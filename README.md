# voice-input

Streaming voice input that does not lose words. One wire protocol, one Node
relay, and clients for Web (TypeScript + React), iOS/iPadOS (Swift) and
Android (Kotlin).

- **Live text** above the button while the person speaks.
- **Two gestures:** tap to talk hands-free until a second tap, or hold to talk.
- **Durable:** the client keeps the audio and the committed text on disk until
  the text is inserted. A lost network, a failed speech service or a killed app
  loses no words. Sessions run up to 20 minutes.
- **Segmented relay:** the server cuts audio at pauses into segments of at most
  60 s, each with its own speech-service session and failover.

```text
Client ──voice/v1 (wss)──► your server: voice relay ──► Doubao · Gemini Live · WeType · …
```

- [PROTOCOL.md](PROTOCOL.md): the wire protocol, segments, journal and resume.
- [INTERACTION.md](INTERACTION.md): gestures, live panel, stops, recovery.
- [conformance/](conformance/): scenarios every client must pass.

## Server (Node)

```ts
import { createVoiceRelay, countryOf, regionOf, providerChain, doubaoIme, geminiLive } from '@nomoat/voice-input/server';

const relay = createVoiceRelay({
  path: '/api/voice/stream',
  secret: process.env.VOICE_SECRET!,                  // derives stable per-user device ids
  authenticate: async (req, token) => verify(token),  // → { userId } | null
  providers: (req, start) =>
    providerChain(regionOf(countryOf(req), start.languages), {
      doubaoIme: doubaoIme(),
      gemini: process.env.GEMINI_API_KEY ? geminiLive({ apiKey: process.env.GEMINI_API_KEY }) : undefined,
    }),
  metric: (m) => console.log(JSON.stringify(m)),      // counts and times only
});
server.on('upgrade', (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
```

`providerChain` puts Doubao first for mainland China (by the edge's country
header, or the first language when there is none) and Gemini first elsewhere.
`tidyDictation(request, complete)` cleans a long transcript with your own
model call and refuses outputs that drop or add content.

The Doubao IME and WeType adapters use reverse-engineered consumer endpoints
([nomoat/free-asr](https://github.com/nomoat/free-asr)); they can change
without notice. WeType needs FFmpeg with libopus and its keys in options.

## Web (React)

```tsx
import { VoiceButton, chineseVoiceStrings } from '@nomoat/voice-input/react';

<VoiceButton
  anchor={composerRef}
  strings={chineseVoiceStrings}
  config={{
    url: 'wss://example.com/api/voice/stream',
    token: () => getToken(),
    languages: ['zh-CN'],
    target: `doc:${docId}`,
    onText: (text) => insertAtCursor(text),
  }}
/>
```

`useVoiceButton` gives the same gestures for your own button component;
`VoicePanelPortal` renders the live panel; `VoiceRecovery` shows unfinished
dictations for a target. `@nomoat/voice-input/client` has the framework-free
`VoiceSession`, IndexedDB store and microphone capture.

## Swift

`Package.swift` at the root: `VoiceInputCore` (session, journal, file store,
capture, transport) and `VoiceInputUI` (SwiftUI button and live panel).

## Android (Kotlin)

`android/voiceinput` is an Android library module (namespace
`com.nomoat.voiceinput`, minSdk 26, Jetpack Compose). It builds on its own
(`cd android && ./gradlew :voiceinput:testDebugUnitTest`) or inside a host
build: copy the directory, `include(":voiceinput")` in the host's
`settings.gradle.kts` and add `implementation(project(":voiceinput"))`.

- `com.nomoat.voiceinput`: `VoiceSession` (coroutines, `state: StateFlow<VoiceState>`,
  `start`, `setMode`, `finish`, `cancel`, `abandon`, `detach`, `markInserted`,
  `saveTidy`, `result: Deferred`, `VoiceSession.restore`), the journal,
  `MemoryVoiceStore`, `FileVoiceStore` (`filesDir/voice-input/<session>/`),
  `listDictations`, `VoiceGesture`, `OkHttpVoiceSocket` and `MicrophoneCapture`
  (`AudioRecord`, `VOICE_RECOGNITION`, 16 kHz mono PCM16; audio focus loss
  pauses the session).
- `com.nomoat.voiceinput.ui`: `rememberVoiceInputController`, `VoiceButton`,
  `Modifier.voiceInputGesture`, `trackVoicePress` (for a host's own gesture
  code), `VoiceLivePanel`, `VoiceRecoveryBanner`, `englishVoiceStrings` and
  `chineseVoiceStrings`.

```kotlin
val voice = rememberVoiceInputController(
    VoiceInputConfig(
        url = "wss://example.com/api/voice/stream",
        token = { auth.freshToken() },
        languages = listOf("zh-CN"),
        target = "doc:$docId",
        onText = { text, info -> insertAtCursor(text) },
    ),
    strings = chineseVoiceStrings,
)
Column {
    VoiceLivePanel(voice, strings = chineseVoiceStrings)
    Row { TextField(/* … */); VoiceButton(voice, strings = chineseVoiceStrings) }
}
```

`onText` receives `VoiceTextInfo` with the session's final `mode` (`Hold` or
`HandsFree`) and `interrupted` (finished by the system, not by the person), so
a host can, for example, send a released hold and keep a hands-free text in
the field. A hold finishes when the app goes to the background. Hands-free
keeps recording in the background through `VoiceRecordingService`, a
foreground service of type `microphone` that the library manifest declares;
if Android refuses to start it, the session finishes instead.

The session takes its `CoroutineScope` and clock from `VoiceSessionOptions`, so
tests run it on a `TestScope` with virtual time. `src/test` runs
`conformance/*.json` (text, gestures and every session scenario) on the JVM. A
vendored copy without the repository root reads the files from
`voiceinput/conformance/` or the `voiceinput.conformance` system property.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm build            # dist/ is committed so apps can depend on a Git revision
pnpm check:dist
cd android && ./gradlew :voiceinput:testDebugUnitTest
```

Automated tests use synthetic PCM. They never open a microphone.
