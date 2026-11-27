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
import { createVoiceRelay, speechChain, speechChoiceFor, doubao, doubaoIme, geminiLive } from '@nomoat/voice-input/server';

const relay = createVoiceRelay({
  path: '/api/voice/stream',
  secret: process.env.VOICE_SECRET!,                  // derives stable per-user device ids
  authenticate: async (req, token) => verify(token),  // → { userId, speech?: 'doubao' | 'gemini' } | null
  providers: (req, start, user) =>
    speechChain(user.speech ?? speechChoiceFor(start.languages), {
      doubao: doubao({ apiKey: process.env.DOUBAO_SPEECH_KEY }),
      doubaoIme: doubaoIme(),
      gemini: process.env.GEMINI_API_KEY ? geminiLive({ apiKey: process.env.GEMINI_API_KEY }) : undefined,
    }),
  metric: (m) => console.log(JSON.stringify(m)),      // counts and times only
});
server.on('upgrade', (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
```

Each person chooses a speech service, `doubao` or `gemini`. Store the choice
with the account: set it once when the account is made, with
`speechChoiceFor(languages)` (a Chinese first language picks Doubao, any other
Gemini), and change it only when the person does. `speechChain` puts the
chosen service first and keeps the others as fallbacks, so a failed service
loses no words. `providerChain(regionOf(countryOf(req), languages), set)`
chooses by the edge's country header instead.

`doubao({ apiKey })` is Volcengine's streaming speech recognition
(豆包语音, `bigmodel_async`), with an API Key from the 豆包语音 console. It
takes `resourceId` (default `volc.seedasr.sauc.duration`, ASR 2.0). The key
stays on your server. Leave `hotwords` unset: in tests on 2026-11-27, any
hotword made `bigmodel_async` drop the words it could not match, and a product
name gave no gain.

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

With `hotkeys`, Space and `/` work while no text field or control has the
focus: hold Space to talk, tap Space for hands-free, press `/` to type.

```tsx
<VoiceButton config={config} hotkeys={{ focus: () => fieldRef.current?.focus(), scope: composerRef }} />
{!focused && !draft && keyboard && <VoiceKeyHint strings={strings} />}  // keyboard = useKeyboardDevice()
```

The last mounted composer with `hotkeys` owns the keys. `useVoiceHotkeys`
gives the same keys to a host with its own gestures.

`useVoiceButton` gives the same gestures for your own button component;
`VoicePanelPortal` renders the live panel; `VoiceRecovery` shows unfinished
dictations for a target. `@nomoat/voice-input/client` has the framework-free
`VoiceSession`, IndexedDB store and microphone capture.

## Swift (iOS 17+, macOS 14+)

`Package.swift` at the root has two products:

- `VoiceInputCore`: protocol types, text rules, journal, `FileVoiceStore`
  (Application Support/VoiceInput, frames in 300-frame chunk files),
  `VoiceSession`, `MicrophoneCapture` (AVAudioEngine → 16 kHz mono Int16) and
  `URLSessionVoiceSocket`.
- `VoiceInputUI`: `VoiceInputController`, `VoiceButton`, `VoiceLivePanel`,
  `VoiceRecoveryBanner`, the built-in strings and `UITextView.insertVoiceText`.

```swift
import VoiceInputCore
import VoiceInputUI

@State private var voice = VoiceInputController(configuration: .init(
    endpoint: {
        let ticket = try await api.voiceTicket()            // a fresh credential per connection
        return VoiceEndpoint(url: ticket.url, token: ticket.token)
    },
    languages: VoiceInputController.preferredLanguages(),
    target: "doc:\(docID)",
    surface: "document",
    onText: { text, info in textView.insertVoiceText(text) },
    tidy: { text in try await api.tidy(text) }              // optional; texts of 80+ characters
))

VStack {
    VoiceRecoveryBanner(controller: voice)
    VoiceLivePanel(controller: voice)                         // above the composer
    HStack { composer; VoiceButton(controller: voice) }
}
```

The endpoint closure runs for every connection attempt; throw
`VoiceEndpointError.unauthorized` when the host's credential is refused (three
in a row fail the session), or `VoiceEndpointError.refused` when the host will
not connect this dictation at all (the session fails at once and keeps the
dictation on the device for the recovery banner). `VoiceTextInfo.mode` (`hold`, `handsFree`, `restore`,
or `undecided` for a press the system ended before it became a hold) and
`stoppedBy` (`interrupted`, `limit`, `silence`) say how a dictation ended. A
host that sends on release sends only for `mode == .hold` with no `stoppedBy`
and inserts everything else. A hold ends as `interrupted` when the system
cancels the touch, the app goes to the background or an audio interruption
begins; it shows no notice. Hands-free pauses on an interruption and resumes
after it.
`VoiceInputController.recoverable` lists the target's dictations that were not
inserted; `VoiceRecoveryBanner(controller:)` shows the first one and takes no
room in a stack when there is none. Strings default
to `VoiceStrings.current` (Chinese for a `zh` locale, else English); pass
`englishVoiceStrings`, `chineseVoiceStrings` or your own `VoiceStrings`.

Hosts declare `NSMicrophoneUsageDescription` and, so that hands-free keeps
recording in the background, `UIBackgroundModes` = `audio`.

```sh
swift test            # macOS: conformance/*.json, file store, session scenarios
```

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
  code), `VoiceLivePanel`, `VoiceRecoveryBanner` and `englishVoiceStrings`.
  `chineseVoiceStrings` and `voiceStrings(locale)` are in `ui/ChineseStrings.kt`,
  which a host that ships only English can leave out.

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

`onText` receives `VoiceTextInfo` with the session's final `mode` (`Hold`,
`HandsFree` or `Restore`) and `stoppedBy` (`Interrupted`, `Limit`, `Silence`,
or null when the person ended it), so a host can, for example, send a
released hold and keep everything else in the field. A hold finishes as
`Interrupted` when the app goes to the background, when another app takes
audio focus, or when the system cancels the touch. Hands-free pauses while
another app has audio focus, and keeps recording in the background through
`VoiceRecordingService`, a
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
