import Foundation

public protocol VoiceStore: Sendable {
    func append(_ session: String, _ record: JournalRecord) async throws
    func read(_ session: String) async throws -> [JournalRecord]
    func sessions() async throws -> [String]
    func putFrames(_ session: String, first: Int, _ frames: [Data]) async throws
    func getFrames(_ session: String, from: Int, to: Int) async throws -> [Data]
    func frameEnd(_ session: String) async throws -> Int
    func dropFrames(_ session: String, below: Int) async throws
    func remove(_ session: String) async throws
}

public actor MemoryVoiceStore: VoiceStore {
    public private(set) var journals: [String: [JournalRecord]] = [:]
    public private(set) var frames: [String: [Int: Data]] = [:]
    private var order: [String] = []

    public init() {}

    public func append(_ session: String, _ record: JournalRecord) {
        if journals[session] == nil { order.append(session) }
        journals[session, default: []].append(record)
    }

    public func read(_ session: String) -> [JournalRecord] { journals[session] ?? [] }

    public func sessions() -> [String] { order.filter { journals[$0] != nil } }

    public func putFrames(_ session: String, first: Int, _ batch: [Data]) {
        var map = frames[session] ?? [:]
        for (i, frame) in batch.enumerated() { map[first + i] = frame }
        frames[session] = map
    }

    public func getFrames(_ session: String, from: Int, to: Int) -> [Data] {
        guard to > from, let map = frames[session] else { return [] }
        var out: [Data] = []
        var i = from
        while i < to, let frame = map[i] {
            out.append(frame)
            i += 1
        }
        return out
    }

    public func frameEnd(_ session: String) -> Int {
        guard let last = frames[session]?.keys.max() else { return 0 }
        return last + 1
    }

    public func dropFrames(_ session: String, below: Int) {
        guard let map = frames[session] else { return }
        frames[session] = map.filter { $0.key >= below }
    }

    public func remove(_ session: String) {
        journals[session] = nil
        frames[session] = nil
        order.removeAll { $0 == session }
    }

    public func journal(_ session: String) -> [JournalRecord] { journals[session] ?? [] }

    public func frameCount(_ session: String) -> Int { frames[session]?.count ?? 0 }
}
