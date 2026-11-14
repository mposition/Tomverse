import { useState } from "react";
import { AnswerMarkdown } from "@tomverse/chat-ui";
import { visibleGeneratedArtifacts, formatArtifactSize, type ChatStreamArtifact } from "../../../lib/generatedArtifactCore";
import type { ChatTransport } from "./chatTransport";
import { mobileCompletionCopy } from "../../../locales/mobileCompletion";
import type { MobileLanguage } from "../../../locales/mobile";
import { ImageTurn } from "./ImageTurn";
import { Copy } from "lucide-react";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { isGeneratedArtifactRevisionSupported } from "../../../lib/generatedArtifactRevisionCore";
import { mobileArtifactRevisionCopy } from "../../../locales/mobileArtifactRevision";
import { mergeGeneratedArtifactVersions, type GeneratedArtifactVersion } from "../../../lib/generatedArtifactVersions";

export function AnswerContent({ content, artifacts, citations, transport, language, imageTurn, copyable = false, onRevise }: {
  content: string; artifacts?: ChatStreamArtifact[];
  citations?: Array<{ url: string; title?: string }>;
  transport: ChatTransport; language: MobileLanguage;
  imageTurn?: { groupId: string; modelIds: string[] };
  copyable?: boolean;
  onRevise?: (artifact: ChatStreamArtifact) => Promise<string | null>;
}) {
  const copy = mobileCompletionCopy(language);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const actions = mobileParityCopy(language);
  const revision = mobileArtifactRevisionCopy(language);
  const [revisionPending, setRevisionPending] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, { artifacts: GeneratedArtifactVersion[]; cursor: string | null }>>({});
  const [versionsPending, setVersionsPending] = useState<string | null>(null);
  function revise(artifact: ChatStreamArtifact) {
    if (!onRevise || revisionPending) return;
    setRevisionPending(artifact.id); setError("");
    void onRevise(artifact).then(message => { if (message) setError(message); })
      .catch(() => setError(revision.failed)).finally(() => setRevisionPending(null));
  }
  async function loadVersions(artifactId: string, cursor?: string | null) {
    if (!transport.artifactVersions) return;
    setVersionsPending(artifactId); setError("");
    try {
      const page = await transport.artifactVersions(artifactId, cursor);
      setVersions(current => ({ ...current, [artifactId]: { artifacts: mergeGeneratedArtifactVersions(current[artifactId]?.artifacts ?? [], page.artifacts), cursor: page.nextCursor } }));
    } catch { setError(revision.failed); }
    finally { setVersionsPending(null); }
  }
  return <div className="answer-content">
    {imageTurn ? <ImageTurn groupId={imageTurn.groupId} transport={transport} language={language} /> : <AnswerMarkdown components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt}</span>,
    }}>{content}</AnswerMarkdown>}
    {!!citations?.length && <ol className="answer-sources" aria-label={copy.sources}>{citations.map((source, index) => {
      let safe = false; try { safe = ["https:", "http:"].includes(new URL(source.url).protocol); } catch { /* Invalid sources are not links. */ }
      return <li key={`${source.url}-${index}`}>{safe ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a> : source.title}</li>;
    })}</ol>}
    {visibleGeneratedArtifacts(artifacts ?? []).map((artifact) => <section className="generated-file" key={artifact.id}>
      <strong>{artifact.filename}</strong><span>{artifact.format.toUpperCase()} · {formatArtifactSize(artifact.byteSize)}</span>
      {artifact.modelId && <small>{artifact.modelId}</small>}
      {artifact.status === "ready" ? <button disabled={pending !== null} onClick={() => {
        setPending(artifact.id); setError("");
        void transport.downloadArtifact(artifact).catch((error) => { if ((error as { code?: string }).code !== "FILE_SAVE_CANCELLED") setError(copy.downloadFailed); }).finally(() => setPending(null));
      }}>{pending === artifact.id ? copy.saving : copy.download}</button> : <p>{artifact.status === "blocked" ? copy.signIn : copy.fileFailed}</p>}
      {onRevise && artifact.status === "ready" && isGeneratedArtifactRevisionSupported(artifact) && <>
        {(artifact.format === "docx" || artifact.format === "pptx") && <small>{revision.officeNotice}</small>}
        <button type="button" data-testid="native-artifact-revise" disabled={revisionPending !== null} onClick={() => revise(artifact)}>{revisionPending === artifact.id ? revision.preparing : revision.revise}</button>
      </>}
      {onRevise && artifact.status === "ready" && artifact.lineageId && transport.artifactVersions && <>
        <button type="button" disabled={versionsPending !== null} onClick={() => void loadVersions(artifact.id)}>{revision.versions}</button>
        {versions[artifact.id] && <ul className="artifact-versions" aria-label={revision.versions}>{versions[artifact.id].artifacts.map(version => {
          const parent = versions[artifact.id].artifacts.find(candidate => candidate.id === version.parentArtifactId);
          const nodeId = `native-artifact-version-${artifact.id}-${version.id}`;
          return <li key={version.id} id={nodeId} tabIndex={-1} aria-current={version.id === artifact.id ? "true" : undefined}>
            <strong>{version.filename}</strong><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString(language)}</time>
            {version.id === artifact.id && <small>{revision.current}</small>}
            {parent ? <button type="button" onClick={() => { const source = document.getElementById(`native-artifact-version-${artifact.id}-${parent.id}`); source?.focus(); source?.scrollIntoView({ block: "nearest" }); }}>{revision.source}: {parent.filename} · {new Date(parent.createdAt).toLocaleString(language)}</button>
              : version.parentArtifactId ? <small>{revision.notLoaded}</small> : <small>{version.lineageId !== version.id ? revision.unavailable : revision.noSource}</small>}
            {isGeneratedArtifactRevisionSupported(version) && <button type="button" disabled={revisionPending !== null} onClick={() => revise(version)}>{revision.use}</button>}
          </li>;
        })}</ul>}
        {versions[artifact.id]?.cursor && <button type="button" disabled={versionsPending !== null} onClick={() => void loadVersions(artifact.id, versions[artifact.id].cursor)}>{revision.more}</button>}
      </>}
    </section>)}
    {copyable && content.trim() && !imageTurn && <button type="button" className="answer-copy" onClick={() => {
      setError(""); setCopied(false);
      void Promise.resolve().then(() => navigator.clipboard.writeText(content)).then(() => setCopied(true)).catch(() => setError(actions.copyFailed));
    }}><Copy size={15} aria-hidden="true" />{copied ? actions.copied : actions.copy}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
