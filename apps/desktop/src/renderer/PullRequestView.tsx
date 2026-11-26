import { useEffect, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopGitCopy } from "../../../../locales/desktopGit";
import type { PrCheck, PrComment, PrViewResult } from "../git-actions-contract";
import type { PullLink } from "../github-pr-contract";
import { addPromptAttachment } from "./prompt-attachments";
import "./git-panel.css";

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
const bucketKey = { pass: "prBucketPass", fail: "prBucketFail", pending: "prBucketPending", skipping: "prBucketSkipping", cancel: "prBucketCancel" } as const;

/**
 * A linked pull request inside the app: its checks and review comments (through the person's own `gh`), a failed check's log and any
 * comment to attach to the next instruction. Everything from GitHub is text from outside: it renders as plain text and is attached as data.
 */
export function PullRequestView({ link, language, scope }: { link: PullLink; language: Language; scope: string }) {
  const copy = desktopGitCopy[language];
  const [loaded, setLoaded] = useState<{ key: string; value: PrViewResult } | null>(null);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const { url, environment } = link;
  const key = url + "#" + version;
  useEffect(() => {
    let active = true;
    void window.desktop.git({ type: "pr-view", link: { url, environment } }).then((value) => { if (active) setLoaded({ key, value }); },
      () => { if (active) setLoaded({ key, value: { status: "error", code: "unavailable" } }); });
    return () => { active = false; };
  }, [url, environment, key]);
  const result = loaded?.key === key ? loaded.value : null;
  const pending = result === null;
  async function sendFailure(check: PrCheck) {
    setNotice(null);
    try {
      const log = await window.desktop.git({ type: "pr-check-log", link, check: check.name });
      if (log.status !== "ok") { setNotice({ text: copy.prLogUnavailable, alert: true }); return; }
      addPromptAttachment({ scope, source: "ci-log", label: fill(copy.attachmentLog, { name: check.name }), text: log.text });
      setNotice({ text: copy.prAdded, alert: false });
    } catch { setNotice({ text: copy.prLogUnavailable, alert: true }); }
  }
  function sendComment(comment: PrComment) {
    const where = comment.path ? comment.path + (comment.line ? ":" + comment.line : "") + "\n" : "";
    addPromptAttachment({ scope, source: "review-comment", label: fill(copy.attachmentComment, { author: comment.author }) + (comment.path ? " · " + comment.path : ""),
      id: scope + ":comment:" + comment.id, text: where + comment.body });
    setNotice({ text: copy.prAdded, alert: false });
  }
  if (!result) return <p role="status">{copy.loading}</p>;
  const refresh = <button type="button" className="soft" disabled={pending} onClick={() => setVersion(version + 1)}>{copy.refresh}</button>;
  if (result.status === "error") return <div className="pr-view"><p role="alert">{copy.prReadFailed}</p>{refresh}</div>;
  if (result.status === "limited") {
    const reason = result.reason === "gh-missing" ? copy.ghMissing : result.reason === "gh-signed-out" ? copy.ghSignedOut : copy.ghError;
    return <div className="pr-view" data-testid="pr-limited">
      <p role="status">{copy.prLimited}</p>
      <p role="note">{reason}</p>
      {refresh}
    </div>;
  }
  const { details } = result;
  return <div className="pr-view" data-testid="pr-details">
    <div className="git-row">
      <strong>{details.title}</strong>
      <span>{details.state}{details.isDraft ? " · " + copy.prDraft : ""}{details.reviewDecision ? " · " + fill(copy.prReview, { value: details.reviewDecision }) : ""}</span>
    </div>
    <small><code>{details.headRef}</code> → <code>{details.baseRef}</code> · <code title={details.headSha}>{details.headSha.slice(0, 12)}</code></small>
    <p role="note" className="git-notice">{copy.prUntrusted}</p>
    <h3>{copy.prChecksHeading}</h3>
    {details.checks.length ? <ul aria-label={copy.prChecksHeading}>{details.checks.map((check) => <li key={check.name + check.link} className="pr-check" data-bucket={check.bucket}>
      <div className="git-row">
        <span><span className="pr-bucket">{copy[bucketKey[check.bucket]]}</span> · {check.name}{check.workflow ? " · " + check.workflow : ""}</span>
        {check.bucket === "fail" && <button type="button" className="soft" onClick={() => void sendFailure(check)}>{copy.prSendFailure}</button>}
      </div>
    </li>)}</ul> : <p>{copy.prNoChecks}</p>}
    <h3>{copy.prCommentsHeading}</h3>
    {details.comments.length ? <ul aria-label={copy.prCommentsHeading}>{details.comments.map((comment) => <li key={comment.id}>
      <div className="git-row">
        <span><strong>{comment.author}</strong>{comment.state ? " · " + comment.state : ""}{comment.path ? " · " + comment.path + (comment.line ? ":" + comment.line : "") : ""}</span>
        <button type="button" className="soft" onClick={() => sendComment(comment)}>{copy.prSendComment}</button>
      </div>
      <p className="pr-comment-body">{comment.body}</p>
    </li>)}</ul> : <p>{copy.prNoComments}</p>}
    {details.omittedComments > 0 && <small>{fill(copy.prMoreComments, { count: details.omittedComments })}</small>}
    {notice && <p className="git-notice" role={notice.alert ? "alert" : "status"}>{notice.text}</p>}
    {refresh}
  </div>;
}
