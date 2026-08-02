/**
 * The two judgements the default-model eval harness makes about its own run,
 * separated out so they can be tested without spending money at a provider.
 *
 * Both exist to stop the same mistake: reading an eval that never happened as
 * an eval that failed.
 */

export type ArmOutcome =
  | "measured"
  | "inconclusive"
  | "provider_unavailable"
  | "not_run";

/**
 * What an arm's numbers are evidence *of*.
 *
 * An arm where every request errored has a 0% success rate, and that number
 * looks exactly like a model that failed every scenario. It is not: the model
 * was never asked. This repository has the case on hand -- the egress proxy
 * blocks `api.openai.com`, so the harness reports a 100% provider error rate
 * for all four arms while saying nothing whatsoever about answer quality.
 *
 * Above half the requests failing, the surviving runs are not a
 * representative sample either: whatever knocked out the others selected
 * which requests remain. That is `inconclusive` rather than a verdict.
 */
export const classifyArmOutcome = ({
  attempted,
  providerErrorRate,
}: {
  attempted: number;
  providerErrorRate: number;
}): ArmOutcome => {
  if (attempted === 0) return "not_run";
  if (providerErrorRate >= 1) return "provider_unavailable";
  if (providerErrorRate > 0.5) return "inconclusive";
  return "measured";
};

export type PreflightVerdict =
  | { ok: true; commitSha: string | null; startedAt: string | null; repeats: number | null }
  | { ok: false; reason: string };

/**
 * Whether a preflight artefact clears the main run to proceed.
 *
 * Policy 4.5.1 makes the `--repeats=2` preflight a precondition, and the
 * precondition is not "a preflight was run" -- a preflight in which every
 * call errored is precisely the situation it exists to catch. So the artefact
 * has to show all four arms present and each of them completing at least one
 * real call, which is the minimum that demonstrates every arm reached its own
 * model with its own reasoning setting and got usage fields back.
 *
 * Discovering otherwise after 1,200 billed calls costs the money and produces
 * nothing that can be cited.
 */
export const evaluatePreflightArtifact = (artifact: unknown): PreflightVerdict => {
  if (!artifact || typeof artifact !== "object") {
    return { ok: false, reason: "is not a JSON object" };
  }
  const record = artifact as {
    summaries?: unknown;
    manifest?: { allArmsPresent?: unknown; commitSha?: unknown; startedAt?: unknown; repeats?: unknown };
  };
  const summaries = Array.isArray(record.summaries)
    ? (record.summaries as {
        arm?: string;
        attempted?: number;
        providerErrorRate?: number;
      }[])
    : [];

  if (summaries.length === 0) {
    return { ok: false, reason: "contains no arm summaries" };
  }
  if (record.manifest?.allArmsPresent !== true) {
    return {
      ok: false,
      reason: `only ran ${summaries.map((summary) => summary.arm ?? "?").join(", ")}; all four arms must preflight together`,
    };
  }

  const dead = summaries.filter(
    (summary) =>
      classifyArmOutcome({
        attempted: summary.attempted ?? 0,
        providerErrorRate: summary.providerErrorRate ?? 0,
      }) === "provider_unavailable" ||
      (summary.attempted ?? 0) === 0
  );
  if (dead.length > 0) {
    return {
      ok: false,
      reason:
        `${dead.map((summary) => summary.arm ?? "?").join(", ")} completed no successful call, ` +
        `so nothing was established about ${dead.length > 1 ? "those arms" : "that arm"}`,
    };
  }

  return {
    ok: true,
    commitSha:
      typeof record.manifest?.commitSha === "string" ? record.manifest.commitSha : null,
    startedAt:
      typeof record.manifest?.startedAt === "string" ? record.manifest.startedAt : null,
    repeats: typeof record.manifest?.repeats === "number" ? record.manifest.repeats : null,
  };
};
