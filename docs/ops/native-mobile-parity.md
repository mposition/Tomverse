# Native mobile parity

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
AI cross-review and item feedback/verification, and polling existing Deep Research
jobs, reading the existing account usage totals and generating conversation titles
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
Android retains FLAG_SECURE while this preference is enabled. Server session expiry,
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
