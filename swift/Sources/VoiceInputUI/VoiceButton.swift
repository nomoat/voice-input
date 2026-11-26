import SwiftUI
import VoiceInputCore

public struct VoiceButton<Label: View>: View {
    private let controller: VoiceInputController
    private let strings: VoiceStrings
    private let label: (Bool) -> Label

    @Environment(\.isEnabled) private var isEnabled
    @State private var press = VoicePress()
    @GestureState private var touching = false

    public init(controller: VoiceInputController, strings: VoiceStrings = .current, @ViewBuilder label: @escaping (_ active: Bool) -> Label) {
        self.controller = controller
        self.strings = strings
        self.label = label
    }

    public var body: some View {
        let active = controller.isActive
        label(active)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .updating($touching) { _, state, _ in state = true }
                    .onChanged { value in
                        guard isEnabled else { return }
                        if press.touching {
                            press.move(to: value.location, controller: controller)
                        } else {
                            press.down(at: value.startLocation, controller: controller)
                        }
                    }
                    .onEnded { _ in press.up(controller: controller) },
                including: isEnabled ? .all : .subviews
            )
            .onChange(of: touching) { _, now in
                guard !now else { return }
                let press = press
                let controller = controller
                Task { @MainActor in
                    await Task.yield()
                    press.interrupted(controller: controller)
                }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: press.downCount)
            .sensoryFeedback(.impact(weight: .medium), trigger: press.holdCount)
            .sensoryFeedback(.warning, trigger: press.cancelCount)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(active ? strings.stop : strings.voiceInput)
            .accessibilityHint(strings.buttonHint)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                guard isEnabled else { return }
                if controller.isActive {
                    controller.finish()
                } else {
                    controller.begin(mode: .handsFree)
                }
            }
            .onDisappear { press.reset() }
    }
}

extension VoiceButton where Label == VoiceButtonIcon {
    public init(controller: VoiceInputController, strings: VoiceStrings = .current) {
        self.init(controller: controller, strings: strings) { active in VoiceButtonIcon(active: active) }
    }
}

public struct VoiceButtonIcon: View {
    public var active: Bool
    public var size: CGFloat

    public init(active: Bool, size: CGFloat = 17) {
        self.active = active
        self.size = size
    }

    public var body: some View {
        Image(systemName: active ? "stop.fill" : "mic")
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(active ? Color.voiceAccent : Color.primary)
            .frame(width: 44, height: 44)
    }
}

@MainActor @Observable
final class VoicePress {
    private(set) var downCount = 0
    private(set) var holdCount = 0
    private(set) var cancelCount = 0
    private(set) var touching = false

    @ObservationIgnored private var track: PressTrack?
    @ObservationIgnored private var stopTap = false
    @ObservationIgnored private var holdTask: Task<Void, Never>?
    @ObservationIgnored private var armed = false

    static func now() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

    func down(at point: CGPoint, controller: VoiceInputController) {
        touching = true
        if controller.isActive, controller.view.state?.mode == .handsFree {
            stopTap = true
            return
        }
        if controller.isActive { return }
        stopTap = false
        track = PressTrack(at: Self.now(), x: point.x, y: point.y)
        armed = false
        controller.begin(mode: .undecided)
        downCount += 1
        holdTask?.cancel()
        holdTask = Task { @MainActor [weak self, weak controller] in
            try? await Task.sleep(for: .milliseconds(Int(VoiceGesture.tapMs)))
            guard !Task.isCancelled, let self, let controller, self.track != nil else { return }
            self.becomeHold(controller)
        }
    }

    func move(to point: CGPoint, controller: VoiceInputController) {
        guard let track else { return }
        let next = track.moved(x: point.x, y: point.y)
        self.track = next
        if next.isHold(at: Self.now()) { becomeHold(controller) }
        if next.cancelArmed != armed {
            armed = next.cancelArmed
            if armed { cancelCount += 1 }
        }
        controller.armCancel(next.cancelArmed)
    }

    func up(controller: VoiceInputController) {
        touching = false
        holdTask?.cancel()
        holdTask = nil
        if stopTap {
            stopTap = false
            controller.finish()
            return
        }
        guard let track else { return }
        self.track = nil
        armed = false
        controller.armCancel(false)
        switch track.release(at: Self.now()) {
        case .handsFree: controller.setMode(.handsFree)
        case .cancel: controller.cancel()
        case .finish: controller.finish()
        }
    }

    func interrupted(controller: VoiceInputController) {
        guard touching else { return }
        touching = false
        holdTask?.cancel()
        holdTask = nil
        if stopTap {
            stopTap = false
            return
        }
        guard track != nil else { return }
        track = nil
        armed = false
        controller.armCancel(false)
        controller.finish(stoppedBy: .interrupted)
    }

    func reset() {
        holdTask?.cancel()
        holdTask = nil
        touching = false
        stopTap = false
    }

    private func becomeHold(_ controller: VoiceInputController) {
        guard controller.view.state?.mode != .hold, controller.isActive else { return }
        controller.setMode(.hold)
        holdCount += 1
    }
}

extension Color {
    static let voiceAccent = Color(red: 0.898, green: 0.282, blue: 0.302)
}
