# MCP-01 Connector Preview

Baseline: `origin/develop` at `7b18707463ba6a04ed399843c23935dcb287133b`.
Branch: `codex/to-develop/mcp-01-preview`. Existing checkout changes were
preserved in their original checkout. No remote push, merge or deployment is
authorised by this work.

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
| T08 Independent review | In progress | Claude through existing review orchestrator | Not deployed | Not deployed |
| T09 Real service verification | Not performed | Requires chosen service/account and explicit access approval | Not performed | Not performed |
| T10 Operational rollout | Not authorised | Separate push/merge/deploy/activation approval | Not performed | Not performed |

Synthetic success is not evidence of compatibility with GitHub, Railway,
Notion, Linear or Slack. The UI identifies unconfigured providers explicitly.
The host is provider-independent; a service must actually expose compatible
remote MCP and a separately scoped credential. Existing Drive file import and
Tomverse login permissions are not connector permissions.

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
with `mcp_preview_test` in the connection URL. They refuse any other target.

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

- SDK client and Streamable HTTP examples: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- GitHub remote MCP/authentication: https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
- Railway remote MCP/authentication: https://docs.railway.com/ai/mcp-server
- Design: https://www.figma.com/design/k3aAzURkUUqVVLI8yAj4F7?node-id=2-16
