export interface VoiceStrings {
  voiceInput: string;
  buttonHint: string;
  stop: string;
  listening: string;
  connecting: string;
  offline: string;
  paused: string;
  finishing: string;
  tidying: string;
  holdHint: string;
  releaseToCancel: string;
  tapHint: string;
  done: string;
  cancel: string;
  close: string;
  latest: string;
  stillListening: string;
  minuteLeft: string;
  stoppedAtLimit: string;
  stoppedBySilence: string;
  savedOffline: string;
  microphoneDenied: string;
  signInAgain: string;
  rejected: string;
  emptyResult: string;
  unfinished: (minutes: number) => string;
  restore: string;
  insert: string;
  discard: string;
  showOriginal: string;
  showTidied: string;
  keyHint: string;
  spaceKey: string;
}

export const englishVoiceStrings: VoiceStrings = {
  voiceInput: 'Voice input',
  buttonHint: 'Tap to talk hands-free. Hold to talk while holding.',
  stop: 'Stop and insert',
  listening: 'Listening',
  connecting: 'Connecting… your voice is being recorded',
  offline: 'Offline · still recording',
  paused: 'Paused by another app · tap Done or continue later',
  finishing: 'Finishing…',
  tidying: 'Tidying…',
  holdHint: 'Release to insert · Slide up to cancel',
  releaseToCancel: 'Release to cancel',
  tapHint: 'Tap the microphone again or Done when you finish',
  done: 'Done',
  cancel: 'Cancel',
  close: 'Close',
  latest: 'Latest',
  stillListening: 'Still listening · tap Done when you finish',
  minuteLeft: '1 min left',
  stoppedAtLimit: 'Stopped at 20 minutes. Your text is kept.',
  stoppedBySilence: 'Stopped after a long silence. Your text is kept.',
  savedOffline: 'Saved. The text appears when you are back online.',
  microphoneDenied: 'Allow microphone access to use voice input.',
  signInAgain: 'Sign in again to finish this dictation. It is saved on this device.',
  rejected: 'Voice input is not available right now. Your dictation is saved on this device.',
  emptyResult: 'Didn’t catch that.',
  unfinished: (minutes) => `Unfinished dictation · ${minutes} min`,
  restore: 'Restore',
  insert: 'Insert',
  discard: 'Discard',
  showOriginal: 'Show original',
  showTidied: 'Show tidied',
  keyHint: 'Hold {space} to speak, press {slash} to type',
  spaceKey: 'Space',
};

export const chineseVoiceStrings: VoiceStrings = {
  voiceInput: '语音输入',
  buttonHint: '点一下免手持说话，按住说话松开结束。',
  stop: '停止并插入',
  listening: '正在听',
  connecting: '正在连接…已在录音',
  offline: '网络断开 · 仍在录音',
  paused: '已被其他应用暂停 · 可以点完成',
  finishing: '正在完成…',
  tidying: '正在整理…',
  holdHint: '松开插入 · 上滑取消',
  releaseToCancel: '松开取消',
  tapHint: '说完再点一下话筒或点完成',
  done: '完成',
  cancel: '取消',
  close: '关闭',
  latest: '最新',
  stillListening: '仍在听 · 说完请点完成',
  minuteLeft: '还剩 1 分钟',
  stoppedAtLimit: '已到 20 分钟上限，文字已保留。',
  stoppedBySilence: '长时间没有声音，已自动结束，文字已保留。',
  savedOffline: '已保存。联网后文字会出现。',
  microphoneDenied: '请允许使用麦克风后再试。',
  signInAgain: '请重新登录以完成这段口述。它已保存在本设备上。',
  rejected: '语音输入暂时不可用。这段口述已保存在本设备上。',
  emptyResult: '没有听清。',
  unfinished: (minutes) => `未完成的口述 · ${minutes} 分钟`,
  restore: '恢复',
  insert: '插入',
  discard: '丢弃',
  showOriginal: '显示原文',
  showTidied: '显示整理后',
  keyHint: '按住 {space} 说话，按 {slash} 打字',
  spaceKey: '空格',
};

export function voiceStrings(locale: string | undefined): VoiceStrings {
  return locale?.toLowerCase().startsWith('zh') ? chineseVoiceStrings : englishVoiceStrings;
}

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
