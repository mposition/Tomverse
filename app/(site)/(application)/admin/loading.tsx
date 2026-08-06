/**
 * The content-area loading state.
 *
 * It sits beside `layout.tsx` in the same segment, so Next wraps only the page
 * below it in the Suspense boundary: the sidebar, the header, the breadcrumb
 * and the footer stay mounted and interactive while a workspace loads, and only
 * this block is replaced. Moving between workspaces therefore never blanks the
 * console.
 */
export default function AdminLoading() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      aria-busy="true"
      aria-live="polite"
    >
      <p className="sr-only">Loading this Admin workspace.</p>
      <div className="h-11 w-full max-w-md animate-pulse rounded-xl bg-zinc-900" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/60"
          />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-3xl border border-zinc-800 bg-zinc-900/40" />
    </div>
  );
}
