import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopOrchestrateCopy } from "../../../../locales/desktopOrchestrate";
import type { ApprovalRequest, Task } from "../contract";
import type { CodeSubtask } from "../orchestrate-contract";
import "./code-orchestration.css";

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);

const isActive = (subtask: CodeSubtask) => subtask.state === "queued" || subtask.state === "running" || subtask.state === "verifying";

/**
 * What the subagents of an orchestrated task are doing: each subtask with its state, its newest step, the files it changed and how its
 * result was checked. One subtask can be stopped, or all of them; the main task goes on either way.
 */
export function OrchestrationPanel({ task, language, live }: { task: Task; language: Language; live: boolean }) {
  const copy = desktopOrchestrateCopy[language];
  const [failed, setFailed] = useState(false);
  const orchestration = task.orchestration;
  if (!orchestration?.subtasks.length || !task.id) return null;
  const taskId = task.id;
  const subtasks = orchestration.subtasks;
  const heading = fill(copy.heading, { count: subtasks.length });
  const label = (subtask: CodeSubtask) => copy[subtask.state];
  const verdict = (subtask: CodeSubtask) => {
    const state = subtask.verification?.state;
    return state === "passed" ? copy.verdictPassed : state === "failed" ? copy.verdictFailed : state === "unverified" ? copy.verdictUnverified : state === "skipped" ? copy.verdictSkipped : null;
  };
  async function stop(subtask?: string) {
    try { setFailed(!await window.desktop.stopSubagents(taskId, subtask)); }
    catch { setFailed(true); }
  }
  const running = subtasks.some(isActive);
  return <section className="code-orchestration" aria-label={heading}>
    <div className="code-orchestration-heading">
      <strong>{heading}</strong>
      {live && running && <button className="soft" type="button" onClick={() => void stop()}>{copy.stopAll}</button>}
    </div>
    <small>{fill(copy.limits, { agents: orchestration.maxSubagents, requests: orchestration.maxRequests, used: orchestration.used })}</small>
    <small>{copy.hint}</small>
    <ul>{subtasks.map((subtask) => <li key={subtask.id} data-subtask-state={subtask.state}>
      <div>
        <strong>{subtask.title}</strong>
        <span>{subtask.kind === "worker" ? copy.kindWorker : copy.kindExplore}</span>
        <span role="status">{label(subtask)}</span>
        {subtask.attempts > 1 && <small>{fill(copy.attempt, { count: subtask.attempts })}</small>}
        <small>{fill(copy.requests, { count: subtask.requests })}</small>
        {live && isActive(subtask) && <button className="soft" type="button" aria-label={fill(copy.stopOneFor, { title: subtask.title })}
          onClick={() => void stop(subtask.id)}>{copy.stopOne}</button>}
      </div>
      {subtask.paths?.length ? <small>{fill(copy.scope, { paths: subtask.paths.join(", ") })}</small> : null}
      {isActive(subtask) && subtask.activity && <small className="code-orchestration-activity">{subtask.activity}</small>}
      {subtask.filesChanged?.length ? <small>{fill(copy.changed, { files: subtask.filesChanged.join(", ") })}</small> : null}
      {verdict(subtask) && <small className="code-orchestration-verdict" data-verdict={subtask.verification?.state}>
        <strong>{verdict(subtask)}</strong>{subtask.verification?.reason && subtask.verification.state !== "skipped" ? ` · ${subtask.verification.reason}` : ""}
      </small>}
      {subtask.reason && subtask.state !== "success" && <small>{subtask.reason}</small>}
    </li>)}</ul>
    {failed && <small role="alert">{copy.stopFailed}</small>}
  </section>;
}

/** Which subagent a change or command in the approval window comes from. */
export function ApprovalOrigin({ origin, language }: { origin: NonNullable<ApprovalRequest["origin"]>; language: Language }) {
  return <p role="note" data-origin={origin.id}>{fill(desktopOrchestrateCopy[language].requestedBy, { title: origin.title })}</p>;
}
