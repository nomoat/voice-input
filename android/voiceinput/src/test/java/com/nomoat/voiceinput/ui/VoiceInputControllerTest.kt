package com.nomoat.voiceinput.ui

import com.nomoat.voiceinput.CaptureFactory
import com.nomoat.voiceinput.FakeMicrophone
import com.nomoat.voiceinput.FakeSockets
import com.nomoat.voiceinput.MemoryVoiceStore
import com.nomoat.voiceinput.VoiceMode
import com.nomoat.voiceinput.VoicePhase
import com.nomoat.voiceinput.VoiceStop
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
class VoiceInputControllerTest {
    private class KeepAlive : VoiceKeepAlive {
        var starts = 0
        var stops = 0
        override fun start(strings: VoiceStrings): Boolean {
            starts++
            return true
        }
        override fun stop() {
            stops++
        }
    }

    private class Rig(scope: TestScope, capture: CaptureFactory? = null, refuse: Boolean = false) {
        val store = MemoryVoiceStore()
        val sockets = FakeSockets()
        val mic = FakeMicrophone()
        val keepAlive = KeepAlive()
        val texts = ArrayList<Pair<String, VoiceTextInfo>>()
        val controller = VoiceInputController(
            scope.backgroundScope,
            VoiceInputConfig(
                url = "wss://test",
                languages = listOf("en-US"),
                target = "doc",
                onText = { text, info ->
                    if (refuse) error("refused")
                    texts.add(text to info)
                },
            ),
            VoiceEnvironment(store, capture ?: mic, sockets, scope.backgroundScope, keepAlive),
        )

        fun serve(text: String, endMs: Long) {
            sockets.last.open()
            sockets.last.server("""{"type":"ready","maxMs":1200000}""")
            sockets.last.server("""{"type":"commit","seg":0,"text":"$text","startMs":0,"endMs":$endMs}""")
            sockets.last.server("""{"type":"done","nextSeg":1}""")
        }

        fun journal(): List<String> = store.journals.values.single().map { it.t }
    }

    @Test
    fun aReleasedHoldDeliversTheTranscriptAndMarksItInserted() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        assertTrue(rig.controller.view.value.open)
        runCurrent()
        rig.controller.setMode(VoiceMode.Hold)
        rig.mic.frames(5)
        rig.controller.finish()
        rig.serve("hello", 500)
        runCurrent()
        assertEquals(listOf("hello"), rig.texts.map { it.first })
        val info = rig.texts.single().second
        assertEquals(VoiceMode.Hold, info.mode)
        assertNull(info.stoppedBy)
        assertFalse(rig.controller.view.value.open)
        assertEquals("inserted", rig.journal().last())
        assertEquals(0, rig.keepAlive.starts)
    }

    @Test
    fun handsFreeKeepsRecordingInTheBackgroundAndReportsItsMode() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.HandsFree)
        runCurrent()
        assertEquals(1, rig.keepAlive.starts)
        rig.mic.frames(4)
        rig.controller.onBackground()
        assertEquals(VoicePhase.Recording, rig.controller.session?.state?.value?.phase)
        rig.controller.finish()
        rig.serve("long note", 400)
        runCurrent()
        assertEquals(VoiceMode.HandsFree, rig.texts.single().second.mode)
        assertEquals(1, rig.keepAlive.stops)
    }

    @Test
    fun goingToTheBackgroundFinishesAHoldAsInterrupted() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.Hold)
        rig.mic.frames(3)
        rig.controller.onBackground()
        assertEquals(VoicePhase.Pending, rig.controller.session?.state?.value?.phase)
        runCurrent()
        assertEquals(VoiceNotice.Pending, rig.controller.view.value.notice)
        rig.serve("kept", 300)
        runCurrent()
        val info = rig.texts.single().second
        assertEquals(VoiceMode.Hold, info.mode)
        assertEquals(VoiceStop.Interrupted, info.stoppedBy)
        assertFalse(rig.controller.view.value.open)
    }

    @Test
    fun losingAudioFocusFinishesAHoldAsInterrupted() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.Hold)
        rig.mic.frames(3)
        rig.mic.sink!!.interrupted()
        runCurrent()
        assertEquals(VoicePhase.Pending, rig.controller.session?.state?.value?.phase)
        assertEquals(1, rig.mic.stops)
        rig.controller.setMode(VoiceMode.HandsFree)
        assertEquals(VoiceMode.Hold, rig.controller.session?.state?.value?.mode)
        rig.serve("kept", 300)
        runCurrent()
        val info = rig.texts.single().second
        assertEquals(VoiceMode.Hold, info.mode)
        assertEquals(VoiceStop.Interrupted, info.stoppedBy)
        assertFalse(rig.controller.view.value.open)
    }

    @Test
    fun losingAudioFocusPausesHandsFree() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.HandsFree)
        rig.mic.frames(2)
        rig.mic.sink!!.interrupted()
        runCurrent()
        assertEquals(VoicePhase.Paused, rig.controller.session?.state?.value?.phase)
        rig.mic.sink!!.resumed()
        runCurrent()
        assertEquals(VoicePhase.Recording, rig.controller.session?.state?.value?.phase)
        rig.mic.frames(2, first = 2)
        rig.controller.finish()
        rig.serve("note", 400)
        runCurrent()
        val info = rig.texts.single().second
        assertEquals(VoiceMode.HandsFree, info.mode)
        assertNull(info.stoppedBy)
    }

    @Test
    fun anEmptyResultShowsANoticeThenCloses() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.finish()
        runCurrent()
        assertEquals(VoiceNotice.Empty, rig.controller.view.value.notice)
        assertTrue(rig.controller.view.value.open)
        advanceTimeBy(VoiceInputController.EMPTY_NOTICE_MS)
        runCurrent()
        assertFalse(rig.controller.view.value.open)
        assertTrue(rig.texts.isEmpty())
    }

    @Test
    fun cancelDiscardsAndCloses() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.mic.frames(3)
        rig.controller.cancel()
        runCurrent()
        assertFalse(rig.controller.view.value.open)
        assertNull(rig.controller.session)
        assertEquals("discarded", rig.journal().last())
    }

    @Test
    fun aSilentHoldShowsTheEmptyNoticeAndLeavesNothingToRecover() = runTest {
        val rig = Rig(this)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.Hold)
        rig.mic.frames(5)
        rig.controller.finish()
        rig.sockets.last.open()
        rig.sockets.last.server("""{"type":"ready","maxMs":1200000}""")
        rig.sockets.last.server("""{"type":"done","nextSeg":0}""")
        runCurrent()
        assertEquals(VoiceNotice.Empty, rig.controller.view.value.notice)
        assertTrue(rig.texts.isEmpty())
        assertTrue(rig.store.journals.isEmpty())
        assertTrue(recoverableDictations(rig.store, "doc").isEmpty())
    }

    @Test
    fun aRefusedInsertKeepsTheDictationForRecovery() = runTest {
        val rig = Rig(this, refuse = true)
        rig.controller.begin()
        runCurrent()
        rig.controller.setMode(VoiceMode.Hold)
        rig.mic.frames(3)
        rig.controller.finish()
        rig.serve("keep me", 300)
        runCurrent()
        assertEquals(VoiceNotice.Rejected, rig.controller.view.value.notice)
        assertEquals("complete", rig.journal().last())
        assertEquals(listOf("keep me"), recoverableDictations(rig.store, "doc").map { it.text })
    }

    @Test
    fun aMicrophoneFailureShowsItsNotice() = runTest {
        val rig = Rig(this, capture = CaptureFactory { throw SecurityException("denied") })
        rig.controller.begin()
        runCurrent()
        assertEquals(VoiceNotice.Microphone, rig.controller.view.value.notice)
        assertFalse(rig.controller.active)
    }

    @Test
    fun aNewPressAfterAFinishedSessionStartsAFreshOne() = runTest {
        val rig = Rig(this)
        val first = rig.controller.begin()
        runCurrent()
        rig.controller.finish()
        runCurrent()
        val second = rig.controller.begin()
        assertTrue(first !== second)
        assertTrue(rig.controller.view.value.open)
        assertNull(rig.controller.view.value.notice)
    }
}
