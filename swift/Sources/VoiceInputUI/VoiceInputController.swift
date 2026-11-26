import Foundation
import Observation
import VoiceInputCore
#if canImport(UIKit)
import UIKit
#endif

public struct VoiceTextInfo: Sendable, Equatable {
    public var raw: String
    public var tidied: Bool
    public var session: String
    public var mode: VoiceMode

    public init(raw: String, tidied: Bool, session: String, mode: VoiceMode) {
        self.raw = raw
        self.tidied = tidied
        self.session = session
        self.mode = mode
    }
}

public enum VoiceNotice: String, Sendable {
    case empty, microphone, unauthorized, rejected, limit, silence, pending
}

public struct VoiceInputView: Sendable, Equatable {
    public var open = false
    public var state: VoiceState?
    public var tidying = false
    public var cancelArmed = false
    public var notice: VoiceNotice?

    public init() {}

    public var isActive: Bool { state?.isActive ?? false }
}

public typealias VoiceTextHandler = @MainActor (String, VoiceTextInfo) async throws -> Void
public typealias VoiceTidyHandler = @MainActor (String) async throws -> String?

@MainActor @Observable
public final class VoiceInputController {
    public struct Configuration {
        public var endpoint: VoiceEndpointProvider
        public var languages: [String]
        public var target: String
        public var surface: String?
        public var onText: VoiceTextHandler
        public var tidy: VoiceTidyHandler?
        public var tidyMinChars: Int
        public var tidyTimeoutMs: Int
        public var store: any VoiceStore
        public var capture: VoiceCaptureFactory?
        public var socket: VoiceSocketFactory
        public var maxMs: Int?
        public var finishHoldInBackground: Bool

        public init(
            endpoint: @escaping VoiceEndpointProvider,
            languages: [String],
            target: String,
            surface: String? = nil,
            onText: @escaping VoiceTextHandler,
            tidy: VoiceTidyHandler? = nil,
            tidyMinChars: Int = 80,
            tidyTimeoutMs: Int = 30_000,
            store: any VoiceStore = FileVoiceStore.shared,
            capture: VoiceCaptureFactory? = VoiceInputController.defaultCapture,
            socket: @escaping VoiceSocketFactory = URLSessionVoiceSocket.factory,
            maxMs: Int? = nil,
            finishHoldInBackground: Bool = true
        ) {
            self.endpoint = endpoint
            self.languages = languages
            self.target = target
            self.surface = surface
            self.onText = onText
            self.tidy = tidy
            self.tidyMinChars = tidyMinChars
            self.tidyTimeoutMs = tidyTimeoutMs
            self.store = store
            self.capture = capture
            self.socket = socket
            self.maxMs = maxMs
            self.finishHoldInBackground = finishHoldInBackground
        }
    }

    public nonisolated static var defaultCapture: VoiceCaptureFactory? {
        #if canImport(AVFoundation)
        MicrophoneCapture.factory()
        #else
        nil
        #endif
    }

    public static func preferredLanguages(_ limit: Int = 4) -> [String] {
        var seen: Set<String> = []
        return Locale.preferredLanguages.filter { seen.insert($0).inserted }.prefix(limit).map { $0 }
    }

    public var configuration: Configuration {
        didSet {
            if oldValue.target != configuration.target { refreshRecoverable() }
        }
    }
    public private(set) var view = VoiceInputView() {
        didSet {
            if isOpen != view.open {
                isOpen = view.open
                if !isOpen { refreshRecoverable() }
            }
            if isActive != view.isActive { isActive = view.isActive }
        }
    }
    public private(set) var isOpen = false
    public private(set) var isActive = false
    public private(set) var recoverable: [StoredDictation] = []

    @ObservationIgnored public private(set) var session: VoiceSession?
    @ObservationIgnored private var subscription: VoiceSubscription?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var delivering = false
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private let observers = ObserverBag()

    public init(configuration: Configuration) {
        self.configuration = configuration
        observeApplication()
        refreshRecoverable()
    }

    public func refreshRecoverable() {
        recoveryTask?.cancel()
        let store = configuration.store
        let target = configuration.target
        recoveryTask = Task { [weak self] in
            let all = await listDictations(store, target: target)
            guard !Task.isCancelled, let self else { return }
            let shown = Self.recoverable(all, live: self.session?.id)
            if shown != self.recoverable { self.recoverable = shown }
        }
    }

    static func recoverable(_ all: [StoredDictation], live: String?) -> [StoredDictation] {
        all.filter { item in
            guard item.status == .unfinished || item.status == .complete else { return false }
            guard !item.text.isEmpty || item.durationMs > 0 else { return false }
            if item.session == live { return false }
            if let running = VoiceSession.running(item.session), running.state.phase != .pending { return false }
            return true
        }
    }

    public var isDelivering: Bool { delivering || view.tidying }

    @discardableResult
    public func begin(mode: VoiceMode = .undecided) -> VoiceSession? {
        if let session {
            if session.state.isActive || delivering || view.tidying { return session }
            close()
        }
        let c = configuration
        noticeTask?.cancel()
        let session = VoiceSession(options: VoiceSessionOptions(
            endpoint: c.endpoint,
            languages: c.languages,
            target: c.target,
            surface: c.surface,
            store: c.store,
            capture: c.capture,
            socket: c.socket,
            maxMs: c.maxMs ?? VoiceProtocol.maxSessionMs
        ))
        self.session = session
        subscription = session.subscribe { [weak self, weak session] state in
            guard let self, let session, self.session === session else { return }
            var next = self.view
            next.open = true
            next.state = state
            if state.phase == .pending {
                next.notice = .pending
            } else if next.notice == .pending {
                next.notice = nil
            }
            if next != self.view { self.view = next }
        }
        Task { [weak self] in
            let result = await session.result
            await self?.settled(session, result)
        }
        Task { await session.start(mode: mode) }
        return session
    }

    public func finish() {
        session?.finish()
    }

    public func cancel() {
        guard let session else {
            close()
            return
        }
        switch session.state.phase {
        case .done, .failed, .cancelled:
            close()
        case .pending:
            session.detach()
            close()
        default:
            session.cancel()
        }
    }

    public func setMode(_ mode: VoiceMode) {
        session?.setMode(mode)
    }

    public func armCancel(_ armed: Bool) {
        if view.cancelArmed != armed { view.cancelArmed = armed }
    }

    public func close() {
        noticeTask?.cancel()
        noticeTask = nil
        subscription?.cancel()
        subscription = nil
        session = nil
        delivering = false
        view = VoiceInputView()
    }

    public func detach() {
        let current = session
        subscription?.cancel()
        subscription = nil
        session = nil
        current?.detach()
        view = VoiceInputView()
    }

    private func settled(_ session: VoiceSession, _ result: VoiceResult?) async {
        guard self.session === session else { return }
        let state = session.state
        guard let result else {
            if state.phase == .failed {
                switch state.failure {
                case .microphone: showNotice(.microphone)
                case .unauthorized: showNotice(.unauthorized)
                default: showNotice(.rejected)
                }
            } else {
                close()
            }
            return
        }
        if result.text.isEmpty {
            showNotice(.empty, autoCloseMs: 2500)
            return
        }
        delivering = true
        do {
            try await deliver(session, result.text, mode: state.mode)
        } catch {
            guard self.session === session else { return }
            delivering = false
            showNotice(.rejected)
            return
        }
        guard self.session === session else { return }
        delivering = false
        switch state.stoppedBy {
        case .limit: showNotice(.limit, autoCloseMs: 4000)
        case .silence: showNotice(.silence, autoCloseMs: 4000)
        case nil: close()
        }
    }

    private func deliver(_ session: VoiceSession, _ text: String, mode: VoiceMode) async throws {
        let c = configuration
        var out = text
        var tidied = false
        if let tidy = c.tidy, text.utf16.count >= c.tidyMinChars {
            view.tidying = true
            let markdown = await Self.withTimeout(ms: c.tidyTimeoutMs) { try await tidy(text) }
            guard self.session === session else { return }
            if let markdown, !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out = markdown
                tidied = true
                await session.saveTidy(markdown)
            }
        }
        guard self.session === session else { return }
        try await c.onText(out, VoiceTextInfo(raw: text, tidied: tidied, session: session.id, mode: mode))
        await session.markInserted()
    }

    private func showNotice(_ notice: VoiceNotice, autoCloseMs: Int? = nil) {
        noticeTask?.cancel()
        noticeTask = nil
        view.notice = notice
        view.tidying = false
        guard let autoCloseMs else { return }
        let session = session
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(autoCloseMs))
            guard !Task.isCancelled, let self, self.session === session else { return }
            self.close()
        }
    }

    static func withTimeout(ms: Int, _ work: @escaping @MainActor () async throws -> String?) async -> String? {
        let race = TimeoutRace()
        return await withCheckedContinuation { continuation in
            race.continuation = continuation
            let worker = Task { @MainActor in
                let value = try? await work()
                race.finish(value)
            }
            race.worker = worker
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(ms))
                race.finish(nil)
            }
        }
    }

    private func observeApplication() {
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        observers.add(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.enteredBackground() }
        })
        observers.add(center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.terminating() }
        })
        observers.add(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshRecoverable() }
        })
        #endif
    }

    private func enteredBackground() {
        guard configuration.finishHoldInBackground, let session, session.state.isActive, session.state.mode != .handsFree else { return }
        armCancel(false)
        session.finish()
    }

    private func terminating() {
        guard let session, session.state.phase != .done else { return }
        session.abandon()
    }
}

@MainActor
private final class TimeoutRace {
    var continuation: CheckedContinuation<String?, Never>?
    var worker: Task<Void, Never>?

    func finish(_ value: String?) {
        guard let continuation else { return }
        self.continuation = nil
        worker?.cancel()
        continuation.resume(returning: value)
    }
}

final class ObserverBag: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [NSObjectProtocol] = []

    func add(_ token: NSObjectProtocol) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }

    deinit {
        for token in tokens { NotificationCenter.default.removeObserver(token) }
    }
}
