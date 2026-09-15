/**
 * Which starter capabilities this deployment can actually answer yes to.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md section 2.
 *
 * Resolved on the server, for the same reason `imageGroupMaxModels` and the
 * web-search backend readiness are: the browser cannot read the process
 * environment, and a client-side copy of a capability would keep offering a
 * card after the deployment stopped being able to run it. What crosses to the
 * client is a list of capability ids, never a key, a backend name or a budget.
 *
 * Pure with respect to I/O -- it reads the compiled catalogue and a readiness
 * object handed to it -- so a test can drive every branch without a request.
 *
 * ## Fail-closed by omission
 *
 * A capability that cannot be established is simply absent from the returned
 * set, and `lib/chatStarterAvailability.ts` hides every card that names it.
 * There is no "assume yes" path, because the thing being assumed is a promise
 * on the first screen of the product.
 */

import {
  STARTER_CAPABILITY_IDS,
  type StarterCapability,
} from "@/lib/chatStarterCatalog";
import { CHAT_ATTACHMENT_FORMATS } from "@/lib/chatAttachmentFormats";
import { ARTIFACT_FORMAT_TABLE } from "@/lib/generatedArtifactFormats";
import { AVAILABLE_MODELS, modelSupportsImageInput } from "@/lib/models";
import { modelWebSearchIsDispatchable } from "@/lib/webSearchCapability";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";

export function resolveChatStarterCapabilities(input: {
  webSearchBackendReadiness: WebSearchBackendReadiness;
}): StarterCapability[] {
  const enabledModels = AVAILABLE_MODELS.filter((model) => model.enabled);

  const answers: Record<StarterCapability, boolean> = {
    // Dispatchable, not merely documented: a provider having built a search
    // tool this process cannot pay for or bound is not a search this card can
    // promise. `modelWebSearchIsDispatchable` is the same predicate the chat
    // route uses to decide whether to register the tool at all.
    "web-search": enabledModels.some((model) =>
      modelWebSearchIsDispatchable(model.id, input.webSearchBackendReadiness)
    ),
    "image-input": enabledModels.some((model) =>
      modelSupportsImageInput(model)
    ),
    // The attachment and artifact tables are the features. An empty table is
    // not a configuration state anybody expects, which is exactly why it is
    // checked rather than assumed: if one is ever emptied, the cards that
    // promised it disappear instead of failing on click.
    "document-attachment": CHAT_ATTACHMENT_FORMATS.length > 0,
    "generated-artifact": ARTIFACT_FORMAT_TABLE.length > 0,
  };

  return STARTER_CAPABILITY_IDS.filter((capability) => answers[capability]);
}
