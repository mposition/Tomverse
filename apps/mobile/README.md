# Native Tomverse shell

A locally bundled Vite + Capacitor app. The default build still shows the
readiness diagnostics. Native text chat is an explicitly enabled local build.
There is no remote `server.url` or browser session fallback.

## Implemented chat

- Connect an account using the system browser and a client-bound, 60-second
  one-time code. The app creates its PKCE proof natively; only the public
  challenge enters the browser URL. Code creation requires an explicit click
  on the authenticated `/mobile/connect` page. Paste the code back into the app.
- Native Swift/Java `MobileAuth` exchanges and rotates credentials directly
  over HTTPS, with redirects disabled and no cookies. Keychain on iOS and
  Android Keystore AES-GCM protect the stored session. Only short-lived access
  tokens and expiry cross the bridge. Browser fallback always refuses auth.
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
  web use the same `@tomverse/chat-core` stream consumer.
- Current location defaults off. Enabling requests approximate foreground
  access. Each send acquires a fresh fix, coarsens it and sends `currentLocation`
  only while consent and account identity still match. Denial/timeout continues
  without location. There is no background watch, saved fix or JS credential
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
pairing, per-message location, denial, stop, sign-out, narrow screens and enlarged
text. They are not physical-device evidence. Android debug compilation is
possible with JDK 21 and Android SDK 36. iOS compilation requires macOS/Xcode.

## Native projects

Generated `apps/mobile/android` and `apps/mobile/ios` stay uncommitted. Auth
plugin sources live in `native-auth`, while `cap:sync` also configures foreground
location permissions idempotently. Android requests coarse location only; iOS
includes the Geolocation plugin's two required usage descriptions without
requesting background or always authorization.

```powershell
npm --workspace @tomverse/mobile exec cap add android
npm --workspace @tomverse/mobile exec cap add ios # macOS/Xcode
npm --workspace @tomverse/mobile run cap:sync
```

`app.tomverse.shell` remains the provisional spike identifier. This manual
pairing path needs no universal-link association or production signing change.
Release signing, final application IDs, iOS build, device secure-store checks,
permission prompts and foreground keyboard behavior remain device/release
validation. No merge, deployment or live activation is implied by local checks.
