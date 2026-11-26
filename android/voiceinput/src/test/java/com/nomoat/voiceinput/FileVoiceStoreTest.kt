package com.nomoat.voiceinput

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileVoiceStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private val session = "0f8a2c4e-7d1b-4c3a-9e5f-112233445566"

    private fun frame(index: Int) = ByteArray(FRAME_BYTES) { (index + it).toByte() }

    @Test
    fun journalRecordsRoundTrip() = runBlocking {
        val store = FileVoiceStore(folder.root)
        val records = listOf(
            JournalRecord.Start(session, "doc:1", "chat", listOf("zh-CN", "en-US"), 1),
            JournalRecord.Commit(0, "naïve café, world", 0, 1_000),
            JournalRecord.Rewind(1),
            JournalRecord.Finish(1_300, 2),
            JournalRecord.Complete(3),
            JournalRecord.Tidy("# Title"),
            JournalRecord.Inserted(4),
            JournalRecord.Discarded(5),
        )
        records.forEach { store.append(session, it) }
        assertEquals(records, store.read(session))
        assertEquals(listOf(session), store.sessions())
    }

    @Test
    fun aTornLastLineIsSkippedAndTheNextRecordStillReads() = runBlocking {
        val store = FileVoiceStore(folder.root)
        store.append(session, JournalRecord.Start(session, "t", null, emptyList(), 1))
        File(File(folder.root, session), "journal.jsonl").appendText("{\"t\":\"commit\",\"seg\":0,\"te")
        store.append(session, JournalRecord.Finish(100, 2))
        assertEquals(listOf("start", "finish"), store.read(session).map { it.t })
    }

    @Test
    fun framesSpanChunksAndDropWholeChunks() = runBlocking {
        val store = FileVoiceStore(folder.root)
        val first = FileVoiceStore.CHUNK_FRAMES - 5
        store.putFrames(session, first, (first until first + 10).map(::frame))
        assertEquals(first + 10, store.frameEnd(session))
        val read = store.getFrames(session, first, first + 20)
        assertEquals(10, read.size)
        read.forEachIndexed { i, bytes -> assertArrayEquals(frame(first + i), bytes) }
        store.dropFrames(session, FileVoiceStore.CHUNK_FRAMES)
        assertEquals(5, store.getFrames(session, FileVoiceStore.CHUNK_FRAMES, first + 10).size)
        assertTrue(store.getFrames(session, first, first + 10).isEmpty())
        store.dropFrames(session, Int.MAX_VALUE)
        assertEquals(0, store.frameEnd(session))
    }

    @Test
    fun removeDeletesTheSessionAndInvalidIdsAreRefused() = runBlocking {
        val store = FileVoiceStore(folder.root)
        store.append(session, JournalRecord.Start(session, "t", null, emptyList(), 1))
        store.putFrames(session, 0, listOf(frame(0)))
        store.remove(session)
        assertTrue(store.sessions().isEmpty())
        val refused = runCatching { store.append("../escape", JournalRecord.Complete(1)) }
        assertTrue(refused.isFailure)
    }

    @Test
    fun recoveryListsAndExpiresStoredDictations() = runBlocking {
        val store = FileVoiceStore(folder.root)
        val day = 24 * 3_600_000L
        val now = 40 * day
        val old = "aaaaaaaa-0000-0000-0000-000000000001"
        val inserted = "aaaaaaaa-0000-0000-0000-000000000002"
        val open = "aaaaaaaa-0000-0000-0000-000000000003"
        store.append(old, JournalRecord.Start(old, "t", null, emptyList(), now - 31 * day))
        store.append(inserted, JournalRecord.Start(inserted, "t", null, emptyList(), now - 3 * day))
        store.append(inserted, JournalRecord.Inserted(now - 2 * day))
        store.append(open, JournalRecord.Start(open, "t", null, emptyList(), now - day))
        store.append(open, JournalRecord.Commit(0, "hello", 0, 900))
        val list = listDictations(store, "t", now)
        assertEquals(listOf(open, inserted), list.map { it.session })
        assertEquals(listOf(DictationStatus.Unfinished, DictationStatus.Inserted), list.map { it.status })
        assertEquals(900L, list.first().durationMs)
        assertEquals(listOf(inserted, open).sorted(), store.sessions().sorted())
        markDiscarded(store, open, now)
        assertEquals(DictationStatus.Discarded, listDictations(store, "t", now).first { it.session == open }.status)
        assertTrue(listDictations(store, "t", now + 2 * day).none { it.session == open })
    }
}
