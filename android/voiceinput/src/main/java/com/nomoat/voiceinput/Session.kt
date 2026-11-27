package com.nomoat.voiceinput

import java.util.UUID
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal fun wireName(name: String): String = name.replaceFirstChar { it.lowercaseChar() }

enum class VoicePhase {
    Starting, Recording, Paused, Finishing, Pending, Done, Failed, Cancelled;

    val wire: String get() = wireName(name)
    val capturing: Boolean get() = this == Starting || this == Recording || this == Paused
}

enum class VoiceConnection {
    Connecting, Online, Offline;

    val wire: String get() = wireName(name)
}

enum class VoiceMode {
    Undecided, Hold, HandsFree, Restore;

    val wire: String get() = wireName(name)
}

enum class VoiceFailure {
    Microphone, Unauthorized, Rejected;

    val wire: String get() = wireName(name)
}

enum class VoiceStop {
    Limit, Silence, Interrupted;

    val wire: String get() = wireName(name)
}

data class VoiceState(
    val phase: VoicePhase = VoicePhase.Starting,
    val connection: VoiceConnection = VoiceConnection.Connecting,
    val mode: VoiceMode = VoiceMode.Undecided,
    val committed: String = "",
    val interim: String = "",
    val elapsedMs: Long = 0,
    val remainingMs: Long = MAX_SESSION_MS,
    val silenceMs: Long = 0,
    val level: Float = 0f,
    val failure: VoiceFailure? = null,
    val stoppedBy: VoiceStop? = null,
)

data class VoiceResult(val session: String, val text: String)

interface CaptureSink {
    fun samples(pcm: ShortArray)
    fun interrupted()
    fun resumed()
}

fun interface Capture {
    fun stop()
}

fun interface CaptureFactory {
    suspend fun start(sink: CaptureSink): Capture
}

interface VoiceSocket {
    fun send(text: String): Boolean
    fun send(bytes: ByteArray): Boolean
    val queuedBytes: Long
    fun close(code: Int = 1000)
}

interface VoiceSocketListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed()
}

fun interface VoiceSocketFactory {
    fun connect(url: String, listener: VoiceSocketListener): VoiceSocket
}

data class VoiceSessionOptions(
    val url: String,
    val store: VoiceStore,
    val languages: List<String> = emptyList(),
    val target: String = "",
    val surface: String? = null,
    val token: (suspend () -> String?)? = null,
    val capture: CaptureFactory? = null,
    val socket: VoiceSocketFactory = OkHttpVoiceSocket.Factory(),
    val maxMs: Long = MAX_SESSION_MS,
    val silenceFinishMs: Long = 180_000,
    val now: () -> Long = System::currentTimeMillis,
    val scope: CoroutineScope = VoiceSession.defaultScope,
    val id: String? = null,
)

fun frameLevel(rms: Double): Float {
    if (rms <= 0) return 0f
    val db = 20 * log10(rms / 32768)
    return ((db + 50) / 40).coerceIn(0.0, 1.0).toFloat()
}

class VoiceSession(private val options: VoiceSessionOptions) {
    val id: String = options.id ?: UUID.randomUUID().toString()
    private val lock = Any()
    private val maxMs = options.maxMs
    private val silenceFinishMs = options.silenceFinishMs
    private val now = options.now
    private val scope = options.scope
    private val mutableState = MutableStateFlow(VoiceState(remainingMs = maxMs))
    val state: StateFlow<VoiceState> = mutableState.asStateFlow()

    private var recorded = 0
    private var endFrame: Int? = null
    private val frames = HashMap<Int, ByteArray>()
    private var unsaved = ArrayList<ByteArray>()
    private var unsavedFirst = 0
    private var carry = ShortArray(0)
    private var silentFrames = 0
    private var stopping = false

    private val committed = HashMap<Int, CommittedSegment>()
    private val segments = HashMap<Int, SegmentText>()

    private var ws: VoiceSocket? = null
    private var wsGeneration = 0L
    private var ready = false
    private var sent = 0
    private var ackedMs = 0L
    private var finishSent = false
    private var finishRequested = false
    private var attempt = 0
    private var unauthorized = 0
    private var reconnectJob: Job? = null
    private var connectJob: Job? = null
    private var pumpJob: Job? = null

    private var capture: Capture? = null
    private var abandoned = false
    private var io: Job? = null
    private val settled = CompletableDeferred<VoiceResult?>()
    val result: Deferred<VoiceResult?> get() = settled

    @Volatile var storageFailed: Boolean = false
        private set

    private val sink = object : CaptureSink {
        override fun samples(pcm: ShortArray) {
            synchronized(lock) { receive(pcm) }
        }

        override fun interrupted() {
            synchronized(lock) {
                if (mutableState.value.phase == VoicePhase.Recording) update { it.copy(phase = VoicePhase.Paused, level = 0f) }
            }
        }

        override fun resumed() {
            synchronized(lock) {
                if (mutableState.value.phase == VoicePhase.Paused) update { it.copy(phase = VoicePhase.Recording) }
            }
        }
    }

    suspend fun start(mode: VoiceMode = VoiceMode.Undecided) {
        val factory = synchronized(lock) {
            update { it.copy(mode = mode) }
            val head = JournalRecord.Start(id, options.target, options.surface?.takeIf { it.isNotEmpty() }, options.languages, now())
            write { it.append(id, head) }
            connect()
            val factory = options.capture
            if (factory == null) fail(VoiceFailure.Microphone)
            factory
        } ?: return
        val started = try {
            factory.start(sink)
        } catch (e: CancellationException) {
            synchronized(lock) { fail(VoiceFailure.Microphone) }
            throw e
        } catch (_: Throwable) {
            synchronized(lock) { fail(VoiceFailure.Microphone) }
            return
        }
        synchronized(lock) {
            if (mutableState.value.phase != VoicePhase.Starting) {
                runCatching { started.stop() }
                return
            }
            capture = started
            update { it.copy(phase = VoicePhase.Recording) }
        }
    }

    fun setMode(mode: VoiceMode) {
        synchronized(lock) {
            if (mutableState.value.mode != mode) update { it.copy(mode = mode) }
        }
    }

    fun finish(stoppedBy: VoiceStop? = null): Unit = synchronized(lock) {
        if (!mutableState.value.phase.capturing || stopping) return
        stopping = true
        stopCapture()
        if (carry.isNotEmpty()) {
            val padded = ShortArray(FRAME_SAMPLES)
            carry.copyInto(padded)
            carry = ShortArray(0)
            addFrame(padded, 0)
        }
        flushFrames()
        endFrame = recorded
        finishRequested = true
        if (recorded == 0) {
            update { it.copy(phase = VoicePhase.Done, level = 0f, stoppedBy = stoppedBy ?: it.stoppedBy) }
            closeSocket()
            write { it.remove(id) }
            settled.complete(VoiceResult(id, ""))
            return
        }
        val endMs = recorded.toLong() * FRAME_MS
        val at = now()
        write { it.append(id, JournalRecord.Finish(endMs, at)) }
        update { it.copy(phase = if (ready) VoicePhase.Finishing else VoicePhase.Pending, level = 0f, stoppedBy = stoppedBy ?: it.stoppedBy) }
        pump()
    }

    fun cancel(): Unit = synchronized(lock) {
        val phase = mutableState.value.phase
        if (phase == VoicePhase.Done || phase == VoicePhase.Cancelled) return
        stopCapture()
        clearTimers()
        val socket = ws
        if (socket != null && ready) runCatching { socket.send(cancelMessage()) }
        closeSocket()
        flushFrames()
        frames.clear()
        val at = now()
        write { it.append(id, JournalRecord.Discarded(at)) }
        write { it.dropFrames(id, Int.MAX_VALUE) }
        update { it.copy(phase = VoicePhase.Cancelled, level = 0f) }
        settled.complete(null)
    }

    fun abandon(): Unit = synchronized(lock) {
        if (abandoned) return
        abandoned = true
        stopCapture()
        clearTimers()
        closeSocket()
        flushFrames()
    }

    fun detach() {
        if (mutableState.value.phase.capturing) finish()
    }

    suspend fun markInserted() {
        synchronized(lock) {
            val at = now()
            write { it.append(id, JournalRecord.Inserted(at)) }
            write { it.dropFrames(id, Int.MAX_VALUE) }
        }
        flushed()
    }

    suspend fun saveTidy(markdown: String) {
        synchronized(lock) { write { it.append(id, JournalRecord.Tidy(markdown)) } }
        flushed()
    }

    suspend fun flushed() {
        synchronized(lock) { io }?.join()
    }

    private fun receive(pcm: ShortArray) {
        if (!accepting()) return
        var data = pcm
        if (carry.isNotEmpty()) {
            data = ShortArray(carry.size + pcm.size)
            carry.copyInto(data)
            pcm.copyInto(data, carry.size)
        }
        var at = 0
        while (data.size - at >= FRAME_SAMPLES && accepting()) {
            addFrame(data, at)
            at += FRAME_SAMPLES
        }
        carry = data.copyOfRange(at, data.size)
    }

    private fun accepting(): Boolean {
        val phase = mutableState.value.phase
        return !stopping && (phase == VoicePhase.Recording || phase == VoicePhase.Starting)
    }

    private fun addFrame(data: ShortArray, offset: Int) {
        val bytes = ByteArray(FRAME_BYTES)
        var sum = 0.0
        for (i in 0 until FRAME_SAMPLES) {
            val v = data[offset + i].toInt()
            bytes[2 * i] = (v and 0xFF).toByte()
            bytes[2 * i + 1] = ((v shr 8) and 0xFF).toByte()
            sum += v.toDouble() * v
        }
        val rms = sqrt(sum / FRAME_SAMPLES)
        val index = recorded++
        frames[index] = bytes
        if (unsaved.isEmpty()) unsavedFirst = index
        unsaved.add(bytes)
        if (unsaved.size >= 5) flushFrames()
        silentFrames = if (rms < VOICE_RMS) silentFrames + 1 else 0
        val elapsedMs = recorded.toLong() * FRAME_MS
        val silenceMs = silentFrames.toLong() * FRAME_MS
        update { it.copy(elapsedMs = elapsedMs, remainingMs = max(0L, maxMs - elapsedMs), silenceMs = silenceMs, level = frameLevel(rms)) }
        if (!stopping && (mutableState.value.phase == VoicePhase.Recording || mutableState.value.phase == VoicePhase.Starting)) {
            if (elapsedMs >= maxMs) finish(VoiceStop.Limit)
            else if (mutableState.value.mode == VoiceMode.HandsFree && silenceMs >= silenceFinishMs) finish(VoiceStop.Silence)
        }
        pump()
    }

    private fun flushFrames() {
        if (unsaved.isEmpty()) return
        val first = unsavedFirst
        val batch = unsaved
        unsaved = ArrayList()
        write { it.putFrames(id, first, batch) }
    }

    private fun connect() {
        if (ws != null || isOver()) return
        val c = contiguous(committed)
        val stale = committed.keys.filter { it >= c.nextSeg }
        if (stale.isNotEmpty()) {
            stale.forEach { committed.remove(it) }
            write { it.append(id, JournalRecord.Rewind(c.nextSeg)) }
        }
        segments.keys.removeAll { it >= c.nextSeg }
        sent = (c.endMs / FRAME_MS).toInt()
        ackedMs = sent.toLong() * FRAME_MS
        finishSent = false
        ready = false
        val text = text()
        update {
            it.copy(
                connection = if (attempt == 0 && it.connection != VoiceConnection.Offline) VoiceConnection.Connecting else it.connection,
                committed = text.committed,
                interim = text.interim,
            )
        }
        val fromMs = c.endMs
        val nextSeg = c.nextSeg
        scope.launch { open(fromMs, nextSeg) }
    }

    private suspend fun open(fromMs: Long, nextSeg: Int) {
        val token = try {
            options.token?.invoke()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        synchronized(lock) {
            if (isOver() || ws != null) return
            val generation = ++wsGeneration
            val start = startMessage(id, token, options.languages, options.surface, fromMs, nextSeg)
            val listener = object : VoiceSocketListener {
                override fun onOpen() {
                    synchronized(lock) {
                        val socket = ws
                        if (generation == wsGeneration && socket != null) runCatching { socket.send(start) }
                    }
                }

                override fun onMessage(text: String) {
                    synchronized(lock) {
                        if (generation == wsGeneration && ws != null) parseServerEvent(text)?.let { event(it) }
                    }
                }

                override fun onClosed() {
                    synchronized(lock) {
                        if (generation == wsGeneration && ws != null) dropped()
                    }
                }
            }
            val socket = try {
                options.socket.connect(options.url, listener)
            } catch (_: Throwable) {
                dropped()
                return
            }
            ws = socket
            connectJob = scope.launch {
                delay(CONNECT_TIMEOUT_MS)
                synchronized(lock) { if (ws === socket && !ready) dropped() }
            }
        }
    }

    private fun event(event: ServerEvent) {
        when (event) {
            is ServerEvent.Ready -> {
                connectJob?.cancel()
                ready = true
                attempt = 0
                update { it.copy(connection = VoiceConnection.Online, phase = if (it.phase == VoicePhase.Pending) VoicePhase.Finishing else it.phase) }
                pump()
            }
            is ServerEvent.Interim -> {
                if (committed.containsKey(event.seg)) return
                segments[event.seg] = SegmentText(event.seg, event.text, false)
                updateText()
            }
            is ServerEvent.Commit -> {
                val segment = CommittedSegment(event.seg, event.text, event.startMs, event.endMs)
                committed[event.seg] = segment
                segments[event.seg] = SegmentText(event.seg, event.text, true)
                write { it.append(id, JournalRecord.Commit(segment.seg, segment.text, segment.startMs, segment.endMs)) }
                val below = (contiguous(committed).endMs / FRAME_MS).toInt()
                frames.keys.removeAll { it < below }
                write { it.dropFrames(id, below) }
                updateText()
            }
            is ServerEvent.Ack -> {
                ackedMs = max(ackedMs, event.ms)
                pump()
            }
            is ServerEvent.Done -> complete()
            is ServerEvent.Error -> {
                if (event.code == "unauthorized") {
                    unauthorized++
                    if (unauthorized >= 3) {
                        closeSocket()
                        fail(VoiceFailure.Unauthorized)
                    }
                    return
                }
                if (!event.retryable) {
                    closeSocket()
                    fail(VoiceFailure.Rejected)
                }
            }
        }
    }

    private fun complete() {
        if (mutableState.value.phase == VoicePhase.Done) return
        stopCapture()
        clearTimers()
        closeSocket()
        val at = now()
        val text = committedText(committed)
        if (text.isBlank()) write { it.remove(id) } else write { it.append(id, JournalRecord.Complete(at)) }
        update { it.copy(phase = VoicePhase.Done, connection = VoiceConnection.Online, committed = text, interim = "", level = 0f) }
        settled.complete(VoiceResult(id, text))
    }

    private fun dropped() {
        connectJob?.cancel()
        pumpJob?.cancel()
        val old = ws
        ws = null
        wsGeneration++
        ready = false
        if (old != null) runCatching { old.close(1000) }
        if (isOver()) return
        segments.keys.removeAll { !committed.containsKey(it) }
        val text = text()
        update {
            it.copy(
                connection = VoiceConnection.Offline,
                phase = if (it.phase == VoicePhase.Finishing) VoicePhase.Pending else it.phase,
                committed = text.committed,
                interim = text.interim,
            )
        }
        val delayMs = BACKOFF_MS[min(attempt, BACKOFF_MS.size - 1)]
        attempt++
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            synchronized(lock) { connect() }
        }
    }

    private fun pump() {
        val socket = ws ?: return
        if (!ready) return
        pumpJob?.cancel()
        try {
            while (sent < recorded && sent.toLong() * FRAME_MS < ackedMs + SEND_WINDOW_MS) {
                val frame = frames[sent] ?: break
                if (!socket.send(frame)) {
                    dropped()
                    return
                }
                sent++
                if (socket.queuedBytes > QUEUE_LIMIT_BYTES) {
                    pumpJob = scope.launch {
                        delay(PUMP_RETRY_MS)
                        synchronized(lock) { pump() }
                    }
                    return
                }
            }
            if (finishRequested && !finishSent && sent == recorded) {
                finishSent = true
                if (!socket.send(finishMessage((endFrame ?: recorded).toLong() * FRAME_MS))) dropped()
            }
        } catch (_: Exception) {
            dropped()
        }
    }

    private fun text(): DisplayText = displayText(segments.values)

    private fun updateText() {
        val text = text()
        update { it.copy(committed = text.committed, interim = text.interim) }
    }

    private fun fail(failure: VoiceFailure) {
        if (isOver()) return
        stopCapture()
        clearTimers()
        closeSocket()
        flushFrames()
        if (failure == VoiceFailure.Microphone) write { it.remove(id) }
        update { it.copy(phase = VoicePhase.Failed, failure = failure, level = 0f) }
        settled.complete(null)
    }

    private fun stopCapture() {
        val c = capture
        capture = null
        if (c != null) runCatching { c.stop() }
    }

    private fun closeSocket() {
        val old = ws
        ws = null
        wsGeneration++
        ready = false
        connectJob?.cancel()
        if (old != null) runCatching { old.close(1000) }
    }

    private fun clearTimers() {
        reconnectJob?.cancel()
        connectJob?.cancel()
        pumpJob?.cancel()
    }

    private fun isOver(): Boolean {
        if (abandoned) return true
        val phase = mutableState.value.phase
        return phase == VoicePhase.Done || phase == VoicePhase.Failed || phase == VoicePhase.Cancelled
    }

    private fun write(work: suspend (VoiceStore) -> Unit) {
        val previous = io
        val store = options.store
        io = scope.launch {
            previous?.join()
            try {
                work(store)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                storageFailed = true
            }
        }
    }

    private inline fun update(change: (VoiceState) -> VoiceState) {
        mutableState.value = change(mutableState.value)
    }

    companion object {
        private val BACKOFF_MS = longArrayOf(500, 1_000, 2_000, 4_000, 8_000, 10_000)
        private const val CONNECT_TIMEOUT_MS = 10_000L
        private const val VOICE_RMS = 200.0
        private const val QUEUE_LIMIT_BYTES = 256 * 1024L
        private const val PUMP_RETRY_MS = 50L

        val defaultScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Default) }

        suspend fun restore(id: String, options: VoiceSessionOptions): VoiceSession? {
            val summary = summarize(options.store.read(id)) ?: return null
            if (summary.insertedAt != null || summary.discardedAt != null) return null
            val session = VoiceSession(
                options.copy(
                    id = id,
                    target = summary.target,
                    languages = summary.languages,
                    surface = summary.surface ?: options.surface,
                    capture = null,
                ),
            )
            val from = (summary.contiguousEndMs / FRAME_MS).toInt()
            val stored = options.store.frameEnd(id)
            val end = maxOf(from, stored, ((summary.finishEndMs ?: 0L) / FRAME_MS).toInt())
            val loaded = if (end > from) options.store.getFrames(id, from, end) else emptyList()
            synchronized(session.lock) {
                for (s in summary.segments.values) {
                    session.committed[s.seg] = s
                    session.segments[s.seg] = SegmentText(s.seg, s.text, true)
                }
                loaded.forEachIndexed { i, f -> session.frames[from + i] = f }
                val available = from + loaded.size
                session.recorded = available
                session.endFrame = available
                session.unsavedFirst = available
                session.finishRequested = true
                session.stopping = true
                val text = session.text()
                session.update {
                    it.copy(
                        mode = VoiceMode.Restore,
                        phase = VoicePhase.Pending,
                        elapsedMs = available.toLong() * FRAME_MS,
                        remainingMs = 0,
                        committed = text.committed,
                        interim = text.interim,
                    )
                }
                if (summary.completedAt != null || available <= from) {
                    session.complete()
                    return session
                }
                if (summary.finishEndMs == null) {
                    val endMs = available.toLong() * FRAME_MS
                    val at = session.now()
                    session.write { it.append(id, JournalRecord.Finish(endMs, at)) }
                }
                session.connect()
            }
            return session
        }
    }
}
