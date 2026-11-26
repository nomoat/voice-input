import Foundation
import Testing
@testable import VoiceInputCore

private func conformance(_ name: String) throws -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../conformance/\(name)")
        .standardizedFileURL
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
    return object as? [String: Any] ?? [:]
}

private func cases(_ file: String, _ key: String) throws -> [[String: Any]] {
    try conformance(file)[key] as? [[String: Any]] ?? []
}

private func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }

@Suite("conformance: text")
struct TextConformanceTests {
    @Test func join() throws {
        let all = try cases("text.json", "join")
        #expect(!all.isEmpty)
        for c in all {
            let a = c["a"] as? String ?? ""
            let b = c["b"] as? String ?? ""
            #expect(VoiceText.join(a, b) == c["out"] as? String, "join \(a) + \(b)")
        }
    }

    @Test func display() throws {
        let all = try cases("text.json", "display")
        #expect(!all.isEmpty)
        for (i, c) in all.enumerated() {
            let segments = (c["segments"] as? [[String: Any]] ?? []).map {
                SegmentText(seg: int($0["seg"]) ?? 0, text: $0["text"] as? String ?? "", final: $0["final"] as? Bool ?? false)
            }
            let shown = VoiceText.display(segments)
            #expect(shown == DisplayText(committed: c["committed"] as? String ?? "", interim: c["interim"] as? String ?? ""), "display #\(i)")
        }
    }

    @Test func insert() throws {
        let all = try cases("text.json", "insert")
        #expect(!all.isEmpty)
        for (i, c) in all.enumerated() {
            let r = VoiceText.insert(c["base"] as? String ?? "", selectionStart: int(c["start"]) ?? 0, selectionEnd: int(c["end"]) ?? 0, text: c["text"] as? String ?? "")
            #expect(r.value == c["value"] as? String, "insert #\(i)")
            #expect(r.caret == int(c["caret"]), "insert #\(i) caret")
        }
    }

    @Test func gesture() throws {
        let all = try cases("text.json", "gesture")
        #expect(!all.isEmpty)
        for (i, c) in all.enumerated() {
            var track: PressTrack?
            var result: VoiceRelease?
            for event in c["events"] as? [[Any]] ?? [] {
                let kind = event.first as? String
                let t = (event.count > 1 ? event[1] as? NSNumber : nil)?.doubleValue ?? 0
                let x = (event.count > 2 ? event[2] as? NSNumber : nil)?.doubleValue ?? 0
                let y = (event.count > 3 ? event[3] as? NSNumber : nil)?.doubleValue ?? 0
                switch kind {
                case "down": track = PressTrack(at: t, x: x, y: y)
                case "move": track = track?.moved(x: x, y: y)
                default: result = track?.release(at: t)
                }
            }
            #expect(result?.rawValue == c["result"] as? String, "gesture #\(i)")
        }
    }
}

@Suite("conformance: session")
@MainActor
struct SessionConformanceTests {
    nonisolated static func names() -> [String] {
        ((try? cases("session.json", "scenarios")) ?? []).compactMap { $0["name"] as? String }
    }

    @Test(arguments: SessionConformanceTests.names())
    func scenario(_ name: String) async throws {
        let scenario = try #require(try cases("session.json", "scenarios").first { $0["name"] as? String == name })
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        var checked = 0
        for step in scenario["steps"] as? [[String: Any]] ?? [] {
            if let action = step["do"] as? String {
                switch action {
                case "start":
                    await session.start(mode: VoiceMode(rawValue: step["mode"] as? String ?? "") ?? .undecided)
                    await rig.settle(session)
                case "frames":
                    rig.frames(int(step["count"]) ?? 0)
                case "open":
                    await rig.settle(session)
                    rig.socket.onOpen?()
                    checked = 0
                case "drop":
                    await rig.settle(session)
                    rig.socket.onClose?()
                case "reconnect":
                    let before = rig.sockets.count
                    rig.clock.advance(by: 10_000)
                    await rig.settle(session)
                    #expect(rig.sockets.count == before + 1, "\(name): reconnect opens one socket")
                case "finish":
                    session.finish()
                case "cancel":
                    session.cancel()
                default:
                    Issue.record("\(name): unknown step \(action)")
                }
            } else if let server = step["server"] {
                let data = try JSONSerialization.data(withJSONObject: server)
                rig.socket.onText?(String(decoding: data, as: UTF8.self))
            } else if let want = step["sent"] as? [String: Any] {
                let sent = Array(rig.socket.json.dropFirst(checked))
                let match = sent.firstIndex { message in
                    want.allSatisfy { key, value in (message[key] as? NSObject)?.isEqual(value) == true }
                }
                guard let match else {
                    Issue.record("\(name): sent \(want) not in \(sent)")
                    continue
                }
                checked += match + 1
            } else if let e = step["expect"] as? [String: Any] {
                await rig.settle(session)
                let st = session.state
                if let phase = e["phase"] as? String { #expect(st.phase.rawValue == phase, "\(name): phase") }
                if let connection = e["connection"] as? String { #expect(st.connection.rawValue == connection, "\(name): connection") }
                if let committed = e["committed"] as? String { #expect(st.committed == committed, "\(name): committed") }
                if let interim = e["interim"] as? String { #expect(st.interim == interim, "\(name): interim") }
                if let elapsed = int(e["elapsedMs"]) { #expect(st.elapsedMs == elapsed, "\(name): elapsedMs") }
                if let failure = e["failure"] as? String { #expect(st.failure?.rawValue == failure, "\(name): failure") }
                if let frames = int(e["sentFrames"]) { #expect(rig.socket.frames.count == frames, "\(name): sentFrames") }
                if let stored = int(e["storedFrames"]) {
                    let count = await rig.store.frameCount(session.id)
                    #expect(count == stored, "\(name): storedFrames")
                }
                if let journal = e["journal"] as? [String] {
                    let kinds = await rig.store.journal(session.id).map(\.kind)
                    #expect(kinds == journal, "\(name): journal")
                }
                if e.keys.contains("result") {
                    let settled = try #require(session.settledResult, "\(name): result settled")
                    if e["result"] is NSNull {
                        #expect(settled == nil, "\(name): result is null")
                    } else {
                        #expect(settled?.text == e["result"] as? String, "\(name): result")
                    }
                }
            }
        }
        session.abandon()
    }
}
