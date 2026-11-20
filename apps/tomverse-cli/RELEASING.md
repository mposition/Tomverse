# Releasing the Tomverse CLI

Publishing is the operator's step: it puts code outside Tomverse and needs the
npm and GitHub accounts. Everything before it is prepared in the repository.
This file is not shipped in the package (`files` in package.json).

What a release consists of:

- the npm package `@tomverse/cli` (needs Node.js 22 or later; Windows, macOS,
  Linux), published from `apps/tomverse-cli`;
- six standalone archives for users without Node.js (Windows x64/arm64, macOS
  arm64/x64, Linux x64/arm64), attached to a GitHub Release `cli-v<version>`
  on `mposition/Tomverse`.

## Before anything: production runs the server side

The published CLI talks to `https://tomverse.app/api/v1` (production). Publish
only after production is running the release that has the paid-plan gate for
the API and CLI (PR #4092) and Smart Adaptive on Claude Code and Codex
(PR #4094). Check with a Pro account's key, from any folder:

```powershell
$env:TOMVERSE_API_KEY = "<a Pro account's key>"
npx --yes ./tomverse-cli-<version>.tgz doctor   # the tarball from pack:verify; all checks pass
npx --yes ./tomverse-cli-<version>.tgz models   # smart-adaptive is listed
```

A Free account's key must get "The Tomverse API and CLI need a paid plan."

## 0. Once: the npm organisation

Where: a browser, signed in to the npm account that will own the package.

1. Create the organisation `tomverse` (free plan; public packages only):
   <https://www.npmjs.com/org/create>. If the name is taken, stop: the package
   name and every `npm install -g @tomverse/cli` in the product must change
   together (`lib/externalApiCodingTools.ts`, this README, `docs/policy/external-api.md`).
2. Turn on two-factor authentication for the account (npm requires it to
   publish) and, under the organisation's settings, require it for members.

## 1. Check every platform

Where: GitHub > Actions > **Tomverse CLI release check** > Run workflow, on the
branch or commit to release. It builds and tests the npm package on Windows,
macOS and Linux with Node 22 and 24, and builds and tests the six standalone
executables. It publishes nothing. Every job must be green; download the six
`tomverse-cli-<os>-<arch>` artifacts from the run's summary page.

## 2. Publish the npm package

Where: local PC, PowerShell, a clean clone of the release commit, after `npm ci`.

```powershell
npm login                         # opens the browser; the CLI never sees the password
npm whoami                        # the account that is a member of the tomverse org
cd apps\tomverse-cli
npm publish --dry-run             # runs prepublishOnly (build + pack:verify), uploads nothing
npm publish                       # publishes @tomverse/cli@<version> as public (publishConfig)
npm view @tomverse/cli version    # the version just published
```

`prepublishOnly` rebuilds `dist/` and runs `pack:verify` (pack, install the
tarball outside the repository, license and secret checks, process tests on
the installed copy) before anything is uploaded; a failure stops the publish.
A published version can never be reused, even after `npm unpublish`; a fix
ships as the next version.

## 3. Publish the standalone archives

Where: local PC, PowerShell, with the six artifacts from step 1 unzipped into
one folder.

```powershell
gh release create cli-v0.1.0 --repo mposition/Tomverse --title "Tomverse CLI 0.1.0" `
  --notes "Install: npm install -g @tomverse/cli, or download the archive for your system below." `
  tomverse-0.1.0-*.zip tomverse-0.1.0-*.tar.gz tomverse-0.1.0-*.sha256
```

The README links to `https://github.com/mposition/Tomverse/releases?q=cli-v`.
Mark the release "latest" only if the repository has no other releases that
should hold that place.

## 4. After publishing: show the guide in Settings

Where: Railway dashboard (or `railway variables`), the web service of each
environment, in order: dev, then production.

Set `TOMVERSE_CLI_GUIDE_ENABLED=true`. It shows the install-and-connect card
in Settings > API keys (`tomverseCliGuide` in `lib/externalApiCodingTools.ts`);
it changes nothing in the API. A variable reaches only deployments made after
it is set, so redeploy the service. Check that the card shows
`npm install -g @tomverse/cli` and that the command works on a machine that
has never had the CLI.

## Not done yet (decisions with a cost)

- **Code signing.** The standalone executables have no publisher signature:
  Windows SmartScreen warns on first run, and macOS warns about a downloaded
  file (it has an ad-hoc signature, which Apple silicon needs to run it).
  Removing the warnings needs an Apple Developer ID with notarization and a
  Windows code-signing certificate, both paid.
- **npm provenance / trusted publishing.** Publishing from GitHub Actions with
  OIDC would attach a provenance statement and remove the local `npm login`.
  It needs a publish workflow and an npm trusted-publisher setting.
- **The license text.** `LICENSE` is a draft of a proprietary use-only
  license. Before the first publish, have it reviewed and replace "Tomverse"
  with the registered company name where it names the licensor.
