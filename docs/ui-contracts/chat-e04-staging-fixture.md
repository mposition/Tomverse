# CHAT E04 Staging Fixture Contract

## Status

- Contract type: narrow, administrator-only staging QA exception
- Applies to: `/admin/chat-e2e`, `/api/admin/chat-e2e-fixture`, and the
  document-local transport installed by that page
- Severity when violated: the E04 result is invalid and the fixture must not be
  used
- Product effect: none; public Chat behavior is unchanged, while Prompt Refiner
  remains default-off and provider-disconnected

This contract exists only so one exact staging build can exercise the real
`ChatPageClient` and `ChatInput` integration with deterministic, no-cost
responses. It does not authorize a product rollout, a provider call, an auth or
database bypass on public staging, or any write to product state. The existing
Prompt Refiner rules in
[`prompt-refiner-suggestion.md`](./prompt-refiner-suggestion.md) remain the
product contract.

## Entry and authorization

The page and its only server endpoint are fail-closed:

- the canonical deployment resolver must return `staging`;
- the request must carry a real application session; and
- that session must pass the existing administrator check.

Both the page and the read API repeat this decision on the server. Production,
development, anonymous, and non-administrator access return an unavailable
surface rather than revealing a QA mode. The page is not linked from public
Chat and is not a feature-flag activation path.

`GET /api/admin/chat-e2e-fixture?action=<value>` additionally requires explicit
same-origin evidence accepted by the existing origin guard: a valid `Origin`,
`Sec-Fetch-Site: same-origin`, or a valid same-origin `Referer`; missing evidence
is rejected.
Its raw encoded query component is capped at 512 UTF-8 bytes and must contain
exactly one parameter named `action`. Duplicate `action` parameters, any
additional parameter, a request body, and any other method are rejected. Every
response produced by this read handler is `Cache-Control: private, no-store`.
The only accepted values are:

- `default_off`
- `accepted`
- `kept_original`
- `stale`
- `replay`
- `unknown`

No prompt, message, comparison, model, provider, projection, authority, or
arbitrary payload is accepted from the browser. A value outside this closed
list fails before the synthetic read runs.

The endpoint retains normal session and administrator authorization on every
request. It deliberately adds neither step-up authentication nor a
fixture-specific rate limiter: an accepted query can only select one of six
fixed, pure synthetic results, and those results have no mutable state,
irreversible effect, LLM or provider call, product writer, or cost. If any of
those conditions changes, this rationale expires and the endpoint must fail
closed until a new authorization and abuse-control contract is approved.

Local browser tests may use the repository's existing loopback-only full-fixture
guards and local test-JWT convention. Real staging uses the normal owner or
administrator sign-in and never accepts the local JWT. This exception does not
change those guards and must never enable an auth or database bypass on public
staging.

## The real UI and the sealed transport

The fixture mounts the production `ChatPageClient` and `ChatInput` components.
It must not replace them with a QA-only Chat UI. The fixture transport is
installed before those components mount, so their first request is already
inside the synthetic boundary.

The real administrator session authorizes entry on the server. Inside the
sealed Chat subtree, a fixed synthetic session, conversation id, model and
content replace the operator's product identity and data. The fixture must not
load, mutate, or display the administrator's real conversations or account
content.

For the lifetime of the document, the transport intercepts `fetch`,
`XMLHttpRequest`, and `sendBeacon`. It returns deterministic responses only for
the explicitly registered same-origin Chat dependencies. An external URL, an
unregistered path, an unsupported method, or an invalid body is blocked
fail-closed. The sole request allowed through to the server is the exact
administrator fixture read endpoint above.

Unmount retires the transport without restoring product networking. A callback
that retained the old transport after retirement is still blocked. Leaving QA
uses a hard navigation to a fresh document; restoring a live product transport
inside the QA document is forbidden.

The diagnostic panel is always visible and identifies the surface as synthetic
QA. The sealed transport initializes `providerCalls`, `costMicroUsd`,
`productDatabaseWrites`, and `auditWrites` to literal zero before the Chat UI is
permitted to mount. Those four fields are immutable construction markers, not
measurement counters. They document the transport's declared shape and must
not be cited as independent proof that no provider, cost, database, or audit
activity occurred. Runtime evidence instead comes from the browser's native
network observation, the closed transport allowlist, and `blockedRequests`.

The construction markers do not count or make a claim about normal session,
administrator layout, model, consent, or account reads that the server performs
before the transport exists. They also do not erase or characterize
authentication or audit activity that occurred before the observed fixture
interaction.

## Synthetic behavior covered

The fixture may exercise only deterministic stand-ins registered in its sealed
transport:

- existing conversation history, a new Chat send, context preparation and
  context-bundle reuse;
- one fixed failure, question restoration, and a subsequent explicit Send on
  the real Chat UI;
- Prompt Refiner proposal preview while the product remains default-off;
- attachment prepare, document-local upload/finalize, message binding, and
  synthetic reload observation;
- web-search presentation from a fixed answer and citation trailer;
- generated-artifact progress, trailer, card, and fixed download bytes; and
- voice-composer wiring through a fixed browser media/transcript stand-in.

Conversation messages, drafts, attachments, and their reload observation are
held only in page memory or `sessionStorage`. `sessionStorage` is observation
state for this QA document, not persistence evidence. Reset clears that state.
No product conversation, message, draft, attachment, artifact, search, memory,
usage, credit, or audit writer is called by the synthetic fixture interaction.
Normal server-side authentication and administrator authorization reads remain
outside the transport and continue to use the existing application paths.

Voice coverage proves only the component wiring against the fixed stand-in. It
does not test a physical microphone, operating-system permission behavior,
browser codec or MIME negotiation, speech quality, transcription quality, or
any model. Attachment coverage likewise does not prove real object storage,
malware scanning, operating-system file-picker MIME reporting, or durable
product persistence. Search and artifact coverage prove rendering and client
integration against fixed bytes, not retrieval quality, citation truth,
artifact generation, or download infrastructure.

The search trailer's provider label and citation are fixed display metadata.
They are not evidence that the named provider ran or that the synthetic source
exists. The artifact bytes are likewise compiled fixture content.

## Proposal and Auto boundaries

The proposal mode uses the existing Prompt Refiner fixture seam and the real
composer. Previewing a proposal preserves the authored source. The fixture does
not write the proposed text into a product draft or authorize a Chat dispatch
from the preview state.

The stateless server read runs the existing D02 synthetic Auto facade against
server-owned fixed strings. Each closed action verifies its corresponding
default-off, accepted, kept-original, stale, replay, or unknown-outcome branch.
Every result must retain `dispatchAuthorized: false`, preserve the authored
source contract, and return the four literal zero construction markers. Those
markers are not activity measurements. The `unknown` action remains stopped;
it is not retried or converted to success.

This fixture does not activate Auto, authorize dispatch, record a disposition,
or demonstrate that a product Auto caller exists. It also supplies no release
gate evidence beyond the exact synthetic branch that was run.

## Evidence and claim limits

An E04 browser result is bound to the exact commit and exact staging deployment
that served the page. A result from another build, an earlier deployment, a
local run, or a later reload after deployment replacement does not transfer.
The evidence record must retain the deployment identity, the browser-observed
native request list after the Chat tree mounted, `blockedRequests`, and the
diagnostic marker snapshot.

The fixture can support the following claims for that exact build only:

- the real Chat component tree completed the named synthetic interaction;
- after the real Chat tree mounted, browser network observation found no native
  request from the fixture interaction except the exact administrator read
  endpoint, while unregistered attempts incremented `blockedRequests`; and
- the fixed D02 action returned `dispatchAuthorized: false`.

It cannot support claims about provider quality, model quality, product
persistence, real attachment storage, real search, real artifact generation,
real voice hardware, paid execution, Prompt Refiner rollout, Auto rollout, or a
release-gate pass. It contains and accepts no holdout source, expected answer,
rubric, counterexample, or evaluation result. Untested behavior remains
unverified.

Passing this contract never carries a prior gate disposition forward. Any gate
or later evaluation must bind its own evidence to its own exact target.

## Required verification

The exact candidate must keep all of these checks:

- access tests for staging administrator success and production, development,
  anonymous, non-administrator, missing-origin, and cross-origin refusal;
- strict GET-only six-action parsing, the 512-byte encoded-query cap, and
  rejection of duplicate or additional parameters, request bodies, client
  prompt, comparison, and dispatch-authority inputs;
- D02 synthetic action tests showing source preservation,
  `dispatchAuthorized: false`, stopped unknown outcome, and all four literal
  construction markers;
- transport tests showing external and unregistered requests, beacon, XHR, and
  late callbacks are blocked while the one administrator read endpoint is the
  only native server request;
- browser tests on the real Chat UI for default-off, proposal preview, context,
  failure, question restoration, explicit resend, reload observation,
  attachment, search, artifact, fixed voice wiring, and all six Auto actions;
  and
- an exact-build staging observation that records the deployment identity,
  browser native request list, `blockedRequests`, and diagnostic marker
  snapshot.

Local tests and CI verify the contract's deterministic structure. Only the
exact staging browser observation verifies that the deployed build exposed the
administrator-only surface and kept its transport sealed during the named
flows.
