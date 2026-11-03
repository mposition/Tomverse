/**
 * What the model is told about images on a chat turn.
 *
 * Report: `.github/audits/image-intent-auto-switch-2026-08-24.md` §5.1 and
 * appendix A, whose wording this file carries verbatim.
 * Policy: `docs/policy/image-generation.md` §13.
 *
 * ## The failure this removes
 *
 * A chat model asked for an infographic drew one out of box-drawing
 * characters. It had been told it could not make *files*
 * (lib/generatedArtifactToolPolicy.ts) and nothing at all about images, so it
 * produced the best picture it could reach. That is the same silent
 * substitution the artifact block exists to stop, one modality over:
 *
 *   the app never regresses silently to text.
 *
 * ## Assembly
 *
 * The block does not depend on what the user typed. The rule-based intent
 * classifier that used to pick an editing or an imperative-SVG paragraph was
 * removed 2026-10-20: the LLM judgement (`lib/chatImageIntent.ts`) decides
 * routing, and this prompt is the same for every turn in a given state.
 *
 *   CORE + HANDOFF[state] + ARTIFACT[state]
 *
 * ## What CORE may and may not deny
 *
 * It denies the raster workflow and raster images drawn inside the message --
 * not "images", because the SVG paragraph in the same request offers to create
 * one, and a request that says both is a request that says nothing.
 *
 * When no alternative paragraph follows, CORE must not ask the model to name a
 * way to get an image: on a deployment with the flag off and no file tool
 * there is no way, and a model told to name one invents a product.
 *
 * Pure: no Prisma, no `ai`, no `server-only`. The decision is the part worth
 * testing across every combination, and a decision reachable only through a
 * provider call is a decision nobody tests.
 */

/**
 * Whether this viewer can reach image generation at all, and if not, why.
 *
 * `hidden` is the flag being off -- for everyone, so the block says nothing
 * about a feature that does not exist here. The other three are the same
 * locked-exposure ladder the entry points render
 * (docs/ui-contracts/image-generation-workspace.md).
 */
export const IMAGE_HANDOFF_STATES = [
  "hidden",
  "sign_in",
  "upgrade",
  "available",
] as const;
export type ImageHandoffState = (typeof IMAGE_HANDOFF_STATES)[number];

/**
 * Whether this turn can make a file, mirroring `ArtifactToolPlan.mode`.
 *
 * Only `available` produces a paragraph. On the other two the artifact block
 * is already in the same request explaining itself, and a second voice saying
 * the same thing is priced input that adds nothing.
 */
export const IMAGE_ARTIFACT_STATES = ["unavailable", "sign_in", "available"] as const;
export type ImageArtifactState = (typeof IMAGE_ARTIFACT_STATES)[number];

export type ImageCapabilityPromptInput = {
  imageHandoff: ImageHandoffState;
  artifact: ImageArtifactState;
};

/* ------------------------------------------------------------------------ */
/* Fragments                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Always present.
 *
 * The text-art exception is inside the fragment rather than only in the prose
 * about it: a rule the model never receives is not a rule, and a fragment that
 * differs from the measured one makes the token figures fiction.
 */
export const IMAGE_CAPABILITY_CORE = [
  "# Images",
  "",
  "This chat cannot run the raster image-generation workflow, and cannot",
  "return a generated raster image inside the message. If the user asks for",
  "a picture, an illustration, a diagram or an infographic, say plainly what",
  "this chat can and cannot produce, in the user's language.",
  "",
  "Offer only an alternative described below. If no alternative is provided,",
  "state the limitation without inventing or recommending another path.",
  "",
  "You cannot edit an attached photo either. Never say another model, mode",
  "or setting would edit it.",
  "",
  "Never substitute a drawing made of text characters -- no ASCII art, no",
  "box-drawing or arrow diagrams standing in for a picture, no emoji layout",
  "pretending to be a chart. A text approximation of a requested image is a",
  "silent substitution, not an answer. The one exception is an explicit",
  'request for text art itself ("draw it in ASCII art"), which you may honour.',
  "",
  "You may still answer the question itself in words, and you may still use",
  "ordinary formatting -- a table is a table, not a drawing.",
].join("\n");

/**
 * The handoff paragraph: a prohibition, not a direction.
 *
 * ## What this used to say, and what it produced
 *
 * It used to tell the model where image generation is and to point the user
 * there. On 2026-08-25 a request for an infographic came back as a numbered
 * list of four formats -- SVG, Word/PDF, PowerPoint, and "the image
 * generation tool" -- ending in "which would you like?". The user answered
 * "4". The model then said, correctly, that it has no way to reach that tool
 * and told them to go find a tab.
 *
 * That is the app naming a destination only the app can walk to. The same
 * failure the artifact policy already forbids one modality over: **do not say
 * the app did something it cannot do**, extended to **do not offer a path you
 * cannot take**.
 *
 * So the model is now told to say nothing about reaching it. The offer is a
 * control the app renders beside the answer -- it navigates, it carries the
 * prompt, and it knows whether this viewer is locked out. A sentence can do
 * none of those things.
 *
 * ## Why three states now share one text
 *
 * `sign_in`, `upgrade` and `available` differed only in what the model was to
 * tell the user about *reachability*, and the model no longer tells them
 * anything about reachability. The ladder still exists and the control still
 * renders all three states (docs/ui-contracts/image-generation-workspace.md);
 * it is simply not the prompt's business any more. `hidden` stays empty: with
 * the flag off there is no control either, and CORE's "state the limitation
 * without inventing another path" is the whole answer.
 */
const HANDOFF_EXISTS = [
  "Image generation exists in this app, outside this answer. Do not",
  "describe it, do not explain how to",
  "reach it, and never present it as an option for the user to pick from a",
  "list -- you cannot navigate there, so a user who chooses it from your list",
  "has been sent nowhere.",
].join("\n");

export const IMAGE_HANDOFF_FRAGMENTS: Readonly<Record<ImageHandoffState, string>> = {
  hidden: "",
  sign_in: HANDOFF_EXISTS,
  upgrade: HANDOFF_EXISTS,
  available: HANDOFF_EXISTS,
};

/**
 * The file alternative, only when the tool is really registered.
 *
 * The second sentence is what keeps this consistent with CORE: CORE denied a
 * picture *inside the message*, and this offers a file the user downloads.
 * Without it the request contains both "cannot" and "can" about the same
 * thing.
 */
export const IMAGE_ARTIFACT_FRAGMENT = [
  "For a chart or diagram whose text must be exact, you can instead create a",
  "downloadable SVG file with the file tool. That is a file the user",
  "downloads, not a picture drawn inside the message; say so when you offer",
  "it.",
].join("\n");

/* ------------------------------------------------------------------------ */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The block this turn carries. Never empty.
 *
 * Paragraphs are joined with exactly one blank line; the byte figures in the
 * report's appendix A-5 depend on that separator.
 */
export const buildImageCapabilitySystemPrompt = (
  input: ImageCapabilityPromptInput
): string => {
  // The file paragraph only where it is possible: the file tool is really
  // registered. With no tool there is nothing to offer, and CORE's "state the
  // limitation without inventing another path" is the whole answer.
  const artifactFragment =
    input.artifact === "available" ? IMAGE_ARTIFACT_FRAGMENT : "";
  return [
    IMAGE_CAPABILITY_CORE,
    IMAGE_HANDOFF_FRAGMENTS[input.imageHandoff],
    artifactFragment,
  ]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * Which handoff state a viewer is in.
 *
 * Kept beside the fragments so the ladder is read from one place: the entry
 * points render the same four states, and a route that recomputed them would
 * eventually tell a Free account something the sidebar does not.
 */
export const resolveImageHandoffState = (input: {
  flagEnabled: boolean;
  isAuthenticated: boolean;
  planAllowsImageGeneration: boolean;
}): ImageHandoffState => {
  if (!input.flagEnabled) return "hidden";
  if (!input.isAuthenticated) return "sign_in";
  return input.planAllowsImageGeneration ? "available" : "upgrade";
};
