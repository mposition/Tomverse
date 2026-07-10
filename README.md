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

Create a Railway Cron service with this command:

```text
npm run maintenance:cleanup
```

Run it once per day. It deletes expired usage buckets and request leases, and
removes expired or revoked share tokens and snapshots.

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
