# Tomverse Desktop release draft

## Download listing

Tomverse Desktop brings Chat, Review, and Code together in a desktop app. Connect your Tomverse account to open your conversations and use the features available to your account.

| Platform | Download | Install and update |
| --- | --- | --- |
| Windows x64 | Signed MSIX | Open the package with Windows App Installer. In Desktop, use **Settings → Preferences → Updates** on a direct MSIX installation with an update feed. For installations enrolled through an App Installer manifest, use Windows App Installer updates. |
| macOS Apple Silicon | Signed and notarized PKG for arm64 | Run Installer, then open Tomverse Desktop from Applications. Use **Settings → Preferences → Updates** when a signed update is offered. |
| macOS Intel | Signed and notarized PKG for x64 | Follow the same steps using the Intel package. |
| Debian 12 x64 | AMD64 DEB and SHA-256 checksum list | Compare the downloaded DEB with the published checksum, then install it with the package manager in a graphical session. Install a newer verified DEB to update. |

The Windows installer declares build 19041 as its minimum. Keep only the rows confirmed by installation and launch evidence for the release. Attach the exact version, download URL, and SHA-256 to each published row. The local rehearsal certificates and bundles are for release verification.

### Accounts, credits, and data

- Sign in through the browser. Desktop features depend on the account and the features enabled by Tomverse. Chat, Review, and image generation follow the existing model, plan, and credit rules. Image generation shows the server quote before you confirm. [Tomverse pricing](https://tomverse.app/pricing)
- Connect Code through the same Tomverse account. Check the execution route and applicable usage before sending a task. A provider CLI manages its own sign-in and billing when its execution route is available. Code asks for approval for protected actions and shows the recorded task usage.
- When you send Chat or Review attachments, those files are transmitted to Tomverse for that request. Code has a local project picker and accepts project files and folders as references. Code can read project content for the task and send relevant context to the selected model. Select references and review any proposed edits or commands before approving them.
- Code can save task history locally. A selected MCP connection in Code Ask shares approved read results with the Code model and disables local saving and resumption for that task. Use Tomverse web settings for account data export and account deletion. Review and export any local Code records you need before removing the device profile. [Tomverse privacy policy](https://tomverse.app/privacy)
- Voice recording, OS location sharing, and provider-specific CLI execution depend on the build and supported environment. Chat and Code Ask support entering a place manually. Use the features displayed in your build.

### Support

For an installation or update issue, record your Desktop version, operating system, architecture, and the installer name. For a Code issue, use **Export diagnostics** or **Copy diagnostics** from the task's event log after the task stops. Review the file before sharing it. Send the version, steps, and diagnostics through Tomverse Support. [Tomverse Support](https://tomverse.app/support)

## Operator verification

### R01 and R02 artifacts and updates

Use the [package and lifecycle commands](README.md#release-checks) on the corresponding operating system. Keep the previous verified installer and the new candidate side by side.

1. Record the final byte count and SHA-256 after signing. For Windows, verify the MSIX signing certificate and publisher. On each Mac architecture, verify the PKG and update ZIP's Developer ID and notarization. Select the update origin at build time and serve the corresponding manifests and files from that origin. [Microsoft MSIX signing](https://learn.microsoft.com/windows/msix/package/signing-package-overview) · [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
2. Publish the Debian checksum over the official download channel. On a Debian terminal in the download directory, verify the DEB against the official `SHA256SUMS` file. This reads local files and requires no server credentials.

   ```sh
   sha256sum -c SHA256SUMS
   ```

3. On a disposable Windows or Mac installation with the actual signed stable feed, install N and launch N+1 through the app's update flow. Confirm the app defers restart during active work and preserves the profile. Check invalid versions, an incorrect hash, and an unrecognized signer in the restricted test feed. For Debian, install N and then N+1 with the package manager and confirm the profile opens after each.

### R03 service activation confirmation

Record the approved environment, deployed commit, database migration status, package build version, and enabled capabilities. Keep each optional Desktop capability scoped to the approved environment and account. The installed app must have Desktop authentication enabled at build time, and the server must allow the Desktop grant flow and the selected capabilities.

`TOMVERSE_DESKTOP_AUTH_ENABLED` gates both the Desktop build and the server. The server enables Chat writes, Review and image generation, and attachments with their respective `TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED`, `TOMVERSE_DESKTOP_REVIEW_ENABLED`, and `TOMVERSE_DESKTOP_ATTACHMENTS_ENABLED` switches. Record the availability returned for the approved account from the Desktop capabilities endpoint.

Enable `TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED` on the approved server for Desktop's native account settings. Check that Plan shows the signed-in account's usage, that device preferences remain available after sign-out, and that sign-out clears the main process's settings credential. Pass `--auth-enabled` to the Windows portable package verification when the build includes browser authentication.

The authenticated Windows package opens a compact sign-in window when no Desktop session can be restored. Verify the Apple, Google, and Microsoft browser handoffs and the in-app email code flow separately. The server requires `TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED` for the email flow. The email endpoint uses the existing delivery, rate limits, and verification challenge. Verify the quit button, failed code handling, resend, and return to sign-in after sign-out.

Connect an approved test account from the installed build. Confirm browser sign-in, reconnect, sign-out, and same-account Code key binding. Call one approved Chat, Review, image, and Code request where each capability is enabled. Confirm the returned receipt and actual charge for each accepted request. Check that a disabled capability and a different account's Code key are rejected. Verify results against the same installed build and deployed commit before issuing the launch decision.

### R05 stop a rollout and restore a working app

1. Stop offering the affected version in the update feed and remove its public download link through the approved release process. Check that the previous supported version receives no new offer. A client that already staged an update can still have a restart action, so include those clients in support instructions.
2. Preserve the affected user's profile. Reproduce the startup failure with an isolated copy of the candidate. Reopen the previous verified portable build with the same test profile or follow the signed platform recovery procedure. On an installed channel that blocks downgrades, use an approved superseding package with a higher version and the corrected payload.
3. Capture package digests, the status of the feed, Desktop diagnostics when the app can open, and the result of relaunch. Check Web, Mobile, CLI, and VS Code through their existing entry points and confirm the Desktop repair doesn't reuse or overwrite their independent state.

On a local Windows PC, in PowerShell at the repository root, the following check writes only a disposable profile and candidate copy. It uses two already built portable packages and no production credentials.

```powershell
npm run desktop:pack:verify -- --out "<new package directory>" --previous "<previous portable bundle>" --startup-recovery
```
