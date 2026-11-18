/**
 * Help Centre v2 shapes. Framework-free so the catalogue, the page, the
 * assistant prompt and the tests all read one definition.
 *
 * The catalogue (`catalog.ts`) owns what is language-independent: which guides
 * exist, where they sit, what they need and where they lead. Each locale file
 * under `copy/` owns only words, keyed by the same ids, and a unit test holds
 * every locale to the catalogue's shape (same guides, same step count).
 */

export const HELP_CATEGORY_IDS = [
  "getting-started",
  "chat",
  "review",
  "images",
  "research",
  "files",
  "assistants",
  "imports",
  "connectors",
  "coding",
  "projects",
  "billing",
  "account",
  "notifications",
  "troubleshooting",
] as const;

export type HelpCategoryId = (typeof HELP_CATEGORY_IDS)[number];

/** Where a guide's "try it" button goes. Ids only; `links.ts` makes the URL. */
export type HelpGuideAction =
  | { kind: "product"; product: "chat" | "review" }
  | { kind: "settings"; section: "external-import" | "memory" | "assistants" | "account-data" | "email-notifications" | "api-keys" }
  | { kind: "settings-tab"; tab: "account" | "preferences" | "assistants" | "ai" | "data" | "plan" }
  | { kind: "public"; path: "/pricing" | "/refund" | "/status" | "/support" | "/privacy" };

/** A rectangle on a screenshot, in percent of its width and height. */
export type HelpHotspot = { x: number; y: number; w: number; h: number };

export type HelpGuideStepMeta = {
  /**
   * Screenshot key under `public/help/shots/<lang>/<key>.webp`, written by
   * `scripts/capture-help-centre-shots.mjs`. Optional: a step without one
   * reads as text only.
   */
  shot?: string;
  hotspot?: HelpHotspot;
};

export type HelpGuideMeta = {
  id: string;
  category: HelpCategoryId;
  /** Rough minutes to follow the guide, shown as a hint. */
  minutes: number;
  /** One entry per step; the locale copy must have exactly as many steps. */
  steps: readonly HelpGuideStepMeta[];
  requiresSignIn: boolean;
  /** A plan limit worth saying up front. Absent means every plan. */
  plan?: "paid";
  /** Shown on the hub's "common tasks" row, in this order. */
  popular?: number;
  isNew?: boolean;
  action?: HelpGuideAction;
};

export type HelpCategoryMeta = {
  id: HelpCategoryId;
  /** Tailwind colour classes for the dot; the accent roles of globals.css. */
  dot: string;
};

export type HelpStepCopy = { title: string; body: string };
export type HelpFaqCopy = { q: string; a: string };

export type HelpGuideCopy = {
  title: string;
  summary: string;
  steps: HelpStepCopy[];
  faq: HelpFaqCopy[];
};

export type HelpCategoryCopy = { title: string; description: string };

export type HelpUiCopy = {
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  heroTitleLead: string;
  heroTitleAccent: string;
  heroSubtitle: string;
  askPlaceholder: string;
  askButton: string;
  askMetaLead: string;
  askMetaPrivacy: string;
  askSignIn: string;
  askSignInButton: string;
  askUnavailable: string;
  askThinking: string;
  askError: string;
  askFollowUp: string;
  suggestions: string[];
  searchPlaceholder: string;
  searchEmpty: string;
  commonTasks: string;
  allGuides: string;
  byFeature: string;
  guideCount: string;
  stepsAndMinutes: string;
  newBadge: string;
  noAnswerTitle: string;
  contactTitle: string;
  contactBody: string;
  contactButton: string;
  statusButton: string;
  reportButton: string;
  assistantName: string;
  foundIn: string;
  notFound: string;
  notFoundBody: string;
  sources: string;
  helpful: string;
  thanks: string;
  disclaimer: string;
  openGuide: string;
  relatedGuides: string;
  requirements: string;
  signInRequired: string;
  signInNotRequired: string;
  planLabel: string;
  allPlans: string;
  paidPlans: string;
  breadcrumbHome: string;
  stepLabel: string;
  previous: string;
  next: string;
  faqTitle: string;
  stuckTitle: string;
  stuckBody: string;
  stuckPlaceholder: string;
  tryItTitle: string;
  tryItBody: string;
  tryItButton: string;
  onThisPage: string;
  stepsSection: string;
  nextGuides: string;
  backToHelp: string;
  newQuestion: string;
  /** The derived attachment format list (lib/helpCentre/attachmentFormats.ts). */
  formatsTitle: string;
  formatGroups: Record<"image" | "document" | "data" | "markup" | "code" | "archive", string>;
  /** `{list}`: extensions only a signed-in reader may attach. */
  formatsSignedInOnly: string;
  /** `{files}` and `{mb}` from lib/guestAttachmentPolicy.ts. */
  formatsGuestLimits: string;
  /** `{files}`, `{mb}` and `{total}` from lib/chatAttachmentLimits.ts. */
  formatsSignedInLimits: string;
};

export type HelpLocaleCopy = {
  ui: HelpUiCopy;
  categories: Record<HelpCategoryId, HelpCategoryCopy>;
  guides: Record<string, HelpGuideCopy>;
};
