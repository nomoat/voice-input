package com.nomoat.voiceinput

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionTest {
    private fun TestScope.session(
        store: VoiceStore,
        sockets: FakeSockets,
        capture: CaptureFactory?,
        maxMs: Long = MAX_SESSION_MS,
        silenceFinishMs: Long = 180_000,
    ) = VoiceSession(
        VoiceSessionOptions(
            url = "wss://test",
            store = store,
            languages = listOf("en-US"),
            target = "doc-1",
            capture = capture,
            socket = sockets,
            maxMs = maxMs,
            silenceFinishMs = silenceFinishMs,
            scope = backgroundScope,
            token = { "t" },
        ),
    )

    private fun commit(seg: Int, text: String, startMs: Long, endMs: Long) =
        """{"type":"commit","seg":$seg,"text":"$text","startMs":$startMs,"endMs":$endMs}"""

    private val ready = """{"type":"ready","maxMs":1200000}"""

    @Test
    fun theLengthLimitStopsAndKeepsTheText() = runTest {
        val store = MemoryVoiceStore()
        val sockets = FakeSockets()
        val mic = FakeMicrophone()
        val s = session(store, sockets, mic, maxMs = 1_500)
        s.start(VoiceMode.HandsFree)
        runCurrent()
        mic.frames(30)
        assertEquals(VoiceStop.Limit, s.state.value.stoppedBy)
        assertEquals(1_500L, s.state.value.elapsedMs)
        assertEquals(VoicePhase.Pending, s.state.value.phase)
        assertEquals(1, mic.stops)
        sockets.last.open()
        sockets.last.server(ready)
        assertEquals(15, sockets.last.frames)
        assertEquals("finish", sockets.last.json.last().getString("type"))
        assertEquals(1_500L, sockets.last.json.last().getLong("endMs"))
        sockets.last.server(commit(0, "kept", 0, 1_500))
        sockets.last.server("""{"type":"done","nextSeg":1}""")
        assertEquals("kept", s.result.await()?.text)
    }

    @Test
    fun handsFreeSilenceFinishes() = runTest {
        val mic = FakeMicrophone()
        val s = session(MemoryVoiceStore(), FakeSockets(), mic, silenceFinishMs = 500)
        s.start(VoiceMode.HandsFree)
        runCurrent()
        mic.frames(3)
        mic.frames(17, amplitude = 0)
        assertEquals(VoiceStop.Silence, s.state.value.stoppedBy)
        assertEquals(800L, s.state.value.elapsedMs)
    }

    @Test
    fun holdNeverStopsForSilence() = runTest {
        val mic = FakeMicrophone()
        val s = session(MemoryVoiceStore(), FakeSockets(), mic, silenceFinishMs = 500)
        s.start(VoiceMode.Hold)
        runCurrent()
        mic.frames(20, amplitude = 0)
        assertEquals(VoicePhase.Recording, s.state.value.phase)
        assertNull(s.state.value.stoppedBy)
    }

    @Test
    fun aMicrophoneFailureLeavesNothingBehind() = runTest {
        val store = MemoryVoiceStore()
        val s = session(store, FakeSockets(), CaptureFactory { throw SecurityException("denied") })
        s.start(VoiceMode.Hold)
        runCurrent()
        s.flushed()
        assertEquals(VoicePhase.Failed, s.state.value.phase)
        assertEquals(VoiceFailure.Microphone, s.state.value.failure)
        assertTrue(store.sessions().isEmpty())
        assertNull(s.result.await())
    }

    @Test
    fun aReleaseBeforeTheMicrophoneStartsEndsEmpty() = runTest {
        val store = MemoryVoiceStore()
        val gate = CompletableDeferred<Unit>()
        var stopped = false
        val s = session(store, FakeSockets(), CaptureFactory {
            gate.await()
            Capture { stopped = true }
        })
        val started = launch { s.start(VoiceMode.Hold) }
        runCurrent()
        s.finish()
        gate.complete(Unit)
        started.join()
        assertEquals("", s.result.await()?.text)
        assertTrue(stopped)
    }

    @Test
    fun anInterruptionPausesAndIgnoresAudioUntilResumed() = runTest {
        val mic = FakeMicrophone()
        val s = session(MemoryVoiceStore(), FakeSockets(), mic)
        s.start(VoiceMode.Hold)
        runCurrent()
        mic.frames(3)
        mic.sink!!.interrupted()
        assertEquals(VoicePhase.Paused, s.state.value.phase)
        mic.frames(3)
        assertEquals(300L, s.state.value.elapsedMs)
        mic.sink!!.resumed()
        mic.frames(2)
        assertEquals(500L, s.state.value.elapsedMs)
    }

    @Test
    fun restoreResendsTheSpoolFromTheContiguousEnd() = runTest {
        val store = MemoryVoiceStore()
        val sockets = FakeSockets()
        val mic = FakeMicrophone()
        val s = session(store, sockets, mic)
        s.start(VoiceMode.HandsFree)
        runCurrent()
        sockets.last.open()
        sockets.last.server(ready)
        mic.frames(25)
        sockets.last.server(commit(0, "one", 0, 1_000))
        sockets.last.drop()
        mic.frames(8, first = 25)
        s.abandon()
        runCurrent()
        s.flushed()
        val pending = listDictations(store, target = "doc-1")
        assertEquals(listOf(DictationStatus.Unfinished), pending.map { it.status })
        assertEquals(3_300L, pending.single().durationMs)
        assertEquals("one", pending.single().text)

        val restoredSockets = FakeSockets()
        val restored = VoiceSession.restore(
            s.id,
            VoiceSessionOptions(url = "wss://test", store = store, socket = restoredSockets, scope = backgroundScope),
        )!!
        assertEquals(VoiceMode.Restore, restored.state.value.mode)
        assertEquals(VoicePhase.Pending, restored.state.value.phase)
        runCurrent()
        restoredSockets.last.open()
        val start = restoredSockets.last.json.first()
        assertEquals(1_000L, start.getLong("fromMs"))
        assertEquals(1, start.getInt("nextSeg"))
        restoredSockets.last.server(ready)
        assertEquals(VoicePhase.Finishing, restored.state.value.phase)
        assertEquals(23, restoredSockets.last.frames)
        assertEquals(3_300L, restoredSockets.last.json.last().getLong("endMs"))
        restoredSockets.last.server(commit(1, "two", 1_000, 3_300))
        restoredSockets.last.server("""{"type":"done","nextSeg":2}""")
        assertEquals("one two", restored.result.await()?.text)
        restored.markInserted()
        assertNull(VoiceSession.restore(s.id, VoiceSessionOptions(url = "wss://test", store = store, socket = FakeSockets(), scope = backgroundScope)))
        assertEquals(DictationStatus.Inserted, listDictations(store).single().status)
    }

    @Test
    fun aSessionThatEndsWithoutWordsLeavesNothingToRecover() = runTest {
        val store = MemoryVoiceStore()
        val sockets = FakeSockets()
        val mic = FakeMicrophone()
        val s = session(store, sockets, mic)
        s.start(VoiceMode.Hold)
        runCurrent()
        mic.frames(5)
        s.finish()
        sockets.last.open()
        sockets.last.server(ready)
        sockets.last.server(commit(0, " ", 0, 500))
        sockets.last.server("""{"type":"done","nextSeg":1}""")
        assertTrue(s.result.await()?.text?.isBlank() == true)
        runCurrent()
        s.flushed()
        assertTrue(store.sessions().isEmpty())
        assertTrue(store.frames.isEmpty())
        assertTrue(listDictations(store).isEmpty())
    }

    @Test
    fun backoffGrowsAndResetsAfterReady() = runTest {
        val sockets = FakeSockets()
        val mic = FakeMicrophone()
        val s = session(MemoryVoiceStore(), sockets, mic)
        s.start(VoiceMode.HandsFree)
        runCurrent()
        assertEquals(1, sockets.all.size)
        sockets.last.drop()
        advanceTimeBy(499)
        runCurrent()
        assertEquals(1, sockets.all.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, sockets.all.size)
        sockets.last.drop()
        advanceTimeBy(999)
        runCurrent()
        assertEquals(2, sockets.all.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(3, sockets.all.size)
        sockets.last.open()
        sockets.last.server(ready)
        assertEquals(VoiceConnection.Online, s.state.value.connection)
        sockets.last.drop()
        advanceTimeBy(500)
        runCurrent()
        assertEquals(4, sockets.all.size)
        s.cancel()
    }

    @Test
    fun aSilentConnectionTimesOutAndReconnects() = runTest {
        val sockets = FakeSockets()
        val s = session(MemoryVoiceStore(), sockets, FakeMicrophone())
        s.start(VoiceMode.HandsFree)
        runCurrent()
        sockets.last.open()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(VoiceConnection.Offline, s.state.value.connection)
        assertTrue(sockets.last.closed)
        advanceTimeBy(500)
        runCurrent()
        assertEquals(2, sockets.all.size)
        s.cancel()
    }

    @Test
    fun theTokenGoesInTheStartMessage() = runTest {
        val sockets = FakeSockets()
        val s = session(MemoryVoiceStore(), sockets, FakeMicrophone())
        s.start(VoiceMode.Hold)
        runCurrent()
        sockets.last.open()
        val start = sockets.last.json.single()
        assertEquals("start", start.getString("type"))
        assertEquals(1, start.getInt("v"))
        assertEquals(s.id, start.getString("session"))
        assertEquals("t", start.getString("token"))
        assertEquals("en-US", start.getJSONArray("languages").getString(0))
        assertFalse(start.has("surface"))
        s.cancel()
    }

    @Test
    fun aRetryableErrorKeepsTheSessionAndAFatalOneRejects() = runTest {
        val sockets = FakeSockets()
        val s = session(MemoryVoiceStore(), sockets, FakeMicrophone())
        s.start(VoiceMode.HandsFree)
        runCurrent()
        sockets.last.open()
        sockets.last.server(ready)
        sockets.last.server("""{"type":"error","code":"providers_unavailable","retryable":true}""")
        assertEquals(VoicePhase.Recording, s.state.value.phase)
        sockets.last.server("""{"type":"error","code":"bad_request","retryable":false}""")
        assertEquals(VoicePhase.Failed, s.state.value.phase)
        assertEquals(VoiceFailure.Rejected, s.state.value.failure)
        assertNull(s.result.await())
    }

    @Test
    fun parsingRejectsMalformedEvents() {
        assertNull(parseServerEvent("not json"))
        assertNull(parseServerEvent("""{"type":"commit","seg":0,"text":"a","startMs":10,"endMs":5}"""))
        assertNull(parseServerEvent("""{"type":"interim","seg":-1,"text":"a"}"""))
        assertNull(parseServerEvent("""{"type":"ack","ms":1.5}"""))
        assertEquals(ServerEvent.Ready(MAX_SESSION_MS), parseServerEvent("""{"type":"ready"}"""))
        assertEquals(ServerEvent.Error("timeout", false), parseServerEvent("""{"type":"error","code":"timeout"}"""))
    }
}
