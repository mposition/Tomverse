/**
 * A search excerpt with its match marked.
 *
 * Text nodes only: the excerpt is somebody's message -- possibly an imported
 * transcript -- and nothing in it is interpreted as markup or markdown. The
 * offsets come from `searchSnippet()` (lib/searchSnippet.ts) and are UTF-16
 * positions in `text`; offsets that do not fit are ignored rather than trusted.
 */
export function SearchSnippetText({
    text,
    highlight,
}: {
    text: string;
    highlight: { start: number; end: number } | null;
}) {
    if (
        !highlight ||
        !Number.isSafeInteger(highlight.start) ||
        !Number.isSafeInteger(highlight.end) ||
        highlight.start < 0 ||
        highlight.end <= highlight.start ||
        highlight.end > text.length
    ) {
        return <>{text}</>;
    }
    return (
        <>
            {text.slice(0, highlight.start)}
            <mark className="rounded-sm bg-blue-200/70 px-0.5 text-zinc-800 dark:bg-blue-400/30 dark:text-zinc-100">
                {text.slice(highlight.start, highlight.end)}
            </mark>
            {text.slice(highlight.end)}
        </>
    );
}
