import "server-only";

import { sendTransactionalEmail } from "@/lib/email";
import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { sendManagedSlackMessage } from "@/lib/managedSlack";
import type { ProviderModelCatalogResult } from "@/lib/providerModelCatalogMonitor";
import type { CatalogReconciliationResult } from "@/lib/providerModelCatalogReconciliation";
import { prisma } from "@/lib/prisma";

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

const cappedRows = (rows: string[], empty: string, maximum = 20) => {
  if (!rows.length) return empty;
  const visible = rows.slice(0, maximum);
  if (rows.length > maximum) visible.push(`…and ${rows.length - maximum} more`);
  return visible.join("\n");
};

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
  const candidates = results.flatMap((result) =>
    result.newCandidates.map(
      (model) => `• ${providerName(result.provider)} ${code(model)}`
    )
  );
  const failures = [...failed, ...skipped].map(
    (result) =>
      `• ${providerName(result.provider)}: ${result.status} (${result.errorCode || "unknown"})`
  );
  const registryUpdates = reconciliationRows(reconciliation);
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
      lifecycleRows: `*Lifecycle warning*\n${cappedRows(lifecycle, "None")}`,
      missingRows: `*Missing from successful provider catalogs*\n${cappedRows(missing, "None")}`,
      candidateRows: `*New model candidates found today*\n${cappedRows(candidates, "None")}`,
      providerFailures: `*Provider checks not completed*\n${cappedRows(failures, "None")}`,
    },
  };
};

const plain = (value: string) =>
  value.replace(/\*/g, "").replace(/`/g, "");

const htmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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

export async function sendProviderModelCatalogReport(input: {
  results: ProviderModelCatalogResult[];
  reconciliation?: CatalogReconciliationResult;
  /** Items still waiting on a person. Omitted leaves the line off entirely. */
  openWorkItems?: number;
  generatedAt?: Date;
  test?: boolean;
}) {
  const generatedAt = input.generatedAt || new Date();
  const parts = reportParts(input.results, input.reconciliation, input.openWorkItems);
  const localDate = new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeZone: "Australia/Brisbane",
  }).format(generatedAt);
  const generatedLabel = new Intl.DateTimeFormat("en-AU", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Brisbane",
    timeZoneName: "short",
  }).format(generatedAt);
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

  const subject = `${input.test ? "[TEST] " : ""}[Tomverse] Daily model lifecycle and discovery · ${localDate}`;
  const detail = [
    plain(parts.variables.summary),
    `Lifecycle warning\n${plain(cappedRows(parts.lifecycle, "None", 100))}`,
    `Missing from successful provider catalogs\n${plain(cappedRows(parts.missing, "None", 100))}`,
    `New model candidates found today\n${plain(cappedRows(parts.candidates, "None", 100))}`,
    `Provider checks not completed\n${plain(cappedRows(parts.failures, "None", 100))}`,
    `Registry auto-updates\n${plain(cappedRows(parts.registryUpdates, input.reconciliation?.ran === false ? "Disabled by configuration" : "None", 100))}`,
    "",
    "A model missing from a successful list response is not declared deprecated after one scan. Tomverse reports consecutive misses separately because access permissions and provider catalog behavior can also cause absence.",
    `Generated ${generatedLabel}`,
  ].join("\n\n");
  const recipients = emailRecipients();
  const email = [];
  if (!recipients.length) {
    await recordEmail({
      title: subject,
      detail,
      recipient: "unconfigured",
      status: "skipped",
      error: "Provider model catalog alert email is not configured.",
    });
    email.push({ recipient: null, delivered: false, status: "skipped" as const });
  } else {
    for (const recipient of recipients) {
      try {
        const sent = await sendTransactionalEmail({
          to: recipient,
          subject,
          text: detail,
          html: `<div style="font-family:${EMAIL_FONT_STACK};white-space:pre-wrap;line-height:1.55">${htmlEscape(detail)}</div>`,
        });
        const status = sent.sent ? "sent" : "skipped";
        await recordEmail({ title: subject, detail, recipient, status });
        email.push({ recipient, delivered: sent.sent, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Email delivery failed.";
        await recordEmail({
          title: subject,
          detail,
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
