package dev.turbollm.core

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * llama.cpp and LiteRT-LM through the UniFFI engine surface on a device (plans T19 and T25; the device half of the
 * old SDK's `LlamaCppEngineTest` and `LiteRtLmEngineTest`): the libraries the core module packages, opened by bare
 * name, running the GGUF named by the instrumentation argument `turbollmTestGguf` and the `.litertlm` named by
 * `turbollmTestLitertlm`, on the CPU. Without its argument a test is skipped, except on CI, where it fails.
 */
@RunWith(AndroidJUnit4::class)
class EnginesInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val journal = File(context.cacheDir, "engines-test/loading.json").apply { delete() }
    private val core = CoreEngines(config(), predecessor = null)

    @After
    fun shutDownTheCore() = runBlocking {
        withTimeout(AWAIT_MILLIS) { core.shutdown() }
        core.close()
    }

    @Test(timeout = TEST_MILLIS)
    fun llamaCppIsListedFirstAndAvailable() {
        val first = core.list().first()

        assertEquals(LLAMA_CPP_CPU, first.descriptor.id)
        assertNull(first.unavailableReason)
    }

    @Test(timeout = TEST_MILLIS)
    fun liteRtLmIsListedSecondAndAvailable() {
        val second = core.list()[1]

        assertEquals(LITERT_LM, second.descriptor.id)
        assertNull(second.unavailableReason)
    }

    @Test(timeout = TEST_MILLIS)
    fun onX86_64TheCoreOpensTheBaseLibraryByItsBareName() = runBlocking {
        assumeTrue("an x86_64 device", Build.SUPPORTED_ABIS.first() == "x86_64")
        val model = testModelPath()

        core.load(target(model))

        val nativeLibraryDir = File(context.applicationInfo.nativeLibraryDir)
        assertTrue(nativeLibraryDir.listFiles().orEmpty().none { it.name.startsWith(LLAMA_LIBRARY_PREFIX) })
        for (fasterVariant in listOf("dotprod", "i8mm")) {
            assertFailsWith<UnsatisfiedLinkError> { System.loadLibrary("turbollm_core_llama_$fasterVariant") }
        }
    }

    @Test(timeout = TEST_MILLIS)
    fun aReplyStreamsTextAndEndsWithStop() = runBlocking {
        core.load(target(testModelPath()))

        val events = core.reply(QUESTION)

        assertIs<CoreEngineEvent.Prefilled>(events.first())
        assertTrue(events.any { it is CoreEngineEvent.Text }, "the model generated no text")
        val done = assertIs<CoreEngineEvent.Done>(events.last())
        assertEquals(CoreFinishReason.STOP, done.reason)
        assertTrue(done.promptTokens > 0)
    }

    @Test(timeout = TEST_MILLIS)
    fun cancellingAfterTheFirstTokenEndsPromptlyAndTheNextReplyWorks() = runBlocking {
        core.load(target(testModelPath()))
        val endless = withTimeout(AWAIT_MILLIS) { core.generate(request(maxTokens = ENDLESS_TOKENS)) }
        try {
            while (withTimeout(GENERATION_MILLIS) { endless.next() } !is CoreEngineEvent.Text) continue
        } finally {
            endless.cancel()
            endless.close()
        }

        val next = withTimeout(CANCEL_MILLIS) { core.reply(SHORT) }

        assertIs<CoreEngineEvent.Done>(next.last())
    }

    @Test(timeout = TEST_MILLIS)
    fun aModelUnloadedCanBeLoadedAgain() = runBlocking {
        val model = testModelPath()
        core.load(target(model))
        withTimeout(AWAIT_MILLIS) { core.unload() }
        assertIs<CoreEngineState.Idle>(core.snapshot().state)

        core.load(target(model))
        val events = core.reply(SHORT)

        assertIs<CoreEngineEvent.Done>(events.last())
    }

    @Test(timeout = TEST_MILLIS)
    fun aGpuRequestRunsOnCpuWithTheNote() = runBlocking {
        val loaded = core.load(target(testModelPath(), CoreBackend.GPU))

        assertEquals(CoreBackend.CPU, loaded.backend)
        assertEquals(listOf(GPU_UNAVAILABLE_NOTE), loaded.notes)
    }

    @Test(timeout = TEST_MILLIS)
    fun theLoadJournalHoldsTheModelWhileItLoadsAndIsClearedAfter() = runBlocking {
        val claim = core.claimLoad(target(testModelPath()))
        try {
            val loading = async(Dispatchers.Default) { claim.run() }
            var journalSeen = false
            while (!loading.isCompleted) {
                journalSeen = journalSeen || journal.isFile
                delay(JOURNAL_POLL_MILLIS)
            }
            withTimeout(AWAIT_MILLIS) { loading.await() }

            assertTrue(journalSeen, "no journal at $journal while the model loaded")
            assertTrue(!journal.exists(), "the journal outlived the load")
        } finally {
            claim.abandon()
            claim.close()
        }
    }

    @Test(timeout = TEST_MILLIS)
    fun aLiteRtLmReplyStreamsTextAndEndsWithDoneOnTheCpu() = runBlocking {
        val loaded = core.load(liteRtTarget(testModelPath(LITERT_MODEL_ARGUMENT)))

        val events = core.reply(QUESTION)

        assertEquals(CoreBackend.CPU, loaded.backend)
        assertIs<CoreEngineEvent.Prefilled>(events.first())
        assertTrue(events.any { it is CoreEngineEvent.Text }, "the model generated no text")
        assertIs<CoreEngineEvent.Done>(events.last())
    }

    @Test(timeout = TEST_MILLIS)
    fun cancellingALiteRtLmReplyEndsPromptlyAndTheNextReplyWorks() = runBlocking {
        core.load(liteRtTarget(testModelPath(LITERT_MODEL_ARGUMENT)))
        val endless = withTimeout(AWAIT_MILLIS) { core.generate(request(maxTokens = ENDLESS_TOKENS)) }
        try {
            while (withTimeout(GENERATION_MILLIS) { endless.next() } !is CoreEngineEvent.Text) continue
        } finally {
            endless.cancel()
            endless.close()
        }

        val next = withTimeout(CANCEL_MILLIS) { core.reply(SHORT) }

        assertIs<CoreEngineEvent.Done>(next.last())
    }

    @Test(timeout = TEST_MILLIS)
    fun aLlamaCppModelLoadsAfterALiteRtLmModelWasUnloaded() = runBlocking {
        val liteRtModel = testModelPath(LITERT_MODEL_ARGUMENT)
        val ggufModel = testModelPath(MODEL_ARGUMENT)
        core.load(liteRtTarget(liteRtModel))
        assertIs<CoreEngineEvent.Done>(core.reply(SHORT).last())
        withTimeout(AWAIT_MILLIS) { core.unload() }
        assertIs<CoreEngineState.Idle>(core.snapshot().state)

        core.load(target(ggufModel))
        val events = core.reply(SHORT)

        assertIs<CoreEngineEvent.Done>(events.last())
    }

    private fun config() = CoreEngineConfig(
        cacheDir = context.cacheDir.path,
        nativeLibraryDir = context.applicationInfo.nativeLibraryDir,
        loadJournalPath = journal.path,
        maxQueuedRequests = 8,
        loadStallSeconds = 120,
        forcedUnavailable = emptyMap(),
    )

    /** Kotlin rule 3.3.1: a claim is always abandoned and closed. */
    private suspend fun CoreEngines.load(target: CoreLoadTarget): CoreLoadedModel {
        val claim = claimLoad(target)
        try {
            return withTimeout(AWAIT_MILLIS) { claim.run() }
        } finally {
            claim.abandon()
            claim.close()
        }
    }

    /** Every event of one reply, in order. Kotlin rule 3.3.1: a generation is always cancelled and closed. */
    private suspend fun CoreEngines.reply(request: CoreGenerateRequest): List<CoreEngineEvent> {
        val generation = withTimeout(AWAIT_MILLIS) { generate(request) }
        try {
            return withTimeout(GENERATION_MILLIS) { generation.drain() }
        } finally {
            generation.cancel()
            generation.close()
        }
    }

    private suspend fun CoreGeneration.drain(): List<CoreEngineEvent> {
        val events = mutableListOf<CoreEngineEvent>()
        while (true) events += next() ?: return events
    }

    private fun testModelPath(argument: String = MODEL_ARGUMENT): String {
        val path = InstrumentationRegistry.getArguments().getString(argument)
        check(path != null || !onCi()) { "Pass the model path as the instrumentation argument $argument." }
        assumeTrue("no $argument instrumentation argument", path != null)
        return checkNotNull(path)
    }

    private fun onCi(): Boolean = InstrumentationRegistry.getArguments().getString("turbollmCi") == "true"

    private companion object {
        const val TEST_MILLIS = 180_000L
        const val AWAIT_MILLIS = 60_000L
        const val GENERATION_MILLIS = 60_000L
        const val CANCEL_MILLIS = 30_000L
        const val JOURNAL_POLL_MILLIS = 1L
        const val ENDLESS_TOKENS = 512
        const val MODEL_ARGUMENT = "turbollmTestGguf"
        const val LITERT_MODEL_ARGUMENT = "turbollmTestLitertlm"
        const val LLAMA_CPP_CPU = "llama.cpp-cpu"
        const val LITERT_LM = "litert-lm"
        const val LLAMA_LIBRARY_PREFIX = "libturbollm_core_llama_"
        const val GPU_UNAVAILABLE_NOTE = "GPU is not available for llama.cpp in M1; ran on CPU"

        val QUESTION = request(maxTokens = null)
        val SHORT = request(maxTokens = 8)

        fun request(maxTokens: Int?) = CoreGenerateRequest(
            messages = listOf(
                CoreChatMessage(CoreChatRole.USER, CoreMessageContent.Text("Reply with the single word: yes.")),
            ),
            params = CoreGenerationParams(
                maxTokens = maxTokens,
                temperature = 0f,
                topP = null,
                topK = null,
                seed = 1L,
                enableThinking = false,
                templateKwargs = emptyMap(),
            ),
        )

        fun target(model: String, backend: CoreBackend = CoreBackend.AUTO) = CoreLoadTarget(
            refKind = CoreModelRefKind.FILE,
            refValue = model,
            id = File(model).nameWithoutExtension,
            path = model,
            format = CoreModelFormat.GGUF,
            engineId = LLAMA_CPP_CPU,
            contextSize = 1024,
            threads = 2,
            backend = backend,
        )

        fun liteRtTarget(model: String) = target(model, CoreBackend.CPU).copy(
            format = CoreModelFormat.LITERTLM,
            engineId = LITERT_LM,
            contextSize = 2048,
        )
    }
}
