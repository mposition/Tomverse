# MCP-01 Connector Preview

Provider expansion after #3032: see [current coverage and setup](mcp-provider-expansion.md).
The ledger below records the original feature implementation before its merge.

Baseline: `origin/develop` at `7b18707463ba6a04ed399843c23935dcb287133b`.
Branch: `codex/to-develop/mcp-01-preview`. Existing checkout changes were
preserved in their original checkout. On 26 October 2026 the owner authorised
the feature-branch push and a PR targeting `develop`. Merge and deployment are
not part of that request; T10 activation will be performed in Dev, not Production.

## Task ledger

| Task | Local implementation | Verification | Dev deployment | Production |
| --- | --- | --- | --- | --- |
| T01 Protocol foundation | Complete | Official SDK / real synthetic HTTP | Not deployed | Not deployed |
| T02 Design | Complete | Editable Figma light/dark/mobile with service logos | Not deployed | Not deployed |
| T03 Connections and privacy | Complete | Ownership, encryption, revocation, export, account cascade | Not deployed | Not deployed |
| T04 Read/write execution | Complete | Explicit grants, one-use approval, unknown-outcome fence | Not deployed | Not deployed |
| T05 Chat integration | Complete | Mock model → real MCP → read sources → answer | Not deployed | Not deployed |
| T06 UI | Complete | Desktop/mobile browser flow and dark theme | Not deployed | Not deployed |
| T07 Boundary/regression checks | Complete locally | Protocol/DB/security 26, existing unit regressions 131, UI 10, zoom rechecks 2 | Not deployed | Not deployed |
| T08 Independent review | Accepted | Claude: r-20261025-230233-b98a8f, head 3c5426a6e | Not deployed | Not deployed |
| T09 Real service verification | GitHub OAuth/search/read/source path verified locally | Real GitHub MCP, PR #35 and test issue #36 read, mock-model Chat answer | Not deployed | Not deployed |
| T09-W Live write verification | Complete for the approved one-issue scope | Issue #36 created once, title/body/source and search verified, duplicate approval refused, prior read grants restored | Not deployed | Not deployed |
| T10 Operational rollout | Develop PR handoff; owner selected Dev for activation | Deployed verification pending | Not deployed; activation pending | Not deployed; activation excluded |

Synthetic success is not evidence of compatibility with GitHub, Railway,
Notion, Linear or Slack. The UI identifies unconfigured providers explicitly.
The host is provider-independent; a service must actually expose compatible
remote MCP and a separately scoped credential. Existing Drive file import and
Tomverse login permissions are not connector permissions.

T10 handoff: this PR does not activate the connector. Dev must apply the additive
DB migration and configure its own GitHub App credentials and canonical
`https://dev.tomverse.app/api/mcp/oauth/callback` before enabling the default-off
switch. The loopback app credentials and disposable local database are not Dev
configuration. Verify Dev OAuth, explicitly selected search/read/source, exact
write approval and disconnect/access blocking after deployment. Local test-issue
creation approval was consumed by issue #36; it does not authorise another write.
Production activation and paid-model evaluation remain outside this handoff.

## Implemented surface

- `/plugins` and the Plugins puzzle icon immediately below History in Studio.
- Server-registered remote Streamable HTTP providers; no provider-specific
  router or planner. SDK imports all use `@modelcontextprotocol/sdk@1.32.2`.
  MCP schema validation uses the pinned `ajv-mcp` alias for Ajv 8; existing
  Code execution keeps its original Ajv 6 dependency unchanged.
- Anonymous, separate bearer-token and OAuth authorization-code authentication.
  OAuth uses the same SDK generation, S256 PKCE, owner-bound one-use state,
  issuer/resource binding and encrypted server-side tokens. Static client
  registration and dynamic registration are supported; manual reauthentication
  can refresh tokens. Endpoint metadata is explicitly registered by the operator,
  never accepted from remote discovery or a browser. Arbitrary end-user URLs,
  legacy SSE and local stdio are not implemented.
- Up to 200 catalog tools, 32 explicitly selected tools and 8 connections per
  user. Catalog descriptions and annotations are never instructions or grants.
- Only a reviewed server `readTools` list can bypass per-call human approval.
  Every other selected tool proposes an encrypted, exact, one-use action.
- Argument fields are closed to undeclared properties. Literal enum/const
  constraints are enforced server-side and withheld from the model definition.
  Unsupported input/output schemas disable that tool, not the entire catalog.
- Pending actions expire after 10 minutes. Terminal payloads are erased;
  expired ciphertext is removed on inventory reads and existing maintenance.
  Running/unknown writes cannot be replayed, including after reauthentication.
  Only the owner can record a verified external outcome to clear that fence.
- Foreground calls: 6 per Chat model request, 8 seconds per protocol session,
  45 seconds per tool sequence, one in-flight call per connection, 24 admitted
  actions per user per minute, 128 KiB per HTTP response, 8 KiB arguments,
  8 KiB per model result and 24 KiB returned data per turn. Model steps share
  the existing reservation and total output allowance. Speculative result
  tokens widen internal cost reservations, not authored-input credit weight.
  Four model passes reserve all repeated input plus re-sent assistant output;
  the per-request context ceiling stays separate from that aggregate cost hold.
  Comparison panels keep their existing separate model reservations and share
  the connection lease and per-user admission limit.
- Raw MCP calls/results are neither persisted as provider reasoning context nor
  restored from historical context. Only the visible answer/source cards remain.
- Fresh DNS validation pins the actual socket address. Redirects are refused.
  Credentials are sent only to the exact configured endpoint over validated
  TLS. Loopback is available only through the explicit non-production fixture.
  Credentialed requests use fresh agents and explicit certificate verification.
  Echo checks cover split content parts and separator/fragment obfuscation.
  Registered credential recipients still require operator trust: no text filter
  can prove that a deliberately malicious recipient used no covert encoding.
- Source cards reuse existing Chat citation persistence/export. Only embedded
  resources actually returned with text are collected; search hits alone are
  not citations. Plain-text providers need a verified source mapping before
  claiming equivalent source-card support. No external documents or results
  are automatically written into Memory or a knowledge store.
- Connection, permission, outbound-data and error copy supports all seven
  existing locales, including Korean/English and secondary-locale explanations.
- Native clients can consume the same DTO/API. Native bearer enrollment is
  separately default-off; no native application rewrite or activation occurred.

## Default-off configuration

`MCP_CONNECTOR_PREVIEW_ENABLED` defaults to false. When enabled, the server reads
`MCP_CONNECTOR_SERVERS` as a JSON array of `{ id, name, url, auth, readTools }`.
`auth` is `none`, `bearer` or `oauth`; credentials are per-user encrypted DB references,
never environment values exposed in the provider catalog. No server is
configured by default. Changes to endpoint/auth/read scopes invalidate the
stored connection policy digest and require reconnection.

OAuth providers additionally configure `oauth: { issuer, authorizationUrl,
tokenUrl, scope, clientId?, clientSecretEnv?, registrationUrl? }`. Use either a
registered client ID or an explicitly approved dynamic registration endpoint.
Confidential clients use `client_secret_post`; public clients use `none`.
Register the app's canonical `/api/mcp/oauth/callback` URL with the provider.
Authorization flows expire in 10 minutes, erase secrets on completion/failure
or disconnect, and are swept after expiry by existing maintenance. Account
deletion cascades through them; export contains only their safe status timeline.

The local-only `MCP_CONNECTOR_SYNTHETIC_PORT` adds the fixture at the exact
`http://127.0.0.1:<port>/mcp` endpoint outside production.
`MCP_CONNECTOR_SYNTHETIC_OAUTH=true` enables the fixture's local OAuth endpoints.
`MCP_CONNECTOR_NATIVE_ENABLED` separately gates native bearer enrollment.
Neither switch is activated on Dev or Production by this changeset.

### GitHub OAuth

The first scoped profile uses a private GitHub App with Issues read/write and
Metadata read. The host permits only `search_issues`, `issue_read/get` and
`issue_write/create` in `mposition/TomverseCode` (repository ID `1309523852`).
Writes still require a separate one-use approval for the exact arguments.
Searches require plain terms; qualifiers and boolean scope overrides are refused.
Only bodies actually read by the bound `issue_read/get` call create source cards.
GitHub's Issues API also returns pull requests; their exact bound `/pull/<number>`
URL is retained instead of inventing an `/issues/` URL. Provider content and search
hits do not grant source status themselves. Documented zero-hit issue responses
map to the existing no-results state.

Use `MCP_GITHUB_OAUTH_CLIENT_ID`, `MCP_GITHUB_OAUTH_CLIENT_SECRET`,
`MCP_GITHUB_REPOSITORY` and `MCP_GITHUB_REPOSITORY_ID` for the built-in profile.
Do not also register another server with ID `github` in `MCP_CONNECTOR_SERVERS`.
The alternative explicit JSON profile is in
`config/mcp/github-tomverse-code.example.json`; its secret is an environment
reference. The issuer is exactly `https://github.com/login/oauth`; the code/token
destinations are fixed to GitHub. PKCE and
`offline_access` request expiring user tokens; an empty returned scope is valid
for a GitHub App. Code and refresh requests include the configured repository ID;
the host's repository check remains authoritative even if the provider ignores
that narrowing parameter. Development callback request logging is suppressed;
Sentry server/edge callback errors and transactions (including child spans) are
discarded so code/state parameters are not exported as telemetry.

For the local PC only (PowerShell, repository root), run `npm run setup:mcp-github`
after the focused credential-boundary review is accepted. This opens an owner-bound
loopback registration page. The owner clicks GitHub's Create button, then installs
the private app on **TomverseCode only**. The helper stores the client credentials
using Windows CurrentUser DPAPI outside the repository and discards the generated
PEM/webhook secret. It never prints credentials or reads/issues writes. Registration
has a 15-minute state/cookie deadline and never retries an uncertain exchange.
The UI only binds to `127.0.0.1:3132`; canonical product OAuth callback registration
is `http://127.0.0.1:3131/api/mcp/oauth/callback` for this local app. Dev/Production
must use separately registered canonical callbacks and their own secret settings.

The manifest callback now redirects directly to GitHub's installation page after
successful credential storage. The owner does not need to click an intermediate
installation link. Failed/unknown storage stays on the local status page, and a
replayed callback cannot redirect again. Three setup-flow tests cover these cases.
The local private app registration and CurrentUser-encrypted storage were observed
on 26 October 2026. The owner installed it on `mposition/TomverseCode` only and
completed OAuth. Installation and consent were owner actions.

`npm run dev:mcp-github` loads that encrypted registration into a loopback-only
development child. It requires a disposable DB on `127.0.0.1:56439` with
`schema=mcp_oauth_preview` (prepare it with the existing Prisma local schema setup).
It does not bypass normal Tomverse sign-in; normal local sign-in must be configured.
It does not migrate a deployed database or enable Dev/Production. From Plugins,
GitHub → Connect starts the ordinary owner-bound OAuth flow without token entry.
The owner installed the app on `mposition/TomverseCode` only and completed the
first OAuth consent. That callback was rejected before token exchange because
the initial registered issuer was the GitHub root rather than its OAuth issuer.
GitHub's public metadata at
`https://github.com/.well-known/oauth-authorization-server/login/oauth` confirms
the corrected issuer above. Exact issuer matching and policy-digest binding are
retained; old pending authorizations are not silently migrated or replayed.
Callback redirects expose only a fixed failure category, never code/state or
remote error text; the UI distinguishes expired authorization and sign-in needs.
The corrected fresh authorization completed real code exchange and Streamable
HTTP initialization/tool listing. The local connection contains exactly two
selected read tools: `search_issues` and `issue_read`; `issue_write` remains an
unselected confirmation-only catalog tool. Actual MCP searches for `MCP`, `bug`
and `*` returned zero hits; an independent read-only metadata check confirmed the
repository currently has no issues. Existing closed PR #35 was then read via
MCP `issue_read/get`: 2,347 UTF-8 body bytes, with the actual source
`https://github.com/mposition/TomverseCode/pull/35`. The normalized payload was
3,231 bytes, within the existing 8,000-byte per-result bound.

A mock model used the existing Chat tool adapter for three steps: real MCP
search, real MCP read, and an answer containing the verified source. This is
actual provider/transport evidence, not a paid-LLM quality evaluation or a claim
that every provider is compatible. That read-only run made zero external writes
and zero product paid-model calls. The subsequent owner-approved one-issue write
verification is recorded below. Provider-side token revocation, other services,
deployed Dev/Production and operational activation remain untested.

Claude accepted the canonical-issuer correction at `9c3c37e8c` in
`r-20261026-013010-07ae1a`. Follow-up changes cover safe UI wording, dependency
test typing, zero-hit status and GitHub's documented issue/PR source shape; they
do not expand the reviewed credential recipient, server, tool or repository scope.

Final focused checks pass: 19 boundary/provider tests, 2 callback/telemetry tests,
18 disposable-DB tests and 4 setup/Next-trace tests. The actual connected row also
passed owner-isolation, unselected-write refusal, encrypted credential/session
storage and credential-free public-projection checks. The connection remains
connected with the two read grants after local preview restart.

Next 16 development performance traces record full request URLs independently of
the request-log ignore setting. The loopback preview child now disables those
private performance spans using the installed version's threshold; a behavior
test pins that support. Existing local callback/sign-in trace queries were
redacted, and an HTTP callback probe after restart produced no performance trace
file or recorded authentication query. Runtime authorization/audit checks remain
enabled; this helper setting does not alter deployed logging or permissions.

### T09-W: owner-approved live issue creation

On 26 October 2026 the owner explicitly approved creating one synthetic issue in
`mposition/TomverseCode`, excluding push, merge and deployment. The existing
accepted write/approval boundary was reused without changing runtime code.

- Tool: GitHub MCP `issue_write`, method `create`, bound owner/repository above.
- Title: `[MCP-01 test] Connector verification`.
- Body: `Synthetic connector verification. No customer or production data.`
- Created resource: https://github.com/mposition/TomverseCode/issues/36.

The execution used the existing server-side grant and one-use approval path.
Preflight MCP search found no exact-title match; the pending action retained the
exact approved arguments encrypted. The owner's chat approval was applied once
through `decideMcpInvocation`. The invocation completed, erased its stored
arguments and rejected a second use of the same approval before external dispatch.
A local exclusive execution receipt additionally prevented replaying the test
command after an attempt, including uncertain outcomes.

MCP `issue_read/get` returned issue #36 with the exact title and body and its
actual read source. A subsequent MCP search found the new issue and did not
create a read citation from the search hit. Temporary `issue_write` selection
was removed, restoring the original `issue_read` and `search_issues` grants with
the existing version fence. The test issue remains available at the link above;
no comment, update, close or deletion was performed. Actual external writes in
this approved test: **1 issue creation**. Product paid-model calls: **0**.

This completes the local live-write test for the named GitHub repository, not
all-provider write compatibility or deployed readiness. Dev and Production are
unchanged and not deployed; push, merge and deployment were not performed.

Local OAuth increment verification: 23 protocol/security/provider-profile tests,
19 disposable-DB tests and 9 transport/telemetry/monitoring regressions pass.
Windows DPAPI round-trip self-test passes with synthetic data. Lint and the full
TypeScript check pass (the latter needs a larger heap for this repository).
The optimized build passes as well. Claude accepted the OAuth boundary at
`38d78ecc2` in `r-20261026-001231-00789c`. Its conditional schema-serialization
concern is covered by a pinned SDK behavior test: JSON tool schemas are enumerable
and included in the budget estimate. GitHub identifies `mposition` as a personal
User; the setup UI explicitly requires signing in as that account. Misconfigured
partial operator environment settings still fail closed for the connector list.
This accepted review remains applicable after the follow-up copy/test/evidence
changes, which do not change the reviewed authority or credential boundary.
This evidence contains no actual GitHub App creation, OAuth consent, issue read
or issue write.

## Local verification

The final focused protocol/DB/security batch passed 26 tests, including real
OAuth DCR/PKCE/token exchange, token redirects, schema recursion, owner isolation,
disconnect races and already-pending actions after an unknown write. Existing
Chat/search/budget/native/shared regressions passed 131 tests (one intentional
skip). Browser MCP flows passed 10 desktop/mobile cases. Two previous narrow
viewport failures passed on recheck with the development indicator hidden.
The broader composer run had 86 passes and 82 project skips; its two Windows
visual goldens are absent in this checkout and remain unverified rather than
being regenerated as evidence. These are local synthetic checks, not a live
provider or paid-model evaluation. A local production-mode fixture server was
refused by automatic execution review; browser verification used the existing
loopback-only development fixture instead. The optimized build passes separately.
The existing managed-Code test script also passes after isolating Ajv 8 behind
the MCP-only dependency alias; Code continues to resolve Ajv 6.15.0.

Local PC / PowerShell / repository root. The following commands write only
local test state and use synthetic data; no production credentials are needed.
The DB tests require a disposable local PostgreSQL instance on port 56439,
with the exact `mcp_preview_test` schema. The shared CI runner also executes
all three MCP DB suites in the accounts lane against its dedicated loopback
`127.0.0.1:5432/tomverse_test` database, with `CI=true` and matching
`TEST_DATABASE_URL`/`DATABASE_URL`. Other targets, including the real local
OAuth preview schema, are refused.

```powershell
node --conditions=react-server --import tsx --test tests/mcpConnectorProtocol.test.ts tests/mcpConnectorBoundary.test.ts
node --conditions=react-server --import tsx --test tests/integration/mcp-connector.db.test.ts tests/integration/mcp-oauth.db.test.ts tests/integration/mcp-migration.db.test.ts
npx playwright test tests/e2e/mcp-plugins.spec.ts
npm run typecheck
npm run build -- --large-heap
```

Use only the existing approved review orchestrator on the committed diff before
enabling authentication/external execution boundaries. Review is not activation,
merge or deployment approval. Product paid-model calls in local verification: 0.

## References

Review `r-20261025-142320-299ef2` rejected the first diff. The follow-up fixes
repeated-input reservations, provider-context retention, undeclared arguments,
untrusted schema literals, split credential echoes, fresh TLS agents, callback
binding and approval expiry. It also serializes a model's parallel tool calls,
skips unsupported catalog tools and counts only active connection capacity.
The installed Next generator explicitly writes the retained `##` heading.
Read-invocation audit events retain the existing transactional chain; batching
or replacing that chain is outside this preview.
Claude accepted the fixes in `r-20261025-230233-b98a8f` at `3c5426a6e`.
Follow-up verification: 35 core/DB/privacy tests, 2 transport tests and 72
existing regressions pass, along with lint, typecheck and the optimized build.
Known accepted preview limitations: composed/root-map argument schemas may not
be callable; enum/const constraints are hidden from the model and can require
explicit user-provided values; fragment echo checks can false-positive and
then require verified-outcome handling for a dispatched write. Encoded covert
channels from a malicious credential recipient are outside text-filter guarantees.

- SDK client and Streamable HTTP examples: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- GitHub remote MCP/authentication: https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
- GitHub OAuth metadata: https://github.com/.well-known/oauth-authorization-server/login/oauth
- GitHub Issues API and pull-request records: https://docs.github.com/en/rest/issues/issues#get-an-issue
- Railway remote MCP/authentication: https://docs.railway.com/ai/mcp-server
- Design: https://www.figma.com/design/k3aAzURkUUqVVLI8yAj4F7?node-id=2-16
