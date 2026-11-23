package dev.turbollm.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap

/**
 * A Kotlin engine the real Rust manager drives through the generated foreign traits (plan T11, P-14). `open` and
 * `generate` run on the core's engine thread; `requestAbort` may come from any thread.
 */
internal class KotlinFakeBackend(
    private val onOpen: () -> Unit = {},
    private val reply: KotlinFakeBackend.(CoreEventSink) -> Unit = { sink -> replyHelloWorld(sink) },
) : CoreForeignBackend {
    val opened = CompletableDeferred<CoreLoadSpec>()
    val released = CompletableDeferred<Unit>()
    val abortRequests = Channel<Unit>(Channel.UNLIMITED)
    @Volatile
    private var replyAborted = CompletableDeferred<Unit>()

    override fun probe(): String? = null

    override fun open(spec: CoreLoadSpec): CoreForeignModel {
        opened.complete(spec)
        onOpen()
        return Model()
    }

    /** Streams a first piece of text, then holds the engine thread until the core asks the reply to stop. */
    fun replyUntilAborted(sink: CoreEventSink) {
        sink.emit(CoreEngineEvent.Prefilled(promptTokens = PROMPT_TOKENS, promptMs = 1.0))
        sink.emit(CoreEngineEvent.Text("Hello"))
        awaitOnEngineThread(replyAborted)
    }

    private inner class Model : CoreForeignModel {
        override fun info() = CoreModelInfo(
            contextSize = CONTEXT_SIZE,
            trainedContext = null,
            backend = CoreBackend.CPU,
            notes = listOf("kotlin fake"),
        )

        override fun generate(request: CoreGenerateRequest, sink: CoreEventSink) {
            replyAborted = CompletableDeferred()
            sink.use { reply(it) }
        }

        override fun requestAbort() {
            replyAborted.complete(Unit)
            abortRequests.trySend(Unit)
        }

        override fun release() {
            released.complete(Unit)
        }
    }

    companion object {
        const val ENGINE_ID = "kotlin-fake"
        const val MODEL = "fake-model"
        const val CONTEXT_SIZE = 2048
        private const val PROMPT_TOKENS = 3

        val descriptor = CoreEngineDescriptor(
            id = ENGINE_ID,
            name = "Kotlin fake engine",
            kind = CoreEngineKind.LLAMA_CPP,
            formats = listOf(CoreModelFormat.GGUF),
            backends = listOf(CoreBackend.CPU),
        )

        fun target() = CoreLoadTarget(
            refKind = CoreModelRefKind.INSTALLED,
            refValue = MODEL,
            id = MODEL,
            path = "/models/$MODEL.gguf",
            format = CoreModelFormat.GGUF,
            engineId = ENGINE_ID,
            contextSize = CONTEXT_SIZE,
            threads = 2,
            backend = CoreBackend.CPU,
        )

        fun request() = CoreGenerateRequest(
            messages = listOf(CoreChatMessage(CoreChatRole.USER, CoreMessageContent.Text("Hi"))),
            params = CoreGenerationParams(
                maxTokens = 16,
                temperature = 0f,
                topP = null,
                topK = null,
                seed = 1L,
                enableThinking = false,
                templateKwargs = emptyMap(),
            ),
        )

        fun replyHelloWorld(sink: CoreEventSink) {
            sink.emit(CoreEngineEvent.Prefilled(promptTokens = PROMPT_TOKENS, promptMs = 1.0))
            sink.emit(CoreEngineEvent.Text("Hello"))
            sink.emit(CoreEngineEvent.Text(" world"))
            sink.emit(
                CoreEngineEvent.Done(
                    reason = CoreFinishReason.STOP,
                    promptTokens = PROMPT_TOKENS,
                    completionTokens = 2,
                    promptMs = 1.0,
                    genMs = 1.0,
                ),
            )
        }
    }
}

/** Blocks a foreign call's thread until `signal` completes; bounded, so a broken core fails a test, never hangs it. */
internal fun awaitOnEngineThread(signal: CompletableDeferred<Unit>) = runBlocking {
    withTimeout(ENGINE_THREAD_WAIT_LIMIT_MS) { signal.await() }
}

private const val ENGINE_THREAD_WAIT_LIMIT_MS = 10_000L

/**
 * What a foreign engine gets when it calls back into the core from its engine thread (P-17): each call's outcome,
 * `"served"` or `"<code>: <detail>"`.
 */
internal class ReentryProbe {
    lateinit var core: CoreEngines
    val outcomes = ConcurrentHashMap<String, String>()

    fun callBack() {
        attempt("list") { core.list() }
        attempt("snapshot") { core.snapshot() }
        attempt("claimLoad") { core.claimLoad(KotlinFakeBackend.target()).close() }
        attempt("generate") { runBlocking { core.generate(KotlinFakeBackend.request()).close() } }
        attempt("unload") { runBlocking { core.unload() } }
    }

    private fun attempt(call: String, coreCall: () -> Unit) {
        outcomes[call] = try {
            coreCall()
            "served"
        } catch (refusal: CoreEngineException.Failed) {
            "${refusal.failure.code}: ${refusal.failure.detail}"
        }
    }

    companion object {
        val CALLS = setOf("list", "snapshot", "claimLoad", "generate", "unload")
    }
}
