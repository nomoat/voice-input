package com.nomoat.voiceinput

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MicrophoneCapture private constructor(
    context: Context,
    private val record: AudioRecord,
    private val sink: CaptureSink,
) : Capture {
    private val running = AtomicBoolean(true)
    private val audio = context.getSystemService(AudioManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val pauseLock = Any()
    private var focusLost = false
    private var silenced = false
    private var paused = false
    @Volatile private var focus: AudioFocusRequest? = null
    @Volatile private var recordingCallback: AudioManager.AudioRecordingCallback? = null

    override fun stop() {
        running.set(false)
    }

    private fun begin() {
        requestFocus()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) watchSilencing()
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IllegalStateException("The microphone is in use.")
        Thread({ loop() }, "voice-input-capture").start()
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val buffer = ShortArray(FRAME_SAMPLES)
        try {
            while (running.get()) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    if (running.get()) sink.samples(buffer.copyOf(read))
                } else if (read < 0) {
                    if (running.get()) sink.interrupted()
                    break
                }
            }
        } finally {
            release()
        }
    }

    private fun release() {
        runCatching { record.stop() }
        runCatching { record.release() }
        focus?.let { request -> runCatching { audio?.abandonAudioFocusRequest(request) } }
        focus = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            recordingCallback?.let { callback -> runCatching { audio?.unregisterAudioRecordingCallback(callback) } }
        }
        recordingCallback = null
    }

    private fun requestFocus() {
        val manager = audio ?: return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener({ change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> setPaused(fromFocus = true, value = true)
                    AudioManager.AUDIOFOCUS_GAIN -> setPaused(fromFocus = true, value = false)
                }
            }, handler)
            .build()
        focus = request
        runCatching { manager.requestAudioFocus(request) }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun watchSilencing() {
        val manager = audio ?: return
        val callback = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val mine = configs.firstOrNull { it.clientAudioSessionId == record.audioSessionId } ?: return
                setPaused(fromFocus = false, value = mine.isClientSilenced)
            }
        }
        recordingCallback = callback
        runCatching { manager.registerAudioRecordingCallback(callback, handler) }
    }

    private fun setPaused(fromFocus: Boolean, value: Boolean) {
        val change = synchronized(pauseLock) {
            if (fromFocus) focusLost = value else silenced = value
            val next = focusLost || silenced
            if (next == paused) null else next.also { paused = it }
        } ?: return
        if (!running.get()) return
        if (change) sink.interrupted() else sink.resumed()
    }

    companion object {
        fun factory(context: Context): CaptureFactory {
            val app = context.applicationContext
            return CaptureFactory { sink -> start(app, sink) }
        }

        @SuppressLint("MissingPermission")
        suspend fun start(context: Context, sink: CaptureSink): Capture = withContext(Dispatchers.IO) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw SecurityException("Microphone permission is not granted.")
            }
            val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minimum <= 0) throw IllegalStateException("The microphone does not support 16 kHz capture.")
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, FRAME_BYTES * 4),
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                throw IllegalStateException("The microphone is not available.")
            }
            val capture = MicrophoneCapture(context, record, sink)
            try {
                capture.begin()
            } catch (e: Throwable) {
                capture.release()
                throw e
            }
            capture
        }
    }
}
