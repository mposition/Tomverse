# Voice Recovery deployment

[한국어 설정 안내](voice-recovery-setup.ko.md)

The worker is `scripts/voice-conversation-watchdog.mjs`; its package script is
`npm run voice:watchdog`. Run it from the repository root, alongside `package.json`,
not from `apps/mobile`, `scripts`, or the Android folder.

Use a checkout containing this script. Verify its presence before configuring the
worker; preserve unrelated work if another checkout is on a different branch.

## Railway production service

Use the Tomverse Railway project and its `production` environment. `Voice Recovery`
already exists in the project; configure its production instance if absent. If
creating an instance through the dashboard, use the same GitHub repository as the
web service and verify the environment before deploying.

To reuse the existing service, select the receiving `production` environment,
choose **Sync**, and select `dev` as the source. Retain only the Voice Recovery
addition in the staged changes. Review **Details** before deploying: this sync
must not replace production web/database settings with development settings.
Set the worker source branch to `main` and re-enter any required production sealed
secrets; sealed values are not copied by environment sync.

| Setting | Value |
| --- | --- |
| Repository | `mposition/Tomverse` |
| Branch | `main` containing the voice release |
| Root Directory | repository root (`/`) |
| Builder | Railpack |
| Build Command | `npx prisma generate` |
| Start Command | `npm run voice:watchdog` |
| Replicas | one continuously running replica |
| Restart Policy | Always |
| Cron Schedule | unset |
| Public domain and HTTP healthcheck | not needed; the worker has no HTTP listener |
| Pre-deploy migration command | none; reuse the web deployment's migrated database |

These are Railway commands inside its Linux deployment container. A Windows `C:`
or `H:` folder is not a Railway Root Directory or Start Command.

## Variables

Set these worker values:

```dotenv
VOICE_CONVERSATION_WATCHDOG_ENABLED=true
NODE_ENV=production
APP_ENV=production
TOMVERSE_DEPLOY_ENV=production
```

Reference the matching production web service values, preserving existing approved
budgets and keys:

```text
DATABASE_URL
DIRECT_DATABASE_URL
NEXTAUTH_SECRET
ADMIN_AUDIT_INTEGRITY_KEY
ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS (if present on the web service)
VOICE_CONVERSATION_API_KEY
VOICE_PROVIDER_SECONDS_PER_DAY
VOICE_PROVIDER_SECONDS_PER_MONTH
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH
VOICE_INPUT_SECONDS_PER_DAY (if explicitly configured on the web service)
```

Use production shared variables or Railway service references, for example
`DATABASE_URL=${{Tomverse.DATABASE_URL}}`. Register the dedicated voice provider
credential privately in Railway. Do not put credentials in Git, a Start Command,
or chat. Do not substitute development database references or invent larger budgets.

`VOICE_CONVERSATION_KILL_SWITCH` must be absent or empty on both services for normal
operation. Any nonempty string, including `false`, activates the kill switch.

## Start and verify

1. Confirm the web voice release and its database migrations deployed successfully.
2. Configure and deploy the worker. A failed deployment is not a running watchdog.
3. Verify its process remains running and its database heartbeat advances. The key
   is `voice-conversation:watchdog` in `ChatUsageBucket`; the server requires a
   heartbeat newer than 15 seconds. This is a read-only database check:

   ```sql
   SELECT "key", "updatedAt"
   FROM "ChatUsageBucket"
   WHERE "key" = 'voice-conversation:watchdog';
   ```

4. On the Tomverse web service, set `VOICE_CONVERSATION_ENABLED=true`, register the
   same dedicated `VOICE_CONVERSATION_API_KEY`. Deploy those web variable changes.
5. Verify the authenticated `/api/products/chat/capabilities` response contains
   `voiceConversation.enabled: true`. A guest response does not establish this.
6. Fully close and reopen the updated native APK to refresh its capability read.

The worker polls every two seconds and does not create new paid sessions. It can
close and reconcile existing sessions. Actual voice Start creates a paid provider
session and remains a separately approved verification action.

The continuous-session server ignores the obsolete `VOICE_CONVERSATION_MAX_SECONDS`.
Remove it after deploying that server and the matching recovery worker; deleting it
on an older server merely restores its 300-second default. The new server renews
short funding windows on the same connection, within existing account, provider-time
and provider-cost budgets. Its initial exposure is up to 60 seconds / 36 credits,
including 30 seconds of closing headroom. Unused credits return after settlement.
Provider expiry and disconnects do not automatically start another paid session.

Repeated `Voice recovery cycle deferred.` logs indicate that the recovery cycle
could not finish. Check the database connection, schema, dedicated provider key
and matching production environment before enabling new voice sessions.

## Local diagnostic execution

On the local PC, use PowerShell in the verified checkout:

```powershell
Set-Location '<checkout>'
$env:VOICE_CONVERSATION_WATCHDOG_ENABLED='true'
npm run voice:watchdog
```

First supply the remaining variables above through the approved environment or
secret manager. Plain `node` does not automatically load `.env.local`; this package
script does not add an env-file loader. Do not paste secrets into command history.
Use a local/test database for isolated diagnostics. A local process with production
credentials writes production recovery state and is not an isolated dry run.

For production, supervise the worker in Railway: closing a Windows terminal or
sleeping the PC must not stop voice-session recovery.

Reference: [Railway environments](https://docs.railway.com/environments) and
[service variables](https://docs.railway.com/variables).
