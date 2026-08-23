import "server-only";

import { EMAIL_FONT_STACK, EMAIL_MONO_FONT_STACK } from "@/lib/emailTypography";
import {
  buildDailyLifecycleReport,
  type DailyLifecycleReport,
  type LifecycleReportInput,
  type LifecycleReportWorkItem,
  type ReportList,
} from "@/lib/modelLifecycleDailyReportCore";

/**
 * The operator's daily model lifecycle mail, HTML and plain text.
 *
 * Both halves render from `buildDailyLifecycleReport()` rather than from the
 * raw input, so neither can grow a section the other does not have.
 *
 * Written for Outlook's Word renderer, which is why this looks like 2003:
 * nested fixed-width tables instead of `max-width`, `<td width="25%">` instead
 * of a grid, `bgcolor` cells instead of `border-left`, and every rule inline.
 * The one `<style>` block holds a mobile media query and nothing the mail needs
 * -- a client that drops it still gets a single readable column.
 *
 * English only. This is operator mail; the user-facing templates are the ones
 * that carry the language policy.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md section 10.
 */

const INK = "#18181b";
const MUTED = "#52525b";
const HAIRLINE = "#e4e4e7";
const CANVAS = "#f4f4f5";
const CRITICAL = "#b91c1c";
const HIGH = "#c2410c";
const NORMAL = "#3f3f46";
const OK = "#047857";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const severityColour = (severity: string) =>
  severity === "critical" ? CRITICAL : severity === "high" ? HIGH : NORMAL;

/** Severity reaches the reader as a word. Colour is decoration on top of it. */
const severityLabel = (severity: string) => severity.toUpperCase();

const cell = (content: string, style = "") =>
  `<td style="font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:1.5;color:${INK};${style}">${content}</td>`;

const mono = (value: string) =>
  `<span style="font-family:${EMAIL_MONO_FONT_STACK};font-size:13px;word-break:break-all">${escapeHtml(value)}</span>`;

const sectionHeading = (title: string, count?: number) =>
  `<tr>${cell(
    `${escapeHtml(title)}${typeof count === "number" ? ` &mdash; ${count}` : ""}`,
    `padding:22px 24px 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:700`
  )}</tr>`;

/**
 * The line a truncated section ends with.
 *
 * It carries the total and a link, which is the whole of ML-04: the old report
 * said "…and 3 more" and there was nowhere to go and see them.
 */
const overflowRow = (hidden: number, total: number, url: string) =>
  hidden > 0
    ? `<tr>${cell(
        `<a href="${escapeHtml(url)}" style="color:${MUTED};text-decoration:underline">${hidden} more &middot; ${total} in total &middot; open work queue &rarr;</a>`,
        `padding:6px 24px 4px;font-size:13px;color:${MUTED}`
      )}</tr>`
    : "";

const ageLabel = (item: LifecycleReportWorkItem) =>
  item.newToday ? "NEW" : `${item.ageDays}d`;

const actionCard = (item: LifecycleReportWorkItem, url: string) => {
  const facts = [
    `first seen ${item.newToday ? "today" : `${item.ageDays} days ago`}`,
    `owner ${item.ownerEmail ? escapeHtml(item.ownerEmail) : "unassigned"}`,
    item.dueAt ? `due ${escapeHtml(item.dueAt.slice(0, 10))}` : "due &mdash;",
  ].join(" &middot; ");
  const blockers = item.blockers.length
    ? `<div style="margin-top:6px">Blocker: ${escapeHtml(item.blockers.join("; "))}</div>`
    : "";
  const validations = item.pendingValidations.length
    ? `<div style="margin-top:4px">Pending: ${escapeHtml(item.pendingValidations.join(", "))}</div>`
    : "";
  const recommendation = item.recommendation
    ? `<div style="margin-top:4px;color:${MUTED}">${escapeHtml(item.recommendation)}</div>`
    : "";
  return `<tr>${cell(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${HAIRLINE};border-radius:6px">
      <tr>
        <td width="4" bgcolor="${severityColour(item.severity)}" style="width:4px;font-size:0;line-height:0">&nbsp;</td>
        ${cell(
          `<div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:${severityColour(item.severity)}">${severityLabel(item.severity)} &middot; ${escapeHtml(item.action)} &middot; ${escapeHtml(item.provider)}</div>
           <div style="margin-top:4px">${mono(item.apiModel)}</div>
           <div style="margin-top:6px;color:${MUTED};font-size:13px">${facts}</div>
           ${blockers}${validations}${recommendation}
           <div style="margin-top:10px"><a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:underline">Review item &rarr;</a></div>`,
          "padding:14px 16px"
        )}
      </tr>
    </table>`,
    "padding:6px 24px"
  )}</tr>`;
};

const compactRow = (item: LifecycleReportWorkItem) =>
  `<tr>${cell(
    `<span style="color:${MUTED};display:inline-block;min-width:44px">${ageLabel(item)}</span> ${escapeHtml(item.provider)} &nbsp; ${mono(item.apiModel)}`,
    "padding:3px 24px;font-size:13px"
  )}</tr>`;

const kpiCell = (label: string, value: string) =>
  `<td width="25%" style="font-family:${EMAIL_FONT_STACK};padding:10px 8px;vertical-align:top">
     <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${escapeHtml(label)}</div>
     <div style="font-size:18px;font-weight:700;color:${INK};margin-top:2px">${escapeHtml(value)}</div>
   </td>`;

const kpiTable = (report: DailyLifecycleReport) => {
  const s = report.summary;
  const cells = [
    kpiCell("Providers checked", `${s.providersChecked} / ${s.providersTotal}`),
    kpiCell("Failed / skipped", String(s.providersFailed)),
    kpiCell("New today", String(s.newToday)),
    kpiCell("Awaiting review", String(s.awaitingReview)),
    kpiCell("Approved, not shipped", String(s.approvedNotShipped)),
    kpiCell("Lifecycle warnings", String(s.lifecycleWarnings)),
    kpiCell("Auto-disabled", String(s.autoDisabled)),
    kpiCell("Held (provider-wide)", String(s.held)),
  ];
  const rows: string[] = [];
  for (let index = 0; index < cells.length; index += 4) {
    rows.push(`<tr>${cells.slice(index, index + 4).join("")}</tr>`);
  }
  return `<tr><td style="padding:8px 16px;border-top:1px solid ${HAIRLINE};border-bottom:1px solid ${HAIRLINE}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kpi">${rows.join("")}</table>
  </td></tr>`;
};

const simpleSection = <Row>(
  title: string,
  data: ReportList<Row>,
  render: (row: Row) => string,
  url: string
) => {
  if (!data.total) return "";
  return (
    sectionHeading(title, data.total) +
    data.rows.map(render).join("") +
    overflowRow(data.hidden, data.total, url)
  );
};

const providerTable = (report: DailyLifecycleReport) => {
  const head = `<tr>
    <td style="font-family:${EMAIL_FONT_STACK};font-size:11px;color:${MUTED};padding:4px 24px;text-transform:uppercase;letter-spacing:.06em">Provider</td>
    <td style="font-family:${EMAIL_FONT_STACK};font-size:11px;color:${MUTED};padding:4px 8px;text-transform:uppercase;letter-spacing:.06em">Result</td>
    <td style="font-family:${EMAIL_FONT_STACK};font-size:11px;color:${MUTED};padding:4px 8px;text-transform:uppercase;letter-spacing:.06em">Last success</td>
    <td style="font-family:${EMAIL_FONT_STACK};font-size:11px;color:${MUTED};padding:4px 24px 4px 8px;text-transform:uppercase;letter-spacing:.06em">Models</td>
  </tr>`;
  const rows = report.providers
    .map((provider) => {
      const failed = provider.status !== "checked";
      const result = failed
        ? `${escapeHtml(provider.status)}${provider.errorCode ? ` (${escapeHtml(provider.errorCode)})` : ""}`
        : "ok";
      const note = provider.note
        ? `<div style="color:${MUTED};font-size:12px">${escapeHtml(provider.note)}</div>`
        : "";
      return `<tr>
        <td style="font-family:${EMAIL_FONT_STACK};font-size:13px;color:${INK};padding:3px 24px">${escapeHtml(provider.displayName)}${note}</td>
        <td style="font-family:${EMAIL_FONT_STACK};font-size:13px;color:${failed ? CRITICAL : OK};padding:3px 8px">${result}</td>
        <td style="font-family:${EMAIL_FONT_STACK};font-size:13px;color:${MUTED};padding:3px 8px">${escapeHtml(provider.lastSuccessLabel || "—")}</td>
        <td style="font-family:${EMAIL_FONT_STACK};font-size:13px;color:${MUTED};padding:3px 24px 3px 8px">${provider.modelCount === null ? "—" : provider.modelCount}</td>
      </tr>`;
    })
    .join("");
  return (
    sectionHeading("Provider coverage") +
    `<tr><td style="padding:0"><div style="overflow-x:auto"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${head}${rows}</table></div></td></tr>`
  );
};

const renderHtml = (report: DailyLifecycleReport) => {
  const banner = report.allClear
    ? `<tr>${cell(
        `<span style="color:${OK};font-weight:700">All clear &mdash; nothing waiting</span>`,
        "padding:14px 24px"
      )}</tr>`
    : `<tr>${cell(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
           <td width="4" bgcolor="${CRITICAL}" style="width:4px;font-size:0;line-height:0">&nbsp;</td>
           ${cell(
             `<span style="font-weight:700">ACTION REQUIRED &mdash; ${report.actionCount} item${report.actionCount === 1 ? "" : "s"}</span>
              <span style="float:right"><a href="${escapeHtml(report.workQueueUrl)}" style="color:#1d4ed8;text-decoration:underline">Open work queue &rarr;</a></span>`,
             "padding:12px 16px"
           )}
         </tr></table>`,
        "padding:12px 24px 0"
      )}</tr>`;

  // Sections 3-7 do not render on a quiet day: a report that is the same length
  // whether or not anything happened is a report that stops being read.
  const detail = report.allClear
    ? ""
    : [
        report.actionRequired.total
          ? sectionHeading("Action required", report.actionRequired.total) +
            report.actionRequired.rows
              .map((item) => actionCard(item, `${report.workQueueUrl}&item=${item.id}`))
              .join("") +
            overflowRow(
              report.actionRequired.hidden,
              report.actionRequired.total,
              report.workQueueUrl
            )
          : "",
        report.pendingDigest
          ? sectionHeading("Awaiting decision", report.summary.awaitingReview) +
            report.pendingDigest
              .map(
                (row) =>
                  `<tr>${cell(
                    `${escapeHtml(row.displayName)} &nbsp; ${row.count}`,
                    "padding:3px 24px;font-size:13px"
                  )}</tr>`
              )
              .join("") +
            `<tr>${cell(
              `<a href="${escapeHtml(report.workQueueUrl)}" style="color:${MUTED};text-decoration:underline">${report.summary.awaitingReview} awaiting review &middot; open work queue &rarr;</a>`,
              `padding:6px 24px;font-size:13px;color:${MUTED}`
            )}</tr>`
          : simpleSection("New today", report.newToday, compactRow, report.workQueueUrl) +
            simpleSection("Pending", report.pending, compactRow, report.workQueueUrl),
        simpleSection(
          "Approved — awaiting implementation",
          report.inFlight,
          (item) =>
            `<tr>${cell(
              `<span style="color:${MUTED};display:inline-block;min-width:44px">${escapeHtml(item.action)}</span> ${escapeHtml(item.provider)} &nbsp; ${mono(item.apiModel)}<div style="color:${MUTED};font-size:12px;margin-left:44px">${escapeHtml(item.status)}${item.pendingValidations.length ? ` &middot; pending: ${escapeHtml(item.pendingValidations.join(", "))}` : ""}</div>`,
              "padding:3px 24px;font-size:13px"
            )}</tr>`,
          report.workQueueUrl
        ),
        simpleSection(
          "Lifecycle risks",
          report.lifecycleWarnings,
          (row) =>
            `<tr>${cell(
              `${escapeHtml(row.displayName)} &nbsp; ${mono(row.apiModel)} &nbsp; <span style="color:${MUTED}">${escapeHtml(row.lifecycle)}</span>`,
              "padding:3px 24px;font-size:13px"
            )}</tr>`,
          report.workQueueUrl
        ),
        simpleSection(
          "Missing from successful provider catalogues",
          report.missing,
          (row) =>
            `<tr>${cell(
              `${escapeHtml(row.displayName)} &nbsp; ${mono(row.apiModel)} &nbsp; <span style="color:${MUTED}">missed &times;${row.consecutiveMissing}</span>`,
              "padding:3px 24px;font-size:13px"
            )}</tr>`,
          report.workQueueUrl
        ),
        simpleSection(
          "Registry auto-updates",
          report.registryChanges,
          (row) =>
            `<tr>${cell(
              `<span style="color:${MUTED};display:inline-block;min-width:72px">${escapeHtml(row.kind)}</span> ${escapeHtml(row.displayName)} &nbsp; ${mono(row.apiModel)}<div style="color:${MUTED};font-size:12px;margin-left:72px">${escapeHtml(row.detail)}</div>`,
              "padding:3px 24px;font-size:13px"
            )}</tr>`,
          report.workQueueUrl
        ),
        report.changes
          ? sectionHeading("Changes since yesterday") +
            `<tr>${cell(
              `discovered ${report.changes.discovered} &middot; decided ${report.changes.decided} &middot; transitions ${report.changes.transitions} &middot; completed ${report.changes.completed}`,
              "padding:3px 24px;font-size:13px"
            )}</tr>`
          : "",
      ].join("");

  const footnote = `A model absent from one successful scan is not deprecated. Consecutive misses are reported separately because access permissions and catalogue behaviour also cause absence. Scope: chat models only; image generation models are a static catalogue and are not scanned.`;

  return `<!-- ${escapeHtml(report.subject)} -->
<style>@media only screen and (max-width:600px){.kpi td{display:block;width:100%!important}}</style>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background-color:${CANVAS};margin:0;padding:0">
  <tr><td align="center" style="padding:16px 8px">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:640px;max-width:100%;background-color:#ffffff;border:1px solid ${HAIRLINE};border-radius:8px">
      <tr>${cell(
        `<span style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${MUTED}">Tomverse &middot; Model lifecycle</span>
         <span style="float:right;font-size:12px;color:${MUTED}">${escapeHtml(report.localDate)}</span>`,
        `padding:18px 24px 10px;border-bottom:1px solid ${HAIRLINE}`
      )}</tr>
      ${banner}
      ${kpiTable(report)}
      ${detail}
      ${providerTable(report)}
      <tr>${cell(
        `${footnote}<br>Generated ${escapeHtml(report.generatedLabel)}`,
        `padding:16px 24px 20px;border-top:1px solid ${HAIRLINE};font-size:12px;color:${MUTED}`
      )}</tr>
    </table>
  </td></tr>
</table>`;
};

const textList = <Row>(
  title: string,
  data: ReportList<Row>,
  render: (row: Row) => string,
  url: string
) => {
  if (!data.total) return "";
  const lines = [`${title.toUpperCase()} (${data.total})`, ...data.rows.map(render)];
  if (data.hidden > 0) lines.push(`  ${data.hidden} more of ${data.total} - ${url}`);
  return `${lines.join("\n")}\n\n`;
};

const renderText = (report: DailyLifecycleReport) => {
  const s = report.summary;
  const head = [
    `TOMVERSE MODEL LIFECYCLE - ${report.localDate}`,
    report.allClear ? "ALL CLEAR - nothing waiting" : `ACTION REQUIRED: ${report.actionCount}`,
    "",
    "SUMMARY",
    `  providers checked ${s.providersChecked}/${s.providersTotal} | failed ${s.providersFailed} | new today ${s.newToday}`,
    `  awaiting review ${s.awaitingReview} | approved not shipped ${s.approvedNotShipped}`,
    `  lifecycle warnings ${s.lifecycleWarnings} | auto-disabled ${s.autoDisabled} | held ${s.held}`,
    "",
  ].join("\n");

  const detail = report.allClear
    ? ""
    : [
        textList(
          "Action required",
          report.actionRequired,
          (item) =>
            [
              `  [${severityLabel(item.severity)}] ${item.action} | ${item.provider} | ${item.apiModel}`,
              `    first seen ${item.newToday ? "today" : `${item.ageDays} days ago`} | owner: ${item.ownerEmail || "unassigned"}${item.dueAt ? ` | due ${item.dueAt.slice(0, 10)}` : ""}`,
              item.blockers.length ? `    blocker: ${item.blockers.join("; ")}` : "",
              item.pendingValidations.length
                ? `    pending: ${item.pendingValidations.join(", ")}`
                : "",
              item.recommendation ? `    next: ${item.recommendation}` : "",
              `    ${report.workQueueUrl}&item=${item.id}`,
            ]
              .filter(Boolean)
              .join("\n"),
          report.workQueueUrl
        ),
        report.pendingDigest
          ? `AWAITING DECISION (${s.awaitingReview})\n${report.pendingDigest
              .map((row) => `  ${row.displayName} ${row.count}`)
              .join("\n")}\n  ${report.workQueueUrl}\n\n`
          : textList(
              "New today",
              report.newToday,
              (item) => `  ${item.provider} | ${item.apiModel}`,
              report.workQueueUrl
            ) +
            textList(
              "Pending",
              report.pending,
              (item) => `  ${item.ageDays}d | ${item.provider} | ${item.apiModel}`,
              report.workQueueUrl
            ),
        textList(
          "Approved - awaiting implementation",
          report.inFlight,
          (item) =>
            `  ${item.action} | ${item.provider} | ${item.apiModel} | ${item.status}${item.pendingValidations.length ? ` | pending: ${item.pendingValidations.join(", ")}` : ""}`,
          report.workQueueUrl
        ),
        textList(
          "Lifecycle risks",
          report.lifecycleWarnings,
          (row) => `  ${row.displayName} | ${row.apiModel} | ${row.lifecycle}`,
          report.workQueueUrl
        ),
        textList(
          "Missing from successful provider catalogues",
          report.missing,
          (row) => `  ${row.displayName} | ${row.apiModel} | missed x${row.consecutiveMissing}`,
          report.workQueueUrl
        ),
        textList(
          "Registry auto-updates",
          report.registryChanges,
          (row) => `  ${row.kind} | ${row.displayName} | ${row.apiModel} | ${row.detail}`,
          report.workQueueUrl
        ),
        report.changes
          ? `CHANGES SINCE YESTERDAY\n  discovered ${report.changes.discovered} | decided ${report.changes.decided} | transitions ${report.changes.transitions} | completed ${report.changes.completed}\n\n`
          : "",
      ].join("");

  const providers = [
    "PROVIDER COVERAGE",
    ...report.providers.map(
      (provider) =>
        `  ${provider.displayName} | ${provider.status === "checked" ? "ok" : `${provider.status}${provider.errorCode ? ` (${provider.errorCode})` : ""}`} | last success ${provider.lastSuccessLabel || "-"} | models ${provider.modelCount ?? "-"}${provider.note ? ` | ${provider.note}` : ""}`
    ),
    "",
  ].join("\n");

  return `${head}${detail}${providers}
A model absent from one successful scan is not deprecated. Consecutive misses are reported separately because access permissions and catalogue behaviour also cause absence. Scope: chat models only; image generation models are a static catalogue and are not scanned.
Generated ${report.generatedLabel}
`;
};

export function buildModelLifecycleDailyEmail(payload: LifecycleReportInput) {
  const report = buildDailyLifecycleReport(payload);
  return {
    subject: report.subject,
    html: renderHtml(report),
    text: renderText(report),
  };
}
