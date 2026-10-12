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
guest Chat action goes through the normal sign-in flow with `/chat` as its
callback. A signed-in account that the server has not offered Chat sees an
availability notice and a working Review alternative; the client never derives
eligibility from a flag or reveals a cohort reason.

Review keeps its guest preview boundary. No entry action sends a message,
creates a paid turn, or silently creates a conversation.

## 4. Responsive and accessible shape

- Both product targets are at least 44px tall.
- Narrow layouts show the short `Chat` and `Review` labels. Their accessible
  names include the full product name, secondary feature name and description.
- Wider layouts may show the secondary feature labels: `Smart Adaptive` and
  `Model Compare` (localized).
- The switcher occupies a row outside the textarea. It may not reduce the
  textarea's dedicated full-width row or introduce horizontal page overflow.
- On mobile it lives in the conversation drawer so the closed input dock keeps
  its height at page zoom and on short screens. The composer's Smart Adaptive
  switch stays directly accessible without opening the drawer.
- The current state is expressed by `aria-current`, border and surface
  treatment, not colour alone.

## 5. Copy boundary

Primary product names are `Tomverse Chat` and `Tomverse Review`. Secondary
feature names are `Smart Adaptive` and `Model Compare` (Korean: `스마트 자동`,
`모델 비교`). Smart Adaptive is a product label chosen by Tomverse, not a
market-standard term or a quality certification. Copy must not promise a best,
better, optimal or winning model.
