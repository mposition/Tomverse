"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Puzzle, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { mcpConnectorCopy } from "@/lib/mcpConnectorCopy";
import { selectedMcpConnection, selectMcpConnection, subscribeMcpSelection } from "@/lib/mcpConnectorSelection";
import { readPluginInventory, type PluginInventory } from "@/lib/mcpConnectorClientContract";
export function McpChatPicker({ conversationId, disabled }: { conversationId: string | null; disabled?: boolean }) {
  const { lang } = useLanguage(); const c = mcpConnectorCopy[lang];
  const [inventory, setInventory] = useState<PluginInventory | null>(null), [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useModalDialog({ open, dialogRef: panel, panelRef: panel, onClose: () => setOpen(false) });
  const selected = useSyncExternalStore(subscribeMcpSelection, () => selectedMcpConnection(conversationId) || "", () => "");
  const apply = useCallback((data: PluginInventory | null) => {
    setInventory(data);
    if (!data?.connections.some(conn => conn.id === selectedMcpConnection(conversationId) && conn.status === "connected")) selectMcpConnection(conversationId);
  }, [conversationId]);
  useEffect(() => {
    const controller = new AbortController();
    void readPluginInventory(controller.signal).then(data => { if (!controller.signal.aborted) apply(data); }).catch(() => {});
    return () => { controller.abort(); selectMcpConnection(conversationId); };
  }, [apply, conversationId]);
  if (!inventory?.enabled) return null;
  return <>
    <button disabled={disabled} type="button" aria-label={c.select} title={selected ? `${c.select}: ${inventory.connections.find(conn => conn.id === selected)?.name || ""}` : c.select} aria-haspopup="dialog" aria-expanded={open} data-testid="chat-plugin-picker"
      onClick={() => { setOpen(true); void readPluginInventory().then(apply).catch(() => {}); }}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-blue-500 md:[@media(pointer:fine)]:h-9 md:[@media(pointer:fine)]:w-9 ${selected ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200" : "text-zinc-600 dark:text-zinc-300"}`}><Puzzle size={19} aria-hidden="true" /></button>
    {open && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="chat-plugin-title" className="grid max-h-[80dvh] w-full max-w-sm gap-4 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-900 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
        <div className="flex items-center justify-between gap-4"><h2 id="chat-plugin-title" className="font-semibold">{c.select}</h2><button type="button" aria-label={c.close} onClick={() => setOpen(false)} className="flex h-11 w-11 items-center justify-center"><X size={20} /></button></div>
        <label className="grid gap-2">{c.title}<select disabled={disabled} data-testid="chat-plugin-select" value={selected} onChange={e => selectMcpConnection(conversationId, e.target.value || undefined)} className="min-h-11 max-w-full rounded-lg border border-zinc-300 bg-white px-2 dark:border-zinc-700 dark:bg-zinc-800">
          <option value="">{c.none}</option>{inventory.connections.filter(conn => conn.status === "connected" && conn.grants.length > 0).map(conn => <option key={conn.id} value={conn.id}>{conn.name}</option>)}
        </select></label><p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{c.sharing}</p><Link href={`/plugins?lang=${lang}`} className="inline-flex min-h-11 items-center text-blue-600 dark:text-blue-300">{c.open}</Link>
      </div>
    </div>, document.body)}
  </>;
}