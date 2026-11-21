# External inference API (`/api/v1`, `/api/code/v1`)

Status: implemented, default off. Live activation, paid smoke tests and the
production migration are separate, approved steps (section 9).

The API lets an account use its existing Tomverse models and credits from
other apps and coding tools. Two APIs (owner decision 2026-11-21), decided by
the address alone, on one key, one plan check (Pro or Max) and one ledger:

- **The general API** -- `/api/v1/*` and `/api/anthropic/v1/*` -- for AI
  browsers and apps: Aside, Brave Leo, Raycast, BrowserOS and other
  OpenAI-compatible apps. It always offers the chat registry's models.
- **The coding API** -- `/api/code/v1/*` (`chat/completions`, `responses`,
  `models`, `usage`, `requests/status`) and `/api/code/anthropic/v1/*`
  (`messages`, `messages/count_tokens`, `models`) -- for Claude Code, Codex,
  Cursor, the tomverse CLI, VS Code (GitHub Copilot Chat's custom endpoint,
  a coding assistant) and JetBrains AI Assistant (OpenAI-compatible provider,
  no Anthropic format; owner decision 2026-11-21). While `CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED`
  is off (the default) it offers and runs exactly what the general API does;
  on, it offers the coding catalogue's models (section 5, "Which models").
  The same handlers serve both, told which API the route is
  (`lib/externalApiCatalog.ts` `ExternalApiSurface`); the User-Agent decides
  nothing.

Three wire protocols, on both APIs:

- **OpenAI Chat Completions** (`.../v1/chat/completions`): Aside (Custom
  Provider, Pi `openai-completions`), Brave Leo, Raycast, BrowserOS and other
  apps on the general API; Cursor (OpenAI base-URL override), VS Code (Custom
  Endpoint, `chat-completions`), JetBrains AI Assistant and the tomverse CLI on
  the coding API.
- **Anthropic Messages** (`.../anthropic/v1/messages`): Claude Code, CLI and
  the official VS Code extension, on the coding API (section 10).
- **OpenAI Responses** (`.../v1/responses`): Codex, CLI and the official VS
  Code extension, on the coding API (section 10).

It is a stateless inference gateway. It is not a Tomverse agent, not a tool
runner and not a separate billing product. The coding tool runs its own agent
on the person's computer; Tomverse answers each model step.

## 1. What one request is

- One generation request (`POST /api/v1/chat/completions`,
  `/api/v1/responses` or `/api/anthropic/v1/messages`) is one provider generation. The server
  never executes a client tool and never loops. A tool call goes back to the
  client; the client's next request carrying the tool result is a new request
  with its own reservation and receipt.
- No automatic model fallback and no SDK retry (`maxRetries: 0`). A request
  whose outcome is unknown is never re-sent by the server.
- Nothing is added to the request: no memory, Refiner, Review, web search,
  conversation history or system prompt of Tomverse's own. No `Conversation`
  or `Message` row is written, and `Conversation.productKey` is untouched.
- Nothing is stored at the provider on Tomverse's side either: OpenAI calls
  always send `store: false` (the Responses API stores by default).

## 2. Switches

All default off. Server-side; hiding UI is never the gate.

| Variable | Meaning |
|---|---|
| `EXTERNAL_API_ENABLED` | Exactly `true` turns the routes on. Anything else: every `/api/v1` route answers 503 `feature_unavailable` and nothing is dispatched. |
| `EXTERNAL_API_ALLOWED_USER_IDS` | Comma-separated user IDs allowed to manage and use keys, or `*`. Empty means nobody. `*` still means paid accounts only: a Free account is refused whatever this list says (section 3). |
| `EXTERNAL_API_PUBLIC_BASE_URL` | Optional canonical base URL of the general API shown to users (e.g. `https://tomverse.app/api/v1`). Otherwise derived from the request host. The coding API's base is the same with `/api/code/v1` (`lib/externalApiCodingTools.ts` `codingApiBaseUrl`). |
| `CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED` | Exactly `true` makes the coding API offer the coding catalogue's models (section 5). Off, the coding API offers the chat registry like the general API. The general API never reads it. Kept under its earlier name, so nothing has to be renamed in an environment that already has it. |
| `NEXT_PUBLIC_EXTERNAL_API_SETTINGS_VISIBLE` | Build-time. Shows the API keys row in the settings panel. `/settings/api` itself checks availability through the server. |
| `EXTERNAL_API_REQUESTS_PER_MINUTE` / `_PER_DAY` | Per-account request-rate abuse guard, defaults 120 / 20 000. Credits, the key cap and concurrency are what bound usage; this only stops runaway clients. |
| `EXTERNAL_API_HEARTBEAT_MS` | How often an in-flight request renews its concurrency slot and reservation, default 60 000. Runs from dispatch, including the wait for a streaming request's first part. Lowered only by tests. |
| `EXTERNAL_API_READS_PER_MINUTE` / `_PER_DAY` | Separate per-account budget for `GET /models`, `GET /usage` and `GET /requests/status`, defaults 60 / 5 000. The settings read routes (key list, receipts) have a fixed 60 / 5 000; revocation has none, so it always works. |
| `EXTERNAL_API_TIMEOUT_MS` | Server timeout for one generation, default 600 000. |
| `EXTERNAL_API_ANTHROPIC_ENABLED` | Exactly `true` (and `EXTERNAL_API_ENABLED`) turns on the Anthropic Messages routes for Claude Code: `POST /api/anthropic/v1/messages`, its `count_tokens` and `GET /api/anthropic/v1/models`. Off: 503 `feature_unavailable`, nothing dispatched. |
| `EXTERNAL_API_RESPONSES_ENABLED` | Exactly `true` (and `EXTERNAL_API_ENABLED`) turns on `POST /api/v1/responses` for Codex. Off: 503, nothing dispatched. |
| `TOMVERSE_CLI_GUIDE_ENABLED` | Exactly `true` shows the Tomverse CLI install and connect card in Settings > Developer and Settings > API keys (section 11). Off until the package is published, so the page never points at a package that is not on the registry. It turns nothing on in the API. |
| `EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED` | Exactly `true` lets Smart Adaptive (section 5.1) ask Chat's router model which candidate answers. Off by default, because each routed request adds one router call, held against the provider operational budget rather than the user's credits. Off, `smart-adaptive` still works and every request goes to the default model (on a native protocol, that provider's default, section 10.6). |

**Kill switch.** The Admin operational pause for AI chat
(`feature.aiChatEnabled`) stops every new external dispatch at once (503
`AI_CHAT_DISABLED_BY_ADMIN`), because admission goes through the same
`acquireChatAccess`. Setting `EXTERNAL_API_ENABLED` to anything but `true`
stops it at the next deployment. Requests already dispatched keep running and
are settled normally in both cases. Revoking a key stops that key immediately.

## 3. Keys

- Format `tvk_<8 lowercase alphanumerics>_<43 base64url>` (256 random bits).
  `tvk_xxxxxxxx` is the public prefix shown in lists, receipts and the audit
  log. The database stores the SHA-256 digest of the whole key and never the
  key; the key is returned once, in the create response.
- A key authorises only: inference, `GET /api/v1/models` for its account, and
  `GET /api/v1/usage` for itself. It cannot manage keys, read another key,
  reach billing, Admin, account deletion or any Chat data.
- Management (`/api/user/api-keys`) uses the signed-in browser session and
  the ordinary same-origin check, and refuses any request that carries an
  `Authorization` header instead of falling back to the cookie. The Bearer
  routes read no cookie or session; that is the condition for exempting
  exactly `POST /api/v1/chat/completions` from the mutation Origin check
  (`lib/requestOrigin.ts`), pinned by `tests/externalApiBoundary.test.mjs`.
- Each key has a name, optional expiry (7/30/90/365 days or none), and an
  optional lifetime credit cap. At most 10 active keys per account. Rotation is
  create-new then revoke-old. Revocation is always possible, even after the
  feature is switched off for the account: the settings page still lists
  existing keys, with revoke as the only action.
- **Paid plans only** (owner decision 2026-11-19). Access needs the switch, the
  allowlist and a Pro or Max effective plan (`externalApiPlanAllowed`, read
  through `getUserBillingPlan`, so a lapsed subscription counts as Free). A
  Free account cannot create a key (403 `PLAN_NOT_ELIGIBLE` from
  `createExternalApiKey`), and every keyed request (`lib/externalApiAccess.ts`:
  Chat Completions, Anthropic Messages, Responses, `/models`, `/usage`,
  `/requests/status`) re-reads the plan, so a key made on a paid plan answers
  403 `plan_not_eligible` once the account is Free. The Tomverse CLI is a Chat
  Completions client and is refused the same way. A Free account still lists,
  renames and revokes its keys; Settings > API keys shows it an upgrade prompt
  instead of the create button.
- Create, rename, cap change and revoke are written to the hash-chained audit
  log in the same transaction, with the prefix and never the secret or digest.
- Unknown, revoked and expired keys, and keys of a suspended or
  deletion-scheduled account, all answer 401 `invalid_api_key`.

## 4. Credits

The API uses the account's existing plan and purchased credits through the
shared reservation (`ChatCreditReservation`, `source = external_api`). There is
no API wallet, no new price and no per-token billing for the user.

- Admission is `acquireChatAccess`: one credit-account lock serialises every
  request of the account from the web, the API and all its keys, so the shared
  balance cannot be over-reserved. Concurrency and the cost guardrails use the
  same account subject, so extra keys or IP addresses do not raise any limit.
- Inside that same transaction the admission hook (`lib/externalApiAdmission.ts`)
  re-reads the key `FOR UPDATE`, refuses a key revoked or expired since
  authentication, enforces the key cap, and binds the request. A refusal rolls
  back the whole hold.
- The key cap counts everything the key has committed: settled credits plus
  the full held amount of every reservation still `reserved` (in flight, or
  dispatched with an outcome not yet resolved). Concurrent requests cannot
  pass it.
- The estimate behind the reservation includes the whole message history,
  tool schemas, earlier tool calls and tool results, and each image (provider
  image-token rules). The output reservation is the request's
  `max_completion_tokens`/`max_tokens` when given, otherwise the model's
  maximum, and the provider is sent exactly that limit: output is never
  allowed beyond what was reserved.
- Settlement is the existing contract (`getSettledUsageCredits`):

| Outcome | User credits | Provider cost recorded |
|---|---|---|
| completed — text, tool calls only, or reasoning only | the reserved credits | reported usage; if usage is missing, the reservation's own estimate |
| empty — no text, tool call or reasoning | 0 | reported usage, or the estimate |
| cancelled — client disconnect or timeout | pro rata if more than 16 output tokens were produced | reported usage, or the streamed output estimate (the larger of the script-aware text estimator and bytes/4, over text, reasoning and tool arguments) |
| failed — provider refused with a 4xx (not 408) before any output | 0 | 0 (the provider refused) |
| failed — provider answered a 5xx or 408 before any output | 0 | reservation estimate (the provider may have processed it) |
| failed — any other failure (network, mid-stream) | 0 | the reservation's estimate, never 0 by assumption |
| refused before dispatch | nothing held | nothing |

A reservation whose process died, or whose settlement failed, stays `reserved`
and is settled by the existing expired-reservation reconciliation
(`reconcileExpiredChatCreditReservations`). Long streams extend the
reservation every minute so the sweep does not close a live call.

## 5. API contract

Base URL `https://<host>/api/v1` (general) or `https://<host>/api/code/v1`
(coding). Bearer authentication only. Every endpoint below exists on both.

**Which models.** On the general API, and on the coding API while
`CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED` is off, the chat catalogue is the
only list. A model is offered when the runtime registry serves it to the
account's plan (enabled, status enabled or limited, not deleted), it is not a
research or deep-research model, and its provider has a credential on this
deployment. There is no second, operator-kept list of ids: enabling a model in
the catalogue offers it here too.

With the switch on, the coding API offers the rows of the newest coding
snapshot whose channels include the coding API (`api`, or `cli` saved before
the CLI moved onto the coding API) and that the coding judge still admits now
(docs/policy/code-task-cost-guardrails.md 6.3). A chat link runs and bills as
its chat registry model. A coding row chat does not have (a dedicated row)
runs as its own published row: its API model id, context, output limit, input
and output prices, through the same reservation, provider budget,
concurrency, key cap and settlement as every request here. Its credits follow
the chat rule (owner decision 2026-11-21): this API takes at most the chat
input limit (`CHAT_USER_MAX_INPUT_TOKENS`) and settles with the chat input
multiplier, so a request is charged the row's `apiCreditWeight` when the
operator set one, otherwise the chat catalogue's own floor
(the arithmetic `suggestCreditFloor` and the chat guardrails use -- credits x
input multiplier x `COST_PER_CREDIT_CEILING_MICRO_USD` covering the worst turn
-- worked out directly, not rounded up to a chat class: at every
input-multiplier band's largest input up to that limit, the row's output
ceiling and, for Anthropic, 1.25x input, the largest of them, so a short prompt
with a full answer at x1 is covered too; above 1,000 credits it counts as
unworkable), worked out when the request is priced and never stored. Such a
row takes no more input than that limit even where Chat's long context is on:
a longer request is refused with `CHAT_INPUT_TOKEN_LIMIT` before anything is
held or sent. An override below that floor, or a floor that cannot be worked out,
keeps the row off this API. Code's managed path keeps the row's
`pricing.creditWeight`. The reservation and the settlement record
`creditBasis` (`chat_rule_floor` or `api_override`, the credits and the
floor), and `credits_per_request` lists the same credits. Its
reservation records `pricingVersion: coding_catalog_snapshot:<version>:<hash>`
and `costSource: coding_catalog_snapshot`, and the settlement's pricing
snapshot carries both, so a receipt names the catalogue version it was charged
at. An unverified cache discount is full input price; an Anthropic row bounds
a client's cache marker at 1.25x its own input price. A dedicated row is
offered only while the row the judge admits now is exactly the published one,
and never for inference hosts, aggregators or Perplexity
(`CODE_MANAGED_UNBOUNDED_PROVIDERS`). No snapshot, or one past its coverage,
offers nothing on the coding API.

| Endpoint | Purpose |
|---|---|
| `GET /models` | OpenAI model list of what this key's account can run now. Tomverse facts under `tomverse`: capabilities, `context_window_tokens`, `max_output_tokens`, `credits_per_request`. |
| `POST /chat/completions` | Chat Completions, streaming or not. |
| `GET /usage?limit=50` | Tomverse-specific: this key's cap, committed and held credits, and recent request receipts. |
| `GET /requests/status` | Tomverse-specific, read only: the receipt of **one** request of this key, by `?request_id=req_…` or by the `Idempotency-Key` header it was sent with -- exactly one of the two. For a client that lost a response (before or after its headers) or keeps a session longer than the 100 receipts `/usage` lists. Never dispatches, reserves or changes anything; returns no output (none is stored). Another key's request, another account's and a missing one answer the same `404 request_not_found`, and not found is not evidence that nothing was sent or charged: a request may not have arrived or been admitted yet. `usage_source: server_settlement` because the row does not say whether the token counts came from the provider or the reservation estimate. |

**Supported request fields:** `model`, `messages` (roles `system`,
`developer`, `user`, `assistant`, `tool`; text parts; `image_url` parts with
base64 `data:` URLs of PNG, JPEG, WebP or GIF up to 8 MB each, 16 per request;
`detail` `low`/`high` is forwarded to OpenAI and refused for other providers),
`stream`, `stream_options.include_usage`, `tools` (function tools, up to 128,
64 KB per schema; `strict: true` only for providers whose adapter forwards it: OpenAI, Mistral, Moonshot;
and custom tools, free-form input with an optional `text` or `grammar` format, which Cursor's GPT Agent
sends -- every provider here takes JSON tools only, so a custom tool reaches the model as a function with one
`input` string and its grammar in the description, described rather than enforced, and its calls go back as
function calls whose `arguments` is the raw input rather than JSON, streamed as one fragment when the call
completes -- Cursor reads and echoes a custom tool's call only in that form; a `custom` call in history is still accepted), `tool_choice` (`none`, `auto`,
`required`, or a named function or custom tool), `parallel_tool_calls: true`, `max_tokens`, `max_completion_tokens`,
`temperature`, `top_p`, `frequency_penalty`, `presence_penalty` (forwarded where the
model accepts a temperature, including models registered with reasoning `none`;
for a model that takes none of them they are left out of the call and named in
the `x-tomverse-ignored-parameters` response header, because coding clients send
them on every request -- VS Code always sends a temperature), `stop` (up to 4), `n: 1`, `store: false`,
`user` (accepted, no effect), `reasoning_effort` (OpenAI reasoning models only), and its
Responses-API spelling `reasoning`, either `{ effort, summary }` or a bare effort string, which Cursor
sends for a model name it recognises (a string with `gpt-6-luna` on production, 2026-11-20). It is a client
default, not the caller's choice: `effort` is sent where the model takes `reasoning_effort` and otherwise
left out (a string that is no known effort, such as `none`, always is), with `reasoning` named in
`x-tomverse-ignored-parameters` -- unlike `reasoning_effort` itself, which is refused where it cannot
apply. Both sent and different is refused. `summary`, which has no place in a Chat Completions answer, is
left out and named in the same header.
The request body may be up to 12 MB.

**Refused with a typed 400:** any other field (`unsupported_parameter`, naming
it), a `name` on a system, user or assistant message (no provider here has participant names; a tool message's `name`, which Cursor sends, is accepted and ignored, as is a history tool call's stream `index`), `n` other than 1, `store: true`, `parallel_tool_calls: false`, both token
limits with different values, a token limit above the model's maximum, images
for a model without image input, remote image URLs (never fetched), a tool
result answering no earlier tool call, and `strict: true` on a tool for a provider that would drop it.
Unknown fields are refused at every level -- messages, content parts, tool
calls, tool definitions, `tool_choice` and `stream_options`. Nothing is silently dropped; the sampling parameters above are the one
exception, and they are named in a header.

**Responses.** One choice. A tool-only reply has `content: null`,
`tool_calls`, and `finish_reason: "tool_calls"`. A provider stop for length or
a content filter is reported as `length` / `content_filter` even when a tool
call had started, and a call the provider never finished is left out of a
non-streaming `tool_calls`, so a truncated argument is never offered as a
finished call. A reply the provider's content filter blocked entirely is a
normal `200` with `content: null` and `finish_reason: "content_filter"`, charged
nothing. `usage` is `null` when the
provider reported none — never zeros. Streaming sends `chat.completion.chunk`
events with one completion id, the assistant role once, text deltas, tool-call
fragments (id and name on the first fragment of each call, indexed by first
appearance), a final chunk with `finish_reason`, then — with
`include_usage` — a usage chunk with empty `choices`, then `data: [DONE]`. A
failure after the stream started ends with an `error` event and **no**
`[DONE]`, so a client can tell an interrupted answer from a finished one.
Every response carries `x-request-id`, the receipt ID.

**Errors** use the OpenAI shape `{ "error": { message, type, code, param } }`,
with Tomverse limit details under `tomverse` where they exist.

| Status | Codes |
|---|---|
| 400 | `invalid_json`, `invalid_request`, `unsupported_parameter`, `conflicting_parameters`, `max_tokens_too_large`, `invalid_tool`, `invalid_tool_choice`, `invalid_tool_call`, `invalid_tool_result`, `unsupported_image_url`, `unsupported_image_type`, `invalid_image`, `model_does_not_support_images`, `invalid_request_selector` and `invalid_idempotency_key` (status lookup) |
| 401 | `invalid_api_key` |
| 403 | `account_not_enabled` (not on the allowlist), `plan_not_eligible` (Free plan), account restrictions from `assertUserOperationalAccess`, plan access |
| 404 | `model_not_found`, `request_not_found` (status lookup) |
| 409 | `idempotent_request_in_progress`, `idempotent_request_completed` |
| 413 | `image_too_large`, `too_many_images`, `tool_schema_too_large`, `request_body_too_large`, `CHAT_INPUT_TOKEN_LIMIT` |
| 422 | `idempotency_key_reused` |
| 429 | `key_credit_cap_reached`, the shared credit, concurrency and guardrail codes (unchanged from Chat), `rate_limited` |
| 502 | `upstream_error`, `empty_response` |
| 503 | `feature_unavailable`, `AI_CHAT_DISABLED_BY_ADMIN`, provider unavailability |
| 504 / 499 | `upstream_timeout`, `request_cancelled` (stream error events; 499 also when the client left before dispatch — nothing is sent and the hold is refunded) |

**Idempotency.** An optional `Idempotency-Key` header (up to 255 characters)
is scoped to the key and bound to a digest of the body. The same key and body
again does not dispatch: it answers 409 with the original request's receipt
(status, outcome, finish reason, charged credits). Outputs are not stored, so
the original answer cannot be replayed. A different body under the same
Idempotency-Key is 422. Concurrent twins dispatch exactly once. Without the
header, a retry is a new request — the server cannot tell it from a new one. A client that recorded the
header before sending can look the request up later with `GET /requests/status`.

### 5.1 Smart Adaptive

`model: "smart-adaptive"` lets Tomverse choose, per request, which of the
catalogue models answers -- Chat's own Smart Adaptive router
(`pickAutoModelWithLlm`, the router model set in Admin › Routing). It is the
cross-provider choice a single-vendor subscription cannot offer, so the
response always says which model answered: the `model` field (OpenAI's
convention), `x-tomverse-routed-model`, and `x-tomverse-routed-by`
(`router`, `continued` or `default`). It is offered whenever any model is, and
it is the id the settings page puts in a copied configuration by default:
the id stays the same while models are added to or retired from the
catalogue, so a customer never has to recopy it.

- **Candidates:** the offered models, plus the `frontier` and `apex` models
  this plan reaches (owner decision 2026-11-20: Smart Adaptive may route to
  them, no client may name them, and each request is charged that model's own
  credits under the key's cap; they join only beside a model of their
  provider a client can name, and are only ever the router's pick, never the
  default and never the one model left),
  that fit the request -- images only to a
  model that reads them, the requested output within the model's limit, a
  rough input estimate plus that output within its window, and the optional
  features the request uses (`strict` tools, image `detail`,
  `reasoning_effort`) by the same rules the request is validated with
  (`modelTakesRequestFeatures`), so the pick never decides whether a request
  succeeds.
- **When the router is called:** it is paid and runs before admission (which
  reserves for the model it picks), so it is skipped -- the default model
  answers and admission gives its own error -- while AI chat is paused, when
  the key's cap is spent, for two minutes after a Smart Adaptive request of the
  key was refused at admission, and for an Idempotency-Key replay (answered
  before routing). The `GET /models`
  entry advertises the largest window, the default model's output limit
  (clients send it back as `max_tokens`; a candidate that cannot give it is
  left out only of requests that ask for that much, and VS Code subtracts it
  from the window to size the input), and the largest credits per request. A request
  beyond every candidate gets the default model's ordinary limit error.
- **Router input:** the latest user message's text and the assistant text
  before it, bounded by the router itself, and the coding signals
  (`CodingRouterContext`): the client's User-Agent, the number of tools, the
  model turns so far, the input size, the end of the latest tool result
  (600 characters, where errors and test summaries print) and the model
  already working on the conversation. The router reads them with the coding
  head and guidance (`AUTO_LLM_ROUTER_CODING_GUIDANCE`, version `coding-v1`):
  quality first, credits only between candidates expected to do the work
  equally well, strength by tier then credits, apex only for the hardest work.
  The guidance is fixed in code; the router optimizer measures and replaces
  Chat's guidance only. Nothing is stored: the external API passes no
  conversation id, so the router writes no `AutoRouterDecision` row.
- **Tool loops:** a request that carries tool results back goes to the model
  that made those tool calls. When a Smart Adaptive answer ends with tool
  calls, its model is remembered in process for ten minutes under the key and
  each tool-call id; the round is looked up by the ids it carries, before the
  router gate is asked. A tool-call id belongs to one answer, so concurrent
  requests with the same history, refused requests and answers without calls
  never overwrite each other. A miss (another instance, a restart) routes
  again and shows as `routed-by: router`, so across instances a tool loop can
  change model.
- **A new user message** is routed again, and within a conversation the model
  only moves up (`escalateOnly`): a pick with fewer credits than the model
  already working on the conversation keeps that model (`routed-by:
  continued`), an equal or stronger one moves. The conversation is known by
  the opening of its history (everything before the first assistant message)
  under the key; its model is remembered in process for six hours once
  admission accepted a request on it, so a pick the account could not pay for
  is never held. With the router gate closed it keeps its model too. A miss
  (another instance, a restart, a client that rewrites the opening) routes
  freely.
- **Log:** every Smart Adaptive decision, on every protocol, is one
  `external_api_smart_adaptive_routed` line (request id, protocol,
  `routedBy`, model, `held`, the client's User-Agent cut to 40 characters),
  and the router's own `chat_auto_llm_router` line carries
  `taskKind: external_api`. No request text is logged.
- **No answer** (router switch off, no router model configured, provider budget
  refused, timeout, invalid output, one candidate left): the default model
  (`DEFAULT_MODEL_ID`) if it fits, otherwise the first candidate in catalogue
  order, `routed-by: default`. A pick outside the candidates is never taken.
- **A model named by its provider id.** Chat Completions, like the native
  protocols, takes the provider's model id (`gpt-5.6-luna`) when exactly one
  offered model uses it, so a coding tool's built-in model name works when it
  matches one. Cursor's built-in GPT list matched none of the served models
  (owner, 2026-11-21), so with the base URL overridden those picks reach
  Tomverse and fail as `model_not_found`; Settings and `/developers/cursor` tell
  Cursor users to add a Tomverse ID instead.
  An id two offered models share is a 400 `model_ambiguous` naming the
  Tomverse ids. A name no offered model uses is never mapped to another model:
  it is not found.
- **A pinned model that is no longer offered** (retired, disabled, or its
  provider unconfigured) answers 404 `model_unavailable`, naming
  `smart-adaptive` and the settings page, instead of a bare `model_not_found`.
- **Charging:** the request is reserved, charged and receipted as the routed
  model; `GET /usage` shows that model's id.

### 5.2 Coding routing report and coding optimizer

Owner decision 2026-11-20: the coding router is measured every day and can be
improved by its own optimizer, as Chat's router is.

- **Receipt fields.** Each Smart Adaptive request's receipt
  (`ExternalApiRequest`) records `routedBy` (`router`, `continued`,
  `default`), `routedHeld` and `routeConversation`, a SHA-256 prefix of the
  conversation's routing key (never the key). A request that names a model
  leaves them null. No request text is stored. Receipts written before these
  columns existed have them null too, so for the first week the report counts
  those Smart Adaptive requests among the requests that named a model.
- **Report.** `lib/externalApiRoutingReportCore.ts` counts Smart Adaptive
  requests per model and protocol, `topModelShare` (1 means one model took
  everything), the held share, conversations that changed model, the error
  share and credits. Admin › Routing shows the last 24 hours and 7 days, and
  every daily optimizer run logs the last 24 hours as
  `external_api_coding_routing_daily`, whether or not a cycle starts.
- **Coding optimizer** (`lib/autoCodingRouterOptimizer.ts`, target `coding`).
  It is the Chat optimizer's cycle run on the coding guidance. It shares the
  same optimizer and router models, one running cycle at a time, and the
  same day and month caps (`AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD` and
  `AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD` in `lib/autoRouterOptimizerCore.ts`).
  It adds no spending ceiling.
  - The external API keeps no text, so every case is a synthetic coding
    request.
  - The router is asked with the coding head, and a coding judge compares
    the answers.
  - The menu is the external API's Smart Adaptive candidates for the widest
    plan, without apex.
  - The generator also reads two kinds of pre-cycle evidence: the 7-day
    report and the task evaluation.
  - A promoted proposal becomes the `coding` guidance the live coding router
    reads (its code default is `AUTO_LLM_ROUTER_CODING_GUIDANCE`). Rollback
    goes one step back.
  - Its daily run is on by default (owner decision 2026-11-20) and can be
    turned off in Admin › Routing; auto-promote starts off, so a passed
    proposal waits for a person's click. A person may also start a cycle.
    With several daily switches on, the targets take turns, one cycle a day
    in all. A setting row that cannot be read counts as both off.
- **Task evaluation** (`lib/codingTaskEval.ts`).
  - Runs before the cycle proper, within up to 40 per cent of a coding cycle's
    budget. Each run starts only when its worst case
    (`codingEvalWorstCaseTokens`, at the model's prices) still fits. A call
    whose usage is unknown is charged its worst case and leaves the cycle's
    cost coverage incomplete, so that cycle cannot be promoted. No retries.
    It stops starting runs 15 minutes after the cycle began.
  - For each of six fixed JS tasks (two easy, two medium, two hard), the
    current coding guidance routes the task. Its pick and the next candidate
    up each work it as an agent with `list_files`, `read_file`,
    `write_file` and `run_tests` (the visible examples only), for at most
    8 steps, with a 32 KB workspace and 32 KB of tool output.
  - Pass or fail is decided in the trusted parent. A runner written by the
    harness calls the model's exports in a child and returns their values.
    The parent compares them with hidden expectations that never enter the
    child, so printed output cannot fake a pass.
  - The child runs `node --permission`: it reads only the task's temporary
    folder, writes nothing, starts no processes or workers, and gets an
    emptied environment.
  - Node does not restrict network. So model-written code runs only where
    the operator has isolated the runner from internal services, metadata
    endpoints and credentials, and has set
    `CODING_TASK_EVAL_ISOLATED_RUNNER=true` (default off). Anywhere else, a
    coding cycle skips the evaluation and records
    `taskEvaluationStop: runner_not_isolated`.

## 6. Data

`ExternalApiKey`: name, prefix, digest, cap, expiry, revocation, last use.
`ExternalApiRequest`: the link from a key to its reservation, model, whether
it streamed, the wire protocol (`chat_completions`, `anthropic_messages` or
`responses`; migration `20261118160000_external_api_request_protocol`, rows
from before it read as Chat Completions), which API it came through (`surface`:
`general` or `coding`, from the route, held to those two by a CHECK constraint;
migration `20261121120000_external_api_request_surface`, rows from before it
stay NULL and are shown as not recorded, with no backfill), the client user agent, finish reason,
error code, timestamps, and digests of the body and Idempotency-Key. No prompt, output, tool argument,
image or key material is stored or logged. Every credit and token figure lives
on the shared reservation.

The account data export includes both tables without the digests
(`api_keys`, `api_requests`, the latter with `surface`). The key's receipts --
`GET /usage`, `GET /requests/status` and Settings > API keys -- return `surface`
too, null for a request recorded before it. Deleting the account deletes its keys and
request links; the shared reservation rows stay, detached from the person, as
every Chat reservation does.

## 7. Client setup

Settings has a **Developer** tab (`docs/ui-contracts/settings-navigation.md` 2.3): the
key summary, the four connection addresses (general `/api/v1` and `/api/anthropic`,
coding `/api/code/v1` and `/api/code/anthropic`, each copyable) and the CLI install
line, read from the same key list. One key serves both APIs; a request row records
which one it came through (`surface`).

`/settings/api` lists the keys, makes a key in a dialog (which says the key works on
both APIs, and that one key per tool lets one tool be cut off) and shows its secret
once in a second dialog. Under "Connect a tool" the person first picks the API --
**General API** or **Coding API** -- which shows that API's two addresses, then one
tool, and sees only that tool's setup, built from that API's offered models. The
tools, by API (`lib/externalApiAppGuides.ts`): general -- Aside, Brave Leo, Raycast,
BrowserOS and other OpenAI-compatible apps; coding -- Tomverse CLI, Claude Code,
Codex, Cursor, VS Code and JetBrains. "Models allowed through the API" is split the
same way, and a model only the coding API offers is marked "Coding only". Recent
requests show an API column (coding, general, or a dash for a request recorded before
the column). Aside, Raycast and VS Code take Smart Adaptive alone by default, plus any
model the person ticks to pin it. The new key is filled
into the setup until the person leaves the page; it is held only in the page's
memory, never stored. Any other app that takes a custom OpenAI Chat Completions
endpoint needs only three values: base URL, key and model (`smart-adaptive`). The
models allowed through the API are listed in a searchable section, each with
the tools that can use it on that API. Claude Code, Codex, Cursor, VS Code, JetBrains
and the tomverse CLI are configured with the coding API's base URL and its models;
Aside, Brave Leo, Raycast, BrowserOS and other apps with the general API's. Details
are in section 10.4.

- **Aside:** add a Custom Provider and paste the JSON: provider `tomverse`,
  `api: "openai-completions"`, `baseUrl`, `apiKey`, `authHeader: true`, and per
  model `id`, `name`, `reasoning`, `input` (`text`, plus `image` where
  supported), `contextWindow`, `maxTokens`.
- **Brave Leo** (general API; checked against Brave's documentation 2026-11-21):
  Settings > Leo > Bring your own model > add a model. *Server endpoint* is the full
  path `https://<host>/api/v1/chat/completions`; *Model request name* is the model
  id (`smart-adaptive`); *API Key* is the key. Leo handles text in and out only.
- **Raycast** (general API; checked against Raycast's manual 2026-11-21): Settings >
  AI > Custom Providers, file `~/.config/raycast/ai/providers.yaml`. `base_url` is
  `https://<host>/api/v1` without `/chat/completions`; `api_keys` maps an alias to
  the key; `models` is required (`id`, `name`, `provider` alias, `context`,
  `abilities`). Settings generates the file from the ticked models. Tools also need
  a top-level `tools` block, which the person adds from Raycast's guide.
- **BrowserOS** (general API): `chrome://browseros/settings`, the "OpenAI Compatible"
  card: Base URL `https://<host>/api/v1`, model id, key.
- **JetBrains AI Assistant** (coding API): Settings > Tools > AI Assistant >
  Providers & API keys (Models & API keys in newer versions) > OpenAI-compatible:
  URL `https://<host>/api/code/v1` and the key, then Test Connection. The Anthropic
  format is not supported there. Menu names change between versions, so the guide
  gives values only.
- **VS Code** (a coding tool: the coding API's base URL and models): run
  *Chat: Manage Language Models* → *Add Models* → *Custom Endpoint* and use the
  generated entry as the `chatLanguageModels.json` provider: `vendor: "customendpoint"`, `apiType: "chat-completions"`,
  `apiKey: "${input:tomverseApiKey}"` (VS Code asks once and keeps it in its
  secret storage), per model the full `/chat/completions` URL, `toolCalling`,
  `vision`, `streaming`, `maxInputTokens`, `maxOutputTokens`. VS Code's
  documentation (checked 2026-11-17) says local-harness BYOK models need no
  GitHub sign-in or Copilot plan, Copilot Business/Enterprise needs the BYOK
  policy, and BYOK in Copilot-harness sessions is behind the experimental
  `chat.agentHost.byokModels.enabled`. A model without tool calling is hidden
  from agents; every offered model here advertises it.

Both clients have been verified against this API (section 9).

## 8. Operations

**Enable for a test account (after the approvals in section 9):** apply the
migrations `20261117150000_external_api_keys` and
`20261118160000_external_api_request_protocol`, set `EXTERNAL_API_ALLOWED_USER_IDS` to the test account,
`EXTERNAL_API_ENABLED=true` (and `EXTERNAL_API_ANTHROPIC_ENABLED` / `EXTERNAL_API_RESPONSES_ENABLED`
for Claude Code / Codex), deploy, then create a key at `/settings/api`.

**Observe.** Reservations: `source = 'external_api'` in `ChatCreditReservation`
(Admin usage analytics already groups by source). Receipts: `ExternalApiRequest`
by `id` (= `x-request-id` = the reservation's `traceId`). Held or unresolved:

```sql
SELECT r."id", r."keyId", c."status", c."outcome", c."reservedCredits", c."expiresAt"
FROM "ExternalApiRequest" r JOIN "ChatCreditReservation" c ON c."id" = r."reservationId"
WHERE c."status" = 'reserved' ORDER BY r."createdAt";
```

Structured log events: `external_api_settlement_failed`,
`external_api_predispatch_refund_failed`, `external_api_receipt_update_failed`,
`external_api_request_failed`, plus the shared `chat_limit_decision` and
provider health records (`EXTERNAL_API_FAILED`).

**Reconcile.** An unresolved reservation is closed by the existing expired
reservation sweep, the same as Chat. Do not mark one settled by hand from a
timeout alone; use the provider's request ID linked on the reservation.

**Roll back.** Switch off (section 2) — new dispatch stops, in-flight calls
settle. The migration is additive; leaving the tables in place is the safe
rollback. Dropping them is only possible with no rows to keep.

## 9. Verification status and what needs approval

Implemented and verified locally (fake provider, migrated local database):
see `npm run test:external-api`, `npm run test:external-api-db`, and
`tests/e2e/external-api-settings.spec.ts`.

Not yet done, each a separate step:

- Confirming that offering each configured provider's models through an
  external API is within that provider's terms, before the API is switched on
  in production. Every catalogue model with a credential is offered.
- An automated per-model check through this API (text, one tool round, an image
  where claimed): a paid run, approved separately.
- Paid smoke tests with a test account and a spending ceiling.
- Real Aside and VS Code acceptance runs (tool round trip, image, stop, usage,
  revocation). Done locally on 2026-11-18 against a production build and real
  providers: Aside pi/1.4.1 and VS Code with GitHub Copilot Chat 0.74.0
  (Custom Endpoint), both through `smart-adaptive` with the router on
  (OpenAI and DeepSeek candidates). Still open in VS Code: refusing a tool
  approval and stopping mid-answer.
- The router's former 200-token output limit counted reasoning and twice cut the
  router's answer off on a request carrying a previous answer (`invalid`, the
  default model then answered). Every routing call (router, image and location
  intent, search plan, rewrite) now shares one generous ceiling,
  `ROUTING_CALL_MAX_OUTPUT_TOKENS` (8,192, `lib/routingCallLimits.ts`), used only
  for the worst-case cost hold, and a cut-off answer logs `output_truncated`.
  The hold is 20-40 times the old one per call (settled to actual), so on a
  deployment whose provider budget is nearly spent a routing call is refused
  sooner and the turn takes its deterministic fallback; watch
  `chat_auto_llm_router_skipped` with `reason: provider_budget`.
  Not yet re-run live.
- Claude Code and Codex with a real model (section 10.5): paid runs, approved
  separately. Cursor needs a public HTTPS deployment, because Cursor sends the
  requests from its own servers.
- Production migration, merge and deployment.

## 10. Native protocols (Claude Code, Codex)

Claude Code speaks Anthropic Messages and Codex speaks OpenAI Responses; both
keep state the model signed or encrypted (thinking signatures, encrypted
reasoning) and pair request headers with body fields. A translation layer
would break that state and fall behind each client release, so these routes
**pass the client's body through** after deterministic checks, and relay the
provider's stream event by event, each event's data unchanged, while reading
it for usage. The lifecycle is
the Chat Completions one (`lib/externalApiNative.ts`): the same key, rate
bucket, `createChatBudget` → `acquireChatAccess` + `externalApiAdmissionHook`
→ one dispatch → `settleChatUsage`, exactly once.

### 10.1 What changes and what is refused

Changed in the body: the model id becomes the provider's; the output limit
(`max_tokens`, `max_output_tokens`) becomes the one the reservation prices --
the client's own number when it is within the model's limit, the model's limit
when the client asks for more or (Responses) sends none; Responses always gets
`store: false`. A clamped limit is named in `x-tomverse-output-limit`.

Refused before dispatch, with nothing held (`lib/anthropicMessagesProtocol.ts`,
`lib/openAiResponsesProtocol.ts`):

- tools the provider runs and bills itself: Anthropic server tools (web search,
  web fetch, code execution, ...) and Responses hosted tools (web search, file
  search, code interpreter, image generation, remote MCP, and the `shell` and
  `apply_patch` tool types, which can run provider-side); remote MCP servers
  and containers. Client-executed tools pass: function, custom/freeform
  (Codex's `apply_patch`, `exec`), namespaces of them, local shell, and
  Anthropic's `bash`/`text_editor`/`computer` client tools;
- content the provider would fetch (image or document URLs) and Files API ids,
  which would read Tomverse's own provider account;
- a prompt-cache TTL other than 5 minutes (the premium reserved is the
  5-minute one), `speed` other than standard, and any `service_tier` or
  `inference_geo` at all: every price profile is the price of a request that
  selects neither, the convention every Tomverse request follows
  (`scripts/check-processing-tier-core.mjs`);
- a forwarded header value that is not printable ASCII (checked before the
  hold, so a request fetch could not send never consumes provider budget);
- stored or server-side state: `previous_response_id`, `conversation`,
  stored `prompt`, `background`, `item_reference`;
- models of another provider: a native request stays on its own provider.
  The model list per protocol is the same runtime registry, plan and
  credential filter as `/models`, narrowed by provider (`protocols` on each
  `/models` entry). A Responses request may name the provider's model id
  (`gpt-5.6-luna`) when it maps to exactly one offered model; Codex picks its
  patch tool by it. `smart-adaptive` is accepted and routed among the
  provider's own models (section 10.6).

`anthropic-beta` is forwarded unchanged (filtering one half of a header/body
pair yields a provider 400); the cost-bearing features are checked in the body.
The client's Tomverse key never goes upstream: the provider URL and credential
are the deployment's own (`lib/externalApiNativeUpstream.ts`, no redirects).

### 10.2 Money

- One generation request, one reservation, one receipt -- a coding task is
  many requests, and so are compaction summaries.
- Input estimate: every string and object key of the body (tool schemas are
  mostly keys), images by measured size plus the flat allowance, opaque
  signatures and encrypted state at bytes/4. Output: the limit above, reserved
  in full.
- Anthropic usage is cumulative across `message_start` and `message_delta`;
  the ledger's input is uncached + cache read + cache write. A request carrying
  a client `cache_control` marker reserves the 5-minute write premium
  (caching path `external_api_messages`, `lib/anthropicPromptCaching.ts`) and
  settles writes at the write rate. A Chat Completions request that resolves to
  an Anthropic model gets Tomverse's automatic 5-minute marker (caching path
  `external_api_chat_completions`) with the same reservation and settlement.
  Responses usage: `input_tokens` includes
  cached tokens, output includes reasoning.
- Settlement follows section 4: provider usage when reported; zero when the
  provider refused with a 4xx (not 408) or no credential existed; a cancelled
  stream estimated from what it produced; otherwise the reservation estimate.
  A stream that ends without its terminal event (`message_stop`,
  `response.completed`/`incomplete`) is a failure and gets a protocol-native
  `error` event, never a clean finish.
- The provider's own 400 message is kept (Claude Code and Codex recover from
  specific ones); anything naming Tomverse's provider account, limits or
  availability is replaced -- in an HTTP error body and in an in-stream `error`
  or `response.failed` event alike -- and provider rate-limit headers are not
  relayed.
- Idempotency: one `(key, Idempotency-Key)` across all protocols. Native
  request digests are prefixed with the protocol, so a key reused on another
  endpoint is a 422 conflict; Chat Completions digests are unchanged.
- `count_tokens` is free at Anthropic: rate limited as a read, no reservation.
- A timeout or a departed client ends the request from the abort itself, not
  from the next read: a client holding the connection open without reading
  cannot keep the hold or the concurrency slot past `EXTERNAL_API_TIMEOUT_MS`.
- A non-image inline file counts against the input limit at its decoded
  size / 4, never at a flat allowance alone.

### 10.3 Compaction and resume

Both clients compact locally: the summary is an ordinary generation request,
reserved and settled like any other. Codex treats a custom provider's remote
compaction as unsupported (`capabilities.remote_compaction` default), so no
`/responses/compact` endpoint exists. Resume replays the client's own history.

### 10.4 Client configuration (`lib/externalApiCodingTools.ts`)

- **Claude Code:** `ANTHROPIC_BASE_URL=https://<host>/api/code/anthropic` (the
  coding API; the client adds `/v1/messages`), `ANTHROPIC_AUTH_TOKEN=<key>` (`x-api-key` is accepted
  too), every model alias (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`) pinned to offered models,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` below the
  account input limit, `FORCE_PROMPT_CACHING_5M=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Terminal: per-session variables.
  VS Code: `claudeCode.environmentVariables` + `claudeCode.disableLoginPrompt`.
  Claude Code 2.1.278+ asks Anthropic to run auto mode's safety review inside
  the model request (a `safeguards` body field and its beta values, passed
  through unchanged). With a real Anthropic upstream that review should come
  back in the relayed response; it has not been verified yet (section 10.5).
  Without a review result Claude Code refuses actions that need one (Bash),
  and manual permission mode works regardless.
- **Codex:** `[model_providers.tomverse]` in `~/.codex/config.toml`
  (`base_url = "https://<host>/api/code/v1"`, `wire_api = "responses"`, `env_key = "TOMVERSE_API_KEY"`, request and stream
  retries 0, `supports_websockets = false`) and a profile file
  `~/.codex/tomverse.config.toml` (`model_provider`, `model`,
  `web_search = "disabled"`, `approvals_reviewer = "user"`, `review_model`,
  `model_context_window`, `model_auto_compact_token_limit`) selected with
  `codex --profile tomverse`; without it the person's own account is
  untouched. The official VS Code extension has no profile setting and reads
  `config.toml`'s top level, so the page also gives that form. Approvals stay
  with the person: Codex's automatic reviewer runs on its own reviewer model
  (`codex-auto-review`), which Tomverse does not offer. The extension names
  each thread with a small model it picks itself (observed: `gpt-6-luna`);
  that is one more ordinary request with its own credits, and there is no
  setting to change its model.
- **Cursor:** OpenAI API key + base-URL override (`https://<host>/api/code/v1`)
  + a custom model, on the coding API's Chat Completions route. Settings offers
  `smart-adaptive` first (verified with Cursor on production, 10.5); the public
  guide at `/developers/cursor` lists every model ID a paid key can name, read
  from the live chat catalogue with `isExternalApiServableModel`, plus the
  retired IDs and their catalogue replacements. That is the coding API's list
  while `CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED` is off (production,
  2026-11-21); turning it on changes the coding API's models, and the guide's
  table must then read the coding catalogue before the switch goes on. Cursor's
  backend makes the calls, so only a public HTTPS deployment works; Tab,
  Cursor's own models and cloud agents never use the key.

### 10.5 Verification

Verified 2026-11-18 on Windows 10 against this code, a migrated local database
and a scripted fake provider (no paid call): Claude Code 2.1.278 CLI read a
file, edited it, ran the test, compacted, and resumed the compacted session for
a follow-up; a refused approval left the file unchanged; Codex 0.146.0 CLI
applied a freeform patch inside `exec`, ran the test, compacted locally
mid-task and resumed; after revocation both got 401 with nothing dispatched;
every reservation was settled (none left held, including a 439-request burst
stopped by the rate guard). Automated: `npm run test:external-api`,
`npm run test:external-api-db` (`tests/integration/external-api-native.db.test.mjs`).

Official VS Code extensions, 2026-11-18, same fake provider, Windows 10, VS
Code 1.146.0, isolated profile, configured only by the page's generated
settings: Claude Code extension 2.1.327 (Manual mode) read, edited and ran the
test through the extension UI; its bundled CLI also passed compact, resume and
a refused approval. Codex extension openai.chatgpt 26.1111.21308 (bundled Codex
0.169.0-alpha) edited the file with apply_patch and ran the test through the
extension UI; its bundled CLI also passed local compaction and resume. All 50
requests of that key settled, none held. In Auto mode the Claude extension
refused Bash because the fake provider returns no safety-review result.

Real models, 2026-11-18 (approved paid run, US$10 ceiling, US$0.62 spent):
this code on a local Windows PC with an isolated ledger and the real Anthropic
and OpenAI APIs, every client configured only by the page's generated settings.
Claude Code CLI 2.1.278 and the VS Code extension 2.1.327 (Claude Sonnet 5,
Haiku 4.5 for background work) and Codex CLI 0.146.0 and the VS Code extension
26.1111.21308 (GPT-5.6 Luna) each fixed a failing test, honoured a refused
approval, and continued after compaction; Claude Code's auto-mode safety
review worked through the gateway; Codex compacted locally mid-task and
resumed; a stream dropped mid-generation settled as cancelled on both
protocols; after revocation both returned 401 with nothing dispatched. Ledger
input, cache read/write and output matched Claude Code's own usage report to
the token. 57 requests, none left held.

Cursor, 2026-11-19, on the dev deployment (public HTTPS, the deployed Next.js
server, real model GPT-5.6 Luna), driven by the operator in the Cursor desktop
app on Windows 10 (3.21.16 when installed on 2026-11-18) and configured only by
the page's Cursor steps: Chat explained two files; Agent ran a failing test,
fixed the file with `ApplyPatch` and re-ran it to a pass, on two files; with
Run Mode set to Allowlist, a command refused at the approval prompt was not
run and the next request was accepted, then the same command approved ran; a
reply stopped mid-stream settled as cancelled at 1 credit, against 2 for the
completed request before it, and the receipts on the API keys page carried the
same request ids and states as the server. No request in these runs failed or
was retried. Before the function form of section 6, each `ApplyPatch` call
sent as a `custom` call completed and was charged while Cursor retried it four
times and reported a server error.

Cursor, 2026-11-20, against production (`https://tomverse.app/api/v1`), same
steps, model `smart-adaptive` on Chat Completions (it picked DeepSeek V4 Pro for
every request): Chat, Agent fix and re-run, a refused then approved command,
and a stopped reply all passed -- 15 requests, each answered 200 once, no
retries and no server errors; the stopped reply settled as cancelled at 1
credit, and the receipts matched the server's request times. With model
`gpt-6-luna` the first request was refused with 400: Cursor adds `reasoning`
(section 6) for a model name it recognises. Accepting the object form was not
enough -- after it was deployed the 400 named a string -- so the string form is
accepted too, and `reasoning` is left out where the model takes no effort.
With that deployed (2026-11-21, release #4131), Cursor Chat with `gpt-6-luna`
answered: 3 requests, each 200 once, no server errors.

Not yet verified, each a separate step: other operating systems, Claude Code
and Codex against a deployed environment (their runs above called the handlers
directly, not through the Next.js server), Cursor Agent with a named model on
production (Chat is verified above), and native Smart Adaptive
(section 10.6) with real models or real clients end to end.

### 10.6 Smart Adaptive on the native protocols (`lib/externalApiNativeSmartAdaptive.ts`)

`model: "smart-adaptive"` on Anthropic Messages routes among the Anthropic
models this key can run, on Responses among the OpenAI models -- never across
providers, so signed or encrypted state is never sent to another provider.

- **Constraint checked (provider docs, 2026-11-19).** Anthropic binds each
  thinking block to the model that produced it; a model that cannot read an
  earlier block drops it and the request still succeeds. OpenAI omits
  incompatible encrypted reasoning when the model family changes, also without
  failing. So a model switch mid-task costs reasoning and the prompt cache,
  not the request; the gateway still avoids it.
- **One pick per conversation, moving only up.** The first request of a
  conversation (no model output in its history) is routed with the same
  router call, gate, switch and coding guidance as Chat Completions (section
  5.1, `pickWithSmartAdaptiveRouter`); every tool round of that conversation
  goes to the same model (`x-tomverse-routed-by: continued`). A later message
  the user wrote (the history ends with a user message carrying no
  `tool_result`, or a Responses user message rather than a tool output; read
  from the structure, never the text) is routed again with the pinned model
  as `currentModelId`: a cheaper pick keeps the pin, a stronger one answers.
  Every pin is written only once admission accepted the request, so a model
  the account cannot pay for never takes the conversation, and the rule is
  checked again when it is written, so of two messages routed at once the
  cheaper one admitted last cannot lower it. A request that opens a new
  history on the same session (a Claude Code subagent) keeps the session's
  model and is not routed, so it cannot move the model under the main loop's
  tool rounds; identical concurrent requests share one router call. The
  switch costs the reasoning and the cache, the trade the user's harder
  request asks for. The provider default is never a frontier or apex model,
  and a request only they fit is refused as it was before they were candidates.
  Known limit: one pin per session holds one model. Two different messages
  the user sends on one session at the same moment (pinned or not) pick
  independently, the dearer one admitted first keeps the pin, and the
  other's tool rounds then run on it (reasoning and cache lost, never the
  request). Claude Code and Codex send one user message per session at a
  time, and a subagent never re-routes; per-tool-call stickiness on the
  native protocols would remove the limit. The conversation is the client's own id: Codex's
  `prompt_cache_key` (its thread id; `session-id`/`thread-id` headers),
  Claude Code's `x-claude-code-session-id` or the session in
  `metadata.user_id`; otherwise a digest of the history's opening. The pin is
  kept in this process for six hours from the conversation's last generation
  request (a token count reads it without extending it).
- **Candidates** are the provider's models the request fits: images only to a
  model that reads them, and the input estimate plus the output the gateway
  would reserve on that model (the client's limit within the model's own)
  within its window, after the protocol's own check for that model (a
  thinking budget above its output limit leaves it out). When no model of the
  provider fits, the request is refused (`image_input_unsupported`,
  `context_length_exceeded`, or the model check's own error) before any
  router call or hold. Every refusal that does not depend on the model
  (provider-run tools, cache TTL, stored state, forwarded headers) is checked
  before the router call, so a request refused anyway never spends one.
- **A missed pin never fails.** A tool round whose history already carries
  model output and whose pin this process does not have (another instance, a
  restart) takes the provider default and pins it; a message the user wrote
  is routed like a first request. The body
  names no producing model to recover, and both providers accept the switch.
  If the pinned model can no longer take the request (window, retirement),
  another fitting model of the provider answers and the pin moves.
- **Provider default:** the catalogue default (`gpt-6-luna`) when the
  provider has it, otherwise the lower-median model by credits
  (`nativeSmartAdaptiveDefaultId`). It also answers with the router switch
  off, when the router gives no answer or names a model outside the
  candidates, and for the free `count_tokens` call, which never routes and
  reads the pin only.
- **Money:** the pick happens before admission, so the reservation, receipt
  and credits are the picked model's; billing code is unchanged. A refused
  admission pauses router calls for the key for two minutes, as in section 5.1.
  Responses carry `x-tomverse-routed-model` and `x-tomverse-routed-by`.
- **Settings:** Claude Code and Codex offer Smart Adaptive first, scoped to
  their provider (`nativeSmartAdaptiveCapabilities`): the smallest window
  among those models (the conversation keeps its first model, so the tool
  compacts before the smallest window), the default's output limit, the
  dearest model's credits. Claude Code's Haiku alias stays on the cheapest
  fixed Anthropic model, so background work makes no router call. Codex 0.146
  given `smart-adaptive` (a slug it does not know) sends its generic function
  tools (`shell_command`, `update_plan`, ...) and no freeform tool, captured
  2026-11-19 against a local server; every OpenAI model takes those.
- **Verified 2026-11-19** with a fake provider and a faked router over the real
  ledger (`tests/integration/external-api-native.db.test.mjs`): Anthropic-only
  and OpenAI-only candidate lists, a cross-provider router answer ignored, the
  pick kept across tool rounds that carry thinking signatures and encrypted
  reasoning, a dropped pin answered by the default with no router call and no
  failure, every request settled.

## 11. Tomverse CLI (`apps/tomverse-cli`)

Tomverse's own coding agent, `@tomverse/cli` (bin `tomverse`), is a client of
the coding API like Claude Code, Codex and Cursor: `https://tomverse.app/api/code/v1`
by default, Chat Completions only, one key, the account's shared credits, the
key cap as the only hard credit limit. An endpoint saved before the move ends
in `/api/v1` and is read as `/api/code/v1` on the same server
(`apps/tomverse-cli/src/config.ts`). No separate wallet, task
price, Conversation, `productKey` or server-side agent. The user guide and
output contract are in `apps/tomverse-cli/README.md`.

- **Transport.** An explicit AI SDK provider instance (`createOpenAI({ baseURL,
  apiKey, fetch }).chat(model)`) with retries 0. Its fetch allows only
  `POST /chat/completions` on the configured origin and below its API root,
  never follows a redirect, and records a durable intent with a new
  `Idempotency-Key` before each request -- one per model step, never shared
  across steps. Configuration is the user's (home folder); nothing in a
  repository can change the endpoint, the key or a permission. https only;
  http only for a loopback development server the user allowed.
- **Cost.** A session's cost is the sum of its own receipts, looked up by
  request id (`/usage`, then `/requests/status`), never the key's total before
  and after. Held is shown as held and unknown as unknown. Compaction is a
  model request of the same model and counts against the per-task request
  limit (default 20 requests, 15 active minutes, 120 s per command).
- **Recovery.** A lost response is looked up with `/requests/status` by the
  recorded Idempotency-Key; the answer itself cannot be replayed, and sending
  the step again is the user's decision (a new request). `request_not_found`
  is never treated as free or as safe to resend.
- **Local boundary** (the CLI's code, not the server's): approvals bound to the
  exact tool input and file preimages and checked again inside the tool's
  execute, no re-run of a call that started, credential paths and `.git/`
  never read, commands get a fixed short list of environment variables (PATH,
  HOME, temp, locale, …) plus names the user adds, never a Tomverse one, and no
  approval without a terminal. At the terminal the user can answer "always"
  for the rest of that process: all file creates and updates (a delete is
  always asked), or one exact command (program, arguments, folder,
  environment names). It is not saved, so a resumed session asks again, and
  it skips only the question, not the checks. Commands run with the user's
  own permissions; the CLI does not claim a sandbox.
- **Smart Adaptive.** The first answer's `x-tomverse-routed-model` is pinned for
  the session before any tool of that answer runs; later requests name it.
- **Tomverse Code.** Its Rust host is not embedded in v1 (a Windows desktop
  runtime with its own providers and store). The CLI follows its contracts --
  tool names, result states, the credential path list, argv-first commands --
  so a later shared executor can replace the CLI's local tools.

- **Distribution** (owner decision 2026-11-19). The npm package
  `@tomverse/cli` (Node.js 22 or later) under a proprietary use-only license
  (`apps/tomverse-cli/LICENSE`), plus standalone executables (Node.js single
  executable applications) for Windows, macOS and Linux on x64 and arm64,
  attached to a GitHub Release `cli-v<version>`. The workflow
  `tomverse-cli-release-check.yml` (run by hand) builds and tests all of them
  and publishes nothing. The steps are in `apps/tomverse-cli/RELEASING.md`.

Verification state, publication and the operating systems actually run are
reported per change (the PR); package publication and enabling
`TOMVERSE_CLI_GUIDE_ENABLED` are separate approved steps.
