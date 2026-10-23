"use client";

import { useSyncExternalStore } from "react";

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type InstallMode = "unavailable" | "prompt" | "ios";

let deferredPrompt: InstallPrompt | null = null;
let installed = false;
let mode: InstallMode = "unavailable";
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function refresh() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const next = installed || standalone ? "unavailable" : deferredPrompt ? "prompt" : ios ? "ios" : "unavailable";
  if (next !== mode) {
    mode = next;
    listeners.forEach((listener) => listener());
  }
}

function capturePrompt(event: Event) {
  event.preventDefault();
  installed = false;
  deferredPrompt = event as InstallPrompt;
  refresh();
}

function markInstalled() {
  installed = true;
  deferredPrompt = null;
  refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    displayMode.addEventListener("change", refresh);
    stopListening = () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
      displayMode.removeEventListener("change", refresh);
    };
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

async function requestInstall() {
  const prompt = deferredPrompt;
  if (!prompt || mode !== "prompt") return;
  deferredPrompt = null;
  try {
    // Invoke inside the click handler to retain the browser's user activation.
    const result = prompt.prompt();
    refresh();
    await result;
    await prompt.userChoice;
  } catch {
    // A consumed or dismissed prompt needs a fresh browser event before reuse.
  } finally {
    refresh();
  }
}

// One shared prompt survives opening drawers and switching sidebar layouts.
export function usePwaInstall() {
  const mode = useSyncExternalStore(subscribe, modeSnapshot, () => "unavailable" as const);
  return { mode, requestInstall };
}

function modeSnapshot() { return mode; }

// Mobile account drawers are unmounted while closed; capture the event without UI.
export function PwaInstallListener() {
  usePwaInstall();
  return null;
}
