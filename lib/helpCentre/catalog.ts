import type { HelpCategoryId, HelpCategoryMeta, HelpGuideMeta, HelpGuideStepMeta } from "./types";

/**
 * Every Help Centre guide, in reading order within its category. Words live
 * in `copy/<lang>.ts` under the same id; `tests/helpCentreCatalog.test.mjs`
 * holds every locale to this list and to each guide's step count.
 */

export const HELP_CATEGORIES: readonly HelpCategoryMeta[] = [
  { id: "getting-started", dot: "bg-blue-400" },
  { id: "chat", dot: "bg-blue-600" },
  { id: "review", dot: "bg-gradient-to-r from-cyan-400 to-purple-400" },
  { id: "images", dot: "bg-fuchsia-500" },
  { id: "research", dot: "bg-violet-500" },
  { id: "files", dot: "bg-emerald-500" },
  { id: "assistants", dot: "bg-teal-500" },
  { id: "imports", dot: "bg-teal-300" },
  { id: "connectors", dot: "bg-orange-500" },
  { id: "coding", dot: "bg-fuchsia-300" },
  { id: "projects", dot: "bg-lime-400" },
  { id: "billing", dot: "bg-amber-500" },
  { id: "account", dot: "bg-slate-400" },
  { id: "notifications", dot: "bg-sky-400" },
  { id: "troubleshooting", dot: "bg-red-500" },
];

/**
 * `count` steps; `shots` names the screenshot (scripts/capture-help-centre-shots.mjs)
 * shown on a 1-based step. Only captured keys belong here.
 */
const steps = (count: number, shots: Record<number, string> = {}): HelpGuideStepMeta[] =>
  Array.from({ length: count }, (_, index) => (shots[index + 1] ? { shot: shots[index + 1] } : {}));

export const HELP_GUIDES: readonly HelpGuideMeta[] = [
  // getting started
  { id: "create-account", category: "getting-started", minutes: 2, steps: steps(5), requiresSignIn: false },
  { id: "tour-workspace", category: "getting-started", minutes: 2, steps: steps(5), requiresSignIn: false, action: { kind: "product", product: "review" } },
  { id: "chat-vs-review", category: "getting-started", minutes: 1, steps: steps(4, { 2: "chat-composer" }), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  // chat
  { id: "choose-model-auto", category: "chat", minutes: 1, steps: steps(4), requiresSignIn: false, popular: 1, action: { kind: "product", product: "chat" } },
  { id: "prompt-refiner", category: "chat", minutes: 1, steps: steps(3), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  { id: "voice-input", category: "chat", minutes: 1, steps: steps(4), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  { id: "voice-conversation", category: "chat", minutes: 2, steps: steps(4), requiresSignIn: true, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "use-current-location", category: "chat", minutes: 2, steps: steps(4), requiresSignIn: false, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "chat-starters", category: "chat", minutes: 1, steps: steps(3), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  // review
  { id: "compare-answers", category: "review", minutes: 2, steps: steps(5, { 1: "review-composer", 2: "review-composer" }), requiresSignIn: false, popular: 2, action: { kind: "product", product: "review" } },
  { id: "quick-difference-summary", category: "review", minutes: 1, steps: steps(4), requiresSignIn: false, isNew: true, action: { kind: "product", product: "review" } },
  { id: "read-ai-review", category: "review", minutes: 3, steps: steps(5), requiresSignIn: false, action: { kind: "product", product: "review" } },
  { id: "follow-citations", category: "review", minutes: 2, steps: steps(4), requiresSignIn: false, action: { kind: "product", product: "review" } },
  { id: "save-share-review", category: "review", minutes: 2, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "review" } },
  // images
  { id: "create-image", category: "images", minutes: 2, steps: steps(4, { 1: "chat-composer" }), requiresSignIn: true, popular: 3, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "compare-image-models", category: "images", minutes: 3, steps: steps(5), requiresSignIn: true, action: { kind: "product", product: "chat" } },
  { id: "edit-photo", category: "images", minutes: 2, steps: steps(3), requiresSignIn: true, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "image-credits", category: "images", minutes: 1, steps: steps(3), requiresSignIn: true },
  // research
  { id: "deep-research", category: "research", minutes: 3, steps: steps(5), requiresSignIn: true, plan: "paid", popular: 5, action: { kind: "product", product: "chat" } },
  { id: "web-search", category: "research", minutes: 2, steps: steps(4), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  // files
  { id: "attach-files", category: "files", minutes: 1, steps: steps(3), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  { id: "google-drive", category: "files", minutes: 2, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "chat" } },
  { id: "convert-files", category: "files", minutes: 2, steps: steps(4), requiresSignIn: true, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "generated-files", category: "files", minutes: 2, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "chat" } },
  // assistants
  { id: "create-assistant", category: "assistants", minutes: 4, steps: steps(5), requiresSignIn: true, action: { kind: "settings", section: "assistants" } },
  { id: "manage-memory", category: "assistants", minutes: 2, steps: steps(5), requiresSignIn: true, action: { kind: "settings", section: "memory" } },
  // projects
  { id: "organise-projects", category: "projects", minutes: 1, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "review" } },
  { id: "lock-conversation", category: "projects", minutes: 1, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "review" } },
  { id: "share-link", category: "projects", minutes: 1, steps: steps(4), requiresSignIn: true, action: { kind: "product", product: "review" } },
  // imports
  { id: "import-chatgpt", category: "imports", minutes: 5, steps: steps(5), requiresSignIn: true, popular: 4, action: { kind: "settings", section: "external-import" } },
  { id: "import-claude", category: "imports", minutes: 5, steps: steps(4), requiresSignIn: true, action: { kind: "settings", section: "external-import" } },
  { id: "continue-imported", category: "imports", minutes: 2, steps: steps(4), requiresSignIn: true, action: { kind: "settings", section: "external-import" } },
  { id: "import-gemini", category: "imports", minutes: 5, steps: steps(5), requiresSignIn: true, isNew: true, action: { kind: "settings", section: "external-import" } },
  { id: "import-guest-conversations", category: "imports", minutes: 1, steps: steps(3), requiresSignIn: true, action: { kind: "settings-tab", tab: "data" } },
  // connectors
  { id: "connect-plugin", category: "connectors", minutes: 3, steps: steps(4), requiresSignIn: true, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "custom-mcp-server", category: "connectors", minutes: 3, steps: steps(4), requiresSignIn: true, isNew: true, action: { kind: "product", product: "chat" } },
  { id: "use-plugin-in-chat", category: "connectors", minutes: 2, steps: steps(3), requiresSignIn: true, action: { kind: "product", product: "chat" } },
  // coding
  { id: "manage-api-keys", category: "coding", minutes: 2, steps: steps(5), requiresSignIn: true, plan: "paid", isNew: true, action: { kind: "settings", section: "api-keys" } },
  { id: "connect-claude-code", category: "coding", minutes: 4, steps: steps(5), requiresSignIn: true, plan: "paid", isNew: true, action: { kind: "settings", section: "api-keys" } },
  { id: "connect-codex", category: "coding", minutes: 4, steps: steps(5), requiresSignIn: true, plan: "paid", isNew: true, action: { kind: "settings", section: "api-keys" } },
  { id: "connect-cursor", category: "coding", minutes: 4, steps: steps(4), requiresSignIn: true, plan: "paid", isNew: true, action: { kind: "settings", section: "api-keys" } },
  { id: "api-smart-adaptive", category: "coding", minutes: 2, steps: steps(4), requiresSignIn: true, plan: "paid", isNew: true, action: { kind: "settings", section: "api-keys" } },
  { id: "api-usage", category: "coding", minutes: 2, steps: steps(4), requiresSignIn: true, plan: "paid", action: { kind: "settings", section: "api-keys" } },
  // billing
  { id: "how-credits-work", category: "billing", minutes: 2, steps: steps(5), requiresSignIn: false, action: { kind: "public", path: "/pricing" } },
  { id: "check-credits", category: "billing", minutes: 1, steps: steps(4), requiresSignIn: true, popular: 6, action: { kind: "settings-tab", tab: "plan" } },
  { id: "change-plan", category: "billing", minutes: 2, steps: steps(5, { 1: "pricing-page" }), requiresSignIn: true, plan: "paid", action: { kind: "public", path: "/pricing" } },
  { id: "cancel-subscription", category: "billing", minutes: 1, steps: steps(3), requiresSignIn: true, plan: "paid", action: { kind: "settings-tab", tab: "plan" } },
  { id: "request-refund", category: "billing", minutes: 2, steps: steps(3), requiresSignIn: true, action: { kind: "public", path: "/refund" } },
  // account
  { id: "manage-login-methods", category: "account", minutes: 2, steps: steps(5), requiresSignIn: true, action: { kind: "settings-tab", tab: "account" } },
  { id: "export-account-data", category: "account", minutes: 2, steps: steps(5), requiresSignIn: true, action: { kind: "settings", section: "account-data" } },
  { id: "delete-account", category: "account", minutes: 3, steps: steps(4), requiresSignIn: true, action: { kind: "settings-tab", tab: "account" } },
  // notifications
  { id: "email-notifications", category: "notifications", minutes: 2, steps: steps(5), requiresSignIn: true, action: { kind: "settings", section: "email-notifications" } },
  { id: "use-on-mobile", category: "notifications", minutes: 1, steps: steps(3), requiresSignIn: false, action: { kind: "product", product: "chat" } },
  // troubleshooting
  { id: "answer-stopped", category: "troubleshooting", minutes: 2, steps: steps(5), requiresSignIn: false },
  { id: "file-upload-failed", category: "troubleshooting", minutes: 2, steps: steps(4), requiresSignIn: false },
  { id: "report-a-problem", category: "troubleshooting", minutes: 1, steps: steps(4), requiresSignIn: false },
  { id: "sign-in-problems", category: "troubleshooting", minutes: 2, steps: steps(5), requiresSignIn: false },
  { id: "service-status", category: "troubleshooting", minutes: 1, steps: steps(3), requiresSignIn: false, action: { kind: "public", path: "/status" } },
  { id: "contact-support", category: "troubleshooting", minutes: 2, steps: steps(4), requiresSignIn: false, action: { kind: "public", path: "/support" } },
];

export const HELP_GUIDE_IDS: readonly string[] = HELP_GUIDES.map((guide) => guide.id);

const BY_ID = new Map(HELP_GUIDES.map((guide) => [guide.id, guide]));
export const helpGuideMeta = (id: string): HelpGuideMeta | undefined => BY_ID.get(id);

export const guidesInCategory = (category: HelpCategoryId): HelpGuideMeta[] =>
  HELP_GUIDES.filter((guide) => guide.category === category);
