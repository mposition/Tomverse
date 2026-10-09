"use client";

import { useEffect, useRef, useState } from "react";
import { SessionProvider } from "next-auth/react";
import { ChatPageClient } from "@/app/(site)/(application)/chat/ChatPageClient";
import { CHAT_E04_AUTO_ACTIONS } from "@/lib/chatE04StagingFixture";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { CHAT_E04_CONVERSATION, CHAT_E04_SESSION, installChatE04FixtureTransport,
  type ChatE04TransportEvidence } from "@/lib/chatE04StagingFixtureTransport";

export function ChatE04FixtureWorkspace() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"off" | "refiner">("off");
  const [evidence, setEvidence] = useState<ChatE04TransportEvidence | null>(null);
  const [auto, setAuto] = useState<unknown>(null);
  const transport = useRef<ReturnType<typeof installChatE04FixtureTransport> | null>(null);
  useEffect(() => {
    let active = true;
    transport.current = installChatE04FixtureTransport(setEvidence);
    queueMicrotask(() => { if (active) setReady(true); });
    return () => { active = false; transport.current?.retire(); transport.current = null; };
  }, []);
  return <section data-testid="chat-e04-qa" className="space-y-3">
    <div className="rounded border border-amber-500 p-3 text-sm" role="status">
      <h1 className="font-semibold">E04 synthetic Chat QA</h1>
      <p>Staging administrators only. Synthetic API, page cache and Auto stand-ins. Product flags remain off. Provider calls, cost, product database writes and audit writes: 0.</p>
      <p>The zero values are construction/configuration markers, not measured telemetry.</p>
      <p>History, context, save and retry observations are synthetic client evidence. They do not verify product persistence, provider quality or holdout evaluation.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" data-testid="e04-mode-off" className="min-h-11 rounded border px-3" onClick={() => setMode("off")}>Default off / Chat</button>
      <button type="button" data-testid="e04-mode-refiner" className="min-h-11 rounded border px-3" onClick={() => setMode("refiner")}>Synthetic proposal preview</button>
      <button type="button" data-testid="e04-error-next" className="min-h-11 rounded border px-3" onClick={() => transport.current?.setScenario("error")}>Fail next synthetic answer</button>
      <button type="button" data-testid="e04-include-artifact" className="min-h-11 rounded border px-3" onClick={() => transport.current?.setIncludeArtifact(true)}>Include synthetic Markdown file</button>
      <button type="button" className="min-h-11 rounded border px-3" onClick={() => { transport.current?.reset(); window.location.reload(); }}>Reset QA cache</button>
      <button type="button" className="min-h-11 rounded border px-3" onClick={() => window.location.assign(new URL("/admin/overview", window.location.origin).href)}>Exit QA with a fresh document</button>
    </div>
    <pre data-testid="e04-transport-evidence" className="overflow-auto text-xs" aria-live="polite">{JSON.stringify(evidence)}</pre>
    <details>
      <summary className="min-h-11 cursor-pointer">Synthetic Auto facade checks</summary>
      <div className="flex flex-wrap gap-2">{CHAT_E04_AUTO_ACTIONS.map((action) => <button key={action} type="button"
        data-testid={`e04-auto-${action}`} className="min-h-11 rounded border px-3" onClick={async () => {
          try {
            const response = await fetch(`/api/admin/chat-e2e-fixture?action=${encodeURIComponent(action)}`, { method: "GET", cache: "no-store" });
            if (response.ok) setAuto(await response.json());
            else {
              await discardResponseBody(response);
              setAuto({ unavailable: true, status: response.status });
            }
          } catch { setAuto({ unavailable: true }); }
        }}>{action}</button>)}</div>
      <pre data-testid="e04-auto-evidence" className="overflow-auto text-xs" aria-live="polite">{JSON.stringify(auto)}</pre>
    </details>
    {ready && <div data-testid="e04-real-chat-ui" className="relative h-[680px] overflow-hidden rounded border [&_[data-testid=desktop-chat-shell]]:h-full [&_[data-testid=mobile-chat-shell]]:h-full">
      <SessionProvider session={CHAT_E04_SESSION} refetchInterval={0} refetchOnWindowFocus={false}>
        <ChatPageClient key={mode} guestDefaultModelId="gpt-5-6-luna" mountedSurface="chat"
          initialConversationId={CHAT_E04_CONVERSATION} voiceInputEnabled={true} webSearchBackendReadiness={{ brave: true }}
          promptRefinerMode={mode === "refiner" ? "e2e_fixture" : "off"} />
      </SessionProvider>
    </div>}
  </section>;
}
