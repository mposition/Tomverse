import Link from "next/link";

/**
 * A row of links drawn as one segmented control, the way the console picks a
 * report period. Links rather than buttons, so the choice lives in the URL and
 * a report can be linked and reloaded as the same report.
 */
export function AdminSegmentedLinks({
  items,
  label,
}: {
  items: ReadonlyArray<{ id: string; label: string; href: string; active: boolean }>;
  /** Accessible name of the group. */
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-1 rounded-2xl border border-zinc-800 bg-zinc-900 p-1"
    >
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          prefetch={false}
          aria-current={item.active ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-xl px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
            item.active ? "bg-blue-600 font-bold text-white" : "text-zinc-400 hover:text-white"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
