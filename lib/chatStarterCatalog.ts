/**
 * Every card the Chat starter catalogue can offer, and what each one claims.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md.
 *
 * One table, for the reason `lib/generatedArtifactFormats.ts` and
 * `lib/chatAttachmentFormats.ts` are one table each: an entry is not one fact
 * but several that must agree -- the sentence a visitor reads, the work it
 * describes, what has to be switched on for it to run, what the click puts in
 * the composer, and which module actually does the thing. Kept apart, those
 * drift, and the way they drift is the failure this surface exists to avoid: a
 * card that promises something the build no longer does.
 *
 * Pure: no `server-only`, no Prisma, no `ai`, no `next`. The welcome screen in
 * the browser, the RSC shell that resolves the flags, the gate script and the
 * unit tests all read this same table.
 *
 * ## Adding an entry
 *
 * A row here, its two strings in all seven locales, and an `evidence` path
 * that exists. `npm run check:starter-catalog` fails on anything else, which
 * is the whole point of the table: when a feature ships, the entry point grows
 * by one row, and when a feature is switched off its card disappears on its
 * own rather than staying behind to lie about the product.
 */

import { IMAGE_GENERATION_FLAG_KEY } from "@/lib/imageGenerationAccess";
import { VOICE_INPUT_FLAG_KEY } from "@/lib/voiceInputAccess";
import type { ConversationProductKey } from "@/lib/conversationProduct";
import type { ModelTier } from "@/lib/models";
import type { TaskKind } from "@/lib/taskProfileCore";

/**
 * A runtime fact a card needs before it can be offered, and the module that
 * decides it.
 *
 * Capabilities are named rather than inlined so the gate can prove each one is
 * still answerable. A card requiring `web-search` when nothing in the
 * repository can resolve web search is a card that would be offered on a
 * guess, and the fail-closed answer to a guess is `hidden`.
 *
 * `resolvedBy` names a real export in a real module. The check script imports
 * neither -- it reads the file and looks for the name -- because the resolvers
 * reach into the model catalogue and a static check must not need one.
 */
export const STARTER_CAPABILITIES = {
  "web-search": {
    resolvedBy: "lib/webSearchCapability.ts",
    resolvedByExport: "modelWebSearchIsDispatchable",
  },
  "image-input": {
    resolvedBy: "lib/models.ts",
    resolvedByExport: "modelSupportsImageInput",
  },
  "document-attachment": {
    resolvedBy: "lib/chatAttachmentFormats.ts",
    resolvedByExport: "CHAT_ATTACHMENT_FORMATS",
  },
  "generated-artifact": {
    resolvedBy: "lib/generatedArtifactFormats.ts",
    resolvedByExport: "ARTIFACT_FORMAT_TABLE",
  },
} as const;

export type StarterCapability = keyof typeof STARTER_CAPABILITIES;

export const STARTER_CAPABILITY_IDS = Object.keys(
  STARTER_CAPABILITIES
) as StarterCapability[];

export const isStarterCapability = (value: string): value is StarterCapability =>
  Object.prototype.hasOwnProperty.call(STARTER_CAPABILITIES, value);

/**
 * Which accent role a card wears.
 *
 * `neutral` is not a missing decision, it is the decision: AGENTS.md reserves
 * the role hues for features that already own one, and this slice adds no new
 * role. A card whose feature has no accent of its own uses the neutral
 * blue/zinc palette rather than borrowing somebody else's meaning. The AI
 * Review gradient is reserved and appears nowhere here, including on the card
 * that describes AI Review.
 */
export const STARTER_ACCENT_ROLES = [
  "neutral",
  "web-search",
  "image",
  "generated-artifact",
] as const;

export type StarterAccentRole = (typeof STARTER_ACCENT_ROLES)[number];

/**
 * What the card asks of the viewer before it can be run.
 *
 * Every field is a separate question with a separate answer, and the two kinds
 * do not mix: `flagKeys` decides whether the feature *exists* in this
 * deployment, `signedIn` and `minimumPlan` decide whether *this viewer* may
 * reach one that does. The first produces `hidden`, the second `locked`, and
 * `lib/chatStarterAvailability.ts` is where that is enforced.
 */
export type StarterRequirements = {
  /** The card cannot run for a guest. */
  signedIn?: boolean;
  /** The lowest plan tier that may run it. Absent means every tier may. */
  minimumPlan?: ModelTier;
  /**
   * `AppSetting` keys that must all be on.
   *
   * Imported constants, never string literals written out again here. A typo
   * in a literal is a card that is hidden forever with nothing on screen to
   * say so; a typo in an import is a type error before the commit exists.
   */
  flagKeys?: readonly string[];
  /** Runtime facts from `STARTER_CAPABILITIES` that must all resolve. */
  capabilities?: readonly StarterCapability[];
};

/**
 * What the click puts in the composer.
 *
 * A seed, never a send. `promptSeedKey` names the locale string written into
 * the existing draft store; the booleans pre-arm the composer's own toggles.
 * Nothing here dispatches a turn, reserves a credit or names a price -- see
 * the contract's section 4.
 */
export type StarterSeed = {
  /** Locale key of the sentence written into the composer draft. */
  promptSeedKey: string;
  /** Turn the composer's web-search control on with the seed. */
  webSearch?: boolean;
  /** The seeded question expects a file, so open the attachment affordance. */
  attachment?: boolean;
  /** Which product the seeded conversation belongs to, when it is created. */
  productKey: ConversationProductKey;
  /**
   * Models the card suggests, when it suggests any.
   *
   * Optional and deliberately rare: a card that names models is a card that
   * has to be revisited every time the catalogue changes, so only the ones
   * whose whole point is a particular kind of model carry it.
   */
  suggestedModelIds?: readonly string[];
};

/**
 * The work the card describes, in the axes the repository already has.
 *
 * `lib/taskProfileCore.ts` owns this vocabulary and `MODEL_FINDER_TASKS`
 * shares it. A third axis invented here would be a third name for "this is a
 * coding question", and the two that exist are already carefully kept from
 * fusing.
 */
export type StarterTaskProfile = {
  kind: TaskKind;
  /** The seeded question wants information newer than any training cut-off. */
  needsCurrentInformation: boolean;
};

export type ChatStarterEntry = {
  /** Stable identifier. Appears in `data-starter-id`, never in user copy. */
  id: string;
  /**
   * Locale key of the sentence on the card.
   *
   * An **outcome**, not a feature name. "Ask three models the same question
   * about an 18-page PDF" is an outcome; "file attachment supported" is a
   * specification, and a specification is what a visitor reads when nobody
   * could say what it was for.
   */
  outcomeKey: string;
  taskProfile: StarterTaskProfile;
  requires: StarterRequirements;
  seed: StarterSeed;
  accentRole: StarterAccentRole;
  /**
   * The module that actually does what this card promises.
   *
   * Checked for existence by `npm run check:starter-catalog`. It is not proof
   * the feature works -- no static check can be -- but it is proof that
   * somebody had to name a real file, and it is what makes a deleted feature
   * fail the gate rather than leave a card behind.
   */
  evidence: string;
};

/**
 * The registry.
 *
 * Order is product priority, and it is not the order on screen: the screen cap
 * lives in `lib/chatStarterAvailability.ts` and may reorder within this one.
 * The registry is allowed to grow without limit; the screen is not.
 *
 * ## What is deliberately absent
 *
 * *Prompt Refiner* has no card. It has no `AppSetting` flag constant to name
 * (`docs/ui-contracts/prompt-refiner-suggestion.md` records it as wired but
 * not offered), and a card whose requirement cannot be written down is a card
 * that would be offered unconditionally. Writing the flag key out as a string
 * literal here would have made the gate pass and the promise false.
 *
 * *Deep Research* has no card for the same reason: no flag constant exists, so
 * there is nothing for `requires` to name.
 */
export const CHAT_STARTER_CATALOG: readonly ChatStarterEntry[] = [
  {
    id: "compare-answers",
    outcomeKey: "chatStarter.cards.compareAnswers.outcome",
    taskProfile: { kind: "general", needsCurrentInformation: false },
    requires: {},
    seed: {
      promptSeedKey: "chatStarter.cards.compareAnswers.seed",
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "components/chat/ChatApp.tsx",
  },
  {
    id: "document-questions",
    outcomeKey: "chatStarter.cards.documentQuestions.outcome",
    taskProfile: { kind: "documents", needsCurrentInformation: false },
    requires: { capabilities: ["document-attachment"] },
    seed: {
      promptSeedKey: "chatStarter.cards.documentQuestions.seed",
      attachment: true,
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "lib/chatAttachmentFormats.ts",
  },
  {
    id: "sourced-answer",
    outcomeKey: "chatStarter.cards.sourcedAnswer.outcome",
    taskProfile: { kind: "research", needsCurrentInformation: true },
    requires: { capabilities: ["web-search"] },
    seed: {
      promptSeedKey: "chatStarter.cards.sourcedAnswer.seed",
      webSearch: true,
      productKey: "chat",
    },
    accentRole: "web-search",
    evidence: "lib/webSearchCapability.ts",
  },
  {
    id: "debug-stack-trace",
    outcomeKey: "chatStarter.cards.debugStackTrace.outcome",
    taskProfile: { kind: "coding", needsCurrentInformation: false },
    requires: {},
    seed: {
      promptSeedKey: "chatStarter.cards.debugStackTrace.seed",
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "app/api/chat/route.ts",
  },
  {
    id: "spreadsheet-from-answer",
    outcomeKey: "chatStarter.cards.spreadsheetFromAnswer.outcome",
    taskProfile: { kind: "documents", needsCurrentInformation: false },
    // Guests cannot create files at all (docs/policy/generated-artifacts.md):
    // the tool is registered and refuses immediately. So this is `locked` with
    // the requirement said up front, never a card that fails on click.
    requires: { signedIn: true, capabilities: ["generated-artifact"] },
    seed: {
      promptSeedKey: "chatStarter.cards.spreadsheetFromAnswer.seed",
      productKey: "chat",
    },
    accentRole: "generated-artifact",
    evidence: "lib/generatedArtifactFormats.ts",
  },
  {
    id: "read-a-screenshot",
    outcomeKey: "chatStarter.cards.readAScreenshot.outcome",
    taskProfile: { kind: "general", needsCurrentInformation: false },
    requires: { capabilities: ["image-input"] },
    seed: {
      promptSeedKey: "chatStarter.cards.readAScreenshot.seed",
      attachment: true,
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "lib/models.ts",
  },
  {
    id: "translate-and-compare",
    outcomeKey: "chatStarter.cards.translateAndCompare.outcome",
    taskProfile: { kind: "multilingual", needsCurrentInformation: false },
    requires: {},
    seed: {
      promptSeedKey: "chatStarter.cards.translateAndCompare.seed",
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "components/chat/ChatApp.tsx",
  },
  {
    id: "compare-image-models",
    outcomeKey: "chatStarter.cards.compareImageModels.outcome",
    taskProfile: { kind: "general", needsCurrentInformation: false },
    requires: {
      signedIn: true,
      minimumPlan: "Pro",
      flagKeys: [IMAGE_GENERATION_FLAG_KEY],
    },
    seed: {
      promptSeedKey: "chatStarter.cards.compareImageModels.seed",
      productKey: "studio",
    },
    accentRole: "image",
    evidence: "components/images/ImageGenerationWorkspace.tsx",
  },
  {
    id: "speak-a-question",
    outcomeKey: "chatStarter.cards.speakAQuestion.outcome",
    taskProfile: { kind: "general", needsCurrentInformation: false },
    requires: { flagKeys: [VOICE_INPUT_FLAG_KEY] },
    seed: {
      promptSeedKey: "chatStarter.cards.speakAQuestion.seed",
      productKey: "chat",
    },
    accentRole: "neutral",
    evidence: "components/chat/VoiceInputControl.tsx",
  },
];

/** Every flag key any entry names, deduplicated. What a shell has to resolve. */
export const CHAT_STARTER_FLAG_KEYS: readonly string[] = [
  ...new Set(
    CHAT_STARTER_CATALOG.flatMap((entry) => entry.requires.flagKeys ?? [])
  ),
];

/** Every capability any entry names, deduplicated. */
export const CHAT_STARTER_REQUIRED_CAPABILITIES: readonly StarterCapability[] = [
  ...new Set(
    CHAT_STARTER_CATALOG.flatMap((entry) => entry.requires.capabilities ?? [])
  ),
];

export const findChatStarterEntry = (
  id: string
): ChatStarterEntry | undefined =>
  CHAT_STARTER_CATALOG.find((entry) => entry.id === id);
