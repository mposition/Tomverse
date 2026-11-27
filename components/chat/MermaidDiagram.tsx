"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";

/**
 * Present only around an assistant answer (never a user message), and says
 * whether the answer is still streaming. A diagram is drawn only once its
 * block is final: a half-written diagram is a parse error on every chunk.
 */
export type AnswerRenderState = { streaming: boolean };
export const ANSWER_RENDER_STREAMING: AnswerRenderState = { streaming: true };
export const ANSWER_RENDER_FINAL: AnswerRenderState = { streaming: false };
export const AnswerRenderContext = createContext<AnswerRenderState | null>(null);

type MermaidApi = typeof import("mermaid").default;

let mermaidModule: Promise<MermaidApi> | null = null;
/** mermaid renders into a shared DOM scratch area; one render at a time. */
let renderQueue: Promise<unknown> = Promise.resolve();

const loadMermaid = (): Promise<MermaidApi> => {
  mermaidModule ??= import("mermaid").then((module) => module.default);
  return mermaidModule;
};

const prefersDark = () =>
  typeof document !== "undefined" &&
  (document.documentElement.classList.contains("dark") ||
    (!document.documentElement.classList.contains("light") &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches));

async function renderDiagram(id: string, source: string): Promise<string> {
  const run = async () => {
    const mermaid = await loadMermaid();
    // `strict` encodes HTML in labels and disables click handlers; the
    // library also sanitises the SVG it returns.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: prefersDark() ? "dark" : "default",
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  };
  const next = renderQueue.then(run, run);
  renderQueue = next.catch(() => undefined);
  return next;
}

/**
 * A ```mermaid block drawn as a diagram. Anything that goes wrong (still
 * streaming, library fails to load, source does not parse) shows `fallback`,
 * the ordinary code block the reader would have seen without this feature.
 */
export function MermaidDiagram({
  source,
  fallback,
  label,
}: {
  source: string;
  fallback: ReactNode;
  label: string;
}) {
  const streaming = useContext(AnswerRenderContext)?.streaming ?? false;
  const rawId = useId();
  const [drawn, setDrawn] = useState<{ source: string; svg: string } | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  useEffect(() => {
    if (streaming || failedSource === source || drawn?.source === source) return;
    let cancelled = false;
    // useId contains ":" which is not valid in the id mermaid puts on its SVG.
    const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    renderDiagram(id, source).then(
      (svg) => {
        if (!cancelled) setDrawn({ source, svg });
      },
      () => {
        if (!cancelled) setFailedSource(source);
        // mermaid leaves its error graphic in the document on a failed parse.
        document.getElementById(`d${id}`)?.remove();
      }
    );
    return () => {
      cancelled = true;
    };
  }, [streaming, source, rawId, drawn, failedSource]);

  if (streaming || failedSource === source || drawn?.source !== source) return <>{fallback}</>;
  return (
    <div
      data-testid="chat-mermaid-diagram"
      role="img"
      aria-label={label}
      className="mb-3 overflow-x-auto rounded-lg border border-zinc-200 bg-white p-3 last:mb-0 dark:border-zinc-700 dark:bg-zinc-900 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
      // Strict-mode mermaid output: sanitised SVG, no scripts or handlers.
      dangerouslySetInnerHTML={{ __html: drawn.svg }}
    />
  );
}
