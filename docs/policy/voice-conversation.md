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
  A delegated answer is queued temporarily for delivery and removed when sent,
  when delivery fails, or atomically with settlement, including crash recovery.
  The generic token-reservation expiry reconciler excludes this source: expiry
  or a missing final event is not evidence of zero voice usage.
- Wallet and subject/provider seconds reservations now commit and settle in the
  same transaction. Their original bucket dates travel in the durable payload.
- The independent `voice:watchdog` process records monotonic provider usage and
  takes over the provider sideband after the web receiver's 30-second durable
  lease expires. A healthy receiver renews every five seconds; the worker
  uses a database lease to exclude competing recovery and maintenance
  receivers, enforces the deadline and observes the kill
  switch on every cycle. It receives final events after a web process dies.
  Processing a final receipt has a 15-second deadline. A stalled database
  operation stops renewing receiver ownership so another sweep can recover;
  an unresolved final is still treated as unconfirmed, not invented usage.
  New paid starts require a
  heartbeat newer than 15 seconds. Its timers close sessions at the persisted
  deadline; the existing maintenance sweep also retries unresolved records.
- A trusted final receipt settles the exact duration. After the closing grace
  expires without a final receipt, charge only the provider-observed lower
  bound and waive unobserved seconds. Return the unused wallet hold while
  retaining the full provider seconds budget and conservative cost estimate.
  This adjusted outcome is explicitly marked unconfirmed, never a fabricated
  final measurement. A start whose provider outcome is unknown is not retried.
- A failed provider hangup remains pending after wallet settlement and blocks
  that account's new starts until closure is confirmed. Other accounts still
  share the conservative provider budget. A lost session identifier therefore
  requires operator/provider evidence to clear; the customer hold is not kept
  indefinitely. Browser-reported seconds are never settlement evidence.
  A timed-out finalizer resuming after settlement cannot clear this block or
  increase the charge; reconciliation confirms hangup before clearing it.
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

Run `npm run voice:watchdog` as an independently supervised process with
`VOICE_CONVERSATION_WATCHDOG_ENABLED=true`, the dedicated provider credential,
and the same database and budget configuration. Running it inside the web
process does not satisfy crash isolation. It creates no new paid session.

The provider list price was read on 2026-10-23:
[OpenAI pricing](https://developers.openai.com/api/docs/pricing), USD 0.05/minute,
billed per second. WebRTC initialization has a 15-second provider charge credited
against running duration. Confirm the account's reported duration and invoice
behavior in an explicitly approved paid canary before activation. Also verify
provider access, real device audio/interruptions, caption timing, server-process
loss and finalization recovery. Verify the independently supervised watchdog
deployment and its closing deadlines before activation; process-local timers
alone cannot establish that deployment evidence.

Mock coverage: core pricing/captions, device lifecycle, server authorization and
known/unknown outcomes, wallet allocation/refunds/idempotency, and browser reuse
of ordinary Chat Send with Auto/manual selection and search. Financial changes
require the repository's independent finished-diff review.

The Android APK reuses the existing native MVP, its reviewed native bearer
authentication and canonical Chat transport. `sendVoice` persists through that
same transport and returns the saved source-message receipt. Web and native
render `@tomverse/chat-ui`'s voice panel; both show persisted session usage in
Chat after closing and reopening. The UI does not display the per-minute rate.

Issued voice delegations retain an exact-question digest. A result must match
that digest and an owned, durable source message. Ready results are claimed
once in the reservation row and sent through the existing metering sideband;
an indeterminate append is never replayed. Caption transcript text is not
retained in this task record. Completed asynchronous research is linked by
the nullable `PerplexityAsyncJob.sourceUserMessageId` field; its migration must
be applied with the server release before that path is activated. Voice also
reserves and settles the canonical OpenAI day/month cost buckets atomically
with its existing credit and seconds holds.

Delegations are queued by provider audio offset while transcript fragments
arrive. A two-second quiet window includes sentence pauses; fragments do not
individually define a completed turn. If the server stream fails, the client
immediately stops microphone capture and mutes playback. It keeps the silent
primary connection for at most 60 seconds, bounded by the session's existing
30-second closing allowance, while polling persisted billing. Unmount still
releases resources immediately. Once the web lease expires, recovery durably
requests closure and closes its leased receiver immediately after attachment.
It does not dispatch queued answers during termination. The canonical answer
remains in Chat; settlement removes the temporary answer without risking a
repeated spoken result.
Malformed answer SDP is durably linked before a closing receiver collects final
usage; a known final releases excess provider cost holds normally. Missing final
evidence continues to retain conservative exposure under the existing rule.
