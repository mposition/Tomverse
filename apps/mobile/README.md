# Tomverse native app MVP

Locally bundled Vite + React + Capacitor application. It uses the existing
mobile session service and Chat persistence, streaming, attachments and voice
APIs. Production builds contain no demo transport and no remote `server.url`.

## C21 implementation (2026-10-21)

Web and native answers now share `@tomverse/chat-ui` (the existing GFM/CJK
Markdown behavior), and file responses share `@tomverse/api-client`. Native
answers display sources and generated-file cards from the canonical message
readback. Ready files use the existing authenticated artifact endpoint, with
ownership, lock and size checks unchanged. Android's document picker and iOS's
document export picker require an explicit Save action; neither accepts a
filesystem path from JavaScript. Browser tests exercise the browser fallback.

Unsent text drafts are scoped by authenticated account and conversation on the
device, expire after one day and clear on sign-out/session loss. Model selection
preserves the pending draft. No offline message is dispatched automatically.

Account export and deletion have in-app confirmation and reauthentication UI.
They reuse the existing single-use export ticket and deletion scheduler. Native
sensitive actions additionally require `TOMVERSE_NATIVE_ACCOUNT_ENABLED=true`
(default off) beside the existing native Chat enrollment. Step-up freshness is
the token family's original sign-in time; rotating a token cannot renew it.
Unknown deletion outcomes are not automatically retried. This implementation
does not enable the switch, send mail or delete any real account.

The web PWA has an install manifest, explicit install action, and a public-only
offline shell. Its service worker never caches account/API responses or generated
files. A draft entered offline remains bound to the tab and account until the user
chooses Restore offline draft in the normal Chat composer. Sign-out and account
changes clear it before another identity can recover it. Run `npm run test:pwa` for the browser
contract. Shared-package verification executes the actual React Markdown bundle
in Chromium as well as checking standalone TypeScript and emitted tokens.

Android compilation and browser contracts are local evidence. Physical phones,
iOS compilation/signing, domain associations, live activation and store release
remain separate steps.

The file saver was also exercised in a fresh Android emulator with networking
disabled: path refusal, user cancellation, concurrent-save refusal and saving
the exact 29-byte synthetic fixture through the system picker all passed.

## Store billing

Native store subscriptions, plan changes, cancellation, restoration and credit
packs are available behind default-off billing switches. See
[store billing setup](../../docs/ops/mobile-store-billing.md) for configuration,
verification and activation requirements. Store credit purchases do not expire.

## Local development

Automatic current-location intent analysis additionally requires the server-side
`TOMVERSE_CHAT_LOCATION_INTENT_ENABLED=true` switch (default off) and a configured
Auto routing model. Enabling it permits one bounded routing-model call per
eligible question, including manual models and verified guests, within the
existing provider operational budget. Manual location and reuse of an already
enabled location session do not need this extra call. Activation is a separate
operator action; this change does not enable the switch.

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

## Prepare an iOS build on Windows

Run `npm run prepare:ios` from the repository root to type-check and build the
production bundle, sync only iOS and validate its resources, local SPM paths,
permissions, privacy declarations and plugin registrations. Run
`npm run build:ios -- --dry-run` to inspect the unsigned Xcode command without
executing it. `npm --workspace @tomverse/mobile run test:ui:ios` runs the existing
synthetic UI scenarios in desktop WebKit; native permissions still need a device.

On a Mac, `npm run build:ios` builds an unsigned Simulator application with
Xcode 26+. It does not sign, upload, enroll a service or submit to a store.
See [remote iOS build handoff](../../docs/ops/ios-remote-build.md) for clean-machine
setup, output paths, validation evidence and the remaining Mac/device checks.

The repository-root `codemagic.yaml` also provides a manual, unsigned Simulator
build on a hosted Mac mini M2. See [Codemagic setup](../../docs/ops/ios-codemagic.md)
for connecting the personal account, selecting the prepared branch and reading
the artifacts. Apple membership is needed later for TestFlight device distribution.

## Android and iOS design parity (2026-10-27)

The Android design revision `bf48eaf2c` now supplies the same shared React
screens, styles, artwork and seven-language copy to iOS. This includes the
illustrated Chat/Review starts, centered brand, conversation return navigation,
message tools, provider/model lists, all six settings tabs and server-verified
purchase confirmation. Location controls stay in Tools; the composer has no
extra location status row. iOS native configuration remains separate.

From the repository root in local PowerShell, without production credentials:

- `npm --workspace @tomverse/mobile run test:ui:ios` checks shared UI in WebKit.
- `npm --workspace @tomverse/mobile run test:ui:ios-design` checks light/dark
  layouts on iPhone and iPad 7 portrait/landscape WebKit profiles, including
  navigation, model selectors, tools, all settings tabs and overflow.
- `npm run test:ios-billing-ui` checks the Apple billing UI with synthetic
  native bridges and server responses. No purchase is made.
- `npm run prepare:ios` rebuilds and synchronizes the local iOS resources.

WebKit previews establish browser layout compatibility. Xcode compilation,
signed-device permissions, StoreKit purchases and store submission still need
their Mac/device acceptance steps.

## Authentication and operational boundary

The primary sign-in action opens the existing web sign-in flow in the system
browser and returns to the installed app through the native PKCE session.
It uses the same sign-in options as the website. The welcome screen also offers
an explicit email-code option inside the app. The email form's alternate sign-in
action uses the same native browser flow; it does not open a standalone website
login that cannot return a session to the app. Cancelled, expired and unavailable
browser sign-ins retain the email-code option and show an appropriate message.

After web authentication, the completion page automatically requests one
short-lived PKCE grant and navigates to the HTTPS callback. There is no extra
confirmation or Open app button. Android uses AndroidX Auth Tab, which closes the
authentication window and delivers the verified HTTPS result to the native
plugin. It selects an Auth Tab-capable default browser, then installed Chrome;
if neither supports Auth Tab, sign-in reports unavailable. iOS retains its
ASWebAuthenticationSession callback and automatic dismissal. The native layer
resolves sign-in only after exchanging and storing the session. Domain
association verification and physical-device verification remain required.
An expired or signed-out Android attempt retains its ActivityResult slot until
the old authentication window returns. Close that window before retrying; its
late cancellation or redirect cannot consume a newer attempt's PKCE proof.

The email option signs existing accounts in using a six-digit code entered
inside the app. The native plugin calls the exact
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

The `app.tomverse.shell` Apple App ID and a Tomverse App Store Connect draft
were registered on 2026-10-26. Signing certificates/profiles and payment activation
remain operational setup. No association files are published or fabricated. The native declarations are
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

## Production support diagnosis and review follow-up

The owner's second test still could not request a code. Read-only production
GET /api/auth/mobile/email returned NextAuth's plain-text HTTP 400 unsupported
action response. A malformed-body POST, containing no email or code, returned
403 INVALID_REQUEST_ORIGIN before a handler could send mail. This is a missing
server integration, not evidence that the owner's mailbox rejected a message.
No real email was sent by the diagnostic probes.

The native email request now requires a positive, read-only capability response
before submitting any email. Unsupported routes (including the actual NextAuth
400 behavior) cannot be mistaken for a delivered code. Request, delivery and
verification errors have distinct copy, and the existing browser sign-in is
reachable as a secondary action.

Independent review r-20261020-103844-3e4c80 rejected the first email-route diff:
the token-bearing POST must refuse every browser Origin, including the
Capacitor origins, because only native HTTP clients should consume its result.
The route now enforces that rule before processing proof or sending mail.
The follow-up also removes stale delegated content-length/cookies, preserves
specific service error codes, and conditionally reactivates expired suspensions
with a re-read, following web sign-in behavior. Local checks passed 19 route,
14 bridge/origin and five login UI scenarios. A new independent review covers
the corrected authentication boundary; no live endpoint was enabled by this work.

Do not hand a local validation APK over as a production-login fix. Real-account
testing requires separately approved publication/deployment and server enrollment,
followed by a supported capability response from the actual target server.

## Foreground location

The current Chat and Review composers offer a Current location switch in Tools.
Native first launch offers an optional foreground-location explanation before
the system permission request; skipping it leaves ordinary chat available.
Explicit choices are saved per account, without coordinates. A saved grant is
restored only after checking existing device permission, without another OS
prompt. Switching accounts or signing out clears the in-memory fix.

When location is off, the existing, separately gated routing-model analysis can
identify a location-dependent question and request foreground permission before
answering. Manual off, denial and acquisition failures suppress automatic
requests for the current identity session. Each enabled message reads a fresh
approximate fix; location is excluded from stored messages and drafts. Ordinary
chat remains available on analysis or acquisition failure. This UI update does
not enable the analysis switch, a new provider, price or budget ceiling.

The existing native chat enrollment, browser login, secure store and product navigation are unchanged. Run the workspace cap:sync script after dependency changes; its post-sync hook configures foreground coarse Android location and reduced-accuracy iOS usage descriptions. Physical-device permission and GPS observations remain separate from browser fixtures.
