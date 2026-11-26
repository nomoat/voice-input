package com.nomoat.voiceinput.ui

import android.content.Context
import com.nomoat.voiceinput.CaptureFactory
import com.nomoat.voiceinput.FileVoiceStore
import com.nomoat.voiceinput.MAX_SESSION_MS
import com.nomoat.voiceinput.MicrophoneCapture
import com.nomoat.voiceinput.OkHttpVoiceSocket
import com.nomoat.voiceinput.VoiceFailure
import com.nomoat.voiceinput.VoiceMode
import com.nomoat.voiceinput.VoicePhase
import com.nomoat.voiceinput.VoiceResult
import com.nomoat.voiceinput.VoiceSession
import com.nomoat.voiceinput.VoiceSessionOptions
import com.nomoat.voiceinput.VoiceSocketFactory
import com.nomoat.voiceinput.VoiceState
import com.nomoat.voiceinput.VoiceStop
import com.nomoat.voiceinput.VoiceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

data class VoiceTextInfo(
    val raw: String,
    val tidied: Boolean,
    val session: String,
    val mode: VoiceMode,
    val stoppedBy: VoiceStop? = null,
)

data class VoiceInputConfig(
    val url: String,
    val languages: List<String>,
    val target: String,
    val onText: suspend (String, VoiceTextInfo) -> Unit,
    val token: (suspend () -> String?)? = null,
    val surface: String? = null,
    val tidy: (suspend (String) -> String?)? = null,
    val tidyMinChars: Int = 80,
    val maxMs: Long = MAX_SESSION_MS,
    val store: VoiceStore? = null,
    val capture: CaptureFactory? = null,
    val socket: VoiceSocketFactory? = null,
    val keepAlive: Boolean = true,
)

enum class VoiceNotice { Empty, Microphone, Unauthorized, Rejected, Limit, Silence, Pending }

data class VoiceInputView(
    val open: Boolean = false,
    val state: VoiceState? = null,
    val tidying: Boolean = false,
    val cancelArmed: Boolean = false,
    val notice: VoiceNotice? = null,
) {
    val active: Boolean get() = state?.phase?.capturing == true
}

interface VoiceKeepAlive {
    fun start(strings: VoiceStrings): Boolean
    fun stop()
}

class VoiceEnvironment(
    val store: VoiceStore,
    val capture: CaptureFactory?,
    val socket: VoiceSocketFactory,
    val sessionScope: CoroutineScope = VoiceSession.defaultScope,
    val keepAlive: VoiceKeepAlive? = null,
) {
    companion object {
        fun android(context: Context): VoiceEnvironment {
            val app = context.applicationContext
            return VoiceEnvironment(
                store = FileVoiceStore.shared(app),
                capture = MicrophoneCapture.factory(app),
                socket = OkHttpVoiceSocket.Factory(),
                keepAlive = VoiceRecordingService.keepAlive(app),
            )
        }
    }
}

class VoiceInputController(
    private val scope: CoroutineScope,
    config: VoiceInputConfig,
    private val environment: VoiceEnvironment,
) {
    var config: VoiceInputConfig = config
    var strings: VoiceStrings = englishVoiceStrings

    private val mutableView = MutableStateFlow(VoiceInputView())
    val view: StateFlow<VoiceInputView> = mutableView.asStateFlow()
    val active: Boolean get() = view.value.active

    var session: VoiceSession? = null
        private set

    private var stateJob: Job? = null
    private var noticeJob: Job? = null
    private var delivering = false
    private var keptAlive = false

    fun begin(mode: VoiceMode = VoiceMode.Undecided): VoiceSession? {
        session?.let { existing ->
            val phase = existing.state.value.phase
            if (phase.capturing || delivering || view.value.tidying) return existing
            if (phase == VoicePhase.Pending) existing.detach()
            close()
        }
        val c = config
        noticeJob?.cancel()
        val s = VoiceSession(
            VoiceSessionOptions(
                url = c.url,
                store = c.store ?: environment.store,
                languages = c.languages,
                target = c.target,
                surface = c.surface,
                token = c.token,
                capture = c.capture ?: environment.capture,
                socket = c.socket ?: environment.socket,
                maxMs = c.maxMs,
                scope = environment.sessionScope,
            ),
        )
        session = s
        mutableView.value = VoiceInputView(open = true, state = s.state.value)
        stateJob = scope.launch {
            s.state.collect { state -> if (session === s) onState(state) }
        }
        scope.launch {
            val result = s.result.await()
            if (session === s) onResult(s, result)
        }
        environment.sessionScope.launch { s.start(mode) }
        return s
    }

    fun finish(stoppedBy: VoiceStop? = null) {
        val s = session ?: return
        if (!s.state.value.phase.capturing) return
        s.finish(stoppedBy)
    }

    fun cancel() {
        val s = session ?: return close()
        when (s.state.value.phase) {
            VoicePhase.Done, VoicePhase.Failed, VoicePhase.Cancelled -> close()
            VoicePhase.Pending -> {
                s.detach()
                close()
            }
            else -> s.cancel()
        }
    }

    fun setMode(mode: VoiceMode) {
        val s = session ?: return
        if (s.state.value.phase.capturing) s.setMode(mode)
    }

    fun armCancel(armed: Boolean) {
        mutableView.update { if (it.cancelArmed == armed) it else it.copy(cancelArmed = armed) }
    }

    fun close() {
        noticeJob?.cancel()
        noticeJob = null
        stateJob?.cancel()
        stateJob = null
        val s = session
        session = null
        if (s != null && s.state.value.phase.capturing) s.detach()
        stopKeepAlive()
        mutableView.value = VoiceInputView()
    }

    fun onBackground() {
        val s = session ?: return
        val state = s.state.value
        if (!state.phase.capturing) return
        if (state.mode != VoiceMode.HandsFree || !keptAlive) finish(VoiceStop.Interrupted)
    }

    fun dispose() {
        noticeJob?.cancel()
        stateJob?.cancel()
        stateJob = null
        val s = session
        session = null
        stopKeepAlive()
        s?.detach()
    }

    private fun onState(state: VoiceState) {
        mutableView.update { v ->
            val notice = when {
                state.phase == VoicePhase.Pending -> VoiceNotice.Pending
                v.notice == VoiceNotice.Pending -> null
                else -> v.notice
            }
            v.copy(open = true, state = state, notice = notice)
        }
        if (state.phase == VoicePhase.Paused && state.mode != VoiceMode.HandsFree) {
            session?.finish(VoiceStop.Interrupted)
            return
        }
        if (state.phase.capturing) {
            if (state.mode == VoiceMode.HandsFree && config.keepAlive && !keptAlive) keptAlive = environment.keepAlive?.start(strings) == true
        } else {
            stopKeepAlive()
        }
    }

    private suspend fun onResult(s: VoiceSession, result: VoiceResult?) {
        stopKeepAlive()
        val state = s.state.value
        if (result == null) {
            if (state.phase == VoicePhase.Failed) {
                showNotice(
                    when (state.failure) {
                        VoiceFailure.Microphone -> VoiceNotice.Microphone
                        VoiceFailure.Unauthorized -> VoiceNotice.Unauthorized
                        else -> VoiceNotice.Rejected
                    },
                )
            } else {
                close()
            }
            return
        }
        if (result.text.isEmpty()) {
            showNotice(VoiceNotice.Empty, EMPTY_NOTICE_MS)
            return
        }
        try {
            deliver(s, result.text, state)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            if (session === s) showNotice(VoiceNotice.Rejected)
            return
        }
        if (session !== s) return
        when (state.stoppedBy) {
            VoiceStop.Limit -> showNotice(VoiceNotice.Limit, STOP_NOTICE_MS)
            VoiceStop.Silence -> showNotice(VoiceNotice.Silence, STOP_NOTICE_MS)
            VoiceStop.Interrupted, null -> close()
        }
    }

    private suspend fun deliver(s: VoiceSession, text: String, state: VoiceState) {
        val c = config
        var out = text
        var tidied = false
        val tidy = c.tidy
        if (tidy != null && text.length >= c.tidyMinChars) {
            mutableView.update { it.copy(tidying = true) }
            val markdown = try {
                withTimeoutOrNull(TIDY_TIMEOUT_MS) { tidy(text) }
            } catch (e: CancellationException) {
                currentCoroutineContext().ensureActive()
                null
            } catch (_: Throwable) {
                null
            }
            if (session !== s) return
            if (!markdown.isNullOrBlank()) {
                out = markdown
                tidied = true
                s.saveTidy(markdown)
            }
        }
        if (session !== s) return
        delivering = true
        try {
            c.onText(out, VoiceTextInfo(raw = text, tidied = tidied, session = s.id, mode = state.mode, stoppedBy = state.stoppedBy))
            withContext(NonCancellable) { s.markInserted() }
        } finally {
            delivering = false
        }
    }

    private fun showNotice(notice: VoiceNotice, autoCloseMs: Long? = null) {
        noticeJob?.cancel()
        mutableView.update { it.copy(notice = notice, tidying = false) }
        if (autoCloseMs != null) {
            noticeJob = scope.launch {
                delay(autoCloseMs)
                close()
            }
        }
    }

    private fun stopKeepAlive() {
        if (!keptAlive) return
        keptAlive = false
        environment.keepAlive?.stop()
    }

    companion object {
        const val TIDY_TIMEOUT_MS = 30_000L
        const val EMPTY_NOTICE_MS = 2_500L
        const val STOP_NOTICE_MS = 4_000L
    }
}
