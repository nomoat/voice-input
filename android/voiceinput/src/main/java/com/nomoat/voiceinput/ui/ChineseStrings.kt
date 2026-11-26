package com.nomoat.voiceinput.ui

val chineseVoiceStrings: VoiceStrings = VoiceStrings(
    voiceInput = "语音输入",
    buttonHint = "点一下免手持说话，按住说话松开结束。",
    stop = "停止并插入",
    listening = "正在听",
    connecting = "正在连接…已在录音",
    offline = "网络断开 · 仍在录音",
    paused = "已被其他应用暂停 · 可以点完成",
    finishing = "正在完成…",
    tidying = "正在整理…",
    holdHint = "松开插入 · 上滑取消",
    releaseToCancel = "松开取消",
    tapHint = "说完再点一下话筒或点完成",
    done = "完成",
    cancel = "取消",
    close = "关闭",
    latest = "最新",
    stillListening = "仍在听 · 说完请点完成",
    minuteLeft = "还剩 1 分钟",
    stoppedAtLimit = "已到 20 分钟上限，文字已保留。",
    stoppedBySilence = "长时间没有声音，已自动结束，文字已保留。",
    savedOffline = "已保存。联网后文字会出现。",
    microphoneDenied = "请允许使用麦克风后再试。",
    signInAgain = "请重新登录以完成这段口述。它已保存在本设备上。",
    rejected = "语音输入暂时不可用。这段口述已保存在本设备上。",
    emptyResult = "没有听清。",
    unfinished = { minutes -> "未完成的口述 · $minutes 分钟" },
    restore = "恢复",
    insert = "插入",
    discard = "丢弃",
    showOriginal = "显示原文",
    showTidied = "显示整理后",
)

fun voiceStrings(locale: String?): VoiceStrings =
    if (locale?.lowercase()?.startsWith("zh") == true) chineseVoiceStrings else englishVoiceStrings
