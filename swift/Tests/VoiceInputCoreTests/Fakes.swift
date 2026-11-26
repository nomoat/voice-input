import Foundation
@testable import VoiceInputCore

@MainActor
final class FakeSocket: VoiceSocket {
    var onOpen: (@MainActor () -> Void)?
    var onText: (@MainActor (String) -> Void)?
    var onClose: (@MainActor () -> Void)?
    var bufferedAmount = 0
    var json: [[String: Any]] = []
    var frames: [Data] = []
    var closed = false

    func send(text: String) throws {
        let object = try JSONSerialization.jsonObject(with: Data(text.utf8))
        json.append(object as? [String: Any] ?? [:])
    }

    func send(data: Data) throws {
        frames.append(data)
    }

    func close(code: Int) {
        closed = true
    }

    func server(_ event: ServerEvent) {
        onText?(event.json())
    }
}

@MainActor
final class FakeClock: VoiceClock {
    var time = 1_700_000_000_000
    private var timers: [(key: Int, at: Int, action: @MainActor () -> Void)] = []
    private var nextKey = 0

    func now() -> Int { time }

    func schedule(after ms: Int, _ action: @escaping @MainActor () -> Void) -> any VoiceCancellable {
        let key = nextKey
        nextKey += 1
        timers.append((key, time + max(0, ms), action))
        return Timer { [weak self] in self?.timers.removeAll { $0.key == key } }
    }

    func advance(by ms: Int) {
        let end = time + ms
        while let next = timers.filter({ $0.at <= end }).min(by: { ($0.at, $0.key) < ($1.at, $1.key) }) {
            timers.removeAll { $0.key == next.key }
            time = next.at
            next.action()
        }
        time = end
    }

    final class Timer: VoiceCancellable {
        let cancelAction: () -> Void
        init(_ cancel: @escaping () -> Void) { cancelAction = cancel }
        func cancel() { cancelAction() }
    }
}

final class FakeCapture: VoiceCapture, @unchecked Sendable {
    private let lock = NSLock()
    private var isStopped = false

    var stopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isStopped
    }

    func stop() {
        lock.lock()
        isStopped = true
        lock.unlock()
    }
}

@MainActor
final class Rig {
    let store = MemoryVoiceStore()
    let clock = FakeClock()
    var sockets: [FakeSocket] = []
    var sink: VoiceCaptureSink?
    var capture = FakeCapture()
    var endpointError: (any Error)?
    var frame = 0

    var socket: FakeSocket { sockets[sockets.count - 1] }

    func options(maxMs: Int = VoiceProtocol.maxSessionMs, silenceFinishMs: Int = 180_000, capture: VoiceCaptureFactory? = nil) -> VoiceSessionOptions {
        VoiceSessionOptions(
            endpoint: { [unowned self] in
                if let error = self.endpointError { throw error }
                return VoiceEndpoint(url: URL(string: "wss://test.invalid/voice")!, token: "t")
            },
            languages: ["zh-CN"],
            target: "t",
            store: store,
            capture: capture ?? { [unowned self] sink in
                self.sink = sink
                return self.capture
            },
            socket: { [unowned self] _ in
                let socket = FakeSocket()
                self.sockets.append(socket)
                return socket
            },
            maxMs: maxMs,
            silenceFinishMs: silenceFinishMs,
            clock: clock
        )
    }

    func frames(_ count: Int, amplitude: Int16 = 4000) {
        for _ in 0..<count {
            let value: Int16 = frame % 2 == 1 ? amplitude : -amplitude
            frame += 1
            sink?.samples(Array(repeating: value, count: VoiceProtocol.frameSamples))
        }
    }

    func settle(_ session: VoiceSession) async {
        for _ in 0..<6 {
            await session.settled()
            await Task.yield()
        }
    }
}
