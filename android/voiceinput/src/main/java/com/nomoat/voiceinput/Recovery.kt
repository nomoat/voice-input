package com.nomoat.voiceinput

import kotlinx.coroutines.CancellationException

enum class DictationStatus {
    Unfinished, Complete, Inserted, Discarded;

    val wire: String get() = wireName(name)
}

data class StoredDictation(
    val session: String,
    val target: String,
    val surface: String?,
    val startedAt: Long,
    val durationMs: Long,
    val text: String,
    val tidy: String?,
    val status: DictationStatus,
    val at: Long,
)

suspend fun listDictations(store: VoiceStore, target: String? = null, now: Long = System.currentTimeMillis()): List<StoredDictation> {
    val out = ArrayList<StoredDictation>()
    for (session in store.sessions()) {
        val summary = try {
            summarize(store.read(session))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            continue
        }
        if (summary == null || expired(summary, now) || finishedEmpty(summary)) {
            try {
                store.remove(session)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            continue
        }
        if (target != null && summary.target != target) continue
        val frames = try {
            store.frameEnd(session)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            0
        }
        val durationMs = maxOf(summary.finishEndMs ?: 0L, summary.contiguousEndMs, frames.toLong() * FRAME_MS)
        val status = when {
            summary.insertedAt != null -> DictationStatus.Inserted
            summary.discardedAt != null -> DictationStatus.Discarded
            summary.completedAt != null -> DictationStatus.Complete
            else -> DictationStatus.Unfinished
        }
        val at = summary.insertedAt ?: summary.discardedAt ?: summary.completedAt ?: summary.finishedAt ?: summary.startedAt
        out.add(
            StoredDictation(
                session = session,
                target = summary.target,
                surface = summary.surface,
                startedAt = summary.startedAt,
                durationMs = durationMs,
                text = summary.text,
                tidy = summary.tidy?.takeIf { it.isNotEmpty() },
                status = status,
                at = at,
            ),
        )
    }
    return out.sortedByDescending { it.at }
}

internal fun finishedEmpty(summary: JournalSummary): Boolean =
    summary.completedAt != null && summary.insertedAt == null && summary.discardedAt == null &&
        summary.text.isBlank() && summary.tidy.isNullOrBlank()

suspend fun markDiscarded(store: VoiceStore, session: String, now: Long = System.currentTimeMillis()) {
    store.append(session, JournalRecord.Discarded(now))
    store.dropFrames(session, Int.MAX_VALUE)
}

suspend fun markInserted(store: VoiceStore, session: String, now: Long = System.currentTimeMillis()) {
    store.append(session, JournalRecord.Inserted(now))
    store.dropFrames(session, Int.MAX_VALUE)
}
