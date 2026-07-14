# Paid campaign analytics validation

Run this checklist in production with Stripe test mode before enabling paid
campaigns. Use a new browser profile so previous consent and attribution do not
affect the result.

## Test campaign

Open this URL and keep the same browser tab for the full flow:

```text
https://tomverse.app/?utm_source=qa-search&utm_medium=cpc&utm_campaign=launch-validation
```

1. Confirm the landing page loads, then select the primary start CTA.
2. On `/chat`, accept analytics. UTM parameters do not need to remain in the URL.
3. Send a first question and wait for the first complete response.
4. Open sign-up, accept the terms, and complete one OAuth sign-up.
5. Open pricing, select Pro or Max, and continue to Stripe Checkout.
6. Complete a Stripe test-mode payment and wait for the webhook to succeed.

## Required evidence

In the Admin Console analytics funnel, verify that the same test campaign is
present for this sequence:

```text
landing_view
cta_start_click
chat_started
first_response_completed
signup_page_view
signup_started
signup_completed
pricing_view
plan_selected
checkout_started
purchase_completed
```

In GA4 DebugView or Realtime, verify the same events have:

```text
utm_source = qa-search
utm_medium = cpc
utm_campaign = launch-validation
```

Confirm Stripe shows a successful test Checkout Session and that Railway logs
show a successful billing webhook without a replay or signature error. A test
is not complete if `checkout_started` exists but `purchase_completed` is
missing.

## Automated browser contract

The local browser test validates attribution persistence across a full reload,
consent, first chat, sign-up start, plan selection, and checkout start without
calling GA4, OAuth providers, Stripe, or model providers:

```text
npx playwright test tests/e2e/analytics-campaign-funnel.spec.ts --project=desktop-chromium
```

The final `purchase_completed` step remains a production Stripe test-mode
check because it depends on the deployed webhook and Stripe signature.

