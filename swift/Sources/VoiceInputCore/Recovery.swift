import Foundation

public enum DictationStatus: String, Sendable {
    case unfinished, complete, inserted, discarded
}

public struct StoredDictation: Sendable, Equatable, Identifiable {
    public var session: String
    public var target: String
    public var surface: String?
    public var startedAt: Int
    public var durationMs: Int
    public var text: String
    public var tidy: String?
    public var status: DictationStatus
    public var at: Int

    public var id: String { session }
}

public func listDictations(_ store: any VoiceStore, target: String? = nil, now: Int = VoiceTime.now()) async -> [StoredDictation] {
    var out: [StoredDictation] = []
    let sessions = (try? await store.sessions()) ?? []
    for session in sessions {
        guard let records = try? await store.read(session) else { continue }
        guard let summary = VoiceJournal.summarize(records) else {
            try? await store.remove(session)
            continue
        }
        if VoiceJournal.expired(summary, now: now) {
            try? await store.remove(session)
            continue
        }
        if let target, summary.target != target { continue }
        let frames = (try? await store.frameEnd(session)) ?? 0
        let durationMs = max(summary.finishEndMs ?? 0, summary.contiguousEndMs, frames * VoiceProtocol.frameMs)
        let status: DictationStatus = summary.insertedAt != nil ? .inserted
            : summary.discardedAt != nil ? .discarded
            : summary.completedAt != nil ? .complete
            : .unfinished
        let at = summary.insertedAt ?? summary.discardedAt ?? summary.completedAt ?? summary.finishedAt ?? summary.startedAt
        out.append(StoredDictation(
            session: session, target: summary.target, surface: summary.surface, startedAt: summary.startedAt,
            durationMs: durationMs, text: summary.text, tidy: summary.tidy, status: status, at: at
        ))
    }
    return out.enumerated().sorted { $0.element.at != $1.element.at ? $0.element.at > $1.element.at : $0.offset < $1.offset }.map(\.element)
}

public func markDiscarded(_ store: any VoiceStore, session: String, now: Int = VoiceTime.now()) async throws {
    try await store.append(session, .discarded(at: now))
    try await store.dropFrames(session, below: .max)
}

public func markInserted(_ store: any VoiceStore, session: String, now: Int = VoiceTime.now()) async throws {
    try await store.append(session, .inserted(at: now))
    try await store.dropFrames(session, below: .max)
}
