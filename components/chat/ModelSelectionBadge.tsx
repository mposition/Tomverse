import { Check, LockKeyhole, Plus } from "lucide-react";

/**
 * Selection affordance shared by the recommended cards and the full
 * catalogue. The icon carries the state on its own (check / lock / plus) so
 * selection and availability are never signalled by colour alone; the
 * accessible state lives on the owning button's aria-pressed.
 */
export function ModelSelectionBadge({
  isSelected,
  isLocked,
}: {
  isSelected: boolean;
  isLocked: boolean;
}) {
  const Icon = isSelected ? Check : isLocked ? LockKeyhole : Plus;
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
        isSelected
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-zinc-300 text-zinc-400 dark:border-zinc-600 dark:text-zinc-500"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}
