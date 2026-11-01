import { LANDING_EXPERIMENT_BUNDLES } from "@/components/marketing/landingExperimentBundles";
import {
  MARKETING_EXPERIMENT_SPIKE,
  type ExperimentConfig,
} from "@/lib/marketingExperimentContract";
import {
  experimentRates,
  resolveActiveExperiment,
  type ExperimentCounts,
} from "@/lib/marketingExperimentCore";

/**
 * What the Admin console shows about landing experiments: one row for the
 * current (or last) experiment, plus what the start form needs. Pure, so the
 * screen and its tests read the same derivation of "is it really running".
 */

export type ExperimentDerivedState =
  | "active"
  | "not_started"
  | "ended"
  | "stopped"
  | "stop_rule";

export type ExperimentRowView = {
  id: string;
  /** The stored status; a stop is what ends a `running` one for good. */
  status: "running" | "stopped";
  /** What visitors actually get now, derived from the window and the stop rule. */
  state: ExperimentDerivedState;
  bundleId: string;
  variantId: string;
  locales: string[];
  variantRatioPercent: number;
  startsAt: string;
  endsAt: string;
  stoppedAt: string | null;
  hypothesis: string;
  primaryMetric: string;
  minExposuresPerArm: number;
  stopRelativeDropPercent: number;
  stopAfterExposuresPerArm: number;
  counts: ExperimentCounts;
  controlRatePercent: number | null;
  variantRatePercent: number | null;
  /** Both arms have reached the pre-registered minimum sample. */
  sampleReached: boolean;
  /** The compare-and-set token a stop sends back. */
  version: string | null;
};

export type ExperimentsConsoleView = {
  /** The configuration row's token; a start sends it back. Null while nothing was saved. */
  version: string | null;
  /** A row is stored but is not a configuration this build can read. */
  unreadable: boolean;
  spikePassed: boolean;
  /** Every `bundle / variant` this build can run, with the locales it has copy for. */
  bundles: Array<{ bundleId: string; variantId: string; locales: string[] }>;
  /** A `running` experiment exists (even one past its end date): stop it before starting another. */
  hasRunning: boolean;
};

const percent = (value: number | null) =>
  value === null ? null : Math.round(value * 10_000) / 100;

export function buildExperimentsConsole(
  snapshot: {
    configRaw: string | null;
    version: string | null;
    config: ExperimentConfig | null;
    counts: ExperimentCounts | null;
    /** The stop rule was met at some point and recorded. */
    tripped?: boolean;
  },
  now: Date
): { rows: ExperimentRowView[]; experiments: ExperimentsConsoleView } {
  const bundles = LANDING_EXPERIMENT_BUNDLES.flatMap((bundle) =>
    Object.entries(bundle.variants).map(([variantId, locales]) => ({
      bundleId: bundle.id,
      variantId,
      locales: Object.keys(locales),
    }))
  );
  const { config, counts } = snapshot;
  const base = {
    version: snapshot.version,
    unreadable: snapshot.configRaw !== null && config === null,
    spikePassed: MARKETING_EXPERIMENT_SPIKE.passed,
    bundles,
  };
  if (!config || !counts) {
    return { rows: [], experiments: { ...base, hasRunning: false } };
  }

  const resolution = resolveActiveExperiment(config, counts, now, snapshot.tripped === true);
  const rates = experimentRates(counts);
  const minimum = config.preregistration.minExposuresPerArm;
  return {
    rows: [
      {
        id: config.experimentId,
        status: config.status,
        state: resolution.active ? "active" : resolution.reason,
        bundleId: config.bundleId,
        variantId: config.variantId,
        locales: config.locales,
        variantRatioPercent: Math.round(config.variantRatio * 100),
        startsAt: config.startsAt,
        endsAt: config.endsAt,
        stoppedAt: config.stoppedAt,
        hypothesis: config.preregistration.hypothesis,
        primaryMetric: config.preregistration.primaryMetric,
        minExposuresPerArm: minimum,
        stopRelativeDropPercent: config.preregistration.stopRule.relativeDropPercent,
        stopAfterExposuresPerArm: config.preregistration.stopRule.afterExposuresPerArm,
        counts,
        controlRatePercent: percent(rates.control),
        variantRatePercent: percent(rates.variant),
        sampleReached:
          counts.controlExposures >= minimum && counts.variantExposures >= minimum,
        version: snapshot.version,
      },
    ],
    experiments: { ...base, hasRunning: config.status === "running" },
  };
}
