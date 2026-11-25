"use client";

import { useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { describeAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";

export function VoiceModelSettings({ initialModel }: { initialModel: string }) {
  const copy = useAdminMessages(adminModelsBoardMessages).voice;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState(initialModel);
  const [candidate, setCandidate] = useState(initialModel);
  const [options, setOptions] = useState<string[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  async function request(action: "check" | "save") {
    setBusy(true);
    setNotice("");
    setFailure(null);
    try {
      const response = action === "check"
        ? await adminFetch("/api/admin/app-settings?section=voice-model", { cache: "no-store" })
        : await adminFetch("/api/admin/app-settings", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceConversationModel: candidate }),
        });
      const data = await response.json();
      if (!response.ok) {
        setFailure(describeAdminApiFailure({ status: response.status, error: data.error, locale, fallback: copy.failed }));
        return;
      }
      setCurrent(data.modelId);
      setCandidate(data.modelId);
      if (action === "check") {
        setOptions(data.options ?? []);
        setCanWrite(data.canWrite);
        if (data.options === null) setNotice(copy.unavailable);
        else if (!data.options.some((id: string) => id !== data.modelId)) setNotice(copy.noAlternative);
      } else {
        setNotice(copy.saved);
      }
    } catch {
      setNotice(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return <AdminTile title={copy.title} description={copy.description}>
    <p className="text-sm text-zinc-300">{copy.current} <strong className="text-white">{current}</strong></p>
    <div className="flex flex-wrap items-end gap-3">
      <button type="button" disabled={busy} onClick={() => void request("check")}
        className="min-h-10 rounded-xl border border-zinc-700 px-3 text-sm font-bold text-zinc-100 disabled:opacity-50">
        {copy.check}
      </button>
      {options.length > 0 && <>
        <label className="flex flex-col gap-1 text-xs font-bold text-zinc-300">
          {copy.model}
          <select className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white"
            value={candidate} disabled={busy || !canWrite} onChange={event => { setCandidate(event.target.value); setNotice(""); }}>
            {!options.includes(current) && <option value={current} disabled>{current}</option>}
            {options.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <AdminWriteButton stepUp writable={canWrite} requiredRole="ops:write"
          disabled={busy || candidate === current} onClick={() => void request("save")}>{copy.save}</AdminWriteButton>
      </>}
    </div>
    {notice && <p role="status" className="text-sm text-zinc-300">{notice}</p>}
    {failure && <AdminApiFailureNotice failure={failure} returnTo="/admin/models?tab=defaults" />}
  </AdminTile>;
}
