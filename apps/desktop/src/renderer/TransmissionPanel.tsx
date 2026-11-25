import type { Language } from "../../../../lib/language";
import { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopCodeQuotaCopy } from "../../../../locales/desktopCodeQuota";
import { desktopCodeUsageCopy } from "../../../../locales/desktopCodeUsage";
import { desktopTaskListCopy } from "../../../../locales/desktopTaskList";
import { providerClis } from "../code-execution";
import type { CodeApiUsage, CodeNativeRunEvidence, Task, Transmission } from "../contract";
import { formatEvidence } from "./evidence-copy";
import { effortLabel } from "./CodeEngine";

export function TransmissionPanel({ records, usage, taskId, language }: {
  records: Transmission[]; usage: CodeApiUsage; taskId: Task["id"]; language: Language;
}) {
  const copy = desktopEvidenceCopy[language];
  const ids = desktopTaskListCopy(language);
  const quota = desktopCodeQuotaCopy[language];
  const shell = desktopShellCopy[language];
  const states: Record<string, string> = {
    intent: copy.intent, headers: copy.headers, complete: copy.complete, interrupted: copy.interrupted, failed: shell.failed,
  };
  const labelEffort = (effort: string) => language === "en" ? effort : effortLabel(language, effort);
  return <details><summary>{formatEvidence(copy.apiRequests, language, { count: usage.requestCount })}</summary>
    <p>{copy.viaApi}</p>
    <p>{taskId && <>{ids.task} <code>{taskId}</code> · </>}{ids.segment} <code>{records[0]?.segmentId}</code></p>
    <p>{formatEvidence(copy.creditSummary, language, usage)}</p>
    {usage.requestCount > records.length && <p>{formatEvidence(desktopCodeUsageCopy(language).recentRequests, language, { count: records.length })}</p>}
    <ul>{records.map((record) => <li key={record.seq}>
      {formatEvidence(copy.request, language, { count: record.seq })} · {record.purpose === "compact" ? copy.compact : record.purpose === "goal" ? desktopCodeEngineCopy[language].goalRequest : copy.codeTurn}
      {` · ${Object.hasOwn(states, record.state) ? states[record.state] : record.state}`}
      {record.contents?.model && ` · ${formatEvidence(copy.requestedModel, language, { model: record.contents.model })}`}
      {record.model && ` · ${formatEvidence(copy.reportedModel, language, { model: record.model })}`}
      {record.catalogProvider && ` · ${formatEvidence(copy.catalogProvider, language, { provider: record.catalogProvider })}`}
      {record.contents?.effort && ` · ${formatEvidence(copy.sentEffort, language, { effort: labelEffort(record.contents.effort) })}`}
      {record.appliedEffort && ` · ${formatEvidence(copy.appliedEffort, language, { effort: labelEffort(record.appliedEffort) })}`}
      {record.httpStatus !== undefined && ` · HTTP ${record.httpStatus}`}
      {record.requestId && <> · <code>{record.requestId}</code></>}
      {record.receipt.status === "unknown" ? ` · ${copy.receiptUnconfirmed}`
        : ` · ${copy[record.receipt.status]} (${formatEvidence(copy.credits, language, { credits: record.receipt.credits })})`}
      {record.receiptNotFound && ` · ${copy.receiptNotFound}`}
      {record.quota && <p>{quota[record.quota.reason]}</p>}
      {record.contents && <ul>
        <li>{formatEvidence(copy.payload, language, { messages: record.contents.messageCount, results: record.contents.toolResultCount })}</li>
        {record.contents.commandOutput && <li>{formatEvidence(copy.outputs, language, { count: record.contents.commandOutput.results })}
          {record.contents.commandOutput.truncated > 0 && ` · ${formatEvidence(copy.truncatedCount, language, { count: record.contents.commandOutput.truncated })}`}</li>}
        {record.contents.projectInstructions && <li>{copy.projectInstructions}{record.contents.projectInstructionsTruncated && ` · ${copy.truncated}`}</li>}
        {!!record.contents.listedPathCount && <li>{formatEvidence(copy.listings, language, { count: record.contents.listedPathCount })}</li>}
        {!!record.contents.truncatedListingCount && <li>{formatEvidence(copy.truncatedListings, language, { count: record.contents.truncatedListingCount })}</li>}
        {record.contents.fileReads.map((file, index) => <li key={index}>{formatEvidence(copy.fileRead, language, { path: file.path })}
          {file.truncated && ` · ${copy.truncated}`}</li>)}
        {record.contents.webReads?.map((page, index) => <li key={`web-${index}`}>{desktopCodeEngineCopy[language].webRead.replace("{url}", page.url)}
          {page.truncated && ` · ${copy.truncated}`}</li>)}
        {!!record.contents.imageCount && <li>{desktopCodeEngineCopy[language].imagesSent.replace("{count}", String(record.contents.imageCount))}</li>}
        {!!record.contents.moreWebReads && <li>{desktopCodeEngineCopy[language].webReadMore.replace("{count}", String(record.contents.moreWebReads))}</li>}
        {record.contents.moreFileReads > 0 && <li>{formatEvidence(copy.moreFileReads, language, { count: record.contents.moreFileReads })}</li>}
      </ul>}
    </li>)}</ul>
  </details>;
}

export function NativeUsagePanel({ runs, taskId, segmentId, language }: {
  runs: CodeNativeRunEvidence[]; taskId: Task["id"]; segmentId: string; language: Language;
}) {
  const copy = desktopCodeUsageCopy(language);
  const ids = desktopTaskListCopy(language);
  const quotaCopy = desktopCodeQuotaCopy[language];
  const cli = providerClis[runs[0]?.session.provider ?? "openai"];
  return <details>
    <summary>{copy.providerUsage} · {cli}</summary>
    <p>{taskId && <>{ids.task} <code>{taskId}</code> · </>}{ids.segment} <code>{segmentId}</code></p>
    <p>{copy.billingUnknown} · {quotaCopy.overageUnknown}</p>
    <ul>{runs.map(({ session, usage, quota }) => <li key={session.turnId}>
      {session.model} · <code>{session.threadId} / {session.turnId}</code>
      {session.reportedModel && session.reportedModel.model !== session.model && ` · ${ids.actualModel} ${session.reportedModel.model}`}
      <p>{usage?.source === "codex_thread" ? formatEvidence(copy.threadTokens, language, { total: usage.totalTokens })
        : usage?.source === "qwen_requests" ? formatEvidence(copy.requestTokens, language, {
          reported: usage.requests.length, requests: usage.requestCount,
          input: usage.requests.reduce((total, request) => total + request.inputTokens, 0),
          output: usage.requests.reduce((total, request) => total + request.outputTokens, 0),
        })
        : usage?.source === "zcode_turn" ? formatEvidence(copy.reportedRequests, language, {
          reported: usage.reportedRequests, input: usage.inputTokens, output: usage.outputTokens,
        })
        : usage ? <>
          {formatEvidence(usage.source === "vibe_session" ? copy.sessionTokens : copy.turnTokens, language, {
            input: usage.inputTokens, output: usage.outputTokens,
          })}
          {usage.source === "claude_turn" && <>
            {usage.cacheReadTokens !== undefined && ` · ${formatEvidence(copy.cacheRead, language, { tokens: usage.cacheReadTokens })}`}
            {usage.cacheWriteTokens !== undefined && ` · ${formatEvidence(copy.cacheWrite, language, { tokens: usage.cacheWriteTokens })}`}
          </>}
        </> : copy.usageUnknown}</p>
      {quota && <p>{quotaCopy[quota.reason]}</p>}
    </li>)}</ul>
  </details>;
}
