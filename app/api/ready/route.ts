export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import {
  reportOperationalDependencyStatus,
  reportOperationalIncident,
} from "@/lib/operationalMonitoring";
import { computeReadinessChecks } from "@/lib/readinessChecks";

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const readinessResponse = async (head = false) => {
  const traceId = randomUUID();
  const {
    databaseResult,
    securityStatus,
    budgetStatus,
    imageBudgetStatus,
    voiceBudgetStatus,
    voiceModelPriceStatus,
    searchBudgetStatus,
    sendingIdentity,
    snapshotKeyring,
    unsubscribeKeyring,
    unsubscribeRetentionStatus,
    consentKeyring,
    businessIdentity,
    subjectLabels,
    footerDisclosures,
    biennialNotice,
    amuxReviewStatus,
    checks,
    ready,
  } = await computeReadinessChecks();
  const {
    database,
    securityEnvironment,
    providerBudgets,
    imageProviderBudget,
    voiceProviderBudget,
    voiceModelPrice,
    searchProviderBudget,
    emailSendingIdentity,
    emailSnapshotKeyring,
    emailUnsubscribeKeyring,
    emailUnsubscribeKeyRetention,
    emailConsentKeyring,
    emailBusinessIdentity,
    emailSubjectLabels,
    emailFooterDisclosures,
    emailBiennialConsentNotice,
    amuxReviewApproval,
  } = checks;
  const headers = ready
    ? { ...baseHeaders, "X-Tomverse-Trace-Id": traceId }
    : {
        ...baseHeaders,
        "Retry-After": "5",
        "X-Tomverse-Trace-Id": traceId,
      };

  const failedSecurityChecks = Object.entries(securityStatus.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  after(async () => {
    // A warning on a healthy check reaches nobody through the dependency
    // report, which records context only when unhealthy. Mail that is not yet
    // guarded by an adopted keyring is exactly the state that must not be
    // mistaken for verified, so it is raised on its own, rate limited.
    const unguarded = unsubscribeRetentionStatus.status?.warnings.filter(
      (problem) => problem.code === "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNADOPTED"
    );
    if (unguarded && unguarded.length > 0) {
      await reportOperationalIncident({
        code: "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNADOPTED",
        title: "Older mail with unsubscribe links is not yet guarded by an adopted keyring",
        severity: "warning",
        error: unguarded.map((problem) => problem.message).join(" | "),
        cooldownMs: 60 * 60 * 1_000,
        context: { component: "api-ready", route: "/api/ready", traceId },
      });
    }
    await Promise.all([
      reportOperationalDependencyStatus({
        dependency: "postgresql",
        healthy: database,
        code: "DATABASE_READINESS_FAILED",
        title: "Database readiness check failed",
        error:
          databaseResult.error ||
          (database ? "Database is healthy." : "SELECT 1 returned no ready row."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          durationMs: databaseResult.durationMs,
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "provider-cost-budgets",
        healthy: providerBudgets,
        code: "PROVIDER_COST_BUDGET_NOT_READY",
        title: "Provider spend budgets are not configured correctly",
        error:
          budgetStatus.errors.length > 0
            ? budgetStatus.errors.map((problem) => problem.message).join(" | ")
            : "Provider spend budgets are configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          failedProviders:
            [
              ...new Set(budgetStatus.errors.map((problem) => problem.provider)),
            ].join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "voice-provider-seconds-budget",
        healthy: voiceProviderBudget,
        code: "VOICE_PROVIDER_SECONDS_BUDGET_NOT_READY",
        title: "Voice provider usage budget (seconds) is not configured correctly",
        error: voiceProviderBudget
          ? "Voice provider budget is configured (or the feature flag is off)."
          : voiceBudgetStatus.error ??
            ((voiceBudgetStatus.status?.budget.problems ?? [])
              .map((problem) => `${problem.envName}: ${problem.detail}`)
              .join(" | ") ||
              "Voice input is enabled but its provider budget is unusable."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          voiceBudgetCheckThrew: voiceBudgetStatus.error !== null,
          voiceInputFlagEnabled: voiceBudgetStatus.status?.flagEnabled ?? false,
          // Names only. The numbers are an operational decision, not a secret,
          // but a readiness log is not where an operator should have to read
          // them -- and a problem list that carries values grows into one that
          // carries the values of things that are secret.
          voiceBudgetProblems:
            (voiceBudgetStatus.status?.budget.problems ?? [])
              .map((problem) => `${problem.envName}:${problem.code}`)
              .join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "voice-transcription-model-price",
        healthy: voiceModelPrice,
        code: "VOICE_TRANSCRIPTION_MODEL_PRICE_NOT_READY",
        title: "The configured voice transcription model has no known cost",
        error: voiceModelPrice
          ? "The configured transcription model's cost is known (or the feature flag is off)."
          : voiceModelPriceStatus.error ??
            voiceModelPriceStatus.status?.refusal?.detail ??
            "Voice input is enabled but its transcription model's cost is unknown.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          voiceModelPriceCheckThrew: voiceModelPriceStatus.error !== null,
          voiceInputFlagEnabled:
            voiceModelPriceStatus.status?.flagEnabled ?? false,
          // The model id is configuration an operator chose, and naming it is
          // the whole remedy: the refusal is unactionable without knowing
          // which model was configured.
          voiceTranscriptionModel:
            voiceModelPriceStatus.status?.modelId ?? "unknown",
          voiceModelPriceRefusal:
            voiceModelPriceStatus.status?.refusal?.code ?? "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "image-provider-cost-budget",
        healthy: imageProviderBudget,
        code: "IMAGE_PROVIDER_COST_BUDGET_NOT_READY",
        title: "Image provider spend budget is not configured correctly",
        error: imageProviderBudget
          ? "Image provider budget is configured (or the feature flag is off)."
          : imageBudgetStatus.error ??
            ((imageBudgetStatus.status?.providers ?? [])
              .flatMap((entry) =>
                entry.resolved.problems.map(
                  (problem) => `${entry.provider}: ${problem.message}`
                )
              )
              .join(" | ") ||
              "Image generation is enabled but its provider budget is unusable."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          imageBudgetCheckThrew: imageBudgetStatus.error !== null,
          imageGenerationFlagEnabled:
            imageBudgetStatus.status?.flagEnabled ?? false,
          imageProviders:
            (imageBudgetStatus.status?.providers ?? [])
              .map((entry) => entry.provider)
              .join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "search-provider-cost-budget",
        healthy: searchProviderBudget,
        code: "SEARCH_PROVIDER_COST_BUDGET_NOT_READY",
        title: "Application-managed web search is not configured correctly",
        error: searchProviderBudget
          ? "Search backend credentials and spend budget are configured."
          : searchBudgetStatus.error ??
            ((searchBudgetStatus.status?.problems ?? [])
              .map((problem) => problem.message)
              .join(" | ") ||
              "A search backend is unusable."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          searchBudgetCheckThrew: searchBudgetStatus.error !== null,
          // Names, never values. Which backends this deployment holds a
          // credential for is operational fact; the credential is not.
          configuredSearchBackends:
            (searchBudgetStatus.status?.configuredBackends ?? []).join(",") ||
            "none",
          requiredSearchBackends:
            (searchBudgetStatus.status?.requiredBackends ?? []).join(",") ||
            "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-sending-identity",
        healthy: emailSendingIdentity,
        code: "EMAIL_SENDING_IDENTITY_NOT_READY",
        title: "Email sending domains are not configured correctly",
        error:
          sendingIdentity.errors.length > 0
            ? sendingIdentity.errors.map((problem) => problem.message).join(" | ")
            : "Email sending domains are configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          warnings:
            sendingIdentity.warnings.map((problem) => problem.code).join(",") ||
            "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-snapshot-keyring",
        healthy: emailSnapshotKeyring,
        code: "EMAIL_SNAPSHOT_KEYRING_NOT_READY",
        title: "Email render snapshots cannot be sealed",
        error:
          snapshotKeyring.errors.length > 0
            ? snapshotKeyring.errors.map((problem) => problem.message).join(" | ")
            : "The email snapshot keyring is configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // Counts, never the version label or the secret: a keyring is
          // misconfigured most often by a value pasted into the wrong
          // variable, and the wrong variable here holds key material.
          versionCount: snapshotKeyring.versionCount,
          warnings:
            snapshotKeyring.warnings.map((problem) => problem.code).join(",") ||
            "none",
          traceId,
        },
      }),
      // The two Korean duty checks. Both are reported rather than only folded
      // into a boolean: the subject label's own failure names which country is
      // refused, and the biennial notice's warning is the whole point of
      // section 7.7's "device that stops it being forgotten" -- a warning that
      // reaches nobody is a calculation.
      reportOperationalDependencyStatus({
        dependency: "email-subject-labels",
        healthy: emailSubjectLabels,
        code: "EMAIL_SUBJECT_LABEL_MISSING",
        title: "A statutory subject label is not on the rows that send",
        error:
          subjectLabels === null
            ? "The subject label readiness check could not be answered."
            : subjectLabels.problems.length > 0
              ? subjectLabels.problems.map((problem) => problem.message).join(" | ")
              : "Every required subject label is present.",
        severity: "warning",
        context: {
          component: "api-ready",
          route: "/api/ready",
          required: String(subjectLabels?.required ?? "unknown"),
          labelsPresent: String(subjectLabels?.labelsPresent ?? "unknown"),
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-footer-disclosures",
        healthy: emailFooterDisclosures,
        code: "EMAIL_FOOTER_DISCLOSURE_MISSING",
        title: "A statutory footer block is not on the rows that send",
        error:
          footerDisclosures === null
            ? "The footer disclosure readiness check could not be answered."
            : footerDisclosures.problems.length > 0
              ? footerDisclosures.problems.map((problem) => problem.message).join(" | ")
              : "Every required footer block is named and has a value.",
        severity: "warning",
        context: {
          component: "api-ready",
          route: "/api/ready",
          disclosuresPresent: String(footerDisclosures?.disclosuresPresent ?? "unknown"),
          policyVersions: String(footerDisclosures?.policyVersionIds.length ?? "unknown"),
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-biennial-consent-notice",
        healthy: emailBiennialConsentNotice && (biennialNotice?.problems.length ?? 0) === 0,
        code: "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE",
        title: "Korea's two-yearly consent notice is due or close to it",
        error:
          biennialNotice === null
            ? "The biennial consent notice readiness check could not be answered."
            : biennialNotice.problems.length > 0
              ? biennialNotice.problems.map((problem) => problem.message).join(" | ")
              : biennialNotice.earliestDueAt === null
                ? "No Korean recipient is anchored, so nothing is due."
                : `The earliest deadline is ${biennialNotice.earliestDueAt.toISOString().slice(0, 10)}.`,
        severity: "warning",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // A count and a date, and nothing that identifies anybody: the
          // deadline is reported to the day rather than the millisecond, so a
          // single-recipient count cannot be correlated back to one consent.
          recipients: String(biennialNotice?.recipients ?? "unknown"),
          earliestDueOn: biennialNotice?.earliestDueAt?.toISOString().slice(0, 10) ?? "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-business-identity",
        healthy: emailBusinessIdentity,
        code: "EMAIL_BUSINESS_IDENTITY_NOT_READY",
        title: "Email footers cannot say who sent the message",
        error:
          businessIdentity.errors.length > 0
            ? businessIdentity.errors.map((problem) => problem.message).join(" | ")
            : businessIdentity.warnings.length > 0
              ? businessIdentity.warnings.map((problem) => problem.message).join(" | ")
              : "The footer's business identity is configured.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // The variables to set, not just the blocks that are empty: an
          // operator told which footer block is missing still has to work out
          // which variable sets it.
          setInstead:
            [...businessIdentity.errors, ...businessIdentity.warnings]
              .flatMap((problem) => problem.variables)
              .join(",") || "none",
          marketingConfigured: businessIdentity.required,
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-unsubscribe-keyring",
        healthy: emailUnsubscribeKeyring,
        code: "EMAIL_UNSUBSCRIBE_KEYRING_NOT_READY",
        title: "Marketing mail cannot carry a one-click unsubscribe link",
        error:
          unsubscribeKeyring.errors.length > 0
            ? unsubscribeKeyring.errors.map((problem) => problem.message).join(" | ")
            : unsubscribeKeyring.required
              ? "The unsubscribe keyring is configured."
              : "Marketing sending is not configured, so no unsubscribe keyring is required yet.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // Whether this deployment is one the keys are mandatory for, so a
          // warning here can be read without also knowing what
          // MARKETING_EMAIL_FROM is set to. No counts and no labels: unlike the
          // snapshot keyring this can be absent by design, and a version count
          // of zero would read as a fault.
          required: unsubscribeKeyring.required,
          warnings:
            unsubscribeKeyring.warnings.map((problem) => problem.code).join(",") ||
            "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-unsubscribe-key-retention",
        healthy: emailUnsubscribeKeyRetention,
        code: "EMAIL_UNSUBSCRIBE_KEY_RETENTION_NOT_READY",
        title: "An unsubscribe key that recent mail depends on no longer opens its links",
        error:
          unsubscribeRetentionStatus.error ??
          (unsubscribeRetentionStatus.status &&
          unsubscribeRetentionStatus.status.errors.length > 0
            ? unsubscribeRetentionStatus.status.errors
                .map((problem) => problem.message)
                .join(" | ")
            : "Every unsubscribe key used in the retention window opens its links."),
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          // Version names only, never secrets or tokens. Retirable versions are
          // listed so an operator rotating keys can see what is safe to drop.
          failedVersions:
            unsubscribeRetentionStatus.status?.errors
              .map((problem) => problem.keyVersion)
              .join(",") || "none",
          retirableVersions:
            unsubscribeRetentionStatus.status?.retirable.join(",") || "none",
          warnings:
            unsubscribeRetentionStatus.status?.warnings
              .map((problem) => `${problem.code}:${problem.keyVersion}`)
              .join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "email-consent-keyring",
        healthy: emailConsentKeyring,
        code: "EMAIL_CONSENT_KEYRING_NOT_READY",
        title: "Marketing consent cannot be confirmed",
        error:
          consentKeyring.errors.length > 0
            ? consentKeyring.errors.map((problem) => problem.message).join(" | ")
            : consentKeyring.required
              ? "The consent keyring is configured."
              : "Marketing sending is not configured, so no consent keyring is required yet.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          required: consentKeyring.required,
          warnings:
            consentKeyring.warnings.map((problem) => problem.code).join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "amux-review-approval",
        healthy: amuxReviewApproval,
        code: "AMUX_REVIEW_APPROVAL_NOT_READY",
        title: "AMUX human review approval is not configured correctly",
        error: amuxReviewApproval
          ? "AMUX human review approval is configured (or its flag is off)."
          : `Missing or invalid: ${amuxReviewStatus.missing.join(", ")}`,
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          enabled: amuxReviewStatus.enabled,
          missingVariableNames: amuxReviewStatus.missing.join(",") || "none",
          traceId,
        },
      }),
      reportOperationalDependencyStatus({
        dependency: "security-environment",
        healthy: securityEnvironment,
        code: "SECURITY_ENVIRONMENT_NOT_READY",
        title: "Production security environment validation failed",
        error:
          failedSecurityChecks.length > 0
            ? `Failed checks: ${failedSecurityChecks.join(", ")}`
            : "Security environment is healthy.",
        severity: "fatal",
        context: {
          component: "api-ready",
          route: "/api/ready",
          failedChecks: failedSecurityChecks.join(",") || "none",
          traceId,
        },
      }),
    ]);
  });

  if (head) {
    return new Response(null, {
      status: ready ? 204 : 503,
      headers,
    });
  }

  return Response.json(
    {
      ok: ready,
      checks: {
        database,
        securityEnvironment,
        providerBudgets,
        imageProviderBudget,
        voiceProviderBudget,
        voiceModelPrice,
        searchProviderBudget,
        emailSendingIdentity,
        emailSnapshotKeyring,
        emailUnsubscribeKeyring,
        emailUnsubscribeKeyRetention,
        emailConsentKeyring,
        emailBusinessIdentity,
        emailSubjectLabels,
        emailFooterDisclosures,
        emailBiennialConsentNotice,
        amuxReviewApproval,
      },
      traceId,
    },
    {
      status: ready ? 200 : 503,
      headers,
    }
  );
};

export async function GET() {
  return readinessResponse();
}

export async function HEAD() {
  return readinessResponse(true);
}
