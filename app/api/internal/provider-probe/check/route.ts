export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPublicBuildInfo } from "@/lib/buildInfo";
import { classifyProbeError } from "@/lib/providerErrorClassification";
import {
  MONITORED_PROVIDERS,
  recordProviderProbeFailure,
  recordProviderProbeSuccess,
} from "@/lib/providerMonitoring";
import {
  probeDailyCostCapMicroUsd,
  recordProbeUsage,
  runProviderProbe,
} from "@/lib/providerProbe";
import { getProbeUsageCostTodayMicroUsd } from "@/lib/providerUsageAccounting";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

// AUD-R001: periodic low-cost synthetic probes so idle providers don't stay
// permanently "unknown" on the public status page. One representative model
// per provider (see lib/providerProbe.ts), fixed non-sensitive prompt,
// minimal output tokens, no tools/search/image/file/deep-research, a hard
// per-call timeout, and no client-side retry loop -- the next cron tick 10
// minutes later is the retry (see railway.provider-probe.json).

// Half the cron cadence: guards against two near-simultaneous invocations
// (a slow previous run overlapping the next tick) recording duplicate runs,
// mirroring lib/infrastructureThresholdMonitor.ts's soft throttle pattern.
const OVERLAP_GUARD_MS = 5 * 60 * 1_000;
const MAX_CONCURRENT_PROBES = 3;

const authorized = (request: Request) => {
  const secret = process.env.PROVIDER_PROBE_SECRET || process.env.MAINTENANCE_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const now = new Date();

  const recentRun = await prisma.scheduledJobRun
    .findFirst({
      where: {
        jobKey: "provider_probe",
        startedAt: { gte: new Date(now.getTime() - OVERLAP_GUARD_MS) },
      },
      select: { id: true },
    })
    .catch(() => null);
  if (recentRun) {
    return NextResponse.json({
      generatedAt: now.toISOString(),
      skipped: true,
      reason: "overlap_guard",
      succeeded: 0,
      failed: 0,
    });
  }

  const todaysCostMicroUsd = await getProbeUsageCostTodayMicroUsd(now).catch(() => 0);
  if (todaysCostMicroUsd >= probeDailyCostCapMicroUsd()) {
    return NextResponse.json({
      generatedAt: now.toISOString(),
      skipped: true,
      reason: "daily_cost_cap_reached",
      succeeded: 0,
      failed: 0,
    });
  }

  const scheduledRun = await startScheduledJob("provider_probe");
  const environment = (await getPublicBuildInfo()).environment;
  const runId = scheduledRun?.id ?? null;

  try {
    const outcomes = await runWithConcurrencyLimit(
      MONITORED_PROVIDERS,
      MAX_CONCURRENT_PROBES,
      async (provider) => {
        const startedAt = new Date();
        const outcome = await runProviderProbe(provider);
        const completedAt = new Date();

        // no_probe_model means the registry had nothing enabled to call at
        // all -- a configuration gap, not a provider health signal, so it
        // is neither recorded as probe evidence nor logged as an attempt.
        if (!outcome.ok && !outcome.modelId) {
          return outcome;
        }

        if (outcome.ok) {
          await Promise.all([
            recordProviderProbeSuccess(provider),
            recordProbeUsage(outcome).catch(() => undefined),
            runId
              ? prisma.providerProbeResult
                  .create({
                    data: {
                      runId,
                      provider,
                      modelId: outcome.modelId,
                      environment,
                      startedAt,
                      completedAt,
                      success: true,
                      timedOut: false,
                      latencyMs: outcome.latencyMs,
                    },
                  })
                  .catch(() => undefined)
              : Promise.resolve(),
          ]);
        } else {
          await Promise.all([
            recordProviderProbeFailure(provider),
            runId
              ? prisma.providerProbeResult
                  .create({
                    data: {
                      runId,
                      provider,
                      modelId: outcome.modelId as string,
                      environment,
                      startedAt,
                      completedAt,
                      success: false,
                      timedOut: outcome.timedOut,
                      latencyMs: outcome.latencyMs,
                      errorClassification: classifyProbeError(
                        outcome.diagnosticCode,
                        outcome.timedOut
                      ),
                      diagnosticCode: outcome.diagnosticCode ?? null,
                    },
                  })
                  .catch(() => undefined)
              : Promise.resolve(),
          ]);
        }
        return outcome;
      }
    );

    const succeeded = outcomes.filter((outcome) => outcome.ok).length;
    const failed = outcomes.filter((outcome) => !outcome.ok && outcome.modelId).length;
    const noProbeModel = outcomes.filter(
      (outcome) => !outcome.ok && !outcome.modelId
    ).length;

    await completeScheduledJob({
      runId,
      processedCount: succeeded + failed,
      result: { succeeded, failed, noProbeModel, environment },
    });

    return NextResponse.json({
      generatedAt: now.toISOString(),
      succeeded,
      failed,
      skipped: false,
    });
  } catch (error) {
    await failScheduledJob({ runId, error });
    await reportOperationalIncident({
      code: "PROVIDER_PROBE_CYCLE_FAILED",
      title: "Synthetic provider probe cycle failed",
      error,
      severity: "error",
      context: { component: "provider_probe" },
    }).catch(() => undefined);
    console.error("Provider probe cycle failed:", error);
    return NextResponse.json(
      { error: "Provider probe cycle failed." },
      { status: 500 }
    );
  }
}
