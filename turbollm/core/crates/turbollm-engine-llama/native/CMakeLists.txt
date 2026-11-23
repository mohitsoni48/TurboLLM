cmake_minimum_required(VERSION 3.22.1)
project(turbollm_core_llama C CXX)

include(ExternalProject)

# One SHARED library per CPU variant, each statically linking its own build of llama.cpp and exporting only the
# tl_llama_* C ABI (include/tl_llama.h). llama.cpp cannot be add_subdirectory'd twice, so every variant is a
# separate ExternalProject. Built for Android by the core module's Gradle build, for the host by
# `cargo xtask build-llama --host`, which also chooses where the libraries land.

set(TURBOLLM_LLAMA_DIR "" CACHE PATH "llama.cpp sources, as cargo xtask fetch-llama extracts them")
set(TURBOLLM_VARIANTS "base" CACHE STRING "CPU variants to build; a variant the ABI lacks is skipped")

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(probes_by_default ON)
else()
    set(probes_by_default OFF)
endif()
option(TURBOLLM_TEST_PROBES "Export tl_llama_live_sessions, for tests" ${probes_by_default})

if(NOT EXISTS "${TURBOLLM_LLAMA_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp not found at '${TURBOLLM_LLAMA_DIR}'. "
                        "Run: cargo xtask fetch-llama --out <dir>")
endif()

set(ARM64_MARCH_base    "armv8-a")
set(ARM64_MARCH_dotprod "armv8.2-a+dotprod+fp16")
set(ARM64_MARCH_i8mm    "armv8.6-a+dotprod+i8mm+fp16")

set(LLAMA_STATIC_LIBS llama-common llama-common-base cpp-httplib llama ggml ggml-cpu ggml-base)

# llama.cpp is always built optimised, even for a Debug build: unoptimised ggml is too slow to run the device
# tests on an emulator. The session's own sources keep the build type's flags, so they stay debuggable.
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(LLAMA_BUILD_TYPE "RelWithDebInfo")
else()
    set(LLAMA_BUILD_TYPE "${CMAKE_BUILD_TYPE}")
endif()

if(NOT ANDROID AND NOT MSVC)
    find_package(Threads REQUIRED)
endif()

function(abi_supports_variant variant out_supported)
    if(ANDROID_ABI STREQUAL "arm64-v8a" AND DEFINED ARM64_MARCH_${variant})
        set(${out_supported} TRUE PARENT_SCOPE)
    elseif(variant STREQUAL "base")
        set(${out_supported} TRUE PARENT_SCOPE)
    else()
        set(${out_supported} FALSE PARENT_SCOPE)
    endif()
endfunction()

function(variant_arch_flags variant out_flags)
    if(ANDROID_ABI STREQUAL "arm64-v8a")
        set(${out_flags} "-march=${ARM64_MARCH_${variant}}" PARENT_SCOPE)
    else()
        set(${out_flags} "" PARENT_SCOPE)
    endif()
endfunction()

# What each llama.cpp build needs to match this one: the NDK toolchain on Android, the host compiler elsewhere.
# MSVC keeps its default flags (they carry /EHsc), and a DLL exports nothing it is not told to.
function(llama_toolchain_args arch_flags out_args)
    set(hidden_flags "${arch_flags} -fvisibility=hidden -fvisibility-inlines-hidden -ffunction-sections -fdata-sections")
    if(ANDROID)
        set(args
            -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
            -DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM}
            -DANDROID_ABI=${ANDROID_ABI}
            -DANDROID_PLATFORM=${ANDROID_PLATFORM}
            -DANDROID_STL=c++_static
            -DCMAKE_C_FLAGS=${hidden_flags}
            -DCMAKE_CXX_FLAGS=${hidden_flags})
    elseif(MSVC)
        set(args "")
    else()
        set(args
            -DCMAKE_POSITION_INDEPENDENT_CODE=ON
            -DCMAKE_C_FLAGS=${hidden_flags}
            -DCMAKE_CXX_FLAGS=${hidden_flags})
    endif()
    set(${out_args} "${args}" PARENT_SCOPE)
endfunction()

function(add_llama_static_build variant arch_flags out_archives)
    set(binary_dir "${CMAKE_CURRENT_BINARY_DIR}/v_${variant}")
    set(archive_dir "${binary_dir}/archives")
    string(TOUPPER "${LLAMA_BUILD_TYPE}" build_type_upper)
    list(TRANSFORM LLAMA_STATIC_LIBS PREPEND "${archive_dir}/${CMAKE_STATIC_LIBRARY_PREFIX}" OUTPUT_VARIABLE archives)
    list(TRANSFORM archives APPEND "${CMAKE_STATIC_LIBRARY_SUFFIX}")
    llama_toolchain_args("${arch_flags}" toolchain_args)

    ExternalProject_Add(llama_${variant}
        SOURCE_DIR "${TURBOLLM_LLAMA_DIR}"
        BINARY_DIR "${binary_dir}"
        CMAKE_ARGS
            ${toolchain_args}
            -DCMAKE_BUILD_TYPE=${LLAMA_BUILD_TYPE}
            -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${archive_dir}
            -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY_${build_type_upper}=${archive_dir}
            -DBUILD_SHARED_LIBS=OFF
            -DGGML_BACKEND_DL=OFF
            -DGGML_NATIVE=OFF
            -DGGML_OPENMP=OFF
            -DGGML_LLAMAFILE=OFF
            -DGGML_VULKAN=OFF
            -DLLAMA_BUILD_COMMON=ON
            -DLLAMA_BUILD_TESTS=OFF
            -DLLAMA_BUILD_TOOLS=OFF
            -DLLAMA_BUILD_EXAMPLES=OFF
            -DLLAMA_BUILD_SERVER=OFF
            -DLLAMA_BUILD_APP=OFF
            -DLLAMA_OPENSSL=OFF
            -DLLAMA_SUBPROCESS=OFF
        BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --config ${LLAMA_BUILD_TYPE} --target llama-common
        INSTALL_COMMAND ""
        BUILD_BYPRODUCTS ${archives}
    )
    set(${out_archives} "${archives}" PARENT_SCOPE)
endfunction()

function(add_variant_library variant)
    variant_arch_flags(${variant} arch_flags)
    add_llama_static_build(${variant} "${arch_flags}" archives)

    set(target turbollm_core_llama_${variant})
    add_library(${target} SHARED src/tl_llama.cpp src/llama_session.cpp src/chat_format.cpp)
    target_compile_features(${target} PRIVATE cxx_std_17)
    add_dependencies(${target} llama_${variant})
    target_include_directories(${target} PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
        "${TURBOLLM_LLAMA_DIR}/include"
        "${TURBOLLM_LLAMA_DIR}/common"
        "${TURBOLLM_LLAMA_DIR}/ggml/include")
    hide_everything_but_the_abi(${target} "${arch_flags}")
    link_llama(${target} "${archives}")
    add_test_probes(${target})
endfunction()

function(hide_everything_but_the_abi target arch_flags)
    if(MSVC)
        export_the_abi_through_a_def_file(${target})
        return()
    endif()
    separate_arguments(arch_flag_list UNIX_COMMAND "${arch_flags}")
    target_compile_options(${target} PRIVATE ${arch_flag_list} -fvisibility=hidden -fvisibility-inlines-hidden)
    if(APPLE)
        target_link_options(${target} PRIVATE -Wl,-dead_strip "-Wl,-exported_symbol,_tl_llama_*")
    else()
        target_link_options(${target} PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections
            "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/tl_llama.map")
        set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tl_llama.map")
    endif()
endfunction()

# A DLL exports only what it is told to. The names come from the header, so the two cannot drift apart.
function(export_the_abi_through_a_def_file target)
    file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/include/tl_llama.h" declarations REGEX "tl_llama_[a-z_]+\\(")
    set(exports "")
    foreach(declaration IN LISTS declarations)
        string(REGEX MATCH "tl_llama_[a-z_]+" name "${declaration}")
        if(name STREQUAL "tl_llama_live_sessions" AND NOT TURBOLLM_TEST_PROBES)
            continue()
        endif()
        string(APPEND exports "    ${name}\n")
    endforeach()
    set(def_file "${CMAKE_CURRENT_BINARY_DIR}/${target}.def")
    file(WRITE "${def_file}" "EXPORTS\n${exports}")
    target_sources(${target} PRIVATE "${def_file}")
endfunction()

function(link_llama target archives)
    if(ANDROID)
        target_link_libraries(${target} PRIVATE -Wl,--start-group ${archives} -Wl,--end-group android log)
    elseif(MSVC OR APPLE)
        target_link_libraries(${target} PRIVATE ${archives})
    else()
        target_link_libraries(${target} PRIVATE -Wl,--start-group ${archives} -Wl,--end-group Threads::Threads)
    endif()
endfunction()

function(add_test_probes target)
    if(TURBOLLM_TEST_PROBES)
        target_sources(${target} PRIVATE src/test_probes.cpp)
        target_compile_definitions(${target} PRIVATE TURBOLLM_TEST_PROBES)
    endif()
endfunction()

foreach(variant IN LISTS TURBOLLM_VARIANTS)
    abi_supports_variant(${variant} supported)
    if(supported)
        add_variant_library(${variant})
    endif()
endforeach()
