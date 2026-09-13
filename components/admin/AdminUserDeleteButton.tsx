"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminUserDeleteMessages } from "@/lib/adminMessages/userDelete";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";

type Props = {
  userId: string;
  currentUserId?: string;
  label?: string;
};

export function AdminUserDeleteButton({
  userId,
  currentUserId,
  label,
}: Props) {
  const m = useAdminMessages(adminUserDeleteMessages);
  const [isArmed, setIsArmed] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const isCurrentAdmin = Boolean(currentUserId && currentUserId === userId);

  const handleDelete = async () => {
    if (isCurrentAdmin) {
      dispatchAppToast(m.toast.currentAdmin, "info");
      return;
    }
    if (isDeleting) return;
    if (!isArmed) {
      setIsArmed(true);
      dispatchAppToast(m.toast.armed, "info");
      return;
    }
    if (confirmText !== "DELETE USER") {
      dispatchAppToast(m.toast.typeConfirm, "error");
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, confirmText }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(data?.error || m.toast.failed);
      }
      dispatchAppToast(m.toast.deleted, "success");
      window.location.reload();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.failed,
        "error"
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {isArmed ? (
        <input
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder="DELETE USER"
          className="h-9 w-32 rounded-lg border border-red-500/30 bg-zinc-950 px-2 text-xs font-bold text-white outline-none focus:border-red-400"
        />
      ) : null}
      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting || isCurrentAdmin}
        className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-black transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          isArmed
            ? "border-red-500 bg-red-600 text-white hover:bg-red-500"
            : "border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
        }`}
      >
        {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {isCurrentAdmin ? m.currentAdmin : isDeleting ? m.deleting : isArmed ? m.confirm : label ?? m.delete}
      </button>
    </span>
  );
}
