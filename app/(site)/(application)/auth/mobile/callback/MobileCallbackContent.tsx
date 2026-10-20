"use client";
import { useEffect } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { mobileCopy } from "@/locales/mobile";

/** Reaching the web fallback is not evidence of a verified app-link association. */
export function MobileCallbackContent() {
  const { lang } = useLanguage();
  useEffect(() => { history.replaceState(null, "", location.pathname); }, []);
  return <main className="mx-auto max-w-md p-8"><h1 className="text-xl font-semibold">Tomverse</h1><p>{mobileCopy[lang].native}</p></main>;
}
