import { useEffect, useRef, useState } from "react";
import { GitPullRequest, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { mobileCopy } from "../../../../locales/mobile";
import { desktopGitCopy } from "../../../../locales/desktopGit";
import { githubPullUrl, type PullEvidence, type PullLink } from "../github-pr-contract";
import { PullRequestView } from "./PullRequestView";

const copy = {
  en: {
    title: "Linked GitHub pull requests", url: "Public GitHub pull request URL", environment: "Target environment",
    add: "Link and check", refresh: "Check again", invalid: "Enter a valid GitHub pull request URL.",
    error: "The pull request could not be saved.", stale: "Status needs a fresh check", checked: "Checked",
    unknown: "Check evidence unavailable", unavailable: "Pull request unavailable or moved", pending: "Required checks pending",
    closed: "Closed without merge", failed: "Current commit has failing checks", conflict: "Merge conflict",
    passed: "Required checks passed", merged: "Merged, deployment unverified", deployed: "Deployment confirmed",
    deploy_failed: "Deployment failed", deploy_pending: "Deployment pending",
  },
  ko: {
    title: "연결된 GitHub PR", url: "공개 GitHub PR URL", environment: "대상 환경",
    add: "연결 및 확인", refresh: "다시 확인", invalid: "올바른 GitHub PR 주소를 입력하세요.",
    error: "PR 연결을 저장하지 못했습니다.", stale: "상태를 다시 확인해야 합니다", checked: "확인 시각",
    unknown: "검사 근거 없음", unavailable: "PR을 찾을 수 없거나 이동됨", pending: "필수 검사 대기",
    closed: "병합 없이 닫힘", failed: "현재 커밋의 검사 실패", conflict: "병합 충돌",
    passed: "필수 검사 통과", merged: "병합 완료 · 배포 확인 필요", deployed: "배포 확인",
    deploy_failed: "배포 실패", deploy_pending: "배포 대기",
  },
};
const evidenceLifetime = 120_000;

export function TaskGithubPulls({ language, onVisibilityChange, scope }: { language: Language; onVisibilityChange: (open: boolean) => void; scope: string }) {
  const git = desktopGitCopy[language];
  const [expanded, setExpanded] = useState<string | null>(null);
  const text = language === "ko" ? copy.ko : copy.en;
  const common = mobileCopy[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<PullEvidence[]>([]);
  const [pending, setPending] = useState(false);
  const [url, setUrl] = useState("");
  const [environment, setEnvironment] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    void window.desktop.taskPulls({ type: "list" }).then((rows) => { if (active) setRows(rows); }, () => {});
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    return () => { active = false; clearInterval(clock); };
  }, []);
  useEffect(() => () => onVisibilityChange(false), [onVisibilityChange]);
  const status = (row: PullEvidence) => now - row.checkedAt >= evidenceLifetime ? "stale" : row.state;
  async function read(link: PullLink) {
    setPending(true);
    setError("");
    try {
      const rows = await window.desktop.taskPulls({ type: "read", link });
      if (!rows.length) throw new Error("Task changed");
      // The rows were just read, so the newest check time is the present; the clock above keeps it moving.
      setNow((current) => Math.max(current, ...rows.map((row) => row.checkedAt)));
      setRows(rows);
    } catch { setError(text.error); }
    finally { setPending(false); }
  }
  const label = rows.length === 1 ? text.title + " · " + text[status(rows[0])] : text.title;
  const firstState = rows.length === 1 ? status(rows[0]) : undefined;
  return <>
    <button className="icon task-github-status" type="button" aria-label={label} data-state={firstState}
      title={label} onClick={() => { dialog.current?.showModal(); onVisibilityChange(true); }}><GitPullRequest size={17} />{rows.length > 1 && <small>{rows.length}</small>}</button>
    <dialog ref={dialog} className="task-github-dialog" aria-labelledby="task-github-title" onClose={() => onVisibilityChange(false)}>
      <header>
        <h2 id="task-github-title">{text.title}</h2>
        <button type="button" className="icon" aria-label={common.close} onClick={() => dialog.current?.close()}><X size={17} /></button>
      </header>
      <ul>{rows.map((row) => {
        const ref = githubPullUrl(row.url)!;
        const current = status(row);
        return <li key={row.url + "#" + row.environment}>
          <strong>{ref.repo} · #{ref.number}</strong> {row.environment}
          <small className="task-github-status" data-state={current}><GitPullRequest size={14} />{text[current]}{row.conflict && current === "failed" ? " · " + text.conflict : ""}</small>
          <small>{text.checked} {new Date(row.checkedAt).toLocaleString(language)}
            {row.head && <> · <code title={row.head}>{row.head.slice(0, 12)}</code></>}
            {row.merge && <> → <code title={row.merge}>{row.merge.slice(0, 12)}</code></>}
          </small>
          <div className="task-github-actions">
            <button type="button" className="soft" aria-expanded={expanded === row.url}
              onClick={() => setExpanded(expanded === row.url ? null : row.url)}>{expanded === row.url ? git.prHideDetails : git.prDetails}</button>
            <button type="button" className="soft" disabled={pending}
              onClick={() => void read({ url: row.url, environment: row.environment })}>{text.refresh}</button>
          </div>
          {expanded === row.url && <PullRequestView link={{ url: row.url, environment: row.environment }} language={language} scope={scope} />}
        </li>;
      })}</ul>
      <form onSubmit={(event) => {
        event.preventDefault();
        const target = githubPullUrl(url);
        if (!target) { setError(text.invalid); return; }
        void read({ url: target.url, environment });
      }}>
        <label>{text.url}
          <input type="url" required value={url} maxLength={240} onChange={(event) => setUrl(event.currentTarget.value)} />
        </label>
        <label>{text.environment}
          <input value={environment} maxLength={80} onChange={(event) => setEnvironment(event.currentTarget.value)} />
        </label>
        <button type="submit" className="soft" disabled={pending}>{text.add}</button>
      </form>
      {pending && <p role="status">{common.loading}</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>
  </>;
}
