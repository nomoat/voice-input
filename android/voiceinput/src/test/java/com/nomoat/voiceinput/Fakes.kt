package com.nomoat.voiceinput

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

object Conformance {
    fun file(name: String): File {
        val roots = listOfNotNull(System.getProperty("voiceinput.conformance")?.let(::File), File("conformance"), File("../../conformance"))
        return roots.map { File(it, name) }.firstOrNull { it.isFile } ?: error("Missing conformance/$name; looked in ${roots.map { it.absolutePath }}")
    }

    fun json(name: String): JSONObject = JSONObject(file(name).readText(Charsets.UTF_8))
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

class FakeSocket(val listener: VoiceSocketListener) : VoiceSocket {
    val json = ArrayList<JSONObject>()
    var frames = 0
    var closed = false
    var queued = 0L

    override fun send(text: String): Boolean {
        json.add(JSONObject(text))
        return true
    }

    override fun send(bytes: ByteArray): Boolean {
        frames++
        return true
    }

    override val queuedBytes: Long get() = queued

    override fun close(code: Int) {
        closed = true
    }

    fun open() = listener.onOpen()

    fun server(message: String) = listener.onMessage(message)

    fun drop() {
        closed = true
        listener.onClosed()
    }
}

class FakeSockets : VoiceSocketFactory {
    val all = ArrayList<FakeSocket>()
    val last: FakeSocket get() = all.last()

    override fun connect(url: String, listener: VoiceSocketListener): VoiceSocket = FakeSocket(listener).also { all.add(it) }
}

class FakeMicrophone : CaptureFactory {
    var sink: CaptureSink? = null
    var stops = 0

    override suspend fun start(sink: CaptureSink): Capture {
        this.sink = sink
        return Capture { stops++ }
    }

    fun frames(count: Int, amplitude: Int = 4000, alternate: Boolean = true, first: Int = 0) {
        for (i in 0 until count) {
            val index = first + i
            val value = if (!alternate || index % 2 == 1) amplitude else -amplitude
            sink!!.samples(ShortArray(FRAME_SAMPLES) { value.toShort() })
        }
    }
}
