package com.nomoat.voiceinput

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import org.json.JSONObject

class FileVoiceStore(
    private val root: File,
    private val dispatcher: CoroutineDispatcher = defaultDispatcher(),
) : VoiceStore {

    override suspend fun append(session: String, record: JournalRecord) = withContext(dispatcher) {
        val dir = directory(session)
        dir.mkdirs()
        RandomAccessFile(File(dir, JOURNAL), "rw").use { file ->
            val length = file.length()
            var separator = ""
            if (length > 0) {
                file.seek(length - 1)
                if (file.read() != '\n'.code) separator = "\n"
            }
            file.seek(length)
            file.write((separator + record.toJson().toString() + "\n").toByteArray(Charsets.UTF_8))
            file.fd.sync()
        }
    }

    override suspend fun read(session: String): List<JournalRecord> = withContext(dispatcher) {
        val file = File(directory(session), JOURNAL)
        if (!file.isFile) return@withContext emptyList()
        file.readLines(Charsets.UTF_8).mapNotNull { line ->
            if (line.isBlank()) null
            else try {
                JournalRecord.fromJson(JSONObject(line))
            } catch (_: Exception) {
                null
            }
        }
    }

    override suspend fun sessions(): List<String> = withContext(dispatcher) {
        root.listFiles()?.filter { it.isDirectory && SESSION_ID.matches(it.name) }?.map { it.name } ?: emptyList()
    }

    override suspend fun putFrames(session: String, first: Int, frames: List<ByteArray>) = withContext(dispatcher) {
        if (frames.isEmpty()) return@withContext
        val dir = directory(session)
        dir.mkdirs()
        var index = first
        var i = 0
        while (i < frames.size) {
            val chunk = index / CHUNK_FRAMES
            RandomAccessFile(chunkFile(dir, chunk), "rw").use { file ->
                file.seek((index - chunk * CHUNK_FRAMES).toLong() * FRAME_BYTES)
                while (i < frames.size && index / CHUNK_FRAMES == chunk) {
                    file.write(frames[i])
                    i++
                    index++
                }
                file.fd.sync()
            }
        }
    }

    override suspend fun getFrames(session: String, from: Int, to: Int): List<ByteArray> = withContext(dispatcher) {
        val dir = directory(session)
        val out = ArrayList<ByteArray>()
        var open: Pair<Int, RandomAccessFile>? = null
        try {
            var index = from
            while (index < to) {
                val chunk = index / CHUNK_FRAMES
                if (open?.first != chunk) {
                    open?.second?.close()
                    open = null
                    val file = chunkFile(dir, chunk)
                    if (!file.isFile) break
                    open = chunk to RandomAccessFile(file, "r")
                }
                val file = open!!.second
                val offset = (index - chunk * CHUNK_FRAMES).toLong() * FRAME_BYTES
                if (offset + FRAME_BYTES > file.length()) break
                val frame = ByteArray(FRAME_BYTES)
                file.seek(offset)
                file.readFully(frame)
                out.add(frame)
                index++
            }
        } finally {
            open?.second?.close()
        }
        out
    }

    override suspend fun frameEnd(session: String): Int = withContext(dispatcher) {
        chunks(directory(session)).maxOfOrNull { (chunk, file) -> chunk * CHUNK_FRAMES + (file.length() / FRAME_BYTES).toInt() } ?: 0
    }

    override suspend fun dropFrames(session: String, below: Int) = withContext(dispatcher) {
        for ((chunk, file) in chunks(directory(session))) {
            if ((chunk.toLong() + 1) * CHUNK_FRAMES <= below.toLong()) file.delete()
        }
    }

    override suspend fun remove(session: String) = withContext(dispatcher) {
        directory(session).deleteRecursively()
        Unit
    }

    private fun directory(session: String): File {
        require(SESSION_ID.matches(session)) { "Invalid voice session id" }
        return File(root, session)
    }

    private fun chunkFile(dir: File, chunk: Int) = File(dir, "$chunk$CHUNK_SUFFIX")

    private fun chunks(dir: File): List<Pair<Int, File>> =
        dir.listFiles()?.mapNotNull { file ->
            if (!file.isFile || !file.name.endsWith(CHUNK_SUFFIX)) null
            else file.name.removeSuffix(CHUNK_SUFFIX).toIntOrNull()?.let { it to file }
        } ?: emptyList()

    companion object {
        const val CHUNK_FRAMES = 300
        private const val JOURNAL = "journal.jsonl"
        private const val CHUNK_SUFFIX = ".pcm"
        private val SESSION_ID = Regex("^[A-Za-z0-9-]{8,64}$")

        @Volatile private var shared: FileVoiceStore? = null

        @OptIn(ExperimentalCoroutinesApi::class)
        private fun defaultDispatcher(): CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)

        fun shared(context: Context): FileVoiceStore =
            shared ?: synchronized(this) {
                shared ?: FileVoiceStore(File(context.applicationContext.filesDir, "voice-input")).also { shared = it }
            }
    }
}
