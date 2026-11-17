package dev.turbollm.core

import android.content.res.AssetManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The GGUF goldens on a device, through the packaged `libturbollm_core_ffi.so`. The fixtures ship as test assets
 * (`stageGoldenAssets`) and are copied to the cache dir first, because the core reads files by path.
 */
@RunWith(AndroidJUnit4::class)
class GgufGoldensInstrumentedTest {

    @Test
    fun everyCraftedAndCorpusGoldenMatchesTheCore() {
        val report = suite.checkHeaders()
        println(report.summary())
        assertEquals(suite.craftedFileCount(), report.crafted, "every crafted fixture is compared")
        assertTrue(report.mismatches.isEmpty(), report.mismatches.joinToString("\n"))
        assertTrue(!onCi() || report.corpusMissing == 0, "${report.corpusMissing} corpus slices not fetched on CI")
    }

    @Test
    fun everyQuantNameRowMatchesTheCore() {
        val mismatches = suite.quantNameMismatches()
        assertTrue(mismatches.isEmpty(), mismatches.joinToString("\n"))
    }

    companion object {
        private const val ASSET_ROOT = "gguf"
        private lateinit var suite: GoldenSuite

        @BeforeClass
        @JvmStatic
        fun copyFixturesOutOfTheApk() {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val fixtures = File(instrumentation.targetContext.cacheDir, ASSET_ROOT)
            fixtures.deleteRecursively()
            instrumentation.context.assets.copyTree(ASSET_ROOT, fixtures)
            suite = GoldenSuite(fixtures, File(fixtures, "corpus"))
        }

        private fun onCi(): Boolean = InstrumentationRegistry.getArguments().getString("turbollmCi") == "true"

        private fun AssetManager.copyTree(assetPath: String, target: File) {
            val children = list(assetPath).orEmpty()
            if (children.isEmpty()) {
                target.parentFile?.mkdirs()
                open(assetPath).use { input -> target.outputStream().use { input.copyTo(it) } }
                return
            }
            for (child in children) copyTree("$assetPath/$child", File(target, child))
        }
    }
}
