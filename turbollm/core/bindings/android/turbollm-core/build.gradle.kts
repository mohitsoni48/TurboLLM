import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val coreDir: File = projectDir.resolve("../../..").canonicalFile
val ggufFixtures: File = coreDir.resolve("fixtures/gguf")
val jnaVersion = "5.19.1"

group = "dev.turbollm"
version = (JsonSlurper().parse(coreDir.resolve("../package.json")) as Map<*, *>)["version"] as String

android {
    namespace = "dev.turbollm.core"
    compileSdk = 36
    ndkVersion = providers.gradleProperty("turbollm.ndkVersion").getOrElse("27.0.12077973")

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["turbollmCi"] =
            providers.environmentVariable("CI").map { (it == "true").toString() }.getOrElse("false")
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("test").java.srcDir("src/goldens/kotlin")
        getByName("androidTest").java.srcDir("src/goldens/kotlin")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// The Android repo's kotlinxCoroutines pin (gradle/libs.versions.toml).
val coroutinesVersion = "1.11.0"

dependencies {
    api("net.java.dev.jna:jna:$jnaVersion@aar")
    // The generated engine bindings suspend (UniFFI async exports).
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")

    testImplementation("net.java.dev.jna:jna:$jnaVersion")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    androidTestImplementation(kotlin("test"))
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

// Cargo runs from the workspace so rust-toolchain.toml and .cargo/config.toml (16 KB page alignment) apply.
val coreManifest = coreDir.resolve("Cargo.toml").path
val rustJniLibs = layout.buildDirectory.dir("rustJniLibs")
val generatedUniffi = layout.buildDirectory.dir("generated/uniffi")
val hostLibraryDir = coreDir.resolve("target/release")

val cargoNdkBuild by tasks.registering(Exec::class) {
    description = "Builds libturbollm_core_ffi.so for arm64-v8a and x86_64 with cargo-ndk."
    workingDir = coreDir
    environment("ANDROID_NDK_HOME", android.ndkDirectory.path)
    // uniffiKotlin reads the UniFFI metadata from the ELF symbol table, which the workspace's release
    // `strip = "symbols"` removes. AGP strips the libraries when it packages them.
    environment("CARGO_PROFILE_RELEASE_STRIP", "debuginfo")
    commandLine(
        "cargo", "ndk", "-t", "arm64-v8a", "-t", "x86_64", "--platform", "24",
        "-o", rustJniLibs.get().asFile.path,
        "build", "--manifest-path", coreManifest, "-p", "turbollm-ffi", "--release",
    )
}

val uniffiKotlin by tasks.registering(Exec::class) {
    description = "Generates the Kotlin bindings from the built arm64-v8a library."
    dependsOn(cargoNdkBuild)
    workingDir = coreDir
    doFirst { delete(generatedUniffi) }
    commandLine(
        "cargo", "run", "--manifest-path", coreManifest, "-p", "xtask", "--",
        "uniffi-kotlin",
        "--lib", rustJniLibs.get().file("arm64-v8a/libturbollm_core_ffi.so").asFile.path,
        "--out", generatedUniffi.get().asFile.path,
    )
}

val cargoHostBuild by tasks.registering(Exec::class) {
    description = "Builds the host turbollm_core_ffi library the JVM tests load through JNA (plan P-7)."
    workingDir = coreDir
    commandLine("cargo", "build", "--manifest-path", coreManifest, "-p", "turbollm-ffi", "--release")
}

// The napi addon the Android app's nodejs-mobile loads (arch 2.6, 4). Run on demand with
// -Pturbollm.libnodeDir=<dir holding <abi>/libnode.so>; not part of the library build. build-node.mjs links
// each ABI against its libnode.so, writes <abi>/libturbollm_core_node.so and runs xtask check-android-elf.
val libnodeDir = providers.gradleProperty("turbollm.libnodeDir")
val nodejsMobileAddon = layout.buildDirectory.dir("nodejsMobileAddon")

val assembleNodejsMobileAddon by tasks.registering(Exec::class) {
    description = "Builds and checks libturbollm_core_node.so for arm64-v8a and x86_64 (needs turbollm.libnodeDir)."
    workingDir = coreDir
    environment("ANDROID_NDK_HOME", android.ndkDirectory.path)
    doFirst {
        if (!libnodeDir.isPresent) {
            throw GradleException("assembleNodejsMobileAddon needs -Pturbollm.libnodeDir=<dir with <abi>/libnode.so>")
        }
        delete(nodejsMobileAddon)
        commandLine(
            "node", coreDir.resolve("scripts/build-node.mjs").path,
            "--flavour", "nodejs-mobile", "--release",
            "--libnode-dir", libnodeDir.get(),
            "--out", nodejsMobileAddon.get().asFile.path,
        )
    }
}

// The instrumented goldens read the fixtures from test assets under gguf/; the corpus cache is a dot-folder,
// which asset packaging ignores, so it is staged as gguf/corpus/ (present only once fetched).
val goldenAssets = layout.buildDirectory.dir("goldenAssets")

val stageGoldenAssets by tasks.registering(Sync::class) {
    description = "Stages the GGUF fixtures as androidTest assets."
    into(goldenAssets)
    from(ggufFixtures) {
        include("crafted/**", "golden/**", "corpus.json")
        into("gguf")
    }
    from(ggufFixtures.resolve(".corpus-cache")) {
        include("*.gguf")
        into("gguf/corpus")
    }
}

android.sourceSets.getByName("main") {
    jniLibs.srcDir(rustJniLibs)
    java.srcDir(generatedUniffi)
}

android.sourceSets.getByName("androidTest") {
    assets.srcDir(goldenAssets)
}

tasks.matching { it.name.matches(Regex("merge\\w*AndroidTestAssets")) }.configureEach {
    dependsOn(stageGoldenAssets)
}

tasks.named("preBuild") {
    dependsOn(cargoNdkBuild, uniffiKotlin)
}

tasks.withType<Test>().configureEach {
    dependsOn(cargoHostBuild)
    systemProperty("jna.library.path", hostLibraryDir.path)
    systemProperty("turbollm.fixtures", ggufFixtures.path)
}
