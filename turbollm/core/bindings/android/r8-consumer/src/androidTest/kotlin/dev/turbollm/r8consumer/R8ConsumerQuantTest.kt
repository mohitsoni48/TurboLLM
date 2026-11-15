package dev.turbollm.r8consumer

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.turbollm.core.quantFromName
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals

// Runs against the R8-minified release build (testBuildType = "release"): proves the library's consumer rules
// keep JNA and the UniFFI bindings for an app that shrinks its code.
@RunWith(AndroidJUnit4::class)
class R8ConsumerQuantTest {
    @Test
    fun quantFromNameWorksInAMinifiedApp() {
        assertEquals("Q4_K_M", quantFromName("Model-Q4_K_M.gguf"))
    }
}
