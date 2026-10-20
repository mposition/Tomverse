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

The native plugin opens system-browser sign-in with S256 PKCE. The existing
email/Google/Apple web sign-in is reused and issues a single-use login grant.
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
Focused bearer/transport checks passed 36 cases; existing server and web product
regressions passed 85 and 28 cases. Broader mobile/session regressions passed
268 cases before the final recovery/error-copy additions. No product provider
was called.

The full Next webpack build remains blocked by the existing Admin import chain
from decisionMakerBodyCore (node:crypto) into AmuxDecisionMakerRequestsPanel.
Those Admin files are unchanged in this implementation.

Android assembly was attempted but this PC has no Java/Android SDK. iOS cannot
be built on this Windows PC. Native plugin sources, platform projects and
browser tests are not proof of native compilation, OS secure-store behavior,
verified links or device restoration. These checks and operational enrollment
remain open; this is not a released MVP.
