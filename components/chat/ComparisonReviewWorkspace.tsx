"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  FileText,
  Info,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  reviewEvidenceItems,
  reviewQuoteRange,
  type ReviewEvidenceItem,
} from "@/lib/comparisonReviewEvidence";
import type {
  Citation,
  ComparisonReview,
  SingleReviewResult,
} from "../../packages/chat-core/src/review";

export type ReviewWorkspaceSource = {
  question: string;
  responses: Array<{ messageId: string; content: string }>;
};

const sectionKeys = {
  consensus: "chat.aiReviewConsensus",
  contradictions: "chat.aiReviewContradictions",
  differences: "chat.aiReviewDifferences",
  missingPoints: "chat.aiReviewMissingPoints",
  verificationNeeded: "chat.aiReviewVerificationNeeded",
};

export function ComparisonReviewWorkspace({
  result,
  responseMap,
  source,
  renderActions,
}: {
  result: SingleReviewResult;
  responseMap: ComparisonReview["responseMap"];
  source?: ReviewWorkspaceSource | null;
  renderActions: (item: ReviewEvidenceItem) => ReactNode;
}) {
  const { t } = useLanguage();
  const sectionLabel = (section: ReviewEvidenceItem["section"]) =>
    t(sectionKeys[section]).replace(/^\d+\.\s*/, "");
  const items = reviewEvidenceItems(result);
  const [selectedId, setSelectedId] = useState(items[0]?.id);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const [citation, setCitation] = useState<Citation | null>(null);
  const [responseId, setResponseId] = useState(
    selected?.citations[0]?.responseId ?? responseMap[0]?.responseId,
  );
  const sourceRef = useRef<HTMLElement>(null);
  const quoteRef = useRef<HTMLElement>(null);
  const [sourceJump, setSourceJump] = useState(0);
  useEffect(() => {
    if (!sourceJump) return;
    sourceRef.current?.focus({ preventScroll: true });
    (quoteRef.current ?? sourceRef.current)?.scrollIntoView({
      block: quoteRef.current ? "center" : "nearest",
      behavior: "instant",
    });
  }, [sourceJump]);
  const activeCitation =
    citation ??
    selected?.citations.find((item) => item.responseId === responseId);
  const response = responseMap.find((item) => item.responseId === responseId);
  // Labels belong to this review's responseMap, never to the current model order.
  const content = source?.responses.find(
    (item) => item.messageId === response?.messageId,
  )?.content;
  const range =
    content !== undefined && activeCitation
      ? reviewQuoteRange(content, activeCitation.quote)
      : null;
  const selectItem = (item: ReviewEvidenceItem) => {
    setSelectedId(item.id);
    setCitation(null);
    setResponseId(item.citations[0]?.responseId ?? responseMap[0]?.responseId);
  };
  const showCitation = (item: Citation) => {
    setCitation(item);
    setResponseId(item.responseId);
    setSourceJump((value) => value + 1);
  };
  return (
    <section data-testid="ai-review-workspace" className="space-y-4">
      {source?.question && (
        <details className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <summary className="cursor-pointer text-sm font-semibold">
            {t("chat.aiReviewComparedQuestion")}
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {source.question}
          </p>
        </details>
      )}
      {items.length === 0 ? (
        <p role="status" className="p-4 text-sm">
          {t("chat.aiReviewNoneFound")}
        </p>
      ) : (
        <>
          <div
            className="flex gap-2 overflow-x-auto pb-2"
            role="group"
            aria-label={t("chat.aiReviewFindings")}
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectItem(item)}
                aria-pressed={selected?.id === item.id}
                className={`min-h-11 shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${selected?.id === item.id ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200" : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"}`}
              >
                {index + 1}. {sectionLabel(item.section)}
              </button>
            ))}
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <article className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 sm:p-5">
              <p className="text-xs font-bold text-tomverse-review-selected-text">
                {sectionLabel(selected.section)}
              </p>
              <h3 className="mt-2 break-words text-lg font-bold leading-7">
                {selected.text}
              </h3>
              <div className="mt-4 space-y-3">
                {selected.citations.map((item, index) => (
                  <div
                    key={`${item.responseId}:${index}`}
                    className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <strong>
                        {t("chat.aiReviewResponse")} {item.responseId}
                      </strong>
                      <span
                        className={`inline-flex items-center gap-1 ${item.verified ? "text-status-success-700 dark:text-status-success-300" : "text-amber-700 dark:text-amber-300"}`}
                      >
                        {item.verified ? (
                          <ShieldCheck size={14} />
                        ) : (
                          <ShieldAlert size={14} />
                        )}
                        {t(
                          item.verified
                            ? "chat.aiReviewQuoteVerified"
                            : "chat.aiReviewQuoteUnverified",
                        )}
                      </span>
                    </div>
                    <blockquote className="my-2 whitespace-pre-wrap break-words text-sm leading-6">
                      “{item.quote}”
                    </blockquote>
                    <button
                      type="button"
                      onClick={() => showCitation(item)}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-blue-300"
                    >
                      <ArrowUpRight size={16} />
                      {t("chat.aiReviewViewSource")}
                    </button>
                  </div>
                ))}
                {!selected.citations.length && (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t("chat.aiReviewNoItemQuote")}
                  </p>
                )}
              </div>
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                <Info size={15} className="mt-0.5 shrink-0" />
                {t("chat.aiReviewEvidenceScope")}
              </p>
              {items.map((item) => (
                <div
                  key={item.id}
                  hidden={selected.id !== item.id}
                  className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-700"
                >
                  {renderActions(item)}
                </div>
              ))}
            </article>
            <aside
              ref={sourceRef}
              tabIndex={-1}
              aria-label={t("chat.aiReviewSourceAnswer")}
              data-testid="ai-review-source-answer"
              className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:bg-zinc-900 sm:p-5"
            >
              <h3 className="flex items-center gap-2 text-base font-bold">
                <FileText size={18} />
                {t("chat.aiReviewSourceAnswer")}
              </h3>
              <div
                className="mt-3 flex gap-2"
                role="group"
                aria-label={t("chat.aiReviewSourceAnswer")}
              >
                {responseMap.map((item) => (
                  <button
                    key={item.messageId}
                    type="button"
                    aria-pressed={responseId === item.responseId}
                    onClick={() => {
                      setResponseId(item.responseId);
                      setCitation(null);
                    }}
                    className={`min-h-11 flex-1 rounded-lg border text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 ${responseId === item.responseId ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200" : "border-zinc-200 dark:border-zinc-700"}`}
                  >
                    {t("chat.aiReviewResponse")} {item.responseId}
                  </button>
                ))}
              </div>
              {response && (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {response.modelName}
                </p>
              )}
              {content === undefined ? (
                <p
                  role="status"
                  className="mt-4 text-sm text-zinc-500 dark:text-zinc-400"
                >
                  {t("chat.aiReviewSourceUnavailable")}
                </p>
              ) : (
                <>
                  {activeCitation && !range && (
                    <p
                      role="status"
                      className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                    >
                      {t("chat.aiReviewSourceQuoteMissing")}
                    </p>
                  )}
                  <div
                    className="mt-4 max-h-[36rem] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7"
                    data-testid="ai-review-source-content"
                  >
                    {range ? (
                      <>
                        {content.slice(0, range.start)}
                        <mark
                          ref={quoteRef}
                          className="rounded bg-blue-100 px-0.5 text-blue-950 dark:bg-blue-900 dark:text-blue-100"
                        >
                          {content.slice(range.start, range.end)}
                        </mark>
                        {content.slice(range.end)}
                      </>
                    ) : (
                      content
                    )}
                  </div>
                </>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
