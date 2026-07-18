import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const CHECKS = [
  ["Secret history scan", "SECURITY_AUDIT_GITLEAKS_STATUS"],
  ["Node runtime setup", "SECURITY_AUDIT_SETUP_NODE_STATUS"],
  ["Dependency installation", "SECURITY_AUDIT_INSTALL_STATUS"],
  ["Production dependency audit", "SECURITY_AUDIT_DEPENDENCY_STATUS"],
  ["Security regression checks", "SECURITY_AUDIT_REGRESSION_STATUS"],
  ["Unit and API policy tests", "SECURITY_AUDIT_UNIT_STATUS"],
  ["Strict encoding validation", "SECURITY_AUDIT_ENCODING_STATUS"],
  ["Independent TypeScript validation", "SECURITY_AUDIT_TYPECHECK_STATUS"],
  ["ESLint and production build", "SECURITY_AUDIT_PRODUCTION_STATUS"],
  ["Playwright browser setup", "SECURITY_AUDIT_BROWSER_INSTALL_STATUS"],
  ["Full desktop and mobile E2E", "SECURITY_AUDIT_E2E_STATUS"],
];

const normalizeStatus = (value) => {
  const normalized = String(value || "unknown").trim().toLowerCase();
  return ["success", "failure", "cancelled", "skipped"].includes(normalized)
    ? normalized
    : "unknown";
};

const statuses = CHECKS.map(([label, key]) => ({
  label,
  status: normalizeStatus(process.env[key]),
}));
const passed = statuses.every((entry) => entry.status === "success");

const parseCount = (value) =>
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

const readDependencyAudit = async () => {
  try {
    const source = await readFile("security-audit/npm-audit.json", "utf8");
    const parsed = JSON.parse(source);
    const vulnerabilities = parsed?.metadata?.vulnerabilities || {};
    return {
      critical: parseCount(vulnerabilities.critical),
      high: parseCount(vulnerabilities.high),
      moderate: parseCount(vulnerabilities.moderate),
      low: parseCount(vulnerabilities.low),
      total: parseCount(vulnerabilities.total),
      error:
        typeof parsed?.error?.summary === "string"
          ? parsed.error.summary.slice(0, 300)
          : null,
    };
  } catch (error) {
    return {
      critical: null,
      high: null,
      moderate: null,
      low: null,
      total: null,
      error: error instanceof Error ? error.message.slice(0, 300) : "Unavailable",
    };
  }
};

const dependencyAudit = await readDependencyAudit();
const generatedAt = new Date();
const localDate = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(generatedAt);
const workflowUrl = [
  process.env.GITHUB_SERVER_URL,
  process.env.GITHUB_REPOSITORY,
  "actions/runs",
  process.env.GITHUB_RUN_ID,
]
  .filter(Boolean)
  .join("/");
const shortSha = String(process.env.GITHUB_SHA || "unknown").slice(0, 8);
const overallLabel = passed ? "PASSED" : "FAILED";
const overallEmoji = passed ? ":large_green_circle:" : ":red_circle:";

const statusIcon = (status) => {
  if (status === "success") return ":white_check_mark:";
  if (status === "failure") return ":x:";
  if (status === "skipped") return ":fast_forward:";
  if (status === "cancelled") return ":no_entry_sign:";
  return ":grey_question:";
};

const countLabel = (value) => (value === null ? "unavailable" : String(value));
const slackChecks = statuses
  .map((entry) => `${statusIcon(entry.status)} *${entry.label}:* ${entry.status}`)
  .join("\n");
const slackDetail = [
  `${overallEmoji} *Overall:* ${overallLabel}`,
  `*Generated:* ${localDate} Australia/Brisbane`,
  `*Production dependency vulnerabilities:* critical ${countLabel(
    dependencyAudit.critical
  )} · high ${countLabel(dependencyAudit.high)} · moderate ${countLabel(
    dependencyAudit.moderate
  )} · low ${countLabel(dependencyAudit.low)} · total ${countLabel(
    dependencyAudit.total
  )}`,
  dependencyAudit.error ? `*Dependency audit detail:* ${dependencyAudit.error}` : null,
  slackChecks,
  `*Source:* ${process.env.GITHUB_REPOSITORY || "unknown"} · ${shortSha} · ${
    process.env.GITHUB_EVENT_NAME || "unknown"
  }`,
  workflowUrl ? `<${workflowUrl}|Open GitHub Actions run>` : null,
]
  .filter(Boolean)
  .join("\n");
const title = `[${overallLabel}] Tomverse daily security audit · ${localDate}`;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const emailRows = statuses
  .map(
    (entry) =>
      `<tr><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(
        entry.label
      )}</td><td style="padding:8px;border-bottom:1px solid #ddd"><strong>${escapeHtml(
        entry.status
      )}</strong></td></tr>`
  )
  .join("");
const emailText = [
  title,
  "",
  ...statuses.map((entry) => `${entry.label}: ${entry.status}`),
  "",
  `Production dependency vulnerabilities: critical ${countLabel(
    dependencyAudit.critical
  )}, high ${countLabel(dependencyAudit.high)}, moderate ${countLabel(
    dependencyAudit.moderate
  )}, low ${countLabel(dependencyAudit.low)}, total ${countLabel(
    dependencyAudit.total
  )}`,
  dependencyAudit.error ? `Dependency audit detail: ${dependencyAudit.error}` : null,
  `Repository: ${process.env.GITHUB_REPOSITORY || "unknown"}`,
  `Commit: ${shortSha}`,
  workflowUrl ? `Workflow: ${workflowUrl}` : null,
]
  .filter(Boolean)
  .join("\n");
const emailHtml = `
  <h1>${escapeHtml(title)}</h1>
  <p><strong>Overall:</strong> ${escapeHtml(overallLabel)}</p>
  <p><strong>Generated:</strong> ${escapeHtml(localDate)} Australia/Brisbane</p>
  <h2>Checks</h2>
  <table style="border-collapse:collapse;width:100%;max-width:720px"><tbody>${emailRows}</tbody></table>
  <h2>Production dependency vulnerabilities</h2>
  <p>Critical: <strong>${countLabel(dependencyAudit.critical)}</strong> · High: <strong>${countLabel(
    dependencyAudit.high
  )}</strong> · Moderate: <strong>${countLabel(
    dependencyAudit.moderate
  )}</strong> · Low: <strong>${countLabel(dependencyAudit.low)}</strong> · Total: <strong>${countLabel(
    dependencyAudit.total
  )}</strong></p>
  ${
    dependencyAudit.error
      ? `<p><strong>Dependency audit detail:</strong> ${escapeHtml(dependencyAudit.error)}</p>`
      : ""
  }
  <p>Repository: ${escapeHtml(process.env.GITHUB_REPOSITORY || "unknown")}<br />Commit: ${escapeHtml(
    shortSha
  )}</p>
  ${
    workflowUrl
      ? `<p><a href="${escapeHtml(workflowUrl)}">Open GitHub Actions run</a></p>`
      : ""
  }
`;

const parseRecipients = (value) =>
  Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))
    )
  );

const sendSlack = async () => {
  const webhook = process.env.SECURITY_AUDIT_SLACK_WEBHOOK_URL?.trim();
  if (!webhook) throw new Error("Security audit Slack webhook is not configured.");
  const target = new URL(webhook);
  if (target.protocol !== "https:") {
    throw new Error("Security audit Slack webhook must use HTTPS.");
  }
  const blockText = `<!channel>\n*${title}*\n${slackDetail}`.slice(0, 3_000);
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `<!channel>\n${title}\n${slackDetail}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: blockText },
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Security audit Slack webhook returned ${response.status}.`);
  }
  return { status: "sent" };
};

const sendEmails = async () => {
  const recipients = parseRecipients(process.env.SECURITY_AUDIT_EMAILS);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (recipients.length === 0) {
    throw new Error("Security audit email recipient is not configured.");
  }
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured for security reports.");
  const from =
    process.env.SECURITY_AUDIT_EMAIL_FROM?.trim() ||
    "Tomverse Security <hello@tomverse.app>";
  for (const recipient of recipients) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipient,
        subject: title,
        html: emailHtml,
        text: emailText,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Security audit email delivery returned ${response.status}: ${detail.slice(0, 200)}`
      );
    }
  }
  return { status: "sent", recipients: recipients.length };
};

const shouldSend = process.env.SECURITY_AUDIT_SEND_NOTIFICATIONS === "true";
const deliveries = {
  slack: { status: shouldSend ? "pending" : "not_requested" },
  email: { status: shouldSend ? "pending" : "not_requested" },
};

if (shouldSend) {
  const [slackResult, emailResult] = await Promise.allSettled([sendSlack(), sendEmails()]);
  deliveries.slack =
    slackResult.status === "fulfilled"
      ? slackResult.value
      : {
          status: "failed",
          error:
            slackResult.reason instanceof Error
              ? slackResult.reason.message
              : "Slack delivery failed.",
        };
  deliveries.email =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : {
          status: "failed",
          error:
            emailResult.reason instanceof Error
              ? emailResult.reason.message
              : "Email delivery failed.",
        };
}

const report = {
  generatedAt: generatedAt.toISOString(),
  localDate,
  overall: passed ? "passed" : "failed",
  repository: process.env.GITHUB_REPOSITORY || null,
  commit: process.env.GITHUB_SHA || null,
  event: process.env.GITHUB_EVENT_NAME || null,
  workflowUrl: workflowUrl || null,
  checks: statuses,
  dependencyAudit,
  deliveries,
};

const outputPath = process.env.SECURITY_AUDIT_OUTPUT_PATH?.trim();
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY?.trim();
if (summaryPath) {
  const summary = [
    "## Tomverse Daily Security Audit",
    "",
    `**Overall:** ${overallLabel}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...statuses.map((entry) => `| ${entry.label} | ${entry.status} |`),
    "",
    `Dependency vulnerabilities: critical ${countLabel(
      dependencyAudit.critical
    )}, high ${countLabel(dependencyAudit.high)}, moderate ${countLabel(
      dependencyAudit.moderate
    )}, low ${countLabel(dependencyAudit.low)}, total ${countLabel(
      dependencyAudit.total
    )}.`,
    "",
    `Slack report: ${deliveries.slack.status}; email report: ${deliveries.email.status}.`,
    "",
  ].join("\n");
  await appendFile(summaryPath, summary, "utf8");
}

console.log("Daily security audit report prepared.", {
  overall: report.overall,
  slack: deliveries.slack.status,
  email: deliveries.email.status,
});
for (const entry of statuses) {
  console.log(`[security-audit] ${entry.label}: ${entry.status}`);
}

if (
  shouldSend &&
  (deliveries.slack.status !== "sent" || deliveries.email.status !== "sent")
) {
  console.error("Daily security audit report delivery failed.", {
    slack: deliveries.slack,
    email: deliveries.email,
  });
  process.exitCode = 1;
}
