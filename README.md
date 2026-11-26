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
dictation on the device for the recovery banner). `VoiceTextInfo.mode` says whether the dictation
ended as a hold or hands-free, for hosts that send on release.
`VoiceInputController.recoverable` lists the target's dictations that were not
inserted; `VoiceRecoveryBanner(controller:)` shows the first one and takes no
room in a stack when there is none. Strings default
to `VoiceStrings.current` (Chinese for a `zh` locale, else English); pass
`englishVoiceStrings`, `chineseVoiceStrings` or your own `VoiceStrings`.

Hosts declare `NSMicrophoneUsageDescription` and, so that hands-free keeps
recording in the background, `UIBackgroundModes` = `audio`. A hold finishes
when the app goes to the background.

```sh
swift test            # macOS: conformance/*.json, file store, session scenarios
```

## Android

`android/voiceinput`: the Kotlin core and Compose UI.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm build            # dist/ is committed so apps can depend on a Git revision
pnpm check:dist
```

Automated tests use synthetic PCM. They never open a microphone.
