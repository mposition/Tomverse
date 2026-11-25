import type { Language } from "../../../../lib/language";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopTaskListCopy } from "../../../../locales/desktopTaskList";
import type { CodeApiModelObservation, CodeTaskPlan, Model, RunStatus, Task } from "../contract";
import { providerClis } from "../code-execution";
import lightCheck from "./task-list-icons/light-check.svg?no-inline";
import lightCircle from "./task-list-icons/light-circle.svg?no-inline";
import darkCheck from "./task-list-icons/dark-check.svg?no-inline";
import darkCircle from "./task-list-icons/dark-circle.svg?no-inline";

type Row = CodeTaskPlan["items"][number];
type Assignment = NonNullable<Row["evidence"][number]["assignment"]>;
type RowStatus = "completed" | "cancelled" | "approval" | "unconfirmed" | "running" | "blocked" | "pending";

function rowStatus(row: Row, activeId: CodeTaskPlan["activeId"], run: RunStatus,
  last: Row["evidence"][number] | undefined, waitingForNativeApproval: boolean, proposalOnly?: true): RowStatus {
  if (row.complete) return "completed";
  if (row.cancelled || run === "stopped") return "cancelled";
  if (proposalOnly) return "pending";
  if (row.evidence.some((entry) => entry.state === "unconfirmed") ||
      run === "unknown" && (last?.state === "approval" || last?.state === "running" || row.id === activeId)) return "unconfirmed";
  if (last?.state === "approval" || waitingForNativeApproval) return "approval";
  if (row.completionUnverified || last?.state === "failed" || last?.state === "denied") return "blocked";
  if (row.id === activeId && (run === "running" || run === "approval" || run === "stopping")) return "running";
  if (!last) return "pending";
  return "blocked";
}

export function TaskList({ plan, run, taskId, effort, models, language, pendingNativeApproval }: {
  plan: CodeTaskPlan; run: RunStatus; taskId: Task["id"]; effort: Task["effort"]; models: Model[]; language: Language;
  pendingNativeApproval?: Task["pendingNativeApproval"];
}) {
  const copy = desktopTaskListCopy(language);
  const shell = desktopShellCopy[language];
  const modelName = (id: string) => models.find((model) => model.id === id)?.name ?? id;
  const modelLabel = (assignment: Assignment) =>
    "threadId" in assignment ? assignment.model : modelName(assignment.model);
  const levels = { default: shell.defaultEffort, low: shell.lowEffort, high: shell.highEffort };
  const sources = { api_header: copy.apiHeader, api_receipt: copy.apiReceipt,
    codex_reroute: "Codex model/rerouted", claude_assistant: "Claude Code assistant" };
  const execution = (assignment: Assignment | undefined, record?: CodeApiModelObservation) => {
    const native = assignment && "threadId" in assignment ? assignment : undefined;
    const reported = native?.reportedModel ?? record?.reportedModel;
    return <>
      {assignment && <>{modelLabel(assignment)}{native
        ? <> · {providerClis[native.provider ?? "openai"]} · <code>{native.threadId} / {native.turnId}</code></>
        : "requestSeq" in assignment && ` · #${assignment.requestSeq}`} · </>}
      {reported ? <>{copy.actualModel} {"previousModel" in reported && reported.previousModel && `${reported.previousModel} → `}
        {native ? reported.model : modelName(reported.model)} ({sources[reported.source]})</> : copy.unknownModel}
      {record?.appliedEffort ? ` · ${shell.appliedEffort.replace("{effort}", levels[record.appliedEffort])}` : ` · ${copy.effortUnknown}`}
    </>;
  };
  const progress = copy.progress.replace("{done}", plan.items.filter((row) => row.complete).length.toLocaleString(language))
    .replace("{total}", plan.items.length.toLocaleString(language));
  const labels: Record<RowStatus, string> = {
    completed: shell.completed, cancelled: shell.stopped, approval: shell.approval, unconfirmed: shell.unconfirmed,
    running: shell.running, blocked: copy.incomplete, pending: copy.pending,
  };
  const toolStates = {
    succeeded: shell.completed, running: shell.running, approval: shell.approval,
    unconfirmed: shell.unconfirmed, failed: shell.failed, denied: shell.stopped,
  };
  const waitingForApproval = (entry: Row["evidence"][number]) => run === "approval" && !!pendingNativeApproval &&
    entry.state === "running" && entry.nativeItemId === pendingNativeApproval.callId &&
    entry.assignment && "turnId" in entry.assignment && entry.assignment.turnId === pendingNativeApproval.turnId;
  return <details className="code-task-list" open>
    <summary><span>{copy.title}</span><small aria-live="polite">{progress}</small></summary>
    <ol>
      {plan.items.map((row) => {
        const evidence = plan.proposalOnly ? [] : row.evidence;
        const nativeAssignment = plan.proposalOnly ? undefined : row.nativeAssignment;
        const apiAssignment = plan.proposalOnly ? undefined : row.apiAssignment;
        const currentEvidence = evidence.slice(row.evidenceStart ?? 0);
        const latest = currentEvidence.at(-1);
        const status = rowStatus(row, plan.activeId, run, latest, currentEvidence.some(waitingForApproval), plan.proposalOnly);
        const assignment = nativeAssignment ?? apiAssignment?.assignment ?? latest?.assignment;
        const segmentId = row.segmentId ?? (assignment && "threadId" in assignment ? assignment.threadId : undefined);
        const lastReported = latest?.assignment && "threadId" in latest.assignment ? latest.assignment.reportedModel : undefined;
        const model = assignment ? modelLabel(assignment) : latest || row.completionUnverified ? copy.unknownModel : copy.assigning;
        const contents = <>
          <span className="code-task-list-icon" role="img" aria-label={labels[status]}>
            <img className="light-icon" src={row.complete ? lightCheck : lightCircle} alt="" width={14} height={14} />
            <img className="dark-icon" src={row.complete ? darkCheck : darkCircle} alt="" width={24} height={24} />
          </span>
          <span className="code-task-list-title">{row.title}</span>
          <span className="code-task-list-model">{model}</span>
          {(status === "approval" || status === "blocked" || status === "unconfirmed") && <span className="code-task-list-reason">{labels[status]}</span>}
        </>;
        return <li key={row.id} className="code-task-list-item" data-status={status}>
          {evidence.length || nativeAssignment || apiAssignment ? <details>
            <summary className="code-task-list-row" aria-label={`${row.title} · ${labels[status]} · ${model} · ${copy.details}`}>{contents}</summary>
            <ul className="code-task-list-evidence">
              <li>{taskId && <>{copy.task} <code>{taskId}</code> · </>}
                {segmentId && <>{copy.segment} <code>{segmentId}</code>{effort && " · "}</>}
                {effort && shell.requestedEffort.replace("{effort}", levels[effort])}</li>
              {nativeAssignment && (!latest || nativeAssignment.reportedModel?.model !== lastReported?.model) &&
                <li>{execution(nativeAssignment)}</li>}
              {apiAssignment && <li>{execution(apiAssignment.assignment, apiAssignment)}</li>}
              {evidence.map((entry, index) => <li key={index}>
                {entry.tool} · {waitingForApproval(entry) ? shell.approval : toolStates[entry.state]} · {execution(entry.assignment, entry)}
              </li>)}
            </ul>
          </details> : <div className="code-task-list-row">{contents}</div>}
        </li>;
      })}
    </ol>
  </details>;
}
