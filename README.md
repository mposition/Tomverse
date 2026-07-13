This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## AI Usage Limits

Chat access is enforced on the server. Guests can use `Free` models only by
default, while signed-in users can use models through `Max`.

The following optional environment variables override the built-in limits:

```text
CHAT_GUEST_MAX_TIER=Free
CHAT_USER_MAX_TIER=Max
CHAT_GUEST_MAX_INPUT_TOKENS=16000
CHAT_USER_MAX_INPUT_TOKENS=128000
CHAT_GUEST_TOKENS_PER_DAY=40000
CHAT_GUEST_TOKENS_PER_MONTH=200000
CHAT_USER_TOKENS_PER_DAY=1000000
CHAT_USER_TOKENS_PER_MONTH=20000000
CHAT_GUEST_COST_MICROUSD_PER_DAY=20000
CHAT_GUEST_COST_MICROUSD_PER_MONTH=100000
CHAT_USER_COST_MICROUSD_PER_DAY=2000000
CHAT_USER_COST_MICROUSD_PER_MONTH=20000000
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH=100000000
```

Provider variables use the same pattern for every provider. Values are integer
microdollars, so `1000000` equals USD 1. Model pricing and output limits can be
overridden with normalized model IDs:

```text
CHAT_MODEL_GPT_5_5_INPUT_USD_PER_MILLION=15
CHAT_MODEL_GPT_5_5_OUTPUT_USD_PER_MILLION=60
CHAT_MODEL_GPT_5_5_MAX_OUTPUT_TOKENS=8192
```

Application limits are a second line of defense. Configure billing alerts and
hard spending limits in each AI provider dashboard as well.

## Provider Billing Profiles

The Admin Console provider panel separates how a service is priced from how the
account settles its bill:

- Pricing: usage-based, subscription, committed capacity, or unknown.
- Settlement: prepaid, postpaid, hybrid, invoice, or unknown.

Documented defaults are shown until an administrator with `billing:write`
permission verifies the account-specific contract. Mistral defaults to
`usage-based / hybrid` because pay-as-you-go charges can coexist with purchased
credits. A verified profile, optional provider-side monthly limit, and note are
stored in `ProviderBillingConfig`; changes are rate-limited and audit logged.

Prepaid and hybrid panels expose the optional DB credit checkpoint. Postpaid
and invoice panels instead show month-to-date accrued cost, projected month-end
cost, and remaining headroom. Provider-reported usage is preferred when it has
been synchronized; otherwise the projection uses internal tracked cost. These
figures are operational estimates and do not replace the provider invoice.

## Provider Usage Reconciliation

OpenAI organization costs use a dedicated server-side Admin API key. Create the
key as an OpenAI Organization Owner and add it to Railway Variables:

```text
OPENAI_ADMIN_API_KEY=<OpenAI organization Admin API key>
```

The OpenAI adapter calls `/v1/organization/costs` for one exact UTC day, follows
bounded pagination, and sums all USD line items. It does not reuse
`OPENAI_API_KEY`, and the generic `PROVIDER_OPENAI_USAGE_*` variables are ignored.
Provider failures log only sanitized status, error code, request ID, and a
Tomverse trace ID; API keys and raw response bodies are never logged.

Other providers continue to use the generic configuration when their billing
API supports a single numeric cost path:

```text
PROVIDER_<PROVIDER>_USAGE_URL=<HTTPS endpoint with optional {date} placeholder>
PROVIDER_<PROVIDER>_USAGE_COST_JSON_PATH=<numeric USD JSON path>
PROVIDER_<PROVIDER>_USAGE_AUTH_HEADER=<optional complete authorization value>
```

## Admin Infrastructure Audit

The Admin Console Infrastructure tab reads Railway projected usage, Cloudflare
R2 analytics, and application database inventory without exposing API tokens to
the browser. Add these server-side Railway Variables to enable external metrics:

```text
RAILWAY_API_TOKEN=<workspace or account token>
RAILWAY_WORKSPACE_ID=<workspace ID>
# RAILWAY_PROJECT_ID is used automatically when no workspace ID is set.

CLOUDFLARE_API_TOKEN=<Account Analytics Read token>
```

The existing `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` configure object access, but the separate
`CLOUDFLARE_API_TOKEN` is required for GraphQL analytics. Scope it to the
relevant Cloudflare account with `Account Analytics: Read` only.

Railway credit is an admin-maintained checkpoint stored in the database. The
displayed balance subtracts Railway's projected end-of-cycle usage from that
checkpoint; it is an operational estimate, not an invoice or payment action.
Cloudflare usage percentages use the current Standard storage free-tier
allowances as reference thresholds and are likewise not authoritative billing.

Before deploying the Admin Infrastructure, provider billing profiles, and
provider error-detail features,
apply the checked-in database migration with `npm run db:migrate` from a
deployment job that has `DIRECT_DATABASE_URL`.

## Authentication Secrets

Production OAuth account linking encrypts provider tokens before storing them.
Set both secrets in Railway Variables and keep them stable across deployments:

```text
NEXTAUTH_SECRET=<random value with at least 32 characters>
OAUTH_TOKEN_ENCRYPTION_KEY=<random value with at least 32 characters>
```

`OAUTH_TOKEN_ENCRYPTION_KEY` is mandatory and does not fall back to
`NEXTAUTH_SECRET`. If Microsoft OAuth is enabled, configure its client ID,
client secret, and tenant ID together. Public services that accept Microsoft
accounts from multiple directories can use the `common` tenant:

```text
AZURE_AD_CLIENT_ID=<application client ID>
AZURE_AD_CLIENT_SECRET=<application client secret>
AZURE_AD_TENANT_ID=common
```

Use a specific tenant GUID or verified tenant domain instead when sign-in must
be restricted to a single Microsoft Entra directory. Dangerous cross-provider
email account linking remains disabled for both configurations.

In production, `/api/health` returns `503` until `NEXTAUTH_SECRET`,
`OAUTH_TOKEN_ENCRYPTION_KEY`, and `MAINTENANCE_SECRET` are all at least 32
characters and all three Azure provider variables are configured together.

Generate a strong value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Do not rotate `OAUTH_TOKEN_ENCRYPTION_KEY` without re-encrypting existing
`enc:v1:` OAuth tokens, because old encrypted account tokens cannot be
decrypted with a new key.

## API Storage Limits

General write APIs use per-user and per-IP rate limits, bounded JSON parsing,
and transactional storage quotas. These optional variables override the
defaults:

```text
API_MAX_CONVERSATIONS_PER_USER=500
API_MAX_MESSAGES_PER_CONVERSATION=10000
API_MAX_MESSAGES_PER_USER=100000
API_MAX_MESSAGE_BYTES_PER_USER=52428800
API_UPLOAD_BYTES_PER_USER_PER_DAY=262144000
```

Attachment byte reservations work together with the R2 lifecycle rule. Keep
the temporary `attachments/` deletion rule enabled. Browser uploads are
finalized with a server-side R2 `HeadObject` validation immediately after the
presigned `PUT`; invalid objects are deleted during finalization.

## Guest Bot Protection

Production guest chat requires Cloudflare Turnstile:

```text
NEXT_PUBLIC_TURNSTILE_SITE_KEY=your-site-key
TURNSTILE_SECRET_KEY=your-secret-key
TURNSTILE_EXPECTED_HOSTNAME=tomverse.app
TRUSTED_PROXY_IP_HEADER=x-real-ip
```

Railway sets `X-Real-IP` at its trusted edge, so `x-real-ip` is the secure
default. Do not trust `X-Forwarded-For` directly.

Production requests are restricted to the canonical host by default. Add extra
hosts only when you intentionally serve the same deployment from another domain:

```text
PUBLIC_APP_URL=https://tomverse.app
ALLOWED_REQUEST_HOSTS=tomverse.app
```

`PUBLIC_APP_URL` is also used for security report endpoints such as CSP
`Report-To`, so keep it on the public production origin.

When Cloudflare proxying is enabled, remove the public Railway-generated domain
and configure a secret request header at Cloudflare:

```text
TRUSTED_PROXY_IP_HEADER=cf-connecting-ip
CLOUDFLARE_ORIGIN_SECRET=<random value with at least 32 characters>
REQUIRE_CLOUDFLARE_ORIGIN_SECRET=true
```

Cloudflare must overwrite `X-Tomverse-Origin-Verify` with that secret before
forwarding requests. Without a valid origin secret, the application ignores
`CF-Connecting-IP` and safely falls back to Railway's `X-Real-IP`.

## Content Security Policy

Nonce CSP starts in report-only mode. Review `CSP violation` entries in Railway
logs, exercise sign-in, Google Drive, Turnstile, attachments, and shared pages,
then enable enforcement:

```text
CSP_MODE=enforce
```

Do not enable full-page CDN caching for HTML routes while nonce CSP is active.
API responses may still use their own cache policies.

## Scheduled Maintenance

Set the same secret on the web service and the Railway Cron service:

```text
MAINTENANCE_SECRET=<random value with at least 32 characters>
MAINTENANCE_URL=https://tomverse.app
```

Create a separate Railway Cron service and set its Config File Path to
`/railway.maintenance.json`. The checked-in configuration runs this command
daily at 03:00 UTC:

```text
npm run maintenance:cleanup
```

Run it once per day. It deletes expired usage buckets and request leases, and
removes expired or revoked share tokens and snapshots.

## Railway Healthcheck

When host protection is enabled, set Railway's Healthcheck Path to:

```text
/api/health
```

This endpoint intentionally bypasses canonical host checks so Railway can verify
the container without using the public production hostname.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
