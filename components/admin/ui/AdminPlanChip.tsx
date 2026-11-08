/**
 * A plan's name as a small chip. A plan is a label, not a status, so it does
 * not borrow the status colours: Max is violet, Pro blue, anything else grey.
 */
export function AdminPlanChip({ plan, className = "" }: { plan: string | null | undefined; className?: string }) {
  const name = plan || "Free";
  const tone =
    name === "Max"
      ? "bg-violet-500/15 text-violet-300"
      : name === "Pro"
        ? "bg-blue-500/15 text-blue-300"
        : "bg-zinc-800 text-zinc-300";
  return (
    <span
      data-plan={name}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-bold ${tone} ${className}`}
    >
      {name}
    </span>
  );
}
