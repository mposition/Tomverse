import "server-only";

import { appUrl } from "@/lib/accountEmails";
import { OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { sendManagedSlackMessage } from "@/lib/managedSlack";
import type { LifecycleReportInput } from "@/lib/modelLifecycleDailyReportCore";
import { buildModelLifecycleDailyEmail } from "@/lib/modelLifecycleDailyEmail";
import {
  candidateIdentity,
  workItemAgeDays,
} from "@/lib/modelLifecycleWorkItemCore";
import { modelOwnerPhrase } from "@/lib/modelOwner";
import type { LifecycleReportRow } from "@/lib/modelLifecycleWorkItems";
import type { ProviderModelCatalogResult } from "@/lib/providerModelCatalogMonitor";
import type { CatalogReconciliationResult } from "@/lib/providerModelCatalogReconciliation";
import { prisma } from "@/lib/prisma";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";

const providerName = (provider: string) =>
  ({
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    groq: "Groq",
    xai: "xAI",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    moonshot: "Moonshot Kimi",
    qwen: "Qwen",
    zhipu: "Zhipu GLM",
    perplexity: "Perplexity",
  })[provider] || provider;

const code = (value: string) => `\`${value.replace(/`/g, "")}\``;

/**
 * A capped list that says what it left out and where to see it.
 *
 * The old form ended at "…and 3 more" and there was nowhere to go: the queue it
 * was truncating had no reader at all. Now that discovered models persist, the
 * cap is the first thing a backlog meets, so the tail carries the total and the
 * work queue link (ML-04).
 */
const cappedRows = (
  rows: string[],
  empty: string,
  maximum = 20,
  moreHref?: string
) => {
  if (!rows.length) return empty;
  const visible = rows.slice(0, maximum);
  if (rows.length > maximum) {
    const hidden = rows.length - maximum;
    visible.push(
      moreHref
        ? `…${hidden} more · ${rows.length} in total · <${moreHref}|open work queue>`
        : `…${hidden} more · ${rows.length} in total`
    );
  }
  return visible.join("\n");
};

/** Where a truncated list sends the reader. */
export const workQueueUrl = () => `${appUrl()}/admin/models?tab=discovery`;

const reconciliationRows = (
  reconciliation: CatalogReconciliationResult | undefined
) => {
  if (!reconciliation?.ran) return [];
  return [
    ...reconciliation.disabled.map(
      (item) =>
        `• ${providerName(item.provider)} ${code(item.apiModel)}: *disabled in registry* after ×${item.consecutiveMissing} missing scans`
    ),
    ...reconciliation.restored.map(
      (item) =>
        `• ${providerName(item.provider)} ${code(item.apiModel)}: re-enabled after reappearing in the catalog`
    ),
    ...reconciliation.held.map(
      (item) =>
        `• ${providerName(item.provider)}: *held back* — disabling all ${item.modelIds.length} enabled models looks like a catalog fault, not a retirement`
    ),
  ];
};

/**
 * One line per model, saying who made it and where it was seen -- two different
 * facts that the old single label conflated (ML-13).
 *
 * The old form printed the scanning provider in front of the identifier, so a
 * model Qwen happened to list read as a model Qwen built. Grouping by the same
 * identity the queue collapses on also stops one model occupying three lines
 * because three catalogues carry it.
 */
export const candidateRowsFor = (results: ProviderModelCatalogResult[]) => {
  const byIdentity = new Map<
    string,
    { apiModel: string; observedVia: Array<{ provider: string; apiModel: string }> }
  >();
  for (const result of results) {
    for (const model of result.newCandidates) {
      const identity = candidateIdentity(model);
      const entry = byIdentity.get(identity);
      const sighting = { provider: result.provider, apiModel: model };
      if (entry) {
        entry.observedVia.push(sighting);
        continue;
      }
      byIdentity.set(identity, { apiModel: model, observedVia: [sighting] });
    }
  }
  return [...byIdentity.values()].map((entry) => {
    // The exact string each catalogue returned, not the normalised key:
    // somebody checking the claim needs what was actually there. Repeated only
    // when a catalogue named it differently, so the common case stays short.
    const seen = entry.observedVia
      .map((sighting) =>
        sighting.apiModel === entry.apiModel
          ? providerName(sighting.provider)
          : `${providerName(sighting.provider)} as ${code(sighting.apiModel)}`
      )
      .join(", ");
    return `• ${code(entry.apiModel)} · ${modelOwnerPhrase(entry.apiModel)} · seen in ${seen}`;
  });
};

const reportParts = (
  results: ProviderModelCatalogResult[],
  reconciliation?: CatalogReconciliationResult,
  openWorkItems?: number
) => {
  const checked = results.filter((result) => result.status === "checked");
  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  const lifecycle = results.flatMap((result) =>
    result.lifecycleWarnings.map(
      (item) =>
        `• ${providerName(result.provider)} ${code(item.apiModel)}: *${item.lifecycle}*`
    )
  );
  const missing = results.flatMap((result) =>
    result.missing.map(
      (item) =>
        `• ${providerName(result.provider)} ${code(item.apiModel)}: successful catalog scans missing ×${item.consecutiveMissing}`
    )
  );
  const candidates = candidateRowsFor(results);
  const failures = [...failed, ...skipped].map(
    (result) =>
      `• ${providerName(result.provider)}: ${result.status} (${result.errorCode || "unknown"})`
  );
  const registryUpdates = reconciliationRows(reconciliation);
  const queueUrl = workQueueUrl();
  // Folded into the existing summary line rather than added as a new template
  // variable: the Slack side renders a stored template keyed on
  // provider_model_catalog_daily, which would silently drop a key it does not
  // reference. The email body below gets its own section.
  const registrySummary = reconciliation?.ran
    ? ` · registry auto-updates ${reconciliation.disabled.length + reconciliation.restored.length}${
        reconciliation.held.length ? ` · HELD ${reconciliation.held.length}` : ""
      }`
    : "";
  return {
    checked,
    failed,
    skipped,
    lifecycle,
    missing,
    candidates,
    failures,
    registryUpdates,
    variables: {
      // The backlog is folded into the summary string rather than added as a
      // new template variable, for the same reason the registry counts are:
      // the stored Slack template renders a fixed set of keys and silently
      // drops one it does not reference.
      //
      // It is the number the report did not have. "New candidates 0" was true
      // every day that seven reviewed-by-nobody models sat in the queue.
      summary: `*Summary* · checked ${checked.length}/${results.length} · lifecycle warnings ${lifecycle.length} · catalog missing ${missing.length} · new candidates ${candidates.length}${
        typeof openWorkItems === "number" ? ` · awaiting review ${openWorkItems}` : ""
      }${registrySummary}`,
      lifecycleRows: `*Lifecycle warning*\n${cappedRows(lifecycle, "None", 20, queueUrl)}`,
      missingRows: `*Missing from successful provider catalogs*\n${cappedRows(missing, "None", 20, queueUrl)}`,
      candidateRows: `*New model candidates found today*\n${cappedRows(candidates, "None", 20, queueUrl)}`,
      providerFailures: `*Provider checks not completed*\n${cappedRows(failures, "None", 20, queueUrl)}`,
    },
  };
};

const emailRecipients = () =>
  (process.env.PROVIDER_MODEL_CATALOG_ALERT_EMAIL ||
    process.env.OPS_ALERT_EMAIL ||
    process.env.ADMIN_ALERT_EMAIL ||
    "")
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);

const recordEmail = async (input: {
  title: string;
  detail: string;
  recipient: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}) => {
  await prisma.adminNotificationLog
    .create({
      data: {
        channel: "email",
        title: input.title.slice(0, 300),
        detail: input.detail.slice(0, 5_000),
        status: input.status,
        targetType: "ProviderModelCatalog",
        targetId: input.recipient,
        error: input.error?.slice(0, 1_000) || null,
      },
    })
    .catch((error) => console.error("Model catalog email log write failed:", error));
};

/**
 * The most recent successful scan per provider, for the coverage table.
 *
 * Read separately from the run this report describes because the column that
 * matters is the failed provider's: "MiniMax failed" says nothing on its own,
 * and "failed, last succeeded 19 Aug" says whether this is a blip or four days
 * of silence.
 */
const lastSuccessByProvider = async (): Promise<Map<string, Date>> => {
  const rows = await prisma.providerModelCatalogRun
    .groupBy({
      by: ["provider"],
      where: { status: "checked" },
      _max: { startedAt: true },
    })
    .catch((error) => {
      console.error("Model catalog last-success read failed:", error);
      return [] as Array<{ provider: string; _max: { startedAt: Date | null } }>;
    });
  return new Map(
    rows
      .filter((row) => row._max.startedAt)
      .map((row) => [row.provider, row._max.startedAt as Date])
  );
};

const reportPayload = (input: {
  results: ProviderModelCatalogResult[];
  reconciliation?: CatalogReconciliationResult;
  workItems: LifecycleReportRow[];
  changes?: { discovered: number; decided: number; transitions: number; completed: number };
  lastSuccess: Map<string, Date>;
  generatedAt: Date;
  localDate: string;
  generatedLabel: string;
  dayLabel: (value: Date) => string;
  test?: boolean;
}): LifecycleReportInput => ({
  localDate: input.localDate,
  generatedLabel: input.generatedLabel,
  workQueueUrl: workQueueUrl(),
  test: input.test,
  providers: input.results.map((result) => {
    const lastSuccess = input.lastSuccess.get(result.provider);
    return {
      provider: result.provider,
      displayName: providerName(result.provider),
      status: result.status,
      errorCode: result.errorCode ?? null,
      modelCount: result.status === "checked" ? result.discovered : null,
      lastSuccessLabel: lastSuccess ? input.dayLabel(lastSuccess) : null,
      // Named in the report rather than left to be inferred: Perplexity's API
      // does not list models, so its row is not evidence of anything (ML-07).
      note:
        result.provider === "perplexity"
          ? "retirement cannot be proven here"
          : null,
    };
  }),
  workItems: input.workItems.map((item) => ({
    id: item.id,
    provider: providerName(item.provider),
    // Resolved from the model's own identifier, never from the scan that filed
    // the item: the two answer different questions and conflating them is what
    // produced "Qwen kimi-k3" (ML-13).
    publisher: modelOwnerPhrase(item.apiModel),
    observedVia: item.observedVia.map((sighting) => ({
      provider: sighting.provider,
      displayName: providerName(sighting.provider),
      apiModel: sighting.apiModel,
    })),
    apiModel: item.apiModel,
    action: item.action,
    status: item.status,
    severity: item.severity,
    ownerEmail: item.ownerEmail,
    dueAt: item.dueAt ? item.dueAt.toISOString() : null,
    firstSeenAt: item.firstSeenAt.toISOString(),
    ageDays: workItemAgeDays(item.firstSeenAt, input.generatedAt),
    // Same calendar day in the report's timezone, so "new today" means what the
    // heading above it says rather than "within the last 24 hours".
    newToday: input.dayLabel(item.firstSeenAt) === input.localDate,
    blockers: item.blockers,
    pendingValidations: item.pendingValidations,
    recommendation: item.recommendation,
  })),
  lifecycleWarnings: input.results.flatMap((result) =>
    result.lifecycleWarnings.map((item) => ({
      displayName: providerName(result.provider),
      apiModel: item.apiModel,
      lifecycle: item.lifecycle,
    }))
  ),
  missing: input.results.flatMap((result) =>
    result.missing.map((item) => ({
      displayName: providerName(result.provider),
      apiModel: item.apiModel,
      consecutiveMissing: item.consecutiveMissing,
    }))
  ),
  registry: {
    ran: Boolean(input.reconciliation?.ran),
    disabled: (input.reconciliation?.disabled ?? []).map((item) => ({
      provider: item.provider,
      displayName: providerName(item.provider),
      apiModel: item.apiModel,
      detail: `disabled after ×${item.consecutiveMissing} missing scans`,
    })),
    restored: (input.reconciliation?.restored ?? []).map((item) => ({
      provider: item.provider,
      displayName: providerName(item.provider),
      apiModel: item.apiModel,
      detail: "re-enabled after reappearing in the catalogue",
    })),
    held: (input.reconciliation?.held ?? []).map((item) => ({
      provider: item.provider,
      displayName: providerName(item.provider),
      apiModel: "—",
      detail: `held back: disabling all ${item.modelIds.length} enabled models looks like a catalogue fault, not a retirement`,
    })),
  },
  ...(input.changes ? { changes: input.changes } : {}),
});

export async function sendProviderModelCatalogReport(input: {
  results: ProviderModelCatalogResult[];
  reconciliation?: CatalogReconciliationResult;
  /** Items still waiting on a person. Omitted leaves the line off entirely. */
  openWorkItems?: number;
  /** The queue itself. Absent leaves the email with counts and no rows. */
  workItems?: LifecycleReportRow[];
  changes?: { discovered: number; decided: number; transitions: number; completed: number };
  generatedAt?: Date;
  test?: boolean;
}) {
  const generatedAt = input.generatedAt || new Date();
  const parts = reportParts(input.results, input.reconciliation, input.openWorkItems);
  const generatedLabel = new Intl.DateTimeFormat("en-AU", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Brisbane",
    timeZoneName: "short",
  }).format(generatedAt);
  // One formatter for every date the report prints, so "new today" in the
  // heading and the date in the subject cannot disagree about where midnight is.
  const dayLabel = (value: Date) =>
    new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeZone: "Australia/Brisbane",
    }).format(value);
  const localDate = dayLabel(generatedAt);
  const variables = { ...parts.variables, localDate, generatedAt: generatedLabel };
  const slack = await sendManagedSlackMessage({
    key: "provider_model_catalog_daily",
    variables,
    webhookUrl:
      process.env.PROVIDER_MODEL_CATALOG_SLACK_WEBHOOK_URL ||
      process.env.OPS_ALERT_SLACK_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL,
    targetType: "ProviderModelCatalog",
    targetId: generatedAt.toISOString().slice(0, 10),
    test: input.test,
  });

  const payload = reportPayload({
    results: input.results,
    reconciliation: input.reconciliation,
    workItems: input.workItems ?? [],
    changes: input.changes,
    lastSuccess: await lastSuccessByProvider(),
    generatedAt,
    localDate,
    generatedLabel,
    dayLabel,
    test: input.test,
  });
  const rendered = buildModelLifecycleDailyEmail(payload);
  const recipients = emailRecipients();
  const email = [];
  if (!recipients.length) {
    await recordEmail({
      title: rendered.subject,
      detail: rendered.text,
      recipient: "unconfigured",
      status: "skipped",
      error: "Provider model catalog alert email is not configured.",
    });
    email.push({ recipient: null, delivered: false, status: "skipped" as const });
  } else {
    for (const recipient of recipients) {
      try {
        // Enqueued rather than sent. The report is durable from here on: it has
        // an EmailDelivery row, it retries, it is visible in
        // /admin/email-delivery, and a hard-bounced operator address stops it
        // loudly instead of dropping it (EM-14). The 15-minute drain delay is
        // the price, and it is paid by the audit copy rather than by the alert
        // -- Slack above still goes out in the same request.
        const queued = await enqueueStandardEmail({
          templateKey: OPS_MODEL_LIFECYCLE_DAILY_TEMPLATE,
          emailAddress: recipient,
          payload,
          referenceType: "ProviderModelCatalog",
          referenceId: generatedAt.toISOString().slice(0, 10),
        });
        email.push({
          recipient,
          delivered: false,
          status: "queued" as const,
          deliveryId: queued?.deliveryId ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Email enqueue failed.";
        // The lane refuses rather than storing an unencrypted snapshot, and a
        // missing key would otherwise take the whole scan down with it. The
        // scan's own result is worth more than the mail about it.
        await recordEmail({
          title: rendered.subject,
          detail: rendered.text,
          recipient,
          status: "failed",
          error: message,
        });
        email.push({ recipient, delivered: false, status: "failed" as const, error: message });
      }
    }
  }
  return { slack, email };
}
