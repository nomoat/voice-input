import Foundation

public enum VoiceProtocol {
    public static let version = 1
    public static let sampleRate = 16_000
    public static let frameMs = 100
    public static let frameSamples = sampleRate * frameMs / 1000
    public static let frameBytes = frameSamples * 2
    public static let maxSessionMs = 20 * 60_000
    public static let sendWindowMs = 30_000
}

public enum VoiceTime {
    public static func now() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
}

public struct VoiceErrorCode: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }

    public static let unauthorized = VoiceErrorCode("unauthorized")
    public static let badRequest = VoiceErrorCode("bad_request")
    public static let limit = VoiceErrorCode("limit")
    public static let providersUnavailable = VoiceErrorCode("providers_unavailable")
    public static let timeout = VoiceErrorCode("timeout")
    public static let server = VoiceErrorCode("server")
}

public struct StartMessage: Codable, Sendable, Equatable {
    public var type = "start"
    public var v: Int
    public var session: String
    public var token: String?
    public var languages: [String]
    public var surface: String?
    public var fromMs: Int
    public var nextSeg: Int

    public init(session: String, token: String? = nil, languages: [String], surface: String? = nil, fromMs: Int, nextSeg: Int, v: Int = VoiceProtocol.version) {
        self.v = v
        self.session = session
        self.token = token
        self.languages = languages
        self.surface = surface
        self.fromMs = fromMs
        self.nextSeg = nextSeg
    }
}

public enum ClientMessage: Sendable, Equatable {
    case start(StartMessage)
    case finish(endMs: Int)
    case cancel

    public func json() -> String {
        let data: Data?
        switch self {
        case .start(let start): data = try? JSONEncoder().encode(start)
        case .finish(let endMs): data = try? JSONEncoder().encode(FinishBody(endMs: endMs))
        case .cancel: data = try? JSONEncoder().encode(CancelBody())
        }
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    private struct FinishBody: Encodable {
        var type = "finish"
        var endMs: Int
    }

    private struct CancelBody: Encodable {
        var type = "cancel"
    }
}

public enum ServerEvent: Sendable, Equatable {
    case ready(maxMs: Int)
    case interim(seg: Int, text: String)
    case commit(seg: Int, text: String, startMs: Int, endMs: Int)
    case ack(ms: Int)
    case done(nextSeg: Int)
    case error(code: VoiceErrorCode, retryable: Bool)

    public static func parse(_ text: String) -> ServerEvent? {
        try? JSONDecoder().decode(ServerEvent.self, from: Data(text.utf8))
    }

    public func json() -> String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

extension ServerEvent: Codable {
    private enum Keys: String, CodingKey {
        case type, maxMs, seg, text, startMs, endMs, ms, nextSeg, code, retryable
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func int(_ key: Keys, min: Int = 0) -> Int? {
            guard let value = try? c.decode(Int.self, forKey: key), value >= min else { return nil }
            return value
        }
        func string(_ key: Keys) -> String? { try? c.decode(String.self, forKey: key) }
        let invalid = DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "Not a voice/v1 server event"))
        switch try c.decode(String.self, forKey: .type) {
        case "ready":
            self = .ready(maxMs: int(.maxMs, min: 1) ?? VoiceProtocol.maxSessionMs)
        case "interim":
            guard let seg = int(.seg), let text = string(.text) else { throw invalid }
            self = .interim(seg: seg, text: text)
        case "commit":
            guard let seg = int(.seg), let text = string(.text), let startMs = int(.startMs), let endMs = int(.endMs), endMs >= startMs else { throw invalid }
            self = .commit(seg: seg, text: text, startMs: startMs, endMs: endMs)
        case "ack":
            guard let ms = int(.ms) else { throw invalid }
            self = .ack(ms: ms)
        case "done":
            guard let nextSeg = int(.nextSeg) else { throw invalid }
            self = .done(nextSeg: nextSeg)
        case "error":
            guard let code = string(.code) else { throw invalid }
            self = .error(code: VoiceErrorCode(code), retryable: (try? c.decode(Bool.self, forKey: .retryable)) == true)
        default:
            throw invalid
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .ready(let maxMs):
            try c.encode("ready", forKey: .type)
            try c.encode(maxMs, forKey: .maxMs)
        case .interim(let seg, let text):
            try c.encode("interim", forKey: .type)
            try c.encode(seg, forKey: .seg)
            try c.encode(text, forKey: .text)
        case .commit(let seg, let text, let startMs, let endMs):
            try c.encode("commit", forKey: .type)
            try c.encode(seg, forKey: .seg)
            try c.encode(text, forKey: .text)
            try c.encode(startMs, forKey: .startMs)
            try c.encode(endMs, forKey: .endMs)
        case .ack(let ms):
            try c.encode("ack", forKey: .type)
            try c.encode(ms, forKey: .ms)
        case .done(let nextSeg):
            try c.encode("done", forKey: .type)
            try c.encode(nextSeg, forKey: .nextSeg)
        case .error(let code, let retryable):
            try c.encode("error", forKey: .type)
            try c.encode(code, forKey: .code)
            try c.encode(retryable, forKey: .retryable)
        }
    }
}
