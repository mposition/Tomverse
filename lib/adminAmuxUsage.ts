import type { AmuxCliUsageSummaryRow } from "./amux/adminCliUsageSummary.ts";

/**
 * Presentation arithmetic for the Diagnostics tab's usage coverage: the four
 * headline numbers and the per-worker rows, from the rows the summary read
 * returned (`readAmuxCliUsageSummaryForAdmin`).
 *
 * Pure. A call that was not reported is never counted as zero cost: the
 * unmeasured share is a lower bound, and an estimate covers only the calls
 * that have a known price.
 */

export type AmuxUsageWorker = {
  worker: string;
  /** The executors the worker ran on, as stored. */
  executors: string[];
  recorded: number;
  usageUnknown: number;
  /** Finished attempts that left no usage report. */
  noReceipt: number;
  /** Calls not measured: unknown usage plus attempts with no report. A lower bound. */
  unmeasured: number;
  /** Lower-bound share in [0, 1]. */
  rate: number;
  pricedCalls: number;
  knownCostMicrousd: bigint;
  /** Some recorded calls have no known price, so the estimate is a part of the cost. */
  partialPricing: boolean;
  rows: AmuxCliUsageSummaryRow[];
};

const share = (unmeasured: number, recorded: number, noReceipt: number) => {
  const denominator = recorded + noReceipt;
  return denominator === 0 ? 0 : unmeasured / denominator;
};

/** One entry per worker, in the order the summary listed them (most unmeasured first). */
export function groupAmuxUsageByWorker(rows: readonly AmuxCliUsageSummaryRow[]): AmuxUsageWorker[] {
  const groups = new Map<string, AmuxUsageWorker>();
  for (const row of rows) {
    const group = groups.get(row.worker) ?? {
      worker: row.worker, executors: [], recorded: 0, usageUnknown: 0, noReceipt: 0, unmeasured: 0, rate: 0,
      pricedCalls: 0, knownCostMicrousd: BigInt(0), partialPricing: false, rows: [],
    };
    if (!group.executors.includes(row.executor)) group.executors.push(row.executor);
    group.recorded += row.recorded;
    group.usageUnknown += row.usageUnknown;
    group.noReceipt += row.noReceiptAttempts;
    group.pricedCalls += row.pricedCalls;
    group.knownCostMicrousd += BigInt(row.knownProjectedApiCostMicrousd);
    group.rows.push(row);
    groups.set(row.worker, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    unmeasured: group.usageUnknown + group.noReceipt,
    rate: share(group.usageUnknown + group.noReceipt, group.recorded, group.noReceipt),
    partialPricing: group.pricedCalls < group.recorded,
  }));
}

export type AmuxUsageTotals = {
  recorded: number;
  unmeasured: number;
  rate: number;
  pricedCalls: number;
  knownCostMicrousd: bigint;
  partialPricing: boolean;
};

export function amuxUsageTotals(workers: readonly AmuxUsageWorker[]): AmuxUsageTotals {
  let recorded = 0, unmeasured = 0, noReceipt = 0, pricedCalls = 0;
  let cost = BigInt(0);
  for (const worker of workers) {
    recorded += worker.recorded;
    unmeasured += worker.unmeasured;
    noReceipt += worker.noReceipt;
    pricedCalls += worker.pricedCalls;
    cost += worker.knownCostMicrousd;
  }
  return {
    recorded, unmeasured, rate: share(unmeasured, recorded, noReceipt), pricedCalls,
    knownCostMicrousd: cost, partialPricing: pricedCalls < recorded,
  };
}

/** "US$ 24.50" from µUSD, rounded half up to the cent. */
export function formatAmuxUsd(microusd: bigint): string {
  const cents = (microusd + BigInt(5_000)) / BigInt(10_000);
  const whole = cents / BigInt(100);
  const fraction = (cents % BigInt(100)).toString().padStart(2, "0");
  return `US$ ${whole.toLocaleString("en-US")}.${fraction}`;
}

/** "4.6%" from a fraction in [0, 1]. */
export const formatAmuxPercent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/** "1,284" for a big count, "512,000" for a token count given as a decimal string. */
export const formatAmuxCount = (value: number | string) => BigInt(value).toLocaleString("en-US");
