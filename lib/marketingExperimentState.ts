import "server-only";

import type { PrismaClient } from "@prisma/client";

import { readMarketingAutomationSettings } from "@/lib/appSettings";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_EXPERIMENT_CONFIG_KEY,
  MARKETING_EXPERIMENT_COUNTER_PREFIX,
  MARKETING_EXPERIMENT_SPIKE,
  type ExperimentConfig,
  type ExperimentEventKind,
} from "@/lib/marketingExperimentContract";
import {
  experimentCountsFromRows,
  experimentCounterKey,
  parseExperimentConfig,
  resolveActiveExperiment,
  type ActiveExperimentResolution,
  type ExperimentCounts,
} from "@/lib/marketingExperimentCore";
import { prisma } from "@/lib/prisma";

/**
 * Reads of landing-experiment state (policy 6.1 "실험 활성화", 9.1).
 *
 * An experiment is active only when every input is readable and true: no kill
 * switch, the experiments switch on, the spike on record, a configuration that
 * parses against the strict schema, running, inside its window, and its stop
 * rule not triggered. Any input that cannot be read is "no experiment", and no
 * experiment means the default copy for everyone.
 */

export type ExperimentSnapshot = {
  /** The raw row, so an admin screen can say "present but unreadable". */
  configRaw: string | null;
  /** The compare-and-set token of the configuration row. */
  version: string | null;
  config: ExperimentConfig | null;
  counts: ExperimentCounts | null;
};

export const readExperimentSnapshot = async (
  client: Pick<PrismaClient, "appSetting">
): Promise<ExperimentSnapshot> => {
  const rows = await client.appSetting.findMany({
    where: {
      OR: [
        { key: MARKETING_EXPERIMENT_CONFIG_KEY },
        { key: { startsWith: MARKETING_EXPERIMENT_COUNTER_PREFIX } },
      ],
    },
    select: { key: true, value: true, updatedAt: true },
  });
  const configRow = rows.find((row) => row.key === MARKETING_EXPERIMENT_CONFIG_KEY);
  const config = parseExperimentConfig(configRow?.value);
  return {
    configRaw: configRow?.value ?? null,
    version: configRow ? configRow.updatedAt.toISOString() : null,
    config,
    counts: config
      ? experimentCountsFromRows(
          config,
          new Map(rows.map((row) => [row.key, row.value]))
        )
      : null,
  };
};

export type ActiveExperimentRead =
  | {
      ok: true;
      active: true;
      config: ExperimentConfig;
    }
  | {
      ok: true;
      active: false;
      reason:
        | "kill_switch"
        | "switch_off"
        | "spike_missing"
        | "no_configuration"
        | Extract<ActiveExperimentResolution, { active: false }>["reason"];
    }
  | { ok: false };

/**
 * The Playwright fixture. The E2E server has no database, so an experiment
 * cannot be written; a request that asks for one with this header gets the
 * configuration from the environment instead. Loopback fixture servers only,
 * and only on request, so no other spec ever sees an active experiment.
 */
export const E2E_EXPERIMENT_HEADER = "x-e2e-marketing-experiment";

/**
 * A forced roll for the Playwright fixture: `variant` always draws the
 * variant, `control` always the control. Fixture servers only. In production
 * the header is ignored, and a visitor cannot choose their own arm.
 */
export const e2eForcedRoll = (headers: Headers) => {
  if (!isE2EFixtureMode()) return null;
  const forced = headers.get(E2E_EXPERIMENT_HEADER);
  if (forced === "variant") return 0;
  if (forced === "control") return 0.999999;
  return null;
};

const e2eFixtureExperiment = (headers: Headers | undefined, now: Date) => {
  if (!headers || !isE2EFixtureMode()) return null;
  if (!headers.get(E2E_EXPERIMENT_HEADER)) return null;
  const config = parseExperimentConfig(process.env.E2E_MARKETING_EXPERIMENT);
  if (!config) return null;
  // The window is always "now", so the fixture does not expire with the date
  // it was written on.
  return {
    ...config,
    startsAt: new Date(now.getTime() - 86_400_000).toISOString(),
    endsAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  };
};

export async function readActiveMarketingExperiment(options: {
  headers?: Headers;
  now?: Date;
} = {}): Promise<ActiveExperimentRead> {
  const now = options.now ?? new Date();
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  if (typeof killSwitch === "string" && killSwitch.trim() !== "") {
    return { ok: true, active: false, reason: "kill_switch" };
  }
  if (!MARKETING_EXPERIMENT_SPIKE.passed) {
    return { ok: true, active: false, reason: "spike_missing" };
  }

  const fixture = e2eFixtureExperiment(options.headers, now);
  if (fixture) {
    return { ok: true, active: true, config: fixture };
  }
  if (isE2EFixtureMode()) {
    // No database to read: no experiment.
    return { ok: true, active: false, reason: "no_configuration" };
  }

  try {
    const settings = await readMarketingAutomationSettings();
    if (!settings.experimentsEnabled.ok) return { ok: false };
    if (!settings.experimentsEnabled.value) {
      return { ok: true, active: false, reason: "switch_off" };
    }
    const snapshot = await readExperimentSnapshot(prisma);
    if (!snapshot.config || !snapshot.counts) {
      return { ok: true, active: false, reason: "no_configuration" };
    }
    const resolution = resolveActiveExperiment(
      snapshot.config,
      snapshot.counts,
      now
    );
    return resolution.active
      ? { ok: true, active: true, config: resolution.config }
      : { ok: true, active: false, reason: resolution.reason };
  } catch {
    return { ok: false };
  }
}

/**
 * One atomic increment per event. A single `INSERT ... ON CONFLICT` so two
 * visitors counted at once cannot lose an update, which a read-then-write on
 * an `AppSetting` string would.
 */
export async function incrementExperimentCounter(
  experimentId: string,
  arm: string,
  kind: ExperimentEventKind
) {
  if (isE2EFixtureMode()) return;
  const key = experimentCounterKey(experimentId, arm, kind);
  await prisma.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "createdAt", "updatedAt")
    VALUES (${key}, '1', NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "value" = (("AppSetting"."value")::bigint + 1)::text,
        "updatedAt" = NOW()
  `;
}
