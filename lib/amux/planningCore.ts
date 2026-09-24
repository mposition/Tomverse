export const AMUX_GLOBAL_PRIORITY_VERSION = "amux-global-priority-v2";
export const AMUX_WORKER_ROUTER_VERSION = "amux-worker-router-v2";

const DAY_MS = 86_400_000;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const validUtcParts = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
) => {
  const date = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
  );
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
};

const canonicalInstant = (
  raw: string,
): { dueAt: string; precision: "date" | "instant" } | null => {
  const value = raw.trim();
  const dateOnly = dateOnlyPattern.exec(value);
  if (dateOnly) {
    const [, yearRaw, monthRaw, dayRaw] = dateOnly;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!validUtcParts(year, month, day, 0, 0, 0, 0)) return null;
    return {
      dueAt: new Date(
        Date.UTC(year, month - 1, day, 23, 59, 59, 999),
      ).toISOString(),
      precision: "date",
    };
  }

  const instant = instantPattern.exec(value.replace(" ", "T"));
  if (!instant) return null;

  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    millisRaw = "0",
    zone,
    sign,
    offsetHourRaw,
    offsetMinuteRaw,
  ] = instant;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(millisRaw.padEnd(3, "0"));
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !validUtcParts(year, month, day, hour, minute, second, millisecond)
  ) {
    return null;
  }

  let epoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (zone !== "Z") {
    const offsetHour = Number(offsetHourRaw);
    const offsetMinute = Number(offsetMinuteRaw);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
    epoch += sign === "+" ? -offsetMs : offsetMs;
  }
  return { dueAt: new Date(epoch).toISOString(), precision: "instant" };
};

export type AmuxDeadlineParse =
  | {
      state: "parsed";
      due_at: string;
      source: "classification" | "title" | "description";
      precision: "date" | "instant";
      raw: string;
    }
  | {
      state: "absent";
      due_at: null;
      source: null;
      precision: null;
      raw: null;
    }
  | {
      state: "invalid";
      due_at: null;
      source: "classification" | "title" | "description";
      precision: null;
      raw: string;
    }
  | {
      state: "ambiguous";
      due_at: null;
      source: null;
      precision: null;
      raw: string;
    };

const anchoredDeadlines = (text: string) =>
  [...text.matchAll(/(?:^|[\s[(])(?:due|deadline)\s*[:=]\s*(?:([0-9]{4}[-/][^\s\])},;]*)|([0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{4})|([0-9]{4}년\s*[0-9]{1,2}월\s*[0-9]{1,2}일))/gi)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );

const boundedDeadlineRaw = (value: string) => value.slice(0, 120);

/**
 * Parses only unambiguous, timezone-bearing instants or ISO calendar dates.
 * Date-only values mean the end of that UTC date. Relative and locale-specific
 * phrases deliberately remain invalid/absent instead of inheriting a machine
 * locale or the time at which a scheduler happened to read them.
 */
export const parseAmuxDeadline = (input: {
  classificationDueAt?: unknown;
  title: string;
  description?: string | null;
}): AmuxDeadlineParse => {
  const explicitDeadline =
    typeof input.classificationDueAt === "string"
      ? input.classificationDueAt.trim()
      : "";
  const candidates: Array<{
    source: "classification" | "title" | "description";
    raw: string;
  }> = explicitDeadline
    ? [{ source: "classification", raw: explicitDeadline }]
    : [
        ...anchoredDeadlines(input.title).map((raw) => ({
          source: "title" as const,
          raw,
        })),
        ...anchoredDeadlines(input.description ?? "").map((raw) => ({
          source: "description" as const,
          raw,
        })),
      ];

  const parsedCandidates: Array<{
    source: "classification" | "title" | "description";
    raw: string;
    dueAt: string;
    precision: "date" | "instant";
  }> = [];
  for (const candidate of candidates) {
    const parsed = canonicalInstant(candidate.raw);
    if (!parsed) {
      return {
        state: "invalid",
        due_at: null,
        source: candidate.source,
        precision: null,
        raw: boundedDeadlineRaw(candidate.raw),
      };
    }
    parsedCandidates.push({ ...candidate, ...parsed });
  }

  if (new Set(parsedCandidates.map((candidate) => candidate.dueAt)).size > 1) {
    return {
      state: "ambiguous",
      due_at: null,
      source: null,
      precision: null,
      raw: parsedCandidates
        .map(
          (candidate) =>
            `${candidate.source}=${boundedDeadlineRaw(candidate.raw)}`,
        )
        .join(" | ")
        .slice(0, 500),
    };
  }

  const selected = parsedCandidates[0];
  if (selected) {
    return {
      state: "parsed",
      due_at: selected.dueAt,
      source: selected.source,
      precision: selected.precision,
      raw: boundedDeadlineRaw(selected.raw),
    };
  }

  return {
    state: "absent",
    due_at: null,
    source: null,
    precision: null,
    raw: null,
  };
};

export type AmuxUrgency = {
  score: number;
  band:
    | "none"
    | "later"
    | "two_weeks"
    | "one_week"
    | "three_days"
    | "one_day"
    | "six_hours"
    | "overdue";
  millis_to_due: number | null;
};

export const calculateAmuxUrgency = (
  dueAt: string | null,
  now: Date,
): AmuxUrgency => {
  if (!dueAt) return { score: 0, band: "none", millis_to_due: null };
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) {
    return { score: 0, band: "none", millis_to_due: null };
  }
  const delta = due - now.getTime();
  if (delta <= 0) {
    const overdueHours = Math.floor(Math.abs(delta) / 3_600_000);
    return {
      score: 120 + Math.min(120, Math.floor(overdueHours / 6)),
      band: "overdue",
      millis_to_due: delta,
    };
  }
  if (delta <= 6 * 3_600_000) {
    return { score: 100, band: "six_hours", millis_to_due: delta };
  }
  if (delta <= DAY_MS) {
    return { score: 72, band: "one_day", millis_to_due: delta };
  }
  if (delta <= 3 * DAY_MS) {
    return { score: 48, band: "three_days", millis_to_due: delta };
  }
  if (delta <= 7 * DAY_MS) {
    return { score: 24, band: "one_week", millis_to_due: delta };
  }
  if (delta <= 14 * DAY_MS) {
    return { score: 12, band: "two_weeks", millis_to_due: delta };
  }
  return { score: 0, band: "later", millis_to_due: delta };
};

export type AmuxObservedMetric = {
  value: number;
  confidence: number;
  source:
    | "historical_attempts"
    | "historical_cost"
    | "provider_api"
    | "wrapper";
  sample_size: number | null;
  observed_at: string;
};

export type AmuxHistoricalSample = {
  outcome: string | null;
  toStatus: string | null;
  startedAt: Date;
  endedAt: Date | null;
};

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** Empirical-Bayes calibration: every rate has a Beta(2,2) prior. */
export const calibrateAmuxHistory = (
  samples: readonly AmuxHistoricalSample[],
  now: Date,
  targetLatencyMs: number,
): {
  predicted_success: AmuxObservedMetric | null;
  expected_speed: AmuxObservedMetric | null;
  low_rework: AmuxObservedMetric | null;
  low_human_attention: AmuxObservedMetric | null;
  sample_size: number;
} => {
  const cutoff = now.getTime() - 90 * DAY_MS;
  const terminal = samples
    .filter(
      (sample) =>
        sample.endedAt !== null &&
        // Lease expiry is liveness/process evidence. It does not say the
        // worker attempted and failed the work, so it must not calibrate
        // worker success, rework, attention, or latency.
        sample.outcome !== "expired" &&
        sample.endedAt.getTime() >= cutoff &&
        sample.endedAt.getTime() <= now.getTime(),
    )
    .sort(
      (left, right) =>
        (right.endedAt?.getTime() ?? 0) - (left.endedAt?.getTime() ?? 0),
    )
    .slice(0, 200);

  if (terminal.length === 0) {
    return {
      predicted_success: null,
      expected_speed: null,
      low_rework: null,
      low_human_attention: null,
      sample_size: 0,
    };
  }

  const successes = terminal.filter(
    (sample) => sample.outcome === "succeeded",
  ).length;
  const rework = terminal.filter(
    (sample) => sample.outcome === "failed" || sample.toStatus === "todo",
  ).length;
  const humanAttention = terminal.filter(
    (sample) =>
      sample.toStatus === "review" ||
      sample.toStatus === "blocked" ||
      sample.outcome === "blocked",
  ).length;
  const latencies = terminal.flatMap((sample) => {
    if (!sample.endedAt) return [];
    return [Math.max(0, sample.endedAt.getTime() - sample.startedAt.getTime())];
  });
  const latest = terminal[0]?.endedAt ?? now;
  const freshness = clamp01(
    1 - (now.getTime() - latest.getTime()) / (90 * DAY_MS),
  );
  const confidence = clamp01((terminal.length / 20) * freshness);
  const observedAt = latest.toISOString();
  const metric = (value: number): AmuxObservedMetric => ({
    value: clamp01(value),
    confidence,
    source: "historical_attempts",
    sample_size: terminal.length,
    observed_at: observedAt,
  });
  const denominator = terminal.length + 4;
  const latency = median(latencies);
  const target = Math.max(1, targetLatencyMs);

  return {
    predicted_success: metric((successes + 2) / denominator),
    expected_speed: metric(target / (target + latency)),
    low_rework: metric((terminal.length - rework + 2) / denominator),
    low_human_attention: metric(
      (terminal.length - humanAttention + 2) / denominator,
    ),
    sample_size: terminal.length,
  };
};

export type AmuxQuotaTelemetry = {
  remaining_fraction: number;
  observed_at: string;
  source: "provider_api" | "wrapper";
  confidence?: number;
  exhausted?: boolean;
  reset_at?: string | null;
};

const QUOTA_SOURCE_RELIABILITY: Record<AmuxQuotaTelemetry["source"], number> = {
  provider_api: 1,
  wrapper: 0.85,
};

export const evaluateAmuxQuotaTelemetry = (
  telemetry: AmuxQuotaTelemetry | null,
  now: Date,
  maxAgeSeconds = 900,
): {
  metric: AmuxObservedMetric | null;
  provider_exhausted: boolean;
  state: "unknown" | "fresh" | "stale" | "invalid";
  reset_at: string | null;
} => {
  if (!telemetry) {
    return {
      metric: null,
      provider_exhausted: false,
      state: "unknown",
      reset_at: null,
    };
  }
  const observed = canonicalInstant(telemetry.observed_at);
  const reset = telemetry.reset_at
    ? canonicalInstant(telemetry.reset_at)
    : null;
  if (
    !observed ||
    !Number.isFinite(telemetry.remaining_fraction) ||
    telemetry.remaining_fraction < 0 ||
    telemetry.remaining_fraction > 1 ||
    (telemetry.reset_at && !reset)
  ) {
    return {
      metric: null,
      provider_exhausted: false,
      state: "invalid",
      reset_at: null,
    };
  }
  const ageSeconds = (now.getTime() - Date.parse(observed.dueAt)) / 1_000;
  if (ageSeconds < -300) {
    return {
      metric: null,
      provider_exhausted: false,
      state: "invalid",
      reset_at: reset?.dueAt ?? null,
    };
  }
  if (ageSeconds > maxAgeSeconds) {
    return {
      metric: null,
      provider_exhausted: false,
      state: "stale",
      reset_at: reset?.dueAt ?? null,
    };
  }
  const declared = clamp01(telemetry.confidence ?? 1);
  const freshness = clamp01(1 - Math.max(0, ageSeconds) / maxAgeSeconds);
  const confidence = clamp01(
    declared * QUOTA_SOURCE_RELIABILITY[telemetry.source] * freshness,
  );
  const metric: AmuxObservedMetric = {
    value: telemetry.remaining_fraction,
    confidence,
    source: telemetry.source,
    sample_size: null,
    observed_at: observed.dueAt,
  };
  const exhausted =
    confidence >= 0.8 &&
    (telemetry.exhausted === true || telemetry.remaining_fraction <= 0.01);
  return {
    metric,
    provider_exhausted: exhausted,
    state: "fresh",
    reset_at: reset?.dueAt ?? null,
  };
};

export const confidenceAdjustedMetric = (
  metric: AmuxObservedMetric | null,
) => ({
  value: metric
    ? clamp01(0.5 + (metric.value - 0.5) * clamp01(metric.confidence))
    : 0.5,
  raw_value: metric?.value ?? null,
  confidence: metric?.confidence ?? 0,
  observed: metric !== null,
  source: metric?.source ?? null,
  sample_size: metric?.sample_size ?? null,
  observed_at: metric?.observed_at ?? null,
});
