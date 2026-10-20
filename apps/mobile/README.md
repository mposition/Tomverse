# Tomverse native app MVP

Locally bundled Vite + React + Capacitor application. It uses the existing
mobile session service and Chat persistence, streaming, attachments and voice
APIs. Production builds contain no demo transport and no remote `server.url`.

## Local development

From the repository root, using local PowerShell, without production credentials:

- `npm --workspace @tomverse/mobile run dev` opens the real native-auth client.
- `$env:VITE_TOMVERSE_DEMO="true"; npm --workspace @tomverse/mobile run dev`
  enables an explicitly labelled, synthetic development demo. It makes no model
  call. The demo is compiled out of production builds.
- `npm run build:mobile-shell`
- `npm --workspace @tomverse/mobile run typecheck`
- `npm --workspace @tomverse/mobile run cap:sync`
- `npm --workspace @tomverse/mobile run brand:assets` regenerates native sizes
  from the existing logo using the repository's Sharp dependency.
- `npm --workspace @tomverse/mobile run test:ui` runs the synthetic browser
  interaction suite; it is not physical-device verification.
- `npm run check:native-token-boundary`
- `npm run check:capacitor-local-bundle`
- `npm run check:shared-packages`
- `npm run verify:package-build-matrix`

Native projects are now versioned because they contain microphone permissions,
backup restrictions and app-link declarations. Generated bundles and build
outputs remain ignored. Android builds require JDK 21, Android SDK 36 and Gradle;
run `npm --workspace @tomverse/mobile run build:android` after installing them.
The iOS MVP targets iOS 17.4+ and requires macOS and Xcode. Signing and real device verification are separate.

## Authentication and operational boundary

The default app UI signs existing accounts in using an email address and a
six-digit code entered inside the app. The native plugin calls the exact
`/api/auth/mobile/email` path; the server reuses the existing email delivery,
OTP verification, rate limits and mobile session issuer. Cookies cannot grant
identity on this path. Signup and additional Turnstile verification are directed
to the website rather than bypassed. The initial form has English/Korean copy,
with English fallback for the other app locales.

System-browser sign-in with S256 PKCE remains available in the native plugin
for browser-based identity providers. Existing web sign-in issues a single-use grant.
It now probes the public mobile capability endpoint before opening the browser.
Only a claimed HTTPS callback is accepted; there is no custom-scheme fallback.
The native layer exchanges the grant and serializes refresh rotation. Android
stores AES-GCM ciphertext with a Keystore key; iOS uses a non-synchronizing,
this-device-only Keychain entry. Access tokens live only in memory. Nothing
returns a rotating credential to JavaScript. An uncertain refresh consumes the
local credential and requires a new sign-in, rather than replaying it.

The server enrollment switch `TOMVERSE_NATIVE_CHAT_ENABLED` defaults off. Proxy
and route handlers both validate bearers. Routes additionally check current
family/device/account state; all existing ownership, lock, plan, budget and
persistence checks remain in place. Cookie requests retain cookie authentication
and CSRF checks. Live enrollment, paid calls, push, merge, deployment and store
submission require their separate approvals.

The existing `app.tomverse.shell` identifier is provisional. No production app
IDs, Apple Team ID or signing certificate have been chosen by the owner. No
association files are published or fabricated. The native declarations are
preparation, not proof of verified links. Browser screenshots and sync output
are not physical-device authentication evidence. iOS uses ASWebAuthenticationSession with an exact HTTPS callback, rather than
relying on Safari same-domain navigation. Physical app-link and session evidence
remains required before release.
The email-code path itself needs no app-link callback or production app ID.
It still requires a deployed, enabled server and the existing mobile keyring.
The iOS entitlements prepare both `applinks` and `webcredentials` for the HTTPS
authentication session. AASA registration for either service still requires the
owner's actual application/Team IDs and separate operational approval.

## Product surface

The official `public/tomverse-logo.png`, seven locales and light/dark themes are
used. Chat has a full-width IME-safe composer, conversation history, stream/stop,
server restoration, attachment selection and voice-to-editable-text. Navigation
and model changes are blocked during an uncertain send until a server read.
Requests with unknown outcomes are never automatically resubmitted.

Chat and Review remain separate surfaces. The Review screen currently previews
Easy (provider selection) and Professional (direct model selection); it makes no
comparison request. Chat model changes use the existing authenticated server
PATCH and read back the confirmed selection. Server-offered Smart Adaptive
remains a mode within Chat. Text Send has no credit estimate.

## Verification status (2026-10-20)

The local bundle, Capacitor Android/iOS sync, TypeScript, scoped lint, shared
package purity and Vite package execution checks passed. Synthetic browser
coverage passed 14 cases: first/follow-up answer, tab restart, IME, cancellation,
model sheet, product modes, attachments, voice, denied microphone and sign-out.
Focused bearer/transport/stream checks passed 54 cases; existing server and web product
regressions passed 85 and 28 cases. Broader mobile/session regressions passed
268 cases before the final recovery/error-copy additions. No product provider
was called.

An isolated local PostgreSQL 17 cluster built successfully from the existing
migrations. The existing mobile auth schema/service integration suites passed
34 cases. A real bearer/DB smoke check also confirmed authenticated ownership,
foreign-conversation refusal and suspended-account refusal. Claude accepted the
finished security follow-up at commit 0944c9d;
that review is not authorization to activate the default-off routes.

The full Next webpack build remains blocked by the existing Admin import chain
from decisionMakerBodyCore (node:crypto) into AmuxDecisionMakerRequestsPanel.
Those Admin files are unchanged in this implementation.

Android assembly, installation and local native authentication have now been
verified as described below. iOS still cannot be built on this Windows PC.
Physical-device verification, production links and operational enrollment remain
open; this is not a released MVP.

## Android native verification (2026-10-20)

The user-authorized toolchain installation used checksum-verified Temurin
21.0.12.1+1 and Android command-line tools 15859902. Installed SDK components:
platform 36, build-tools 35.0.0/36.0.0, platform-tools 37.0.1, emulator 37.2.12 and
the API 36 Google APIs x86_64 image. JAVA_HOME and ANDROID_HOME are configured
at user scope; an already-open terminal may need those user values reloaded.

The native plugin now declares AppCompat explicitly, fixing its first actual
Java compilation failure. Bridge logging is disabled even for debug builds,
because Capacitor debug logs can include access-token results. A regression
check protects that configuration.

The ordinary debug APK builds with the workspace build:android script. It uses
the provisional app.tomverse.shell ID, a generated development signer and bundled
assets. Its verification copy is .tmp/native-01/tomverse-android-debug.apk
(SHA-256 e517314d5d38b43fa69e678d6a079038c03ec2cc743f3603478d09a8a18a73a6).
The packaged config was checked for loggingBehavior=none, no remote server URL
and no local test CA.

No physical phone was connected. The dedicated Android 16/API 36 emulator
installed and launched the APK. A separate debug fixture APK, built using an
external Gradle init file, trusted a short-lived local CA for the isolated test.
Neither that trust override nor its private key is part of the ordinary APK or
tracked source. All test HTTPS tunnels terminated locally; other TLS hosts and
paid Chat/voice executions were refused.

The browser form and mail delivery were synthetic. Verification reused the
existing email-code verifier, PKCE grant service, exchange/refresh/logout route
handlers, live session checks and authenticated conversation-list handler
against an isolated PostgreSQL database. Observed results:

- System Chrome opened from the installed app; the code verifier accepted the
  synthetic code and a user-clicked HTTPS callback returned to the app.
- Native grant exchange returned 200, followed by bearer conversation-list 200.
- The native preference held only an AES-GCM IV and ciphertext. Credential-shaped
  plugin result log count was zero; no raw credentials were exported in evidence.
- After force-stop and relaunch, native refresh returned 200 and authenticated
  conversation-list read returned 200 again.
- Logout returned 204 and cleared the native sealed session record.

The database receipt showed two refresh-rotation records and a family revoked
for logout. Android Gradle unit tasks passed. Mobile logging/CI admission
regressions passed 55 cases; the final logging guard passed all eight cases.
Mobile TypeScript and scoped lint passed. APK Signature Scheme v2 verified.

The emulator's domain state was manually approved for this callback test after
its unverified state was recorded. This is not domain-ownership verification,
production AASA/assetlinks publication, real mail receipt or Google/Apple SSO
evidence. The full Next sign-in page was not used in the final fixture.
Playwright WebView attachment disrupted native callback completion on this
image; app actions and screenshots used ADB without attaching that debugger.

## Installed APK login correction (2026-10-20)

The owner reported that Continue with Tomverse opened a 404 page. A read-only
production check confirmed GET /auth/mobile returned 404; GET on the existing
exchange route returned 405. The earlier successful auth test used a local
fixture and did not establish production login readiness. The installed APK
therefore could not complete its advertised production sign-in.

Continue now opens the app-owned email form. Missing/disabled server support
shows a specific error inside the app, with no automatic browser navigation.
The new route is behind the unchanged default-off native enrollment switch.
It accepts only existing-account OTP proof, checks active account state before
issuing a session, and delegates mail/abuse checks to the existing request handler.
The native layer stores issued rotating credentials; the form receives no tokens.
An uncertain verify result is not retried automatically and requires a new code.

Verification: 12 new server route tests, 14 bridge/origin tests and all 16 browser
UI scenarios passed. The actual installed Android emulator also completed app
email entry, synthetic mail request, invalid-code refusal, real existing-code
verification/session issuance, bearer list read and force-stop/relaunch refresh.
No browser or callback link was needed for that native email flow. Only mail
delivery was synthetic; the verifier, route, DB, native bridge and secure store
were real. This remains local-fixture evidence, not production login evidence.
Logout returned 204. A separate local plain-HTML 404 test through the actual
native plugin showed the Korean unavailable-service message inside the app.
Credential-shaped bridge log count remained zero. Root/mobile type checks,
scoped lint and diff checks passed. The ordinary APK was reinstalled after the
fixture tests; the emulator, fixture servers, local DB and Gradle daemon stopped.

The updated ordinary APK is .tmp/native-01/tomverse-android-email-debug.apk
(SHA-256 064b37b21ad7235486808dadef63f0e72e30aa608f4f3eae2257782d93ce6076).
It supersedes the earlier APK for the login UI fix. It contains no fixture CA.
Installing it alone does not enable production login: server deployment and
native route activation still require their separate owner approvals.
