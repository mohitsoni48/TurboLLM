package dev.turbollm.core

import dev.turbollm.core.KotlinFakeBackend.Companion.ENGINE_ID
import dev.turbollm.core.KotlinFakeBackend.Companion.MODEL
import dev.turbollm.core.KotlinFakeBackend.Companion.request
import dev.turbollm.core.KotlinFakeBackend.Companion.target
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The generated engine bindings from coroutines against the real Rust manager, with Kotlin engines (arch 9 row
 * "Kotlin JVM, core module", plan T11). Every await runs under a real-time limit ([within]): `runTest`'s virtual
 * clock would otherwise fire a timeout the moment the test waits on Rust.
 */
class EnginesBindingTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun claimLoadReturnsWithTheSnapshotAlreadyLoading() = runTest {
        withCore(KotlinFakeBackend()) { core ->
            val claim = core.claimLoad(target())
            try {
                assertEquals(CoreEngineState.Loading(CoreModelRefKind.INSTALLED, MODEL), core.snapshot().state)
            } finally {
                claim.abandon()
                claim.close()
            }
        }
    }

    @Test
    fun runPublishesReady() = runTest {
        withCore(KotlinFakeBackend()) { core ->
            val loaded = core.load()

            val ready = assertIs<CoreEngineState.Ready>(core.snapshot().state)
            assertEquals(loaded, ready.model)
            assertEquals(ENGINE_ID, loaded.engineId)
        }
    }

    @Test
    fun aCollectorCancelledMidStreamMakesTheEngineAbortWithinOneSecond() = runTest {
        val backend = KotlinFakeBackend(reply = { sink -> replyUntilAborted(sink) })
        withCore(backend) { core ->
            core.load()
            val firstText = CompletableDeferred<Unit>()
            val collector = launch(Dispatchers.Default) {
                core.collect { event -> if (event is CoreEngineEvent.Text) firstText.complete(Unit) }
            }
            within { firstText.await() }

            collector.cancel()

            within(ABORT_LIMIT_MS) { backend.abortRequests.receive() }
        }
    }

    @Test
    fun nextSnapshotSuspendsUntilANewerRevision() = runTest {
        withCore(KotlinFakeBackend()) { core ->
            val before = core.snapshot()
            assertNull(withinOrNull(STILL_SUSPENDED_MS) { core.nextSnapshot(before.revision) })
            val newer = async(Dispatchers.Default) { within { core.nextSnapshot(before.revision) } }

            val claim = core.claimLoad(target())
            try {
                val published = newer.await()
                assertTrue(published.revision > before.revision, "${published.revision} > ${before.revision}")
                assertIs<CoreEngineState.Loading>(published.state)
            } finally {
                claim.abandon()
                claim.close()
            }
        }
    }

    @Test
    fun aForeignGenerateCallingBackIntoTheCoreIsRefusedWithoutDeadlock() = runTest {
        val probe = ReentryProbe()
        val backend = KotlinFakeBackend(reply = { sink ->
            probe.callBack()
            KotlinFakeBackend.replyHelloWorld(sink)
        })
        withCore(backend) { core ->
            probe.core = core
            core.load()

            within(REENTRY_LIMIT_MS) { core.collect {} }

            assertEquals(everyCallRefused(), probe.outcomes.toMap())
            assertEquals(listOf(CoreEngineInfo(KotlinFakeBackend.descriptor, null)), core.list())
        }
    }

    @Test
    fun aForeignOpenCallingBackIntoTheCoreIsRefusedWithoutDeadlock() = runTest {
        val probe = ReentryProbe()
        withCore(KotlinFakeBackend(onOpen = probe::callBack)) { core ->
            probe.core = core

            within(REENTRY_LIMIT_MS) { core.load() }

            assertEquals(everyCallRefused(), probe.outcomes.toMap())
        }
    }

    @Test
    fun aRefusalCarriesItsCoreFailureCode() = runTest {
        withCore(KotlinFakeBackend()) { core ->
            val claim = core.claimLoad(target())
            try {
                val refusal = assertFailsWith<CoreEngineException.Failed> { core.claimLoad(target()) }
                assertEquals(CoreFailureCode.LOAD_IN_PROGRESS, refusal.failure.code)
            } finally {
                claim.abandon()
                claim.close()
            }
        }
    }

    @Test
    fun aForeignOpenFailureReachesKotlinWithItsCode() = runTest {
        val tooLong = CoreFailure(
            code = CoreFailureCode.CONTEXT_LENGTH_EXCEEDED,
            detail = "The context is too long.",
            engineId = null,
            engineKind = null,
            param = null,
            invalidReason = null,
        )
        withCore(KotlinFakeBackend(onOpen = { throw CoreForeignException.Failed(tooLong) })) { core ->
            val refusal = assertFailsWith<CoreEngineException.Failed> { core.load() }

            assertEquals(CoreFailureCode.CONTEXT_LENGTH_EXCEEDED, refusal.failure.code)
            assertEquals("The context is too long.", refusal.failure.detail)
        }
    }

    @Test
    fun aLoadWhoseCoroutineIsCancelledMidOpenEndsIdleAndTheNextLoadSucceeds() = runTest {
        val openMayFinish = CompletableDeferred<Unit>()
        val backend = KotlinFakeBackend(onOpen = { awaitOnEngineThread(openMayFinish) })
        withCore(backend) { core ->
            val loading = launch(Dispatchers.Default) { core.load() }
            within { backend.opened.await() }

            loading.cancelAndJoin()
            openMayFinish.complete(Unit)

            within { backend.released.await() }
            within { core.awaitState<CoreEngineState.Idle>() }
            assertEquals(ENGINE_ID, core.load().engineId)
        }
    }

    @Test
    fun aClaimCollectedWithoutAbandonReleasesTheLifecycle() = runTest {
        withCore(KotlinFakeBackend()) { core ->
            claimAndForget(core)

            within {
                while (!core.claimsAgain()) {
                    collectGarbage()
                }
            }
        }
    }

    @Test
    fun aGenerationCollectedWithoutCloseStopsItsReplyAndFreesItsTurn() = runTest {
        val backend = KotlinFakeBackend(reply = { sink -> replyUntilAborted(sink) })
        withCore(backend) { core ->
            core.load()
            startAndForget(core)

            within {
                while (backend.abortRequests.tryReceive().isFailure) {
                    collectGarbage()
                }
            }

            val next = within { core.generate(request()) }
            next.cancel()
            next.close()
        }
    }

    private suspend fun withCore(backend: KotlinFakeBackend, test: suspend (CoreEngines) -> Unit) {
        val core = CoreEngines.withForeign(
            config(),
            predecessor = null,
            descriptors = listOf(KotlinFakeBackend.descriptor),
            backends = listOf(backend),
            includeNative = false,
        )
        try {
            test(core)
        } finally {
            within { core.shutdown() }
            core.close()
        }
    }

    private fun config() = CoreEngineConfig(
        cacheDir = folder.newFolder("cache").path,
        nativeLibraryDir = null,
        loadJournalPath = null,
        maxQueuedRequests = 8,
        loadStallSeconds = 120,
        forcedUnavailable = emptyMap(),
    )

    private fun everyCallRefused() =
        ReentryProbe.CALLS.associateWith { "${CoreFailureCode.ENGINE_FAILURE}: $REENTRY_REFUSED" }

    /** Kotlin rule 3.3.1: a claim is always abandoned and closed. */
    private suspend fun CoreEngines.load(): CoreLoadedModel {
        val claim = claimLoad(target())
        try {
            return within { claim.run() }
        } finally {
            claim.abandon()
            claim.close()
        }
    }

    /** Kotlin rule 3.3.1: a generation is always cancelled and closed, also when its collector is cancelled. */
    private suspend fun CoreEngines.collect(onEvent: (CoreEngineEvent) -> Unit) {
        val generation = within { generate(request()) }
        try {
            while (true) {
                onEvent(within { generation.next() } ?: break)
            }
        } finally {
            generation.cancel()
            generation.close()
        }
    }

    private suspend inline fun <reified S : CoreEngineState> CoreEngines.awaitState() {
        var snapshot = snapshot()
        while (snapshot.state !is S) {
            snapshot = nextSnapshot(snapshot.revision)
        }
    }

    private fun CoreEngines.claimsAgain(): Boolean = try {
        claimLoad(target()).use { it.abandon() }
        true
    } catch (refusal: CoreEngineException.Failed) {
        if (refusal.failure.code != CoreFailureCode.LOAD_IN_PROGRESS) throw refusal
        false
    }

    /** Leaves a claim to the garbage collector: no reference outlives this call. */
    private fun claimAndForget(core: CoreEngines) {
        core.claimLoad(target())
    }

    /** Leaves a generation that is mid-reply to the garbage collector: no reference outlives this call. */
    private suspend fun startAndForget(core: CoreEngines) {
        val generation = within { core.generate(request()) }
        while (within { generation.next() } !is CoreEngineEvent.Text) continue
    }

    private suspend fun collectGarbage() {
        System.gc()
        delay(GC_POLL_MS)
    }

    private suspend fun <T> within(limitMs: Long = AWAIT_LIMIT_MS, block: suspend CoroutineScope.() -> T): T =
        withContext(Dispatchers.Default) { withTimeout(limitMs, block) }

    private suspend fun <T> withinOrNull(limitMs: Long, block: suspend CoroutineScope.() -> T): T? =
        withContext(Dispatchers.Default) { withTimeoutOrNull(limitMs, block) }

    private companion object {
        const val AWAIT_LIMIT_MS = 10_000L
        const val ABORT_LIMIT_MS = 1_000L
        const val REENTRY_LIMIT_MS = 5_000L
        const val STILL_SUSPENDED_MS = 200L
        const val GC_POLL_MS = 20L
        const val REENTRY_REFUSED = "A foreign engine called back into the TurboLLM core from its engine thread."
    }
}
