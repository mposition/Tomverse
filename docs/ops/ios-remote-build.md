# Remote iOS build handoff

Prepared on 2026-10-26 from origin/main
`208b9e68924fe8be2a4ee656fe17f131728e2218`. This is preparation for the first
Xcode build. Swift compilation, Simulator execution and physical-device acceptance
have not been performed on Windows.

For the selected Codemagic personal-account path, see
[the Codemagic setup](ios-codemagic.md). Its manual `ios-simulator` workflow runs
the unsigned build below on a hosted Mac after the prepared branch is connected.

## What is ready

- The existing React/Vite app, Swift session/file plugins, RevenueCat, browser
  and foreground geolocation plugins are retained from main.
- iOS 17.4+ and the current development Bundle ID `app.tomverse.shell` are retained.
  The development ID is sufficient for the first unsigned Simulator build.
- The shared `App` scheme allows a headless Mac to select the real App target.
- App and local Swift-package privacy manifests declare the existing app-only
  UserDefaults usage with reason `CA92.1`. The Xcode Resources phase, SPM resource
  and CocoaPods resource bundle include their manifests. No new data collection
  or runtime permission is enabled by these declarations.
- Preparation verifies the locally copied production bundle, SPM dependency paths,
  required purpose strings, reduced-accuracy location, disabled bridge logging
  and registration of MobileAuth, MobileFiles, Purchases, Browser and Geolocation.
- A cross-platform build wrapper generates an unsigned Simulator command by
  default. It rejects execution outside macOS and checks Xcode 26+ before building.

The current main behavior is authoritative: optional device authentication gates
fresh sign-in. A valid stored session does not relock on every app restart or
background return. This preparation does not restore the older relocking design.

## Windows preparation

Machine: local Windows PC. Shell: PowerShell. Directory: repository root.
Prerequisites: Node 22.x, npm and repository dependencies. No production credentials
are required. These commands install dependencies or write local generated files;
they do not send email, call paid providers, change server flags or publish code.

```powershell
npm ci
npm run prepare:ios
npm run test:ios-prebuild
npm run build:ios -- --dry-run
```

`npm ci` runs the existing Prisma client generator. It needs no database connection
or migrations. If dependencies were installed using `--ignore-scripts`, run the
existing `npm run postinstall` before server-adjacent transport tests.

Optional synthetic browser checks, from the same directory and shell:

```powershell
npm --workspace @tomverse/mobile run test:ui
npm --workspace @tomverse/mobile run test:ui:ios
```

If the relevant Playwright browser is absent, `npx playwright install chromium webkit`
downloads the local test browsers. Desktop WebKit does not establish actual iOS
WKWebView, Face ID, permissions, GPS or audio-device behavior. Ten existing
microphone/voice/GPS scenarios depend on Chromium fake-device capabilities or
APIs absent in Windows WebKit. They remain covered by the Chromium suite and
are excluded from this desktop WebKit configuration. Native acceptance remains
in the Mac/iPhone list below. The other UI scenarios also run in WebKit.

## Clean remote Mac setup

Machine: the selected remote Mac. Shell: zsh. Directory: the extracted source or
checkout root containing package.json. Prerequisites: Node 22.x, Xcode 26+ selected
as the active developer directory, the Xcode license/first-launch setup completed
and an installed iOS Simulator SDK. A cloud build account is not configured by
these scripts. No Apple signing identity or production credentials are needed for
the first unsigned build. Dependencies and SPM sources are downloaded; generated
files and build products are written only to this checkout.

Use the prepared source revision, not an arbitrary moving branch. A source ZIP
contains tracked source only; install dependencies and regenerate the platform
bundle after extraction. Never copy Windows node_modules to macOS: native packages
and resolved plugin paths are host-specific.

From that repository root:

```zsh
node --version
xcodebuild -version
xcrun --sdk iphonesimulator --show-sdk-version
npm ci
npm run prepare:ios
npm run build:ios -- --dry-run
```

This is the stopping point before the actual remote build requested by the owner.
The next command, when remote build execution is authorized, is:

```zsh
npm run build:ios
```

The wrapper selects `App.xcodeproj`, shared scheme `App`, Debug configuration and
`generic/platform=iOS Simulator`. Signing is disabled. The resulting application
is expected at:

```text
.tmp/ios-build/Debug-simulator/Build/Products/Debug-iphonesimulator/App.app
```

This is an application for Simulator, not a signed IPA for a physical iPhone or
TestFlight. The script performs no install, launch, upload or App Store action.

An optional unsigned compile against the physical-device SDK uses:

```zsh
npm run build:ios -- --device --release
```

Its output directory is `.tmp/ios-build/Release-device`. It also disables signing
and does not produce an installable distribution IPA. Build failure propagates as
a failed command; a dry run is explicitly reported as not executed.

## Checks that need the Mac or iPhone

1. Resolve the actual Swift dependency graph and compile the Swift/Apple SDK code.
2. Launch in Simulator and verify the native plugin bridge.
3. On a signed iPhone build, verify Keychain refresh/logout and fresh-sign-in
   Face ID/Touch ID/passcode cancellation and race handling.
4. Verify email sign-in; for browser-based sign-in, verify the exact HTTPS callback
   and real `applinks`/`webcredentials` domain association.
5. Verify streaming/stop/recovery, keyboard/IME/safe area, selected-file upload,
   generated-file export, microphone capture, audio interruptions and approximate
   foreground location permissions.
6. Test existing store billing only in the approved sandbox/configuration. This
   preparation does not activate billing or perform a purchase.

Physical-device signing later needs the actual Apple Team, final Bundle ID and
provisioning/capabilities. Domain association publication, production changes,
TestFlight upload and store submission are separate actions. No placeholder Team
ID, signing credential or domain-association document is fabricated here.

## Validation record

The implementation includes `tests/iosPrebuild.test.mjs`: missing resource inclusion,
stale copied assets, missing plugin registration, broken SPM paths and a wrong
shared target are rejected before a Mac build. The wrapper tests verify a dry run,
Windows refusal, the Xcode version gate and propagation of a failed Xcode command.
These are fixture tests, not executed Xcode builds.

Local execution results are recorded with the handoff artifacts. The standard
production Vite build can emit existing shared `use client` directive and bundle
size warnings; they do not represent Swift compilation evidence.

Windows verification on 2026-10-26:

| Check | Result |
|---|---|
| Mobile TypeScript, production Vite build, local-bundle/token checks and iOS sync | Passed |
| iOS preparation/build-wrapper fixture tests | 12 passed |
| Existing mobile transport, history, session, location and billing unit tests | 104 passed |
| Existing Chromium mobile UI suite | 99 passed |
| Desktop WebKit compatibility selection | 89 passed; 10 media/GPS-dependent cases excluded as described above |
| Shared-package purity, scoped ESLint and whitespace checks | Passed |
| Xcode build, signing, native execution, TestFlight/store submission | Not run |

## References

- [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Capacitor Swift Package Manager](https://capacitorjs.com/docs/ios/spm)
- [Capacitor privacy manifests](https://capacitorjs.com/docs/ios/privacy-manifest)
- [Apple required-reason API declarations](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)
