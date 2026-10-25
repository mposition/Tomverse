# Native store billing

Implementation uses RevenueCat's Capacitor SDK as the StoreKit / Google Play
Billing adapter. Tomverse remains the entitlement and credit ledger owner.
The SDK verifies/finishes store purchases; an authenticated RevenueCat webhook
grants consumable credits exactly once. Subscription sync reads the current
RevenueCat server snapshot, never the client's entitlements. Provider HTTP runs
outside transactions; a short shared subscription lock serializes DB writes.
Separate observation clocks reject older snapshots for each provider. A pending payment
does not grant access. Failed webhook processing returns 503 for redelivery.

## Product behavior

- Pro and Max monthly/annual subscriptions reuse the web plan's model access,
  monthly credit allowance and usage counters. No extra allowance is issued or
  usage reset on upgrade. Monthly allowance resets on the UTC calendar month.
- Tier changes keep the same interval. Configure one Apple subscription group:
  Max at the higher level, Pro at the lower level; monthly/annual variants of
  each tier share its level. StoreKit handles immediate upgrades and period-end
  downgrades. Google uses CHARGE_PRORATED_PRICE for upgrades and DEFERRED for
  downgrades; configure distinct Pro/Max subscription IDs with matching base
  plans. The native store confirmation discloses the charge and effective date.
- Cancellation opens the original store's subscription management. Paid access
  remains until verified expiry. Cancelled renewal is never silently resumed by
  changing plans. Restore purchases is a visible, explicit action.
- Existing web subscribers can cancel renewal inside the app using the verified
  bearer identity. Changes remain with their original provider to prevent a
  second recurring subscription. The app contains no Stripe checkout or
  external purchase link. Cross-store subscriptions also remain with the
  original store. Credits remain purchasable through the current native store.
- Web and store subscription state are persisted separately. If a previously
  opened checkout completes after a store purchase, its payment and subscription
  are retained and both cancellation paths are shown. Neither source's late
  deletion can remove the other source's paid access. The effective tier is the
  highest currently entitled tier, with a shared monthly allowance rather than
  an extra allowance per subscription.
  Every verified store period is retained, so a lower tier on the other store
  stays available after an overlapping higher tier expires. Management links
  are offered for each subscribed store.
- Account deletion confirmation and scheduled-deletion mail disclose that App
  Store/Play billing must be cancelled separately; deleting the Tomverse account
  does not cancel a store subscription.
- Starter 500 is offered to Free; Project 1,500 and Power 4,000 to Pro/Max, as on
  web. Store prices come from localized StoreKit/Play product data. An annual
  price is the complete annual charge, not a monthly equivalent.
- Store credit packs are consumables and **never expire**, including after
  cancelling a plan. Web purchases retain their existing expiry. nonExpiring
  controls availability and expiry jobs; expiresAt=9999-12-31 is only a
  compatibility value for the existing non-null column. Refunds revoke unused
  credits and put spent amounts into the existing debt ledger. A refund
  tombstone prevents reordered purchase events from granting refunded credits.
  Reservation releases after a refund settle that debt instead of reviving the
  refunded lot. Account export includes filtered store purchase records.
  Before the store sheet opens, the server records one credit-purchase
  authorization after checking the effective plan's pack eligibility. A verified
  credit webhook atomically consumes one matching authorization. A pending
  payment remains authorized if the plan changes before delivery; direct SKU
  purchases without authorization cannot grant credits. Each payment sheet
  gets its own authorization, valid for a purchase timestamp within 24 hours
  of authorization (delivery can arrive later). Repeated same-SKU purchases can
  complete before earlier webhooks arrive without replacing their approvals.
  Duplicate and refund
  events never need a second authorization; refund-before-purchase also consumes
  the matching authorization. A verified paid purchase without authorization is
  retained with needsReview, acknowledged without retry, and surfaced in server
  error logs and the app's support notice; further credit purchases are blocked
  until support resolves the store payment/refund. Pending authorizations are deleted
  with the account and are included in its filtered data export.

## Configuration before activation

All switches default off. This implementation does not activate a deployed
service, publish a build, register real products or make a live purchase.

API server:

| Variable | Purpose |
| --- | --- |
| MOBILE_BILLING_ENABLED=true | Enroll only /api/mobile/billing in the native bearer gateway and enable the authenticated webhook |
| MOBILE_BILLING_ENVIRONMENT | PRODUCTION (default) or SANDBOX; use separate test DB/deployment for sandbox |
| MOBILE_BILLING_PRODUCTS_JSON | Exact store product mapping; no inferred or client-provided quantities |
| REVENUECAT_SECRET_API_KEY | Server-only customer lookup key; never bundle it |
| REVENUECAT_WEBHOOK_AUTHORIZATION | Exact authorization header configured in RevenueCat, at least 32 characters |
| REVENUECAT_APPLE_APP_ID | RevenueCat app ID allowed for App Store events |
| REVENUECAT_GOOGLE_APP_ID | RevenueCat app ID allowed for Play events |
| MOBILE_BILLING_OWNERSHIP_KEY | Dedicated server-only key, at least 32 characters, for stable receipt/owner hashes |

Native Vite build:

- VITE_NATIVE_BILLING_ENABLED=true
- VITE_REVENUECAT_APPLE_API_KEY (public appl_ SDK key)
- VITE_REVENUECAT_GOOGLE_API_KEY (public goog_ SDK key)
- Existing native chat/auth switches and API origin remain required.

Mapping example (replace all identifiers with the registered store IDs):

```json
[
  {"store":"app_store","productId":"app.tomverse.pro.monthly","kind":"subscription","plan":"Pro","interval":"monthly"},
  {"store":"app_store","productId":"app.tomverse.pro.annual","kind":"subscription","plan":"Pro","interval":"annual"},
  {"store":"app_store","productId":"app.tomverse.max.monthly","kind":"subscription","plan":"Max","interval":"monthly"},
  {"store":"app_store","productId":"app.tomverse.max.annual","kind":"subscription","plan":"Max","interval":"annual"},
  {"store":"app_store","productId":"app.tomverse.credits500","kind":"credits","packId":"starter_500"},
  {"store":"app_store","productId":"app.tomverse.credits1500","kind":"credits","packId":"project_1500"},
  {"store":"app_store","productId":"app.tomverse.credits4000","kind":"credits","packId":"power_4000"},
  {"store":"play_store","productId":"tomverse_pro:monthly","kind":"subscription","plan":"Pro","interval":"monthly"},
  {"store":"play_store","productId":"tomverse_pro:annual","kind":"subscription","plan":"Pro","interval":"annual"},
  {"store":"play_store","productId":"tomverse_max:monthly","kind":"subscription","plan":"Max","interval":"monthly"},
  {"store":"play_store","productId":"tomverse_max:annual","kind":"subscription","plan":"Max","interval":"annual"},
  {"store":"play_store","productId":"tomverse_credits500","kind":"credits","packId":"starter_500"},
  {"store":"play_store","productId":"tomverse_credits1500","kind":"credits","packId":"project_1500"},
  {"store":"play_store","productId":"tomverse_credits4000","kind":"credits","packId":"power_4000"}
]
```

Configure RevenueCat to **keep purchases with the original App User ID** on
restore (never transfer between accounts). The app signs in before configuring
the SDK and uses an opaque server-created billing ID; it does not create
anonymous purchases. Enable App Store Server Notifications and Google RTDN
through RevenueCat, and deliver webhooks to /api/webhooks/revenuecat. Include
purchase, renewal, cancellation, expiration, billing issue, product change and
non-renewing purchase events. Verify delivery and refund redelivery before
activation. A store receipt is never assigned to a different Tomverse account.
If RevenueCat reports an unknown customer or transfer, investigate instead of
changing ownership from the webhook.

The server also binds each store transaction and subscription original
transaction to one billing identity. These keyed-hash ownership tombstones have
no user foreign key and survive account deletion. Restoring or transferring a
receipt cannot grant it to another account, even if the provider restore setting
is changed. Subscription access waits for a verified webhook to bind its current
transaction; an SDK success alone cannot grant it. An unbound receipt is shown
as pending and cannot start another subscription purchase. Refund/revocation
always removes absent old entitlements even when a different receipt is pending
or belongs to another account. Configure webhooks before
allowing purchases. Keep the ownership key stable for retained tombstones;
rotation requires compatible lookup of the previous key, never deleting the
ownership records. No raw receipt or account ID is retained in that registry.

Apply the additive migration through the normal approved deployment workflow.
The new web-plan column remains null for existing rows: old application
instances can continue writing plan while migration and rollout overlap. New
writers set the separate web snapshot explicitly; readers fall back to plan
until then.
Run cap sync after installing dependencies; the sync hook changes Android
MainActivity to singleTop so banking-app confirmation does not cancel the
purchase. Enable the In-App Purchase capability in the iOS Xcode target.
Finalize the currently provisional bundle/application ID before registering
products. Store credentials, agreements, tax/banking details, product review,
pricing and a RevenueCat account are required operational setup; choose and
approve the provider's commercial terms before production activation.
The initial catalog uses standard recurring base plans without introductory,
trial or installment offers. Add those offers only with their complete pricing
phase disclosures and device validation.

## Verification

Local PC / PowerShell / repository root. These commands use mocked stores or an
explicitly isolated test database; no production credentials or paid calls:

```powershell
npm --workspace @tomverse/mobile run typecheck
npm --workspace @tomverse/mobile run build
node --conditions=react-server --import tsx --test tests/mobileBilling.test.mjs
node --conditions=react-server --experimental-test-module-mocks --import tsx --test tests/server-contract/mobile-billing-route.test.ts
npx playwright test --config playwright.native.config.ts
```

The normal DB integration runner includes mobile-store-billing.db.test.ts.
It exercises concurrent duplicate delivery, cross-account replay, non-expiry,
refund debt, reordered refund/purchase events, in-flight reservation release,
and subscription reconciliation. The migration was separately applied to a
local copy of the previous schema and compared against schema.prisma.

Before release, use TestFlight sandbox and Play internal-test/license testers
on physical devices. Cover localized monthly/annual totals, purchase approval,
pending/declined/cancelled payment, immediate upgrade, scheduled downgrade,
cancel/resume, restore after reinstall, account switching, renewal, grace,
expiry and refund. Verify web access and the same monthly usage after each
transition. Mock UI tests and an Android compilation are not store/device
evidence. iOS compilation requires macOS/Xcode.

Official references checked 2026-10-25:

- [Apple review guidelines 3.1.1–3.1.3](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase)
- [Play payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)
- [Play subscription disclosures and cancellation](https://support.google.com/googleplay/android-developer/answer/9900533)
- [RevenueCat Capacitor SDK](https://www.revenuecat.com/docs/getting-started/installation/capacitor)
- [Subscription changes](https://www.revenuecat.com/docs/subscription-guidance/managing-subscriptions)
