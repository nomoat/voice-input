import Foundation
import Observation

public enum VoicePhase: String, Sendable {
    case starting, recording, paused, finishing, pending, done, failed, cancelled
}

public enum VoiceConnection: String, Sendable {
    case connecting, online, offline
}

public enum VoiceMode: String, Sendable {
    case undecided, hold, handsFree, restore
}

public enum VoiceFailure: String, Sendable {
    case microphone, unauthorized, rejected
}

public enum VoiceStop: String, Sendable {
    case limit, silence, interrupted
}

public struct VoiceState: Sendable, Equatable {
    public var phase: VoicePhase
    public var connection: VoiceConnection
    public var mode: VoiceMode
    public var committed: String
    public var interim: String
    public var elapsedMs: Int
    public var remainingMs: Int
    public var silenceMs: Int
    public var level: Double
    public var failure: VoiceFailure?
    public var stoppedBy: VoiceStop?

    public var isActive: Bool { phase == .starting || phase == .recording || phase == .paused }
    public var isOver: Bool { phase == .done || phase == .failed || phase == .cancelled }
}

public struct VoiceResult: Sendable, Equatable {
    public var session: String
    public var text: String
}

public struct VoiceSessionOptions {
    public var endpoint: VoiceEndpointProvider
    public var languages: [String]
    public var target: String
    public var surface: String?
    public var store: any VoiceStore
    public var capture: VoiceCaptureFactory?
    public var socket: VoiceSocketFactory
    public var maxMs: Int
    public var silenceFinishMs: Int
    public var clock: (any VoiceClock)?
    public var id: String?

    public init(
        endpoint: @escaping VoiceEndpointProvider,
        languages: [String] = [],
        target: String = "",
        surface: String? = nil,
        store: any VoiceStore = FileVoiceStore.shared,
        capture: VoiceCaptureFactory? = nil,
        socket: @escaping VoiceSocketFactory = URLSessionVoiceSocket.factory,
        maxMs: Int = VoiceProtocol.maxSessionMs,
        silenceFinishMs: Int = 180_000,
        clock: (any VoiceClock)? = nil,
        id: String? = nil
    ) {
        self.endpoint = endpoint
        self.languages = languages
        self.target = target
        self.surface = surface
        self.store = store
        self.capture = capture
        self.socket = socket
        self.maxMs = maxMs
        self.silenceFinishMs = silenceFinishMs
        self.clock = clock
        self.id = id
    }
}

@MainActor
public final class VoiceSubscription {
    private var cancelAction: (() -> Void)?

    init(_ cancel: @escaping () -> Void) { cancelAction = cancel }

    public func cancel() {
        cancelAction?()
        cancelAction = nil
    }
}

public func voiceLevel(rms: Double) -> Double {
    guard rms > 0 else { return 0 }
    let db = 20 * log10(rms / 32768)
    return max(0, min(1, (db + 50) / 40))
}

@MainActor @Observable
public final class VoiceSession {
    public nonisolated let id: String
    public private(set) var state: VoiceState
    public private(set) var storageFailed = false

    @ObservationIgnored private let options: VoiceSessionOptions
    @ObservationIgnored private let maxMs: Int
    @ObservationIgnored private let silenceFinishMs: Int
    @ObservationIgnored private let clock: any VoiceClock
    @ObservationIgnored private var listeners: [(key: Int, call: @MainActor (VoiceState) -> Void)] = []
    @ObservationIgnored private var nextListener = 0

    @ObservationIgnored private var recorded = 0
    @ObservationIgnored private var endFrame: Int?
    @ObservationIgnored private var frames: [Int: Data] = [:]
    @ObservationIgnored private var unsaved: [Data] = []
    @ObservationIgnored private var unsavedFirst = 0
    @ObservationIgnored private var carry: [Int16] = []
    @ObservationIgnored private var silentFrames = 0
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var startRequested = false

    @ObservationIgnored private var committed: [Int: CommittedSegment] = [:]
    @ObservationIgnored private var segments: [Int: SegmentText] = [:]

    @ObservationIgnored private var ws: (any VoiceSocket)?
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var sent = 0
    @ObservationIgnored private var acked = 0
    @ObservationIgnored private var finishSent = false
    @ObservationIgnored private var finishRequested = false
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var unauthorized = 0
    @ObservationIgnored private var reconnectTimer: (any VoiceCancellable)?
    @ObservationIgnored private var connectTimer: (any VoiceCancellable)?
    @ObservationIgnored private var pumpTimer: (any VoiceCancellable)?
    @ObservationIgnored private var opening: Task<Void, Never>?

    @ObservationIgnored private var capture: (any VoiceCapture)?
    @ObservationIgnored private var abandoned = false
    @ObservationIgnored private var io: Task<Void, Never>?
    @ObservationIgnored private var outcome: VoiceResult??
    @ObservationIgnored private var waiters: [CheckedContinuation<VoiceResult?, Never>] = []

    private static let windowFrames = VoiceProtocol.sendWindowMs / VoiceProtocol.frameMs
    private static let backoffMs = [500, 1000, 2000, 4000, 8000, 10_000]
    private static let connectTimeoutMs = 10_000
    private static let voiceRMS = 200.0
    private static let maxBufferedBytes = 256 * 1024

    private static var live: [String: WeakSession] = [:]

    public static func running(_ id: String) -> VoiceSession? {
        guard let session = live[id]?.session, !session.isOver else { return nil }
        return session
    }

    public init(options: VoiceSessionOptions) {
        self.options = options
        id = options.id ?? UUID().uuidString.lowercased()
        maxMs = options.maxMs
        silenceFinishMs = options.silenceFinishMs
        clock = options.clock ?? SystemVoiceClock()
        state = VoiceState(
            phase: .starting, connection: .connecting, mode: .undecided, committed: "", interim: "",
            elapsedMs: 0, remainingMs: options.maxMs, silenceMs: 0, level: 0
        )
        Self.live = Self.live.filter { $0.value.session != nil }
        Self.live[id] = WeakSession(self)
    }

    public var result: VoiceResult? {
        get async {
            if let outcome { return outcome }
            return await withCheckedContinuation { waiters.append($0) }
        }
    }

    @discardableResult
    public func subscribe(_ listener: @escaping @MainActor (VoiceState) -> Void) -> VoiceSubscription {
        let key = nextListener
        nextListener += 1
        listeners.append((key, listener))
        listener(state)
        return VoiceSubscription { [weak self] in self?.listeners.removeAll { $0.key == key } }
    }

    public func start(mode: VoiceMode = .undecided) async {
        guard !startRequested, state.phase == .starting, !stopping, !abandoned else { return }
        startRequested = true
        if state.mode == .undecided { update { $0.mode = mode } }
        let head = JournalRecord.start(session: id, target: options.target, surface: options.surface, languages: options.languages, at: clock.now())
        write { store, id in try await store.append(id, head) }
        connect()
        guard let factory = options.capture else {
            fail(.microphone)
            return
        }
        let sink = VoiceCaptureSink(
            samples: { [weak self] pcm in self?.samples(pcm) },
            interrupted: { [weak self] in
                guard let self, self.state.phase == .recording else { return }
                if self.state.mode == .hold || self.state.mode == .undecided {
                    self.finish(stoppedBy: .interrupted)
                    return
                }
                self.update {
                    $0.phase = .paused
                    $0.level = 0
                }
            },
            resumed: { [weak self] in
                guard let self, self.state.phase == .paused else { return }
                self.update { $0.phase = .recording }
            }
        )
        let started: any VoiceCapture
        do {
            started = try await factory(sink)
        } catch {
            fail(.microphone)
            return
        }
        guard state.phase == .starting else {
            started.stop()
            return
        }
        capture = started
        update { $0.phase = .recording }
    }

    public static func restore(_ id: String, options: VoiceSessionOptions) async -> VoiceSession? {
        guard let records = try? await options.store.read(id),
              let summary = VoiceJournal.summarize(records),
              summary.insertedAt == nil, summary.discardedAt == nil else { return nil }
        var restored = options
        restored.id = id
        restored.target = summary.target
        restored.languages = summary.languages
        restored.capture = nil
        if let surface = summary.surface { restored.surface = surface }
        let session = VoiceSession(options: restored)
        for s in summary.segments.values {
            session.committed[s.seg] = s
            session.segments[s.seg] = SegmentText(seg: s.seg, text: s.text, final: true)
        }
        let frameMs = VoiceProtocol.frameMs
        let from = summary.contiguousEndMs / frameMs
        let stored = (try? await options.store.frameEnd(id)) ?? 0
        let end = max(from, stored, (summary.finishEndMs ?? 0) / frameMs)
        let spooled = end > from ? ((try? await options.store.getFrames(id, from: from, to: end)) ?? []) : []
        for (i, frame) in spooled.enumerated() { session.frames[from + i] = frame }
        let available = from + spooled.count
        session.recorded = available
        session.endFrame = available
        session.unsavedFirst = available
        session.finishRequested = true
        let text = session.text()
        session.update {
            $0.mode = .restore
            $0.phase = .pending
            $0.elapsedMs = available * frameMs
            $0.remainingMs = 0
            $0.committed = text.committed
            $0.interim = text.interim
        }
        if summary.completedAt != nil || available <= from {
            session.complete()
            return session
        }
        if summary.finishEndMs == nil {
            let record = JournalRecord.finish(endMs: available * frameMs, at: session.clock.now())
            session.write { store, id in try await store.append(id, record) }
        }
        session.connect()
        return session
    }

    public static func restore(
        _ id: String,
        endpoint: @escaping VoiceEndpointProvider,
        store: any VoiceStore = FileVoiceStore.shared,
        socket: @escaping VoiceSocketFactory = URLSessionVoiceSocket.factory,
        clock: (any VoiceClock)? = nil
    ) async -> VoiceSession? {
        await restore(id, options: VoiceSessionOptions(endpoint: endpoint, store: store, socket: socket, clock: clock))
    }

    public func setMode(_ mode: VoiceMode) {
        guard state.isActive, !stopping, state.mode != mode else { return }
        update { $0.mode = mode }
    }

    public func finish(stoppedBy: VoiceStop? = nil) {
        guard state.isActive, !stopping else { return }
        stopping = true
        stopCapture()
        if !carry.isEmpty {
            var padded = carry
            carry = []
            padded.append(contentsOf: repeatElement(0, count: max(0, VoiceProtocol.frameSamples - padded.count)))
            addFrame(padded[...])
        }
        flushFrames()
        endFrame = recorded
        finishRequested = true
        if recorded == 0 {
            update {
                $0.phase = .done
                $0.level = 0
                if let stoppedBy { $0.stoppedBy = stoppedBy }
            }
            closeSocket()
            write { store, id in try await store.remove(id) }
            settle(VoiceResult(session: id, text: ""))
            return
        }
        let record = JournalRecord.finish(endMs: recorded * VoiceProtocol.frameMs, at: clock.now())
        write { store, id in try await store.append(id, record) }
        let ready = ready
        update {
            $0.phase = ready ? .finishing : .pending
            $0.level = 0
            if let stoppedBy { $0.stoppedBy = stoppedBy }
        }
        pump()
    }

    public func cancel() {
        guard state.phase != .done, state.phase != .cancelled else { return }
        stopCapture()
        clearTimers()
        if let ws, ready { try? ws.send(text: ClientMessage.cancel.json()) }
        closeSocket()
        flushFrames()
        frames.removeAll()
        let record = JournalRecord.discarded(at: clock.now())
        write { store, id in try await store.append(id, record) }
        write { store, id in try await store.dropFrames(id, below: .max) }
        update {
            $0.phase = .cancelled
            $0.level = 0
        }
        settle(nil)
    }

    public func abandon() {
        guard !abandoned else { return }
        abandoned = true
        stopCapture()
        clearTimers()
        closeSocket()
        flushFrames()
        listeners.removeAll()
        settle(nil)
    }

    public func detach() {
        if state.isActive { finish() }
        listeners.removeAll()
    }

    public func markInserted() async {
        let record = JournalRecord.inserted(at: clock.now())
        write { store, id in try await store.append(id, record) }
        write { store, id in try await store.dropFrames(id, below: .max) }
        await flushed()
    }

    public func saveTidy(_ markdown: String) async {
        write { store, id in try await store.append(id, .tidy(markdown: markdown)) }
        await flushed()
    }

    public func flushed() async {
        await io?.value
    }

    var settledResult: VoiceResult?? { outcome }

    func settled() async {
        await opening?.value
        await io?.value
    }

    private var isOver: Bool { abandoned || state.isOver }

    private func samples(_ pcm: [Int16]) {
        guard state.phase == .recording else { return }
        var data = carry
        carry = []
        data.append(contentsOf: pcm)
        let size = VoiceProtocol.frameSamples
        var at = 0
        while data.count - at >= size && state.phase == .recording {
            addFrame(data[at..<(at + size)])
            at += size
        }
        if state.phase == .recording { carry = Array(data[at...]) }
    }

    private func addFrame(_ samples: ArraySlice<Int16>) {
        let bytes = samples.map(\.littleEndian).withUnsafeBufferPointer { Data(buffer: $0) }
        let index = recorded
        recorded += 1
        frames[index] = bytes
        if unsaved.isEmpty { unsavedFirst = index }
        unsaved.append(bytes)
        if unsaved.count >= 5 { flushFrames() }
        var sum = 0.0
        for s in samples { sum += Double(s) * Double(s) }
        let rms = (sum / Double(max(1, samples.count))).squareRoot()
        silentFrames = rms < Self.voiceRMS ? silentFrames + 1 : 0
        let elapsedMs = recorded * VoiceProtocol.frameMs
        let silenceMs = silentFrames * VoiceProtocol.frameMs
        let level = voiceLevel(rms: rms)
        let remainingMs = max(0, maxMs - elapsedMs)
        update {
            $0.elapsedMs = elapsedMs
            $0.remainingMs = remainingMs
            $0.silenceMs = silenceMs
            $0.level = level
        }
        if state.phase == .recording && !stopping {
            if elapsedMs >= maxMs {
                finish(stoppedBy: .limit)
            } else if state.mode == .handsFree && silenceMs >= silenceFinishMs {
                finish(stoppedBy: .silence)
            }
        }
        pump()
    }

    private func flushFrames() {
        guard !unsaved.isEmpty else { return }
        let first = unsavedFirst
        let batch = unsaved
        unsaved = []
        write { store, id in try await store.putFrames(id, first: first, batch) }
    }

    private func connect() {
        guard ws == nil, opening == nil, !isOver else { return }
        let c = VoiceJournal.contiguous(committed)
        let stale = committed.keys.filter { $0 >= c.nextSeg }
        if !stale.isEmpty {
            for seg in stale { committed[seg] = nil }
            let record = JournalRecord.rewind(nextSeg: c.nextSeg)
            write { store, id in try await store.append(id, record) }
        }
        segments = segments.filter { $0.key < c.nextSeg }
        let fromFrame = c.endMs / VoiceProtocol.frameMs
        sent = fromFrame
        acked = fromFrame
        finishSent = false
        ready = false
        let connection: VoiceConnection = attempt == 0 && state.connection != .offline ? .connecting : state.connection
        let text = text()
        update {
            $0.connection = connection
            $0.committed = text.committed
            $0.interim = text.interim
        }
        let nextSeg = c.nextSeg
        opening = Task { [weak self] in
            await self?.open(fromMs: fromFrame * VoiceProtocol.frameMs, nextSeg: nextSeg)
            self?.opening = nil
        }
    }

    private func open(fromMs: Int, nextSeg: Int) async {
        let endpoint: VoiceEndpoint
        do {
            endpoint = try await options.endpoint()
        } catch VoiceEndpointError.unauthorized {
            guard !isOver, ws == nil else { return }
            unauthorized += 1
            if unauthorized >= 3 { fail(.unauthorized) } else { dropped() }
            return
        } catch VoiceEndpointError.refused {
            guard !isOver, ws == nil else { return }
            fail(.rejected)
            return
        } catch {
            guard !isOver, ws == nil else { return }
            dropped()
            return
        }
        guard !isOver, ws == nil else { return }
        let socket = options.socket(endpoint.url)
        ws = socket
        connectTimer = clock.schedule(after: Self.connectTimeoutMs) { [weak self, weak socket] in
            guard let self, let socket, self.ws === socket, !self.ready else { return }
            self.dropped()
        }
        let token = endpoint.token.flatMap { $0.isEmpty ? nil : $0 }
        socket.onOpen = { [weak self, weak socket] in
            guard let self, let socket, self.ws === socket else { return }
            let start = StartMessage(session: self.id, token: token, languages: self.options.languages, surface: self.options.surface, fromMs: fromMs, nextSeg: nextSeg)
            do {
                try socket.send(text: ClientMessage.start(start).json())
            } catch {
                self.dropped()
            }
        }
        socket.onText = { [weak self, weak socket] text in
            guard let self, let socket, self.ws === socket, let event = ServerEvent.parse(text) else { return }
            self.event(event)
        }
        socket.onClose = { [weak self, weak socket] in
            guard let self, let socket, self.ws === socket else { return }
            self.dropped()
        }
    }

    private func event(_ event: ServerEvent) {
        switch event {
        case .ready:
            connectTimer?.cancel()
            connectTimer = nil
            ready = true
            attempt = 0
            update {
                $0.connection = .online
                if $0.phase == .pending { $0.phase = .finishing }
            }
            pump()
        case .interim(let seg, let text):
            guard committed[seg] == nil else { return }
            segments[seg] = SegmentText(seg: seg, text: text, final: false)
            refreshText()
        case .commit(let seg, let text, let startMs, let endMs):
            let segment = CommittedSegment(seg: seg, text: text, startMs: startMs, endMs: endMs)
            committed[seg] = segment
            segments[seg] = SegmentText(seg: seg, text: text, final: true)
            write { store, id in try await store.append(id, .commit(segment)) }
            let below = VoiceJournal.contiguous(committed).endMs / VoiceProtocol.frameMs
            for key in frames.keys where key < below { frames[key] = nil }
            write { store, id in try await store.dropFrames(id, below: below) }
            refreshText()
        case .ack(let ms):
            acked = max(acked, ms / VoiceProtocol.frameMs)
            pump()
        case .done:
            complete()
        case .error(let code, let retryable):
            if code == .unauthorized {
                unauthorized += 1
                if unauthorized >= 3 {
                    closeSocket()
                    fail(.unauthorized)
                }
                return
            }
            if !retryable {
                closeSocket()
                fail(.rejected)
            }
        }
    }

    private func complete() {
        guard state.phase != .done else { return }
        clearTimers()
        closeSocket()
        let record = JournalRecord.complete(at: clock.now())
        write { store, id in try await store.append(id, record) }
        let text = VoiceJournal.committedText(committed)
        update {
            $0.phase = .done
            $0.connection = .online
            $0.committed = text
            $0.interim = ""
            $0.level = 0
        }
        settle(VoiceResult(session: id, text: text))
    }

    private func dropped() {
        connectTimer?.cancel()
        connectTimer = nil
        pumpTimer?.cancel()
        pumpTimer = nil
        let socket = ws
        ws = nil
        ready = false
        if let socket {
            socket.onOpen = nil
            socket.onText = nil
            socket.onClose = nil
            socket.close(code: 1000)
        }
        if isOver { return }
        segments = segments.filter { committed[$0.key] != nil }
        let phase: VoicePhase = state.phase == .finishing ? .pending : state.phase
        let text = text()
        update {
            $0.connection = .offline
            $0.phase = phase
            $0.committed = text.committed
            $0.interim = text.interim
        }
        let delay = Self.backoffMs[min(attempt, Self.backoffMs.count - 1)]
        attempt += 1
        reconnectTimer?.cancel()
        reconnectTimer = clock.schedule(after: delay) { [weak self] in self?.connect() }
    }

    private func pump() {
        guard let ws, ready else { return }
        pumpTimer?.cancel()
        pumpTimer = nil
        do {
            while sent < recorded && sent < acked + Self.windowFrames {
                guard let frame = frames[sent] else { break }
                try ws.send(data: frame)
                sent += 1
                if ws.bufferedAmount > Self.maxBufferedBytes {
                    pumpTimer = clock.schedule(after: 50) { [weak self] in self?.pump() }
                    return
                }
            }
            if finishRequested && !finishSent && sent == recorded {
                finishSent = true
                try ws.send(text: ClientMessage.finish(endMs: (endFrame ?? recorded) * VoiceProtocol.frameMs).json())
            }
        } catch {
            dropped()
        }
    }

    private func text() -> DisplayText {
        VoiceText.display(segments.values)
    }

    private func refreshText() {
        let text = text()
        update {
            $0.committed = text.committed
            $0.interim = text.interim
        }
    }

    private func fail(_ failure: VoiceFailure) {
        guard !isOver else { return }
        stopCapture()
        clearTimers()
        closeSocket()
        flushFrames()
        if failure == .microphone { write { store, id in try await store.remove(id) } }
        update {
            $0.phase = .failed
            $0.failure = failure
            $0.level = 0
        }
        settle(nil)
    }

    private func stopCapture() {
        let current = capture
        capture = nil
        current?.stop()
    }

    private func closeSocket() {
        let socket = ws
        ws = nil
        ready = false
        connectTimer?.cancel()
        connectTimer = nil
        guard let socket else { return }
        socket.onOpen = nil
        socket.onText = nil
        socket.onClose = nil
        socket.close(code: 1000)
    }

    private func clearTimers() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
        connectTimer?.cancel()
        connectTimer = nil
        pumpTimer?.cancel()
        pumpTimer = nil
    }

    private func settle(_ value: VoiceResult?) {
        let previous = io
        io = Task {
            await previous?.value
            self.resolve(value)
        }
    }

    private func resolve(_ value: VoiceResult?) {
        guard outcome == nil else { return }
        outcome = .some(value)
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume(returning: value) }
        Self.live[id] = nil
    }

    private func write(_ work: @escaping @Sendable (any VoiceStore, String) async throws -> Void) {
        let previous = io
        let store = options.store
        let id = id
        io = Task { [weak self] in
            await previous?.value
            do {
                try await work(store, id)
            } catch {
                self?.storageFailed = true
            }
        }
    }

    private func update(_ change: (inout VoiceState) -> Void) {
        var next = state
        change(&next)
        guard next != state else { return }
        state = next
        for listener in listeners { listener.call(next) }
    }

    private final class WeakSession {
        weak var session: VoiceSession?
        init(_ session: VoiceSession) { self.session = session }
    }
}
