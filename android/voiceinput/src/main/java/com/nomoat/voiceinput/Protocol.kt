package com.nomoat.voiceinput

import org.json.JSONArray
import org.json.JSONObject

const val PROTOCOL_VERSION = 1
const val SAMPLE_RATE = 16_000
const val FRAME_MS = 100
const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000
const val FRAME_BYTES = FRAME_SAMPLES * 2
const val MAX_SESSION_MS = 20 * 60_000L
const val SEND_WINDOW_MS = 30_000L

sealed interface ServerEvent {
    data class Ready(val maxMs: Long) : ServerEvent
    data class Interim(val seg: Int, val text: String) : ServerEvent
    data class Commit(val seg: Int, val text: String, val startMs: Long, val endMs: Long) : ServerEvent
    data class Ack(val ms: Long) : ServerEvent
    data class Done(val nextSeg: Int) : ServerEvent
    data class Error(val code: String, val retryable: Boolean) : ServerEvent
}

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

private fun JSONObject.safeLong(key: String, min: Long = 0): Long? {
    val value = opt(key) as? Number ?: return null
    val double = value.toDouble()
    if (double.isNaN() || double.isInfinite() || double != Math.floor(double) || Math.abs(double) > MAX_SAFE_INTEGER) return null
    val long = value.toLong()
    return if (long >= min) long else null
}

private fun JSONObject.safeInt(key: String): Int? = safeLong(key)?.takeIf { it <= Int.MAX_VALUE }?.toInt()

private fun JSONObject.string(key: String): String? = opt(key) as? String

fun parseServerEvent(raw: String): ServerEvent? {
    val e = try {
        JSONObject(raw)
    } catch (_: Exception) {
        return null
    }
    return when (e.opt("type")) {
        "ready" -> ServerEvent.Ready(e.safeLong("maxMs", 1) ?: MAX_SESSION_MS)
        "interim" -> {
            val seg = e.safeInt("seg")
            val text = e.string("text")
            if (seg != null && text != null) ServerEvent.Interim(seg, text) else null
        }
        "commit" -> {
            val seg = e.safeInt("seg")
            val text = e.string("text")
            val startMs = e.safeLong("startMs")
            val endMs = e.safeLong("endMs")
            if (seg != null && text != null && startMs != null && endMs != null && endMs >= startMs) ServerEvent.Commit(seg, text, startMs, endMs) else null
        }
        "ack" -> e.safeLong("ms")?.let { ServerEvent.Ack(it) }
        "done" -> e.safeInt("nextSeg")?.let { ServerEvent.Done(it) }
        "error" -> e.string("code")?.let { ServerEvent.Error(it, e.opt("retryable") == true) }
        else -> null
    }
}

internal fun startMessage(session: String, token: String?, languages: List<String>, surface: String?, fromMs: Long, nextSeg: Int): String {
    val message = JSONObject()
    message.put("type", "start")
    message.put("v", PROTOCOL_VERSION)
    message.put("session", session)
    if (!token.isNullOrEmpty()) message.put("token", token)
    message.put("languages", JSONArray().apply { languages.forEach { put(it) } })
    if (!surface.isNullOrEmpty()) message.put("surface", surface)
    message.put("fromMs", fromMs)
    message.put("nextSeg", nextSeg)
    return message.toString()
}

internal fun finishMessage(endMs: Long): String = JSONObject().put("type", "finish").put("endMs", endMs).toString()

internal fun cancelMessage(): String = JSONObject().put("type", "cancel").toString()
