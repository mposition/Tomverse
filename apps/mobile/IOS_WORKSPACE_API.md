# iOS Chat-first workspace

Implemented from main `80a95b53ea9fe99f3ef1466fd142cfb0679dddcf`. iOS presentation is selected by Capacitor's platform. Android retains its workspace. `VITE_TOMVERSE_IOS_PREVIEW=true` is a development-only browser preview; it cannot select fixture transport in a production bundle.

The client preserves the Chat/Review setup origin in the mounted native panel through creation, knowledge setup and saving. Starting an assistant creates and binds a conversation in that origin, then opens it without sending a message. Existing drafts and conversation revisions are retained. This requires no web return URL, global pending-profile storage or web navigation change.

Both product creation requests carry `assistantProfileId`, so the existing server creation handler adopts the saved assistant models. An existing-conversation PATCH would intentionally retain its previous model choices and is not used for this start action. A saved assistant's explicit models are not subsequently overridden by Smart Adaptive. Ordinary new Chat creation retains its existing server-offered Auto behavior. Creation's identity-only receipt is followed by a profile read before presenting its published configuration.

## Server integration and activation

The server enrolls the exact workspace method/path pairs in `nativeWorkspaceBearerRoute`. Both proxy admission and route authentication use that list. `TOMVERSE_NATIVE_WORKSPACE_ENABLED=true` is required alongside the existing native Chat and parity switches; a missing switch keeps the new bearer calls unavailable. Each converted handler independently resolves the verified mobile owner and retains its existing ownership, feature, payload, rate and storage checks. Web cookie requests keep their existing behavior.

The capabilities endpoint reports the effective switches, including the existing assistant profiles, knowledge and external-import feature settings:

```json
{
  "workspace": {
    "assistantEditing": true,
    "assistantKnowledge": true,
    "externalImport": true
  }
}
```

Missing or non-true values are false. The server derives these values; the client cannot enable them. Activation follows review and the normal server deployment process. This document is not evidence of production activation or physical-device acceptance.

| Readback | Existing endpoint contracts consumed by this client |
| --- | --- |
| assistantEditing | POST `/api/assistant-profiles`; GET/PATCH `/api/assistant-profiles/:id`; POST `/api/assistant-profiles/:id/versions` |
| assistantKnowledge | GET/POST `/api/assistant-profiles/:id/knowledge` (capacity, prepare, signed byte transfer, finalize) |
| externalImport | GET `/api/imports/external/capacity`; POST `/api/imports/external`; POST `/api/imports/external/:id/batches`, `/seal`, `/finalize`; GET `/api/external-conversations`, `/:id`; POST `/:id/continuations` |

Profiles can still be selected/started using the already supported list and conversation APIs while authoring support is absent. Import entries on welcome/sidebar stay hidden while native import is unadvertised. Existing continuation history and its read-only source remain usable through their existing endpoints. Memory uses the existing native memory-settings contract.

The workspace enrollment excludes assistant-package import, exports, deletion, source lock management and public sharing. Locked external snapshots remain locked for native requests; web unlock cookies are never accepted as a native grant. Existing import finalize/extraction scheduling and knowledge processing are reused without changing their budgets or consent behavior. TestFlight 1.0.21 (12) already contains this client contract; a server deployment and application restart suffice to refresh its capability probe.

The client reuses the main export parser worker and batching/digest helpers. Archives stay on the device; selected normalized conversation text is uploaded. Non-importable or truncated conversations cannot be silently accepted by this mobile selection screen. A full truncation-approval review remains on the web. Import and memory are separate. Native signed uploads reuse the existing restricted uploader and never receive a Tomverse bearer token.

## Local validation

Run in this checkout's root using PowerShell; no production credentials are needed. These checks are local, with no live model, billing or customer-data calls:

```powershell
npm run typecheck --prefix apps/mobile
npm run build --prefix apps/mobile
node --conditions=react-server --import tsx --test tests/nativeWorkspaceTransport.test.mjs tests/nativeMobileTransport.test.mjs tests/nativeHistoryTransport.test.mjs
npm run test:ui:ios-design --prefix apps/mobile
```

The UI suite uses an explicitly development-only synthetic transport, WebKit and iPhone/iPad emulation. It establishes UI behavior, not native-device acceptance, production API enrollment, signing, App Review readiness or TestFlight distribution. Deployment, signing and submission are separate actions.
