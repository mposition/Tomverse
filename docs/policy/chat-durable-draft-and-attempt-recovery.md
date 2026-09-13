# Chat durable draft and response-attempt recovery

Status: implementation contract, Phase 1 backend foundation.

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

## 3. Response attempt identity

`ChatResponseAttempt` is keyed by the client-selected assistant message id. Its
fingerprint is a SHA-256 over a versioned, length-delimited tuple containing the
conversation id, persisted source user-message id, requested model id, and the
effective request payload digest. Prompt text and attachment storage facts are
not copied into the row.

The attempt must be claimed before any provider call or credit/provider-budget
reservation. Creation records the owner and a lease no more than five minutes
after the server's claim time; checkpoint lease changes have the same bound.
Repeating the same assistant id with the same account and fingerprint returns
the existing state for read/reattachment; it never creates a second execution.
Within an account, reusing the id with a different fingerprint, source,
conversation, or model returns `409 CHAT_ATTEMPT_ID_REUSED` before create-only
scope or lease validation. A globally colliding id owned by another account is
never read for identity comparison; if creation otherwise passes validation,
the uniqueness conflict returns that same generic 409 without disclosing the
owner or stored attempt.

Phase 1 exposes only an authenticated GET for attempts. It does not wire claim,
checkpoint, terminal transition, cancellation, provider dispatch, reservation,
or client UI. Those server functions are foundations for Phase 2; adding a
route that calls them requires its own execution-order tests.

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

Finish reasons and failure codes are closed, public-safe classifications shared
by runtime parsing and database constraints. A failed attempt must use the
generic `error` finish reason and one of the approved coarse failure codes.
Completed and cancelled attempts cannot carry a failure code. Raw provider
messages, exception text, credentials and request fragments are never accepted
into either field, exposed by GET, or included in account export.

These rules preserve what the server has committed; they do not claim that a
provider stream can resume at an exact token boundary. Reattachment reads the
committed prefix and current state.

## 5. Read and reload are passive

Draft GET and attempt GET are passive with respect to recovery and model work.
A browser reload may call them, but neither route imports or invokes provider
dispatch, credit reservation, admission, routing, or retry code. They may write
ordinary security rate-limit bookkeeping. GET never changes recovery state,
changes owner, extends a lease, creates an attempt, or submits a message. A
retry remains an explicit user action and Phase 2 must claim it before any paid
or capacity-affecting work.

All responses use `Cache-Control: no-store`. Route parameters follow the
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
- Per-model assistant-history deletion removes attempt rows for the assistant
  message ids being deleted and no-message attempts attributed to that model,
  whether those orphan rows are active or terminal, inside the same
  transaction. It does not match on model alone without also scoping account
  and conversation. Before Phase 2 can dispatch attempts,
  claim and per-model deletion must additionally serialize on their shared
  conversation so a claim cannot commit immediately after a concurrent clear;
  that database race remains part of the Phase 2 integration test gate.
- No recovery response returns storage keys, provider-private state, prompt
  digests, fingerprints, owner ids, or lease ids.

## 7. Failure and observability boundary

Validation is 400, authentication is 401, missing and other-account recovery
scopes share a 404, locked conversations remain 423, and optimistic-concurrency
or attempt identity conflicts are 409. A local persistence refusal is not
provider health evidence and must never be attributed to a provider.
