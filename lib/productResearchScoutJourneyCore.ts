/**
 * The Scout's journey planner (docs/policy/product-research-agent.md §14),
 * without IO: what the planner model is asked, and the one check on its answer.
 *
 * Owner direction 2026-11-15: the defects people found by using Chat -- a
 * follow-up answered in text, a drawer left open after picking a conversation,
 * a new-chat draft gone after a look at another conversation -- live between
 * screens, where a screenshot of one page never looks. Rather than a fixed list
 * of flows, the Scout's model writes one journey a day across the families
 * below, steering away from what earlier findings already cover; the walker
 * follows it (lib/productResearchScoutJourney.mjs) and the judge sees every step.
 */
import {
  JOURNEY_ACTIONS,
  JOURNEY_ANCHORS,
  JOURNEY_ATTACHES_MAX,
  JOURNEY_KEYS,
  JOURNEY_PATHS,
  JOURNEY_SENDS_MAX,
  JOURNEY_STEPS_MAX,
  JOURNEY_TARGET_MAX_CHARS,
  JOURNEY_TEXT_MAX_CHARS,
  JOURNEY_VIEWPORTS,
  SCENARIO_ATTACHMENTS_MAX,
  SCENARIO_EXPECTATION_MAX_CHARS,
  SCOUT_FIXTURES,
  SCOUT_JOURNEY_GENERATION,
  SCOUT_JOURNEY_TASK_ENV,
  admitJourney,
} from "@/lib/productResearchScoutBrowserPolicy.mjs";

export { SCOUT_JOURNEY_TASK_ENV };

/** The Scout ledger subject of the planner call. */
export const JOURNEY_SUBJECT = "scenario.journey";
/** Calls the planner's reservation leaves free: judging the journey needs one. */
export const JOURNEY_JUDGE_CALLS = 1;
export const JOURNEY_MAX_OUTPUT_TOKENS = 1_500;
export const JOURNEY_RECENT_TITLES_MAX = 30;
/** The subject whose earlier findings steer the next journey elsewhere. */
export const JOURNEY_FINDINGS_SUBJECT = SCOUT_JOURNEY_GENERATION;

export type ScoutJourneyStep = { readonly action: string; readonly value: string };
export type ScoutJourney = {
  readonly viewport: string;
  readonly start: { readonly text: string; readonly attachments: string[] };
  readonly steps: ScoutJourneyStep[];
  readonly expectation: string;
};

const fixtureLines = Object.entries(SCOUT_FIXTURES as Record<string, { description: string }>)
  .map(([name, fixture]) => `- ${name}: ${fixture.description}`)
  .join("\n");
/**
 * The families of defects that live between screens. The planner is told to pick
 * a different one each day; the day's suggested family rotates through all of
 * them, so none is left out for long because the model keeps choosing another.
 */
export const JOURNEY_FAMILIES = Object.freeze([
  "state that should survive moving around: a draft, an attachment, a model choice, a scroll position -- left for another conversation or screen and come back to",
  "navigation that should finish its job: a drawer, menu or dialog that should close after a choice, the screen that should show what was picked, Back that should go where it came from",
  "follow-ups that build on the turn before: change the image or file just made, ask about the last answer, correct it",
  "a later turn that brings new files: after a turn with attachments worked, attach new files in the same conversation and ask again -- the second answer must read the new files and be as good as the first",
  "the same flow on a phone and on a desktop, switching conversations mid-answer, starting a new chat twice, Escape and Enter where a person would press them",
  "labels that show internal ids, codes or untranslated keys where a person expects words",
  // 2026-11-16: a conversation whose files added up past an internal text limit refused every later message.
  "limits and accumulation: one conversation carrying more and more -- the long text files below over two turns, several files at once, a long history -- up to and past what a single message could hold; every turn should still answer, or say plainly what is too big and what to do, and never refuse a short follow-up because of what came before",
  // 2026-11-16: after a failed answer the user switched model and opened a new chat; both failed the same way.
  "recovery after a failure: when an answer fails or is refused, do what a person does next -- retry, pick another model, or start a new chat with the same files -- and expect the product to recover rather than repeat the same error",
]);
const familyLines = JOURNEY_FAMILIES.map((family, index) => `${index + 1}. ${family};`).join("\n");

const anchorLines = Object.entries(JOURNEY_ANCHORS as Record<string, string>)
  .map(([name, description]) => `- ${name}: ${description}`)
  .join("\n");

export const JOURNEY_SYSTEM_PROMPT = `You plan one test for Tomverse, an AI chat platform, as a demanding QA engineer who uses it like a real person.
Signed-in users chat with many AI models (Smart Auto picks one per message), keep a history of conversations in a sidebar (a drawer on a phone, a History button in the studio rail), write drafts that should survive moving around, attach files, ask for files and images to be made and then changed, compare answers, use memory, assistants, plugins and settings.
When <production> lists failures real users hit lately (an error code, the model, how often), plan the journey that reproduces the most frequent one instead -- the same model when the model picker offers it, files and history like the failing turns -- because a defect users already hit outranks any family. Otherwise plan ONE journey of a few steps that a person would really take and that is likely to expose a defect that only shows BETWEEN screens. Plan it in today's family (named after the date) unless the findings in <recent> already cover that family; then pick another, and never repeat what <recent> covers:
${familyLines}
The walker starts on a new chat in Korean. Steps use only these actions, each with a value (empty when none):
- open: go to one of ${JOURNEY_PATHS.join(", ")}
- click: a named control below, or a button, link, tab or menu item by the exact words a Korean user sees (at most ${JOURNEY_TARGET_MAX_CHARS} characters)
- type: replace the chat composer's text (at most ${JOURNEY_TEXT_MAX_CHARS} characters, natural Korean)
- attach: add one of the synthetic files below to the composer, as a person adds a file to their next message (at most ${JOURNEY_ATTACHES_MAX} per journey)
- send: press send and wait for the answer (at most ${JOURNEY_SENDS_MAX} per journey; each is a real paid turn, so send only when the journey needs an answer)
- back: the browser's Back
- press: one of ${JOURNEY_KEYS.join(", ")}
Named controls:
${anchorLines}
You may also start with a draft already in the new chat: text, and up to ${SCENARIO_ATTACHMENTS_MAX} of these synthetic files:
${fixtureLines}
At most ${JOURNEY_STEPS_MAX} steps, on a ${JOURNEY_VIEWPORTS.join(" or ")} screen. Never delete, rename, share, sign out, buy, connect accounts or change settings: the walker refuses those writes anyway. Nothing about real people.
Return the viewport, the start draft, the steps, and in one Korean sentence what a person would expect to see along the way (at most ${SCENARIO_EXPECTATION_MAX_CHARS} characters).`;

export function journeyPromptText(recentTitles: readonly string[], today: Date, productionFailures: readonly string[] = []): string {
  const recent = recentTitles.slice(0, JOURNEY_RECENT_TITLES_MAX).map((title) => `- ${title}`).join("\n");
  const family = Math.floor(today.getTime() / 86_400_000) % JOURNEY_FAMILIES.length + 1;
  const production = productionFailures.map((line) => `- ${line}`).join("\n");
  return [
    `Today is ${today.toISOString().slice(0, 10)}. Today's family is ${family}.`,
    `<production>\n${production || "none"}\n</production>`,
    `<recent>\n${recent || "none"}\n</recent>`,
  ].join("\n");
}

export const JOURNEY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["viewport", "start", "steps", "expectation"],
  properties: {
    viewport: { type: "string", enum: [...JOURNEY_VIEWPORTS] },
    start: {
      type: "object",
      additionalProperties: false,
      required: ["text", "attachments"],
      properties: {
        text: { type: "string" },
        attachments: { type: "array", maxItems: SCENARIO_ATTACHMENTS_MAX, items: { type: "string", enum: Object.keys(SCOUT_FIXTURES) } },
      },
    },
    steps: {
      type: "array",
      maxItems: JOURNEY_STEPS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "value"],
        properties: { action: { type: "string", enum: [...JOURNEY_ACTIONS] }, value: { type: "string" } },
      },
    },
    expectation: { type: "string" },
  },
} as const;

/** The model's answer as a journey the walker can follow, or null. */
export const parseJourneyAnswer = (value: unknown): ScoutJourney | null => admitJourney(value) as ScoutJourney | null;

export type JourneyDeps = {
  readonly now: Date;
  readonly recentTitles: () => Promise<readonly string[]>;
  /** What real users' turns failed with lately (lib/productResearchScoutProductionFailures.ts); none when absent. */
  readonly productionFailures?: () => Promise<readonly string[]>;
  /** The owner's chosen model, or null when the model step is off. */
  readonly model: () => Promise<{
    readonly modelId: string;
    readonly planJourney: (recentTitles: readonly string[], today: Date, productionFailures?: readonly string[]) => Promise<{
      readonly journey: ScoutJourney | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }>;
  } | null>;
  /** Takes one call from today's cap before the model runs (the Scout ledger). */
  readonly reserve: (modelId: string) => Promise<{ readonly id: string } | { readonly refused: string }>;
  readonly settle: (id: string, result: { ok: boolean; inputTokens: number | null; outputTokens: number | null; kept: number | null }) => Promise<void>;
};

export type JourneyAnswer = { readonly journey: ScoutJourney } | { readonly judged: false; readonly reason: string };

/** Today's journey. Nothing is reserved or spent while the model is off. */
export async function runJourney(deps: JourneyDeps): Promise<JourneyAnswer> {
  const llm = await deps.model();
  if (!llm) return { judged: false, reason: "model_off" };
  const reservation = await deps.reserve(llm.modelId);
  if ("refused" in reservation) return { judged: false, reason: reservation.refused };
  const planned = await llm.planJourney(await deps.recentTitles(), deps.now, (await deps.productionFailures?.()) ?? []);
  await deps.settle(reservation.id, {
    ok: planned.journey !== null,
    inputTokens: planned.inputTokens,
    outputTokens: planned.outputTokens,
    kept: planned.journey ? 1 : 0,
  });
  if (!planned.journey) return { judged: false, reason: "model_failed" };
  return { journey: planned.journey };
}
