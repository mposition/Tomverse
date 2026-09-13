# Chat durable draft and response-attempt recovery

Status: implementation contract, Phase 2 durable send and recovery.

This policy extends the bounded in-memory recovery in
`docs/ops/chat-entry-transcript-recovery-v1.md`. It does not change Review,
continuation, Studio, image generation, guest local storage, or Deep Research's
persisted-job contract.

## 1. Product and identity boundary

- Durable recovery is available only to an authenticated account.
- A conversation-scoped record belongs only to an owned `Conversation` whose
  stored `productKey` is exactly `chat` and whose `kind` is `chat`.
- An existing owned Chat remains readable after cohort eligibility changes.
  A `new` draft follows the existing Chat surface-entry decision because no
  stored conversation exists yet.
- Conversation passwords remain effective. Reading or changing a scoped draft,
  and reading an attempt, requires the existing unlock grant.
- Draft scope reads and attempt GET make missing and other-account conversation
  or attempt identifiers indistinguishable and return the same 404. Claim is a
  separate identity operation. An existing attempt is looked up within the
  authenticated account before create-only scope and lease validation; a
  mismatched request for that owned id returns the same 409 without exposing
  private row contents. A cross-account primary-key collision is likewise a
  generic 409 after an otherwise valid create reaches the uniqueness boundary;
  the existing row and its account are never returned.

## 2. Composer draft

There is at most one `ChatComposerDraft` per `(userId, scopeKey)`. `scopeKey`
is either the literal `new` or the server conversation id. It is deliberately
not a browser-tab id: two tabs edit the same account draft through an explicit
concurrency contract instead of silently forking it.

The stored payload is only:

- exact draft text; and
- an ordered array of opaque `{uploadId}` or `{attachmentId}` references.

The application write boundary accepts no reference fields other than one
`uploadId` or one `attachmentId`; it therefore never intentionally writes a
name, media type, byte count, object key, path, bytes, data URL, extracted text,
or signed URL. Every route save resolves the handles with `userId` inside the
query. Bound attachments must belong to the scoped conversation; a `new` draft
accepts upload ids only. The database constraint provides a second bound on the
JSON value's top-level array shape and item count; exact object shape,
uniqueness and ownership remain application invariants tested at the route and
persistence boundaries.

`revision` starts at 1. Creation requires `expectedRevision = 0`; update and
delete require the exact stored revision. A successful update increments it by
one. There is no last-write-wins and no silent text or attachment merge. A
mismatch returns `409 CHAT_DRAFT_REVISION_CONFLICT` and the caller must read the
current state before choosing what to keep.

Draft synchronisation failure is visible state, not a silent best-effort path.
A failed or malformed GET, PUT, or DELETE keeps the local composer value,
shows a retry control, and retries only the same authenticated identity and
scope with bounded exponential backoff. Success clears the failure state;
changing account, conversation, or `new`-Chat identity cancels the old retry.
The retry never resolves a revision conflict or overwrites the server copy on
the user's behalf.

Consuming a draft into a persisted user Message is one transaction: the exact
draft text and the ordered opaque reference identities are verified, the new
Message and attachment bindings are written, and that exact draft revision is
deleted. The browser supplies a UUID `clientRequestId`, not a database Message
primary key. Before any Message or attachment lookup, the server derives a
deterministic version-8 UUID from a fixed SHA-256 namespace, the owned
conversation id, and that request id. Only the derived id is written to the
Message and MessageAttachment tables. The response returns the explicit
`{requestId,messageId}` mapping; only that persisted `messageId` may become the
provider request's `sourceUserMessageId`. The read-only receipt operation uses
POST so exact draft text and attachment provenance remain in a bounded private
body rather than a URL, but it performs no write and never calls a provider. It
repeats the same derivation from the request id and returns the mapping when it
proves a commit.
Consequently, copying an actual Message UUID from another account or
conversation into `clientRequestId` cannot name, probe, or bind attachments to
that row.

An exact replay of an already-persisted derived Message id succeeds without
deleting a newer draft. Replay equality is based on the original upload or
source-attachment identity and order, not mutable display metadata; reusing the
same request id with different content or provenance is a generic conflict.
Every partial `createMany` result is accepted only when all derived rows are an
exact, ownership-scoped replay; otherwise the transaction rolls back. The
attachment binder independently verifies the target user Message belongs to
the same owner and conversation, then reads back the complete ordered binding
set before it can report success.
For an authenticated stored-attachment save, a read-only comparison of the
draft revision, exact text, ordered provenance, and exact Message replay runs
before any attachment object is read or copied. That comparison grants no write
authority: the same checks repeat in the database transaction under the
conversation advisory lock, so a stale concurrent writer cannot commit. A
writer that loses only after preparing a fresh copy queues that unbound copy
through the existing attachment-cleanup path; process termination or cleanup-DB
unavailability retains the documented objects-first residual.

The pre-save replay check and provider source binding intentionally compare
different identities. Pre-save compares `sourceAttachmentId`, the immutable
provenance of the draft reference copied into the saved attachment. A later
provider request compares the current bound `MessageAttachment.id` returned to
the client and uses `sourceAttachmentId` only to validate provenance. Neither
path substitutes mutable attachment metadata for identity.
The first stored conversation may consume `scopeKey = new` through this same
server transaction. This contract proves the server-side consume boundary; it
does not infer or certify any preceding browser copy/delete sequence.

## 3. Response attempt identity

`ChatResponseAttempt` is keyed by the client-selected assistant message id. Its
fingerprint is a SHA-256 over a versioned, length-delimited tuple containing the
conversation id, persisted source user-message id, requested model id, and the
effective request payload digest. Prompt text and attachment storage facts are
not copied into the row.

For a context bundle, the effective request digest binds the verified semantic
context fingerprint and its bounded token fields. It deliberately excludes the
opaque bearer token or bundle id, so two independently issued bundles with the
same verified context cannot produce different attempt identities merely due to
credential identity. Only the claim winner may consume the bundle. A collision
during that consumption immediately terminalises the claimed attempt with a
public-safe failure, performs no provider call or credit reservation, and
requires a new assistant id and fresh context bundle for a later request.
The empty `failed / request_refused` row remains available through its direct,
owner-scoped attempt GET but is omitted from the conversation-detail attempt
list, where it would otherwise appear as an assistant turn that never ran.

The attempt must be claimed before any provider call or credit/provider-budget
reservation. Creation records the owner and a lease no more than five minutes
after the server's claim time; checkpoint lease changes have the same bound.
Before source lookup, advisory locking, or claim, the durable POST consumes a
separate authenticated admission bucket (`60/minute`, `5,000/day`) which also
applies the API security layer's coarser IP bucket. Both a fresh claim and an
exact POST reattachment consume it. This prevents recovery identity probes
from creating unbounded database or lock work before the ordinary Chat
admission path.
Repeating the same assistant id with the same account and fingerprint returns
the existing state for read/reattachment; it never creates a second execution.
Within an account, reusing the id with a different fingerprint, source,
conversation, or model returns `409 CHAT_ATTEMPT_ID_REUSED` before create-only
scope or lease validation. A globally colliding id owned by another account is
never read for identity comparison; if creation otherwise passes validation,
the uniqueness conflict returns that same generic 409 without disclosing the
owner or stored attempt.

New attempts are also bounded by storage quotas, defaulting to 2,000 rows per
account/conversation and 10,000 rows per account. Deployments may lower or
raise those positive limits with `CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION` and
`CHAT_RESPONSE_ATTEMPTS_PER_USER`. Creation counts are serialised by an
account-wide advisory lock before the conversation lock. An exact existing
identity may still reattach at capacity, but a different new identity is
refused with `409 CHAT_ATTEMPT_STORAGE_QUOTA_EXCEEDED`. These caps are a hard
storage bound, not a retention promise or permission to remove audit rows.

The authenticated stored-Chat send path wires claim, checkpoint and terminal
transition around the existing provider dispatch. Review, continuation, guest
and Deep Research keep their existing contracts and do not enter this path.

## 4. Checkpoints and terminal CAS

Attempt revisions are monotonic. `checkpointRevision` starts at 0. A checkpoint
write must name the current revision, a current owner with a live lease, and
content whose bytes begin with the previously committed `partialContent`.
Replacing, shortening, or editing the committed prefix is refused. A successful
checkpoint increments the revision once.

Only a non-terminal attempt may become `completed`, `failed`, or `cancelled`.
The terminal write uses the same expected-revision and owner/lease checks and
sets `terminalAt` in the same update. A completed value must also preserve the
committed prefix. Terminal rows are immutable. A stale worker cannot overwrite
a newer checkpoint or terminal result.

Visible stream prefixes are coalesced by size or one second, whichever arrives
first. A small final chunk therefore receives a scheduled checkpoint even when
no later chunk arrives; terminal flush remains the final owner/revision/database
clock barrier.

Credit settlement follows the provider outcome and is separate from Message
and attempt-state persistence. A checkpoint or terminal CAS failure is logged
and later reconciled through lease expiry, but it cannot suppress the provider
request's financial settle/refund call. If the transaction that would atomically
create the assistant
Message and complete its attempt rolls back, settlement is not repeated and the
attempt is immediately terminalised as a public-safe internal failure rather
than remaining active until lease expiry.

Finish reasons and failure codes are closed, public-safe classifications shared
by runtime parsing and database constraints. A failed attempt must use the
generic `error` finish reason and one of the approved coarse failure codes.
Completed and cancelled attempts cannot carry a failure code. Raw provider
messages, exception text, credentials and request fragments are never accepted
into either field, exposed by GET, or included in account export.

These rules preserve what the server has committed; they do not claim that a
provider stream can resume at an exact token boundary. Reattachment reads the
committed prefix and current state.

## 5. Read and reload are passive, except expired-lease reconciliation

Draft GET and attempt GET are passive with respect to model work. A browser
reload may call them, but neither route imports or invokes provider dispatch,
credit reservation, admission, routing, or retry code. They may write ordinary
security rate-limit bookkeeping.

There is exactly one recovery-state mutation authorised on an attempt or
conversation-detail GET: a fail-closed, ownership-scoped conditional update may
use the database clock to turn a `claimed` or `streaming` row whose lease has
already expired into terminal `failed / worker_lease_expired`. The update does
not change the owner, extend the lease, call a provider, reserve or settle
credit, reroute, create an attempt, or submit a Message. If the predicate no
longer matches, the read returns the newer row without retrying a mutation.
This bounded reconciliation is what prevents polling an abandoned worker from
reporting an active attempt forever; no other GET mutation is permitted.
The direct attempt route performs a non-mutating owner lookup and conversation
unlock check before invoking this reconciliation, so a caller without the
unlock grant cannot cause even that bounded state transition. Destructive
message-history operations perform the same expired-lease reconciliation under
the conversation advisory lock before their active-attempt refusal check; an
expired worker therefore cannot block deletion indefinitely merely because no
GET happened first.

All recovery JSON and errors use `Cache-Control: private, no-store`. A durable
POST stream additionally uses `no-transform`. Route parameters follow the
installed Next.js 16 contract and are awaited promises.

## 6. Deletion, export, and privacy

- Both tables relate to `User` with `onDelete: Cascade`; conversation-scoped
  rows also cascade with their conversation. Account and conversation deletion
  therefore remove recovery state in the same database transaction.
- A draft is the user's unsent content, so unified account export includes its
  text, scope, revision, and timestamps. Opaque attachment reference ids and
  internal row ids are withheld and the export manifest says so.
- An attempt export includes the visible partial answer, status, model/provider
  attribution, revision, terminal metadata, and timestamps. Fingerprints,
  owner/lease data, and other execution internals are withheld.
- Neither table changes attachment object retention. Deleting a draft does not
  delete an upload or a previously bound attachment; the existing attachment
  lifecycle remains authoritative.
- Per-model assistant-history deletion increments the conversation recovery
  epoch under the same advisory transaction lock used by claim, then removes
  attempt rows for the assistant
  message ids being deleted and no-message attempts attributed to that model,
  inside the same transaction. Any attempt in the conversation that is still
  `claimed` or `streaming` refuses every per-model clear, even when its current
  requested or actual model differs: fallback attribution is not final until
  dispatch. Terminal orphans for the cleared model are removed. Attempt deletion
  does not match on model alone without also scoping account and conversation.
  Before Phase 2 can dispatch attempts,
  claim and per-model deletion serialize on their shared conversation. A send
  captures the epoch while preparing its persisted source and claim verifies
  it under that lock, so a clear that wins first fences the stale send; a claim
  that wins first makes the clear refuse the active attempt. A new request that
  captures the incremented epoch remains valid.
- No recovery response returns storage keys, provider-private state, prompt
  digests, fingerprints, owner ids, or lease ids.

## 7. Failure and observability boundary

Validation is 400, authentication is 401, missing and other-account recovery
scopes share a 404, locked conversations remain 423, and optimistic-concurrency
or attempt identity conflicts are 409. A local persistence refusal is not
provider health evidence and must never be attributed to a provider.
