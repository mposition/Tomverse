# Codemagic: first unsigned iOS build

Prepared on 2026-10-26 for the owner's personal Codemagic account. The Apple
Developer Program is not required for this Simulator compile. The workflow has
been checked locally; a Codemagic/Xcode build has not run yet.

## Repository and workflow

The repository-root `codemagic.yaml` defines `ios-simulator` (display name
`Tomverse iOS Simulator`). It uses a Mac mini M2, Node 22.22.2 and Xcode 26.6,
with a 45-minute timeout. It installs locked dependencies, generates and checks
the iOS bundle, runs the preparation tests, compiles without signing and packages
the Simulator application. There are no automatic triggers or publishing steps.

Repository: `https://github.com/mposition/Tomverse`.
Prepared branch: `codex/to-develop/ios-remote-build-prep`, based on the main
revision recorded in [the remote-build handoff](ios-remote-build.md).
The branch must be pushed before Codemagic can read this configuration. A merge
to main or develop is not needed to build this branch.

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
   select branch `codex/to-develop/ios-remote-build-prep` and workflow
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

## Local verification

Machine: local Windows PC. Shell: PowerShell. Directory: repository root.
Prerequisites: Node 22 and installed repository dependencies. No production
credentials are required; these checks do not run a cloud build.

```powershell
npm run test:codemagic
npm run test:ios-prebuild
npm run build:ios -- --dry-run
```

The workflow tests check YAML parsing, preparation order, signing/trigger
exclusion, failed-build propagation through `tee`, and explicit artifact paths.
The embedded Bash steps have also passed a local syntax check. These checks do
not substitute for the first Xcode build.

## Official references

- [Adding an app and limiting GitHub repository access](https://docs.codemagic.io/getting-started/adding-apps/)
- [Using YAML and manually selecting a branch/workflow](https://docs.codemagic.io/yaml-basic-configuration/yaml-getting-started/)
- [Personal-account free M2 minutes](https://docs.codemagic.io/billing/pricing/)
- [Xcode 26.6 build image](https://docs.codemagic.io/specs-macos/xcode-26-6/)
- [Unsigned iOS Simulator builds](https://docs.codemagic.io/yaml-code-signing/ios-simulator-builds/)
