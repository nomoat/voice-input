package com.nomoat.voiceinput

import kotlin.math.hypot

enum class Release { HandsFree, Finish, Cancel }

data class PressTrack(
    val downAt: Long,
    val x: Float,
    val y: Float,
    val moved: Boolean = false,
    val cancelArmed: Boolean = false,
)

object VoiceGesture {
    const val TAP_MS = 350L
    const val SLOP = 12f
    const val CANCEL = 65f

    fun press(at: Long, x: Float, y: Float): PressTrack = PressTrack(at, x, y)

    fun move(track: PressTrack, x: Float, y: Float): PressTrack {
        val moved = track.moved || hypot(x - track.x, y - track.y) > SLOP
        return track.copy(moved = moved, cancelArmed = track.y - y > CANCEL)
    }

    fun isHold(track: PressTrack, at: Long): Boolean = at - track.downAt >= TAP_MS || track.moved

    fun release(track: PressTrack, at: Long): Release = when {
        track.cancelArmed -> Release.Cancel
        !isHold(track, at) -> Release.HandsFree
        else -> Release.Finish
    }
}
