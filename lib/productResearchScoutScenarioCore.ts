/**
 * The Scout's model-written task (docs/policy/product-research-agent.md §14),
 * without IO: what the scenario model is asked, and the one check on its answer.
 *
 * The fixed generations only ever ask for what someone already thought of. Once a
 * day, behind its own switch, the Scout's model writes one realistic request a
 * Tomverse user might make in Chat -- with the walker's synthetic files attached
 * when the task needs them -- and the walker sends it through the real composer
 * as `generated.explore`. The model call is taken from the Scout's daily cap; the
 * real turn spends one generation permit. The answer is checked by admitScenario
 * (a bounded request and only known fixtures) and nothing else.
 */
import {
  SCENARIO_ATTACHMENTS_MAX,
  SCENARIO_EXPECTATION_MAX_CHARS,
  SCENARIO_PROMPT_MAX_CHARS,
  SCOUT_EXPLORE_GENERATION,
  SCOUT_EXPLORE_TASK_ENV,
  SCOUT_FIXTURES,
  admitScenario,
} from "@/lib/productResearchScoutBrowserPolicy.mjs";

export { SCOUT_EXPLORE_TASK_ENV };

/** The Scout ledger subject of the scenario call. */
export const SCENARIO_SUBJECT = "scenario.explore";
/** Calls the scenario reservation leaves free: judging the planned turn needs one. */
export const SCENARIO_JUDGE_CALLS = 1;
export const SCENARIO_MAX_OUTPUT_TOKENS = 1_000;
/** Earlier findings on the model-written task, so the next request looks elsewhere. */
export const SCENARIO_RECENT_TITLES_MAX = 30;

export type ScoutScenario = { readonly prompt: string; readonly attachments: string[]; readonly expectation: string };

const fixtureLines = Object.entries(SCOUT_FIXTURES as Record<string, { description: string }>)
  .map(([name, fixture]) => `- ${name}: ${fixture.description}`)
  .join("\n");

export const SCENARIO_SYSTEM_PROMPT = `You plan one test for Tomverse, an AI chat platform, as a demanding QA engineer who thinks like its users.
Signed-in users chat with many AI models (Smart Auto picks one per message), compare answers, attach files (images, PDF, Word, Excel, CSV, archives), ask for files to be made (PDF, Word, Excel, PowerPoint), generate images, search the web, and use memory and assistants.
Write ONE realistic request, in natural Korean, that an ordinary user would type into Chat and that is likely to expose a gap: a task the product should handle but may refuse, misread, or do badly. Prefer tasks that combine things (an attached file turned into another file, a file read and summarised into a table, a chart rebuilt as a spreadsheet).
You may attach up to ${SCENARIO_ATTACHMENTS_MAX} of these synthetic files, by name; attach none when the task needs none:
${fixtureLines}
Never ask for anything unsafe, personal, or about a real person; the files are examples, not real documents.
Do not repeat what the findings in <recent> already cover; look somewhere else.
Return the request (at most ${SCENARIO_PROMPT_MAX_CHARS} characters), the attached file names, and in one Korean sentence what the user would expect to get back (at most ${SCENARIO_EXPECTATION_MAX_CHARS} characters).`;

export function scenarioPromptText(recentTitles: readonly string[], today: Date): string {
  const recent = recentTitles.slice(0, SCENARIO_RECENT_TITLES_MAX).map((title) => `- ${title}`).join("\n");
  return [`Today is ${today.toISOString().slice(0, 10)}.`, `<recent>\n${recent || "none"}\n</recent>`].join("\n");
}

export const SCENARIO_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "attachments", "expectation"],
  properties: {
    prompt: { type: "string" },
    attachments: { type: "array", maxItems: SCENARIO_ATTACHMENTS_MAX, items: { type: "string", enum: Object.keys(SCOUT_FIXTURES) } },
    expectation: { type: "string" },
  },
} as const;

/** The model's answer as a scenario the walker can run, or null. */
export const parseScenarioAnswer = (value: unknown): ScoutScenario | null => admitScenario(value);

export type ScenarioDeps = {
  readonly now: Date;
  readonly recentTitles: () => Promise<readonly string[]>;
  /** The owner's chosen model, or null when the model step is off. */
  readonly model: () => Promise<{
    readonly modelId: string;
    readonly planScenario: (recentTitles: readonly string[], today: Date) => Promise<{
      readonly scenario: ScoutScenario | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }>;
  } | null>;
  /** Takes one call from today's cap before the model runs (the Scout ledger). */
  readonly reserve: (modelId: string) => Promise<{ readonly id: string } | { readonly refused: string }>;
  readonly settle: (id: string, result: { ok: boolean; inputTokens: number | null; outputTokens: number | null; kept: number | null }) => Promise<void>;
};

export type ScenarioAnswer =
  | { readonly scenario: ScoutScenario }
  | { readonly judged: false; readonly reason: string };

/** Today's model-written request. Nothing is reserved or spent while the model is off. */
export async function runScenario(deps: ScenarioDeps): Promise<ScenarioAnswer> {
  const llm = await deps.model();
  if (!llm) return { judged: false, reason: "model_off" };
  const reservation = await deps.reserve(llm.modelId);
  if ("refused" in reservation) return { judged: false, reason: reservation.refused };
  const planned = await llm.planScenario(await deps.recentTitles(), deps.now);
  await deps.settle(reservation.id, {
    ok: planned.scenario !== null,
    inputTokens: planned.inputTokens,
    outputTokens: planned.outputTokens,
    kept: planned.scenario ? 1 : 0,
  });
  if (!planned.scenario) return { judged: false, reason: "model_failed" };
  return { scenario: planned.scenario };
}

/** The subject whose earlier findings steer the next request elsewhere. */
export const SCENARIO_FINDINGS_SUBJECT = SCOUT_EXPLORE_GENERATION;
