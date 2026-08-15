# Enter and IME composition — exploratory observation, 2026-08-15

Not a checklist row and not a verification. One environment was measured
because a tester saw a message send with an unfinished syllable in it, and the
result changed what the accessibility matrix should be asking for. Recorded
here so the next person does not repeat the investigation, and kept separate
from the matrix because **a desktop measurement does not satisfy any of rows
10–13**, which are Gboard, the Samsung keyboard, the iOS Korean keyboard and a
mobile external keyboard.

## Environment

| | |
|---|---|
| Build | `b0cf10e761053fd5f00c3cd6064edc41925e1898` (production) |
| OS | Windows 11 |
| Browser | Chrome (desktop) |
| IME | Microsoft Korean IME, 2-beolsik |
| Shell | desktop chat composer (`components/chat/ChatInput.tsx`) |
| Observer | @mposition |
| Date | 2026-08-15 |

## What was done

Typed `안녕하세` and then `ㅇ` — leaving `ㅇ` in composition, before it could
become `요` — and pressed **Enter**. The message was sent as `안녕하세ㅇ`.

Event listeners were attached in the capture phase for `compositionstart`,
`compositionupdate`, `compositionend` and `keydown`.

## What was observed

The final four events, verbatim:

```
keydown            Process  keyCode 229  isComposing true   value "안녕하세ㅇ"
compositionupdate  data 'ㅇ'                                value "안녕하세ㅇ"
compositionend     data 'ㅇ'                                value "안녕하세ㅇ"
keydown            Enter    keyCode 13   isComposing false  value "안녕하세ㅇ"
```

`compositionend` arrives **before** the Enter `keydown`, and that keydown
carries neither of the two signals the guard reads:

```ts
// lib/chatKeyboardPolicy.ts
Boolean(event.nativeEvent?.isComposing) || event.keyCode === 229
```

Every keydown that *was* part of the composition arrived as `Process` /
`keyCode 229`, never as `Enter`.

## What this does and does not establish

**Does:** in this environment, the guard has no signal to act on when Enter is
pressed. The text that was sent was the textarea's actual content at that
moment — the IME had already committed `ㅇ` — so nothing was truncated by the
application. Pressing Enter mid-syllable here behaves as pressing Enter
mid-word does in a Latin composer.

**Does not:** this says nothing about other Korean IMEs, other browsers, other
operating systems, or mobile keyboards. One environment was measured.

**Does not:** it is not a reason to weaken or remove the guard. The invariant —
an Enter carrying `isComposing` or `keyCode 229` never submits — is unchanged,
and the environments where it does fire are the ones worth verifying.

## What it changed

The guard's real subject is a **candidate-selection IME**, where the first
Enter chooses a candidate from a popup and must not also send the message.
Those environments were not in the matrix at all, so three rows were added:

- Windows + Chrome/Edge + Microsoft Pinyin
- Windows + Chrome/Edge + Microsoft Japanese IME
- macOS + Safari + Apple Japanese IME

Chinese is a supported product locale, so its row is the higher priority. The
Japanese rows earn their place regardless of locale support: they are the
cheapest way to detect a regression in candidate selection.

Rows 10–13 stay exactly as they were. They ask a different question — whether a
mobile IME's composition survives Enter — and nothing here answers it.

A comment in `components/images/ImageGenerationWorkspace.tsx` named Korean as
the composition-confirming example. It now names candidate-selection IMEs and
points here. No behaviour changed.
