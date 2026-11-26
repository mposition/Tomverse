import type { Language } from "../../../../lib/language";
import { desktopGitCopy } from "../../../../locales/desktopGit";
import type { GitApprovalView } from "../git-actions-contract";
import "./git-panel.css";

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));

/** What the approval window shows for a commit or a push: built by the main process from the repository, shown as plain text. */
export function GitApprovalSection({ git, language }: { git: GitApprovalView; language: Language }) {
  const copy = desktopGitCopy[language];
  const { commit, publish } = git;
  return <section className="git-approval" aria-label={git.kind === "publish" ? copy.approvalPublishHeading : copy.approvalCommitHeading} data-testid="git-approval">
    <h2>{git.kind === "publish" ? copy.approvalPublishHeading : copy.approvalCommitHeading}</h2>
    <p role="note"><strong>{git.origin === "agent" ? copy.approvalByAgent : copy.approvalByYou}</strong></p>
    <dl><dt>{copy.approvalRepository}</dt><dd><code>{git.repository}</code></dd></dl>
    {commit && <>
      <h3>{copy.approvalMessage}</h3><pre>{commit.message}</pre>
      <h3>{copy.approvalFiles} ({commit.files.length})</h3>
      <ul>{commit.files.map((file) => <li key={file.path}><code>{file.status}</code> <code>{file.path}</code></li>)}</ul>
    </>}
    {publish && <>
      <dl>
        <dt>{copy.approvalRemote}</dt><dd><code>{publish.remote.name}</code> · <code>{publish.remote.url}</code></dd>
        <dt>{copy.approvalLocalBranch}</dt><dd><code>{publish.localBranch}</code></dd>
        <dt>{copy.approvalRemoteBranch}</dt><dd><code>{publish.remoteBranch}</code></dd>
        <dt>{copy.approvalHead}</dt><dd><code>{publish.head}</code></dd>
      </dl>
      <h3>{fill(copy.approvalCommits, { count: publish.commits.length + publish.moreCommits })}</h3>
      <ul>{publish.commits.map((commitRow) => <li key={commitRow.sha}><code>{commitRow.sha.slice(0, 10)}</code> {commitRow.subject} <small>({commitRow.author})</small></li>)}</ul>
      {publish.moreCommits > 0 && <small>{fill(copy.approvalMoreCommits, { count: publish.moreCommits })}</small>}
      {publish.uncommitted > 0 && <p role="note">{fill(copy.approvalUncommitted, { count: publish.uncommitted })}</p>}
      {publish.pullRequest && <>
        <h3>{copy.approvalPrHeading}</h3>
        <dl>
          <dt>{copy.approvalPrRepository}</dt><dd><code>{publish.pullRequest.repo}</code></dd>
          <dt>{copy.approvalPrBase}</dt><dd><code>{publish.pullRequest.base}</code> ← <code>{publish.pullRequest.head}</code></dd>
          <dt>{copy.approvalPrTitle}</dt><dd>{publish.pullRequest.title}</dd>
          <dt>{copy.approvalPrDraft}</dt><dd>{publish.pullRequest.draft ? copy.yes : copy.no}</dd>
          <dt>{copy.approvalPrBody}</dt><dd><pre>{publish.pullRequest.body || "—"}</pre></dd>
        </dl>
      </>}
    </>}
    <p role="note">{copy.approvalNote}</p>
  </section>;
}
