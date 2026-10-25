# Native Tomverse shell

A locally bundled Vite + Capacitor app. The default build still shows the
readiness diagnostics. Native text chat is an explicitly enabled local build.
There is no remote `server.url` or browser session fallback.

## Implemented chat

- Connect an account using the system browser and a client-bound, 60-second
  one-time code. Compare the request ID in the app with the browser page and
  explicitly confirm the match before creating the code. The app creates its PKCE proof natively; only the public
  challenge enters the browser URL. Code creation requires an explicit click
  on the authenticated `/mobile/connect` page. Paste the code back into the app.
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
registration aligned with this ID. The manual pairing path needs no
universal-link association files.

Release signing, iOS build, device secure-store checks,
permission prompts and foreground keyboard behavior remain device/release
validation. No merge, deployment or live activation is implied by local checks.
