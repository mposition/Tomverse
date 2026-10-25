# Tomverse Chat and Review product switcher — UI contract

- Status: implemented UI boundary; release, merge and deployment are separate.
- Owner: Product
- Coverage: `tests/client/chatProductSwitcherRender.test.tsx` and
  `tests/e2e/chat-product-switcher.spec.ts`.

Tomverse Chat and Tomverse Review are separate products with separate jobs.
Chat offers question refinement and per-message Smart Adaptive model selection.
Review lets the user choose models directly and compare answers side by side.
The product switcher must keep that distinction visible without presenting
Smart Adaptive as a third product.

## 1. The switcher navigates; it never rewrites

The Chat and Review segments are links to the canonical product roots:

- Tomverse Chat: `/chat`
- Tomverse Review: `/review`

The active link carries `aria-current="page"`. Following either link starts or
restores that product's own workspace state. The switcher does not PATCH the
open conversation, rewrite `productKey`, change selected models, change Smart
Adaptive mode, or move a draft between products.

An existing conversation continues to use its stored product. Deep-link routing
and ownership checks remain server-owned. A route transition is never evidence
that a stored conversation changed product.

A Chat continuation of an imported conversation also offers "Compare models in
Review" beside its provenance line (owner decision 2026-10-25). That is not the
switcher: it is an explicit, labelled action that creates a new Review
conversation from the same imported original and opens it, and the Chat
conversation keeps its product (`docs/policy/external-conversation-continuation.md`
§3.1).

The navigation callback may stage one idle in-memory draft snapshot immediately
before following a product link. It does not persist, publish or copy that draft
into the other product. While a send, stream, mode write, recovered unknown
write or draft conflict is active, both links expose the localized pending
reason and navigation is blocked. Direct URL changes, browser Back and unmount
do not stage a raw draft, so an unknown write cannot be replayed as another
Send.

## 2. Product and mode are separate controls

The product switcher names Tomverse Chat and Tomverse Review. Smart Adaptive's
ON/OFF switch appears separately inside the Chat composer and model picker. It
changes Chat's model-selection mode only after server confirmation; it does not
navigate to Review.

Directly choosing a model belongs to Review, or returns an existing Chat
conversation to its confirmed manual fallback as defined by
`auto-model-selection.md`. The product switcher does not perform either write.

## 3. Entry and availability

The landing page may link an eligible signed-in visitor directly to Chat. A
guest Chat product card or product-switcher link enters a blank `/chat` trial
directly, where the existing guest usage limits apply to a single-model reply.
`guestTrialAvailable` admits this blank entry independently of Auto's `offered`;
it never grants Smart Adaptive or Prompt Refiner capability. Guest Smart Adaptive
may refine a text question and select a model only when the server offers it,
within the same existing Guest quota. The first Guest version is text-only;
attachment sends retain manual model selection. When the server does not offer
Auto, its controls remain absent and the manual trial remains available.
The landing card describes this conditional Guest access and browser-local
storage. Sign-in does not automatically save or import a Guest Chat into an
account. A signed-in account that the server has not offered Chat sees an
availability notice and a working Review alternative; the client never derives
eligibility from a flag or reveals a cohort reason.

The marketing document stays static. Its public Guest entry is a server-supplied
constant and reads no session, account row, auth secret or Auto availability at
build time. Once `useSession` resolves an authenticated user ID, the landing
reads the existing private `/api/products/chat/capabilities` GET with `no-store`
and accepts only its `autoSelection.offered` boolean for link availability.
The landing makes no Guest capability request; Guest Smart Adaptive availability
is resolved separately by the canonical Chat workspace's server capability.
Each resolved signed-in identity mounts an unavailable
view and aborts the preceding read; late responses, including A-to-B-to-A, cannot
restore a previous account's link. Failed, malformed or unknown reads retain the
availability notice and Review alternative. This read grants no authority and
neither changes the static CSP/cache boundary nor enables a Guest Auto control.

Review keeps its guest preview boundary, and the landing hero and final primary
comparison CTA retain `/review?entry=guest-preview`. Guest URLs that name a saved
Chat conversation fail closed rather than probing an account's rows. No entry
action sends a message, creates a paid turn, or silently creates a conversation.

## 4. Responsive and accessible shape

- Both product targets are at least 44px tall.
- Narrow layouts show the short `Chat` and `Review` labels. Their accessible
  names include the full product name, secondary feature name and description.
- Wider layouts may show the secondary feature labels: `Smart Adaptive` and
  `Model Compare` (localized).
- The switcher occupies a row outside the textarea. It may not reduce the
  textarea's dedicated full-width row or introduce horizontal page overflow.
- On mobile the compact switcher appears in the composer's own top navigation
  row while the bottom dock has normal room, and remains available in the
  conversation drawer as a second route. A keyboard-covered, landscape or
  otherwise compact bottom dock may omit its duplicate and leave the drawer as
  the navigation route. Both
  instances use the same canonical links and `onProductSwitch` admission; the
  composer instance never writes `productKey`, copies a draft, or changes the
  selected models. This narrow placement exception was owner-approved with the
  Composer design on 2026-10-13 Australia/Brisbane time (the owner's actual
  approval date and timezone)
  ([Figma](https://www.figma.com/design/SKTapwjDJz4DUwjlZMKsCI?node-id=2-71)).
  The top navigation row is independent of the textarea. Its supplementary
  product context is desktop text, and is absent on mobile before it can
  narrow the input. The composer's Smart Adaptive switch stays directly
  accessible without opening the drawer.
  In an active multi-model conversation with less than 800px of visible
  height, the shell may omit this duplicate composer instance while the drawer
  route remains available. Empty/new conversations and taller layouts retain
  the approved Composer row.
- On both desktop and mobile, a fully supported web-search chip sits in the
  footer tools group beside model selection. Partial or blocked search remains
  in the independent status row with its detail or recovery action.
- The current state is expressed by `aria-current`, border and surface
  treatment, not colour alone.

## 5. Copy boundary

Primary product names are `Tomverse Chat` and `Tomverse Review`. Secondary
feature names are `Smart Adaptive` and `Model Compare` (Korean: `스마트 자동`,
`모델 비교`). Smart Adaptive is a product label chosen by Tomverse, not a
market-standard term or a quality certification. Copy must not promise a best,
better, optimal or winning model. Guest copy must not require sign-in for Smart
Adaptive, promise an always-visible Auto control, automatic attachment routing,
or automatic account storage/import of browser-local Guest chats.
