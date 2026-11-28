import Link from "next/link";
import type { WebSearchCitation } from "@/lib/webSearchCitations";

/** Set by the save_memory tool when this answer saved something to memory (lib/chatMemoryTool.ts). */
const MEMORY_SAVED_PROVIDER = "memory_saved";

export function SearchCitationList({
  citations: allCitations,
  label,
  memorySaved,
}: {
  citations: WebSearchCitation[];
  label: string;
  /** The localized note and link text for an answer that saved a memory. */
  memorySaved?: { note: string; manage: string };
}) {
  const saved = memorySaved && allCitations.some((citation) => citation.sourceProvider === MEMORY_SAVED_PROVIDER);
  // The saved-memory entry is a note with a link to the memory screen, not a source of the answer.
  const citations = saved ? allCitations.filter((citation) => citation.sourceProvider !== MEMORY_SAVED_PROVIDER) : allCitations;
  if (citations.length === 0 && !saved) return null;
  return (
    <>
      {saved && memorySaved && (
        <p
          data-testid="memory-saved-note"
          className="mt-3 flex flex-wrap items-baseline gap-x-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
        >
          <span>{memorySaved.note}</span>
          <Link
            href="/settings/memory"
            data-testid="memory-saved-manage-link"
            className="font-semibold text-blue-600 underline underline-offset-2 dark:text-blue-400"
          >
            {memorySaved.manage}
          </Link>
        </p>
      )}
      {citations.length > 0 && <SourceList citations={citations} label={label} />}
    </>
  );
}

function SourceList({ citations, label }: { citations: WebSearchCitation[]; label: string }) {
  return (
    <div
      data-testid="search-citation-list"
      className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-700/60"
    >
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <ul className="space-y-2">
        {citations.map((citation, citationIndex) => (
          <li
            key={`${citation.url}-${citationIndex}`}
            data-testid="search-citation-item"
            data-reference-number={citation.referenceNumber ?? ""}
            className="flex items-baseline gap-1.5"
          >
            {/*
              The number the answer text already used, shown
              as the provider numbered it. Providers that
              publish no citation order (OpenAI, Anthropic,
              Google inline annotations) leave it undefined
              and the row renders without one -- a made-up
              sequence would point at the wrong source.
            */}
            {citation.referenceNumber !== undefined && (
              <span className="shrink-0 text-xs font-bold tabular-nums text-zinc-400 dark:text-zinc-500">
                [{citation.referenceNumber}]
              </span>
            )}
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              title={citation.url}
              className="truncate py-0.5 text-sm leading-6 font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
            >
              {citation.title || citation.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
