package com.nomoat.voiceinput.ui

import com.nomoat.voiceinput.DictationStatus
import com.nomoat.voiceinput.JournalRecord
import com.nomoat.voiceinput.MemoryVoiceStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoverableDictationsTest {
    private val now = System.currentTimeMillis()
    private val store = MemoryVoiceStore()

    private suspend fun dictation(session: String, vararg texts: String, finished: Boolean) {
        store.append(session, JournalRecord.Start(session, "doc", null, listOf("en-US"), now - 120_000))
        texts.forEachIndexed { seg, text -> store.append(session, JournalRecord.Commit(seg, text, seg * 1_000L, (seg + 1) * 1_000L)) }
        store.putFrames(session, 0, List(600) { ByteArray(4) })
        if (finished) {
            store.append(session, JournalRecord.Finish(60_000, now - 60_000))
            store.append(session, JournalRecord.Complete(now - 59_000))
        }
    }

    @Test
    fun aFinishedDictationWithNoWordsIsNeverOfferedAndIsRemoved() = runBlocking {
        dictation("silent", finished = true)
        assertTrue(recoverableDictations(store, "doc").isEmpty())
        assertFalse("silent" in store.sessions())
        assertNull(store.frames["silent"])
    }

    @Test
    fun aFinishedDictationWithOnlyBlankWordsIsNeverOfferedAndIsRemoved() = runBlocking {
        dictation("blank", " ", "\n", finished = true)
        assertTrue(recoverableDictations(store, "doc").isEmpty())
        assertFalse("blank" in store.sessions())
    }

    @Test
    fun anUnfinishedDictationWithWordsIsStillOffered() = runBlocking {
        dictation("open", "hello", finished = false)
        val items = recoverableDictations(store, "doc")
        assertEquals(listOf("hello"), items.map { it.text })
        assertEquals(listOf(DictationStatus.Unfinished), items.map { it.status })
    }

    @Test
    fun anUnfinishedDictationWithOnlyAudioIsStillOffered() = runBlocking {
        dictation("audio", finished = false)
        assertEquals(listOf("audio"), recoverableDictations(store, "doc").map { it.session })
    }

    @Test
    fun aFinishedButNeverInsertedDictationWithWordsIsStillOffered() = runBlocking {
        dictation("done", "keep me", finished = true)
        val item = recoverableDictations(store, "doc").single()
        assertEquals("keep me", item.text)
        assertEquals(DictationStatus.Complete, item.status)
        assertEquals(60_000L, item.durationMs)
    }

    @Test
    fun aFinishedDictationWithOnlyATidyIsStillOffered() = runBlocking {
        dictation("tidy", finished = true)
        store.append("tidy", JournalRecord.Tidy("- kept"))
        assertEquals(listOf("- kept"), recoverableDictations(store, "doc").map { it.tidy })
    }
}
