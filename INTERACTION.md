# Interaction

Every client (iOS, iPadOS, Android, Web, Desktop) behaves the same way.

## Gestures

The microphone starts at touch-down, before the gesture is known, so the
first word is never lost.

| Gesture | Result |
|---|---|
| Tap (released within 350 ms, moved less than 12 pt) | Hands-free. Talk until you tap the button again or press Done. |
| Hold (still down at 350 ms, or moved) | Hold to talk. Release inserts the text. |
| Hold, slide up more than 65 pt | `Release to cancel` (the panel turns red). Slide back to keep. |
| A hold interrupted by the system (pointer cancel, app to background) | Finishes and inserts. Nothing is lost. |

The host's `onText` receives `mode` (`hold`, `handsFree` or `restore`) and
`stoppedBy` (`interrupted`, `limit`, `silence`). A host that sends on release
(Impo) sends only for `mode: hold` without a `stoppedBy`, and inserts
everything else into the field.

Keyboard (Web/Desktop), on the focused button: Space held = hold to talk,
Space or Enter tapped = hands-free, Escape = cancel, Cmd/Ctrl+Enter = Done.

Hosts that start a hold from a long press on an empty text field (Impo) wait
350 ms before starting, so a tap still focuses the field.

## Stops

- Tap again, Done, or release (hold).
- 20 minutes of audio: the session stops and keeps the text
  (`Stopped at 20 minutes. Your text is kept.`). From 19:00 the panel says
  `1 min left`.
- Hands-free, 3 minutes of silence: the session stops and keeps the text.
  From 1 minute of silence the panel says `Still listening · tap Done when
  you finish`.
- A short pause never stops anything.

## Live panel

- Opens above the button (or above the host's composer) at touch-down, the
  composer's width up to 560 pt.
- Grows to 40% of the screen height on phones and 320 pt elsewhere, then
  scrolls. It follows the newest text; when the person scrolls up, it stops
  following and shows `Latest ↓`. The text area shows at least two lines, and
  in Swift its height is a whole number of lines, so no line is cut at its top.
- Committed text in the primary color, interim text in the secondary color.
- Header: level meter, status, time. Status texts: `Listening`,
  `Connecting… your voice is being recorded`, `Offline · still recording`,
  `Paused by another app`, `Finishing…`, `Tidying…`.
- Footer: hold mode shows `Release to insert · Slide up to cancel`;
  hands-free shows `Cancel` and `Done`, with the tap hint beside them when it
  fits in two lines (otherwise the hint is left out; the buttons keep their size).
- At accessibility text sizes (Swift) the panel stacks: the meter and the time
  (never wrapped) on one line, the status below in up to two lines, and
  `Cancel` and `Done` full width one above the other, without the tap hint.
  The whole panel (status, text and buttons) then scrolls as one, up to 60% of
  the screen height on phones and 44% (at least 320 pt) elsewhere, following
  the newest text and the buttons.
- Read only while recording. Editing happens in the host's field afterwards.
- Screen readers hear committed text, not interim text.

## After Done

- The final text goes in at the cursor and replaces the selection, as one
  undo step (`insertText` joins it with the text around it).
- Hosts with `tidy` (long-form documents) send texts of 80 characters or more
  to the tidy endpoint first. The tidied text goes in; the raw text stays in
  the journal. If tidy fails, is refused by the guard or takes over 30 s, the
  raw text goes in.
- Finished offline: `Saved. The text appears when you are back online.` The
  panel can close; the text waits in the recovery banner.

## Recovery

- A dictation that never finished (app killed, page closed) or finished but was
  never inserted shows a banner on its target screen:
  `Unfinished dictation · 3 min · Restore / Discard`. Restore sends the
  remaining spooled audio through the relay, without the microphone.
  At accessibility text sizes (Swift) the title takes the full width and the
  two buttons sit below it, one above the other.
- Inserted dictations stay on the device for 7 days, discarded ones for
  24 hours, abandoned ones for 30 days.

## Strings

English and Chinese are built in (`englishVoiceStrings`,
`chineseVoiceStrings`). Hosts pass their own translations for other
languages.
