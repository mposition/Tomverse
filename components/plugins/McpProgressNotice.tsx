"use client";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { mcpConnectorCopy } from "@/lib/mcpConnectorCopy";
import type { McpProgressState } from "@/lib/mcpConnectorProgress";
export function McpProgressNotice({ state }: { state: McpProgressState }) {
  const { lang } = useLanguage(); const c = mcpConnectorCopy[lang];
  const labels = { searching: c.searchState, reading: c.readState, approval_required: c.approvalState, no_results: c.noResults, reauth_required: c.expired, server_error: c.serverError, done: c.done };
  if (state === "done") return null;
  return <p role="status" data-testid="mcp-progress" className="mt-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
    {labels[state]}{["approval_required", "reauth_required"].includes(state) && <> · <Link href={`/plugins?lang=${lang}`} className="underline">{c.open}</Link></>}
  </p>;
}
