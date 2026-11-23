cmake_minimum_required(VERSION 3.22.1)
project(turbollm_sdk_native C CXX)

include(ExternalProject)

# One SHARED JNI library per CPU variant, each statically linking its own build of llama.cpp.
# llama.cpp cannot be add_subdirectory'd twice, so every variant is a separate ExternalProject.

set(TURBOLLM_LLAMA_DIR "" CACHE PATH "llama.cpp sources: the third_party/llama.cpp submodule")
set(TURBOLLM_VARIANTS "base" CACHE STRING "CPU variants to build; a variant the ABI lacks is skipped")

if(NOT EXISTS "${TURBOLLM_LLAMA_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp not found at '${TURBOLLM_LLAMA_DIR}'. "
                        "Run: git submodule update --init third_party/llama.cpp")
endif()

set(ARM64_MARCH_base    "armv8-a")
set(ARM64_MARCH_dotprod "armv8.2-a+dotprod+fp16")
set(ARM64_MARCH_i8mm    "armv8.6-a+dotprod+i8mm+fp16")

set(LLAMA_STATIC_LIBS llama-common llama-common-base cpp-httplib llama ggml ggml-cpu ggml-base)

# llama.cpp is always built optimised, even for a Debug SDK: unoptimised ggml is too slow to run the device
# tests on an emulator. The SDK's own JNI sources keep the build type's flags, so they stay debuggable.
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(LLAMA_BUILD_TYPE "RelWithDebInfo")
else()
    set(LLAMA_BUILD_TYPE "${CMAKE_BUILD_TYPE}")
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

function(add_llama_static_build variant arch_flags out_archives)
    set(binary_dir "${CMAKE_CURRENT_BINARY_DIR}/v_${variant}")
    set(archive_dir "${binary_dir}/archives")
    list(TRANSFORM LLAMA_STATIC_LIBS PREPEND "${archive_dir}/lib" OUTPUT_VARIABLE archives)
    list(TRANSFORM archives APPEND ".a")
    set(hidden_flags "${arch_flags} -fvisibility=hidden -fvisibility-inlines-hidden -ffunction-sections -fdata-sections")

    ExternalProject_Add(llama_${variant}
        SOURCE_DIR "${TURBOLLM_LLAMA_DIR}"
        BINARY_DIR "${binary_dir}"
        CMAKE_ARGS
            -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
            -DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM}
            -DANDROID_ABI=${ANDROID_ABI}
            -DANDROID_PLATFORM=${ANDROID_PLATFORM}
            -DANDROID_STL=c++_static
            -DCMAKE_BUILD_TYPE=${LLAMA_BUILD_TYPE}
            -DCMAKE_C_FLAGS=${hidden_flags}
            -DCMAKE_CXX_FLAGS=${hidden_flags}
            -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${archive_dir}
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
        BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --target llama-common
        INSTALL_COMMAND ""
        BUILD_BYPRODUCTS ${archives}
    )
    set(${out_archives} "${archives}" PARENT_SCOPE)
endfunction()

function(add_jni_variant variant)
    variant_arch_flags(${variant} arch_flags)
    add_llama_static_build(${variant} "${arch_flags}" archives)

    set(target turbollm_llama_${variant})
    add_library(${target} SHARED
        turbollm_jni.cpp jni_text.cpp session_registry.cpp llama_session.cpp chat_format.cpp)
    target_compile_features(${target} PRIVATE cxx_std_17)
    add_dependencies(${target} llama_${variant})
    target_include_directories(${target} PRIVATE
        "${TURBOLLM_LLAMA_DIR}/include"
        "${TURBOLLM_LLAMA_DIR}/common"
        "${TURBOLLM_LLAMA_DIR}/ggml/include")
    separate_arguments(arch_flag_list UNIX_COMMAND "${arch_flags}")
    target_compile_options(${target} PRIVATE ${arch_flag_list} -fvisibility=hidden -fvisibility-inlines-hidden)
    target_link_libraries(${target} PRIVATE -Wl,--start-group ${archives} -Wl,--end-group android log)
    target_link_options(${target} PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections)
    add_test_probes_in_debug(${target})
endfunction()

# The device tests' LlamaTestProbe; a release library has neither the probes nor their JNI export.
function(add_test_probes_in_debug target)
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        target_sources(${target} PRIVATE test_probes.cpp)
        target_compile_definitions(${target} PRIVATE TURBOLLM_TEST_PROBES)
    endif()
endfunction()

foreach(variant IN LISTS TURBOLLM_VARIANTS)
    abi_supports_variant(${variant} supported)
    if(supported)
        add_jni_variant(${variant})
    endif()
endforeach()
