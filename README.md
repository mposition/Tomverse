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
CHAT_FREE_COST_MICROUSD_PER_DAY=250000
CHAT_FREE_COST_MICROUSD_PER_MONTH=500000
CHAT_PRO_COST_MICROUSD_PER_DAY=1500000
CHAT_PRO_COST_MICROUSD_PER_MONTH=4500000
CHAT_MAX_COST_MICROUSD_PER_DAY=3000000
CHAT_MAX_COST_MICROUSD_PER_MONTH=9000000
CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH=30
CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH=100000000
```

Provider variables use the same pattern for every provider. Values are integer
microdollars, so `1000000` equals USD 1. Model pricing and output limits can be
overridden with normalized model IDs:

User-facing AI response credits are reserved per model call and settled when
the stream completes. Base weights are Standard 1, Advanced 4, Premium 8,
Reasoning 12-16, search 20, and Deep Research 30 credits. Estimated input above
16K, 50K, and 100K tokens applies a 1.5x, 2x, and 3x multiplier respectively.
Provider failures and empty responses refund user credits; partial cancellation
settles proportionally while estimated provider cost accounting remains separate.

```text
CHAT_MODEL_GPT_5_5_INPUT_USD_PER_MILLION=15
CHAT_MODEL_GPT_5_5_OUTPUT_USD_PER_MILLION=60
CHAT_MODEL_GPT_5_5_MAX_OUTPUT_TOKENS=8192
CHAT_MODEL_GPT_5_5_RESERVATION_OUTPUT_TOKENS=2048
```

`MAX_OUTPUT_TOKENS` remains the provider response ceiling. The separate
`RESERVATION_OUTPUT_TOKENS` value is the realistic output allowance reserved by
Tomverse's internal cost guard before a request starts; it is clamped to the
provider ceiling. Multi-model sends are preflighted as one comparison against
the user's credits, concurrency, token, internal-cost, and provider-cost limits
before any provider request is dispatched.

Application limits are a second line of defense. Configure billing alerts and
hard spending limits in each AI provider dashboard as well.

## Customer Billing Promotions

The public billing configuration exposes plans and a generic promotion policy,
but never promotion objects or code strings. A code is looked up only after the
customer submits it to the bounded, rate-limited server validation endpoint,
and checkout repeats the same validation. Stripe's free-form promotion-code
entry is disabled; Tomverse passes only the server-selected Stripe Promotion
Code ID.

Every active promotion must have a maximum redemption count and end date. Both
the database transaction and the Stripe Promotion Code enforce those limits.
Annual-plan discount stacking is denied by default and must be enabled for the
specific promotion in Admin Billing. Existing unbounded active promotions are
paused by migration `20260714000000_harden_billing_promotions`.

Account reuse is blocked, overlapping promotion checkouts use a short lease,
and shared IP/payment-method signals are recorded for Admin review. IPs and
Stripe payment fingerprints are stored only as keyed hashes; the maintenance
job removes those identifiers after 90 days while retaining the redemption
audit record.

`TOMFRIEND100` is intentionally different from a Stripe discount. Migration
`20260716150000_founding_tester_pass` configures it as a private Founding Tester
Pass with these controls:

- Pro only, 100% discount, exactly 60 days of access.
- 25 total redemptions and campaign redemption through 2026-08-30 Brisbane time.
- No Stripe Checkout session, payment method, charge, or automatic renewal.
- A reminder email seven days before expiry, then an automatic return to Free.
- An expiry email linking to the regular Pro and Max pricing page.

The Admin Billing editor identifies this with `fulfillmentType=internal_pass`
and `accessDurationDays=60`. All ordinary promotions, including `TOMVERSE50`,
use `stripe_subscription`; even a 100% Stripe promotion must not enter the
internal-pass path merely because the amount due today is zero.

## Fixed-currency customer billing

New subscription and credit-pack checkouts use fixed prices in USD, AUD, CNY,
EUR, or KRW. Localized prices are stored in the `billing.fixed-prices.v1`
`AppSetting` and are edited in Admin Billing under **Market prices**; live FX is
not used for the customer-facing amount. USD subscription prices remain in
`BillingPlan`. Price changes affect new checkouts only and do not rewrite an
existing Stripe subscription price.

Stripe amounts and GA4 ecommerce values use each currency's own minor-unit
rules. In particular, KRW is zero-decimal (`20000` means ₩20,000), while
`1500` means USD 15.00. Checkout completion writes the actual Stripe currency
and `amount_total` to `BillingTransaction`, together with a payment-time USD
revenue snapshot. Credit purchases retain the same snapshot on
`CreditPurchase`. Refund APIs refund the original Stripe charge in its original
currency and stop for manual review if the stored purchase currency differs.

Deploy migration `20260715230000_fixed_currency_billing` before enabling these
checkouts in production.

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

## Database Model Registry

The Admin Console **Providers > Model Registry** tab is the source of
truth for the live model catalogue. It manages the Tomverse model ID, provider
API model ID, API Base URL, API-key environment-variable name, plan access,
credit weight, image/PDF support, context window, token limits, and token-price
snapshot. API secrets are never stored in the database; only the environment
variable name is stored and its configured/missing state is displayed.

Live availability (`enabled`, `limited`, `disabled`, or `coming-soon`), the
private operational reason, and the safe user-visible status note are managed
in the same registry. The former Model Controls override panel is no longer a
separate source of truth. Its saved values are copied into the registry by
`20260717213000_consolidate_model_runtime_controls`.

Use the Copy action on any model card to prefill a new entry with the existing
provider, endpoint, plan, credit, capability, context, and pricing settings. A
copy receives a unique draft ID and starts disabled and hidden so its new API
model ID can be verified before it becomes callable.

The checked-in `AVAILABLE_MODELS` array is retained only as the first-deploy
bootstrap and a rolling-migration fallback. Existing rows are never overwritten
by the bootstrap. Removing a model from the Admin Console archives it
(`catalogDeleted=true`, `enabled=false`, `publiclyListed=false`) instead of
physically deleting the ID, so historical conversations remain readable. A
saved archived entry is restored to the active catalogue.

Apply the Model Registry migrations before using the editor:

```bash
npm run db:migrate
```

Custom API Base URLs must be public HTTPS endpoints. Localhost, private/link-local
addresses, embedded credentials, query strings, and fragments are rejected to
prevent server-side request forgery. Registry writes are permission checked,
rate limited, and recorded in the Admin audit log.

Prepaid and hybrid panels expose the optional DB credit checkpoint. Postpaid
and invoice panels instead show month-to-date accrued cost, projected month-end
cost, and remaining headroom. Provider-reported usage is preferred when it has
been synchronized; otherwise the projection uses internal tracked cost. These
figures are operational estimates and do not replace the provider invoice.

The Admin Console always shows two separate monthly limits. **Provider billing
limit (DB reference)** is the provider account or contract value recorded in
`ProviderBillingConfig`; it is informational inside Tomverse. **Tomverse enforced
monthly cap** comes from
`CHAT_PROVIDER_<PROVIDER>_COST_MICROUSD_PER_MONTH` in Railway, or the $100 code
default when the variable is absent or invalid, and is the value enforced by
chat request reservation. The expected effective ceiling is displayed as the
lower of the known provider limit and the Tomverse cap. When the provider limit
is not recorded, the Tomverse cap is the only known operational ceiling.

## Provider Usage Reconciliation

OpenAI organization costs use a dedicated server-side Admin API key. Create the
key as an OpenAI Organization Owner and add it to Railway Variables:

```text
OPENAI_ADMIN_API_KEY=<OpenAI organization Admin API key>
```

OpenAI cost sync uses a 30-second per-request timeout and up to three attempts
for connection failures, timeouts, HTTP 408/409/429, and HTTP 5xx responses.
The limits can be narrowed or extended within the built-in safety bounds without
making either variable required:

```text
OPENAI_COSTS_TIMEOUT_MS=30000 # 5000..60000
OPENAI_COSTS_MAX_ATTEMPTS=3   # 1..3
```

If all attempts end before response headers arrive, the Admin Console reports a
connection-stage failure. That result cannot validate the key or its permissions;
check Railway outbound DNS/TLS and HTTPS access to `api.openai.com` first. A
received HTTP 401/403 instead means connectivity succeeded and the Admin API key
or its Organization Owner permissions must be corrected.

The OpenAI adapter calls `/v1/organization/costs` for one exact UTC day, follows
bounded pagination, and stores the net total of all USD line items. Signed
credits or adjustments are preserved, and a genuine zero-cost day is still
recorded as synced. It does not reuse `OPENAI_API_KEY`, and the generic
`PROVIDER_OPENAI_USAGE_*` variables are ignored. Provider failures log only the
sanitized HTTP status, schema path and value type, error code, request ID, and a
Tomverse trace ID; API keys, amount values, and raw response bodies are never
logged.

Anthropic organization costs also use a dedicated server-side Admin API key:

```text
ANTHROPIC_ADMIN_API_KEY=<Anthropic organization Admin API key>
```

The Anthropic adapter calls `/v1/organizations/cost_report` with `x-api-key`
authentication for one exact UTC day, follows bounded `next_page` pagination,
sums every USD fractional-cent line item across all returned buckets, and stores
the total as provider-reported micro-USD. It does not reuse `ANTHROPIC_API_KEY`,
and the generic `PROVIDER_ANTHROPIC_USAGE_*` variables are ignored.

xAI team usage requires a Management Key that is separate from the inference
`XAI_API_KEY`. Add both server-only values to the web and provider-usage Cron
services:

```text
XAI_MANAGEMENT_API_KEY=<xAI Management Key>
XAI_TEAM_ID=<xAI Team UUID>
```

The dedicated xAI adapter sends a bounded POST request to
`https://management-api.x.ai/v1/billing/teams/{team_id}/usage` for one exact UTC
day. It requests the summed `usd` value, totals every returned
`timeSeries[].dataPoints[].values[0]`, and stores the result as provider-reported
micro-USD. A response with `limitReached=true` is rejected rather than storing a
partial cost. `XAI_ADMIN_API_KEY`, `PROVIDER_XAI_USAGE_URL`, and
`PROVIDER_XAI_USAGE_COST_JSON_PATH` are not used by this adapter.

Other providers continue to use the generic configuration when their billing
API supports a single numeric cost path:

```text
PROVIDER_<PROVIDER>_USAGE_URL=<HTTPS endpoint with optional {date} placeholder>
PROVIDER_<PROVIDER>_USAGE_COST_JSON_PATH=<numeric USD JSON path>
PROVIDER_<PROVIDER>_USAGE_AUTH_HEADER=<optional complete authorization value>
```

Mistral Chat Completion usage is accounted from each API response instead of
requiring an Admin Usage API. The OpenAI-compatible streaming adapter sends
`stream_options.include_usage=true`; the final Usage event supplies prompt,
completion, and cached prompt tokens. Tomverse stores those actual token counts
with the input/output rates and 10% cached-input multiplier that applied when
the request was reserved. Historical costs are therefore not recalculated when
environment pricing changes.

Use a Tomverse-only `MISTRAL_API_KEY`, preferably from a production-only Mistral
Workspace. The Admin Console labels this mode **Internal response accounting**
and **Provider reconciliation unavailable on current Mistral plan**. Compare the
internal monthly total with Mistral Console Usage manually. If a future Mistral
plan exposes a supported numeric billing endpoint, the generic
`PROVIDER_MISTRAL_USAGE_*` variables can opt the provider back into automatic
reconciliation. This calculation covers Chat Completions; OCR, Audio, Agents,
Connectors, and fine-tuning require separate accounting before they are enabled.

Deploy migration `20260715233000_mistral_response_usage_accounting` before
releasing cached-token accounting in production.

Zhipu/Z.AI Chat Completion usage is also accounted from the final response
Usage event. Prompt, completion, total, and
`prompt_tokens_details.cached_tokens` values flow through the durable chat
reservation settlement and are stored in `ProviderDailyUsage`. The Admin Usage
Reconciliation panel therefore labels Zhipu **Internal response accounting**
instead of **Skipped** when no custom daily-cost endpoint is configured.

Set the GLM model prices to the values that apply to the production account.
The cached-input multiplier is snapshotted with every request so later pricing
changes do not rewrite historical estimates:

```text
CHAT_MODEL_GLM_5_2_INPUT_USD_PER_MILLION=<current uncached input price>
CHAT_MODEL_GLM_5_2_OUTPUT_USD_PER_MILLION=<current output price>
CHAT_MODEL_GLM_5_2_CACHED_INPUT_PRICE_MULTIPLIER=0.2
```

The code uses `0.2` as the Zhipu cached-input fallback, but the production value
must be verified against the current model price or account contract before
launch.

Zhipu does not have a supported general-account balance API in the current
integration. After a recharge, enter the verified USD balance with **Set
credit** on the Zhipu provider card. Tomverse stores the checkpoint in
`ProviderCreditConfig`, subtracts internal response costs recorded after that
checkpoint, and shows the estimated remaining balance. When the estimate falls
to 50%, 20%, or 5% of the checkpoint, Tomverse sends an internal provider alert
through the configured Admin notification channels. Each level is deduplicated
to at most one alert per UTC day. Update the checkpoint only after a recharge or
manual provider-dashboard verification; a new checkpoint resets the usage
baseline without rewriting historical usage.

Perplexity costs are captured from each successful Chat Completion response.
Tomverse preserves the provider's exact `usage.cost.total_cost`, including the
request, search-query, citation, reasoning, input, and output components, in the
durable `ChatCreditReservation.providerUsageSnapshot`. The exact provider total
overrides the token-price estimate for settlement and internal provider usage;
the original request-time token estimate remains in `pricingSnapshot` for audit.
Retries under the same reservation are summed so billed retry attempts are not
lost. No additional Perplexity admin key is required.

The Provider Usage Reconciliation panel reports Perplexity as **Internal** with
the source **Exact response cost accounting**. Perplexity does not use the
generic `PROVIDER_PERPLEXITY_USAGE_*` variables; its period total should be
verified manually against the Perplexity Billing dashboard.

Deploy migration `20260715234500_perplexity_exact_response_cost` before
releasing exact Perplexity request accounting.

DeepSeek prepaid balance monitoring uses the inference key against the official
`GET https://api.deepseek.com/user/balance` endpoint. No extra URL variable is
required:

```text
DEEPSEEK_API_KEY=<DeepSeek API key>
```

The Admin Console keeps the returned currency intact and displays total,
granted, and topped-up balances plus `is_available`. A CNY balance is never
mislabelled as USD. `PROVIDER_DEEPSEEK_BALANCE_URL` remains available only as an
explicit endpoint override.

DeepSeek does not expose a supported date-based aggregate cost API in the
current integration. When no custom `PROVIDER_DEEPSEEK_USAGE_*` endpoint is
configured, Usage Reconciliation therefore shows **Internal response
accounting** instead of **Skipped**. Tomverse normalizes DeepSeek's
`prompt_cache_hit_tokens` response field into the standard cached-token Usage
shape before settlement, then stores request, input, cached-input, output, and
estimated cost totals in `ProviderDailyUsage`. The Balance API remains the live
prepaid-funds check; compare monthly internal totals with the DeepSeek Usage CSV
export.

Set production model pricing explicitly so every request stores the active
price snapshot:

```text
CHAT_MODEL_DEEPSEEK_V4_FLASH_INPUT_USD_PER_MILLION=<current cache-miss input price>
CHAT_MODEL_DEEPSEEK_V4_FLASH_OUTPUT_USD_PER_MILLION=<current output price>
CHAT_MODEL_DEEPSEEK_V4_FLASH_CACHED_INPUT_PRICE_MULTIPLIER=<cache-hit price divided by cache-miss price>
CHAT_MODEL_DEEPSEEK_V4_PRO_INPUT_USD_PER_MILLION=<current cache-miss input price>
CHAT_MODEL_DEEPSEEK_V4_PRO_OUTPUT_USD_PER_MILLION=<current output price>
CHAT_MODEL_DEEPSEEK_V4_PRO_CACHED_INPUT_PRICE_MULTIPLIER=<cache-hit price divided by cache-miss price>
```

Moonshot/Kimi balance monitoring uses the existing `MOONSHOT_API_KEY` with the
official Check Balance endpoint. The URL and JSON path below are supported as
explicit overrides, but the official values are built in:

```text
PROVIDER_MOONSHOT_BALANCE_URL=https://api.moonshot.ai/v1/users/me/balance
PROVIDER_MOONSHOT_BALANCE_JSON_PATH=data.available_balance
```

The provider panel displays the available, voucher, and cash balances. Moonshot
does not expose a supported date-based cost API, so Usage Reconciliation shows
**Internal response accounting** instead of **Skipped**. Request tokens and the
request-time model price snapshot supply the internal daily cost; the Balance
API remains a separate live prepaid-funds check. Compare the monthly internal
total with Kimi API Platform manually.

Google Cloud Billing reconciliation reads the standard Cloud Billing export in
BigQuery. First enable the standard usage-cost export, then give a dedicated
service account **BigQuery Job User** on the query project and **BigQuery Data
Viewer** on the export dataset. Configure the full table identifier and one of
the two credential formats below on the web and provider-usage Cron services:

```text
GOOGLE_CLOUD_BILLING_PROJECT_ID=<BigQuery query project; defaults to service-account project_id>
GOOGLE_CLOUD_BILLING_EXPORT_TABLE=<project.dataset.gcp_billing_export_v1_ACCOUNT_ID>
GOOGLE_CLOUD_BILLING_LOCATION=<BigQuery dataset location, such as US or australia-southeast1>
GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON=<complete service-account JSON>
# Alternative for platforms where multiline JSON is inconvenient:
GOOGLE_CLOUD_BILLING_SERVICE_ACCOUNT_JSON_BASE64=<base64 service-account JSON>
```

The query sums cost and credits for the selected UTC usage date and divides by
the export's `currency_conversion_rate`, producing a net micro-USD amount even
when the Cloud Billing account uses a local invoice currency. Billing export can
arrive several hours late, so the scheduled reconciliation should continue to
sync the previous UTC day. The service-account secret is never returned to the
browser or written to provider usage JSON.

Alibaba Cloud Billing reconciliation is attached to the Qwen provider card and
uses a dedicated RAM identity against the international Singapore BSS endpoint.
Grant `AliyunBSSReadOnlyAccess` or the narrower
`bssapi:QueryInstanceBill` permission and configure:

```text
ALIBABA_CLOUD_ACCESS_KEY_ID=<RAM AccessKey ID>
ALIBABA_CLOUD_ACCESS_KEY_SECRET=<RAM AccessKey secret>
ALIBABA_CLOUD_SECURITY_TOKEN=<optional temporary RAM token>
ALIBABA_CLOUD_BILLING_PRODUCT_CODE=<optional product filter, recommended for shared accounts>
ALIBABA_CLOUD_BILLING_ENDPOINT=https://business.ap-southeast-1.aliyuncs.com
```

Requests use the current `ACS3-HMAC-SHA256` signature, daily granularity,
bounded pagination, and sum the returned USD `PretaxAmount` values. Alibaba can
delay daily instance bills by about one day. Non-USD bills are rejected instead
of applying an unverified FX rate; use an international USD billing account for
exact micro-USD reconciliation. If `ALIBABA_CLOUD_BILLING_PRODUCT_CODE` is
omitted, the result represents the whole Alibaba Cloud account rather than only
Model Studio/Qwen usage.

## Admin Infrastructure Audit

The Admin Console Infrastructure tab reads Railway projected usage, Cloudflare
R2 analytics, and application database inventory without exposing API tokens to
the browser. Add these server-side Railway Variables to enable external metrics:

```text
# Recommended: project-specific monitoring
RAILWAY_PROJECT_ID=<project ID from Project Settings>
RAILWAY_PROJECT_TOKEN=<project token from Project Settings > Tokens>

# Alternative: workspace/account token authentication
RAILWAY_API_TOKEN=<workspace or account token>
RAILWAY_WORKSPACE_ID=<workspace ID; only used when RAILWAY_PROJECT_ID is absent>

CLOUDFLARE_API_TOKEN=<Account Analytics Read token>

PRISMA_MANAGEMENT_API_TOKEN=<workspace service token>
PRISMA_DATABASE_ID=<database ID from Prisma Console>
PRISMA_OPERATIONS_LIMIT=1000000
```

Railway project tokens use the `Project-Access-Token` header. Account and
workspace tokens use `Authorization: Bearer`. The dashboard supports both and
prefers project scope when both project and workspace IDs are configured. This
prevents a stale `RAILWAY_WORKSPACE_ID` from masking a valid project setup.

Create the Prisma token from Prisma Console under Workspace Settings > Service
Tokens. The database usage endpoint supplies the current month's operations and
storage values. Set `PRISMA_OPERATIONS_LIMIT` to the allowance shown for the
active Prisma plan; the dashboard defaults to 1,000,000 and warns at 80%.

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

In production, `/api/ready` fails closed until PostgreSQL answers `SELECT 1`
and all launch security checks pass. The required production configuration is:

```text
NEXTAUTH_SECRET=<at least 32 characters>
OAUTH_TOKEN_ENCRYPTION_KEY=<at least 32 characters>
MAINTENANCE_SECRET=<at least 32 characters>
CSP_MODE=enforce
STRIPE_WEBHOOK_SECRET=<Stripe signing secret>
PROVIDER_USAGE_SYNC_SECRET=<at least 32 characters>
PROVIDER_MODEL_CATALOG_SYNC_SECRET=<optional dedicated 32+ character secret; otherwise MAINTENANCE_SECRET>
REQUIRE_CLOUDFLARE_ORIGIN_SECRET=true
CLOUDFLARE_ORIGIN_SECRET=<at least 32 characters>
TRUSTED_PROXY_IP_HEADER=cf-connecting-ip
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key>
TURNSTILE_SECRET_KEY=<secret key>
TURNSTILE_EXPECTED_HOSTNAME=tomverse.app
SENTRY_DSN=<Sentry DSN>
# At least one independent operations alert channel:
OPS_ALERT_SLACK_WEBHOOK_URL=<webhook URL>
# Public database URLs must use sslmode=verify-full or sslmode=verify-ca.
DATABASE_URL=<PostgreSQL URL>
E2E_AUTH_BYPASS=false
E2E_DISABLE_DATABASE=false
```

All three Azure provider variables must also be configured together when
Microsoft login is enabled. Private Railway database hosts (`*.internal`) do
not require a public TLS query parameter; public database endpoints do. The
readiness response exposes only aggregate booleans, while the failed check
names are sent to the independent operational alert path.

Generate a strong value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Do not rotate `OAUTH_TOKEN_ENCRYPTION_KEY` without re-encrypting existing
`enc:v1:` OAuth tokens, because old encrypted account tokens cannot be
decrypted with a new key.

## DB-independent error monitoring

Prisma-backed `ProviderErrorEvent` and `AdminNotificationLog` records cannot be
written while PostgreSQL itself is unavailable. Production therefore uses a
separate server error path which never imports Prisma:

```text
SENTRY_DSN=<Sentry Next.js project DSN>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0

# Optional but recommended for readable production stack traces
SENTRY_ORG=<Sentry organization slug>
SENTRY_PROJECT=<Sentry project slug>
SENTRY_AUTH_TOKEN=<source-map upload token>

# Dedicated values take precedence; existing provider-alert hooks are fallbacks.
OPS_ALERT_SLACK_WEBHOOK_URL=<Slack incoming webhook URL>
OPS_ALERT_DISCORD_WEBHOOK_URL=<Discord webhook URL>
OPS_ALERT_EMAIL=<operations email address>
OPS_ALERT_COOLDOWN_SECONDS=600
```

`instrumentation.ts` forwards unhandled App Router server errors to Sentry.
Caught readiness and maintenance errors are reported explicitly, because a
handled `503` or `500` is not an unhandled exception. Slack, Discord, and Resend
delivery runs directly and never attempts to create an `AdminNotificationLog`.
Messages redact database credentials, bearer tokens, cookies, and secret-shaped
context keys. Prompts, file contents, request bodies, authorization headers, and
cookies are not sent to Sentry.

The Admin Console environment audit shows `SENTRY_DSN` and
`OPS_ALERT_CHANNEL`. These checks confirm application configuration only; they
do not prove that an external uptime monitor is running.

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
TRUSTED_PROXY_IP_HEADER=cf-connecting-ip
```

Production does not trust `X-Real-IP` or `X-Forwarded-For`. Client IP addresses
are accepted only from Cloudflare after the origin verification header has
been validated.

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
forwarding requests. Without a valid origin secret, production requests are
rejected and client IP resolution fails closed to `unknown`. Remove or
firewall Railway's generated public domain so Cloudflare is the only public
ingress path.

## Content Security Policy

Nonce CSP starts in report-only mode. Review `CSP violation` entries in Railway
logs, exercise sign-in, Google Drive, Turnstile, attachments, and shared pages,
then enable enforcement:

```text
CSP_MODE=enforce
```

Do not enable full-page CDN caching for HTML routes while nonce CSP is active.
API responses may still use their own cache policies.

## Privacy-safe Product Analytics

Apply the product analytics migration before launch:

```text
npm run db:migrate
```

Configure the GA4 web stream and create a Measurement Protocol API secret in
Railway. The API secret must remain server-only:

```text
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=your-ga4-measurement-protocol-secret
ANALYTICS_DEFAULT_ENABLED_COUNTRIES=AU
```

`ANALYTICS_DEFAULT_ENABLED_COUNTRIES` is a server-only, comma-separated
allowlist for regions where privacy-minimized analytics may start after a clear
notice with an immediate opt-out. It defaults to `AU`. Add another country only
after a country-specific privacy review. EU/EEA countries, the United Kingdom,
and Switzerland remain explicit opt-in even if accidentally placed in this
allowlist. An unknown country also fails closed to explicit opt-in.

For GA4 DebugView verification, set the following only in the staging service:

```text
NEXT_PUBLIC_GA4_DEBUG_MODE=true
```

This adds `debug_mode: true` to the client GA configuration, client product and
Ecommerce events, and server Measurement Protocol events. Leave the variable
unset or set it to `false` in production. Because `NEXT_PUBLIC_*` values are
inlined into the browser bundle, rebuild and redeploy staging after changing it.

In explicit opt-in regions, Tomverse does not load Google Analytics or create
its pseudonymous analytics identifier until the visitor accepts the analytics
notice. In a reviewed default-enabled region such as Australia, analytics
starts only after the same-origin country policy check completes; the visitor
sees a compact notice and can turn analytics off immediately or later through
the persistent Analytics settings control. A failed or unknown country check
falls back to explicit opt-in. Advertising storage, advertising user data, and
ad personalization remain denied in every region.

Every enabled event is also written to the bounded first-party analytics ledger
so the Admin Console Analytics tab can report the weekly active comparison-user
North Star, the 24-hour activation definition, D1/D7 return, funnel counts, and
campaign attribution. Prompts, responses, filenames, file contents, email, and
profile data are rejected by the analytics schema.

Before analytics is enabled, first-touch UTM values and bounded product-event
intents are kept only in the current tab's `sessionStorage`. They survive
navigation and a page reload, are sent only after analytics becomes permitted,
and are deleted on decline or opt-out. Run the complete test-campaign checklist in
`docs/analytics-campaign-validation.md` before enabling paid acquisition.

In GA4 Admin, register event-scoped custom dimensions for `utm_source`,
`utm_medium`, `utm_campaign`, `language`, `country`, and `plan`, plus an
event-scoped custom metric for numeric `model_count`. Funnel events such as
`multi_model_compare_completed` and `signup_completed` can be marked as key
events where appropriate. For payment conversion and revenue reporting, use
the standard GA4 `purchase` event as the only Primary purchase Key Event and
the only purchase conversion imported into Google Ads. Keep
`purchase_completed` as a Tomverse first-party ledger and internal funnel event;
do not mark it as a GA4 Key Event or import it into Google Ads. This prevents a
single transaction from being counted as two purchase conversions.

### Model Finder experiment

The signed-in onboarding experiment assigns new accounts deterministically so
the same account always receives the same variant. Existing accounts are not
interrupted and can reopen Model Finder from Settings.

```text
MODEL_FINDER_EXPERIMENT_PERCENT=50
MODEL_FINDER_LAUNCH_AT=2026-07-15T00:00:00.000Z
```

The percentage is bounded to `0..100`. Funnel events carry only the experiment
variant, recommendation rank, selected model ID, and a bounded suggestion
reason. Prompts, responses, and file metadata are not collected.

## Search and Social Discovery

The production app generates `/robots.txt` and `/sitemap.xml` from Next.js
metadata routes. The sitemap contains only public canonical URLs and real
localized variants of the homepage and search-intent pages. Authenticated app,
Admin, API, sign-in, and public-share-token routes are excluded or explicitly
marked `noindex`.

Page metadata uses `https://tomverse.app` as the canonical origin and includes
Open Graph and X large-card images. The root document also publishes sanitized
`Organization` and `SoftwareApplication` JSON-LD. Do not add ratings, reviews,
or pricing claims that cannot be verified from the live product.

For URL-prefix ownership verification, Railway can optionally provide the exact
HTML meta-tag tokens issued by the webmaster tools:

```text
GOOGLE_SITE_VERIFICATION=<Google Search Console HTML tag content value>
BING_SITE_VERIFICATION=<Bing msvalidate.01 content value>
```

For Google, a Domain property verified by DNS is preferred because it covers
protocol and subdomain variants and does not depend on an application deploy.
After ownership is verified, submit `https://tomverse.app/sitemap.xml` in
Google Search Console. Bing Webmaster Tools can import the verified Google
property and its sitemap, or the same sitemap can be submitted directly. Keep
the verification record or meta token in place after registration.

## Administrator security and operational controls

Administrator allowlists and roles are intentionally separate. `ADMIN_EMAILS`
or `ADMIN_USER_IDS` grants console access; the role lists grant write
permissions. An authorized identity that is missing from every role list is
`readonly`, never `owner`:

```text
ADMIN_EMAILS=owner@example.com,operator@example.com
ADMIN_OWNER_EMAILS=owner@example.com
ADMIN_OPS_EMAILS=operator@example.com
ADMIN_BILLING_EMAILS=
ADMIN_SUPPORT_EMAILS=
ADMIN_READONLY_EMAILS=
```

Optional administrator expiries are enforced with a JSON object. If this
variable is present but malformed, administrator access fails closed:

```text
ADMIN_ACCESS_EXPIRY_JSON={"operator@example.com":"2026-12-31T23:59:59.000Z"}
ADMIN_SESSION_MAX_HOURS=8
ADMIN_RECENT_AUTH_MINUTES=30
ADMIN_APPROVAL_TTL_MINUTES=30
ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS=10000
```

High-risk operations create an exact, expiring approval request. A different
administrator must approve it; the original requester then retries the same
target and payload. Successful execution consumes the approval once. Existing
administrators must sign in again after the security migration. Recent-auth
checks use the current database session's creation time, not a user-wide last
login timestamp.

New admin audit records are serialized into an HMAC chain. A dedicated secret
is recommended; when omitted, `NEXTAUTH_SECRET` is used:

```text
ADMIN_AUDIT_INTEGRITY_KEY=<independent random value with at least 32 characters>
```

The Admin Overview includes scheduled-job delay detection, privacy-request
deadlines, operational verification checkpoints, and audit-chain verification.
The Platform tab contains server-enforced emergency switches for AI chat,
attachments, and public sharing. Disabling sharing still permits revocation,
and disabling attachments still permits deletion.

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

Run it once per day. It sends Founding Tester Pass expiry notices, returns
expired pass accounts to Free, deletes expired usage buckets and request leases,
and removes expired or revoked share tokens and snapshots.

Create a second Railway Cron service for durable AI-credit reservation recovery
and set its Config File Path to `/railway.credit-reconciliation.json`. It runs
every five minutes:

```text
npm run maintenance:credit-reservations
```

The web service and this Cron service must share `MAINTENANCE_SECRET` and
`MAINTENANCE_URL`. Chat credit reservations expire after five minutes by
default; the reconciler atomically refunds reservations that remain in
`reserved` state after expiry. A value from 300 to 1800 seconds can be set when
longer provider calls are expected:

```text
CHAT_RESERVATION_TTL_SECONDS=300
```

Do not schedule this job less frequently than every five minutes. The daily
cleanup also runs the reconciler as a fallback, but it is not a substitute for
the five-minute Cron service. This five-minute job also runs the Railway, R2,
PostgreSQL, and Prisma threshold monitor at most once every 15 minutes. Warning
or error thresholds are sent through the DB-independent operational alert
channels and appear as a separate scheduled-job row in Admin.

Create a third Railway Cron service for the daily operations summary and
set its Config File Path to `/railway.provider-usage-sync.json`. It runs at
00:30 UTC (10:30 Australia/Brisbane). The same run refreshes the Infrastructure
dashboard sources and sends two managed Slack reports: the previous UTC day's
provider usage/balance summary and the latest Railway, R2, PostgreSQL, and
Prisma statistics:

```text
npm run maintenance:provider-usage
```

Set `PROVIDER_USAGE_SYNC_SECRET` on both the web and Cron services. The Cron
service also needs `PROVIDER_USAGE_SYNC_URL=https://tomverse.app`. Configure
`PROVIDER_USAGE_SLACK_WEBHOOK_URL` on the web service for a dedicated report
channel, or it falls back to `SLACK_WEBHOOK_URL`. Infrastructure reports use
`INFRASTRUCTURE_SLACK_WEBHOOK_URL` when configured and otherwise use
`SLACK_WEBHOOK_URL`.

Create a fourth Railway Cron service for Provider model lifecycle and discovery
monitoring and set its Config File Path to
`/railway.provider-model-catalog.json`. It runs at 00:00 UTC, which is 10:00
Australia/Brisbane year-round:

```text
npm run maintenance:provider-model-catalog
```

Set `PROVIDER_MODEL_CATALOG_SYNC_URL=https://tomverse.app` on the Cron service.
It can share the web service's existing `MAINTENANCE_SECRET`, or use a separate
32+ character `PROVIDER_MODEL_CATALOG_SYNC_SECRET` configured identically on
the web and Cron services. Provider API keys remain on the web service only;
the Cron calls the authenticated internal route and never receives those keys.

The monitor queries each configured Provider's fixed, code-allowlisted model
catalog endpoint, compares the result with `ModelRegistryEntry`, and stores an
auditable daily snapshot. Explicit lifecycle states such as `legacy` or
`archived` are reported immediately. A model merely absent from a successful
catalog response is reported as **missing**, not definitively deprecated;
`likely_deprecated` requires two consecutive successful missing scans by
default. This prevents an API outage or account permission difference from
becoming a false deprecation alert. The threshold can be set from 2 to 7 with:

```text
PROVIDER_MODEL_MISSING_CONFIRMATION_RUNS=2
```

Slack delivery uses `PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL`, then
`OPS_ALERT_SLACK_WEBHOOK_URL`, then `SLACK_WEBHOOK_URL`. Email delivery uses a
comma-separated `PROVIDER_MODEL_CATALOG_ALERT_EMAIL`, then `OPS_ALERT_EMAIL`,
then `ADMIN_ALERT_EMAIL`, and requires `RESEND_API_KEY`. A daily report is sent
even when there are no changes. It separates lifecycle warnings, consecutive
catalog misses, newly discovered model candidates, missing keys, and Provider
API failures. Admin Scheduled Jobs records the latest run, result counts,
delay, and failure state. Admin Alerts also exposes the managed Slack template
and a safe test payload.

All Tomverse Slack deliveries, including Admin test messages and DB-independent
operational alerts, automatically include `<!channel>` so the destination channel
receives an explicit notification.

The Admin **Alerts** tab contains the managed Slack templates for daily
Infrastructure, daily Provider Usage, daily Provider Model Catalog, and
Provider Incident messages. Operators
with `ops:write` permission can enable or disable scheduled delivery, edit only
the documented placeholders, and send a test message using live dashboard data.
Every send, failure, and skipped delivery is written to Admin notification logs.
Run `npm run db:migrate` after deploying the Slack template migration. Critical
DB-outage alerts intentionally remain environment-backed and independent from
these DB templates so they still work during a database outage.

## Railway Healthcheck

When host protection is enabled, keep Railway's deployment Healthcheck Path on
the process liveness endpoint:

```text
/api/health
```

This endpoint intentionally bypasses canonical host checks so Railway can verify
the container without using the public production hostname. It does not query
the database or validate service configuration, so a dependency outage cannot
turn the process liveness check into a restart or deployment loop.

Configure continuous external monitoring against the dependency readiness
endpoint instead:

```text
/api/ready
```

`/api/ready` returns `200` only when PostgreSQL answers `SELECT 1` and the
required production security environment is valid. It returns `503` with
boolean `database` and `securityEnvironment` checks otherwise. Neither endpoint
is cached, and both intentionally bypass canonical host protection without
exposing secrets.

Create the readiness monitor in a service outside the Tomverse Railway project
so a project-wide outage cannot disable both the app and its monitor. Use these
settings:

```text
URL: https://tomverse.app/api/ready
Method: GET
Interval: 60 seconds
Timeout: 10 seconds
Incident condition: 2 consecutive non-2xx responses
Recovery notification: enabled
Channels: operations Slack and email
```

Do not point Railway's container Healthcheck Path at `/api/ready`; keep it on
`/api/health` to avoid restarting a healthy process during a database outage.
After deployment, temporarily use an invalid staging database host and verify
all of the following before Go-Live:

1. `/api/health` remains `200` while `/api/ready` returns `503`.
2. Sentry receives `DATABASE_READINESS_FAILED` with no connection credentials.
3. Slack or email receives the incident and later the recovery notification.
4. The external uptime service records both outage and recovery.
5. Railway Logs contain the structured `operational_incident` record.

Configure a Railway Log Drain to an external log destination as a second copy
of structured application logs. A Log Drain and the external uptime monitor are
Railway/service settings and cannot be created merely by deploying repository
files.

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
