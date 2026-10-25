# Native Tomverse shell

A locally bundled Vite + Capacitor app. The default build still shows the
readiness diagnostics. Native text chat is an explicitly enabled local build.
There is no remote `server.url` or browser session fallback.

## Implemented chat

- Connect an account using the system browser and a client-bound, 60-second
  one-time code. Compare the request ID in the app with the browser page and
  explicitly confirm the match before creating the code. The app creates its PKCE proof natively; only the public
  challenge enters the browser URL. Code creation requires an explicit click
  on the authenticated `/mobile/connect` page, after the ordinary web login
  (Google, Microsoft or email). With verified auth links configured, choose
  **Return to Tomverse app** to complete sign-in without pasting a code.
  Manual code entry remains available when the link cannot open the app.
- Native Swift/Java `MobileAuth` exchanges and rotates credentials directly
  over HTTPS, with redirects disabled and no cookies. Keychain on iOS and
  Android Keystore AES-GCM protect the stored session. Only short-lived access
  tokens and expiry cross the bridge. Validation and secure-store read errors
  preserve existing sessions. The UI checks/restores a session before showing
  pairing controls, and a failed identity read offers a safe retry. Browser fallback always refuses auth.
- Native mutation calls are serialized. Local single-use state is consumed
  before rotation; a timeout or unknown outcome signs out instead of replaying
  an exchange or rotation. Sign-out removes local state before remote logout.
- `GET /api/mobile/chat` reads the verified account identity. `POST` uses the
  existing chat execution, model access, moderation, budget, credit and stream
  handling. Both independently verify the bearer and session revocation. There
  is no cookie fallback. Only this exact endpoint is enrolled when enabled.
- Text conversation and the opt-in location session live in memory. New chat,
  sign-out or reload clears them. This first native screen has no persisted
  conversation sync, attachments, generated files or model picker. Native and
  web use the same `@tomverse/chat-core` stream consumer and completion parser;
  length-limited answers remain visible and are labeled incomplete.
- Current location defaults off. Enabling requests approximate foreground
  access. Each send acquires a fresh fix, coarsens it and sends `currentLocation`
  only while consent and account identity still match, rechecking after native
  token acquisition and before any 401 retry. Denial/timeout continues
  without location. Permission decisions do not consume the acquisition timeout;
  Stop cancels the caller’s pending read immediately. There is no background watch, saved fix or JS credential
  storage. Web search is separately opt-in for live weather/place facts.

## Enablement is separate from implementation

All three switches are off unless explicitly set:

| Setting | Boundary |
|---|---|
| `MOBILE_CHAT_ENABLED=true` on the API server | Exact native bearer gateway and browser pairing page |
| `VITE_NATIVE_CHAT_ENABLED=true` during Vite build | Native chat UI instead of readiness diagnostics |
| `NATIVE_CHAT_ENABLED=true` during Capacitor sync | Native auth plugin permission |

`VITE_TOMVERSE_API_ORIGIN` must be one trusted HTTPS origin; it configures both
Vite transport and native auth. Rebuild and sync together when changing it.
The app uses native code, not JavaScript, for credential exchange/rotation.
These switches have not been set on a deployed service by this change.

## System-browser sign-in return

The browser uses the existing `/auth/signin` page and cookie session. The app
receives only a 60-second, single-use grant in the fragment of the exact HTTPS
`/mobile/auth/callback` link, bound to its in-memory PKCE request. It refuses
other origins, paths, query credentials, unrelated requests and duplicate
callbacks. The verifier and rotating session stay native. An app restart
requires a new connection request; a cold-start link cannot resume lost proof.
If link verification fails, the standalone fallback clears the fragment from
browser history, loads no analytics/resources and offers manual code entry.

App returns stay off by default. Configure these together when preparing a
signed build and its matching API deployment:

| Location | Setting |
|---|---|
| API server | `MOBILE_AUTH_APP_LINKS_ENABLED=true` |
| API server | `MOBILE_AUTH_APP_LINK_ORIGIN`: a dedicated HTTPS return origin on this deployment, different from all web login hosts |
| API server, Android | `MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS`: comma-separated SHA-256 fingerprints of the installed app's signing certificates (Play App Signing certificate for Play builds) |
| API server, iOS | `MOBILE_AUTH_IOS_APP_ID`: the actual App ID prefix plus `.app.tomverse.shell` |
| Vite build | `VITE_MOBILE_AUTH_APP_LINKS_ENABLED=true` |
| Vite build and Capacitor sync | `VITE_MOBILE_AUTH_APP_LINK_ORIGIN`: the same dedicated return origin |
| Capacitor sync | `NATIVE_AUTH_APP_LINKS_ENABLED=true` |

Use the same `VITE_TOMVERSE_API_ORIGIN` for build and sync. The sync hook adds
an Android auto-verified intent filter for only the callback path and configures
iOS Associated Domains in the app's entitlements/build settings. Existing
capabilities are preserved; disabling the sync switch removes only managed
entries. Enable Associated Domains for the iOS App ID and signing profile too.
When other capabilities have since been added to a generated entitlements file,
disabling keeps that file's signing reference so those capabilities stay intact.
Attach the return hostname to this API deployment and explicitly add it to
`ALLOWED_REQUEST_HOSTS`, retaining the existing Cloudflare origin-secret gate.
Serve the two association paths and callback over HTTPS with no redirect.
The return host serves only those three read-only paths; chat, sign-in and API
routes are refused on that host. Build and sync fail if the explicit return
origin is missing. iOS [keeps same-host browser links in Safari](https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links),
so configured login/share aliases and production login hosts cannot be used
as the dedicated return origin.
The API publishes `/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association` only with valid, configured signing
identities. No placeholder signing identity is published.

Physical Android/iOS verification of the signed app's association and
browser-to-app return remains required. Local tests mock OS link delivery;
they do not establish that a release certificate or Apple provisioning profile
has been configured. No production setting or signing identity is changed by
the implementation.

## Local checks

Run on the local PC, PowerShell, from the repository root. These checks write
local build/test artifacts and require no production credentials or paid calls.

```powershell
npm --workspace @tomverse/chat-core run typecheck
npm --workspace @tomverse/mobile run typecheck
npm run check:shared-packages
npm run check:native-token-boundary
npm run check:capacitor-local-bundle
npm run build:mobile-shell
npx playwright test --config playwright.native.config.ts
```

The native screen tests use mocked native plugins and a mocked API. They test
pairing, session-restoration races, per-message location, denial, stop,
sign-out, incomplete answers, narrow screens and enlarged text. The Android
plugin also has JVM tests executing its real validation and rotation control
flow with isolated secure-store and HTTP ports. They are not physical-device evidence. Android debug compilation is
possible with JDK 21 and Android SDK 36. iOS compilation requires macOS/Xcode.

## Native projects

Generated `apps/mobile/android` and `apps/mobile/ios` stay uncommitted. Auth
plugin sources live in `native-auth`, while `cap:sync` also configures foreground
location permissions idempotently. Android requests coarse location only; iOS
includes the Geolocation plugin's two required usage descriptions and reduced
accuracy by default, without requesting background or always authorization.
The installed Geolocation 8.2.4 manifest declares no permissions; the generated
Android merged manifest was checked to contain only coarse location.

```powershell
npm --workspace @tomverse/mobile exec cap add android
npm --workspace @tomverse/mobile exec cap add ios # macOS/Xcode
npm --workspace @tomverse/mobile run cap:sync
```

The Android release application ID is `app.tomverse.shell`, confirmed by the
owner on 2026-10-25. Keep the generated Android project and Google Play
registration aligned with this ID. Manual code pairing needs no association
files; browser-to-app return uses the verified links described above.

Release signing, iOS build, device secure-store checks,
permission prompts and foreground keyboard behavior remain device/release
validation. No merge, deployment or live activation is implied by local checks.
