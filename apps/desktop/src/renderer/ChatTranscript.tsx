import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { AnswerMarkdown } from "@tomverse/chat-ui";
import { getModelBrand } from "../../../../lib/modelBranding";
import { getModel } from "../../../../lib/models";
import { splitInlineCode, splitUserMessageSegments } from "../../../../lib/userMessageSegments";
import type { Language } from "../../../../lib/language";
import { en } from "../../../../locales/en";
import { ko } from "../../../../locales/ko";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import { fr } from "../../../../locales/fr";
import { de } from "../../../../locales/de";
import { es } from "../../../../locales/es";
import { pt } from "../../../../locales/pt";

const locales = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };
const TranscriptLanguage = createContext<Language>("en");
const providerImages = import.meta.glob<string>("../../../../public/model-icons/*.png", {
  eager: true, import: "default", query: "?url&no-inline",
});

function CopyText({ text, code = false }: { text(): string; code?: boolean }) {
  const copy = locales[useContext(TranscriptLanguage)].chat;
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const label = copied ? copy.responseCopied : code ? copy.copyCode : copy.copyResponse;
  return <button className="chat-copy-text" type="button" title={label} aria-label={label} onClick={async () => {
    const value = text();
    if (!value) return;
    try {
      await window.desktop.copyChatText(value);
      clearTimeout(reset.current);
      setCopied(true);
      reset.current = setTimeout(() => setCopied(false), 1500);
    } catch {}
  }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const copy = locales[useContext(TranscriptLanguage)].chat;
  return <div className="chat-code-block">
    <pre ref={ref} tabIndex={0} role="region" aria-label={copy.markdownCodeRegion}>{children}</pre>
    <CopyText code text={() => (ref.current?.textContent ?? "").replace(/\r?\n$/, "")} />
  </div>;
}

const markdownComponents = {
  pre: CodeBlock,
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
};

export function ChatMarkdown({ content, language = "en" }: { content: string; language?: Language }) {
  return <TranscriptLanguage.Provider value={language}>
    <div className="chat-message-markdown">
      <AnswerMarkdown components={markdownComponents} rehypePlugins={[rehypeHighlight]}>{content}</AnswerMarkdown>
    </div>
  </TranscriptLanguage.Provider>;
}

export function UserMessageContent({ content, language }: { content: string; language: Language }) {
  return <div className="chat-message-markdown chat-user-content">
    {splitUserMessageSegments(content).map((segment, index) => {
      if (segment.kind === "text") {
        return <p key={index}>{splitInlineCode(segment.text).map((part, partIndex) =>
          part.kind === "code" ? <code key={partIndex}>{part.text}</code> : part.text)}</p>;
      }
      const longestRun = (segment.code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
      const fence = "`".repeat(longestRun + 1);
      const block = fence + (segment.language ?? "") + "\n" + segment.code + "\n" + fence;
      return <ChatMarkdown key={index} content={block} language={language} />;
    })}
  </div>;
}

export function AnswerModel({ id, provider }: { id?: string | null; provider?: string | null }) {
  if (!id) return null;
  const model = getModel(id);
  const brand = getModelBrand(model?.provider ?? provider ?? id);
  const image = brand.image ? providerImages["../../../../public" + brand.image] : undefined;
  return <div className="chat-answer-model" data-testid="desktop-chat-answer-model">
    {image ? <img src={image} alt="" width={23} height={23} />
      : <span aria-hidden="true">{brand.mark}</span>}
    <span>{model?.name ?? id}</span>
  </div>;
}

export function CopyAnswer({ content, language }: { content: string; language: Language }) {
  return <TranscriptLanguage.Provider value={language}>
    <CopyText text={() => content} />
  </TranscriptLanguage.Provider>;
}
