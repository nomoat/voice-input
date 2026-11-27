# voice/v1

One WebSocket per dictation session, between a client and the app's own
server. The server relays audio to speech services. Clients never talk to a
speech service directly.

## Audio

- 16 kHz, mono, signed 16-bit little-endian PCM.
- Binary frames of exactly 3,200 bytes (100 ms). The client pads the last
  frame with silence.
- A frame's position is its index × 100 ms from the stated start (`fromMs`).
  Both sides count frames, so audio positions need no timestamps.
- A session holds at most 20 minutes of audio (`MAX_SESSION_MS`). The client
  stops at 20:00; the server refuses audio past 20:10.

## Client → server

| Message | Meaning |
|---|---|
| `{"type":"start","v":1,"session":"<id>","token":"…","languages":["zh-CN"],"surface":"screenplay","fromMs":0,"nextSeg":0}` | First message. Opens or resumes a session. `token` is the host app's credential; it never goes in the URL. `surface` names the screen (for metrics). On resume, `fromMs` and `nextSeg` come from the journal (below). |
| binary frame | 100 ms of audio, in order. Send only after `ready`. |
| `{"type":"finish","endMs":192300}` | No more audio. Sent after the last frame. |
| `{"type":"cancel"}` | Drop the session. |

## Server → client

| Message | Meaning |
|---|---|
| `{"type":"ready","maxMs":1200000}` | Authenticated. Audio can flow. |
| `{"type":"interim","seg":7,"text":"…"}` | Current guess for segment 7. Replaces the earlier guess for that segment. |
| `{"type":"commit","seg":7,"text":"…","startMs":181000,"endMs":192300}` | Final text for segment 7. Segments are contiguous: `startMs` of segment n+1 equals `endMs` of segment n. Commits can arrive out of order. The server may have cleaned the text (see Segment clean-up); interim text is never cleaned. |
| `{"type":"ack","ms":192300}` | Audio received up to this position. |
| `{"type":"done","nextSeg":8}` | Every segment is committed. The server closes the socket. |
| `{"type":"error","code":"…","retryable":true}` | `unauthorized`, `forbidden` (signed in but not allowed, for example no AI consent), `bad_request`, `limit`, `providers_unavailable`, `timeout`, `server`. The server closes the socket after an error. |

The speech service in use is never sent to the client.

## Flow control

The client sends no more than 30 s of audio beyond the last `ack`
(`SEND_WINDOW_MS`). The server holds its `ack` while four segments wait for
final text. Server memory per session is therefore bounded.

## Segments (server)

The relay cuts the audio into segments and gives each segment its own speech
service session:

- From 20 s of segment length, cut after a pause of 300 ms (200 ms from 45 s).
- At 60 s, cut at once.
- With no audio for 1.5 s (for example a paused client), cut.
- A segment with no voice at all (RMS below 200 in every frame) commits empty
  text without a speech service.

Each segment tries the speech services in order. On a connection error,
disconnect or connect timeout, the relay replays that segment's audio (at most
60 s) to the next service. If a service never sends its final result, the
latest text commits after the service's finish timeout. If every service
fails, the session ends with `providers_unavailable` (retryable).

## Segment clean-up (server)

A relay with a `format` function cleans each segment's final text before its
`commit`: punctuation, filler words, false starts and self-corrections. The
client sees only the cleaned commit and needs no change.

- The clean-up has `formatMs` (default 1200 ms) per segment. A result that
  comes later, an error, `null`, or a result the guard refuses (it drops or
  adds too much content) sends the raw text.
- A later segment's commit waits for an earlier one still being cleaned, so
  commits leave in the order the segments finished. `done` waits for them, so
  Done takes at most `formatMs` longer.
- Empty segments and interim text are never cleaned.

## Client journal and resume

The client keeps, per session:

- **Spool:** every recorded frame, until a contiguous commit covers it.
- **Journal:** `start`, then `commit`, `rewind`, `finish`, `complete`, `tidy`,
  `inserted`, `discarded` records. `complete` is written only when the committed
  text has words. A session that ends with blank text deletes its journal and
  spool instead, and a recovery list drops any `complete` session with blank
  text and no `tidy` (from older builds) that was never inserted or discarded.

Write order: append a `commit` record, then delete spool frames before the
contiguous commit end. Each word is always in the journal, in the spool, or
in both.

The **contiguous end** is the `endMs` of the highest segment k such that
segments 0…k are all committed and contiguous. On reconnect the client:

1. Drops committed segments after k (journal `rewind` with `nextSeg = k + 1`).
2. Sends `start` with `fromMs` = contiguous end and `nextSeg` = k + 1.
3. Resends spooled frames from `fromMs`, then live frames.

## Display text

Display = committed text of segments 0…k, then the text of every later segment
(interim or committed) as the interim part. Two pieces join with no space
when either side is Han, Hiragana, Katakana or CJK punctuation, or when the
second piece starts with punctuation; otherwise with one space.
`conformance/text.json` holds the cases.

## Conformance

`conformance/session.json` is a list of scenarios: client actions, server
events and expected state. The TypeScript, Swift and Kotlin clients run the
same file.
