import { Check } from "lucide-react";

import type { AdminFlowStepState } from "@/lib/adminAmuxFlow";

const MARKER: Record<AdminFlowStepState, string> = {
  done: "bg-emerald-500 text-white",
  current: "border-2 border-blue-500 bg-zinc-900 text-blue-300",
  attention: "border-2 border-red-500 bg-zinc-900 text-red-300",
  todo: "border-2 border-zinc-700 bg-zinc-900 text-zinc-600",
};

const LABEL: Record<AdminFlowStepState, string> = {
  done: "text-zinc-300",
  current: "font-bold text-blue-300",
  attention: "font-bold text-red-300",
  todo: "text-zinc-500",
};

/**
 * A row of steps joined by a line: what is done, where it is now, what is
 * still ahead. It states a position and decides nothing; the caller computes
 * each state (`lib/adminAmuxFlow.ts`). The state is also written as text for
 * assistive technology, because colour alone must not carry it.
 */
export function AdminStepper({
  steps,
  stateWords,
  label,
  className = "",
  ...rest
}: {
  steps: ReadonlyArray<{ id: string; label: string; state: AdminFlowStepState }>;
  /** The word for each state, read out after the step's name. */
  stateWords: Record<AdminFlowStepState, string>;
  /** The list's accessible name. */
  label: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLOListElement>, "children">) {
  return (
    <ol {...rest} aria-label={label} className={`flex min-w-0 items-center gap-1 ${className}`}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-step={step.id}
          data-state={step.state}
          aria-current={step.state === "current" || step.state === "attention" ? "step" : undefined}
          className={`flex min-w-0 items-center gap-1.5 ${index < steps.length - 1 ? "flex-1" : ""}`}
        >
          <span
            aria-hidden="true"
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${MARKER[step.state]}`}
          >
            {step.state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : step.state === "todo" ? null : <span className="h-2 w-2 rounded-full bg-current" />}
          </span>
          <span className={`whitespace-nowrap text-xs ${LABEL[step.state]}`}>
            {step.label}
            <span className="sr-only"> ({stateWords[step.state]})</span>
          </span>
          {index < steps.length - 1 ? (
            <span aria-hidden="true" className={`h-0.5 min-w-3 flex-1 rounded-full ${step.state === "done" ? "bg-emerald-500/60" : "bg-zinc-800"}`} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
