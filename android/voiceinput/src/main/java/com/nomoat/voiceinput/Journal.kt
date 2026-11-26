package com.nomoat.voiceinput

import org.json.JSONArray
import org.json.JSONObject

sealed class JournalRecord {
    abstract val t: String

    data class Start(val session: String, val target: String, val surface: String?, val languages: List<String>, val at: Long) : JournalRecord() {
        override val t: String get() = "start"
    }

    data class Commit(val seg: Int, val text: String, val startMs: Long, val endMs: Long) : JournalRecord() {
        override val t: String get() = "commit"
    }

    data class Rewind(val nextSeg: Int) : JournalRecord() {
        override val t: String get() = "rewind"
    }

    data class Finish(val endMs: Long, val at: Long) : JournalRecord() {
        override val t: String get() = "finish"
    }

    data class Complete(val at: Long) : JournalRecord() {
        override val t: String get() = "complete"
    }

    data class Tidy(val markdown: String) : JournalRecord() {
        override val t: String get() = "tidy"
    }

    data class Inserted(val at: Long) : JournalRecord() {
        override val t: String get() = "inserted"
    }

    data class Discarded(val at: Long) : JournalRecord() {
        override val t: String get() = "discarded"
    }

    fun toJson(): JSONObject {
        val o = JSONObject().put("t", t)
        when (this) {
            is Start -> {
                o.put("session", session).put("target", target).put("at", at)
                if (surface != null) o.put("surface", surface)
                o.put("languages", JSONArray().apply { languages.forEach { put(it) } })
            }
            is Commit -> o.put("seg", seg).put("text", text).put("startMs", startMs).put("endMs", endMs)
            is Rewind -> o.put("nextSeg", nextSeg)
            is Finish -> o.put("endMs", endMs).put("at", at)
            is Complete -> o.put("at", at)
            is Tidy -> o.put("markdown", markdown)
            is Inserted -> o.put("at", at)
            is Discarded -> o.put("at", at)
        }
        return o
    }

    companion object {
        fun fromJson(o: JSONObject): JournalRecord? = try {
            when (o.getString("t")) {
                "start" -> {
                    val list = o.optJSONArray("languages") ?: JSONArray()
                    Start(
                        session = o.getString("session"),
                        target = o.getString("target"),
                        surface = if (o.has("surface") && !o.isNull("surface")) o.getString("surface") else null,
                        languages = (0 until list.length()).map { list.getString(it) },
                        at = o.getLong("at"),
                    )
                }
                "commit" -> Commit(o.getInt("seg"), o.getString("text"), o.getLong("startMs"), o.getLong("endMs"))
                "rewind" -> Rewind(o.getInt("nextSeg"))
                "finish" -> Finish(o.getLong("endMs"), o.getLong("at"))
                "complete" -> Complete(o.getLong("at"))
                "tidy" -> Tidy(o.getString("markdown"))
                "inserted" -> Inserted(o.getLong("at"))
                "discarded" -> Discarded(o.getLong("at"))
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }
}

data class CommittedSegment(val seg: Int, val text: String, val startMs: Long, val endMs: Long)

data class Contiguous(val endMs: Long, val nextSeg: Int)

data class JournalSummary(
    val session: String,
    val target: String,
    val surface: String?,
    val languages: List<String>,
    val startedAt: Long,
    val segments: Map<Int, CommittedSegment>,
    val contiguousEndMs: Long,
    val nextSeg: Int,
    val finishEndMs: Long?,
    val finishedAt: Long?,
    val completedAt: Long?,
    val tidy: String?,
    val insertedAt: Long?,
    val discardedAt: Long?,
    val text: String,
)

fun contiguous(segments: Map<Int, CommittedSegment>): Contiguous {
    var endMs = 0L
    var seg = 0
    while (true) {
        val s = segments[seg] ?: break
        if (s.startMs != endMs) break
        endMs = s.endMs
        seg++
    }
    return Contiguous(endMs, seg)
}

fun committedText(segments: Map<Int, CommittedSegment>, upTo: Int = Int.MAX_VALUE): String =
    displayText(segments.values.filter { it.seg < upTo }.map { SegmentText(it.seg, it.text, true) }).committed

fun summarize(records: List<JournalRecord>): JournalSummary? {
    val head = records.firstOrNull() as? JournalRecord.Start ?: return null
    val segments = LinkedHashMap<Int, CommittedSegment>()
    var finishEndMs: Long? = null
    var finishedAt: Long? = null
    var completedAt: Long? = null
    var tidy: String? = null
    var insertedAt: Long? = null
    var discardedAt: Long? = null
    for (r in records.drop(1)) {
        when (r) {
            is JournalRecord.Commit -> segments[r.seg] = CommittedSegment(r.seg, r.text, r.startMs, r.endMs)
            is JournalRecord.Rewind -> segments.keys.removeAll { it >= r.nextSeg }
            is JournalRecord.Finish -> {
                finishEndMs = r.endMs
                finishedAt = r.at
            }
            is JournalRecord.Complete -> completedAt = r.at
            is JournalRecord.Tidy -> tidy = r.markdown
            is JournalRecord.Inserted -> insertedAt = r.at
            is JournalRecord.Discarded -> discardedAt = r.at
            is JournalRecord.Start -> Unit
        }
    }
    val c = contiguous(segments)
    return JournalSummary(
        session = head.session,
        target = head.target,
        surface = head.surface?.takeIf { it.isNotEmpty() },
        languages = head.languages,
        startedAt = head.at,
        segments = segments,
        contiguousEndMs = c.endMs,
        nextSeg = c.nextSeg,
        finishEndMs = finishEndMs,
        finishedAt = finishedAt,
        completedAt = completedAt,
        tidy = tidy,
        insertedAt = insertedAt,
        discardedAt = discardedAt,
        text = committedText(segments, c.nextSeg),
    )
}

const val INSERTED_KEEP_MS = 7 * 24 * 3_600_000L
const val DISCARDED_KEEP_MS = 24 * 3_600_000L
const val ABANDONED_KEEP_MS = 30 * 24 * 3_600_000L

fun expired(summary: JournalSummary, now: Long): Boolean {
    summary.insertedAt?.let { return now - it > INSERTED_KEEP_MS }
    summary.discardedAt?.let { return now - it > DISCARDED_KEEP_MS }
    return now - summary.startedAt > ABANDONED_KEEP_MS
}
