package com.nomoat.voiceinput.ui

import android.os.SystemClock
import android.view.View
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.view.HapticFeedbackConstantsCompat
import androidx.core.view.ViewCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nomoat.voiceinput.Release
import com.nomoat.voiceinput.VoiceGesture
import com.nomoat.voiceinput.VoiceMode

@Composable
fun rememberVoiceInputController(
    config: VoiceInputConfig,
    strings: VoiceStrings = englishVoiceStrings,
    environment: VoiceEnvironment? = null,
): VoiceInputController {
    val context = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    val actual = environment ?: remember(context) { VoiceEnvironment.android(context) }
    val controller = remember(actual) { VoiceInputController(scope, config, actual) }
    SideEffect {
        controller.config = config
        controller.strings = strings
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) controller.onBackground() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    DisposableEffect(controller) { onDispose { controller.dispose() } }
    return controller
}

internal fun haptic(view: View?, feedback: Int) {
    if (view != null) ViewCompat.performHapticFeedback(view, feedback)
}

suspend fun AwaitPointerEventScope.trackVoicePress(
    controller: VoiceInputController,
    down: PointerInputChange,
    view: View? = null,
    hold: Boolean = false,
    position: (PointerInputChange) -> Offset = { it.position },
) {
    val start = position(down)
    var track = VoiceGesture.press(down.uptimeMillis, start.x / density, start.y / density)
    var holding = hold
    var armed = false
    var ended = false
    if (holding) controller.setMode(VoiceMode.Hold)
    try {
        while (true) {
            val event = if (holding) {
                awaitPointerEvent()
            } else {
                val remaining = VoiceGesture.TAP_MS - (SystemClock.uptimeMillis() - down.uptimeMillis)
                if (remaining <= 0) null else withTimeoutOrNull(remaining) { awaitPointerEvent() }
            }
            if (event == null) {
                holding = true
                controller.setMode(VoiceMode.Hold)
                haptic(view, HapticFeedbackConstantsCompat.LONG_PRESS)
                continue
            }
            val change = event.changes.firstOrNull { it.id == down.id } ?: continue
            if (!change.pressed) {
                ended = true
                controller.armCancel(false)
                if (change.isConsumed) {
                    controller.finish(interrupted = true)
                    return
                }
                change.consume()
                val outcome = VoiceGesture.release(track, change.uptimeMillis).let { if (it == Release.HandsFree && holding) Release.Finish else it }
                when (outcome) {
                    Release.HandsFree -> {
                        controller.setMode(VoiceMode.HandsFree)
                        haptic(view, HapticFeedbackConstantsCompat.CONTEXT_CLICK)
                    }
                    Release.Cancel -> {
                        controller.cancel()
                        haptic(view, HapticFeedbackConstantsCompat.REJECT)
                    }
                    Release.Finish -> {
                        controller.finish()
                        haptic(view, HapticFeedbackConstantsCompat.CONFIRM)
                    }
                }
                return
            }
            change.consume()
            val at = position(change)
            track = VoiceGesture.move(track, at.x / density, at.y / density)
            if (!holding && VoiceGesture.isHold(track, change.uptimeMillis)) {
                holding = true
                controller.setMode(VoiceMode.Hold)
                haptic(view, HapticFeedbackConstantsCompat.LONG_PRESS)
            }
            if (track.cancelArmed != armed) {
                armed = track.cancelArmed
                controller.armCancel(armed)
                haptic(view, if (armed) HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstantsCompat.GESTURE_THRESHOLD_DEACTIVATE)
            }
        }
    } finally {
        if (!ended) {
            controller.armCancel(false)
            controller.finish(interrupted = true)
        }
    }
}

suspend fun AwaitPointerEventScope.awaitVoiceRelease(id: PointerId): Boolean {
    while (true) {
        val change = awaitPointerEvent().changes.firstOrNull { it.id == id } ?: continue
        if (!change.pressed) {
            val clean = !change.isConsumed
            change.consume()
            return clean
        }
        change.consume()
    }
}

@Composable
fun Modifier.voiceInputGesture(controller: VoiceInputController, enabled: Boolean = true): Modifier {
    val view = LocalView.current
    val latestEnabled by rememberUpdatedState(enabled)
    return pointerInput(controller) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            if (!latestEnabled) return@awaitEachGesture
            down.consume()
            val current = controller.view.value
            if (current.active) {
                if (current.state?.mode == VoiceMode.HandsFree && awaitVoiceRelease(down.id)) {
                    controller.finish()
                    haptic(view, HapticFeedbackConstantsCompat.CONFIRM)
                }
                return@awaitEachGesture
            }
            if (controller.begin(VoiceMode.Undecided) == null) return@awaitEachGesture
            trackVoicePress(controller, down, view)
        }
    }
}

@Composable
fun VoiceButton(
    controller: VoiceInputController,
    modifier: Modifier = Modifier,
    strings: VoiceStrings = englishVoiceStrings,
    enabled: Boolean = true,
    size: Dp = 44.dp,
    containerColor: Color = MaterialTheme.colorScheme.secondaryContainer,
    contentColor: Color = MaterialTheme.colorScheme.onSecondaryContainer,
    activeContainerColor: Color = MaterialTheme.colorScheme.error,
    activeContentColor: Color = MaterialTheme.colorScheme.onError,
) {
    val view by controller.view.collectAsState()
    val active = view.active
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(if (active) activeContainerColor else containerColor)
            .voiceInputGesture(controller, enabled)
            .semantics {
                role = Role.Button
                contentDescription = if (active) strings.stop else strings.voiceInput
                if (!enabled && !active) disabled()
                onClick(label = if (active) strings.done else strings.voiceInput) {
                    if (controller.active) controller.finish() else if (enabled) controller.begin(VoiceMode.HandsFree)
                    true
                }
                if (active) customActions = listOf(CustomAccessibilityAction(strings.cancel) { controller.cancel(); true })
            },
        contentAlignment = Alignment.Center,
    ) {
        if (active) StopIcon(activeContentColor, Modifier.size(size * 0.4f)) else MicIcon(contentColor, Modifier.size(size * 0.45f))
    }
}

@Composable
fun MicIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val u = this.size.minDimension / 24f
        val stroke = Stroke(width = 2 * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawRoundRect(color, topLeft = Offset(9 * u, 2 * u), size = Size(6 * u, 12 * u), cornerRadius = CornerRadius(3 * u), style = stroke)
        drawArc(color, startAngle = 0f, sweepAngle = 180f, useCenter = false, topLeft = Offset(5 * u, 3 * u), size = Size(14 * u, 14 * u), style = stroke)
        drawLine(color, Offset(12 * u, 17 * u), Offset(12 * u, 22 * u), strokeWidth = 2 * u, cap = StrokeCap.Round)
    }
}

@Composable
fun StopIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val u = this.size.minDimension / 24f
        drawRoundRect(color, topLeft = Offset(6 * u, 6 * u), size = Size(12 * u, 12 * u), cornerRadius = CornerRadius(2.5f * u))
    }
}
