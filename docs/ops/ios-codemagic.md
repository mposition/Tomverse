# Codemagic: Simulator and internal TestFlight builds

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
on iOS/iPadOS 17.4+. The separate manual `ios-testflight` workflow below creates
an internal-only signed IPA and uploads it to the existing App Store Connect app.

## Internal TestFlight workflow

The owner requested signed-device testing on 2026-10-27. `ios-testflight`
(display name `Tomverse iOS TestFlight Internal`) prepares and verifies the same
production bundle, assigns Codemagic's application-wide `PROJECT_BUILD_NUMBER`,
applies the specified App Store signing profile, and archives the Release IPA.
The first upload uses the existing marketing version 1.0 and bundle identifier
`app.tomverse.shell` (App Store Connect app `6827148073`).

Configure these names in the existing Codemagic personal account before running:

| Account setting | Required value |
|---|---|
| Apple Developer Portal API integration | `Tomverse Codemagic Signing` |
| Apple Distribution certificate reference | `tomverse-apple-distribution` |
| App Store profile reference for `app.tomverse.shell` | `tomverse-app-store` |

The registered App ID and provisioning profile must include Associated Domains
for the existing `applinks:tomverse.app` and `webcredentials:tomverse.app`
entitlements. Enable that capability before generating the App Store profile.

The signing API integration needs a dedicated App Store Connect key with App
Manager access. It is separate from the RevenueCat In-App Purchase key. Creating
the key, retaining its private file locally, sharing it with Codemagic, and
creating the signing certificate/profile require the owner's specific approval.
Private keys and profiles stay outside Git; the workflow imports the named
account identities and does not create new credentials during a build.

The owner approved this credential setup in chat on 2026-10-27. The dedicated
API integration, Apple Distribution certificate and App Store profile are now
configured under the references above. Key/certificate/profile recovery files
are retained outside Git. Independent review `r-20261027-105333-e11b71` accepted
the manual internal-only signing and upload boundary; its versioning and
Associated Domains setup notes were addressed before the signed run.

The export option `testFlightInternalTestingOnly=true` restricts the resulting
build to internal testing. Publishing uses the stored integration to upload the
IPA; `submit_to_testflight=false` avoids an external beta-review submission and
`submit_to_app_store=false` avoids a public release submission. No automatic
trigger or recipient notification is configured. Once Apple finishes processing,
add only the owner's existing App Store Connect user to an internal tester group
and assign this build. Open that invitation in TestFlight on the iPad.

`ITSAppUsesNonExemptEncryption=false` records the current use of Apple's
platform cryptography (URLSession TLS, Keychain and CryptoKit PKCE hashing).
The bundled app does not implement a separate encryption algorithm. Reassess
this declaration if the app or a bundled SDK adds non-exempt encryption.

For this first upload, the Apple dashboard had no existing TestFlight builds.
If builds are uploaded from another system later, keep the Codemagic project
number above the latest Apple build number before starting another upload.
The project enables Apple Generic versioning; the finished IPA is checked for
the expected bundle ID, CI build number, minimum OS, iPhone/iPad families and
device platform before publishing. Artifacts include only the IPA, preflight
receipt and Xcode logs. Signed-device
installation and actual location/login/purchase behavior require observations
on the iPad; a successful upload alone does not establish those results.

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

## First signed TestFlight delivery (2026-10-27)

[The first `ios-testflight` run](https://codemagic.io/app/6adf504aa37cedc4dfe11471/build/6ae08654206ce93970c66f78)
compiled commit `32677a04c29e2957680bb306b7c9f69d4bfe67b1` on Mac mini M2 with
Xcode 26.6 in 8m 32s. This is workflow run #1 and application-wide build #3.
The CI admission merge at that commit added unrelated Android domain-association
files; the iOS workflow and app sources match the verified signing changes.

The Release archive, signed IPA export and pre-upload metadata checks passed.
Apple upload reported `UPLOAD SUCCEEDED with no errors`. App Store Connect
processed version **1.0 (3)** as **Internal** and **Ready to Test**, then changed
to **Testing** after it was assigned to `Tomverse Internal`. That group contains
only the owner's existing Account Holder/Admin user, whose status is **Accepted**
(confirmed at 21:34 AEST).
Automatic distribution is off. No external beta review or public App Store
submission was performed.

The downloaded `App.ipa` was independently inspected:

- Size: 10,397,471 bytes.
- SHA-256: `6a8f299d1dc0e9206832fac81f24ae4473d068c0832ebe9710a380b4b9f08333`.
- Bundle ID `app.tomverse.shell`; version 1.0; build 3; minimum OS 17.4.
- Device platform `iPhoneOS`, arm64 executable, iPhone/iPad device families.
- Code signature resources and the correct embedded App Store profile present.
- Associated Domains allowed, debugging disabled, beta reporting enabled.
- All four new Chat/Review illustrations present; non-exempt encryption flag false.

The owner accepted the invitation and sees version 1.0 (3), but installation on
the iPad 7th generation fails with "The requested app is not available or doesn't
exist." Reopening TestFlight and retrying did not resolve it. Installation and
device acceptance are therefore **blocked**, despite the Testing label.

App Store Connect's Build Metadata independently shows Binary State Validated,
minimum iOS 17.4, arm64, iPhone/iPad families, the expected application identifier,
Associated Domains, debugging disabled and beta reporting enabled. The downloaded
executable uses ARM64_ALL, and its bundled frameworks require iOS 15.0. These
checks found no OS, architecture or signing mismatch with the reported iPadOS
18.7.10 device. Membership renews on 2027-10-27; the developer license is accepted;
Free/Paid Apps agreements and required banking/tax records are Active. Apple's
system-status page showed TestFlight available at 21:41 AEST.

The empty Beta App Description and Feedback Email fields were completed with
the internal test scope and the existing public support address. App Store
Connect confirmed Saved. This completes test metadata; it does not establish
that the installation error is resolved.

The exact installation cause remains unconfirmed. Similar errors are reported
on the [Apple Developer Forums](https://developer.apple.com/forums/thread/824745),
where Apple directs unresolved account cases to Developer Support. Do not treat
another developer's `BETA_CONTRACT_MISSING` report as a diagnosis for this app,
or change credentials, public availability or external-review settings to probe
it. Device launch, native sign-in, location consent and StoreKit results remain
unobserved. The billing activation/pricing work described below remains separate.

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

## Android 1.0.16 (17) parity (2026-10-28)

The delivered Android release identifies `4cc180126` as its native source.
All 70 tracked files under `apps/mobile/src` match the current iOS source from
develop `85aca533b`; their shared Git tree is
`d098f09df2e4a89ad3fdc6547f4af9b73e7483c4`. The continuation title context and
translations also match. These changes are already merged in main, but the
previously uploaded iOS 1.0 (3), built from `32677a04c`, predates them.

The refreshed iOS bundle includes original continuation titles in history,
search and accessible action names, and the shared read-only source endpoint
fix that prevents reopening an imported conversation from losing the session.
Marketing version is now 1.0.16; Codemagic assigns its own increasing build
number independently of Android's 17.

Android's one-time HTTPS Auth Tab verification retry is platform-specific.
iOS continues to use ASWebAuthenticationSession with the claimed HTTPS callback;
it does not accept failed verification or copy Android result codes. Android's
store-review credential exception remains Android-only. Ordinary iOS sign-in
and the existing Apple purchase activation requirements are unchanged.

Local validation passed 20 title/transport/continuation tests, 14 iOS preparation
tests, 7 Codemagic tests, 21 WebKit continuation/login tests and 6 responsive
design cases across iPhone and iPad 7th generation portrait/landscape. The
continuation case now leaves history and reopens the original again. Production
bundle preparation, iOS sync and the unsigned build dry run passed. These checks
do not establish a new signed upload or resolution of the earlier installation
failure; record the cloud build and actual device result separately.

## Android 1.0.17 (18) parity (2026-10-29)

The final Android 1.0.17 (18) release records native source `ffe7fd0d9`.
All 70 files in `apps/mobile/src` match the refreshed iOS source; their shared
Git tree is `5bb45666f703c62127ea5ce78d35cc26d4c12a59`. The iOS marketing
version is 1.0.17. Codemagic assigns the iOS build number independently of
Android's 18.

The shared bundle now consumes Chat image handoffs in the original conversation,
preserves the saved question and answer idempotency key, and reads back an
uncertain result without submitting another image. Credit-balance and daily
credit refusals have distinct localized explanations, and an empty failed
response no longer leaves the Thinking indicator active. The native plan screen
includes access-pass code entry, server-confirmed access periods and specific
expired/ineligible/unconfirmed-result messages.

The image-response CORS header and authenticated server routes are already in
the Android release's merged backend. They apply to the existing iOS origin
as well. No additional backend deployment or authorization change is introduced
by this iOS refresh. The Apple billing build flag and product/SDK configuration
remain subject to the existing setup above; synthetic pass tests do not activate
App Store purchases or make the disabled production plan menu available.

The iOS-specific fixture suite additionally covers English/Korean access-pass
redemption on an iPad-sized screen, Apple-store routing, no StoreKit purchase
for a pass, and expired/lost responses without automatic retries or unverified
access. Local verification passed 66 image/transport/billing tests, 27 iOS
preparation/CORS tests, 24 Apple billing browser cases, 12 WebKit
completion/continuation cases and 6 iPhone/iPad responsive cases. Production
bundle generation, iOS sync, the build dry run, scoped ESLint and diff checks
also passed. A signed cloud build and physical-device installation remain
separate steps. The previously diagnosed
TestFlight install-data HTTP 404 occurs before app download; refreshing the
application source does not establish that Apple's delivery failure is fixed.

## Android 1.0.18 (19) update prompt parity (2026-10-29)

The signed Android 1.0.18 (19) candidate records source `d4b99ae21` from
PR #3110. That candidate's record says it is not merged or published. This iOS
branch includes that commit unchanged and adds the platform-specific update
adapter. The iOS marketing version is 1.0.18; its CI build number remains
independent of Android's 19.

The shared launch/foreground banner, seven languages, 24-hour Later choice and
response-in-progress suppression are retained. iOS checks Apple's public lookup
metadata through the new `MobileUpdatesPlugin`, matches Tomverse's app/bundle
identity, compares marketing versions numerically and excludes incompatible
minimum OS versions. Lookup failures and unpublished apps stay quiet. The
adapter caches checks for five minutes and opens the fixed App Store product
page only after Update is tapped. App Store owns installation, so iOS never
claims an in-app download or restart. The iOS prebuild check now requires this
plugin's actual generated registration.

Local verification passed 57 adapter/image/transport unit tests, 15 iOS prebuild
tests, 7 Codemagic workflow tests, 24 WebKit update/composer cases, 15 Chromium
update cases and 6 iPhone/iPad responsive cases (124 total). Mobile typecheck,
production bundle preparation and sync, scoped lint and the build dry run passed.
The Windows checks exercise the TypeScript adapter, browser banner and generated
plugin registration. They do not compile the new Swift class or prove a store
update. Record remote Xcode compilation separately from a signed upload after
Apple's advised waiting period and actual iPhone/iPad acceptance. Public App Store
metadata does not list TestFlight-only builds or fix the prior install-data 404.

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
