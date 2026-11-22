# Android native workspace parity

Implementation follows the approved [Figma screens](https://www.figma.com/design/44oPfGjVfOhogeeWUSGgpo?node-id=4-74).

## Source scope

- Previous Android store source: `90b9fafb71719342b89930e3aace2770abd55048`, version 1.0.22 (24).
- Main reviewed on 2026-11-22: `debe34842e1ae11a2cc04ce8061fb93f7c19f144`.
- Release PR #4162 was still open. Initially reviewed at `dba706054dde211f35665d3c60849fd0f8205cf6`, then checked again at `15af1dce7af059c1696e11cf066e81b27fb36928`.
- Feature branch starts from develop `6d1e1367178a0827f1d3385223a507ae61a2597b`. Release-train and main integration remain separate from this feature diff.

The source audit is a feature inventory, not a claim that every operational flag is enabled or that paid providers were exercised. Existing API, entitlement, billing, memory consent, upload and native permission checks remain authoritative.

## Functional coverage

| Area | Native coverage |
| --- | --- |
| Home | Shared iOS and Android Chat-first layout, centered original logo and wordmark, light/dark themes; starters only seed an unsent draft. |
| Smart Adaptive | Existing server offer, routing and manual selection paths; automatic-selection copy is shown only when offered. |
| Sending and recovery | Existing immediate Composer clearing, saved question, stream, reasoning/research recovery and uncertain-outcome handling. |
| Model catalogue | Existing live provider/model availability and plan limits; no hard-coded list of paid models. |
| Review | Easy/Professional selection and model/provider answer tabs; changing tabs never sends a question. Korean mode labels are localized. |
| Review analysis | Cross-review and quick differences are separate result actions, outside Composer tools. Estimates precede explicit execution. Unknown executions require readback. |
| Chat/Review connections | Existing Chat-to-Review context handoff. Saved analysis can become a previewed, revalidated Chat reference; an existing new-Chat draft is preserved and explicitly appended to. Nothing auto-sends. |
| History | Existing source titles, sorting, projects, search, locks, sharing/download gates and new-chat/history close behavior. |
| Image generation | Existing server image routing, model/quality catalogue, progress animation and quality guidance. The image starter is capability-gated. |
| Image input | Existing supported photo-edit routing, thumbnails, pending-result recovery and per-model eligibility. |
| Uploads | Existing upload progress modal, count/size/type/capacity checks and draft preservation when admission is refused. |
| Generated files | Existing Chat creation/conversion for spreadsheets, documents, presentations and PDF; download, supported revisions and version history. |
| External imports | Native ChatGPT, Claude, Gemini and Perplexity import entry, preview, selection, capacity checks and read-only originals. |
| Continuation context | Existing recent/selected passage context, provenance, fidelity receipts, lock/deletion state and continuation disclosure. |
| Assistants | Native create/edit, versioned instructions, model/tools/memory settings, reference-file processing and originating Chat/Review selection. |
| Memory | Existing account consent, retrieval and relevance behavior; entry stays in Library/settings/assistant setup, without a Composer memory switch. |
| Search/location | Existing sourced-answer paths and location permission/tool controls. No location status banner is added to Composer. |
| Research | Existing capability-gated plan/estimate, durable run display, restoration and explicit start. |
| Plans and purchases | Existing native store products, usage, credits, purchase confirmations, restoration and Tomverse pass-code handling. No price or credit contract changes. |
| Settings | Menu overview follows the approved layout; account, preferences, assistants, AI, data and plan retain their existing detail controls. Close returns to the conversation. |
| Developer tools | A clearly identified web entry opens the existing Developer settings for API, Cursor and CLI setup. No native secret-management or CLI execution is introduced. |
| Native bridges | Existing Android updates/back handling, browser/email auth, secure session, files, dictation, voice and location bridges remain in place. |

## #4162 changes

The release candidate additionally contains history/new-chat fixes, coding-model catalogue and channel links, external API cache accounting, CLI installation/help and operational read/stream preservation. User-facing native entries reuse existing server capabilities and web Developer setup. Administrative AMUX hierarchy, portfolio and planning changes remain server/admin functionality; they do not add mobile administrator authority.

The later #4162 changes affect the help guide and memory evaluation/approval register. This feature does not renew memory approvals, change evaluation records, activate memory/voice/research flags, change provider spending, or deploy the release candidate.

## Changed authentication boundary

`GET` and `POST /api/conversations/{id}/compare-summary` use the existing native session resolver and exact parity enrollment. Bearer authentication cannot fall back to an ambient web cookie. Origin, active-account, device/family/session revocation, conversation ownership/lock, rate limits and server credit admission remain in force. The new mobile client also requires the server's `reviewAnalysis.quickSummary` capability before requesting this route. No execution is made by opening its preview.

This boundary needs independent review before activation. No production merge, deployment, Play upload or store-listing write is performed by the local implementation.

## Store copy

The English and Korean [Google Play copy proposal](google-play-native-workspace-copy.md) is reviewable text. It does not promise automatic account synchronization, imported attachments, universally free image generation, or error-free AI analysis.

## Local verification

- Android/Chromium native UI: 224 checks passed; final layout/key regression subset: 20 passed.
- iPhone, iPad portrait and iPad landscape WebKit design/workflow suite: 27 passed.
- Exact #4162 candidate `15af1dce7af059c1696e11cf066e81b27fb36928` plus this patch: mobile typecheck, production web bundle, 53 authentication/API/model-image checks and local-bundle configuration check passed.
- Scoped ESLint, shared-package purity and native refresh-token boundary checks passed.
- English/Korean store-copy lengths: titles 27/23, short descriptions 80/45, full descriptions 2473/1334 characters.

UI and model responses in these local checks are synthetic. These results do not replace a physical Android check, live provider/billing validation, CI or a release approval.
