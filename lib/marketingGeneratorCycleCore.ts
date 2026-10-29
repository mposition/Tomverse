/**
 * One run of the marketing generator (S3 plan, S3e3): the app's context, one
 * A5 call per approval-mode account, the answers read, and each call's drafts
 * submitted under that call's ledger key. Pure orchestration over ports, so
 * the service and the tests drive the same code.
 *
 * **It stops rather than presses on.** A refused reservation (no pin, budget
 * spent, kill switch) refuses every later call too, and an unknown outcome is
 * a thing a person looks at (agent foundation rule 7), so the run ends at the
 * first of these and reports where.
 *
 * **A submission is the one thing it resends** -- the same signed bytes, never
 * a new call to the provider. The intake commits each draft on its own and
 * reads a key it has already taken back, so an answer lost part-way, or a 5xx,
 * is resolved by sending exactly that submission again: what committed is read
 * back, the rest is taken. Only this run holds those bytes, so the resend
 * happens here, a bounded number of times, and a run that still has no answer
 * ends and says so.
 *
 * Imports node built-ins and relative modules only, so the service loads it
 * with `--experimental-strip-types`.
 */

import {
  marketingA5Messages,
  marketingDraftSubmissionBody,
  marketingGeneratorContextSchema,
  readMarketingA5Answer,
  type MarketingA5Refusal,
} from "./marketingGeneratorDraftingCore.ts";
import type { MarketingDraftSubmission } from "./marketingDraftIntakeCore.ts";
import type { MarketingGeneratorReport } from "./marketingIntelReportCore.ts";
import type { MarketingLlmCallOutcome, MarketingLlmMessage } from "./marketingLlmClientCore.ts";

/** Time a call is not started without: one reservation, one provider answer and one submission. */
export const MARKETING_GENERATOR_CALL_BUDGET_MS = 90_000;

/** Sends of one signed submission when its answer is lost or a 5xx: the first and two resends. */
export const MARKETING_GENERATOR_SUBMIT_ATTEMPTS = 3;

/** The wait before each resend. */
export const MARKETING_GENERATOR_SUBMIT_BACKOFF_MS = [2_000, 5_000] as const;

export type MarketingGeneratorCycleDeps = {
  /** The app's context route, answered as JSON. Throws when there is no answer. */
  readonly readContext: () => Promise<unknown>;
  /** One ledger-accounted LLM call (`runMarketingLlmCall`, bound to its pin and ports). */
  readonly callLlm: (messages: readonly MarketingLlmMessage[], requestKey: string) => Promise<MarketingLlmCallOutcome>;
  /** The draft intake route. Throws when there is no answer. */
  readonly submit: (
    submission: MarketingDraftSubmission,
  ) => Promise<{ readonly httpStatus: number; readonly body: Record<string, unknown> }>;
  readonly secret: string;
  readonly newId: () => string;
  readonly now: () => number;
  /** Waits between resends of a submission. */
  readonly sleep: (ms: number) => Promise<void>;
};

export type MarketingGeneratorCycleSummary = {
  readonly calls: number;
  readonly draftsProposed: number;
  readonly draftsSubmitted: number;
  readonly dropped: Partial<Record<MarketingA5Refusal, number>>;
  /** Per submitted draft, the intake's answer: queued, rejected, refused or conflict. */
  readonly intake: Partial<Record<string, number>>;
  /** Where the run ended early, or null when every account was asked. */
  readonly stoppedAt:
    | null
    | { readonly stage: "context" | "deadline" | "llm" | "submit"; readonly detail: string };
};

export async function runMarketingGeneratorCycle(
  input: {
    readonly generatorRunId: string;
    readonly deadlineAt: string;
    readonly postsPerAccount: number;
  },
  deps: MarketingGeneratorCycleDeps,
): Promise<MarketingGeneratorCycleSummary> {
  let calls = 0;
  let draftsProposed = 0;
  let draftsSubmitted = 0;
  const dropped: Partial<Record<MarketingA5Refusal, number>> = {};
  const intake: Partial<Record<string, number>> = {};
  const summary = (stoppedAt: MarketingGeneratorCycleSummary["stoppedAt"]): MarketingGeneratorCycleSummary => ({
    calls,
    draftsProposed,
    draftsSubmitted,
    dropped,
    intake,
    stoppedAt,
  });

  let context;
  try {
    const parsed = marketingGeneratorContextSchema.safeParse(await deps.readContext());
    if (!parsed.success) return summary({ stage: "context", detail: "context_unreadable" });
    context = parsed.data;
  } catch {
    return summary({ stage: "context", detail: "context_unavailable" });
  }

  const deadline = Date.parse(input.deadlineAt);
  const accounts = [...context.channels]
    .filter((channel) => channel.allowedLocales.includes(channel.defaultLocale))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const [callIndex, account] of accounts.entries()) {
    if (deadline - deps.now() < MARKETING_GENERATOR_CALL_BUDGET_MS) {
      return summary({ stage: "deadline", detail: "deadline_too_close" });
    }
    const scope = { channelId: account.id, locale: account.defaultLocale, count: input.postsPerAccount, callIndex };
    const requestKey = deps.newId();
    calls += 1;
    const outcome = await deps.callLlm(marketingA5Messages(context, scope), requestKey);
    if (outcome.status === "refused") return summary({ stage: "llm", detail: `${outcome.stage}:${outcome.code}` });
    if (outcome.status !== "answered") return summary({ stage: "llm", detail: outcome.status });

    const read = readMarketingA5Answer(outcome.content, context, scope);
    for (const [reason, count] of Object.entries(read.dropped)) {
      dropped[reason as MarketingA5Refusal] = (dropped[reason as MarketingA5Refusal] ?? 0) + (count ?? 0);
    }
    draftsProposed += read.drafts.length;
    if (read.drafts.length === 0) continue;

    const submission = marketingDraftSubmissionBody(deps.secret, {
      generatorRunId: input.generatorRunId,
      submissionId: `call-${callIndex}`,
      deadlineAt: input.deadlineAt,
      drafts: read.drafts,
      llmCallRequestKeys: [outcome.requestKey],
    });
    // The same bytes each time: a resend is a read-back of what committed and
    // the intake of what did not, never a second draft.
    let answer: { readonly httpStatus: number; readonly body: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < MARKETING_GENERATOR_SUBMIT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await deps.sleep(MARKETING_GENERATOR_SUBMIT_BACKOFF_MS[attempt - 1] ?? 5_000);
      try {
        answer = await deps.submit(submission);
      } catch {
        answer = null;
        continue;
      }
      // A 4xx is this submission's fault, and sending it again changes nothing.
      if (answer.httpStatus < 500) break;
    }
    if (answer === null) return summary({ stage: "submit", detail: "outcome_unknown" });
    if (answer.httpStatus !== 200 || !Array.isArray(answer.body.results)) {
      return summary({ stage: "submit", detail: `http_${answer.httpStatus}` });
    }
    for (const result of answer.body.results as Array<{ status?: unknown }>) {
      const status = typeof result?.status === "string" ? result.status : "unreadable";
      intake[status] = (intake[status] ?? 0) + 1;
    }
    draftsSubmitted += read.drafts.length;
  }
  return summary(null);
}

// ---------------------------------------------------------------------------
// The worker's configuration and its ports to the app
// ---------------------------------------------------------------------------

/** What the worker reads from its environment, and nothing else. */
export const MARKETING_GENERATOR_WORKER_VARIABLES = [
  "MARKETING_APP_URL",
  "MARKETING_GENERATOR_SUBMIT_SECRET",
  "MARKETING_LLM_API_KEY",
] as const;

export type MarketingGeneratorWorkerConfig = {
  readonly appUrl: URL;
  readonly secret: string;
  readonly apiKey: string;
};

/**
 * The worker's configuration, or why it will not start.
 *
 * Which model it uses, and that model's price pin, come from the context:
 * the operator's Admin setting priced by the chat catalog
 * (`marketingGeneratorPinForContext`).
 */
export function marketingGeneratorWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly config: MarketingGeneratorWorkerConfig } | { readonly ok: false; readonly reason: string } {
  const missing = MARKETING_GENERATOR_WORKER_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0) return { ok: false, reason: `missing: ${missing.join(", ")}` };
  const secret = env.MARKETING_GENERATOR_SUBMIT_SECRET as string;
  if (secret.length < 32) return { ok: false, reason: "MARKETING_GENERATOR_SUBMIT_SECRET is shorter than 32 characters" };
  let appUrl: URL;
  try {
    appUrl = new URL(env.MARKETING_APP_URL as string);
  } catch {
    return { ok: false, reason: "MARKETING_APP_URL is not a URL" };
  }
  const local = appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1";
  if (appUrl.protocol !== "https:" && !local) return { ok: false, reason: "MARKETING_APP_URL must use HTTPS" };
  return { ok: true, config: { appUrl, secret, apiKey: env.MARKETING_LLM_API_KEY as string } };
}

/**
 * The pin for the model the operator selected in the Admin Console, as the
 * context carries it, or why the run does nothing. `problems` is the ledger's
 * own pin check: a pin it would refuse is not used to build a request.
 */
export function marketingGeneratorPinForContext<Pin extends { readonly model: string }>(
  context: unknown,
  problems: (pin: Pin) => readonly string[],
): { readonly ok: true; readonly pin: Pin } | { readonly ok: false; readonly reason: string } {
  const llm = context && typeof context === "object" ? (context as { llm?: unknown }).llm : undefined;
  const fields = llm && typeof llm === "object" ? (llm as { model?: unknown; pin?: unknown }) : {};
  if (typeof fields.model !== "string") return { ok: false, reason: "no model is selected in the Admin Console" };
  const pin = fields.pin as Pin | null | undefined;
  if (!pin || typeof pin !== "object" || pin.model !== fields.model) {
    return { ok: false, reason: "the selected model has no price pin" };
  }
  const found = problems(pin);
  if (found.length > 0) return { ok: false, reason: `the selected model's pin is refused: ${found.join(", ")}` };
  return { ok: true, pin };
}

/** The context, intake and report routes, over HTTP with the generator's secret. */
export function marketingGeneratorAppPorts(input: {
  readonly appUrl: URL;
  readonly secret: string;
  readonly generatorRunId: string;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}): Pick<MarketingGeneratorCycleDeps, "readContext" | "submit"> & {
  readonly submitReport: (
    report: MarketingGeneratorReport,
  ) => Promise<{ readonly httpStatus: number; readonly body: Record<string, unknown> }>;
} {
  const post = async (path: string, body: unknown) => {
    const response = await input.fetch(new URL(path, input.appUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${input.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    // A response that came back is an answer, whatever its body: its status
    // decides what happens next. Only a request with no response throws.
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { httpStatus: response.status, body: answer !== null && typeof answer === "object" ? answer : {} };
  };
  return {
    readContext: async () => {
      const answer = await post("/api/internal/marketing-generator-context", { generatorRunId: input.generatorRunId });
      if (answer.httpStatus !== 200) throw new Error(`context: http ${answer.httpStatus}`);
      return answer.body.context;
    },
    submit: (submission) => post("/api/internal/marketing-drafts", submission),
    submitReport: (report) => post("/api/internal/marketing-intel-reports", report),
  };
}
