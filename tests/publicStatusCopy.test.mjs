import assert from "node:assert/strict";
import test from "node:test";
import {
  describePublicStatusAffectedModels,
  describePublicStatusEvidence,
  formatPublicStatusUtc,
  getPublicStatusCopy,
  localizePublicStatusSummary,
  publicStatusEvidenceSource,
  publicStatusSchedulerNotice,
  resolvePublicStatusLanguage,
} from "../lib/publicStatusCopy.ts";
import {
  evaluatePublicProviderStatus,
  HEALTH_DATA_UNAVAILABLE_RESULT,
  summarizeMonitoredStatuses,
} from "../lib/providerPublicStatusCore.ts";

const languages = ["ko", "en", "zh", "fr", "de", "es", "pt"];
const now = new Date("2026-10-12T08:00:00.000Z");
const recent = "2026-10-12T07:55:00.000Z";
const old = "2026-10-12T04:00:00.000Z";
const evidence = (overrides = {}) => ({
  publicStatus: "unknown",
  publicStatusReasonCode: "NO_SUCCESS_RECORDED",
  publicStatusFreshnessMinutes: 17,
  consecutiveFailures: 13,
  consecutiveProbeFailures: 11,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastProbeSuccessAt: null,
  lastProbeFailureAt: null,
  ...overrides,
});

test("explicit status language matches the document-language resolution priority", () => {
  for (const language of languages) {
    assert.equal(resolvePublicStatusLanguage({ searchLanguage: language, documentLanguage: "en", acceptLanguage: "en-AU" }), language);
    assert.equal(resolvePublicStatusLanguage({ documentLanguage: language, acceptLanguage: "en-AU" }), language);
  }
  assert.equal(resolvePublicStatusLanguage({ searchLanguage: ["ko", "en"], documentLanguage: "en" }), "ko");
  assert.equal(resolvePublicStatusLanguage({ searchLanguage: "invalid", documentLanguage: "es" }), "es");
  assert.equal(resolvePublicStatusLanguage({ acceptLanguage: "pt-BR,fr;q=0.5" }), "pt");
  assert.equal(resolvePublicStatusLanguage({}), "en");
});

test("localization preserves the core summary tone for empty, unknown and mixed evidence", () => {
  const states = [[], ["unknown"], ["operational", "unknown"], ["operational"], ["degraded"], ["incident", "unknown"]];
  for (const language of languages) {
    for (const statuses of states) {
      const summary = summarizeMonitoredStatuses(statuses);
      const localized = localizePublicStatusSummary(summary, language, { providerCount: statuses.length, dataUnavailable: false });
      assert.equal(localized.tone, summary.tone);
      assert.ok(localized.headline);
      if (summary.tone === "unknown") {
        const healthy = localizePublicStatusSummary(summarizeMonitoredStatuses(["operational"]), language, { providerCount: 1, dataUnavailable: false });
        assert.notEqual(localized.headline, healthy.headline);
      }
    }
  }
});

test("unavailable health data never claims healthy status or an empty monitored-provider list", () => {
  const summary = summarizeMonitoredStatuses([HEALTH_DATA_UNAVAILABLE_RESULT.status]);
  for (const language of languages) {
    const localized = localizePublicStatusSummary(summary, language, { providerCount: 0, dataUnavailable: true });
    const empty = localizePublicStatusSummary(summarizeMonitoredStatuses([]), language, { providerCount: 0, dataUnavailable: false });
    assert.equal(localized.tone, "unknown");
    assert.notEqual(localized.headline, empty.headline);
    assert.equal(publicStatusEvidenceSource(evidence({ publicStatusReasonCode: "HEALTH_DATA_UNAVAILABLE" }), now), "none");
  }
});

test("operator declarations, checks and automatic checks stay distinct from real user traffic", () => {
  const groups = {
    declared: ["PUBLIC_INCIDENT_DECLARED"],
    manual: ["ADMIN_VERIFICATION_SUCCESS", "RECOVERY_VERIFICATION_FAILED"],
    probe: ["PROBE_SUCCESS_CONFIRMED", "PROBE_REPEATED_FAILURE", "PROBE_FAILURE_STALE"],
    traffic: ["RECENT_SUCCESS_CONFIRMED", "CONSECUTIVE_FAILURES_THRESHOLD", "RECENT_FAILURE_EVIDENCE", "ELEVATED_LATENCY", "REAL_FAILURE_STALE"],
    monitoring: ["INTERNAL_OUTAGE_DETECTED", "DEGRADED_PERFORMANCE"],
    none: ["NO_SUCCESS_RECORDED", "HEALTH_DATA_UNAVAILABLE"],
  };
  for (const [source, reasons] of Object.entries(groups)) {
    for (const publicStatusReasonCode of reasons) assert.equal(publicStatusEvidenceSource(evidence({ publicStatusReasonCode }), now), source);
  }
  for (const language of languages) {
    const actualTraffic = describePublicStatusEvidence(evidence({ publicStatusReasonCode: "RECENT_SUCCESS_CONFIRMED" }), language, now).source;
    for (const code of ["ADMIN_VERIFICATION_SUCCESS", "PROBE_SUCCESS_CONFIRMED", "PUBLIC_INCIDENT_DECLARED", "HEALTH_DATA_UNAVAILABLE"]) {
      assert.notEqual(describePublicStatusEvidence(evidence({ publicStatusReasonCode: code }), language, now).source, actualTraffic);
    }
  }
});

test("operating usage warnings are not presented as failed user traffic or depleted plan credits", () => {
  const base = evidence({ publicStatusReasonCode: "DEGRADED_PERFORMANCE", publicStatus: "degraded" });
  const usage = { ...base, statusReasons: [{ code: "MONTHLY_BUDGET_WARNING" }] };
  const failures = { ...base, statusReasons: [{ code: "RECENT_PROVIDER_FAILURES" }] };
  const both = { ...base, statusReasons: [...usage.statusReasons, ...failures.statusReasons] };
  assert.equal(publicStatusEvidenceSource(usage, now), "monitoring");
  assert.equal(publicStatusEvidenceSource(failures, now), "traffic");
  assert.equal(publicStatusEvidenceSource(both, now), "monitoring");
  for (const language of languages) {
    const warningText = describePublicStatusEvidence(usage, language, now).reason;
    const failureText = describePublicStatusEvidence(failures, language, now).reason;
    assert.notEqual(warningText, failureText);
    const combined = describePublicStatusEvidence(both, language, now).reason;
    assert.ok(combined.includes(warningText) && combined.includes(failureText));
  }
  assert.match(describePublicStatusEvidence(usage, "en", now).reason, /does not mean user plan credits have run out/);
  assert.doesNotMatch(describePublicStatusEvidence(usage, "en", now).reason, /request failure rate/);
});

test("stale successes identify only evidence streams actually present", () => {
  const stale = evidence({ publicStatusReasonCode: "SUCCESS_STALE" });
  assert.equal(publicStatusEvidenceSource(stale, now), "none");
  assert.equal(publicStatusEvidenceSource({ ...stale, lastSuccessAt: old }, now), "traffic");
  assert.equal(publicStatusEvidenceSource({ ...stale, lastProbeSuccessAt: old }, now), "probe");
  assert.equal(publicStatusEvidenceSource({ ...stale, lastSuccessAt: old, lastProbeSuccessAt: old }, now), "mixed");
  assert.equal(publicStatusEvidenceSource({ ...stale, lastSuccessAt: "2026-10-13T08:00:00.000Z" }, now), "none");
});

test("typed reason translation preserves counts and freshness without parsing server English", () => {
  for (const language of languages) {
    const failures = describePublicStatusEvidence(evidence({ publicStatusReasonCode: "CONSECUTIVE_FAILURES_THRESHOLD", publicStatusReasonText: "UNTRUSTED SERVER PROSE" }), language, now);
    assert.match(failures.reason, /13/);
    assert.doesNotMatch(failures.reason, /UNTRUSTED SERVER PROSE/);
    const success = describePublicStatusEvidence(evidence({ publicStatusReasonCode: "PROBE_SUCCESS_CONFIRMED" }), language, now);
    assert.match(success.reason, /17/);
    const probe = describePublicStatusEvidence(evidence({ publicStatusReasonCode: "PROBE_REPEATED_FAILURE", publicStatus: "degraded" }), language, now);
    assert.match(probe.reason, /11/);
    const incident = describePublicStatusEvidence(evidence({ publicStatusReasonCode: "PROBE_REPEATED_FAILURE", publicStatus: "incident" }), language, now);
    assert.notEqual(probe.reason, incident.reason);
    assert.doesNotMatch(success.reason + failures.reason + probe.reason, /\{(?:minutes|failures|probeFailures)\}/);
  }
});

test("unusable failure times are described differently from expired valid evidence", () => {
  for (const language of languages) {
    for (const [reason, timestamp, count] of [["PROBE_FAILURE_STALE", "lastProbeFailureAt", /11/], ["REAL_FAILURE_STALE", "lastFailureAt", /13/]]) {
      const missing = describePublicStatusEvidence(evidence({ publicStatusReasonCode: reason }), language, now).reason;
      const expired = describePublicStatusEvidence(evidence({ publicStatusReasonCode: reason, [timestamp]: old }), language, now).reason;
      assert.match(missing, count);
      assert.match(expired, /17/);
      assert.notEqual(missing, expired);
      for (const unusable of ["invalid", "2026-10-13T08:00:00.000Z"]) assert.equal(describePublicStatusEvidence(evidence({ publicStatusReasonCode: reason, [timestamp]: unusable }), language, now).reason, missing);
    }
  }
});

test("model-specific failure explanation and affected names retain the failure target", () => {
  const generic = evidence({ publicStatusReasonCode: "INTERNAL_OUTAGE_DETECTED", status: "outage" });
  const model = evidence({ publicStatusReasonCode: "INTERNAL_OUTAGE_DETECTED", status: "available", modelIncidents: [{ scope: "provider" }] });
  for (const language of languages) {
    assert.notEqual(describePublicStatusEvidence(generic, language, now).reason, describePublicStatusEvidence(model, language, now).reason);
    assert.match(describePublicStatusAffectedModels(["Model A", "Model B"], language), /Model A, Model B/);
  }
});

test("all reason codes render localized copy rather than English fallback", () => {
  const reasons = ["PUBLIC_INCIDENT_DECLARED", "INTERNAL_OUTAGE_DETECTED", "CONSECUTIVE_FAILURES_THRESHOLD", "DEGRADED_PERFORMANCE", "RECENT_FAILURE_EVIDENCE", "ELEVATED_LATENCY", "RECENT_SUCCESS_CONFIRMED", "PROBE_SUCCESS_CONFIRMED", "PROBE_REPEATED_FAILURE", "PROBE_FAILURE_STALE", "REAL_FAILURE_STALE", "ADMIN_VERIFICATION_SUCCESS", "RECOVERY_VERIFICATION_FAILED", "NO_SUCCESS_RECORDED", "SUCCESS_STALE", "HEALTH_DATA_UNAVAILABLE"];
  for (const code of reasons) {
    const input = evidence({ publicStatusReasonCode: code });
    const english = describePublicStatusEvidence(input, "en", now);
    for (const language of languages) {
      const localized = describePublicStatusEvidence(input, language, now);
      assert.ok(localized.reason);
      assert.ok(localized.source);
      if (language !== "en") assert.notEqual(localized.reason, english.reason);
    }
  }
  for (const language of languages) {
    const copy = getPublicStatusCopy(language);
    assert.notEqual(copy.statuses.unknown, copy.statuses.operational);
    assert.ok(copy.metadataTitle && copy.metadataDescription && copy.lastManual);
  }
});

test("scheduler notices keep monitoring gaps distinct from provider verdicts and preserve time", () => {
  for (const language of languages) {
    assert.equal(publicStatusSchedulerNotice(null, null, language), null);
    const delayed = publicStatusSchedulerNotice("delayed_with_history", { delayed: true, lastRunAt: recent }, language);
    assert.match(delayed, /2026-10-12 07:55 UTC/);
    assert.notEqual(delayed, publicStatusSchedulerNotice("delayed_never_run", { delayed: true, lastRunAt: null }, language));
  }
  assert.equal(formatPublicStatusUtc(recent), "2026-10-12 07:55 UTC");
});

test("displaying localized evidence does not mutate or reinterpret a core unknown verdict", () => {
  const core = evaluatePublicProviderStatus({ now, lastSuccessAt: null, lastFailureAt: null, freshnessMinutes: 17, internalStatus: "available" });
  assert.equal(core.status, "unknown");
  const input = Object.freeze(evidence({ publicStatus: core.status, publicStatusReasonCode: core.reasonCode }));
  for (const language of languages) describePublicStatusEvidence(input, language, now);
  assert.equal(input.publicStatus, core.status);
  assert.equal(input.publicStatusReasonCode, core.reasonCode);
});
