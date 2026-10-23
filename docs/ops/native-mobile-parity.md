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
jobs. No administration, sharing, publishing, profile creation or bulk deletion
route is enrolled.

An old or inactive server answers the capability probe without invalidating an
otherwise valid native session. The client checks this probe before calling a
legacy cookie-only endpoint. Activation, remote push, merge and deployment are
separate from local implementation and require the applicable owner approval.

## Device authentication and files

Device lock is opt-in after account sign-in. Android uses BiometricPrompt with
device credentials; iOS uses LocalAuthentication's deviceOwnerAuthentication.
The OS owns fingerprint, Face ID, PIN, pattern and passcode entry. The app has no
custom PIN database and receives none of those secrets. Cold restart and thirty
seconds in the background require authentication before native access-token
issuance. Cancelling the prompt keeps the session locked without consuming its
rotating credential. Android enables FLAG_SECURE while this option is enabled.

Already opened UI state is hidden and inert while locked; it is retained so that
a long system file selection does not discard the draft. A native DEVICE_LOCKED
refusal waits before HTTP dispatch and resumes after native unlock. It does not
replay an HTTP mutation. Signing out from the lock screen discards drafts and
remounts the account UI.

The Android system document picker grants access to user-selected files. No broad
storage or media permission is added. A selected upload still follows the server's
prepare/completion protocol. The signed R2 PUT runs in the native layer to avoid
WebView storage CORS failures. HTTPS destination validation, no redirects, bounded
bytes and header allowlists prevent sending an application bearer or cookie to
storage. The completed receipt contains an upload ID, never a storage key.

## Review and image execution

One question is persisted once. Parallel answers use independent model histories;
switching provider tabs does not submit a question. Easy routing uses the existing
client validator and server router, with no manual substitution for an unsupported
provider. Professional selection uses the existing model catalogue and plan limit.
Deep Research follows the existing durable async job and never submits a second
research job while restoring status.

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
not automatically repeated. Generated assets use short-lived signed URLs in memory
and bounded automatic expiry recovery.

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
