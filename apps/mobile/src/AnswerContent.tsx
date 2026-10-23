import { useState } from "react";
import { AnswerMarkdown } from "@tomverse/chat-ui";
import { visibleGeneratedArtifacts, formatArtifactSize, type ChatStreamArtifact } from "../../../lib/generatedArtifactCore";
import type { ChatTransport } from "./chatTransport";
import { mobileCompletionCopy } from "../../../locales/mobileCompletion";
import type { MobileLanguage } from "../../../locales/mobile";

export function AnswerContent({ content, artifacts, citations, transport, language }: {
  content: string; artifacts?: ChatStreamArtifact[];
  citations?: Array<{ url: string; title?: string }>;
  transport: ChatTransport; language: MobileLanguage;
}) {
  const copy = mobileCompletionCopy(language);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <div className="answer-content">
    <AnswerMarkdown components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt}</span>,
    }}>{content}</AnswerMarkdown>
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
    </section>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
