# The test APK leaves out the Kotlin runtime and calls into this app's copy of it, minified separately against this
# app's mapping. R8 removes runtime classes the app does not use (kotlin.jvm.internal.Lambda) and rewrites the
# signatures of methods it keeps (Intrinsics.checkNotNullParameter became (String, Object)), so androidx.test crashed
# before any test ran. Keeping the Kotlin runtime whole keeps nothing of JNA or the UniFFI bindings: the library's
# consumer rules alone still decide whether those survive.
-keep class kotlin.** { *; }
