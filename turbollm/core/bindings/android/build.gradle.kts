// Same plugin pins as the Android repo (TurboLLM Android/gradle/libs.versions.toml), which includes
// :turbollm-core by path and builds it with its own plugin versions (architecture 2.6).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}
