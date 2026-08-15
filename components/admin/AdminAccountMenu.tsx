"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { ExternalLink, LogOut, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminRole } from "@/lib/adminAuthCore";

type Props = {
  user: { name: string | null; email: string | null };
  role: AdminRole;
};

/**
 * The console's account control.
 *
 * It used to be a `<span>` -- the signed-in administrator's name, and nothing
 * that could be pressed. There was no way to leave the console or to end the
 * session from anywhere inside `/admin/**`, which is what turned an expired
 * step-up window into a dead end: the one instruction the console could give
 * ("sign out completely, then sign in again") named an action the console did
 * not have.
 *
 * Signing out here is exactly NextAuth's `signOut()` and nothing more. It ends
 * the session; it does not renew, extend or satisfy either administrator
 * window. The step-up clock is `authenticatedAt` on a freshly minted JWT, so
 * the only thing that moves it is a real sign-in.
 */
export function AdminAccountMenu({ user, role }: Props) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = user.name || user.email || "Administrator";

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focus the first item so the menu is usable from the keyboard the moment
    // it opens, rather than leaving focus behind on the trigger.
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      // Tabbing past the last item leaves the menu; it should not stay open
      // behind the focus ring.
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [close, open]);

  const moveFocus = (direction: 1 | -1) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") || []
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = (index + direction + items.length) % items.length;
    items[next]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // `stopPropagation` because the shell listens for Escape on `window` to
      // close its own overlays; without it one press would close the drawer
      // and the command palette too.
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  const endSession = async () => {
    setSigningOut(true);
    try {
      await signOut({ callbackUrl: "/" });
    } catch {
      setSigningOut(false);
    }
  };

  const itemClass =
    "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-bold text-zinc-200 outline-none transition hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        data-testid="admin-account-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        // The visible name is truncated and hidden entirely on small screens,
        // so the accessible name carries the account and the role in full.
        aria-label={`Account menu for ${label} (${role})`}
        // Below `sm` it is the same 40px square as the other header controls,
        // with the name and role carried by `aria-label` alone; from `sm` it
        // grows the chip the console has always shown.
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-800 transition hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-auto sm:w-auto sm:justify-start sm:gap-2 sm:px-2.5 sm:py-1.5"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
          <UserRound className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="hidden max-w-36 truncate text-xs font-bold text-zinc-300 md:inline">
          {label}
        </span>
        <span className="hidden rounded bg-purple-500/10 px-1.5 py-0.5 text-xs font-bold uppercase text-purple-200 md:inline">
          {role}
        </span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Administrator account"
          data-testid="admin-account-menu"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-12 z-50 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-black text-white">{label}</p>
            {user.email && user.email !== label ? (
              <p className="truncate text-xs text-zinc-400">{user.email}</p>
            ) : null}
            <p className="mt-1 text-xs font-bold uppercase tracking-[0.14em] text-purple-200">
              {role}
            </p>
          </div>
          <div className="my-1 border-t border-zinc-800" />
          <Link
            href="/"
            role="menuitem"
            data-testid="admin-account-menu-home"
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Return to Tomverse
          </Link>
          <button
            type="button"
            role="menuitem"
            data-testid="admin-account-menu-signout"
            onClick={() => void endSession()}
            disabled={signingOut}
            className={`${itemClass} disabled:cursor-wait disabled:opacity-70`}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          <p className="px-3 pb-1 pt-2 text-xs leading-5 text-zinc-500">
            Signing out ends this session. It does not extend the
            administrator or high-risk sign-in windows.
          </p>
        </div>
      ) : null}
    </div>
  );
}
