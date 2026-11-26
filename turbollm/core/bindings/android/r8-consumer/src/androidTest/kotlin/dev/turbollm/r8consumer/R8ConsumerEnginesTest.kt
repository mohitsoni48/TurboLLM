package dev.turbollm.r8consumer

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.turbollm.core.CoreEngineConfig
import dev.turbollm.core.CoreEngineEvent
import dev.turbollm.core.CoreEngineException
import dev.turbollm.core.CoreEngines
import dev.turbollm.core.CoreGeneration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The engine surface in an app that shrinks its code (plan T19, PG-6), run against the R8-minified release build
 * (testBuildType = "release"): UniFFI's async continuations and the foreign-trait vtables must survive the library's
 * consumer rules. The suspend calls are driven with the Kotlin standard library only, so the test relies on nothing
 * of kotlinx.coroutines beyond what the minified bindings themselves keep.
 *
 * The last two tests end a Kotlin engine whose reply blocked its engine thread, or called back into the core from it,
 * and then let that thread exit: ART aborts a process whose native thread exits while still attached to the VM (the
 * JVM tests print "JNA: could not detach thread" for these cases, increments T11).
 */
@RunWith(AndroidJUnit4::class)
class R8ConsumerEnginesTest {

    @Test
    fun aForeignEngineLoadsAndStreamsInAMinifiedApp() {
        withCore(KotlinFakeEngine()) { core ->
            loadTheFakeModel(core)

            val events = awaitSuspending { core.generate(KotlinFakeEngine.request()) }.drainAndClose()

            assertEquals(
                listOf("Prefilled", "Text:Hello", "Text: world", "Done"),
                events.map(::describe),
            )
        }
    }

    @Test
    fun aCancelledForeignReplyReachesTheEngineAndItsThreadThenExitsCleanly() {
        val engine = KotlinFakeEngine { sink -> replyUntilAborted(sink) }
        withCore(engine) { core ->
            loadTheFakeModel(core)
            val generation = awaitSuspending { core.generate(KotlinFakeEngine.request()) }
            try {
                while (awaitSuspending { generation.next() } !is CoreEngineEvent.Text) continue
                generation.cancel()

                assertTrue(engine.abortRequested.await(ABORT_SECONDS, TimeUnit.SECONDS), "the engine saw no abort")
            } finally {
                generation.cancel()
                generation.close()
            }
        }
    }

    @Test
    fun aForeignReplyCallingBackIntoTheCoreIsRefusedAndItsThreadThenExitsCleanly() {
        val refusals = mutableListOf<String>()
        lateinit var reentered: CoreEngines
        val engine = KotlinFakeEngine { sink ->
            refusals += refusalOf { reentered.list() }
            refusals += refusalOf { awaitSuspending { reentered.generate(KotlinFakeEngine.request()) }.close() }
            replyHelloWorld(sink)
        }
        withCore(engine) { core ->
            reentered = core
            loadTheFakeModel(core)

            awaitSuspending { core.generate(KotlinFakeEngine.request()) }.drainAndClose()

            assertEquals(listOf(REENTRY_REFUSED, REENTRY_REFUSED), refusals)
        }
    }

    /** Builds a core over [engine] only, and shuts it down after [test], so its engine thread has exited by then. */
    private fun withCore(engine: KotlinFakeEngine, test: (CoreEngines) -> Unit) {
        val core = CoreEngines.withForeign(
            config(),
            null,
            listOf(KotlinFakeEngine.descriptor),
            listOf(engine),
            false,
        )
        try {
            test(core)
        } finally {
            awaitSuspending { core.shutdown() }
            core.close()
        }
    }

    private fun config() = CoreEngineConfig(
        cacheDir = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.path,
        nativeLibraryDir = null,
        loadJournalPath = null,
        maxQueuedRequests = 8,
        loadStallSeconds = 120,
        forcedUnavailable = emptyMap(),
    )

    /** Kotlin rule 3.3.1: a claim is always abandoned and closed. */
    private fun loadTheFakeModel(core: CoreEngines) {
        val claim = core.claimLoad(KotlinFakeEngine.target())
        try {
            awaitSuspending { claim.run() }
        } finally {
            claim.abandon()
            claim.close()
        }
    }

    /** Every event until `next()` answers null. Kotlin rule 3.3.1: the generation is cancelled and closed. */
    private fun CoreGeneration.drainAndClose(): List<CoreEngineEvent> {
        val events = mutableListOf<CoreEngineEvent>()
        try {
            while (true) events += awaitSuspending { next() } ?: return events
        } finally {
            cancel()
            close()
        }
    }

    private fun describe(event: CoreEngineEvent): String = when (event) {
        is CoreEngineEvent.Prefilled -> "Prefilled"
        is CoreEngineEvent.Text -> "Text:${event.text}"
        is CoreEngineEvent.Reasoning -> "Reasoning:${event.text}"
        is CoreEngineEvent.Done -> "Done"
    }

    private fun refusalOf(coreCall: () -> Unit): String = try {
        coreCall()
        "served"
    } catch (refusal: CoreEngineException.Failed) {
        refusal.failure.detail
    }

    private companion object {
        const val AWAIT_SECONDS = 10L
        const val ABORT_SECONDS = 1L
        const val REENTRY_REFUSED = "A foreign engine called back into the TurboLLM core from its engine thread."

        /** Runs a suspend call to its end on the calling thread's behalf, bounded by [AWAIT_SECONDS]. */
        fun <T> awaitSuspending(call: suspend () -> T): T {
            val outcome = CompletableFuture<T>()
            call.startCoroutine(
                Continuation(EmptyCoroutineContext) { result ->
                    result.fold(outcome::complete, outcome::completeExceptionally)
                },
            )
            try {
                return outcome.get(AWAIT_SECONDS, TimeUnit.SECONDS)
            } catch (failure: ExecutionException) {
                throw failure.cause ?: failure
            }
        }
    }
}
