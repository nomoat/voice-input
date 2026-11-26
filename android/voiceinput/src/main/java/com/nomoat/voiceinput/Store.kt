package com.nomoat.voiceinput

interface VoiceStore {
    suspend fun append(session: String, record: JournalRecord)
    suspend fun read(session: String): List<JournalRecord>
    suspend fun sessions(): List<String>
    suspend fun putFrames(session: String, first: Int, frames: List<ByteArray>)
    suspend fun getFrames(session: String, from: Int, to: Int): List<ByteArray>
    suspend fun frameEnd(session: String): Int
    suspend fun dropFrames(session: String, below: Int)
    suspend fun remove(session: String)
}

class MemoryVoiceStore : VoiceStore {
    val journals: MutableMap<String, MutableList<JournalRecord>> = LinkedHashMap()
    val frames: MutableMap<String, MutableMap<Int, ByteArray>> = LinkedHashMap()

    override suspend fun append(session: String, record: JournalRecord) {
        synchronized(this) { journals.getOrPut(session) { ArrayList() }.add(record) }
    }

    override suspend fun read(session: String): List<JournalRecord> = synchronized(this) { journals[session]?.toList() ?: emptyList() }

    override suspend fun sessions(): List<String> = synchronized(this) { journals.keys.toList() }

    override suspend fun putFrames(session: String, first: Int, frames: List<ByteArray>) {
        synchronized(this) {
            val map = this.frames.getOrPut(session) { HashMap() }
            frames.forEachIndexed { i, f -> map[first + i] = f.copyOf() }
        }
    }

    override suspend fun getFrames(session: String, from: Int, to: Int): List<ByteArray> = synchronized(this) {
        val map = frames[session]
        val out = ArrayList<ByteArray>()
        for (i in from until to) {
            val f = map?.get(i) ?: break
            out.add(f.copyOf())
        }
        out
    }

    override suspend fun frameEnd(session: String): Int = synchronized(this) {
        val map = frames[session]
        if (map.isNullOrEmpty()) 0 else map.keys.max() + 1
    }

    override suspend fun dropFrames(session: String, below: Int) {
        synchronized(this) { frames[session]?.keys?.removeAll { it < below } }
    }

    override suspend fun remove(session: String) {
        synchronized(this) {
            journals.remove(session)
            frames.remove(session)
        }
    }
}
