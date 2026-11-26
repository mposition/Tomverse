import { useRef, useState } from "react";
import { GitBranch, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopGitCopy } from "../../../../locales/desktopGit";
import { gitBranchName, type GhStatusResult, type GitErrorCode, type GitStatusResult } from "../git-actions-contract";
import "./git-panel.css";

type Ready = Extract<GitStatusResult, { kind: "ready" }>;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
type Copy = Record<keyof (typeof desktopGitCopy)["en"], string>;

function errorText(copy: Copy, code: GitErrorCode): string {
  const map: Partial<Record<GitErrorCode, string>> = {
    busy: copy.errorBusy, "no-project": copy.errorNoProject, "no-git": copy.errorNoGit, "managed-worktree": copy.errorManaged,
    "invalid-name": copy.errorInvalidName, "branch-exists": copy.errorBranchExists, "nothing-to-commit": copy.errorNothingToCommit,
    "staged-elsewhere": copy.errorStagedElsewhere, "unknown-path": copy.errorChangedFiles, identity: copy.errorIdentity,
    "commit-failed": copy.errorCommitFailed, detached: copy.errorDetached, "no-commits": copy.errorNoCommits, "no-remote": copy.errorNoRemote,
    "remote-unsupported": copy.errorRemoteUnsupported, "default-branch": copy.errorDefaultBranch, "config-blocked": copy.errorConfigBlocked,
    "nothing-to-publish": copy.errorNothingToPublish, "gh-missing": copy.ghMissing, "gh-signed-out": copy.ghSignedOut,
    "pr-needs-github": copy.errorPrNeedsGithub, "pr-same-branch": copy.errorPrSameBranch, denied: copy.errorDenied, changed: copy.errorChanged,
    "push-rejected": copy.errorPushRejected, "push-failed": copy.errorPushFailed,
    "draft-failed": copy.draftFailed, "draft-empty": copy.draftEmpty, "model-unavailable": copy.draftNoModel,
  };
  return map[code] ?? copy.errorUnavailable;
}

/** Branch, commit and push for the open project or task worktree. A push opens an approval window; nothing leaves the app before it is approved. */
export function GitPanel({ language, onVisibilityChange, disabled, models = [], defaultModelId }: {
  language: Language; onVisibilityChange: (open: boolean) => void; disabled: boolean;
  /** The Code model catalogue: a model for the commit message and pull request drafts is chosen from it. */
  models?: ReadonlyArray<{ id: string; name: string }>;
  defaultModelId?: string;
}) {
  const copy = desktopGitCopy[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [gh, setGh] = useState<GhStatusResult | null>(null);
  const [agent, setAgent] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [remoteBranch, setRemoteBranch] = useState("");
  const [withPr, setWithPr] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [working, setWorking] = useState<"" | "commit" | "branch" | "publish" | "draft">("");
  const [draftModel, setDraftModel] = useState(defaultModelId ?? "");
  const draftModelId = models.some((model) => model.id === draftModel) ? draftModel : models.find((model) => model.id === defaultModelId)?.id ?? models[0]?.id ?? "";
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);

  async function load() {
    try {
      const [next, ghState, switchState] = await Promise.all([window.desktop.git({ type: "status" }), window.desktop.git({ type: "gh" }), window.desktop.git({ type: "agent-actions" })]);
      setStatus(next);
      setGh(ghState);
      setAgent(switchState.enabled);
      if (next.kind === "ready") {
        setSelected((current) => new Set(next.files.filter((file) => current.has(file.path) || current.size === 0).map((file) => file.path)));
        setPrBase((current) => current || next.defaultBranch || "main");
      }
    } catch { setStatus({ kind: "unavailable", reason: "error" }); }
  }
  const fail = (code: GitErrorCode) => setNotice({ text: errorText(copy, code), alert: true });
  async function act(kind: "commit" | "branch" | "publish" | "draft", run: () => Promise<void>) {
    setWorking(kind);
    setNotice(null);
    try { await run(); } catch { setNotice({ text: copy.errorUnavailable, alert: true }); }
    setWorking("");
    await load();
  }
  const ready: Ready | null = status?.kind === "ready" ? status : null;
  const locked = disabled || working !== "" || Boolean(ready?.busy);
  const paths = ready ? ready.files.filter((file) => selected.has(file.path)).map((file) => file.path) : [];
  const canDraft = !locked && Boolean(draftModelId);

  /** The model's text goes into the boxes the person can edit; it is never committed or sent from here. */
  const draft = (kind: "commit" | "pull-request") => void act("draft", async () => {
    const base = gitBranchName.safeParse(prBase.trim());
    const result = kind === "commit"
      ? await window.desktop.git({ type: "draft", kind, modelId: draftModelId, paths })
      : await window.desktop.git({ type: "draft", kind, modelId: draftModelId, ...(base.success ? { base: base.data } : {}) });
    if (result.status === "cancelled") return;
    if (result.status !== "ok") { fail(result.code); return; }
    if (result.kind === "commit") setMessage(result.message.slice(0, 4000));
    else { setPrTitle(result.title.slice(0, 256)); setPrBody(result.body.slice(0, 8000)); }
    setNotice({ text: copy.draftAdded, alert: false });
  });

  return <>
    <button className="icon" type="button" aria-label={copy.gitButton} title={copy.gitButton}
      onClick={() => { dialog.current?.showModal(); onVisibilityChange(true); void load(); }}><GitBranch size={17} /></button>
    <dialog ref={dialog} className="git-panel-dialog" aria-labelledby="git-panel-title" onClose={() => onVisibilityChange(false)}>
      <header>
        <h2 id="git-panel-title">{copy.gitTitle}</h2>
        <span>
          <button type="button" className="soft" disabled={working !== ""} onClick={() => void load()}>{copy.refresh}</button>
          <button type="button" className="icon" aria-label={copy.close} onClick={() => dialog.current?.close()}><X size={17} /></button>
        </span>
      </header>
      {!status && <p role="status">{copy.loading}</p>}
      {status?.kind === "unavailable" && <p role="alert">{errorText(copy, status.reason === "no-project" ? "no-project" : status.reason === "no-git" ? "no-git" : "unavailable")}</p>}
      {ready && <>
        <p>
          <strong>{copy.branchLabel}:</strong> <code>{ready.branch ?? copy.detached}</code>
          {" · "}<strong>{copy.remoteLabel}:</strong> {ready.remote ? <code>{ready.remote}</code> : copy.noRemote}
          {ready.ahead ? <><br /><small>{fill(copy.aheadCount, { count: ready.ahead })}</small></> : null}
        </p>
        <section aria-label={copy.newBranchHeading}>
          <h3>{copy.newBranchHeading}</h3>
          {ready.managed ? <small>{errorText(copy, "managed-worktree")}</small> : <div className="git-row">
            <label>{copy.newBranchName}<input value={branchName} maxLength={200} onChange={(event) => setBranchName(event.currentTarget.value)} /></label>
            <button type="button" className="soft" disabled={locked || !ready.canCreateBranch || !branchName.trim()} onClick={() => void act("branch", async () => {
              const result = await window.desktop.git({ type: "create-branch", name: branchName.trim() });
              if (result.status === "ok") { setNotice({ text: fill(copy.branchSwitched, { branch: result.branch }), alert: false }); setBranchName(""); } else fail(result.code);
            })}>{copy.createBranch}</button>
          </div>}
        </section>
        <section aria-label={copy.commitHeading}>
          <h3>{copy.changesHeading}</h3>
          {ready.files.length ? <ul className="git-files">{ready.files.map((file) => <li key={file.path}>
            <input type="checkbox" aria-label={file.path} checked={selected.has(file.path)} disabled={locked}
              onChange={(event) => { const next = new Set(selected); if (event.currentTarget.checked) next.add(file.path); else next.delete(file.path); setSelected(next); }} />
            <code>{(file.index + file.worktree).trim() || "?"}</code> <span>{file.path}</span>
          </li>)}</ul> : <p>{copy.noChanges}</p>}
          {ready.moreFiles > 0 && <small>{fill(copy.moreFiles, { count: ready.moreFiles })}</small>}
          <div className="git-draft" data-testid="git-draft">
            <label>{copy.draftModel}<select value={draftModelId} disabled={locked || !models.length} onChange={(event) => setDraftModel(event.currentTarget.value)}>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </select></label>
            <small>{copy.draftNote}</small>
          </div>
          <label>{copy.commitMessage}<textarea value={message} maxLength={4000} onChange={(event) => setMessage(event.currentTarget.value)} /></label>
          <button type="button" className="soft" disabled={!canDraft || !paths.length} onClick={() => draft("commit")}>{copy.draftWithModel}</button>
          <button type="button" className="soft" disabled={locked || !paths.length || !message.trim()} onClick={() => void act("commit", async () => {
            const result = await window.desktop.git({ type: "commit", message, paths });
            if (result.status === "ok") { setNotice({ text: fill(copy.committed, { sha: result.sha.slice(0, 10) }), alert: false }); setMessage(""); setSelected(new Set()); } else fail(result.code);
          })}>{copy.commitSelected}</button>
        </section>
        <section aria-label={copy.publishHeading}>
          <h3>{copy.publishHeading}</h3>
          <label>{copy.remoteBranch}<input value={remoteBranch} placeholder={ready.branch ?? ""} maxLength={200} onChange={(event) => setRemoteBranch(event.currentTarget.value)} /></label>
          <label className="inline"><input type="checkbox" checked={withPr} disabled={locked} onChange={(event) => setWithPr(event.currentTarget.checked)} />{copy.openPullRequest}</label>
          {withPr && <>
            {gh && gh.state !== "ready" && <p className="git-notice" role="note">{gh.state === "missing" ? copy.ghMissing : copy.ghSignedOut}</p>}
            <label>{copy.pullRequestTitle}<input value={prTitle} maxLength={256} onChange={(event) => setPrTitle(event.currentTarget.value)} /></label>
            <label>{copy.pullRequestBody}<textarea value={prBody} maxLength={8000} onChange={(event) => setPrBody(event.currentTarget.value)} /></label>
            <label>{copy.pullRequestBase}<input value={prBase} maxLength={200} onChange={(event) => setPrBase(event.currentTarget.value)} /></label>
            <button type="button" className="soft" disabled={!canDraft} onClick={() => draft("pull-request")}>{copy.draftWithModel}</button>
            <label className="inline"><input type="checkbox" checked={prDraft} onChange={(event) => setPrDraft(event.currentTarget.checked)} />{copy.pullRequestDraft}</label>
          </>}
          <p className="git-notice">{copy.publishHint}</p>
          <button type="button" className="primary" disabled={locked || (withPr && (!prTitle.trim() || !prBase.trim()))} onClick={() => void act("publish", async () => {
            const result = await window.desktop.git({ type: "publish", ...(remoteBranch.trim() ? { remoteBranch: remoteBranch.trim() } : {}),
              ...(withPr ? { pullRequest: { title: prTitle.trim(), body: prBody, base: prBase.trim(), draft: prDraft } } : {}) });
            if (result.status !== "ok") { fail(result.code); return; }
            const outcome = result.pullRequest;
            const base = fill(copy.pushed, { sha: result.sha.slice(0, 10), remote: result.remote, branch: result.branch });
            const extra = !outcome ? "" : outcome.state === "created" ? copy.prCreated : outcome.state === "exists" ? copy.prExists : outcome.state === "failed" ? copy.prFailed : copy.prUnknown;
            setNotice({ text: extra ? base + " " + extra : base, alert: outcome?.state === "failed" });
          })}>{copy.publish}</button>
          {working === "publish" && <p role="status" className="git-notice">{copy.waitingApproval}</p>}
          {working === "draft" && <p role="status" className="git-notice">{copy.drafting}</p>}
        </section>
        <section aria-label={copy.agentHeading}>
          <label className="inline"><input type="checkbox" checked={agent} onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void window.desktop.git({ type: "agent-actions", enabled }).then((value) => setAgent(value.enabled), () => undefined);
          }} />{copy.agentToggle}</label>
        </section>
      </>}
      {notice && <p className="git-notice" role={notice.alert ? "alert" : "status"}>{notice.text}</p>}
    </dialog>
  </>;
}
