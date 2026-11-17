# Rules an app that shrinks its code (R8) applies to turbollm-core (plan PG-8).

# JNA binds native functions and structures by reflection on class, method and field names.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }

# The UniFFI bindings are JNA interfaces and structures named after the Rust library's symbols.
-keep class dev.turbollm.core.** { *; }

# JNA references AWT classes that do not exist on Android.
-dontwarn java.awt.**
