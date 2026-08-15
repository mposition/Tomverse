# Accessibility QA matrix

Where accessibility verification for Tomverse Insight is recorded (WO-007 /
UX-F011). Automation covers part of this; the rest needs a human on real
hardware and is marked **N/V** — *not verified* — until someone runs it.

**N/V is not a pass.** A release that needs accessibility sign-off is not
signed off by the automated rows alone.

Fill in a dated copy of the manual table per release candidate. Record the
build SHA, because evidence against another build does not carry over.

```
Release SHA: 851598eb8957342bc66d742596692961dbaec03f
Date / timezone: 2026-08-15 / AEST
Tester: @mposition
```

## What automation covers

`tests/e2e/accessibility-core-tasks.spec.ts` runs on every Chromium project
and covers the machine-checkable slice of the core tasks:

| Check | Covered by automation |
|---|---|
| Keyboard-only completion (no pointer) | yes |
| Visible focus on every interactive stop | yes |
| `forced-colors: active` — controls stay visible and labelled | yes |
| `prefers-reduced-motion: reduce` — no content depends on animation | yes |
| 200% / 400% reflow, no horizontal overflow | yes (equivalent CSS-pixel viewport) |
| Accessible names / roles for core controls | yes |
| Touch targets ≥ 44×44 | yes (existing `touch-targets.spec.ts`) |

These are necessary, not sufficient. None of them establishes that a screen
reader announces something *usefully* — only that a name exists.

## What automation cannot cover

A headless Chromium has no screen reader, no IME, and no physical keyboard.
Nothing below can be inferred from a green suite.

| # | Environment | Task | Expected | Actual | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | NVDA + Chrome (Windows) | Landing → consent notice: reach Decline/Accept, hear what is being consented to | Purpose announced before the buttons; both reachable | | | **N/V** |
| 2 | NVDA + Chrome | `/pricing`: read each plan's price and period | Reads as "<price> per month", not "<price>per month" | | | **N/V** |
| 3 | NVDA + Chrome | Model picker: open, understand current selection, change it | Selected state announced, not conveyed by styling alone | | | **N/V** |
| 4 | NVDA + Chrome | Send a comparison, wait for responses | Per-panel start/finish announced without flooding | | | **N/V** |
| 5 | NVDA + Chrome | Trigger a failure, use Retry | Error announced; focus lands somewhere sensible | | | **N/V** |
| 6 | NVDA + Chrome | `/status`: provider state | State conveyed by text, not colour | | | **N/V** |
| 7 | VoiceOver + Safari (iOS) | Tasks 1–6 on a phone | As above, via rotor/swipe | | | **N/V** |
| 8 | TalkBack + Chrome (Android) | Tasks 1–6 on a phone | As above | | | **N/V** |
| 9 | JAWS + Chrome (Windows) | Tasks 1, 4, 5 | As above | | | **N/V** |
| 10 | Gboard Korean IME | Type Korean in the composer; Enter mid-composition | Composition Enter never sends | | | **N/V** |
| 11 | Samsung keyboard Korean IME | As #10 | As above | | | **N/V** |
| 12 | iOS Korean keyboard | As #10 | As above | | | **N/V** |
| 13 | Mobile + physical external keyboard | Enter, Shift+Enter, Ctrl/Cmd+Enter in the composer | Enter newlines; only Ctrl/Cmd+Enter sends | | | **N/V** |
| 14 | Real browser zoom 200% | `/`, `/pricing`, chat | No horizontal scroll, nothing clipped | | | **N/V** |
| 15 | Real browser zoom 400% | As #14 | As above | | | **N/V** |
| 16 | Windows High Contrast (real, not emulated) | Consent, picker, send, error | Controls and focus remain visible | | | **N/V** |

### Why these specifically

- **10–13** exist because the Enter-key policy is the one place where a wrong
  call silently destroys user input. `lib/chatKeyboardPolicy.ts` treats
  `isComposing` and `keyCode === 229` as the guard; emulated key events in a
  headless browser cannot prove a real IME sets either.
- **14–15** are listed separately from the automated reflow row on purpose.
  Injecting CSS `zoom` is **not** a substitute for real browser zoom and must
  not be recorded as satisfying them.
- **16** likewise: `emulateMedia({ forcedColors: "active" })` applies the media
  query but not the OS colour substitution.

## Defect handling

A finding gets its own tracked ID and severity; it is not fixed silently
inside this document. P0/P1 accessibility blockers block release. Record the
ID in the row's Evidence column so the matrix and the tracker agree.

## Scope

A green visual-regression run is not accessibility evidence — screenshots
cannot see focus order, accessible names, announcements, or OS colour
substitution. See `.github/RELEASE_CHECKLIST.md` §4.
