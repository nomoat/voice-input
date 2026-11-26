import Foundation

@MainActor
public protocol VoiceCancellable: AnyObject {
    func cancel()
}

@MainActor
public protocol VoiceClock: AnyObject {
    func now() -> Int
    func schedule(after ms: Int, _ action: @escaping @MainActor () -> Void) -> any VoiceCancellable
}

@MainActor
public final class SystemVoiceClock: VoiceClock {
    public init() {}

    public func now() -> Int { VoiceTime.now() }

    public func schedule(after ms: Int, _ action: @escaping @MainActor () -> Void) -> any VoiceCancellable {
        let task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(max(0, ms)))
            guard !Task.isCancelled else { return }
            action()
        }
        return TaskTimer(task)
    }

    private final class TaskTimer: VoiceCancellable {
        let task: Task<Void, Never>
        init(_ task: Task<Void, Never>) { self.task = task }
        func cancel() { task.cancel() }
    }
}

public struct VoiceEndpoint: Sendable, Equatable {
    public var url: URL
    public var token: String?

    public init(url: URL, token: String? = nil) {
        self.url = url
        self.token = token
    }
}

public enum VoiceEndpointError: Error, Sendable {
    case unauthorized
}

public typealias VoiceEndpointProvider = @MainActor @Sendable () async throws -> VoiceEndpoint

public enum VoiceEndpoints {
    public static func fixed(_ url: URL, token: (@MainActor @Sendable () async throws -> String?)? = nil) -> VoiceEndpointProvider {
        {
            let value: String?
            do {
                value = try await token?()
            } catch VoiceEndpointError.unauthorized {
                throw VoiceEndpointError.unauthorized
            } catch {
                value = nil
            }
            return VoiceEndpoint(url: url, token: value)
        }
    }
}

public enum VoiceSocketError: Error, Sendable {
    case closed
}

@MainActor
public protocol VoiceSocket: AnyObject {
    var onOpen: (@MainActor () -> Void)? { get set }
    var onText: (@MainActor (String) -> Void)? { get set }
    var onClose: (@MainActor () -> Void)? { get set }
    var bufferedAmount: Int { get }
    func send(text: String) throws
    func send(data: Data) throws
    func close(code: Int)
}

public typealias VoiceSocketFactory = @MainActor @Sendable (URL) -> any VoiceSocket

public struct VoiceCaptureSink: Sendable {
    public var samples: @MainActor @Sendable ([Int16]) -> Void
    public var interrupted: @MainActor @Sendable () -> Void
    public var resumed: @MainActor @Sendable () -> Void

    public init(
        samples: @escaping @MainActor @Sendable ([Int16]) -> Void,
        interrupted: @escaping @MainActor @Sendable () -> Void,
        resumed: @escaping @MainActor @Sendable () -> Void
    ) {
        self.samples = samples
        self.interrupted = interrupted
        self.resumed = resumed
    }
}

public protocol VoiceCapture: AnyObject, Sendable {
    func stop()
}

public typealias VoiceCaptureFactory = @MainActor @Sendable (VoiceCaptureSink) async throws -> any VoiceCapture

@MainActor
public final class URLSessionVoiceSocket: VoiceSocket {
    public var onOpen: (@MainActor () -> Void)?
    public var onText: (@MainActor (String) -> Void)?
    public var onClose: (@MainActor () -> Void)?
    public private(set) var bufferedAmount = 0

    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private let relay: Relay
    private var closed = false
    private var receiver: Task<Void, Never>?
    private var pinger: Task<Void, Never>?

    public nonisolated static let factory: VoiceSocketFactory = { url in URLSessionVoiceSocket(url: url) }

    public init(url: URL, configuration: URLSessionConfiguration = .default, pingInterval: Duration = .seconds(15)) {
        let relay = Relay()
        self.relay = relay
        session = URLSession(configuration: configuration, delegate: relay, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 4 << 20
        relay.handler = { [weak self] event in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.handle(event) }
            }
        }
        task.resume()
        let task = self.task
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    self?.handle(.closed)
                    return
                }
                guard let self else { return }
                if case .string(let text) = message { self.onText?(text) }
            }
        }
        pinger = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: pingInterval)
                guard !Task.isCancelled, let self, !self.closed else { return }
                task.sendPing { error in
                    guard error != nil else { return }
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated { self.handle(.closed) }
                    }
                }
            }
        }
    }

    public func send(text: String) throws {
        guard !closed else { throw VoiceSocketError.closed }
        let size = text.utf8.count
        bufferedAmount += size
        task.send(.string(text)) { [weak self] error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.sent(size, failed: error != nil) }
            }
        }
    }

    public func send(data: Data) throws {
        guard !closed else { throw VoiceSocketError.closed }
        let size = data.count
        bufferedAmount += size
        task.send(.data(data)) { [weak self] error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.sent(size, failed: error != nil) }
            }
        }
    }

    public func close(code: Int) {
        guard !closed else { return }
        closed = true
        teardown(code: code)
    }

    private func sent(_ size: Int, failed: Bool) {
        bufferedAmount = max(0, bufferedAmount - size)
        if failed { handle(.closed) }
    }

    private func handle(_ event: Relay.Event) {
        guard !closed else { return }
        switch event {
        case .open:
            onOpen?()
        case .closed:
            closed = true
            teardown(code: 1000)
            onClose?()
        }
    }

    private func teardown(code: Int) {
        receiver?.cancel()
        pinger?.cancel()
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private final class Relay: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
        enum Event: Sendable { case open, closed }

        var handler: (@Sendable (Event) -> Void)?

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            handler?(.open)
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            handler?(.closed)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            handler?(.closed)
        }
    }
}
