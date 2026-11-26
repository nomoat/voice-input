import SwiftUI
import VoiceInputCore

public struct VoiceRecoveryBanner: View {
    private let target: String
    private let endpoint: VoiceEndpointProvider
    private let store: any VoiceStore
    private let socket: VoiceSocketFactory
    private let strings: VoiceStrings
    private let onText: VoiceTextHandler
    private let controller: VoiceInputController?

    @State private var items: [StoredDictation] = []
    @State private var busy: String?
    @Environment(\.scenePhase) private var scenePhase

    public init(
        target: String,
        endpoint: @escaping VoiceEndpointProvider,
        store: any VoiceStore = FileVoiceStore.shared,
        socket: @escaping VoiceSocketFactory = URLSessionVoiceSocket.factory,
        strings: VoiceStrings = .current,
        onText: @escaping VoiceTextHandler
    ) {
        self.target = target
        self.endpoint = endpoint
        self.store = store
        self.socket = socket
        self.strings = strings
        self.onText = onText
        controller = nil
    }

    public init(controller: VoiceInputController, strings: VoiceStrings = .current) {
        let c = controller.configuration
        target = c.target
        endpoint = c.endpoint
        store = c.store
        socket = c.socket
        self.strings = strings
        onText = c.onText
        self.controller = controller
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let item = items.first { banner(item) }
        }
        .task(id: target) { await refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
        .onChange(of: controller?.isOpen ?? false) { _, open in
            if !open { Task { await refresh() } }
        }
    }

    private func refresh() async {
        let all = await listDictations(store, target: target)
        let live = controller?.session?.id
        items = all.filter { item in
            guard item.status == .unfinished || item.status == .complete else { return false }
            guard !item.text.isEmpty || item.durationMs > 0 else { return false }
            if item.session == live { return false }
            if let running = VoiceSession.running(item.session), running.state.phase != .pending { return false }
            return true
        }
    }

    private func banner(_ item: StoredDictation) -> some View {
        let preview = item.text.count > 80 ? String(item.text.prefix(80)) + "…" : item.text
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.unfinished(voiceMinutes(item.durationMs))).fontWeight(.semibold)
                if !preview.isEmpty {
                    Text(preview).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(busy != nil ? strings.finishing : item.status == .complete ? strings.insert : strings.restore) {
                Task { await restore(item) }
            }
            .disabled(busy != nil)
            Button(strings.discard) {
                Task { await discard(item) }
            }
            .disabled(busy != nil)
        }
        .font(.footnote)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.gray.opacity(0.28)))
        .accessibilityElement(children: .contain)
    }

    private func restore(_ item: StoredDictation) async {
        busy = item.session
        defer {
            busy = nil
            Task { await refresh() }
        }
        var text = item.tidy ?? item.text
        if item.status == .unfinished {
            let session: VoiceSession?
            if let running = VoiceSession.running(item.session) {
                session = running
            } else {
                session = await VoiceSession.restore(item.session, endpoint: endpoint, store: store, socket: socket)
            }
            guard let result = await session?.result else { return }
            text = result.text
        }
        do {
            if !text.isEmpty {
                try await onText(text, VoiceTextInfo(raw: item.text.isEmpty ? text : item.text, tidied: item.tidy != nil, session: item.session, mode: .restore))
            }
            try await markInserted(store, session: item.session)
        } catch {
            return
        }
    }

    private func discard(_ item: StoredDictation) async {
        try? await markDiscarded(store, session: item.session)
        await refresh()
    }
}
