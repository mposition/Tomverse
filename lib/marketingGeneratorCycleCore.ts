/**
 * One run of the marketing generator (S3 plan, S3e3): the app's context, one
 * A5 call per approval-mode account, the answers read, and each call's drafts
 * submitted under that call's ledger key. Pure orchestration over ports, so
 * the service and the tests drive the same code.
 *
 * **It stops rather than presses on.** A refused reservation (no pin, budget
 * spent, kill switch) refuses every later call too, an unknown outcome is a
 * thing a person looks at (agent foundation rule 7), and a submission whose
 * answer is lost is resolved by resending the same key -- which a new run,
 * with a new run id, cannot do. So the run ends at the first of these and
 * reports where.
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
import type { MarketingLlmCallOutcome, MarketingLlmMessage } from "./marketingLlmClientCore.ts";

/** Time a call is not started without: one reservation, one provider answer and one submission. */
export const MARKETING_GENERATOR_CALL_BUDGET_MS = 90_000;

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
    let answer;
    try {
      answer = await deps.submit(submission);
    } catch {
      return summary({ stage: "submit", detail: "outcome_unknown" });
    }
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
  "MARKETING_GENERATOR_MODEL",
] as const;

export type MarketingGeneratorWorkerConfig<Pin> = {
  readonly appUrl: URL;
  readonly secret: string;
  readonly apiKey: string;
  readonly pin: Pin;
};

/**
 * The worker's configuration, or why it will not start.
 *
 * The model is named by the operator and must have a price pin -- a person's
 * decision, in code -- or the worker does nothing at all: without a pin the
 * app refuses every reservation anyway, and a worker that started would only
 * spend a run being refused.
 */
export function marketingGeneratorWorkerConfig<Pin extends { readonly model: string }>(
  env: Readonly<Record<string, string | undefined>>,
  pins: readonly Pin[],
): { readonly ok: true; readonly config: MarketingGeneratorWorkerConfig<Pin> } | { readonly ok: false; readonly reason: string } {
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
  const pin = pins.find((candidate) => candidate.model === env.MARKETING_GENERATOR_MODEL);
  if (!pin) return { ok: false, reason: "no price pin for MARKETING_GENERATOR_MODEL; a person adds one" };
  return { ok: true, config: { appUrl, secret, apiKey: env.MARKETING_LLM_API_KEY as string, pin } };
}

/** The context and intake routes, over HTTP with the generator's secret. */
export function marketingGeneratorAppPorts(input: {
  readonly appUrl: URL;
  readonly secret: string;
  readonly generatorRunId: string;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}): Pick<MarketingGeneratorCycleDeps, "readContext" | "submit"> {
  const post = async (path: string, body: unknown) => {
    const response = await input.fetch(new URL(path, input.appUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${input.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (answer === null || typeof answer !== "object") throw new Error(`${path}: no readable answer`);
    return { httpStatus: response.status, body: answer };
  };
  return {
    readContext: async () => {
      const answer = await post("/api/internal/marketing-generator-context", { generatorRunId: input.generatorRunId });
      if (answer.httpStatus !== 200) throw new Error(`context: http ${answer.httpStatus}`);
      return answer.body.context;
    },
    submit: (submission) => post("/api/internal/marketing-drafts", submission),
  };
}
