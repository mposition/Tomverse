# External inference API (`/api/v1`)

Status: implemented, default off. Live activation, paid smoke tests and the
production migration are separate, approved steps (section 9).

The API lets an account use its existing Tomverse models and credits from
coding tools that speak the OpenAI Chat Completions protocol: Aside (Custom
Provider, Pi `openai-completions`) and VS Code (Custom Endpoint,
`chat-completions`). It is a stateless inference gateway. It is not a
Tomverse agent, not a tool runner and not a separate billing product.

## 1. What one request is

- One `POST /api/v1/chat/completions` is one provider generation. The server
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
| `EXTERNAL_API_ALLOWED_USER_IDS` | Comma-separated user IDs allowed to manage and use keys, or `*`. Empty means nobody. |
| `EXTERNAL_API_PUBLIC_BASE_URL` | Optional canonical base URL shown to users (e.g. `https://tomverse.app/api/v1`). Otherwise derived from the request host. |
| `NEXT_PUBLIC_EXTERNAL_API_SETTINGS_VISIBLE` | Build-time. Shows the API keys row in the settings panel. `/settings/api` itself checks availability through the server. |
| `EXTERNAL_API_REQUESTS_PER_MINUTE` / `_PER_DAY` | Per-account request-rate abuse guard, defaults 120 / 20 000. Credits, the key cap and concurrency are what bound usage; this only stops runaway clients. |
| `EXTERNAL_API_HEARTBEAT_MS` | How often an in-flight request renews its concurrency slot and reservation, default 60 000. Runs from dispatch, including the wait for a streaming request's first part. Lowered only by tests. |
| `EXTERNAL_API_READS_PER_MINUTE` / `_PER_DAY` | Separate per-account budget for `GET /models` and `GET /usage`, defaults 60 / 5 000. The settings read routes (key list, receipts) have a fixed 60 / 5 000; revocation has none, so it always works. |
| `EXTERNAL_API_TIMEOUT_MS` | Server timeout for one generation, default 600 000. |
| `EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED` | Exactly `true` lets Smart Adaptive (section 5.1) ask Chat's router model which candidate answers. Off by default, because each routed request adds one router call, held against the provider operational budget rather than the user's credits. Off, `smart-adaptive` still works and every request goes to the default model. |

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

Base URL `https://<host>/api/v1`. Bearer authentication only.

**Which models.** The model catalogue is the only list. A model is offered when
the runtime registry serves it to the account's plan (enabled, status enabled
or limited, not deleted), it is not a research or deep-research model, and its
provider has a credential on this deployment. There is no second, operator-kept
list of ids: enabling a model in the catalogue offers it here too.

| Endpoint | Purpose |
|---|---|
| `GET /models` | OpenAI model list of what this key's account can run now. Tomverse facts under `tomverse`: capabilities, `context_window_tokens`, `max_output_tokens`, `credits_per_request`. |
| `POST /chat/completions` | Chat Completions, streaming or not. |
| `GET /usage?limit=50` | Tomverse-specific: this key's cap, committed and held credits, and recent request receipts. |

**Supported request fields:** `model`, `messages` (roles `system`,
`developer`, `user`, `assistant`, `tool`; text parts; `image_url` parts with
base64 `data:` URLs of PNG, JPEG, WebP or GIF up to 8 MB each, 16 per request;
`detail` `low`/`high` is forwarded to OpenAI and refused for other providers),
`stream`, `stream_options.include_usage`, `tools` (function tools, up to 128,
64 KB per schema; `strict: true` only for providers whose adapter forwards it: OpenAI, Mistral, Moonshot), `tool_choice` (`none`, `auto`, `required`, or a named
function), `parallel_tool_calls: true`, `max_tokens`, `max_completion_tokens`,
`temperature`, `top_p`, `frequency_penalty`, `presence_penalty` (forwarded where the
model accepts a temperature, including models registered with reasoning `none`;
for a model that takes none of them they are left out of the call and named in
the `x-tomverse-ignored-parameters` response header, because coding clients send
them on every request -- VS Code always sends a temperature), `stop` (up to 4), `n: 1`, `store: false`,
`user` (accepted, no effect), `reasoning_effort` (OpenAI reasoning models only).
The request body may be up to 12 MB.

**Refused with a typed 400:** any other field (`unsupported_parameter`, naming
it), a `name` on any message (no provider here has participant names), `n` other than 1, `store: true`, `parallel_tool_calls: false`, both token
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
| 400 | `invalid_json`, `invalid_request`, `unsupported_parameter`, `conflicting_parameters`, `max_tokens_too_large`, `invalid_tool`, `invalid_tool_choice`, `invalid_tool_call`, `invalid_tool_result`, `unsupported_image_url`, `unsupported_image_type`, `invalid_image`, `model_does_not_support_images` |
| 401 | `invalid_api_key` |
| 403 | `account_not_enabled`, account restrictions from `assertUserOperationalAccess`, plan access |
| 404 | `model_not_found` |
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
header, a retry is a new request — the server cannot tell it from a new one.

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

- **Candidates:** the offered models that fit the request -- images only to a
  model that reads them, the requested output within the model's limit, and a
  rough input estimate plus that output within its window. The `GET /models`
  entry advertises the largest window, the default model's output limit
  (clients send it back as `max_tokens`; a candidate that cannot give it is
  left out only of requests that ask for that much, and VS Code subtracts it
  from the window to size the input), and the largest credits per request. A request
  beyond every candidate gets the default model's ordinary limit error.
- **Router input:** the latest user message's text and the assistant text
  before it, bounded by the router itself. Nothing is stored: the external API
  passes no conversation id, so the router writes no `AutoRouterDecision` row.
- **Tool loops:** a request that only carries tool results back keeps the model
  picked for the user message it continues, remembered in process for ten
  minutes under a SHA-256 digest of the key and the messages up to that user
  message. A miss (another instance, a restart) routes again. A new user message
  is routed again.
- **No answer** (router switch off, no router model configured, provider budget
  refused, timeout, invalid output, one candidate left): the default model
  (`DEFAULT_MODEL_ID`) if it fits, otherwise the first candidate in catalogue
  order, `routed-by: default`. A pick outside the candidates is never taken.
- **A pinned model that is no longer offered** (retired, disabled, or its
  provider unconfigured) answers 404 `model_unavailable`, naming
  `smart-adaptive` and the settings page, instead of a bare `model_not_found`.
- **Charging:** the request is reserved, charged and receipted as the routed
  model; `GET /usage` shows that model's id.

## 6. Data

`ExternalApiKey`: name, prefix, digest, cap, expiry, revocation, last use.
`ExternalApiRequest`: the link from a key to its reservation, model, whether
it streamed, the client user agent, finish reason, error code, timestamps,
and digests of the body and Idempotency-Key. No prompt, output, tool argument,
image or key material is stored or logged. Every credit and token figure lives
on the shared reservation.

The account data export includes both tables without the digests
(`api_keys`, `api_requests`). Deleting the account deletes its keys and
request links; the shared reservation rows stay, detached from the person, as
every Chat reservation does.

## 7. Client setup

`/settings/api` builds the configurations in the page from the offered models:
Smart Adaptive alone by default, plus any model the person ticks to pin it. The
key appears only in the configuration shown right after creation. Any other app
that takes a custom OpenAI Chat Completions endpoint needs only the three values
the page also shows: base URL, key and model (`smart-adaptive`). A client that
speaks only OpenAI's Responses API is not supported.

- **Aside:** add a Custom Provider and paste the JSON: provider `tomverse`,
  `api: "openai-completions"`, `baseUrl`, `apiKey`, `authHeader: true`, and per
  model `id`, `name`, `reasoning`, `input` (`text`, plus `image` where
  supported), `contextWindow`, `maxTokens`.
- **VS Code:** run *Chat: Manage Language Models* → *Add Models* → *Custom
  Endpoint* and use the generated entry as the `chatLanguageModels.json`
  provider: `vendor: "customendpoint"`, `apiType: "chat-completions"`,
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
migration `20261117150000_external_api_keys`, set `EXTERNAL_API_ALLOWED_USER_IDS` to the test account,
`EXTERNAL_API_ENABLED=true`, deploy, then create a key at `/settings/api`.

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
- The router's 200-token output limit counts reasoning, and twice cut the
  router's answer off on a request carrying a previous answer (`invalid`, the
  default model then answered). Shared with Chat's Smart Adaptive.
- Production migration, merge and deployment.
