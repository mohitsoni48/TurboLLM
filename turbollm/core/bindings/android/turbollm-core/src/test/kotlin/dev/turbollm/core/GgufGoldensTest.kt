package dev.turbollm.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The GGUF goldens on the JVM, through the generated bindings into the host-built `turbollm_core_ffi` (P-7). */
class GgufGoldensTest {
    private val fixtures = File(
        checkNotNull(System.getProperty("turbollm.fixtures")) { "the Gradle test task sets turbollm.fixtures" },
    )
    private val suite = GoldenSuite(fixtures, File(fixtures, ".corpus-cache"))

    @Test
    fun everyCraftedAndCorpusGoldenMatchesTheCore() {
        val report = suite.checkHeaders()
        println(report.summary())
        assertEquals(suite.craftedFileCount(), report.crafted, "every crafted fixture is compared")
        assertTrue(report.mismatches.isEmpty(), report.mismatches.joinToString("\n"))
        val onCi = System.getenv("CI") == "true"
        assertTrue(!onCi || report.corpusMissing == 0, "${report.corpusMissing} corpus slices not fetched on CI")
    }

    @Test
    fun everyQuantNameRowMatchesTheCore() {
        val mismatches = suite.quantNameMismatches()
        assertTrue(mismatches.isEmpty(), mismatches.joinToString("\n"))
    }
}
