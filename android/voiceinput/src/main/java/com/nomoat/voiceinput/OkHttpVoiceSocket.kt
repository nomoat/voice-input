package com.nomoat.voiceinput

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

class OkHttpVoiceSocket private constructor(private val socket: WebSocket) : VoiceSocket {
    override fun send(text: String): Boolean = socket.send(text)

    override fun send(bytes: ByteArray): Boolean = socket.send(bytes.toByteString())

    override val queuedBytes: Long get() = socket.queueSize()

    override fun close(code: Int) {
        if (!socket.close(code, null)) socket.cancel()
    }

    class Factory(private val client: OkHttpClient = sharedClient) : VoiceSocketFactory {
        override fun connect(url: String, listener: VoiceSocketListener): VoiceSocket {
            val request = Request.Builder().url(url).build()
            val closed = AtomicBoolean(false)
            val socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    listener.onMessage(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    if (closed.compareAndSet(false, true)) listener.onClosed()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (closed.compareAndSet(false, true)) listener.onClosed()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (closed.compareAndSet(false, true)) listener.onClosed()
                }
            })
            return OkHttpVoiceSocket(socket)
        }
    }

    companion object {
        val sharedClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .build()
        }
    }
}
