"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, LockKeyhole, MessageSquarePlus, Plus } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

// The unified "new" entry point (policy v2 section 13 of
// docs/policy/image-generation.md). One control replaces the pair of
// stacked buttons: the dominant action (a new chat) stays a single click,
// and the other kinds live behind the caret.
//
// Two shapes, one behaviour. Desktop is a split button so the primary action
// costs no extra click. Mobile does NOT shrink that caret into a 20px target
// -- it opens a bottom sheet with full-size rows instead, which is also what
// the drawer's own controls do.
//
// Locked entries stay visible and clickable (never hidden, never
// disabled-at-the-end): the plan requirement is stated up front and the click
// routes to the upgrade or sign-in prompt. UI exposure is not a security
// boundary; the server re-checks every request regardless.

export type NewConversationKind = "chat" | "image";

export type NewConversationLauncherProps = {
  onNewChat: () => void;
  /** Absent when the image feature flag is off: the entry does not exist. */
  onNewImage?: (() => void) | null;
  /**
   * Set when the viewer may see image generation but not use it yet. The
   * entry renders locked and the click reports the reason instead of opening
   * a workspace they cannot submit from.
   */
  imageLock?: "sign_in" | "upgrade" | null;
  onLockedImageClick?: (lock: "sign_in" | "upgrade") => void;
  variant: "rail" | "expanded";
  /** Mobile drawer sizing: 44px rows rather than compact desktop ones. */
  isMobileDrawer?: boolean;
};

export function NewConversationLauncher({
  onNewChat,
  onNewImage,
  imageLock = null,
  onLockedImageClick,
  variant,
  isMobileDrawer = false,
}: NewConversationLauncherProps) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const showImage = Boolean(onNewImage) || Boolean(imageLock);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setIsOpen(false);
      // Focus returns to the control that opened the menu, never to the
      // document body.
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    // Move focus into the menu so a keyboard user is not left behind on the
    // caret with an open surface they cannot reach.
    const firstItem = menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]'
    );
    firstItem?.focus();
  }, [isOpen]);

  const selectImage = () => {
    setIsOpen(false);
    if (imageLock) {
      onLockedImageClick?.(imageLock);
      return;
    }
    onNewImage?.();
  };

  const selectChat = () => {
    setIsOpen(false);
    onNewChat();
  };

  const menuItemClass = `flex w-full items-center gap-2.5 px-3 text-left text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 ${
    isMobileDrawer ? "min-h-12 py-2.5" : "min-h-10 py-2"
  }`;

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("sidebar.newConversationMenu")}
      data-testid="new-conversation-menu"
      className={`absolute z-30 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 ${
        variant === "rail" ? "left-11 top-0 w-56" : "left-0 right-0 top-full mt-1"
      }`}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="new-conversation-menu-chat"
        onClick={selectChat}
        className={menuItemClass}
      >
        <MessageSquarePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("sidebar.newChat")}
      </button>
      {showImage && (
        <button
          type="button"
          role="menuitem"
          data-testid="new-conversation-menu-image"
          data-locked={imageLock ? "true" : "false"}
          onClick={selectImage}
          className={menuItemClass}
        >
          <ImagePlus
            className="h-4 w-4 shrink-0 text-accent-image-500"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">{t("sidebar.newImage")}</span>
          {imageLock && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-accent-image-600 dark:text-accent-image-300">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
              {imageLock === "sign_in"
                ? t("sidebar.newImageSignInRequired")
                : t("sidebar.newImageUpgradeRequired")}
            </span>
          )}
        </button>
      )}
    </div>
  );

  if (variant === "rail") {
    return (
      <div ref={containerRef} className="relative mt-2 flex flex-col items-center">
        <button
          type="button"
          onClick={showImage ? () => setIsOpen((open) => !open) : onNewChat}
          ref={triggerRef}
          data-testid="sidebar-rail-new-launcher"
          title={showImage ? t("sidebar.newConversationMenu") : t("sidebar.newChat")}
          aria-label={
            showImage ? t("sidebar.newConversationMenu") : t("sidebar.newChat")
          }
          {...(showImage
            ? { "aria-haspopup": "menu" as const, "aria-expanded": isOpen }
            : {})}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
        {isOpen && menu}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex w-full items-stretch gap-px overflow-hidden rounded-lg bg-zinc-900 dark:bg-white">
        <button
          type="button"
          data-testid="sidebar-new-chat"
          onClick={onNewChat}
          className={`flex flex-1 cursor-pointer items-center justify-center gap-2 px-4 text-xs font-semibold text-white transition-all hover:bg-zinc-800 dark:text-zinc-950 dark:hover:bg-zinc-200 ${
            isMobileDrawer ? "min-h-11 py-2" : "py-2.5"
          }`}
        >
          <span className="text-sm">+</span> {t("sidebar.newChat")}
        </button>
        {showImage && (
          <button
            type="button"
            ref={triggerRef}
            data-testid="sidebar-new-launcher-more"
            onClick={() => setIsOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={t("sidebar.newConversationMenu")}
            className={`flex w-11 cursor-pointer items-center justify-center border-l border-white/20 text-white transition-all hover:bg-zinc-800 dark:border-zinc-950/20 dark:text-zinc-950 dark:hover:bg-zinc-200 ${
              isMobileDrawer ? "min-h-11" : ""
            }`}
          >
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {isOpen && menu}
    </div>
  );
}
