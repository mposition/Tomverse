# Native mobile parity

## Tomverse access pass codes

Owner request (2026-10-28): the native Plan tab accepts the same complimentary
Tomverse trial/access pass codes as the web. `POST /api/billing/checkout` uses
the native bearer account only under the existing native Chat/parity switches;
bearer requests without an `internal_pass` promotion are refused before any
Stripe customer, checkout, or redemption write. Web checkout remains unchanged.
The existing pass transaction, expiry, one-use-per-account constraint and total
redemption cap apply. No new promotion, extra credit grant, store discount or
automatic renewal is introduced. Mobile billing advertises `promotionPasses`
only when those switches are enabled. Deploy the server before the client;
older servers never receive native redemption requests. A lost receipt is
checked through balance refresh, never an automatic redemption retry.


The bundled Capacitor client reuses the existing account settings, conversation,
Review, image-generation and Deep Research services. It does not load the website
as its application UI. No provider, pricing, credit, quota or product-key contract
is changed by this integration.

## Activation boundary

`TOMVERSE_NATIVE_PARITY_ENABLED` defaults to off. Both this switch and
`TOMVERSE_NATIVE_CHAT_ENABLED` must be true before any additional bearer route is
enrolled. The exact method/path list is `nativeParityBearerRoute` in
`lib/nativeBearerGate.ts`; the proxy and route session resolver use the same list.
Invalid bearers never fall back to a cookie. Existing route ownership, account
state, conversation locks, entitlements, reservation and consent checks remain in
their original services. Account export/deletion retain their separate switch and
server family sign-in freshness requirement; a local biometric unlock does not
renew that timestamp.

The additional scope covers account preferences and memory settings, reading
assistant profiles, creating Review conversations and routing Easy questions,
reading generated-image groups/history, explicitly requested Studio generation,
AI cross-review and item feedback/verification, reporting a problem with one
answer (`POST /api/feedback`), polling existing Deep Research jobs, reading the existing account usage totals and generating conversation titles
through the existing owner-scoped service. The client calls title generation at
most once after the first successful answer, retaining the saved interim title on
failure. Compare-and-set preserves subsequent web renames. Title/usage capability
fields prevent calling older cookie-only deployments. No administration, sharing, publishing, profile creation or bulk deletion
route is enrolled.

An old or inactive server answers the capability probe without invalidating an
otherwise valid native session. The client checks this probe before calling a
legacy cookie-only endpoint. Activation, remote push, merge and deployment are
separate from local implementation and require the applicable owner approval.

## Device authentication and files

Device authentication is opt-in after account sign-in. Android uses BiometricPrompt
with device credentials; iOS uses LocalAuthentication's deviceOwnerAuthentication.
The OS owns fingerprint, Face ID, PIN, pattern and passcode entry. Tomverse receives
none of those secrets. The preference persists across sign-out and gates the next
fresh email-code verification or PKCE exchange, including after session expiry.
Cancelling device authentication does not consume the email code or exchange grant.
A synchronous sign-out generation fence invalidates callbacks captured by an
earlier sign-in, including callbacks queued before main-thread cleanup. It also
cancels device prompts. An in-flight cancelled exchange cannot persist credentials;
its unused refresh credential is revoked once, with an uncertain result reported
as unconfirmed logout. A valid stored session
restores without another prompt on cold restart, background return or token rotation.
If the one-shot revocation of a cancelled exchange cannot be confirmed, its
unused secret is discarded; the server family may remain valid until expiry.
The client never replays that secret. The conservative unconfirmed-revocation
flag is reported at the next logout, even if a newer sign-in caused the original
cancellation. iOS race handling still requires Mac/device acceptance.
Device sign-in verification does not block Android screenshots or screen recording.
Server session expiry,
revocation, account freshness and rotating-secret consumption are unchanged.

The Android system document picker grants access to user-selected files. No broad
storage or media permission is added. A selected upload still follows the server's
prepare/completion protocol. The signed R2 PUT runs in the native layer to avoid
WebView storage CORS failures. HTTPS destination validation, no redirects, bounded
bytes and header allowlists prevent sending an application bearer or cookie to
storage. The completed receipt contains an upload ID, never a storage key.

## Review and image execution

The default mobile layout keeps one 52px application header and one 44px Review
context row. The product selector lives in the header. Easy/Professional and
participant selection open from the context row; cross-review and Studio open
from the composer tools menu. There are no permanent Write/Results tabs or model
chip rows. A one-line composer grows only as the user types. At 390x844 the UI
regression requires more than 72% of the viewport for the conversation and less
than 11% for the idle composer.

One question is persisted once. Parallel answers use independent model histories;
switching the displayed provider does not submit a question. Multi-model sends
first acquire the existing aggregate preflight admission before persisting the
question. A real refusal preserves the draft and selected attachments and starts
no model request; infrastructure failures retry once, then use each model's
ordinary admission as on the web. A null optional context bundle is omitted from
model requests. Easy routing uses the existing
client validator and server router, with no manual substitution for an unsupported
provider. Professional selection uses the existing model catalogue and plan limit.
Deep Research follows the existing durable async job and never submits a second
research job while restoring status. A restored foreground conversation polls
until a terminal status, retries transient connection/server failures, and stops
the watcher when the view closes. Item feedback follows the existing PUT/DELETE
contract. The cookie-only bulk DELETE /api/chat route is not enrolled.

Cross-review renders reviewer provenance, per-quote matching, the source quote
match rate, original-response links, limitations and reversible per-item feedback.
Quote matching is not factual accuracy. Paid web verification is a separate,
explicit action. Unknown run outcomes are not automatically repeated; cross-review
has read-only cached-result recovery. An unknown web-verification outcome stays
blocked locally because that endpoint has no persisted-result read API.

Images use the existing Studio product creation API rather than changing a Review
conversation's product. The mobile catalogue includes user-facing credit prices
and pricing versions only. Current prices, selected models and consent are checked
before generation; a changed quote requires fresh consent. Unknown submissions are
not automatically repeated. An owner-scoped read-only receipt lookup recovers a
lost response by its original request key. If no receipt is found, an explicit
resume uses the same key and original options, with fresh quote consent. A replay
refusal (including authentication, rate limit or stale pricing) retains that key:
those checks can run before lookup of an already-created generation. A found
receipt clears the local marker. A permanently refused request can be explicitly
closed with confirmation that this does not cancel server processing or credits;
closing requires fresh quote consent before any new request and never dispatches
generation itself. Generated assets use short-lived signed
URLs in memory and bounded automatic expiry recovery.

## Microphone capture

Capacitor 8.5.3 requests RECORD_AUDIO and MODIFY_AUDIO_SETTINGS together for
WebView audio capture. The Android manifest declares both; MODIFY_AUDIO_SETTINGS
is a normal permission and adds no new runtime prompt. Without that declaration,
the bridge rejects getUserMedia even after the user grants microphone access.
An emulator reproduction confirmed NotAllowedError before the fix and a nonempty
audio/webm recording with ended tracks afterwards. This checks capture, not paid
transcription. The shared web recorder is reused. Permission, device, network and
server transcription failures have separate messages. The existing approved voice
privacy notice is shown during recording; converted text remains editable and is
never automatically sent as a question.

## Validation and remaining release evidence

Local verification includes browser UI tests, transport/session tests, existing
image-route and comparison-result regressions, TypeScript, ESLint, shared-package
purity, local-bundle and native-token boundary checks, and an Android debug APK.
An isolated emulator fixture blocks all production, email and provider execution.
It verifies system PIN opt-in, cold restart, cancellation, native token refusal,
unlock/session restoration, and a real system-picker PNG upload with byte/hash and
credential-header assertions. The fixture certificate and proxy configuration are
not part of the stock APK.

iOS source and Capacitor synchronization are prepared, but an Xcode build and
Face ID/Touch ID device tests require a Mac. Physical Android biometric enrollment,
live paid model/image/research calls, full seven-language parity for new copy,
store review, and complete web workspace/account-management parity are not claimed
by local fixture verification. New copy currently has English/Korean versions and
uses English fallback for the other supported languages.

## Follow-up regression checks

The history list uses flat rows with a 48px minimum height, 4px spacing, a two-line
title clamp and a separate 44px-wide context-menu target. Chat and Review reuse the
same list component. Internal conversation rows do not use an external-link arrow.
The account footer stays below the independently scrolling list.

History actions reuse the web endpoints for rename, ordered pinning, project
management, public snapshot sharing/revocation, TXT export with the optional imported
original, deletion and password locks. Title and message search reuse the server
search route, including its locked-source checks, result expiry and incomplete-search
signals. Filters match the web's locked, shared, comparison, model and project filters;
pins precede the same calendar-date groups as the web. Public share and export
visibility also use the server's plan capabilities. Creation of a public share,
irreversible conversation deletion and source-inclusive export require explicit UI
confirmation. Unknown mutations are never automatically repeated: a marker scoped
to the signed-in account requires a read of saved state before another change.

These additional bearer routes remain behind the existing default-off native parity
deployment flag. The exact enrollment includes only their documented methods, not
bulk conversation deletion/export, arbitrary share reads or administrative paths.
The handlers use the verified bearer owner even if a different browser cookie is
present, while retaining their existing ownership, lock, plan and operational checks.

Native fetch still omits cookies. A successful password verification returns the
existing signed, owner/conversation/password-bound unlock grant instead of setting a
browser cookie. At most 32 grants are held in app memory and sent through
`X-Tomverse-Conversation-Unlocks` only to conversation APIs. They retain the existing
30-minute expiry; a native bearer never borrows a browser unlock cookie or an
external-resource grant. Logout/session loss clears them, and an in-flight proof
cannot reinsert one after logout. Passwords and grants are not persisted in WebView
storage. The cookie-only web proof format and behavior remain unchanged.

Usage reads refresh capability support before calling `/api/user/usage`, so retry
can recover immediately after server activation. An older server does not receive
that cookie-only request and cannot accidentally log out a valid native session.
Unavailable usage never renders a fabricated zero. The usage route enrollment and
capability declaration must be deployed together for production totals to load.

Smart Adaptive image handoffs are recognized by the `image-turn` response mode,
separately from deep-research receipts. The `chatImageTurns` capability advertises
the exact native POST `/api/conversations/{id}/image-turn` enrollment behind the
existing native parity flag. Deploy the route and capability before distributing
the updated mobile bundle. Older servers never receive that cookie-only request.
The handler uses the verified bearer owner and retains the image service's existing
ownership, conversation lock, plan, pricing, credit and provider-budget checks.
The saved question and assistant answer ID are reused; a lost receipt is recovered
by reading saved history, without resubmitting the question or another image.

Chat startup restores the signed-in account and history list while staying on the
new-conversation screen. It never opens the last Chat automatically. Selecting a
history row restores its saved messages, files, images and voice session receipts;
unsent drafts remain scoped to their original conversation.

`tests/native-mobile/followups.spec.ts` covers newline-only Enter, the header new
conversation action in Chat and Review, server-derived Easy defaults, explicit
empty selection, and the account footer at a short viewport.

From `apps/mobile/android`, with Java 21 and Android SDK configured, run
`./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=app.tomverse.shell.DeviceSignInTest`
(`gradlew.bat` in PowerShell, with the `-P...` argument quoted). The test uses real
Android Keystore and the native serial queue, isolated preference namespaces and
an in-process HTTPS fixture; no production or provider request is dispatched.
It covers cold restore, a 31-second background return, fresh sign-in proof
refusal before email-code consumption, and a missing-session sign-in requirement.
This does not replace physical fingerprint/PIN or iOS Face ID acceptance.
