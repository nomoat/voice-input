import SwiftUI
import VoiceInputCore
#if canImport(UIKit)
import UIKit
#endif

public struct VoiceLivePanel: View {
    private let controller: VoiceInputController
    private let strings: VoiceStrings
    private let maxHeight: CGFloat?
    private let maxWidth: CGFloat

    @State private var follow = true
    @State private var contentHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    @State private var containerLimit: CGFloat = 0
    @State private var oneLine: CGFloat = 0
    @State private var twoLines: CGFloat = 0
    @State private var hintHeight: CGFloat = 0
    @State private var hintFullHeight: CGFloat = 0
    @State private var spoken = ""
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private nonisolated static let bottomID = "voice-input-bottom"
    private nonisolated static let space = "voice-input-scroll"

    public init(controller: VoiceInputController, strings: VoiceStrings = .current, maxHeight: CGFloat? = nil, maxWidth: CGFloat = 560) {
        self.controller = controller
        self.strings = strings
        self.maxHeight = maxHeight
        self.maxWidth = maxWidth
    }

    public var body: some View {
        let view = controller.view
        if view.open, let state = view.state {
            panel(view, state)
                .frame(maxWidth: maxWidth)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    private var phone: Bool {
        #if canImport(UIKit) && !os(watchOS)
        UIDevice.current.userInterfaceIdiom == .phone
        #else
        false
        #endif
    }

    private var panelLimit: CGFloat {
        if let maxHeight { return maxHeight }
        let large = dynamicTypeSize.isAccessibilitySize
        if phone { return containerLimit > 0 ? max(120, containerLimit * (large ? 1.5 : 1)) : 320 }
        return large ? max(320, containerLimit * 1.1) : 320
    }

    private var lineAdvance: CGFloat {
        oneLine > 0 && twoLines > oneLine ? twoLines - oneLine : 0
    }

    private func viewport(whole: Bool, textLimit: CGFloat) -> CGFloat {
        let content = max(44, contentHeight)
        let advance = lineAdvance
        if whole {
            guard content > panelLimit else { return content }
            guard advance > 0 else { return panelLimit }
            let fixed = footerHeight + 9
            let lines = max(2, ((panelLimit - fixed) / advance).rounded(.down))
            return min(content, lines * advance + fixed)
        }
        guard advance > 0 else { return min(content, textLimit) }
        let limit = max(textLimit, 2 * advance + 5)
        guard content > limit else { return content }
        let lines = max(2, ((limit - 5) / advance).rounded(.down))
        return lines * advance + 5
    }

    private func status(_ view: VoiceInputView, _ state: VoiceState) -> String {
        if view.tidying { return strings.tidying }
        switch state.phase {
        case .paused: return strings.paused
        case .finishing, .done: return strings.finishing
        case .pending: return strings.savedOffline
        default: break
        }
        if state.connection == .offline { return strings.offline }
        if state.connection == .connecting { return strings.connecting }
        if state.mode == .handsFree && state.silenceMs >= 60_000 { return strings.stillListening }
        return strings.listening
    }

    private func notice(_ view: VoiceInputView) -> String? {
        switch view.notice {
        case .empty: strings.emptyResult
        case .microphone: strings.microphoneDenied
        case .unauthorized: strings.signInAgain
        case .rejected: strings.rejected
        case .limit: strings.stoppedAtLimit
        case .silence: strings.stoppedBySilence
        case .pending, nil: nil
        }
    }

    @ViewBuilder
    private func panel(_ view: VoiceInputView, _ state: VoiceState) -> some View {
        let phase = state.phase
        let recording = phase == .recording || phase == .starting
        let hold = state.mode == .hold
        let armed = view.cancelArmed && hold
        let muted: Color = armed ? Color.white.opacity(0.8) : Color.secondary
        let noticeText = notice(view)
        let textLimit = max(44, panelLimit - headerHeight - footerHeight)
        let whole = dynamicTypeSize.isAccessibilitySize
        let top = header(view, state, recording: recording, armed: armed, muted: muted)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
        let bottom = footer(view, state, recording: recording, hold: hold, armed: armed, muted: muted, hasNotice: noticeText != nil)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }

        VStack(spacing: 0) {
            if !whole { top }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        if whole { top }
                        VStack(alignment: .leading, spacing: 6) {
                            transcript(state, notice: noticeText, armed: armed)
                            if let noticeText, !(state.committed.isEmpty && state.interim.isEmpty) {
                                Text(noticeText).font(.footnote).foregroundStyle(muted)
                            }
                            if !whole { Color.clear.frame(height: 1).id(Self.bottomID) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.top, 4)
                        .padding(.bottom, 10)
                        if whole {
                            bottom
                            Color.clear.frame(height: 1).id(Self.bottomID)
                        }
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { frame in
                        let grew = abs(frame.height - contentHeight) > 0.5
                        contentHeight = frame.height
                        let gap = frame.maxY - viewportHeight
                        if gap < 24 {
                            if !follow { follow = true }
                        } else if !grew && follow {
                            follow = false
                        }
                        if grew && follow { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                    }
                }
                .coordinateSpace(.named(Self.space))
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: viewport(whole: whole, textLimit: textLimit))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                .overlay(alignment: .bottomTrailing) {
                    if !follow {
                        Button {
                            follow = true
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        } label: {
                            Text("\(strings.latest) ↓")
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(.background, in: Capsule())
                                .overlay(Capsule().strokeBorder(Color.gray.opacity(0.28)))
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 12)
                        .padding(.bottom, 6)
                    }
                }
            }

            if !whole { bottom }
        }
        .foregroundStyle(armed ? Color.white : Color.primary)
        .background(armed ? AnyShapeStyle(Color.voiceAccent) : AnyShapeStyle(.background))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.gray.opacity(0.28)))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 8)
        .animation(.easeOut(duration: 0.12), value: armed)
        .background { lineProbe(state) }
        .background(alignment: .bottom) {
            Color.clear
                .containerRelativeFrame(.vertical) { length, _ in length * 0.4 }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { containerLimit = $0 }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.voiceInput)
        .onChange(of: state.committed) { old, new in announce(old, new) }
    }

    private func lineProbe(_ state: VoiceState) -> some View {
        let sample = String((state.committed + state.interim).first { !$0.isWhitespace } ?? "A")
        return ZStack {
            Text(sample)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { oneLine = $0 }
            Text(sample + "\n" + sample)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { twoLines = $0 }
        }
        .font(.body)
        .lineSpacing(4)
        .fixedSize()
        .hidden()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func transcript(_ state: VoiceState, notice: String?, armed: Bool) -> some View {
        let empty = state.committed.isEmpty && state.interim.isEmpty
        var text = AttributedString(empty ? (notice ?? "…") : state.committed)
        if empty {
            text.foregroundColor = armed ? Color.white.opacity(0.75) : Color.secondary
        } else {
            var interim = AttributedString(state.interim)
            interim.foregroundColor = armed ? Color.white.opacity(0.75) : Color.secondary
            text.append(interim)
        }
        return Text(text)
            .font(.body)
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.disabled)
            .accessibilityLabel(empty ? (notice ?? "") : state.committed)
    }

    private func header(_ view: VoiceInputView, _ state: VoiceState, recording: Bool, armed: Bool, muted: Color) -> some View {
        let line = armed ? strings.releaseToCancel : status(view, state)
        let lastMinute = state.remainingMs <= 60_000 && recording
        return Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        VoiceLevelMeter(level: state.level, live: recording && !armed)
                        Spacer(minLength: 0)
                        Text(voiceClock(state.elapsedMs)).monospacedDigit().fixedSize()
                    }
                    Text(line)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if lastMinute {
                        Text(strings.minuteLeft).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 8)
            } else {
                HStack(spacing: 8) {
                    VoiceLevelMeter(level: state.level, live: recording && !armed)
                    Text(line)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if lastMinute { Text(strings.minuteLeft) }
                    Text(voiceClock(state.elapsedMs)).monospacedDigit()
                }
            }
        }
        .font(.caption)
        .foregroundStyle(muted)
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private func footer(_ view: VoiceInputView, _ state: VoiceState, recording: Bool, hold: Bool, armed: Bool, muted: Color, hasNotice: Bool) -> some View {
        let phase = state.phase
        HStack(spacing: 8) {
            if recording && hold {
                Text(armed ? strings.releaseToCancel : strings.holdHint)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if (recording || phase == .paused) && !hold && dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) {
                    VoicePanelButton(title: strings.cancel, primary: false, wide: true) { controller.cancel() }
                    VoicePanelButton(title: strings.done, primary: true, wide: true) { controller.finish() }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            if (recording || phase == .paused) && !hold && !dynamicTypeSize.isAccessibilitySize {
                let hint = state.mode == .undecided ? "" : strings.tapHint
                Text(hint)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(alignment: .topLeading) {
                        Text(hint)
                            .fixedSize(horizontal: false, vertical: true)
                            .hidden()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { hintFullHeight = $0 }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { hintHeight = $0 }
                    .opacity(hintFits ? 1 : 0)
                    .accessibilityHidden(!hintFits)
                VoicePanelButton(title: strings.cancel, primary: false) { controller.cancel() }
                    .layoutPriority(1)
                VoicePanelButton(title: strings.done, primary: true) { controller.finish() }
                    .layoutPriority(1)
            }
            if !recording && phase != .paused {
                Spacer(minLength: 0)
                VoicePanelButton(title: strings.close, primary: false) {
                    if phase == .pending || hasNotice { controller.close() } else { controller.cancel() }
                }
            }
        }
        .font(.caption)
        .foregroundStyle(muted)
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .overlay(alignment: .top) {
            if !armed { Divider() }
        }
    }

    private var hintFits: Bool {
        hintFullHeight <= hintHeight + 0.5
    }

    private func announce(_ old: String, _ new: String) {
        guard new.count > old.count, new.hasPrefix(old) else { return }
        let added = String(new.dropFirst(old.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !added.isEmpty, added != spoken else { return }
        spoken = added
        AccessibilityNotification.Announcement(added).post()
    }
}

struct VoicePanelButton: View {
    let title: String
    let primary: Bool
    var wide = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(primary ? .semibold : .regular))
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .frame(maxWidth: wide ? .infinity : nil)
                .foregroundStyle(primary ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
                .background(primary ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.clear), in: Capsule())
                .overlay(Capsule().strokeBorder(primary ? Color.clear : Color.gray.opacity(0.28)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct VoiceLevelMeter: View {
    let level: Double
    let live: Bool

    private static let bars: [Double] = [0.55, 0.85, 1, 0.7, 0.45]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Self.bars.indices, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(live ? Color.voiceAccent : Color.secondary)
                    .frame(width: 3, height: max(3, (14 * min(1, level * 1.4) * Self.bars[i]).rounded()))
            }
        }
        .frame(height: 14)
        .animation(.linear(duration: 0.09), value: level)
        .accessibilityHidden(true)
    }
}
