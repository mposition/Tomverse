# Codemagic: first unsigned iOS build

Prepared on 2026-10-26 for the owner's personal Codemagic account. The Apple
Developer Program is not required for this Simulator compile. The workflow has
been checked locally; the first hosted build is recorded below.

## Repository and workflow

The repository-root `codemagic.yaml` defines `ios-simulator` (display name
`Tomverse iOS Simulator`). It uses a Mac mini M2, Node 22.22.2 and Xcode 26.6,
with a 45-minute timeout. It installs locked dependencies, generates and checks
the iOS bundle, runs the preparation and billing-boundary tests, compiles without signing and packages
the Simulator application. There are no automatic triggers or publishing steps.

Repository: `https://github.com/mposition/Tomverse`.
Prepared branch: `codex/to-develop/ios-android-design-parity`, including the
2026-10-27 Android design. The original iOS preparation and PR #3044 were merged
before this branch was created. Its initial main revision and develop rebase
are recorded in [the remote-build handoff](ios-remote-build.md). The branch is
pushed and can be built directly; a merge to main or develop is not needed.

## Connect from Windows

Machine: local Windows PC. Interface: Codemagic and GitHub web dashboards; no
terminal directory is needed. Prerequisites: the personal Codemagic account and
GitHub access to this repository. Connecting grants Codemagic repository access;
it requires no production service secrets or Apple signing credentials.

1. In Codemagic **Applications**, choose **Add application**, then **GitHub**.
2. Complete the GitHub authorization and app installation when prompted. Select
   **Only select repositories** and `mposition/Tomverse` rather than granting
   access to every repository. Complete this account authorization yourself.
3. Select `mposition/Tomverse` and the YAML-based project setup. If a project-type
   selector is shown, use **Other** for this repository's custom Capacitor build.
   Finish adding the application to your personal account.
4. After the prepared branch is available on GitHub, choose **Start new build**,
   select branch `codex/to-develop/ios-android-design-parity` and workflow
   `ios-simulator` / **Tomverse iOS Simulator**.
5. Confirm the personal account's remaining free M2 minutes before starting the
   build. The published personal plan includes 500 M2 minutes per month; the
   account dashboard is authoritative for the remaining balance. This preparation
   does not enable billing. Then start the build manually when ready.

The config is at the repository root, not `apps/mobile`. Do not select an Android
or Flutter workflow, add Apple credentials or copy server `.env` files for this
first compile. If no workflow appears, verify the selected remote branch contains
`codemagic.yaml`; selecting main will not find these unmerged changes.

## Read the result

| Artifact | Meaning |
|---|---|
| `prebuild.json` | Resource, plugin and copied-bundle checks before compilation |
| `xcodebuild.log` | Native build output, including errors if compilation fails |
| `tomverse-ios-simulator.zip` | Unsigned Simulator `App.app`, produced only after a successful build |

Artifacts are collected from `.tmp/codemagic`. A successful build establishes
Swift/SDK compilation on that Mac image. It does not launch the app or verify
native sign-in, microphone, purchases or physical-device behavior. See the
remaining acceptance checks in [the handoff](ios-remote-build.md).

The Simulator ZIP cannot be installed on a physical iPad or iPhone. For iPad
testing through TestFlight, the next stage needs an active Apple Developer
Program membership, a final Bundle ID and App Store Connect app, and signing/API
access configured inside Codemagic. The existing target supports iPhone and iPad
on iOS/iPadOS 17.4+. Signed builds and TestFlight upload are a separate workflow;
this file does not configure or perform them.

## First hosted build (2026-10-27)

The owner authorized the first cloud build. Personal-account usage was 0/500
free macOS minutes before starting; no paid subscription was enabled.

Build #1 at `23ec58bad` reached Xcode and failed because Swift inferred the
native file bridge's methods as `[CAPPluginMethod?]`, which does not satisfy
`CAPBridgedPlugin`. Commit `e3e7530bd` explicitly declares `[CAPPluginMethod]`,
matching the existing authentication bridge and Capacitor's protocol. File
validation, upload restrictions and document-picker behavior are unchanged.

[Build #2](https://codemagic.io/app/6adf504aa37cedc4dfe11471/build/6ae07b76206ce93970c66b94)
compiled commit `e3e7530bd9ab745858770ccfeb982c8e26e98359` successfully in
3m 32s on Mac mini M2 with Xcode 26.6. The production bundle preparation,
prebuild/billing tests, native compile and artifact packaging all completed.
The downloaded Xcode log contains `BUILD SUCCEEDED`.

The actual downloaded `tomverse-ios-simulator.zip` was inspected:

- Size: 19,271,534 bytes.
- SHA-256: `ebba05de7ede048a04172af3b469fe0cee8bb058b3c0fe7b4cf9e2a17eb5a42e`.
- Bundle ID `app.tomverse.shell`; minimum OS 17.4; device families iPhone/iPad.
- Simulator platform with both arm64 and x86_64 executable architectures.
- All four new Chat/Review light/dark illustrations are bundled.

This establishes native compilation and package contents. Simulator launch,
signed-device installation, permission dialogs, authentication and StoreKit
acceptance remain separate checks. No app-store upload or deployment occurred.

The Apple App ID `app.tomverse.shell` and [Tomverse App Store Connect draft](https://appstoreconnect.apple.com/apps/6827148073/distribution)
were registered on 2026-10-26. Seven payment products have draft records as noted
in the billing runbook. On 2026-10-27 (AEST), the Paid Apps Agreement and required
banking/tax records were confirmed Active. RevenueCat Apple app `appaefd8126bd`
has a validated In-App Purchase key and seven manually linked products. English
(U.S.) product names/descriptions are saved, and both Apple server notification
URLs point to the RevenueCat app. Pricing, availability, isolated sandbox
configuration, notification delivery and signed-device acceptance still need
completion before purchases are operational. The Apple purchase key is
stored outside this checkout; it is not a Codemagic signing credential. The
public Apple SDK key has been obtained, but the workflow does not yet inject it
or enable the billing build flag.

## Local verification

Machine: local Windows PC. Shell: PowerShell. Directory: repository root.
Prerequisites: Node 22 and installed repository dependencies. No production
credentials are required; these checks do not run a cloud build.

```powershell
npm run test:codemagic
npm run test:ios-prebuild
npm run test:mobile-billing
npm run test:ios-billing-ui
npm run build:ios -- --dry-run
```

The workflow tests check YAML parsing, preparation order, signing/trigger
exclusion, failed-build propagation through `tee`, and explicit artifact paths.
The embedded Bash steps have also passed a local syntax check. These checks do
not substitute for the first Xcode build.

The App target includes the In-App Purchase capability and the Purchases SDK.
Its Apple-specific purchase/restore flows have synthetic browser coverage, while
the build's billing UI stays behind the existing build flag and actual Apple SDK
key. See [native store billing](mobile-store-billing.md#ios-preparation-and-remaining-store-setup)
for account/product registration, server configuration and signed-device payment
acceptance. A successful unsigned compile does not complete those steps.

## Official references

- [Adding an app and limiting GitHub repository access](https://docs.codemagic.io/getting-started/adding-apps/)
- [Using YAML and manually selecting a branch/workflow](https://docs.codemagic.io/yaml-basic-configuration/yaml-getting-started/)
- [Personal-account free M2 minutes](https://docs.codemagic.io/billing/pricing/)
- [Xcode 26.6 build image](https://docs.codemagic.io/specs-macos/xcode-26-6/)
- [Unsigned iOS Simulator builds](https://docs.codemagic.io/yaml-code-signing/ios-simulator-builds/)
