import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Test-only app that shrinks its code with R8 and depends on :turbollm-core, the way an SDK integrator's app does
// (plan PG-8). Never published.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.turbollm.r8consumer"
    compileSdk = 36
    testBuildType = "release"

    defaultConfig {
        applicationId = "dev.turbollm.r8consumer"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "instrumentation-proguard-rules.pro")
            testProguardFiles("test-proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":turbollm-core"))

    androidTestImplementation(kotlin("test"))
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
