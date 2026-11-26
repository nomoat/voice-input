import Foundation

public struct VoiceStrings: Sendable {
    public var voiceInput: String
    public var buttonHint: String
    public var stop: String
    public var listening: String
    public var connecting: String
    public var offline: String
    public var paused: String
    public var finishing: String
    public var tidying: String
    public var holdHint: String
    public var releaseToCancel: String
    public var tapHint: String
    public var done: String
    public var cancel: String
    public var close: String
    public var latest: String
    public var stillListening: String
    public var minuteLeft: String
    public var stoppedAtLimit: String
    public var stoppedBySilence: String
    public var savedOffline: String
    public var microphoneDenied: String
    public var signInAgain: String
    public var rejected: String
    public var emptyResult: String
    public var unfinished: @Sendable (String) -> String
    public var restore: String
    public var insert: String
    public var discard: String
    public var showOriginal: String
    public var showTidied: String

    public init(
        voiceInput: String, buttonHint: String, stop: String, listening: String, connecting: String, offline: String,
        paused: String, finishing: String, tidying: String, holdHint: String, releaseToCancel: String, tapHint: String,
        done: String, cancel: String, close: String, latest: String, stillListening: String, minuteLeft: String,
        stoppedAtLimit: String, stoppedBySilence: String, savedOffline: String, microphoneDenied: String,
        signInAgain: String, rejected: String, emptyResult: String, unfinished: @escaping @Sendable (String) -> String,
        restore: String, insert: String, discard: String, showOriginal: String, showTidied: String
    ) {
        self.voiceInput = voiceInput
        self.buttonHint = buttonHint
        self.stop = stop
        self.listening = listening
        self.connecting = connecting
        self.offline = offline
        self.paused = paused
        self.finishing = finishing
        self.tidying = tidying
        self.holdHint = holdHint
        self.releaseToCancel = releaseToCancel
        self.tapHint = tapHint
        self.done = done
        self.cancel = cancel
        self.close = close
        self.latest = latest
        self.stillListening = stillListening
        self.minuteLeft = minuteLeft
        self.stoppedAtLimit = stoppedAtLimit
        self.stoppedBySilence = stoppedBySilence
        self.savedOffline = savedOffline
        self.microphoneDenied = microphoneDenied
        self.signInAgain = signInAgain
        self.rejected = rejected
        self.emptyResult = emptyResult
        self.unfinished = unfinished
        self.restore = restore
        self.insert = insert
        self.discard = discard
        self.showOriginal = showOriginal
        self.showTidied = showTidied
    }

    public static let english = VoiceStrings(
        voiceInput: "Voice input",
        buttonHint: "Tap to talk hands-free. Hold to talk while holding.",
        stop: "Stop and insert",
        listening: "Listening",
        connecting: "Connecting… your voice is being recorded",
        offline: "Offline · still recording",
        paused: "Paused by another app · tap Done or continue later",
        finishing: "Finishing…",
        tidying: "Tidying…",
        holdHint: "Release to insert · Slide up to cancel",
        releaseToCancel: "Release to cancel",
        tapHint: "Tap the microphone again or Done when you finish",
        done: "Done",
        cancel: "Cancel",
        close: "Close",
        latest: "Latest",
        stillListening: "Still listening · tap Done when you finish",
        minuteLeft: "1 min left",
        stoppedAtLimit: "Stopped at 20 minutes. Your text is kept.",
        stoppedBySilence: "Stopped after a long silence. Your text is kept.",
        savedOffline: "Saved. The text appears when you are back online.",
        microphoneDenied: "Allow microphone access to use voice input.",
        signInAgain: "Sign in again to finish this dictation. It is saved on this device.",
        rejected: "Voice input is not available right now. Your dictation is saved on this device.",
        emptyResult: "Didn’t catch that.",
        unfinished: { minutes in "Unfinished dictation · \(minutes)" },
        restore: "Restore",
        insert: "Insert",
        discard: "Discard",
        showOriginal: "Show original",
        showTidied: "Show tidied"
    )

    public static let chinese = VoiceStrings(
        voiceInput: "语音输入",
        buttonHint: "点一下免手持说话，按住说话松开结束。",
        stop: "停止并插入",
        listening: "正在听",
        connecting: "正在连接…已在录音",
        offline: "网络断开 · 仍在录音",
        paused: "已被其他应用暂停 · 可以点完成",
        finishing: "正在完成…",
        tidying: "正在整理…",
        holdHint: "松开插入 · 上滑取消",
        releaseToCancel: "松开取消",
        tapHint: "说完再点一下话筒或点完成",
        done: "完成",
        cancel: "取消",
        close: "关闭",
        latest: "最新",
        stillListening: "仍在听 · 说完请点完成",
        minuteLeft: "还剩 1 分钟",
        stoppedAtLimit: "已到 20 分钟上限，文字已保留。",
        stoppedBySilence: "长时间没有声音，已自动结束，文字已保留。",
        savedOffline: "已保存。联网后文字会出现。",
        microphoneDenied: "请允许使用麦克风后再试。",
        signInAgain: "请重新登录以完成这段口述。它已保存在本设备上。",
        rejected: "语音输入暂时不可用。这段口述已保存在本设备上。",
        emptyResult: "没有听清。",
        unfinished: { minutes in "未完成的口述 · \(minutes)" },
        restore: "恢复",
        insert: "插入",
        discard: "丢弃",
        showOriginal: "显示原文",
        showTidied: "显示整理后"
    )

    public static func forLocale(_ identifier: String?) -> VoiceStrings {
        identifier?.lowercased().hasPrefix("zh") == true ? chinese : english
    }

    public static var current: VoiceStrings {
        forLocale(Locale.current.language.languageCode?.identifier ?? Locale.current.identifier)
    }
}

public let englishVoiceStrings = VoiceStrings.english
public let chineseVoiceStrings = VoiceStrings.chinese

public func voiceStrings(_ locale: String?) -> VoiceStrings { VoiceStrings.forLocale(locale) }

public func voiceClock(_ ms: Int) -> String {
    let total = max(0, ms / 1000)
    return String(format: "%02d:%02d", total / 60, total % 60)
}

func voiceMinutes(_ ms: Int) -> String {
    "\(max(1, Int((Double(ms) / 60_000).rounded()))) min"
}
