"use client";

import { useId } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminUiMessages } from "@/lib/adminMessages/ui";

const VARIANT = {
  primary: "bg-blue-600 text-white hover:bg-blue-500",
  secondary: "border border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
  danger: "bg-red-500/15 text-red-200 hover:bg-red-500/25",
  ghost: "text-blue-300 hover:bg-blue-500/10",
} as const;

/**
 * A button that changes something.
 *
 * - `writable={false}`: drawn disabled with a lock, and says which access it
 *   needs (`requiredRole`) both on hover and to a screen reader. The server
 *   still refuses the write on its own; this only tells the operator before
 *   they try.
 * - `stepUp`: shows a shield from the start, so the operator knows a recent
 *   sign-in is coming before they press it.
 */
export function AdminWriteButton({
  children,
  writable = true,
  requiredRole,
  stepUp = false,
  variant = "primary",
  size = "md",
  className = "",
  disabled,
  type = "button",
  ...rest
}: {
  children: React.ReactNode;
  writable?: boolean;
  requiredRole?: string;
  stepUp?: boolean;
  variant?: keyof typeof VARIANT;
  size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const m = useAdminMessages(adminUiMessages);
  const locked = !writable;
  const lockedNote = locked && requiredRole ? m.writeLocked(requiredRole) : undefined;
  const noteId = `admin-write-note-${useId().replace(/:/g, "")}`;
  return (
    <>
    <button
      {...rest}
      type={type}
      disabled={locked || disabled}
      title={lockedNote ?? rest.title}
      aria-describedby={lockedNote ? noteId : rest["aria-describedby"]}
      data-step-up={stepUp ? "true" : undefined}
      className={`inline-flex min-w-0 max-w-full shrink items-center justify-center gap-1.5 whitespace-normal text-center [overflow-wrap:anywhere] sm:shrink-0 sm:whitespace-nowrap rounded-xl font-bold transition disabled:cursor-not-allowed ${
        size === "sm" ? "min-h-8 px-3 text-xs" : "min-h-10 px-4 text-sm"
      } ${
        locked
          ? "border border-dashed border-zinc-700 text-zinc-500"
          : `${VARIANT[variant]} disabled:opacity-50`
      } ${className}`}
    >
      {locked ? (
        <Lock className="h-3.5 w-3.5" aria-hidden />
      ) : stepUp ? (
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      ) : null}
      {children}
    </button>
    {lockedNote ? (
      <span id={noteId} className="sr-only">
        {lockedNote}
      </span>
    ) : null}
    </>
  );
}
