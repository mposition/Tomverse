# Tomverse Desktop authentication rollout

Follow the [dev, Test, and production release lanes](dev-test-lanes.md). Deploy the server routes and repository migrations with the Desktop flags off. Migration `20261122100000_desktop_native_device` adds `desktop` to the existing device platform check. The server uses the existing native signing and refresh configuration, and the existing Tomverse login email delivery and Turnstile configuration.

| Server variable | Purpose |
| --- | --- |
| `TOMVERSE_DESKTOP_AUTH_ENABLED` | Enables Desktop authentication routes and requires a ready native keyring. |
| `TOMVERSE_DESKTOP_EMAIL_LOGIN_ENABLED` | Enables requesting and verifying codes and serving the Turnstile page. |
| `TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED` | Enables the separate in-app account settings session. |
| `TOMVERSE_DESKTOP_BILLING_ENABLED` | Shows Desktop's in-app plan, purchase, plan-change, cancellation and refund screens (`desktopBilling` capability). Requires the account settings session. It is a display switch: the billing routes already accept that session as they accept a web session. Off, Desktop's Plan tab shows balances only. |
| `TOMVERSE_DESKTOP_PLUGINS_ENABLED` | Shows Desktop's in-app connector management and the Chat connector picker (`desktopPlugins` capability). Requires the account settings session and `MCP_CONNECTOR_PREVIEW_ENABLED`. It is a display switch: the `/api/mcp` routes already accept that session as they accept a web session. |

Verify the deployed commit and migration in Test. With the two login flags off, an originless `POST /api/auth/desktop/email` with `{}` returns HTTP 503 and `NOT_AVAILABLE`. With both flags on and the native keyring ready, the same invalid request reaches validation and returns HTTP 400 without sending mail. Requests with cookies or an `Origin` header must be refused, and `/auth/desktop/email-proof` must load with the configured Turnstile site key.

After approval to activate in production, enable the two login flags and repeat the route checks on `tomverse.app`. The Windows 0.1.123 portable uses that origin. With an approved test account, request a code once, enter the received six digits in the Desktop window, confirm the workspace opens, and sign out. Exercise the provider buttons against the configured Apple, Google, and Microsoft accounts when verifying provider login.

Turn off the email flag to stop new email sign-ins. Turn off the Desktop auth flag if the Desktop session routes must also be disabled. Keep the additive device-platform migration in place so existing Desktop device records remain valid.
