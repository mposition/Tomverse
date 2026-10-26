# MCP provider expansion — 26 October 2026

Baseline: `origin/develop` at `92453adedeec2cad7f9b0696f275611a801cebd3`
(merged #3032). Branch: `codex/to-develop/mcp-provider-expansion`.
The clean worktree was fast-forwarded before branching; other checkouts were preserved.
This expansion is local. It has not authenticated new suppliers, changed Dev/Production,
pushed, merged or deployed. The original feature evidence remains in
[mcp-connector-preview.md](mcp-connector-preview.md).

| Task | Local implementation / evidence | Dev | Production |
| --- | --- | --- | --- |
| P01 Supplier analysis | Official Codex 65 and Claude Code 315 entries inspected; 181 distinct integration entries | No change | No change |
| P02 Remote profiles | 140 fixed profiles: 112 OAuth, 1 anonymous, 1 existing GitHub, 26 need additional configuration | Off by default | Off by default |
| P03 Directory and assets | Search/category/source filters, details, 7 locales, 170 original brand/repository assets | Not deployed by this task | Not deployed by this task |
| P04 Verification and review | In progress; local protocol/security and disposable DB verification | No new live service verified | No new live service verified |

## Coverage and limits

The public [source inventory](mcp-provider-inventory.json) records all 380 plugin
entries inspected as data, without executing their code, hooks or processes.
Pins: OpenAI `0722921d5542fc593105c27bd52630babd8b8c2a`,
Anthropic `58267944f92187b7d6a1c822165c96c81c864806`.
Many plugins are skills with no external MCP declaration. The 181 integration
entries comprise 116 remote providers, 8 managed apps, 56 local integrations and
1 legacy transport integration (PayPal SSE). The local Codex account directory
also returned 8,249 packages, mostly community/managed entries. That private,
account-specific list is not published or claimed as portable MCP coverage.

Public metadata inspection is not evidence of account authorization, successful
business operations or availability for every tenant. Only the earlier GitHub
test repository has live search/read/write evidence. Every vendor does not
necessarily expose both read and write operations. Provider permissions and
available tools determine the actual capabilities.
Managed app IDs, existing Google Drive import permissions and other platforms'
credentials cannot be reused as Tomverse connectors. Local stdio/hook execution
and legacy SSE remain unavailable in Chat. Arbitrary user-supplied URLs remain blocked.

## Operator configuration

Local PC / PowerShell / repository root. Read-only; no production credential needed:

```powershell
npm run mcp:providers -- --provider=notion --json
```

This prints public endpoints, scope options and environment-variable names,
never client secrets or tokens. Select fixed profiles using the comma-separated
`MCP_CONNECTOR_PROVIDERS`, in addition to the existing default-off
`MCP_CONNECTOR_PREVIEW_ENABLED`. Browsing the catalog does not change either.
Profiles without dynamic registration require their own registered app and
`MCP_PROVIDER_<PROFILE_ID>_CLIENT_ID` / `_CLIENT_SECRET` on the server.
Use uppercase IDs with hyphens replaced by underscores. Scope selection uses
`MCP_PROVIDER_<PROFILE_ID>_SCOPE`. The 74 profiles requiring an explicit scope
choice remain absent until the operator chooses among the recorded scopes.
Configure app callback URLs for `/api/mcp/oauth/callback`; loopback and Dev
credentials are separate. Asana, Slack, HubSpot, Zoom and Amazon Selling Partner
require static app registration.

The 26 `configure` profiles are not emitted as callable presets. They include
Google Workspace authentication, Cloudinary custom headers, a CockroachDB cluster
header and Pigment's tenant-specific address. These need a separately reviewed
adapter or the operator's existing supported server configuration. Missing
configuration is not a successful connection.

New profile tools need explicit grants and confirmation for every call.
`readOnlyHint`, directory entries and metadata responses never grant automatic
read execution. The reviewed GitHub repository boundary remains intact.
OAuth `none`, `client_secret_post` and `client_secret_basic` use official SDK
1.32.2. Basic credentials are allowed only at the fixed token endpoint and must
match the owned OAuth client. Cookies, Tomverse bearer credentials, redirects,
private DNS addresses and unregistered discovery remain blocked.

## Brand assets

Original asset bytes/colors are preserved, including intentionally monochrome
brands. The 11 entries without a verified asset use the puzzle fallback.
Original URLs are in `public/plugins/providers/sources.json`. Images are served
locally, without supplier image requests when browsing the directory. The browser
contains public catalog data, never authentication presets or operator secrets.

## Sources

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI official marketplace](https://github.com/openai/plugins)
- [Claude Code plugin discovery](https://code.claude.com/docs/en/discover-plugins)
- [Anthropic official marketplace](https://github.com/anthropics/claude-plugins-official)
- [Asana V2 client requirements](https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server)
- [MCP TypeScript SDK 1.32.2 client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.32.2/docs/client.md)
