"use client";
import { useEffect, useState } from "react";
import { VoiceSessionSummary, type VoiceSessionSummaryValue } from "@tomverse/chat-ui";
import { useLanguage } from "@/components/LanguageProvider";

export function VoiceConversationHistory({ conversationId, revision }: { conversationId: string; revision: number }) {
  const { lang } = useLanguage();
  const [saved, setSaved] = useState<{ conversationId: string; sessions: VoiceSessionSummaryValue[] } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/chat/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "history", conversationId }), signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.sessions) || abort.signal.aborted) return;
        const rows = data.sessions.filter((s: Record<string, unknown>) => typeof s.id === "string" && typeof s.seconds === "number" && typeof s.credits === "number").map((s: VoiceSessionSummaryValue & { settled: boolean }) => ({ ...s, status: s.settled ? "settled" : "reserved" }));
        setSaved({ conversationId, sessions: rows.reverse() });
        if (rows.some((s: VoiceSessionSummaryValue) => s.status !== "settled")) timer = setTimeout(() => void load(), 15_000);
      } catch { /* Chat remains available when voice history is temporarily unavailable. */ }
    };
    void load(); return () => { abort.abort(); clearTimeout(timer); };
  }, [conversationId, revision]);
  return saved?.conversationId === conversationId ? saved.sessions.map(value => <VoiceSessionSummary key={value.id} language={lang} value={value} />) : null;
}
