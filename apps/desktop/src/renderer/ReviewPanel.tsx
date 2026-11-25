import { useEffect, useMemo, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeReviewCopy, type CodeReviewCopy } from "../../../../locales/desktopCodeReview";
import type { Model, Task } from "../contract";
import {
  MAX_REVIEW_COMMENT_CHARACTERS, MAX_REVIEW_MODELS, REVIEW_OPEN_EVENT, REVIEW_REQUESTS, serializeFindingForFix, serializeReviewComments,
  type MergedFinding, type ReviewComment, type ReviewDiff, type ReviewFile, type ReviewHunk, type ReviewModelResult, type ReviewScope, type ReviewUnavailable,
} from "../review-contract";
import { matchFindingPath } from "../review-findings";
import "./review-panel.css";

type Copy = CodeReviewCopy;
type View = { kind: "loading" } | { kind: "ok"; diff: ReviewDiff } | { kind: "unavailable"; reason: ReviewUnavailable };
type Loaded = { key: string; result: Exclude<View, { kind: "loading" }> };
type Run = { kind: "idle" } | { kind: "running" } | { kind: "done"; results: ReviewModelResult[]; findings: MergedFinding[] };
type Composer = { fileId: string; hunkId: string; from: number; to: number };

const SETTLED: Task["status"][] = ["completed", "clarification", "blocked", "stopped", "unknown", "failed"];
const SCOPES: ReviewScope[] = ["uncommitted", "last-turn", "branch"];
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{([a-z]+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

const unavailableText = (copy: Copy, reason: ReviewUnavailable) => ({
  "no-task": copy.unavailableNoTask, busy: copy.unavailableBusy, "not-git": copy.unavailableNotGit, "git-unavailable": copy.unavailableGit,
  "no-turn": copy.unavailableNoTurn, "no-base": copy.unavailableNoBase, failed: copy.unavailableFailed,
})[reason];

/** The number a comment on this line is made against, and which version of the file that number is in. */
const lineNumber = (line: ReviewHunk["lines"][number]) => (line.kind === "remove" ? line.oldNo! : line.newNo!);

/** Whether a task is one the panel can review: a saved Tomverse API task. */
export const canReview = (task: Task) => !!task.id && task.execution?.executionMode === "tomverse_api" && task.savedLocally !== false &&
  !task.continuation && !task.cliContinuation && !task.unreadable && task.status !== "starting";

export function ReviewPanel({ task, models, language, insert }: {
  task: Task; models: Model[]; language: Language;
  /** Puts text into the instruction box; false when it does not fit. */
  insert: (text: string) => boolean;
}) {
  const copy = desktopCodeReviewCopy[language];
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [base, setBase] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const settled = SETTLED.includes(task.status);
  const stamp = settled ? `${task.id}|${task.status}|${task.changes.map((change) => change.id + change.current).join(",")}` : "running";

  useEffect(() => {
    const listener = (event: Event) => {
      const scopeRequested = (event as CustomEvent<{ scope: ReviewScope | null } | undefined>).detail?.scope;
      setOpen(true);
      if (scopeRequested) setScope(scopeRequested);
    };
    window.addEventListener(REVIEW_OPEN_EVENT, listener);
    return () => window.removeEventListener(REVIEW_OPEN_EVENT, listener);
  }, []);

  // The diff is read again whenever the scope, the base, the task's changes or a refresh asks for it; what is shown is only ever what was read for the current key.
  const key = `${scope}|${base ?? ""}|${stamp}|${reload}`;
  useEffect(() => {
    if (!open) return;
    let current = true;
    const done = (result: Loaded["result"]) => { if (current) setLoaded({ key, result }); };
    window.desktop.review({ action: "diff", scope, ...(scope === "branch" && base ? { base } : {}) }).then(
      (outcome) => done(outcome.status === "ok" ? { kind: "ok", diff: outcome.diff } : { kind: "unavailable", reason: outcome.reason }),
      () => done({ kind: "unavailable", reason: "failed" }));
    return () => { current = false; };
  }, [open, scope, base, key]);
  const view: View = loaded?.key === key ? loaded.result : { kind: "loading" };
  const refresh = () => { setComposer(null); setReload((count) => count + 1); };

  const diff = view.kind === "ok" ? view.diff : null;
  const shown = useMemo(() => new Set((diff?.files ?? []).flatMap((file) => file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind !== "remove").map((line) => `${file.path}:${line.newNo}`)))), [diff]);
  const paths = useMemo(() => new Set((diff?.files ?? []).map((file) => file.path)), [diff]);
  const anchored = useMemo(() => {
    const map = new Map<string, MergedFinding[]>();
    const outside: MergedFinding[] = [];
    if (run.kind !== "done") return { map, outside };
    for (const finding of run.findings) {
      const path = matchFindingPath(finding.file, paths);
      const key = path && finding.line !== null ? `${path}:${finding.line}` : null;
      if (key && shown.has(key)) map.set(key, [...(map.get(key) ?? []), finding]);
      else outside.push(finding);
    }
    return { map, outside };
  }, [run, paths, shown]);

  function choose(file: ReviewFile, hunk: ReviewHunk, index: number, extend: boolean) {
    setNotice(null);
    setComposer((current) => {
      if (extend && current && current.hunkId === hunk.id) return { ...current, from: Math.min(current.from, index), to: Math.max(current.to, index) };
      setDraft("");
      return { fileId: file.id, hunkId: hunk.id, from: index, to: index };
    });
  }

  function saveComment(file: ReviewFile, hunk: ReviewHunk, selected: Composer) {
    const lines = hunk.lines.slice(selected.from, selected.to + 1);
    const current = lines.filter((line) => line.kind !== "remove");
    const side: ReviewComment["side"] = current.length ? "new" : "old";
    const used = side === "new" ? current : lines;
    const numbers = used.map(lineNumber);
    const text = draft.trim().slice(0, MAX_REVIEW_COMMENT_CHARACTERS);
    if (!text) return;
    setComments((existing) => [...existing, { path: file.path, startLine: Math.min(...numbers), endLine: Math.max(...numbers), side, snippet: used.map((line) => line.text).join("\n"), text }]);
    setComposer(null);
    setDraft("");
  }

  function attachComments() {
    const inserted = insert(serializeReviewComments(comments));
    if (inserted) setComments([]);
    setNotice(inserted ? copy.commentsAttached : copy.commentsTooLong);
  }

  async function revert(hunk: ReviewHunk) {
    setReverting(true);
    setNotice(null);
    try {
      const outcome = await window.desktop.review({ action: "revert-hunk", scope, ...(scope === "branch" && base ? { base } : {}), hunkId: hunk.id });
      if (outcome.status === "reverted") setNotice(copy.revertDone);
      else if (outcome.status === "stale") setNotice(copy.revertStale);
      else if (outcome.status === "unconfirmed") setNotice(copy.revertUnconfirmed);
      else if (outcome.status === "unavailable") setNotice(copy.revertUnavailable);
      if (outcome.status !== "cancelled") refresh();
    } catch { setNotice(copy.revertUnavailable); }
    setReverting(false);
  }

  async function startReview() {
    setRun({ kind: "running" });
    setNotice(null);
    try {
      const outcome = await window.desktop.review({ action: "run", scope, ...(scope === "branch" && base ? { base } : {}), modelIds: chosen });
      if (outcome.status === "done") { setRun({ kind: "done", results: outcome.results, findings: outcome.findings }); return; }
      setNotice(outcome.status === "empty" ? copy.reviewEmpty : outcome.status === "cancelled" ? copy.reviewCancelled
        : outcome.status === "unconfirmed" ? copy.reviewUnconfirmed : copy.reviewUnavailable);
    } catch { setNotice(copy.reviewUnavailable); }
    setRun({ kind: "idle" });
  }

  function askFix(finding: MergedFinding) {
    setNotice(insert(serializeFindingForFix(finding)) ? copy.fixAdded : copy.commentsTooLong);
  }

  const toggleModel = (id: string) => setChosen((current) => current.includes(id) ? current.filter((item) => item !== id)
    : current.length < MAX_REVIEW_MODELS ? [...current, id] : current);
  const hasHunks = !!diff?.files.some((file) => file.hunks.length);
  const scopeNames: Record<ReviewScope, string> = { uncommitted: copy.scopeUncommitted, "last-turn": copy.scopeLastTurn, branch: copy.scopeBranch };

  const findingItem = (finding: MergedFinding) => <li key={finding.id} className="review-finding" data-severity={finding.severity} data-testid="review-finding">
    <span className="review-severity">{{ critical: copy.severityCritical, high: copy.severityHigh, medium: copy.severityMedium, low: copy.severityLow, info: copy.severityInfo }[finding.severity]}</span>
    <span>{finding.line === null ? finding.file : `${finding.file}:${finding.line}`}</span>
    <p>{finding.description}</p>
    {finding.suggestion && <p className="review-suggestion">{finding.suggestion}</p>}
    <small>{fill(copy.reportedBy, { models: finding.models.join(", ") })}</small>
    <button className="soft" type="button" onClick={() => askFix(finding)}>{copy.askFix}</button>
  </li>;

  return <details className="review-panel" data-testid="review-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{copy.summary}</summary>
    {open && <>
      <div className="review-toolbar">
        <div role="group" aria-label={copy.scopeLabel}>
          {SCOPES.map((item) => <button key={item} type="button" className="soft" aria-pressed={scope === item} onClick={() => { setComposer(null); setScope(item); }}>{scopeNames[item]}</button>)}
        </div>
        {scope === "branch" && diff?.bases && diff.bases.length > 0 && <label>{copy.baseLabel}
          <select value={base ?? diff.base?.ref ?? ""} onChange={(event) => setBase(event.currentTarget.value)}>
            {diff.bases.map((item) => <option key={item.ref} value={item.ref}>{item.label}</option>)}
          </select></label>}
        <button className="soft" type="button" onClick={refresh}>{copy.refresh}</button>
      </div>
      {notice && <p role="status" className="review-notice">{notice}</p>}
      {view.kind === "loading" && <p role="status">{copy.loading}</p>}
      {view.kind === "unavailable" && <p role="status">{unavailableText(copy, view.reason)}</p>}
      {diff && !diff.files.length && <p role="status">{copy.empty}</p>}
      {diff?.truncated && <p role="status">{copy.truncated}</p>}
      {diff?.files.map((file) => <section key={file.id} className="review-file" data-testid="review-file" data-path={file.path} aria-label={file.path}>
        <h4><code>{file.path}</code>
          {file.status !== "modified" && <span className="review-tag">{file.status === "added" ? copy.fileAdded : copy.fileDeleted}</span>}
          <small>+{file.added} −{file.removed}</small></h4>
        {file.omitted && <p className="review-omitted">{{ binary: copy.omittedBinary, large: copy.omittedLarge, secret: copy.omittedSecret, unreadable: copy.omittedUnreadable }[file.omitted]}</p>}
        {file.hunks.map((hunk) => {
          const selected = composer?.hunkId === hunk.id ? composer : null;
          return <div key={hunk.id} className="review-hunk" data-testid="review-hunk">
            <div className="review-hunk-head"><code>{hunk.header}</code>
              <button className="soft" type="button" disabled={reverting} onClick={() => void revert(hunk)}>{reverting ? copy.hunkReverting : copy.hunkRevert}</button></div>
            <ol>{hunk.lines.map((line, index) => {
              const number = lineNumber(line);
              const inRange = !!selected && index >= selected.from && index <= selected.to;
              const found = line.kind === "remove" ? [] : anchored.map.get(`${file.path}:${line.newNo}`) ?? [];
              return <li key={index} className="review-line" data-kind={line.kind} data-line={number} data-selected={inRange || undefined} data-testid="review-line">
                <button type="button" className="review-gutter" aria-label={fill(copy.commentLine, { line: number })}
                  onClick={(event) => choose(file, hunk, index, event.shiftKey)}>{number}</button>
                <code>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}{line.text}</code>
                {line.noEol && <small>⏎✗</small>}
                {found.length > 0 && <ul className="review-findings">{found.map(findingItem)}</ul>}
                {selected && index === selected.to && <form className="review-comment-form" onSubmit={(event) => { event.preventDefault(); saveComment(file, hunk, selected); }}>
                  <textarea aria-label={copy.commentLabel} value={draft} maxLength={MAX_REVIEW_COMMENT_CHARACTERS} autoFocus
                    onChange={(event) => setDraft(event.currentTarget.value)} />
                  <button className="soft" type="submit" disabled={!draft.trim()}>{copy.commentSave}</button>
                  <button className="soft" type="button" onClick={() => setComposer(null)}>{copy.commentCancel}</button>
                </form>}
              </li>;
            })}</ol>
          </div>;
        })}
      </section>)}
      {comments.length > 0 && <section className="review-comments" data-testid="review-comments">
        <h4>{fill(copy.commentsHeading, { count: comments.length })}</h4>
        <ul>{comments.map((comment, index) => <li key={index}>
          <code>{comment.path}:{comment.startLine}{comment.endLine > comment.startLine ? `-${comment.endLine}` : ""}</code>
          <span>{comment.text}</span>
          <button className="soft" type="button" aria-label={copy.commentRemove} onClick={() => setComments((current) => current.filter((_, at) => at !== index))}>×</button>
        </li>)}</ul>
        <button className="soft" type="button" onClick={attachComments}>{copy.commentsAttach}</button>
      </section>}
      <section className="review-run" aria-label={copy.reviewHeading}>
        <h4>{copy.reviewHeading}</h4>
        <p>{copy.reviewHint}</p>
        <fieldset disabled={run.kind === "running"}><legend>{copy.reviewModels}</legend>
          {models.map((model) => <label key={model.id}>
            <input type="checkbox" checked={chosen.includes(model.id)} disabled={!chosen.includes(model.id) && chosen.length >= MAX_REVIEW_MODELS}
              onChange={() => toggleModel(model.id)} /> {model.name}</label>)}
        </fieldset>
        {chosen.length > 0 && <p>{fill(copy.reviewCost, { count: chosen.length, requests: REVIEW_REQUESTS })}</p>}
        {run.kind === "running"
          ? <button className="soft" type="button" onClick={() => void window.desktop.review({ action: "cancel" }).catch(() => undefined)}>{copy.reviewCancel}</button>
          : <button className="soft" type="button" disabled={!chosen.length || !hasHunks} onClick={() => void startReview()}>{copy.reviewRun}</button>}
        {run.kind === "running" && <p role="status">{copy.reviewRunning}</p>}
        {run.kind === "done" && <div data-testid="review-results">
          <ul>{run.results.map((result) => <li key={result.modelId}>
            {result.status === "ok" ? fill(copy.usedRequests, { model: result.modelName, requests: result.requests ?? 0 })
              : result.status === "unparseable" ? <>{fill(copy.reviewUnreadable, { model: result.modelName })}{result.summary && <details><summary>{result.modelName}</summary><pre>{result.summary}</pre></details>}</>
              : fill(copy.reviewNoResult, { model: result.modelName })}
            {result.status === "ok" && result.summary && <p>{result.summary}</p>}
          </li>)}</ul>
          <h4>{fill(copy.resultsHeading, { count: run.findings.length })}</h4>
          {!run.findings.length && <p>{copy.noFindings}</p>}
          {anchored.outside.length > 0 && <><h5>{copy.findingsOutside}</h5><ul className="review-findings">{anchored.outside.map(findingItem)}</ul></>}
        </div>}
      </section>
    </>}
  </details>;
}
