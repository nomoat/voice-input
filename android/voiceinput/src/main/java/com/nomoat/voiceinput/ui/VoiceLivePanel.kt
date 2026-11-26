package com.nomoat.voiceinput.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nomoat.voiceinput.VoiceConnection
import com.nomoat.voiceinput.VoiceMode
import com.nomoat.voiceinput.VoicePhase
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlin.math.roundToInt

@Immutable
data class VoicePanelColors(
    val background: Color,
    val content: Color,
    val muted: Color,
    val border: Color,
    val accent: Color,
    val danger: Color,
    val onDanger: Color,
)

object VoicePanelDefaults {
    @Composable
    fun colors(
        background: Color = MaterialTheme.colorScheme.surface,
        content: Color = MaterialTheme.colorScheme.onSurface,
        muted: Color = MaterialTheme.colorScheme.onSurfaceVariant,
        border: Color = MaterialTheme.colorScheme.outlineVariant,
        accent: Color = MaterialTheme.colorScheme.error,
        danger: Color = MaterialTheme.colorScheme.error,
        onDanger: Color = MaterialTheme.colorScheme.onError,
    ): VoicePanelColors = VoicePanelColors(background, content, muted, border, accent, danger, onDanger)

    @Composable
    fun maxHeight(): Dp {
        val configuration = LocalConfiguration.current
        return if (configuration.screenWidthDp < 640) (configuration.screenHeightDp * 0.4f).dp else 320.dp
    }

    val MaxWidth: Dp = 560.dp
}

@Composable
fun VoiceLivePanel(
    controller: VoiceInputController,
    modifier: Modifier = Modifier,
    strings: VoiceStrings = englishVoiceStrings,
    colors: VoicePanelColors = VoicePanelDefaults.colors(),
    shape: Shape = RoundedCornerShape(16.dp),
    maxHeight: Dp = VoicePanelDefaults.maxHeight(),
) {
    val view by controller.view.collectAsState()
    VoiceLivePanel(
        view = view,
        onDone = { controller.finish() },
        onCancel = { controller.cancel() },
        onClose = { controller.close() },
        modifier = modifier,
        strings = strings,
        colors = colors,
        shape = shape,
        maxHeight = maxHeight,
    )
}

@Composable
fun VoiceLivePanel(
    view: VoiceInputView,
    onDone: () -> Unit,
    onCancel: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    strings: VoiceStrings = englishVoiceStrings,
    colors: VoicePanelColors = VoicePanelDefaults.colors(),
    shape: Shape = RoundedCornerShape(16.dp),
    maxHeight: Dp = VoicePanelDefaults.maxHeight(),
) {
    val state = view.state
    if (!view.open || state == null) return
    val phase = state.phase
    val recording = phase == VoicePhase.Recording || phase == VoicePhase.Starting
    val hold = state.mode == VoiceMode.Hold
    val handsFree = state.mode == VoiceMode.HandsFree
    val cancelArmed = view.cancelArmed && hold
    val status = when {
        view.tidying -> strings.tidying
        phase == VoicePhase.Paused -> strings.paused
        phase == VoicePhase.Finishing || phase == VoicePhase.Done -> strings.finishing
        phase == VoicePhase.Pending -> strings.savedOffline
        state.connection == VoiceConnection.Offline -> strings.offline
        state.connection == VoiceConnection.Connecting -> strings.connecting
        handsFree && state.silenceMs >= 60_000 -> strings.stillListening
        else -> strings.listening
    }
    val notice = when (view.notice) {
        VoiceNotice.Empty -> strings.emptyResult
        VoiceNotice.Microphone -> strings.microphoneDenied
        VoiceNotice.Unauthorized -> strings.signInAgain
        VoiceNotice.Rejected -> strings.rejected
        VoiceNotice.Limit -> strings.stoppedAtLimit
        VoiceNotice.Silence -> strings.stoppedBySilence
        VoiceNotice.Pending, null -> null
    }
    val background by animateColorAsState(if (cancelArmed) colors.danger else colors.background, label = "voicePanel")
    val foreground = if (cancelArmed) colors.onDanger else colors.content
    val muted = if (cancelArmed) colors.onDanger.copy(alpha = 0.75f) else colors.muted
    val committed = state.committed
    val interim = state.interim

    Column(
        modifier
            .widthIn(max = VoicePanelDefaults.MaxWidth)
            .fillMaxWidth()
            .heightIn(max = maxHeight)
            .clip(shape)
            .background(background)
            .border(1.dp, if (cancelArmed) Color.Transparent else colors.border, shape)
            .semantics { paneTitle = strings.voiceInput },
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LevelMeter(state.level, if (recording && !cancelArmed) colors.accent else muted)
            Text(
                if (cancelArmed) strings.releaseToCancel else status,
                Modifier.weight(1f),
                color = if (cancelArmed) foreground else muted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (state.remainingMs <= 60_000 && recording) Text(strings.minuteLeft, color = muted, fontSize = 12.sp)
            Text(clock(state.elapsedMs), color = muted, fontSize = 12.sp, style = TextStyle(fontFeatureSettings = "tnum"))
        }
        Box(Modifier.weight(1f, fill = false)) {
            val scroll = rememberScrollState()
            var follow by remember { mutableStateOf(true) }
            val threshold = with(LocalDensity.current) { 24.dp.toPx() }
            LaunchedEffect(scroll) {
                snapshotFlow { Triple(scroll.value, scroll.maxValue, scroll.isScrollInProgress) }
                    .distinctUntilChanged()
                    .collect { (value, max, scrolling) -> if (scrolling) follow = max - value < threshold }
            }
            LaunchedEffect(scroll, follow) {
                if (follow) snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .verticalScroll(scroll)
                    .padding(start = 14.dp, end = 14.dp, top = 4.dp, bottom = 10.dp),
            ) {
                if (committed.isNotEmpty() || interim.isNotEmpty()) {
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(color = foreground)) { append(committed) }
                            withStyle(SpanStyle(color = muted)) { append(interim) }
                        },
                        Modifier.clearAndSetSemantics {
                            contentDescription = committed.takeLast(200)
                            liveRegion = LiveRegionMode.Polite
                        },
                        fontSize = 16.sp,
                        lineHeight = 25.sp,
                    )
                    if (notice != null) Text(notice, Modifier.padding(top = 6.dp), color = colors.muted, fontSize = 13.sp)
                } else {
                    Text(notice ?: "…", color = muted, fontSize = 16.sp, lineHeight = 25.sp)
                }
            }
            if (!follow) {
                Text(
                    "${strings.latest} ↓",
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 12.dp, bottom = 6.dp)
                        .clip(RoundedCornerShape(50))
                        .background(colors.background)
                        .border(1.dp, colors.border, RoundedCornerShape(50))
                        .clickable { follow = true }
                        .padding(horizontal = 12.dp, vertical = 5.dp),
                    color = colors.content,
                    fontSize = 12.sp,
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(if (cancelArmed) Color.Transparent else colors.border))
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 10.dp, top = 6.dp, bottom = 10.dp).heightIn(min = 36.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (recording && hold) {
                Text(if (cancelArmed) strings.releaseToCancel else strings.holdHint, Modifier.weight(1f), color = if (cancelArmed) foreground else muted, fontSize = 12.sp)
            }
            if ((recording || phase == VoicePhase.Paused) && !hold) {
                Text(if (state.mode == VoiceMode.Undecided) "" else strings.tapHint, Modifier.weight(1f), color = muted, fontSize = 12.sp)
                PanelButton(strings.cancel, primary = false, colors = colors, onClick = onCancel)
                PanelButton(strings.done, primary = true, colors = colors, onClick = onDone)
            }
            if (!recording && phase != VoicePhase.Paused) {
                Spacer(Modifier.weight(1f))
                PanelButton(strings.close, primary = false, colors = colors, onClick = if (phase == VoicePhase.Pending || notice != null) onClose else onCancel)
            }
        }
    }
}

@Composable
private fun PanelButton(label: String, primary: Boolean, colors: VoicePanelColors, onClick: () -> Unit) {
    val shape = RoundedCornerShape(50)
    Text(
        label,
        Modifier
            .clip(shape)
            .then(if (primary) Modifier.background(colors.content) else Modifier.border(1.dp, colors.border, shape))
            .clickable(onClick = onClick)
            .heightIn(min = 32.dp)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        color = if (primary) colors.background else colors.content,
        fontSize = 13.sp,
    )
}

@Composable
private fun LevelMeter(level: Float, color: Color) {
    val bars = remember { floatArrayOf(0.55f, 0.85f, 1f, 0.7f, 0.45f) }
    Row(Modifier.height(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (k in bars) {
            val height = (14 * minOf(1f, level * 1.4f) * k).roundToInt().coerceAtLeast(3)
            Box(Modifier.width(3.dp).height(height.dp).clip(RoundedCornerShape(2.dp)).background(color))
        }
    }
}
