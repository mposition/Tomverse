"use client";

import { useEffect, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type AdminNote = {
  id: string;
  targetType: string;
  targetId: string;
  body: string;
  createdByEmail: string | null;
  createdAt: string;
};

type Props = {
  targetType: "User" | "RefundRequest" | "Feedback" | "BillingConfig" | "Model";
  targetId: string;
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminNotesBox({ targetType, targetId }: Props) {
  const [notes, setNotes] = useState<AdminNote[]>([]);
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadNotes = async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams({ targetType, targetId });
        const response = await fetch(`/api/admin/notes?${params.toString()}`, {
          cache: "no-store",
        });
        const data = (await response.json().catch(() => null)) as
          | { notes?: AdminNote[]; error?: string }
          | null;
        if (!response.ok || !data?.notes) {
          throw new Error(data?.error || "Failed to load notes.");
        }
        if (!cancelled) setNotes(data.notes);
      } catch (error) {
        if (!cancelled) {
          dispatchAppToast(
            error instanceof Error ? error.message : "Failed to load notes.",
            "error"
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    loadNotes();
    return () => {
      cancelled = true;
    };
  }, [targetId, targetType]);

  const saveNote = async () => {
    const trimmed = body.trim();
    if (!trimmed || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, body: trimmed }),
      });
      const data = (await response.json().catch(() => null)) as
        | { note?: AdminNote; error?: string }
        | null;
      if (!response.ok || !data?.note) {
        throw new Error(data?.error || "Failed to save note.");
      }
      setNotes((current) => [data.note!, ...current]);
      setBody("");
      dispatchAppToast("Admin note saved.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to save note.",
        "error"
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
            Internal notes
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Visible only to Admin operators.
          </p>
        </div>
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-zinc-500" /> : null}
      </div>

      <div className="mt-3 grid gap-2">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add context, follow-up, risk notes, or customer handling details..."
          rows={3}
          className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
        />
        <button
          type="button"
          onClick={saveNote}
          disabled={isSaving || body.trim().length === 0}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
          Save note
        </button>
      </div>

      <div className="mt-4 grid gap-2">
        {notes.length === 0 ? (
          <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
            No internal notes yet.
          </p>
        ) : (
          notes.map((note) => (
            <article key={note.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
              <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">{note.body}</p>
              <p className="mt-2 text-xs text-zinc-500">
                {note.createdByEmail || "Admin"} · {dateLabel(note.createdAt)} UTC
              </p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
