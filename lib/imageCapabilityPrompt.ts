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
 * ## Assembly is exclusion, not correction
 *
 * A turn carrying an attached image gets the editing paragraph *instead of*
 * the handoff and SVG paragraphs, not after them. Loading all three and
 * relying on the last to win hands the model contradictory instructions and
 * hopes for an ordering effect.
 *
 *   edit_or_reference:  CORE + EDIT_LIMITATION
 *   otherwise:          CORE + HANDOFF[state] + ARTIFACT[state]
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

import type { L0ImageIntent } from "@/lib/imageIntentSignals";

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
  intent: L0ImageIntent;
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
 * The handoff paragraphs.
 *
 * `available` names the workspace for photographs and illustrations and tells
 * the model *not* to send a text-dense chart there. That sentence is the
 * deferral of the text-heavy case
 * (.github/audits/image-intent-auto-switch-2026-08-24.md §5.2)
 * carried into the prompt: the
 * wording is "outside that path's current scope", a product-scope statement,
 * never a claim about how well the models render text -- which nobody has
 * measured.
 */
export const IMAGE_HANDOFF_FRAGMENTS: Readonly<Record<ImageHandoffState, string>> = {
  hidden: "",
  sign_in: [
    "Image generation exists in this app but requires signing in. Say that",
    "much and no more about how to reach it.",
  ].join("\n"),
  upgrade: [
    "Image generation exists in this app but is included only in the paid",
    "plans. Say that much and no more about how to reach it.",
  ].join("\n"),
  available: [
    "For a photo or an illustration, image generation is a separate workspace",
    "in this app, reachable from the composer's tools menu. Point the user",
    "there for those. A text-heavy chart or infographic is outside that",
    "path's current scope -- do not point there for one.",
  ].join("\n"),
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

/**
 * The same alternative, on a turn that already asked for one.
 *
 * The paragraph above offers; this one instructs, and the difference is a
 * wasted turn. A request for an infographic reached a model that held the file
 * tool, and the answer was a numbered list of three formats ending in "which
 * would you like?" -- so the person who had already said "draw it" had to
 * choose again and pay for a second turn to get what the first one could have
 * produced.
 *
 * Offering was not a rule violation: the artifact prompt says to call the tool
 * when a *file* is asked for, and nobody asking for an infographic says the
 * word "file". This paragraph closes that gap for the one class where the
 * answer is unambiguous -- a chart, a diagram, an infographic is a picture
 * made of text, which is exactly what this app can render exactly and a
 * text-to-image model cannot.
 *
 * It does not reach a raster request. Someone asking for a photograph or an
 * illustration wants neither an SVG nor a lecture about one.
 *
 * "Call the tool before you speak" is deliberately not repeated here. The
 * artifact block in the same request already says it, and a second copy is
 * priced input that adds nothing -- "after the file exists" carries the same
 * ordering in four words.
 */
export const IMAGE_ARTIFACT_MAKE_FRAGMENT = [
  "The user has asked for a chart, a diagram or an infographic. Make it now,",
  "with the file tool, as an SVG -- do not ask which format they would prefer",
  "and do not offer a list of options, because they have already said what",
  "they want and asking costs them another turn.",
  "",
  "It arrives as a file the user downloads rather than a picture drawn inside",
  "the message. Say that once, after the file exists.",
].join("\n");

/**
 * The attachment branch.
 *
 * Scoped to the workspace, which is what the policy actually settles: the
 * workspace is text-to-image only. It is not scoped to "this app", because
 * chat models do read attached images, and the last sentence keeps that door
 * open -- it is what stops a question *about* a picture from being answered
 * with a refusal.
 */
export const IMAGE_EDIT_LIMITATION_FRAGMENT = [
  "This turn carries an image the user attached. The image-generation",
  "workspace cannot edit an attached image or use one as a reference; it",
  "starts from text only. Say that plainly rather than sending the user",
  "there. You may still look at the attachment and answer questions about it.",
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
  if (input.intent === "edit_or_reference") {
    return [IMAGE_CAPABILITY_CORE, IMAGE_EDIT_LIMITATION_FRAGMENT].join("\n\n");
  }
  // The imperative paragraph only where it is both right and possible: the
  // request is a text-dense visual *and* the file tool is really registered.
  // With no tool there is nothing to instruct, and CORE's "state the
  // limitation without inventing another path" is the whole answer.
  const artifactFragment =
    input.artifact !== "available"
      ? ""
      : input.intent === "text_heavy_visual"
        ? IMAGE_ARTIFACT_MAKE_FRAGMENT
        : IMAGE_ARTIFACT_FRAGMENT;
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
