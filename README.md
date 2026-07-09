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
the temporary `attachments/` deletion rule enabled.

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
