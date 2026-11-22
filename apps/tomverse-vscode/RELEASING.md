# Build and verify

Local developer machine, PowerShell, repository root. Requires the repository's Node/npm toolchain and local VS Code Desktop. These commands write local build/test artifacts and need no production credentials or paid requests.

```powershell
npm ci
npm run cli:typecheck
npm run cli:test
npm run cli:pack:verify
npm run vscode:typecheck
npm run vscode:build
npm run vscode:test
npm run vscode:test:integration
npm run vscode:package
npm run vscode:pack:verify
npm run vscode:test:installed
npm run vscode:test:recovery
```

Dependencies are exact versions in the workspace manifest/lock. esbuild bundles the same revision's CLI headless runtime into `dist/extension.cjs`; the CLI entry and terminal prompter are rejected by the build. Third-party licenses are included. VSIX timestamps use the source commit date (`SOURCE_DATE_EPOCH`); repeat packaging from the same revision/toolchain produces the same bytes. `vscode:package` uses local vsce without a Marketplace token. `vscode:pack:verify` inspects the actual VSIX against a file allowlist and credential/private-path patterns, and emits its SHA256.

Integration uses actual Extension Development Hosts and a local fake gateway with no paid request. `VSCODE_EXECUTABLE_PATH` selects the local executable (required on macOS/Linux). Trusted and restricted profiles are separate. The trusted helper from `@vscode/test-electron` disables trust; the restricted run launches the documented test-host flags directly because that helper unconditionally adds `--disable-workspace-trust`. The restricted run keeps trust enabled and asserts the real `workspace.isTrusted === false`.

`TOMVERSE_TEST_EXTENSION_PATH` can point to the installed VSIX's extension directory so the identical packaged runtime is exercised. The test driver is outside the VSIX. Internal test handles are returned only when VS Code sets `ExtensionMode.Test`; there are no production commands to set keys, approve operations or override trust for tests. Host logs and JSON evidence are under `artifacts/` and excluded from the package.

Before claiming support for an OS, record that OS's actual VSIX install, Ask, approve patch, command, cancel, resume and Undo results with the version and artifact hash. Unrun systems remain NOT RUN. Check native Save/Cancel, format-on-save, keyboard/IME, themes and screen-reader behavior separately from deterministic host tests. Do not claim UI clicks merely because a test called the message handler.

Real-model tests require a separately authorized environment, key, models, request ceiling and spending ceiling. Check the coding API deployment and receipt readiness first. Never reuse a prior stage's budget or run on a production database. Independent review of changed credential/approval/execution boundaries uses the repository review server after committing the finished diff.

## Publish the preview

From the local repository root in PowerShell, run `npm --workspace tomverse-vscode run package -- --pre-release`, then `npm run vscode:pack:verify`. The flag adds the Marketplace pre-release marker. The resulting universal VSIX can also be installed directly. Build from the release commit and verify the installed package's hash before uploading it.

Publish the VSIX and SHA256 with a versioned GitHub pre-release. Record the source commit, verified environments and remaining checks in the release notes. Verify the public asset without an authenticated session before adding a download link to the website.

Marketplace publication requires an account authorized to manage the `tomverse` publisher in the [Marketplace publisher portal](https://marketplace.visualstudio.com/manage). Register the publisher there if needed and upload the verified pre-release VSIX. For automated publishing, follow the [official Trusted Publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing). Confirm that `tomverse.tomverse-vscode` and the expected pre-release version are publicly visible before advertising Marketplace availability.

A new PR targets develop as draft with `ci:hold`. CI admission, merge, deployment, publication and paid runs each require the applicable owner authorization.
