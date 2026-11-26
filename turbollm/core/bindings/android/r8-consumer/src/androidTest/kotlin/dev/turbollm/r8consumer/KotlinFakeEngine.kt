package dev.turbollm.r8consumer

import dev.turbollm.core.CoreBackend
import dev.turbollm.core.CoreChatMessage
import dev.turbollm.core.CoreChatRole
import dev.turbollm.core.CoreEngineDescriptor
import dev.turbollm.core.CoreEngineEvent
import dev.turbollm.core.CoreEngineKind
import dev.turbollm.core.CoreEventSink
import dev.turbollm.core.CoreFinishReason
import dev.turbollm.core.CoreForeignBackend
import dev.turbollm.core.CoreForeignModel
import dev.turbollm.core.CoreGenerateRequest
import dev.turbollm.core.CoreGenerationParams
import dev.turbollm.core.CoreLoadSpec
import dev.turbollm.core.CoreLoadTarget
import dev.turbollm.core.CoreMessageContent
import dev.turbollm.core.CoreModelFormat
import dev.turbollm.core.CoreModelInfo
import dev.turbollm.core.CoreModelRefKind
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A Kotlin engine the minified app's core drives through the generated foreign traits (plan T19, PG-6). `open` and
 * `generate` run on the core's engine thread; `requestAbort` may come from any thread.
 */
internal class KotlinFakeEngine(
    private val reply: KotlinFakeEngine.(CoreEventSink) -> Unit = { sink -> replyHelloWorld(sink) },
) : CoreForeignBackend {
    val abortRequested = CountDownLatch(1)

    override fun probe(): String? = null

    override fun open(spec: CoreLoadSpec): CoreForeignModel = Model()

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

    /** Streams a first piece of text, then holds the engine thread until the core asks the reply to stop. */
    fun replyUntilAborted(sink: CoreEventSink) {
        sink.emit(CoreEngineEvent.Prefilled(promptTokens = PROMPT_TOKENS, promptMs = 1.0))
        sink.emit(CoreEngineEvent.Text("Hello"))
        abortRequested.await(ENGINE_THREAD_WAIT_SECONDS, TimeUnit.SECONDS)
    }

    private inner class Model : CoreForeignModel {
        override fun info() = CoreModelInfo(
            contextSize = CONTEXT_SIZE,
            trainedContext = null,
            backend = CoreBackend.CPU,
            notes = emptyList(),
        )

        override fun generate(request: CoreGenerateRequest, sink: CoreEventSink) {
            sink.use { reply(it) }
        }

        override fun requestAbort() = abortRequested.countDown()

        override fun release() = Unit
    }

    companion object {
        private const val ENGINE_ID = "kotlin-fake"
        private const val MODEL = "fake-model"
        private const val CONTEXT_SIZE = 2048
        private const val PROMPT_TOKENS = 3
        private const val ENGINE_THREAD_WAIT_SECONDS = 10L

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
    }
}
