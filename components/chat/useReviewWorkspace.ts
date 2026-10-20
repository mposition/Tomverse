"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReviewMode } from "@/lib/reviewRoutingCore";

export type ReviewAppearance = "studio" | "classic";
export type ReviewWorkspaceControls = {
  appearance: ReviewAppearance;
  setAppearance: (value: ReviewAppearance) => void;
  mode: ReviewMode;
  setMode: (value: ReviewMode) => void;
  providers: string[];
  setProviders: (value: string[]) => void;
  maxProviders: number;
  easyAvailable: boolean;
  pending: boolean;
  ready?: boolean;
  error: string | null;
  unsupportedProviders: string[];
  imageRequest: boolean;
  imagePromptMode: boolean;
  setImagePromptMode: (value: boolean) => void;
};

/** Browser preferences never change a conversation's product or entitlements. */
export function useReviewWorkspace(identityKey: string | null, easyAvailable: boolean, conversationId: string | null) {
  const appearance = useSyncExternalStore<ReviewAppearance>(subscribePreferences, readAppearance, () => "studio");
  const readMode = useCallback((): ReviewMode => {
    if (!easyAvailable) return "professional";
    try {
      const saved = JSON.parse(localStorage.getItem(`tomverse:review:${identityKey}`) ?? "null");
      if (saved?.mode === "easy" || saved?.mode === "professional") return saved.mode;
    } catch { /* Optional preferences never block execution. */ }
    return memoryModes.get(identityKey) ?? (easyAvailable ? "easy" : "professional");
  }, [identityKey, easyAvailable]);
  const mode = useSyncExternalStore<ReviewMode>(subscribePreferences, readMode, () => "professional");
  const setMode = useCallback((value: ReviewMode) => {
    memoryModes.set(identityKey, value);
    try { localStorage.setItem(`tomverse:review:${identityKey}`, JSON.stringify({ mode: value })); }
    catch { /* The current browser may disable persistence. */ }
    window.dispatchEvent(new Event(PREFERENCES_CHANGED));
  }, [identityKey]);
  const [providers, setProviders] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupportedProviders, setUnsupportedProviders] = useState<string[]>([]);
  const [imageRequest, setImageRequest] = useState(false);
  const [imagePromptMode, setImagePromptMode] = useState(false);
  useEffect(() => { queueMicrotask(() => setImagePromptMode(false)); }, [identityKey, conversationId]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
    if (cancelled) return;
    setProviders([]);
    setError(null);
    setUnsupportedProviders([]);
    setImageRequest(false);
    });
    return () => { cancelled = true; };
  }, [identityKey]);
  return { appearance, setAppearance, mode, setMode, providers, setProviders,
    pending, setPending, error, setError, unsupportedProviders, setUnsupportedProviders,
    imageRequest, setImageRequest, imagePromptMode, setImagePromptMode };
}

const PREFERENCES_CHANGED = "tomverse:review-preferences";
const memoryModes = new Map<string | null, ReviewMode>();
let memoryAppearance: ReviewAppearance = "studio";
const readAppearance = (): ReviewAppearance => {
  try { return localStorage.getItem("tomverse_review_appearance") === "classic" ? "classic" : "studio"; }
  catch { return memoryAppearance; }
};
const setAppearance = (value: ReviewAppearance) => {
  memoryAppearance = value;
  try { localStorage.setItem("tomverse_review_appearance", value); } catch { /* Browser-only preference. */ }
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
};
const subscribePreferences = (notify: () => void) => {
  window.addEventListener(PREFERENCES_CHANGED, notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener(PREFERENCES_CHANGED, notify); window.removeEventListener("storage", notify); };
};
