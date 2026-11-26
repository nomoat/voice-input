#if canImport(AVFoundation)
import AVFoundation
import Foundation

public enum VoiceCaptureError: Error, Sendable {
    case permissionDenied
    case noInput
    case failed
}

public final class MicrophoneCapture: VoiceCapture, @unchecked Sendable {
    public static let audioQueue = DispatchQueue(label: "voice-input.audio-session", qos: .userInitiated)

    public static func factory(queue: DispatchQueue = audioQueue) -> VoiceCaptureFactory {
        { sink in try await MicrophoneCapture.start(sink: sink, queue: queue) }
    }

    public static func start(sink: VoiceCaptureSink, queue: DispatchQueue = audioQueue) async throws -> MicrophoneCapture {
        guard await microphoneAllowed() else { throw VoiceCaptureError.permissionDenied }
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    continuation.resume(returning: try MicrophoneCapture(sink: sink, queue: queue))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    public static func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    private let sink: VoiceCaptureSink
    private let queue: DispatchQueue
    private let engine = AVAudioEngine()
    private var observers: [NSObjectProtocol] = []
    private var tapInstalled = false
    private var stopped = false
    private var paused = false

    private init(sink: VoiceCaptureSink, queue: DispatchQueue) throws {
        self.sink = sink
        self.queue = queue
        try AudioSessionLease.shared.acquire()
        do {
            try installTap()
            engine.prepare()
            try engine.start()
        } catch {
            removeTap()
            engine.stop()
            AudioSessionLease.shared.release()
            throw error
        }
        observe()
    }

    public func stop() {
        queue.async { [self] in
            guard !stopped else { return }
            stopped = true
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
            removeTap()
            engine.stop()
            AudioSessionLease.shared.release()
        }
    }

    private func installTap() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceCaptureError.noInput }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceProtocol.sampleRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else { throw VoiceCaptureError.failed }
        converter.downmix = true
        let resampler = Resampler(converter: converter, target: target)
        let sink = sink
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            let pcm = resampler.convert(buffer)
            guard !pcm.isEmpty else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { sink.samples(pcm) }
            }
        }
        tapInstalled = true
    }

    private func removeTap() {
        guard tapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.reconfigure() }
        })
        #if os(iOS)
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            let began = type == .began
            let resume = options.contains(.shouldResume)
            self.queue.async { began ? self.interrupt() : self.resume(force: resume) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.interrupt() }
        })
        #endif
    }

    private func interrupt() {
        guard !stopped, !paused else { return }
        paused = true
        let sink = sink
        DispatchQueue.main.async {
            MainActor.assumeIsolated { sink.interrupted() }
        }
    }

    private func resume(force: Bool) {
        guard !stopped, paused, force else { return }
        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setActive(true)
            #endif
            removeTap()
            try installTap()
            engine.prepare()
            try engine.start()
        } catch {
            return
        }
        paused = false
        let sink = sink
        DispatchQueue.main.async {
            MainActor.assumeIsolated { sink.resumed() }
        }
    }

    private func reconfigure() {
        guard !stopped, !paused else { return }
        removeTap()
        do {
            try installTap()
            engine.prepare()
            try engine.start()
        } catch {
            interrupt()
        }
    }
}

private final class Resampler: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let target: AVAudioFormat

    init(converter: AVAudioConverter, target: AVAudioFormat) {
        self.converter = converter
        self.target = target
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> [Int16] {
        guard buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return [] }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var pending: AVAudioPCMBuffer? = buffer
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            guard let next = pending else {
                inputStatus.pointee = .noDataNow
                return nil
            }
            pending = nil
            inputStatus.pointee = .haveData
            return next
        }
        guard status != .error, output.frameLength > 0, let channel = output.int16ChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
    }
}

private final class AudioSessionLease: @unchecked Sendable {
    static let shared = AudioSessionLease()

    private let lock = NSLock()
    private var open = 0
    private var previousHaptics = false

    func acquire() throws {
        lock.lock()
        defer { lock.unlock() }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        if open == 0 { previousHaptics = session.allowHapticsAndSystemSoundsDuringRecording }
        open += 1
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            guard session.isInputAvailable else { throw VoiceCaptureError.noInput }
        } catch {
            releaseLocked()
            throw error
        }
        #else
        open += 1
        #endif
    }

    func release() {
        lock.lock()
        defer { lock.unlock() }
        releaseLocked()
    }

    private func releaseLocked() {
        guard open > 0 else { return }
        open -= 1
        guard open == 0 else { return }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(previousHaptics)
        #endif
    }
}
#endif
