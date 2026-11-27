import Foundation
import Testing
@testable import VoiceInputCore

@Suite("file store")
struct FileStoreTests {
    private func temporaryStore() -> (FileVoiceStore, URL) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-input-tests-\(UUID().uuidString)", isDirectory: true)
        return (FileVoiceStore(directory: url), url)
    }

    private func frame(_ value: Int16) -> Data {
        Array(repeating: value, count: VoiceProtocol.frameSamples).withUnsafeBufferPointer { Data(buffer: $0) }
    }

    @Test func journalRoundTrip() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let id = "session-0001"
        let records: [JournalRecord] = [
            .start(session: id, target: "doc:1", surface: "document", languages: ["zh-CN", "en"], at: 10),
            .commit(CommittedSegment(seg: 0, text: "第一场", startMs: 0, endMs: 1000)),
            .rewind(nextSeg: 1),
            .finish(endMs: 1200, at: 11),
            .complete(at: 12),
            .tidy(markdown: "# 第一场"),
            .inserted(at: 13),
            .discarded(at: 14),
        ]
        for record in records { try await store.append(id, record) }
        #expect(try await store.read(id) == records)
        #expect(try await store.sessions() == [id])
        try await store.remove(id)
        #expect(try await store.sessions().isEmpty)
        #expect(try await store.read(id).isEmpty)
    }

    @Test func tornLastLineIsSkippedAndTheNextRecordSurvives() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let id = "session-0002"
        try await store.append(id, .start(session: id, target: "t", surface: nil, languages: [], at: 1))
        let journal = root.appendingPathComponent(id).appendingPathComponent("journal.jsonl")
        let handle = try FileHandle(forWritingTo: journal)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"t\":\"comm".utf8))
        try handle.close()
        let reopened = FileVoiceStore(directory: root)
        try await reopened.append(id, .complete(at: 2))
        #expect(try await reopened.read(id).map(\.kind) == ["start", "complete"])
    }

    @Test func framesSpanChunksAndDropByChunk() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let id = "session-0003"
        try await store.append(id, .start(session: id, target: "t", surface: nil, languages: [], at: 1))
        let frames = (0..<310).map { frame(Int16($0)) }
        try await store.putFrames(id, first: 0, Array(frames[0..<298]))
        try await store.putFrames(id, first: 298, Array(frames[298..<310]))
        #expect(try await store.frameEnd(id) == 310)
        let middle = try await store.getFrames(id, from: 296, to: 304)
        #expect(middle == Array(frames[296..<304]))
        try await store.dropFrames(id, below: 305)
        #expect(try await store.getFrames(id, from: 0, to: 5).isEmpty)
        #expect(try await store.getFrames(id, from: 305, to: 400) == Array(frames[305..<310]))
        #expect(try await store.frameEnd(id) == 310)
        try await store.dropFrames(id, below: .max)
        #expect(try await store.frameEnd(id) == 0)
        #expect(try await store.read(id).count == 1)
    }

    @Test func rejectsUnsafeSessionNames() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        await #expect(throws: FileVoiceStoreError.self) {
            try await store.append("../../etc", .complete(at: 1))
        }
    }

    @Test func recoveryListsByTargetAndExpires() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let now = 1_700_000_000_000
        try await store.append("aaaaaaaa-1", .start(session: "aaaaaaaa-1", target: "doc:1", surface: nil, languages: [], at: now - 1000))
        try await store.append("aaaaaaaa-1", .commit(CommittedSegment(seg: 0, text: "hello", startMs: 0, endMs: 900)))
        try await store.putFrames("aaaaaaaa-1", first: 9, [frame(1), frame(2)])
        try await store.append("bbbbbbbb-2", .start(session: "bbbbbbbb-2", target: "doc:2", surface: nil, languages: [], at: now - 500))
        try await store.append("bbbbbbbb-2", .commit(CommittedSegment(seg: 0, text: "two", startMs: 0, endMs: 400)))
        try await store.append("bbbbbbbb-2", .complete(at: now - 400))
        try await store.append("cccccccc-3", .start(session: "cccccccc-3", target: "doc:1", surface: nil, languages: [], at: now - VoiceJournal.abandonedKeepMs - 1))
        let doc1 = await listDictations(store, target: "doc:1", now: now)
        #expect(doc1.map(\.session) == ["aaaaaaaa-1"])
        #expect(doc1.first?.durationMs == 1100)
        #expect(doc1.first?.status == .unfinished)
        let all = await listDictations(store, now: now)
        #expect(all.map(\.session) == ["bbbbbbbb-2", "aaaaaaaa-1"])
        #expect(all.first?.status == .complete)
        #expect(try await store.sessions() == ["aaaaaaaa-1", "bbbbbbbb-2"])
        try await markDiscarded(store, session: "aaaaaaaa-1", now: now)
        #expect(try await store.frameEnd("aaaaaaaa-1") == 0)
        #expect(await listDictations(store, target: "doc:1", now: now).first?.status == .discarded)
    }

    private func seed(_ store: FileVoiceStore, _ session: String, _ records: [JournalRecord], frames: Int = 0, at: Int) async throws {
        try await store.append(session, .start(session: session, target: "doc:1", surface: nil, languages: ["zh-CN"], at: at))
        for record in records { try await store.append(session, record) }
        if frames > 0 { try await store.putFrames(session, first: 0, (0..<frames).map { frame(Int16($0)) }) }
    }

    @Test func aFinishedDictationWithNoTextIsRemovedWithItsAudio() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let now = 1_700_000_000_000
        try await seed(store, "silent-01", [
            .commit(CommittedSegment(seg: 0, text: "", startMs: 0, endMs: 3000)),
            .finish(endMs: 3000, at: now - 900), .complete(at: now - 800),
        ], frames: 150, at: now - 1000)
        try await seed(store, "nothing-02", [.finish(endMs: 1200, at: now - 900), .complete(at: now - 800)], frames: 60, at: now - 1000)
        try await seed(store, "blanks-03", [
            .commit(CommittedSegment(seg: 0, text: "  ", startMs: 0, endMs: 2000)),
            .commit(CommittedSegment(seg: 1, text: "\n", startMs: 2000, endMs: 4000)),
            .finish(endMs: 4000, at: now - 900), .complete(at: now - 800),
        ], at: now - 1000)
        #expect(await listDictations(store, target: "doc:1", now: now).isEmpty)
        #expect(try await store.sessions().isEmpty)
        for session in ["silent-01", "nothing-02", "blanks-03"] {
            #expect(try await store.frameEnd(session) == 0)
        }
    }

    @Test func dictationsWithTextOrUnsentAudioAreStillListed() async throws {
        let (store, root) = temporaryStore()
        defer { try? FileManager.default.removeItem(at: root) }
        let now = 1_700_000_000_000
        try await seed(store, "keeps-text-01", [
            .commit(CommittedSegment(seg: 0, text: "做一个短片", startMs: 0, endMs: 3000)),
            .finish(endMs: 3000, at: now - 900), .complete(at: now - 800),
        ], at: now - 1000)
        try await seed(store, "tidied-02", [
            .commit(CommittedSegment(seg: 0, text: " ", startMs: 0, endMs: 1000)),
            .complete(at: now - 700), .tidy(markdown: "Hello"),
        ], at: now - 1000)
        try await seed(store, "words-003", [.commit(CommittedSegment(seg: 0, text: "one", startMs: 0, endMs: 1000))], frames: 20, at: now - 600)
        try await seed(store, "audio-004", [], frames: 10, at: now - 500)
        try await seed(store, "inserted-05", [.complete(at: now - 450), .inserted(at: now - 400)], at: now - 450)
        let all = await listDictations(store, target: "doc:1", now: now)
        #expect(all.map(\.session) == ["inserted-05", "audio-004", "words-003", "tidied-02", "keeps-text-01"])
        #expect(all.map(\.status) == [.inserted, .unfinished, .unfinished, .complete, .complete])
        #expect(all.first { $0.session == "audio-004" }?.durationMs == 1000)
        #expect(all.first { $0.session == "tidied-02" }?.tidy == "Hello")
    }

    @Test func protocolMessagesMatchTheWire() throws {
        let start = ClientMessage.start(StartMessage(session: "s-123456", token: "tok", languages: ["zh-CN"], surface: "screenplay", fromMs: 1000, nextSeg: 1)).json()
        let object = try #require(try JSONSerialization.jsonObject(with: Data(start.utf8)) as? [String: Any])
        #expect(object["type"] as? String == "start")
        #expect(object["v"] as? Int == 1)
        #expect(object["token"] as? String == "tok")
        #expect(object["surface"] as? String == "screenplay")
        let bare = ClientMessage.start(StartMessage(session: "s-123456", languages: [], fromMs: 0, nextSeg: 0)).json()
        #expect(!bare.contains("token"))
        #expect(!bare.contains("surface"))
        #expect(ClientMessage.cancel.json() == "{\"type\":\"cancel\"}")
        #expect(ServerEvent.parse("{\"type\":\"ready\"}") == .ready(maxMs: VoiceProtocol.maxSessionMs))
        #expect(ServerEvent.parse("{\"type\":\"commit\",\"seg\":1,\"text\":\"x\",\"startMs\":5,\"endMs\":4}") == nil)
        #expect(ServerEvent.parse("{\"type\":\"interim\",\"seg\":-1,\"text\":\"x\"}") == nil)
        #expect(ServerEvent.parse("{\"type\":\"error\",\"code\":\"limit\"}") == .error(code: .limit, retryable: false))
        #expect(ServerEvent.parse("{\"type\":\"nope\"}") == nil)
        #expect(ServerEvent.parse("not json") == nil)
    }
}
