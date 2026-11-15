package dev.turbollm.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The GGUF goldens (architecture 3.2) replayed through the generated Kotlin bindings: every crafted and corpus
 * golden compared field by field, and every quant-name row. Shared by the JVM and the instrumented test.
 *
 * Generated fixtures are skipped (plan P-1: Rust rebuilds and pins them). A corpus slice that was never fetched
 * is counted, not compared; the caller decides whether that is allowed.
 */
class GoldenSuite(private val fixtures: File, private val corpusDir: File) {

    fun checkHeaders(): GoldenReport {
        val corpusIds = corpusIds()
        val report = GoldenReport()
        for ((id, golden) in goldens()) {
            if ("generated" in golden) continue
            val file = if (id in corpusIds) File(corpusDir, "$id.gguf") else File(fixtures, "crafted/$id.gguf")
            if (id in corpusIds) {
                if (!file.exists()) {
                    report.corpusMissing++
                    continue
                }
                report.corpus++
            } else {
                report.crafted++
            }
            report.mismatches += mismatches(id, golden, file)
        }
        return report
    }

    fun quantNameMismatches(): List<String> =
        readJson(File(fixtures, "golden/quant-names.json")).jsonArray.mapNotNull { row ->
            val (fileName, expected) = row.jsonArray
            val name = fileName.jsonPrimitive.content
            val want = if (expected is JsonNull) null else expected.jsonPrimitive.content
            val got = quantFromName(name)
            if (got == want) null else "quantFromName($name): expected $want, actual $got"
        }

    fun craftedFileCount(): Int =
        File(fixtures, "crafted").listFiles { file -> file.name.endsWith(".gguf") }?.size ?: 0

    private fun mismatches(id: String, golden: JsonObject, file: File): List<String> =
        headerMismatches(id, golden, file) + cutShortMismatches(id, golden, file)

    private fun headerMismatches(id: String, golden: JsonObject, file: File): List<String> {
        val expected = Json.parseToJsonElement(golden.getValue("parse").jsonPrimitive.content).jsonObject
        val maxRead = golden["maxRead"]?.jsonPrimitive?.long?.toULong()
        val actual = headerAsGolden(file, maxRead)
        return (expected.keys + actual.keys).filter { expected[it] != actual[it] }.map { field ->
            "$id: $field expected ${expected[field]}, actual ${actual[field]}"
        }
    }

    private fun cutShortMismatches(id: String, golden: JsonObject, file: File): List<String> =
        golden.getValue("cutShort").jsonArray.mapNotNull { pair ->
            val (size, verdict) = pair.jsonArray.map { it.jsonPrimitive }
            val actual = ggufCutShort(file.path, size.long.toULong())
            if (actual == verdict.boolean) null
            else "$id: cutShort at ${size.long}: expected ${verdict.boolean}, actual $actual"
        }

    private fun headerAsGolden(file: File, maxRead: ULong?): JsonObject =
        try {
            parseGguf(file.path, maxRead).asGolden()
        } catch (failure: GgufException) {
            failure.asGolden()
        }

    private fun goldens(): List<Pair<String, JsonObject>> =
        File(fixtures, "golden").listFiles().orEmpty()
            .mapNotNull { file -> goldenId(file.name)?.let { id -> id to readJson(file).jsonObject } }
            .sortedBy { it.first }

    private fun corpusIds(): Set<String> =
        readJson(File(fixtures, "corpus.json")).jsonArray
            .map { it.jsonObject.getValue("id").jsonPrimitive.content }
            .toSet()
}

class GoldenReport {
    var crafted = 0
    var corpus = 0
    var corpusMissing = 0
    val mismatches = mutableListOf<String>()

    fun summary(): String = "goldens: crafted=$crafted corpus=$corpus (not fetched: $corpusMissing)"
}

/** The fixture id of `golden/<id>.json`; null for the quant-name table and a divergence's raw TS output. */
private fun goldenId(fileName: String): String? {
    val id = fileName.removeSuffix(".json")
    return if (id == fileName || id == "quant-names" || id.endsWith(".ts")) null else id
}

private fun readJson(file: File): JsonElement = Json.parseToJsonElement(file.readText())

private fun GgufMeta.asGolden(): JsonObject = buildJsonObject {
    put("arch", arch)
    put("name", name)
    put("quant", quant)
    put("sizeLabel", sizeLabel)
    put("nativeCtx", nativeCtx)
    put("blockCount", blockCount)
    put("embedLen", embedLen)
    put("headCountKv", headCountKv)
    put("headDim", headDim)
    put("expertCount", expertCount)
    put("nextnLayers", nextnLayers)
    put("hasChatTemplate", hasChatTemplate)
    put("reasoningEffort", reasoningEffort)
    put("slidingWindow", slidingWindow)
    put("slidingWindowPattern", JsonArray(slidingWindowPattern.map(::JsonPrimitive)))
    put("headDimSwa", headDimSwa)
    put("headCountKvPerLayer", JsonArray(headCountKvPerLayer.map(::JsonPrimitive)))
    put("fullAttentionInterval", fullAttentionInterval)
    put("ssmInnerSize", ssmInnerSize)
    put("ssmStateSize", ssmStateSize)
    put("ssmConvKernel", ssmConvKernel)
    put("dataEnd", dataEnd)
}

private fun GgufException.asGolden(): JsonObject = buildJsonObject {
    putJsonObject("error") {
        put("code", coreCode())
        put("message", message)
    }
}

private fun GgufException.coreCode(): String = when (this) {
    is GgufException.NotGguf -> "not_gguf"
    is GgufException.BadVersion -> "bad_version"
    is GgufException.Truncated -> "truncated"
    is GgufException.BadType -> "bad_type"
    is GgufException.TooLarge -> "too_large"
    is GgufException.Io -> "io"
}
