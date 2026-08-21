/**
 * Whether this turn may produce a file, and what the model is told either way.
 *
 * Policy: docs/policy/generated-artifacts.md sections 2, 7 and 9.
 *
 * Pure: no `ai`, no `server-only`, no Prisma. The decision is the part that
 * needs testing against every combination of plan, model and web-search mode,
 * and a decision that can only be exercised through a provider call is a
 * decision nobody exercises.
 *
 * The rule the whole file serves is the one the product cannot break: **the
 * app never regresses silently to text.** A turn either has the tool, or the
 * model has been told in the same request that it cannot make files and must
 * say so. There is no third state in which the user asks for a spreadsheet and
 * receives a Python script.
 */

import {
  ARTIFACT_LIMITS,
  SUPPORTED_ARTIFACT_FORMATS,
  type ArtifactFormat,
} from "@/lib/generatedArtifactCore";

/* ------------------------------------------------------------------------ */
/* Model capability                                                           */
/* ------------------------------------------------------------------------ */

export type ArtifactToolSupport = "verified" | "unverified";

/**
 * Which catalogue models are confirmed to call an application-defined tool
 * through the provider adapter this repository actually installs.
 *
 * Keyed by catalogue `id` rather than by provider, for the same reason
 * lib/webSearchCapability.ts is: two models behind one provider can differ,
 * and a provider-shaped assumption is how an unsupported model gets a tool it
 * silently ignores. Anything absent is `unverified`, which is a refusal, not a
 * guess -- and a refusal the user is told about, via `artifactSystemPrompt`.
 */
export const ARTIFACT_TOOL_CAPABILITIES: Readonly<
  Record<string, ArtifactToolSupport>
> = {
  // OpenAI -- function calling on the Responses API, used by @ai-sdk/openai.
  "gpt-5-6-sol": "verified",
  "gpt-5-6-terra": "verified",
  "gpt-5-6-luna": "verified",
  "gpt-5-5": "verified",
  "gpt-5-5-thinking": "verified",
  "gpt-5-4-mini": "verified",

  // Anthropic -- tool use is GA across the current generation.
  "claude-fable-5": "verified",
  "claude-opus-4-8": "verified",
  "claude-sonnet-5": "verified",
  "claude-haiku-4-5": "verified",

  // Google -- function declarations on the Gemini 3.x line. The disabled
  // legacy entries are deliberately absent: a model nobody can select does not
  // need a capability, and listing one would make the registry describe a
  // catalogue that no longer exists.
  "gemini-3-6-flash": "verified",
  "gemini-3-1-pro": "verified",
  "gemini-2-5-flash": "verified",

  // Everything else -- Groq, xAI, DeepSeek, Mistral, Moonshot, MiniMax, Qwen,
  // Zhipu and Perplexity -- is deliberately absent. Several of them do expose
  // function calling, and some of them probably work; "probably works" is the
  // state this registry exists to keep out. A model moves here when somebody
  // has run the tool against it, not when somebody has read a changelog.
  //
  // Perplexity is a separate case and will stay absent: its search models
  // answer from a live retrieval loop this app does not drive, and its
  // deep-research model never reaches this code path at all.
};

export const getArtifactToolSupport = (modelId: string): ArtifactToolSupport =>
  ARTIFACT_TOOL_CAPABILITIES[modelId] ?? "unverified";

/* ------------------------------------------------------------------------ */
/* The decision                                                               */
/* ------------------------------------------------------------------------ */

export const ARTIFACT_TOOL_MODES = ["generate", "sign_in_required", "off"] as const;
export type ArtifactToolMode = (typeof ARTIFACT_TOOL_MODES)[number];

export const ARTIFACT_TOOL_OFF_REASONS = [
  "model_unverified",
  "native_search_conflict",
  "not_a_chat_conversation",
  "no_conversation",
] as const;
export type ArtifactToolOffReason = (typeof ARTIFACT_TOOL_OFF_REASONS)[number];

export type ArtifactToolPlan = {
  /** `generate` writes files; `sign_in_required` refuses and says why. */
  mode: ArtifactToolMode;
  /** Present only when `mode` is "off". */
  offReason?: ArtifactToolOffReason;
  /** Whether the tool is sent to the provider at all. */
  registerTool: boolean;
  /** The system block this turn carries. Never empty. */
  systemPrompt: string;
};

export type ArtifactToolPlanInput = {
  modelId: string;
  provider: string;
  /** false for a guest session. */
  isAuthenticated: boolean;
  /**
   * Whether this turn has somewhere to attach a file: a server-side
   * conversation and an assistant message id. Separate from
   * `isAuthenticated` because the two fail for different reasons and the
   * user can only act on one of them -- a guest signs in, an account whose
   * turn carries no conversation is looking at a bug, not a paywall.
   */
  canPersist: boolean;
  /** Whether a provider-native web search tool is being sent this turn. */
  nativeSearchEnabled: boolean;
  /** Whether that native tool is being forced with `toolChoice: "required"`. */
  nativeSearchForced: boolean;
  /** "chat" conversations only; the image workspace has its own domain. */
  conversationKind: "chat" | "image";
};

/**
 * Whether the artifact tool can coexist with this turn's native web search.
 *
 * Two distinct incompatibilities, and neither is a matter of taste:
 *
 *   * A forced native search sends `toolChoice: "required"`, which means "call
 *     *a* tool". Adding a second tool lets the model satisfy that requirement
 *     by writing a spreadsheet and never searching -- so "always search" would
 *     quietly stop meaning always. The search wins: the user asked for it
 *     explicitly, and the file request has an unambiguous alternative (turn
 *     search off, or ask again).
 *   * Google's Search grounding is not a function declaration; on the Gemini
 *     API it is exclusive with them, and a request carrying both is rejected
 *     by the provider rather than degraded. Sending it would turn a file
 *     request into a 400.
 *
 * Anthropic's `web_search_20250305` has neither problem and keeps both.
 */
export const nativeSearchBlocksArtifactTool = (input: {
  provider: string;
  nativeSearchEnabled: boolean;
  nativeSearchForced: boolean;
}): boolean => {
  if (!input.nativeSearchEnabled) return false;
  if (input.nativeSearchForced) return true;
  return input.provider === "google";
};

const UNSUPPORTED_FORMATS = (
  ["docx", "pptx", "pdf", "json", "txt", "md"] as ArtifactFormat[]
).filter(
  (format) => !(SUPPORTED_ARTIFACT_FORMATS as readonly string[]).includes(format)
);

/**
 * The instructions that go with the tool.
 *
 * Three jobs, in order of how badly they fail without it:
 *
 *   1. tell the model that the file is the deliverable, so the answer body
 *      stops being a thousand-line Markdown table nobody can paste anywhere;
 *   2. tell it which formats exist, so it stops offering .docx;
 *   3. tell it never to write a link, a path or base64, because the download
 *      is attached by the application and any URL the model invents is a lie
 *      with a plausible shape.
 */
const GENERATE_PROMPT = [
  "# File generation",
  "",
  "You can create real, downloadable files for this user with the",
  "`create_spreadsheet` tool. When the user asks for a spreadsheet, an Excel",
  "file, a .xlsx, a CSV, or asks you to 'put this in a file', call the tool.",
  "",
  "Rules:",
  `- Supported formats: ${SUPPORTED_ARTIFACT_FORMATS.join(", ")}. If the user asks for ` +
    `${UNSUPPORTED_FORMATS.join(", ")} or any other format, say plainly that it is not ` +
    "supported yet and offer a supported one. Never pretend to have made it.",
  "- A request for .xlsx is answered with .xlsx. Never substitute CSV for it.",
  "- The tool takes structured data, not a file. You never produce bytes,",
  "  base64, a data URL, a file path or a download link; the application",
  "  attaches the finished file to your message and shows a download card.",
  "- Do not also print the whole table, the CSV text, or the Python/pandas code",
  "  that would have produced it. After a successful call, write one or two",
  "  short sentences saying what the file contains, in the user's language.",
  "- Put real values in the rows. Never invent data the conversation does not",
  "  contain; if something is unknown, leave the cell empty and say so.",
  "- Write plain values only. The tool has no formula field, and a string that",
  "  looks like a formula is stored as text.",
  `- Limits: at most ${ARTIFACT_LIMITS.maxWorksheets} worksheets, ` +
    `${ARTIFACT_LIMITS.maxRowsPerSheet} rows and ${ARTIFACT_LIMITS.maxColumnsPerSheet} ` +
    `columns per worksheet, and ${ARTIFACT_LIMITS.maxCells} cells in total. If the data ` +
    "does not fit, say so and offer a narrower selection rather than truncating silently.",
  "- If the tool reports a failure, tell the user what failed. Do not describe",
  "  a file that does not exist.",
].join("\n");

const SIGN_IN_PROMPT = [
  "# File generation",
  "",
  "This user is not signed in. File generation requires an account, so the",
  "`create_spreadsheet` tool will refuse. If the user asks for a spreadsheet,",
  "an Excel file, a .xlsx or a CSV, call the tool once anyway: the application",
  "uses the refusal to show a sign-in card next to your message.",
  "",
  "Then say briefly, in the user's language, that creating a downloadable file",
  "requires signing in. Do not write the file contents as a table, as CSV text,",
  "as code that would produce it, as base64, or as a link. None of those is the",
  "file the user asked for.",
].join("\n");

const offPrompt = (reason: ArtifactToolOffReason): string => {
  const why =
    reason === "native_search_conflict"
      ? "because web search is active for this turn"
      : reason === "not_a_chat_conversation"
        ? "in this workspace"
        : reason === "no_conversation"
          ? "for this request"
          : "with the model that is answering";
  return [
    "# File generation",
    "",
    `You cannot create downloadable files ${why}. If the user asks for a`,
    "spreadsheet, an Excel file, a .xlsx, a CSV or any other file, say so",
    "plainly in the user's language and say what would let them get one",
    reason === "native_search_conflict"
      ? "(turning web search off for this question)."
      : reason === "model_unverified"
        ? "(choosing a different model)."
        : "(starting the request again from a saved conversation).",
    "",
    "Do not write a file path, a download link, base64, or code that claims to",
    "save a file. You may still answer the question itself in the message.",
  ].join("\n");
};

/**
 * The whole decision for one turn.
 *
 * Ordered by which refusal is most specific, so the sentence the model is
 * given names the reason the user can actually act on: a guest on a model that
 * also cannot call tools is told to sign in, because signing in is the step
 * that is in front of them.
 */
export const planGeneratedArtifactTool = (
  input: ArtifactToolPlanInput
): ArtifactToolPlan => {
  if (input.conversationKind !== "chat") {
    return {
      mode: "off",
      offReason: "not_a_chat_conversation",
      registerTool: false,
      systemPrompt: offPrompt("not_a_chat_conversation"),
    };
  }

  if (getArtifactToolSupport(input.modelId) !== "verified") {
    return {
      mode: "off",
      offReason: "model_unverified",
      registerTool: false,
      systemPrompt: offPrompt("model_unverified"),
    };
  }

  if (
    nativeSearchBlocksArtifactTool({
      provider: input.provider,
      nativeSearchEnabled: input.nativeSearchEnabled,
      nativeSearchForced: input.nativeSearchForced,
    })
  ) {
    return {
      mode: "off",
      offReason: "native_search_conflict",
      registerTool: false,
      systemPrompt: offPrompt("native_search_conflict"),
    };
  }

  if (!input.isAuthenticated) {
    return {
      mode: "sign_in_required",
      registerTool: true,
      systemPrompt: SIGN_IN_PROMPT,
    };
  }

  if (!input.canPersist) {
    return {
      mode: "off",
      offReason: "no_conversation",
      registerTool: false,
      systemPrompt: offPrompt("no_conversation"),
    };
  }

  return { mode: "generate", registerTool: true, systemPrompt: GENERATE_PROMPT };
};

/**
 * A conservative allowance for what the tool definition itself costs.
 *
 * The JSON schema is sent with every request that registers the tool, and it
 * is priced input like anything else. Estimating it as a constant rather than
 * tokenising the schema is deliberate: the schema is fixed at build time, so a
 * measured constant is exact enough, and re-tokenising it per request would
 * spend real time on a number that cannot change between requests.
 *
 * Measured against the rendered schema and rounded up, so the reservation is
 * never short.
 */
export const ARTIFACT_TOOL_DEFINITION_TOKENS = 420;
