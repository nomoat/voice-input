package com.nomoat.voiceinput

import org.junit.Assert.assertEquals
import org.junit.Test

class TextConformanceTest {
    private val cases = Conformance.json("text.json")

    @Test
    fun join() {
        for (c in cases.getJSONArray("join").objects()) {
            assertEquals("join ${c.getString("a")} + ${c.getString("b")}", c.getString("out"), joinText(c.getString("a"), c.getString("b")))
        }
    }

    @Test
    fun display() {
        cases.getJSONArray("display").objects().forEachIndexed { i, c ->
            val segments = c.getJSONArray("segments").objects().map { SegmentText(it.getInt("seg"), it.getString("text"), it.getBoolean("final")) }
            assertEquals("display #$i", DisplayText(c.getString("committed"), c.getString("interim")), displayText(segments))
        }
    }

    @Test
    fun insert() {
        cases.getJSONArray("insert").objects().forEachIndexed { i, c ->
            val actual = insertText(c.getString("base"), c.getInt("start"), c.getInt("end"), c.getString("text"))
            assertEquals("insert #$i", Insertion(c.getString("value"), c.getInt("caret")), actual)
        }
    }

    @Test
    fun gesture() {
        cases.getJSONArray("gesture").objects().forEachIndexed { i, c ->
            var track: PressTrack? = null
            var result: Release? = null
            val events = c.getJSONArray("events")
            for (e in 0 until events.length()) {
                val event = events.getJSONArray(e)
                val at = event.getLong(1)
                when (event.getString(0)) {
                    "down" -> track = VoiceGesture.press(at, event.getDouble(2).toFloat(), event.getDouble(3).toFloat())
                    "move" -> track = VoiceGesture.move(track!!, event.getDouble(2).toFloat(), event.getDouble(3).toFloat())
                    else -> result = VoiceGesture.release(track!!, at)
                }
            }
            assertEquals("gesture #$i", c.getString("result"), result?.let { wireName(it.name) })
        }
    }
}
