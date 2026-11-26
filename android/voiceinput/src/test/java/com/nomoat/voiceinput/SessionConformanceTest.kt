package com.nomoat.voiceinput

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(Parameterized::class)
class SessionConformanceTest(private val name: String, private val steps: JSONArray) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun scenarios(): List<Array<Any>> = Conformance.json("session.json").getJSONArray("scenarios").objects().map {
            arrayOf(it.getString("name"), it.getJSONArray("steps"))
        }

        fun mode(wire: String): VoiceMode = VoiceMode.entries.first { it.wire == wire }
    }

    @Test
    fun scenario() = runTest {
        val store = MemoryVoiceStore()
        val sockets = FakeSockets()
        val microphone = FakeMicrophone()
        val session = VoiceSession(
            VoiceSessionOptions(
                url = "wss://test",
                store = store,
                languages = listOf("zh-CN"),
                target = "t",
                capture = microphone,
                socket = sockets,
                scope = backgroundScope,
            ),
        )
        var frame = 0
        var checked = 0
        suspend fun TestScope.settle() {
            runCurrent()
            session.flushed()
            runCurrent()
        }
        for ((index, step) in steps.objects().withIndex()) {
            val where = "$name, step $index: $step"
            when {
                step.has("do") -> when (step.getString("do")) {
                    "start" -> {
                        session.start(mode(step.getString("mode")))
                        runCurrent()
                    }
                    "frames" -> {
                        microphone.frames(step.getInt("count"), first = frame)
                        frame += step.getInt("count")
                    }
                    "open" -> {
                        settle()
                        sockets.last.open()
                        checked = 0
                    }
                    "drop" -> sockets.last.drop()
                    "reconnect" -> {
                        val before = sockets.all.size
                        advanceTimeBy(10_000)
                        runCurrent()
                        settle()
                        assertEquals(where, before + 1, sockets.all.size)
                    }
                    "finish" -> session.finish()
                    "cancel" -> session.cancel()
                    else -> error("Unknown action in $where")
                }
                step.has("server") -> sockets.last.server(step.getJSONObject("server").toString())
                step.has("sent") -> {
                    val expected = step.getJSONObject("sent")
                    val sent = sockets.last.json.drop(checked)
                    val match = sent.indexOfFirst { m -> expected.keys().asSequence().all { k -> m.opt(k)?.toString() == expected.opt(k)?.toString() } }
                    assertTrue("$where: sent ${expected} in $sent", match >= 0)
                    checked += match + 1
                }
                step.has("expect") -> {
                    settle()
                    expect(where, step.getJSONObject("expect"), session, store, sockets)
                }
            }
        }
        session.abandon()
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun expect(where: String, e: JSONObject, session: VoiceSession, store: MemoryVoiceStore, sockets: FakeSockets) {
        val state = session.state.value
        if (e.has("phase")) assertEquals("$where phase", e.getString("phase"), state.phase.wire)
        if (e.has("connection")) assertEquals("$where connection", e.getString("connection"), state.connection.wire)
        if (e.has("committed")) assertEquals("$where committed", e.getString("committed"), state.committed)
        if (e.has("interim")) assertEquals("$where interim", e.getString("interim"), state.interim)
        if (e.has("elapsedMs")) assertEquals("$where elapsedMs", e.getLong("elapsedMs"), state.elapsedMs)
        if (e.has("failure")) assertEquals("$where failure", e.getString("failure"), state.failure?.wire)
        if (e.has("sentFrames")) assertEquals("$where sentFrames", e.getInt("sentFrames"), sockets.last.frames)
        if (e.has("storedFrames")) assertEquals("$where storedFrames", e.getInt("storedFrames"), store.frames[session.id]?.size ?: 0)
        if (e.has("journal")) assertEquals("$where journal", e.getJSONArray("journal").strings(), store.journals[session.id]?.map { it.t } ?: emptyList<String>())
        if (e.has("result")) {
            assertTrue("$where result settled", session.result.isCompleted)
            val result = session.result.getCompleted()
            val expected = if (e.isNull("result")) null else e.getString("result")
            assertEquals("$where result", expected, result?.text)
        }
    }
}
