import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCloudExecutionCopy, type DesktopCloudExecutionCopy } from "../../../../locales/desktopCloudExecution";
import { desktopManagedCodeCopy } from "../../../../locales/desktopManagedCode";
import {
  CLOUD_INSTRUCTION_MAX, cloudFailureFor, cloudJobActive, emptyCloudExecutionView,
  type CloudExecutionView, type CloudJobItem, type CloudReview, type DesktopCloudExecutionInput,
} from "../cloud-execution-contract";
import { MANAGED_MAX_APPROVED_CREDITS } from "../managed-code-contract";

type Copy = DesktopCloudExecutionCopy;
const POLL_MS = 3_000;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{([a-z]+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

function statusText(copy: Copy, job: CloudJobItem) {
  if (job.cancelRequested && cloudJobActive(job.status)) return copy.stopping;
  return { uploading: copy.statusUploading, queued: copy.statusQueued, starting: copy.statusStarting, running: copy.statusRunning,
    completed: copy.statusCompleted, failed: copy.statusFailed, cancelled: copy.statusCancelled }[job.status];
}

function failureText(copy: Copy, language: Language, code: string | null) {
  const failure = cloudFailureFor(code);
  if (!failure) return null;
  return failure.kind === "managed" ? desktopManagedCodeCopy[language].refusal[failure.refusal] : copy.failure[failure.reason];
}

function Job({ copy, language, job, busy, run }: { copy: Copy; language: Language; job: CloudJobItem; busy: boolean; run: (input: DesktopCloudExecutionInput) => void }) {
  const failure = job.status === "failed" ? failureText(copy, language, job.failureCode) : null;
  return <li className="cloud-job" data-testid="cloud-job" data-status={job.status}>
    <div><strong>{job.instruction.split("\n")[0]!.slice(0, 120)}</strong> <span data-testid="cloud-job-status">{statusText(copy, job)}</span></div>
    {job.billing && <small data-testid="cloud-job-credits">{fill(copy.creditsLine, { settled: job.billing.settledCredits, reserved: job.billing.reservedCredits, returned: job.billing.releasedCredits })}</small>}
    {failure && <p role="status" data-testid="cloud-job-failure" data-code={job.failureCode ?? ""}>{failure}</p>}
    {job.summary && <p data-testid="cloud-job-summary">{job.summary}</p>}
    {job.logs.length > 0 && <pre className="cloud-job-log" data-testid="cloud-job-log">{job.logs.slice(-12).map((line) => line.text).join("\n")}</pre>}
    <div className="managed-actions">
      {cloudJobActive(job.status) && !job.cancelRequested && <button className="soft" type="button" disabled={busy} data-testid="cloud-job-stop"
        onClick={() => run({ action: "cancel", jobId: job.jobId })}>{copy.stop}</button>}
      {job.status === "completed" && (job.patchBytes
        ? <button className="soft" type="button" disabled={busy} data-testid="cloud-job-review" onClick={() => run({ action: "review", jobId: job.jobId })}>{copy.reviewChanges}</button>
        : <small>{copy.noChanges}</small>)}
    </div>
  </li>;
}

function Review({ copy, review, busy, run }: { copy: Copy; review: CloudReview; busy: boolean; run: (input: DesktopCloudExecutionInput) => void }) {
  const [confirming, setConfirming] = useState(false);
  return <div className="cloud-review" data-testid="cloud-review" role="group" aria-label={copy.reviewHeading}>
    <h4>{copy.reviewHeading}</h4>
    <p role="status" data-testid="cloud-review-applies" data-applies={String(review.applies)}>{review.applies ? copy.applies : copy.conflicts}</p>
    {review.files.map((file) => <details key={file.id} className="cloud-review-file" data-testid="cloud-review-file" open={review.files.length <= 3}>
      <summary><code>{file.path}</code> <small>+{file.added} −{file.removed}</small></summary>
      {file.omitted ? <small>{file.omitted === "binary" ? copy.omittedBinary : file.omitted === "large" ? copy.omittedLarge : copy.omittedOther}</small>
        : <pre className="cloud-review-hunks">{file.hunks.map((hunk) => [hunk.header, ...hunk.lines.map((line) =>
          (line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ") + line.text)].join("\n")).join("\n")}</pre>}
    </details>)}
    {review.truncated && <small>{copy.truncated}</small>}
    <div className="managed-actions">
      {!confirming && review.applies && <button className="soft" type="button" disabled={busy} data-testid="cloud-review-apply" onClick={() => setConfirming(true)}>{copy.apply}</button>}
      {confirming && <>
        <p>{copy.applyConfirm}</p>
        <button className="soft" type="button" disabled={busy} data-testid="cloud-review-apply-confirm" onClick={() => { setConfirming(false); run({ action: "apply", jobId: review.jobId }); }}>{copy.applyYes}</button>
        <button className="soft" type="button" disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</button>
      </>}
      <button className="soft" type="button" disabled={busy} onClick={() => run({ action: "closeReview" })}>{copy.close}</button>
    </div>
  </div>;
}

function StartForm({ copy, language, view, busy, run }: { copy: Copy; language: Language; view: CloudExecutionView; busy: boolean; run: (input: DesktopCloudExecutionInput) => void }) {
  const models = view.catalog?.models ?? [];
  const [instruction, setInstruction] = useState("");
  const [executorId, setExecutorId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const executor = models.find((model) => model.id === executorId);
  const reviewer = models.find((model) => model.id === reviewerId);
  const credits = /^\d{1,7}$/.test(amount) ? Number(amount) : 0;
  const ready = instruction.trim().length > 0 && !!executor && !!reviewer && executor.provider !== reviewer.provider && credits > 0 && credits <= MANAGED_MAX_APPROVED_CREDITS;
  if (!("name" in view.project)) return <p role="status" data-testid="cloud-project-unavailable">{copy[view.project.unavailable]}</p>;
  if (!view.catalog) return <p role="status">{copy.readingModels}</p>;
  if (!models.length) return <p>{copy.noModels}</p>;
  const project = view.project.name;
  const options = <>
    <option value="">{desktopManagedCodeCopy[language].chooseModel}</option>
    {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
  </>;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) setConfirming(true);
  }
  const change = (set: (value: string) => void) => (event: { currentTarget: { value: string } }) => { set(event.currentTarget.value); setConfirming(false); };
  return <form className="managed-form" onSubmit={submit} data-testid="cloud-form">
    <p data-testid="cloud-project">{fill(copy.project, { name: project })}</p>
    <div><label htmlFor="cloud-instruction">{copy.instruction}</label>
      <textarea id="cloud-instruction" rows={3} maxLength={CLOUD_INSTRUCTION_MAX} value={instruction} disabled={busy || confirming} onChange={change(setInstruction)} /></div>
    <div><label htmlFor="cloud-executor">{copy.executor}</label>
      <select id="cloud-executor" value={executorId} disabled={busy || confirming} onChange={change(setExecutorId)}>{options}</select></div>
    <div><label htmlFor="cloud-reviewer">{copy.reviewer}</label>
      <select id="cloud-reviewer" value={reviewerId} disabled={busy || confirming} onChange={change(setReviewerId)}>{options}</select></div>
    <div><label htmlFor="cloud-credits">{copy.credits}</label>
      <input id="cloud-credits" type="text" inputMode="numeric" maxLength={7} value={amount} disabled={busy || confirming}
        aria-invalid={amount !== "" && credits === 0} onChange={change(setAmount)} /></div>
    {!confirming && <button className="soft" type="submit" disabled={busy || !ready}>{copy.review}</button>}
    {confirming && executor && reviewer && <div className="managed-confirm" data-testid="cloud-confirm" role="group" aria-label={copy.review}>
      <p>{fill(copy.confirmText, { credits, executor: executor.name, project })}</p>
      <div className="managed-actions">
        <button className="soft" type="button" disabled={busy} data-testid="cloud-confirm-start" onClick={() => {
          setConfirming(false);
          run({ action: "start", instruction: instruction.trim(), executorModelId: executor.id, reviewerModelId: reviewer.id, approvedCredits: credits });
          setInstruction("");
        }}>{copy.confirm}</button>
        <button className="soft" type="button" disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</button>
      </div>
    </div>}
  </form>;
}

/** Desktop > Execution and limits > Run in Tomverse cloud. Shown only when the server names `desktopCloudExecution`. */
export function CodeCloudTasks({ language }: { language: Language }) {
  const copy = desktopCloudExecutionCopy[language];
  const [view, setView] = useState<CloudExecutionView>(emptyCloudExecutionView);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback((input: DesktopCloudExecutionInput) => {
    setBusy(true);
    window.desktop.cloudExecution(input).then((next) => { setView(next); setFailed(false); }, () => setFailed(true)).finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    let current = true;
    window.desktop.cloudExecution({ action: "read" }).then((next) => { if (current) setView(next); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);
  const active = view.jobs.some((job) => cloudJobActive(job.status));
  useEffect(() => {
    if (!active) return undefined;
    let current = true;
    const handle = setInterval(() => {
      window.desktop.cloudExecution({ action: "read" }).then((next) => { if (current) setView(next); }, () => {});
    }, POLL_MS);
    return () => { current = false; clearInterval(handle); };
  }, [active]);
  const notice = view.notice;
  return <section className="managed-code cloud-tasks" aria-labelledby="cloud-tasks-heading" data-testid="cloud-tasks">
    <h4 id="cloud-tasks-heading">{copy.heading}</h4>
    <p>{copy.intro}</p>
    <p data-testid="cloud-billing">{copy.billing}</p>
    <StartForm copy={copy} language={language} view={view} busy={busy} run={run} />
    {notice?.kind === "started" && <p role="status" data-testid="cloud-started">{fill(notice.omitted ? copy.startedOmitted : copy.started, { files: notice.files, omitted: notice.omitted })}</p>}
    {notice?.kind === "applied" && <p role="status" data-testid="cloud-applied">{copy.applied}</p>}
    {notice?.kind === "refused" && <p role="alert" data-testid="cloud-refusal" data-reason={notice.refusal}>{copy.refusal[notice.refusal]}</p>}
    {failed && <p role="alert" data-testid="cloud-failed">{copy.refusal.unavailable}</p>}
    {view.review && <Review key={view.review.jobId} copy={copy} review={view.review} busy={busy} run={run} />}
    <h4>{copy.jobsHeading}</h4>
    {view.jobs.length
      ? <ul className="cloud-jobs">{view.jobs.map((job) => <Job key={job.jobId} copy={copy} language={language} job={job} busy={busy} run={run} />)}</ul>
      : <p>{copy.noJobs}</p>}
  </section>;
}
