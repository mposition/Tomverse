# Voice conversation

Implementation: default off. This is distinct from the free, review-before-send
dictation feature in [Voice input](voice-input.md). No live paid verification,
activation, merge or deployment is implied by implementation or mock tests.

Owner decisions in chat, 2026-10-23:

- GPT-Live handles speech and interruption. Substantive answers use the existing
  Tomverse Chat Send path, including Smart Adaptive, manual model selection,
  search, tools, conversation context, durable messages and answer billing.
- Voice usage is charged to the user's ordinary plan/purchased-credit wallet at
  **36 credits/minute**. Meter cumulative provider seconds and round up once per
  session. Answer-model and search charges remain separate.
- The owner removed the per-minute price wording from the voice UI and Figma
  mockups. This presentation change does not change the approved billing rate.

## User flow

The waveform control beside Send opens a voice dialog. Before Start, disclose
separate answer/search charges and the maximum temporary hold; omit the per-minute
price wording in the voice UI.
Start requests microphone access before any paid request. The dialog shows both
speakers' captions independently, connection duration, estimated voice credits,
microphone mute and End. Muting does not pause billing. End returns to the same
Chat; its existing pipeline retains user questions and backend answers. The
spoken paraphrase and brief acknowledgments are live captions, not additional
duplicate saved assistant messages. Do not present a caption as proof of audio
playback.

The shared browser transport is separated from React. The current product entry
is the responsive Chat surface; the diagnostic Capacitor shell and its unwritten
native authentication plugin are not claimed as a verified iOS/Android release.

## Server and wallet boundaries

- `POST /api/chat/voice` requires the existing authenticated web session and
  ownership/unlock of an existing Chat. A blank Chat is created by the ordinary
  Send pipeline on its first substantive request. Guest voice is not enabled.
- The server creates a WebRTC session with client delegation, provider storage
  disabled, server-sourced history, and no frontend command authority. A trusted
  sideband observes usage and controls closure. Neither keys nor raw audio are
  logged or persisted by Tomverse.
- Results are read from the owned, completed `ChatResponseAttempt`; the browser
  supplies only an answer receipt, never trusted answer text or usage seconds.
- The existing credit-account and subject locks, usage buckets, debt offset,
  plan allocation and purchased-credit ledger are reused. Reserve the bounded
  session and 30 seconds of closing headroom before the paid initialization.
  The default 300-second session temporarily holds **198 credits**. Insufficient
  available credits refuses Start; unused credits return after known settlement.
- Voice reservations use `source=voice_conversation` in `ChatCreditReservation`.
  Their JSON contains accounting/session references, not transcript or audio.
  The generic token-reservation expiry reconciler excludes this source: expiry
  or a missing final event is not evidence of zero voice usage.
- Only trusted `session.closed.usage.seconds` (or a proven pre-dispatch refusal)
  settles and refunds. Atomic claim prevents duplicate charge/refund and provider
  cost rollup. Unknown starts/final usage retain the hold with an explicit error
  marker; do not blindly retry them or refund on a browser report.
- The server enforces duration and the kill switch; browser cancellation closes
  the session and releases device resources. A user can still request Stop after
  the kill switch or account restriction is applied.

## Configuration and verification

`VOICE_CONVERSATION_ENABLED=true` and a dedicated
`VOICE_CONVERSATION_API_KEY` are required. A nonempty
`VOICE_CONVERSATION_KILL_SWITCH` disables new starts and closes running sessions.
`VOICE_CONVERSATION_MAX_SECONDS` defaults to 300 and accepts integers 15–900.
Existing voice subject/provider seconds budgets also apply. These settings are
not changed by this implementation.

The provider list price was read on 2026-10-23:
[OpenAI pricing](https://developers.openai.com/api/docs/pricing), USD 0.05/minute,
billed per second. WebRTC initialization has a 15-second provider charge credited
against running duration. Confirm the account's reported duration and invoice
behavior in an explicitly approved paid canary before activation. Also verify
provider access, real device audio/interruptions, caption timing, server-process
loss and finalization recovery. In particular a sideband timer alone is not a
durable watchdog across a server crash; activation needs bounded provider-side
duration or an independently verified session-recovery mechanism.

Mock coverage: core pricing/captions, device lifecycle, server authorization and
known/unknown outcomes, wallet allocation/refunds/idempotency, and browser reuse
of ordinary Chat Send with Auto/manual selection and search. Financial changes
require the repository's independent finished-diff review.
