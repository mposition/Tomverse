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
  REFUSED_ARTIFACT_EXTENSIONS,
  formatIdsOfKind,
} from "@/lib/generatedArtifactCore";
import {
  conversionSourceKind,
  isOfficeRenderable,
  turnHasConvertibleAttachment,
} from "@/lib/fileConversionCore";
import {
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
  type TurnAttachmentDescriptor,
} from "@/lib/messageAttachmentCore";
import { AVAILABLE_MODELS } from "@/lib/models";

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
  "gpt-6-luna": "verified",
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

/**
 * Providers whose adapter in this repository sends application-defined tools
 * and has been run against them -- every model in the register above is one
 * of theirs. A chat model the register does not list is recognised by its
 * provider, so a new OpenAI, Anthropic or Google model is file-capable from
 * the moment it is added, and any other provider's is not until someone ticks
 * it. Either way an administrator can tick or untick a model in the Admin
 * Console (`ModelRegistryEntry.fileToolsOverride`).
 */
export const ARTIFACT_TOOL_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
]);

/** What the decision reads about a model: the catalogue row's own fields. */
export type ArtifactToolModel = {
  id: string;
  provider?: string;
  usageClass?: string;
  /** An administrator's tick (true) or untick (false); null follows the code. */
  fileToolsOverride?: boolean | null;
};

/** The automatic answer, before any administrator's tick or untick. */
export const autoArtifactToolSupport = (model: ArtifactToolModel): ArtifactToolSupport => {
  // Deep research answers from a retrieval loop this app does not drive.
  if (model.usageClass === "deep-research") return "unverified";
  return (
    ARTIFACT_TOOL_CAPABILITIES[model.id] ??
    (model.provider && ARTIFACT_TOOL_PROVIDERS.has(model.provider) ? "verified" : "unverified")
  );
};

/**
 * Whether this model gets the file tools. A bare id reads only the register,
 * for callers that hold nothing else (older recorded router samples).
 */
export const getArtifactToolSupport = (model: string | ArtifactToolModel): ArtifactToolSupport => {
  if (typeof model === "string") return ARTIFACT_TOOL_CAPABILITIES[model] ?? "unverified";
  if (typeof model.fileToolsOverride === "boolean") {
    return model.fileToolsOverride ? "verified" : "unverified";
  }
  return autoArtifactToolSupport(model);
};

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
  /**
   * Whether `create_document_batch` is sent as well.
   *
   * Only on a turn that actually carries a Word template. A tool that has
   * nothing to act on is priced input the request had no use for, and a model
   * offered it anyway would eventually reach for it with an invented handle.
   */
  registerDocumentBatch: boolean;
  /**
   * Whether `convert_files` is sent as well.
   *
   * Only on a turn that carries a file a conversion could read -- an image, a
   * PDF, an .xlsx or a .csv -- for the same reason the batch tool is
   * conditional: a tool with nothing to act on is priced input, and a model
   * offered it anyway reaches for it with an invented handle.
   */
  registerFileConversion: boolean;
  /** The system block this turn carries. Never empty. */
  systemPrompt: string;
};

export type ArtifactToolPlanInput = {
  modelId: string;
  provider: string;
  /** The catalogue's usage class; deep research never gets the tools. */
  usageClass?: string;
  /** The catalogue row's tick or untick (ModelRegistryEntry.fileToolsOverride). */
  fileToolsOverride?: boolean | null;
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
  /**
   * Whether Auto chose `modelId` for this turn rather than the user.
   *
   * CHAT-ART-01. Only the wording of the unverified-model notice reads it:
   * telling someone who let Auto choose to "choose a different model" names
   * a choice they did not make. What Auto may choose is the Router's
   * decision, not this plan's.
   */
  autoRouted?: boolean;
  /**
   * The files the user attached to the turn being answered, in order.
   *
   * Handles only -- `att_1`, `att_2` -- plus the name and media type the card
   * already shows. No key, no size in bytes of anything the model could ask
   * for, and nothing that addresses a route.
   */
  turnAttachments?: readonly TurnAttachmentDescriptor[];
  /**
   * The operator's switch for `convert_files`. On unless it is passed false.
   *
   * A switch rather than a deploy because the tool reads user files with
   * libraries the rest of this domain does not use, and turning it off must
   * not need a release (policy section 14).
   */
  fileConversionEnabled?: boolean;
  /**
   * Whether office documents can be laid out as PDF by the renderer service
   * (lib/officeRenderer.ts, policy section 15). Off unless passed true.
   */
  officeRenderingEnabled?: boolean;
};

/**
 * Whether the artifact tool can coexist with this turn's web search.
 *
 * Two distinct incompatibilities, and neither is a matter of taste:
 *
 *   * A forced native search sends `toolChoice: "required"`, which means "call
 *     *a* tool". Adding a second tool lets the model satisfy that requirement
 *     by writing a spreadsheet and never searching -- so "always search" would
 *     quietly stop meaning always. The search wins: the user asked for it
 *     explicitly, and the file request has an unambiguous alternative (turn
 *     search off, or ask again).
 *   * Google's Search *grounding* is not a function declaration; on the Gemini
 *     API a built-in retrieval tool of that kind is exclusive with function
 *     declarations, and a request carrying both is rejected by the provider
 *     rather than degraded. Sending it would turn a file request into a 400.
 *
 * Anthropic's `web_search_20250305` has neither problem and keeps both.
 *
 * ## Why the Google rule is not "provider is Google"
 *
 * It reads that way, and for a while it was that way, and that was wrong in a
 * way that only mattered once the Google models started searching. The
 * exclusivity belongs to *grounding*, not to Gemini: a Gemini request carrying
 * ordinary function declarations is entirely ordinary, and Gemini 3 runs
 * built-in tools and custom functions together besides. What this application
 * sends a Google model now is `web_search`, a function declaration of its own
 * (`lib/appManagedWebSearchTool.ts`), and `buildWebSearchToolConfig` refuses to
 * emit grounding at all -- so there is no exclusivity to respect and blocking
 * the artifact tools would be refusing a file for a reason that no longer
 * exists on the request.
 *
 * The guard therefore keys on `nativeSearchEnabled`, which is false for the
 * application-managed route, and stays fail-closed for the case it was written
 * for: if anybody re-enables grounding, `nativeSearchEnabled` goes true for a
 * Google model again and this refuses again, without the rule having to be
 * remembered.
 */
export const nativeSearchBlocksArtifactTool = (input: {
  provider: string;
  /** A provider-native search tool is attached. Never true for app-managed. */
  nativeSearchEnabled: boolean;
  nativeSearchForced: boolean;
}): boolean => {
  if (!input.nativeSearchEnabled) return false;
  if (input.nativeSearchForced) return true;
  return input.provider === "google";
};

const formatList = (kind: Parameters<typeof formatIdsOfKind>[0]) =>
  formatIdsOfKind(kind).join(", ");

// Only recommend models available to every signed-in and guest user. This
// notice has no plan context, so suggesting a paid-tier model could be useless.
const FILE_CAPABLE_MODEL_NAMES = AVAILABLE_MODELS.filter(
  (model) =>
    model.enabled &&
    model.minimumPlan === "Guest" &&
    getArtifactToolSupport(model) === "verified",
)
  .slice(0, 3)
  .map((model) => model.name);

/**
 * The instructions that go with the tools.
 *
 * Four jobs, in order of how badly they fail without it:
 *
 *   1. tell the model that the file is the deliverable, so the answer body
 *      stops being a thousand-line Markdown table nobody can paste anywhere;
 *   2. tell it which tool makes which kind of file, so a deck request does not
 *      arrive as a Markdown outline;
 *   3. tell it which formats exist and which are refused outright, so it
 *      neither offers `.psd` nor tries to write an installer;
 *   4. tell it never to write a link, a path or base64, because the download
 *      is attached by the application and any URL the model invents is a lie
 *      with a plausible shape.
 */
const GENERATE_PROMPT_LINES = [
  "# File generation",
  "",
  "You can create real, downloadable files for this user. When the user asks",
  "for a file -- a spreadsheet, a document, slides, a script, a config file, a",
  "data file, a set of files -- call the matching tool.",
  "",
  `- \`create_spreadsheet\` -- ${formatList("spreadsheet")}`,
  `- \`create_document\` -- ${formatList("document")}`,
  `- \`create_presentation\` -- ${formatList("presentation")}`,
  `- \`create_text_file\` -- source code, markup and config: ${formatList("text")}`,
  `- \`create_archive\` -- ${formatList("archive")}, for delivering several files at once. ` +
    "Its entries are either authored text (`path`, `format`, `content`) or " +
    "documents the application renders for you (`path`, `documentFormat`, `blocks`).",
  "",
  "Rules:",
  "- The format the user names is the format you produce. Never substitute CSV",
  "  for a .xlsx request, or Markdown for a .docx one.",
  `- Never produce an executable or installer: ${REFUSED_ARTIFACT_EXTENSIONS.join(", ")}. ` +
    "Say plainly that you do not create those.",
  "- Any other extension is not supported. Say so plainly and offer the closest",
  "  supported format. Never pretend to have made a file you did not make.",
  "- The spreadsheet, document and presentation tools take structured content,",
  "  not a file; `create_text_file` and `create_archive` take the file's exact",
  "  text. In no case do you write bytes, base64, a data URL, a file path or a",
  "  download link -- the application attaches the finished file to your",
  "  message and shows a download card.",
  "- Do not also print the whole table, the whole file text, or the",
  "  Python/pandas code that would have produced it. After a successful call,",
  "  write one or two short sentences saying what the file contains, in the",
  "  user's language.",
  "- **Call the tool first, then speak.** Do not write a progress promise into",
  "  the answer -- no \"Let me analyse this\", no \"I will now create the web",
  "  page:\", no heading announcing the file. Say that the file exists only",
  "  after the tool has come back with `created`, and then in one or two",
  "  sentences. A sentence promising a file that no tool call followed is a",
  "  claim about work you did not do.",
  "- **Write the file, not a padded version of it.** For HTML and source",
  "  files, no repeated blocks that differ only in a value, no commentary",
  "  restating what the next line does, and no data repeated in two places.",
  "  Every wasted line makes it likelier the call is cut off before it ends,",
  "  and a call cut off produces no file at all.",
  "- **If it will not fit in one call, say so before you start one.** When the",
  "  content is too large for a single tool call, ask the user to narrow it --",
  "  fewer sections, fewer rows, one page instead of five -- or offer to split",
  "  it across separate requests. Do not begin a call you cannot finish, and",
  "  do not announce a file you are not about to produce.",
  "- Put real values in. Never invent data the conversation does not contain;",
  "  if something is unknown, leave it empty and say so.",
  "  When the user requests a fictional example or permits assumptions, supply",
  "  clearly labeled illustrative inputs and worked figures instead of deferring",
  "  every number. Keep assumptions distinct from actual or sourced data.",
  "- Preserve the user's requested document outline, section names and exact",
  "  heading count. Put a table caption in a paragraph block inside an existing",
  "  section, not an extra heading. Before calling create_document, check the",
  "  heading blocks against that outline; describe only the structure actually created.",
  "- Spreadsheets hold plain values only. There is no formula field, and a",
  "  string that looks like a formula is stored as text.",
  `- Limits: ${ARTIFACT_LIMITS.maxWorksheets} worksheets, ` +
    `${ARTIFACT_LIMITS.maxRowsPerSheet} rows and ${ARTIFACT_LIMITS.maxColumnsPerSheet} ` +
    `columns per worksheet, ${ARTIFACT_LIMITS.maxCells} cells in total; ` +
    `${ARTIFACT_LIMITS.maxDocumentBlocks} document blocks; ` +
    `${ARTIFACT_LIMITS.maxSlides} slides; ` +
    `${ARTIFACT_LIMITS.maxTextFileCharacters} characters per text file. ` +
    "If the content does not fit, say so and offer a narrower selection " +
    "rather than truncating silently.",
  `- **How many files.** You may attach at most ${ARTIFACT_LIMITS.maxArtifactsPerMessage} ` +
    "**top-level** files to one answer. That is a limit on attachments, NOT on " +
    "how many documents you can produce: an archive counts as one attachment " +
    `and may contain up to ${ARTIFACT_LIMITS.maxArchiveEntries} files. So ten ` +
    "spreadsheets, or fifty contracts, is one `create_archive` call -- it is " +
    "something you can do, and refusing it as over the three-file limit would " +
    "be wrong.",
  "- If the tool reports a failure, tell the user what failed. Do not describe",
  "  a file that does not exist.",
];

/**
 * What the model is told about converting the user's own files.
 *
 * On every `generate` turn, attachments or not, because the request that
 * matters most arrives without them: "make those two photos a PDF", sent a
 * message after the photos. The tool is not on that turn; what must not happen
 * is the model concluding the product cannot do it.
 */
const CONVERSION_RULES = [
  "- **Converting the user's own files.** Putting attached images into a PDF,",
  "  merging or splitting PDFs, taking or rotating PDF pages, drawing PDF pages",
  "  as images, changing an image's format or size, and re-saving an .xlsx or",
  "  .csv are done by `convert_files`. It is offered only on a message that has",
  "  those files attached to it. If the user asks for one of these and",
  "  `convert_files` is not available on this message, ask them to send the",
  "  request again with the files attached -- never say it cannot be done, and",
  "  never retype a file's content as a substitute for converting it.",
];

/** Office to PDF when the renderer can keep the layout, and when it cannot. */
const officeToPdfRule = (officeRendering: boolean): string[] =>
  officeRendering
    ? [
        "- An attached office document -- Word, PowerPoint, Excel, Hangul (HWP,",
        "  HWPX), OpenDocument, Pages or Numbers -- becomes a PDF *with its",
        "  layout* through `convert_files` (`to_pdf`, the file as a source). Use",
        "  that, not `create_document`, whenever the user wants the file itself as",
        "  a PDF.",
        "- A PDF's content as a Word, Excel or PowerPoint file is written again",
        "  with `create_document`, `create_spreadsheet` or `create_presentation`;",
        "  say that the layout is rebuilt rather than copied.",
      ]
    : [
        "- To turn an attached document's *content* into another format (a PDF's",
        "  text as a Word file, a Word file as a PDF), write it again with",
        "  `create_document` and say that the layout is rebuilt rather than copied.",
      ];

const generatePrompt = (
  fileConversionEnabled: boolean,
  officeRendering: boolean
): string =>
  [
    ...GENERATE_PROMPT_LINES,
    ...(fileConversionEnabled
      ? [...CONVERSION_RULES, ...officeToPdfRule(officeRendering)]
      : []),
  ].join("\n");

const SIGN_IN_PROMPT = [
  "# File generation",
  "",
  "This user is not signed in. File generation requires an account, so the file",
  "tools will refuse. If the user asks for a spreadsheet, a document, slides, a",
  "script, a config file or any other file, call the matching tool once anyway:",
  "the application uses the refusal to show a sign-in card next to your message.",
  "",
  "Then say briefly, in the user's language, that creating a downloadable file",
  "requires signing in. Do not write the file contents as a table, as CSV text,",
  "as a code block, as base64, or as a link. None of those is the file the user",
  "asked for.",
].join("\n");

const offPrompt = (reason: ArtifactToolOffReason, autoRouted = false): string => {
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
    "spreadsheet, a document, slides, a script or any other file, say so",
    "plainly in the user's language and say what would let them get one",
    reason === "native_search_conflict"
      ? "(turning web search off for this question)."
      : reason === "model_unverified"
        ? autoRouted
          ? // Auto chose this model; the user did not. Telling them to leave
            // Auto names a choice they never made: a file request sent again
            // is routed to a model that can create files.
            "(sending the same request again: Auto routes a file request to a model that can create files). Do not tell them to turn Auto off or to pick a model themselves."
          : `(choosing a different model, such as ${FILE_CAPABLE_MODEL_NAMES.join(", ")}).`
        : "(starting the request again from a saved conversation).",
    "",
    "Do not write a file path, a download link, base64, or code that claims to",
    "save a file. You may still answer the question itself in the message.",
  ].join("\n");
};

/** Which formats the batch tool can read a template from, and records from. */
const isBatchTemplate = (attachment: TurnAttachmentDescriptor) =>
  attachment.mediaType === DOCX_MEDIA_TYPE;
const isBatchData = (attachment: TurnAttachmentDescriptor) =>
  attachment.mediaType === XLSX_MEDIA_TYPE || attachment.mediaType === "text/csv";

/**
 * Whether this turn can run a template batch at all.
 *
 * A Word template is the necessary half: without one there is nothing to fill,
 * and registering the tool would be offering a capability with no input. The
 * data file is not required here -- a user may attach the template first and
 * the spreadsheet next turn, and the tool's own refusal names what is missing.
 */
export const turnSupportsDocumentBatch = (
  attachments: readonly TurnAttachmentDescriptor[] | undefined
): boolean => Boolean(attachments?.some(isBatchTemplate));

/**
 * The list of this turn's own files, as the model is allowed to see it.
 *
 * The handles are the whole point. A model that is asked to fill a template
 * has to be able to say *which* file is the template, and the two ways of
 * letting it -- a storage key or a database id -- are both things that must
 * never reach a model. So it gets `att_1`, which is a name for a position in
 * this request and nothing else.
 */
const attachmentSection = (
  attachments: readonly TurnAttachmentDescriptor[],
  registerFileConversion: boolean,
  officeRendering = false
): string => {
  const lines = [
    "",
    "## Files attached to this message",
    "",
    ...attachments.map(
      (attachment) =>
        `- \`${attachment.handle}\` -- "${attachment.name}" (${attachment.mediaType})`
    ),
    "",
    "Refer to these files ONLY by the handle above. You do not have their",
    "bytes, their base64, their XML, their storage key or a path, and there is",
    "no way to ask for any of those -- a handle is the whole of what a tool",
    "accepts.",
  ];

  if (turnSupportsDocumentBatch(attachments)) {
    const template = attachments.find(isBatchTemplate);
    const data = attachments.find(isBatchData);
    lines.push(
      "",
      "`create_document_batch` is available for this message. Use it when the",
      "user wants one document per row of a table: it fills the attached Word",
      "template once per row and returns every finished document in one .zip.",
      "It keeps the template's styles, tables, headers, footers, section setup",
      "and images, because it copies the template rather than rewriting it.",
      data
        ? `Here that means \`templateAttachment: "${template!.handle}"\` and ` +
          `\`dataAttachment: "${data.handle}"\`.`
        : "It also needs a spreadsheet of rows; if the user has not attached " +
          "one, ask for it rather than inventing the values.",
      "Give `filenameTemplate` as a naming rule over the spreadsheet's own",
      "column headers, for example \"{{name}}_contract\". Placeholders in the",
      "template are written the same way and may be split across formatting;",
      "the application handles that. If a value must never be blank, list its",
      "column in `requiredPlaceholders` and the batch will refuse rather than",
      "deliver an incomplete document."
    );
  }

  // Pictures from this turn's images and PDFs can go into a document. Said
  // whenever such a file is attached, because "make this PDF a Word file"
  // is a rebuild with create_document, and the figures are the part a
  // rebuild otherwise drops.
  if (attachments.some((attachment) => {
    const kind = conversionSourceKind(attachment.mediaType);
    return kind === "image" || kind === "pdf";
  })) {
    lines.push(
      "",
      "Pictures from these files can be placed in a document: add an `image`",
      "block to `create_document` (.docx or .pdf) with `attachment` (the",
      "handle), for a PDF the `page` (1-based), and `crop` -- the region",
      "holding the picture as fractions of the page from its top-left corner,",
      "read off the page you see -- plus an optional `caption`. When rebuilding",
      "a PDF as a Word file, place its figures this way rather than describing",
      "them in words."
    );
  }

  if (registerFileConversion) {
    const convertible = attachments.filter(
      (attachment) =>
        conversionSourceKind(attachment.mediaType) !== null ||
        (officeRendering && isOfficeRenderable(attachment.mediaType))
    );
    lines.push(
      "",
      "`convert_files` is available for this message. Use it when the user",
      "wants these files themselves converted, combined or split. You pass",
      "handles; the application works from the files' own bytes:",
      '- images and PDFs -> ONE PDF: `operation: "to_pdf"`, `sources` in page',
      "  order. One image per page. The same call merges PDFs, and takes,",
      '  reorders (`pages: "3,1,2"`) or rotates pages.',
      "- one PDF -> several PDFs in a .zip: `split_pdf`.",
      "- PDF pages -> PNG/JPG/WebP images: `pdf_to_images`.",
      "- an image -> another format, smaller or more compressed: `convert_images`.",
      "- an .xlsx or .csv -> xlsx, csv or a PDF table: `convert_spreadsheet`.",
      ...(officeRendering
        ? [
            "- an office document (Word, PowerPoint, Excel, HWP, HWPX, ODF, Pages,",
            "  Numbers) -> a PDF that keeps its layout:",
            '  `operation: "to_pdf"` with the file as a source. Several files, or',
            "  office files with images and PDFs, merge into one PDF in order.",
          ]
        : []),
      `The files it can read here: ${convertible
        .map((attachment) => `\`${attachment.handle}\``)
        .join(", ")}.`,
      "An attached image is a file you can pass by handle even though you",
      "cannot write its bytes. Never answer that attached images cannot be",
      "made into a PDF, and do not describe the images instead of converting",
      "them."
    );
  }

  return lines.join("\n");
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
      registerDocumentBatch: false,
      registerFileConversion: false,
      systemPrompt: offPrompt("not_a_chat_conversation"),
    };
  }

  if (
    getArtifactToolSupport({
      id: input.modelId,
      provider: input.provider,
      usageClass: input.usageClass,
      fileToolsOverride: input.fileToolsOverride,
    }) !== "verified"
  ) {
    return {
      mode: "off",
      offReason: "model_unverified",
      registerTool: false,
      registerDocumentBatch: false,
      registerFileConversion: false,
      systemPrompt: offPrompt("model_unverified", input.autoRouted === true),
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
      registerDocumentBatch: false,
      registerFileConversion: false,
      systemPrompt: offPrompt("native_search_conflict"),
    };
  }

  if (!input.isAuthenticated) {
    return {
      mode: "sign_in_required",
      registerTool: true,
      registerDocumentBatch: false,
      registerFileConversion: false,
      systemPrompt: SIGN_IN_PROMPT,
    };
  }

  if (!input.canPersist) {
    return {
      mode: "off",
      offReason: "no_conversation",
      registerTool: false,
      registerDocumentBatch: false,
      registerFileConversion: false,
      systemPrompt: offPrompt("no_conversation"),
    };
  }

  const attachments = input.turnAttachments ?? [];
  const registerDocumentBatch = turnSupportsDocumentBatch(attachments);
  const fileConversionEnabled = input.fileConversionEnabled !== false;
  const officeRendering = fileConversionEnabled && input.officeRenderingEnabled === true;
  const registerFileConversion =
    fileConversionEnabled &&
    turnHasConvertibleAttachment(attachments, { officeRendering });
  const prompt = generatePrompt(fileConversionEnabled, officeRendering);
  return {
    mode: "generate",
    registerTool: true,
    registerDocumentBatch,
    registerFileConversion,
    systemPrompt: attachments.length
      ? `${prompt}\n${attachmentSection(attachments, registerFileConversion, officeRendering)}`
      : prompt,
  };
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
 * never short. Raised from 2,600 when `create_document` gained the image
 * block (about 1,150 characters of schema and 230 of description, rounded up
 * to 500 tokens; policy section 16).
 */
export const ARTIFACT_TOOL_DEFINITION_TOKENS = 3100;

/**
 * The extra allowance for `create_document_batch`'s own schema.
 *
 * Counted separately because the tool is registered on some turns and not
 * others, and folding it into the constant above would price it into every
 * request that never sends it. Measured against the rendered schema and
 * rounded up, so the reservation is never short.
 */
export const ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS = 700;
