import Foundation

public struct CommittedSegment: Codable, Sendable, Equatable {
    public var seg: Int
    public var text: String
    public var startMs: Int
    public var endMs: Int

    public init(seg: Int, text: String, startMs: Int, endMs: Int) {
        self.seg = seg
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
    }
}

public enum JournalRecord: Sendable, Equatable {
    case start(session: String, target: String, surface: String?, languages: [String], at: Int)
    case commit(CommittedSegment)
    case rewind(nextSeg: Int)
    case finish(endMs: Int, at: Int)
    case complete(at: Int)
    case tidy(markdown: String)
    case inserted(at: Int)
    case discarded(at: Int)

    public var kind: String {
        switch self {
        case .start: "start"
        case .commit: "commit"
        case .rewind: "rewind"
        case .finish: "finish"
        case .complete: "complete"
        case .tidy: "tidy"
        case .inserted: "inserted"
        case .discarded: "discarded"
        }
    }
}

extension JournalRecord: Codable {
    private enum Keys: String, CodingKey {
        case t, session, target, surface, languages, at, seg, text, startMs, endMs, nextSeg, markdown
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "start":
            self = .start(
                session: try c.decode(String.self, forKey: .session),
                target: try c.decode(String.self, forKey: .target),
                surface: try c.decodeIfPresent(String.self, forKey: .surface),
                languages: try c.decodeIfPresent([String].self, forKey: .languages) ?? [],
                at: try c.decode(Int.self, forKey: .at)
            )
        case "commit":
            self = .commit(CommittedSegment(
                seg: try c.decode(Int.self, forKey: .seg),
                text: try c.decode(String.self, forKey: .text),
                startMs: try c.decode(Int.self, forKey: .startMs),
                endMs: try c.decode(Int.self, forKey: .endMs)
            ))
        case "rewind":
            self = .rewind(nextSeg: try c.decode(Int.self, forKey: .nextSeg))
        case "finish":
            self = .finish(endMs: try c.decode(Int.self, forKey: .endMs), at: try c.decode(Int.self, forKey: .at))
        case "complete":
            self = .complete(at: try c.decode(Int.self, forKey: .at))
        case "tidy":
            self = .tidy(markdown: try c.decode(String.self, forKey: .markdown))
        case "inserted":
            self = .inserted(at: try c.decode(Int.self, forKey: .at))
        case "discarded":
            self = .discarded(at: try c.decode(Int.self, forKey: .at))
        default:
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "Unknown journal record"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(kind, forKey: .t)
        switch self {
        case .start(let session, let target, let surface, let languages, let at):
            try c.encode(session, forKey: .session)
            try c.encode(target, forKey: .target)
            try c.encodeIfPresent(surface, forKey: .surface)
            try c.encode(languages, forKey: .languages)
            try c.encode(at, forKey: .at)
        case .commit(let s):
            try c.encode(s.seg, forKey: .seg)
            try c.encode(s.text, forKey: .text)
            try c.encode(s.startMs, forKey: .startMs)
            try c.encode(s.endMs, forKey: .endMs)
        case .rewind(let nextSeg):
            try c.encode(nextSeg, forKey: .nextSeg)
        case .finish(let endMs, let at):
            try c.encode(endMs, forKey: .endMs)
            try c.encode(at, forKey: .at)
        case .complete(let at), .inserted(let at), .discarded(let at):
            try c.encode(at, forKey: .at)
        case .tidy(let markdown):
            try c.encode(markdown, forKey: .markdown)
        }
    }
}

public struct JournalSummary: Sendable, Equatable {
    public var session: String
    public var target: String
    public var surface: String?
    public var languages: [String]
    public var startedAt: Int
    public var segments: [Int: CommittedSegment] = [:]
    public var contiguousEndMs = 0
    public var nextSeg = 0
    public var finishEndMs: Int?
    public var finishedAt: Int?
    public var completedAt: Int?
    public var tidy: String?
    public var insertedAt: Int?
    public var discardedAt: Int?
    public var text = ""
}

public enum VoiceJournal {
    public static let insertedKeepMs = 7 * 24 * 3_600_000
    public static let discardedKeepMs = 24 * 3_600_000
    public static let abandonedKeepMs = 30 * 24 * 3_600_000

    public static func contiguous(_ segments: [Int: CommittedSegment]) -> (endMs: Int, nextSeg: Int) {
        var endMs = 0
        var seg = 0
        while let s = segments[seg], s.startMs == endMs {
            endMs = s.endMs
            seg += 1
        }
        return (endMs, seg)
    }

    public static func committedText(_ segments: [Int: CommittedSegment], upTo: Int = .max) -> String {
        let parts = segments.values.filter { $0.seg < upTo }.map { SegmentText(seg: $0.seg, text: $0.text, final: true) }
        return VoiceText.display(parts).committed
    }

    public static func summarize(_ records: [JournalRecord]) -> JournalSummary? {
        guard case .start(let session, let target, let surface, let languages, let at)? = records.first else { return nil }
        var summary = JournalSummary(session: session, target: target, surface: surface, languages: languages, startedAt: at)
        for record in records.dropFirst() {
            switch record {
            case .commit(let s):
                summary.segments[s.seg] = s
            case .rewind(let nextSeg):
                summary.segments = summary.segments.filter { $0.key < nextSeg }
            case .finish(let endMs, let at):
                summary.finishEndMs = endMs
                summary.finishedAt = at
            case .complete(let at):
                summary.completedAt = at
            case .tidy(let markdown):
                summary.tidy = markdown
            case .inserted(let at):
                summary.insertedAt = at
            case .discarded(let at):
                summary.discardedAt = at
            case .start:
                break
            }
        }
        let c = contiguous(summary.segments)
        summary.contiguousEndMs = c.endMs
        summary.nextSeg = c.nextSeg
        summary.text = committedText(summary.segments, upTo: c.nextSeg)
        return summary
    }

    public static func expired(_ summary: JournalSummary, now: Int) -> Bool {
        if let insertedAt = summary.insertedAt { return now - insertedAt > insertedKeepMs }
        if let discardedAt = summary.discardedAt { return now - discardedAt > discardedKeepMs }
        return now - summary.startedAt > abandonedKeepMs
    }
}
