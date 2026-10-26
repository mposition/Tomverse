"use client";

import { useState } from "react";
import { adminMessagesFor, type AdminLocale } from "@/lib/adminLocale";
import { adminAiReviewPreparationPanelMessages } from "@/lib/adminMessages/aiReviewPreparation";
import {
  aiReviewCandidateProposal,
  aiReviewSampleProposal,
  type AiReviewPreparationCatalog,
  type AiReviewPreparationSet,
} from "@/lib/aiReviewPreparation";
import type { AiReviewEvalCase } from "@/lib/aiReviewEvalCore";

const field =
  "min-h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400";
const button =
  "min-h-10 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-100 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-400";

export function downloadAiReviewDraft(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CandidateEditor({
  set,
  item,
  locale,
}: {
  set: AiReviewPreparationSet;
  item: AiReviewEvalCase;
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewPreparationPanelMessages, locale);
  const [question, setQuestion] = useState(item.question);
  const [responses, setResponses] = useState(
    item.responses.map((response) => ({ ...response })),
  );
  const [notes, setNotes] = useState(item.notes ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid min-w-0 gap-4" data-testid="candidate-editor">
      <p className="text-xs text-zinc-400">
        {item.language} · {item.taskType} · {item.phenomenon} ·{" "}
        {item.status ?? "candidate"}
      </p>
      <label className="text-sm text-zinc-200">
        {m.question}
        <textarea
          className={`${field} mt-2`}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            setSaved(false);
          }}
          rows={3}
        />
      </label>
      {responses.map((response, index) => (
        <label key={response.label} className="text-sm text-zinc-200">
          {m.answer} {response.label.toUpperCase()}
          <textarea
            className={`${field} mt-2`}
            rows={5}
            value={response.content}
            onChange={(event) => {
              setResponses(
                responses.map((value, i) =>
                  i === index
                    ? { ...value, content: event.target.value }
                    : value,
                ),
              );
              setSaved(false);
            }}
          />
        </label>
      ))}
      <details className="rounded-xl border border-zinc-800 p-4">
        <summary className="cursor-pointer text-sm text-zinc-200">
          {m.gold}
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-zinc-400">
          {JSON.stringify(
            {
              gold: item.gold,
              goldCompleteness: item.goldCompleteness,
              draftedBy: item.draftedBy,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <label className="text-sm text-zinc-200">
        {m.notes}
        <textarea
          className={`${field} mt-2`}
          rows={4}
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <button
        type="button"
        className={button}
        disabled={
          !question.trim() ||
          responses.some((response) => !response.content.trim())
        }
        onClick={() => {
          downloadAiReviewDraft(
            `${item.id}-proposal.json`,
            aiReviewCandidateProposal(set, item, {
              question,
              responses,
              notes,
            }),
          );
          setSaved(true);
        }}
      >
        {m.downloadEdit}
      </button>
      <p role="status" className="text-xs text-zinc-400">
        {saved ? m.downloaded : m.draftNotice}
      </p>
    </div>
  );
}

function DatasetPreparation({
  set,
  locale,
}: {
  set: AiReviewPreparationSet;
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewPreparationPanelMessages, locale);
  const [caseId, setCaseId] = useState(set.dataset.cases[0]?.id ?? "");
  const [selected, setSelected] = useState(
    set.dataset.cases.map((item) => item.id),
  );
  const [version, setVersion] = useState(`${set.dataset.version}-draft`);
  const item = set.dataset.cases.find((candidate) => candidate.id === caseId);
  return (
    <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)]">
      <div className="min-w-0">
        <label className="text-sm text-zinc-200">
          {m.candidate}
          <select
            className={`${field} my-3`}
            value={caseId}
            onChange={(event) => setCaseId(event.target.value)}
          >
            {set.dataset.cases.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.id}
              </option>
            ))}
          </select>
        </label>
        {item && (
          <CandidateEditor
            key={item.id}
            set={set}
            item={item}
            locale={locale}
          />
        )}
      </div>
      <div className="min-w-0 space-y-4 rounded-xl border border-zinc-800 p-4">
        <h3 className="font-medium text-zinc-100">{m.composition}</h3>
        <p className="text-sm text-zinc-400">{m.shortfalls}</p>
        <ul className="max-h-44 space-y-1 overflow-y-auto text-xs text-zinc-400">
          {set.shortfalls.map((shortfall) => (
            <li key={shortfall}>{shortfall}</li>
          ))}
        </ul>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm text-zinc-200">
            {m.includeCandidates}
          </legend>
          {set.dataset.cases.map((candidate) => (
            <label
              key={candidate.id}
              className="flex items-start gap-2 break-all text-xs text-zinc-300"
            >
              <input
                type="checkbox"
                checked={selected.includes(candidate.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, candidate.id]
                      : selected.filter((id) => id !== candidate.id),
                  )
                }
              />
              {candidate.id}
            </label>
          ))}
        </fieldset>
        <label className="block text-sm text-zinc-200">
          {m.version}
          <input
            className={`${field} mt-2`}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={button}
          disabled={
            !selected.length ||
            !version.trim() ||
            version.trim() === set.dataset.version
          }
          onClick={() =>
            downloadAiReviewDraft(
              "ai-review-sample-proposal.json",
              aiReviewSampleProposal(set, selected, version),
            )
          }
        >
          {m.downloadSample}
        </button>
        <p className="text-xs text-zinc-400">{m.signatureNotice}</p>
      </div>
    </div>
  );
}

export function AdminAiReviewPreparationPanel({
  catalog,
  locale,
}: {
  catalog: AiReviewPreparationCatalog;
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewPreparationPanelMessages, locale);
  const [file, setFile] = useState(catalog.sets[0]?.file ?? "");
  const set = catalog.sets.find((entry) => entry.file === file);
  return (
    <details
      className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="ai-review-preparation"
    >
      <summary className="cursor-pointer font-semibold text-zinc-100">
        {m.title}
      </summary>
      <p className="my-4 text-sm text-zinc-400">{m.description}</p>
      {catalog.problems.map((problem) => (
        <p
          key={problem}
          role="alert"
          className="break-words text-sm text-red-400"
        >
          {problem}
        </p>
      ))}
      {!set ? (
        <p className="text-sm text-zinc-400">{m.empty}</p>
      ) : (
        <>
          <label className="text-sm text-zinc-200">
            {m.candidateSet}
            <select
              className={`${field} mt-2`}
              value={file}
              onChange={(event) => setFile(event.target.value)}
            >
              {catalog.sets.map((entry) => (
                <option key={entry.file} value={entry.file}>
                  {entry.dataset.version} ({entry.dataset.cases.length})
                </option>
              ))}
            </select>
          </label>
          <DatasetPreparation key={file} set={set} locale={locale} />
        </>
      )}
    </details>
  );
}
