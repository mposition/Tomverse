"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type Props = {
  userId: string;
  label?: string;
};

export function AdminUserDeleteButton({ userId, label = "Delete" }: Props) {
  const [isArmed, setIsArmed] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (isDeleting) return;
    if (!isArmed) {
      setIsArmed(true);
      dispatchAppToast(
        "Click delete again to permanently remove this user account and all owned data.",
        "info"
      );
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete user.");
      }
      dispatchAppToast("User account deleted.", "success");
      window.location.reload();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to delete user.",
        "error"
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isDeleting}
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-black transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        isArmed
          ? "border-red-500 bg-red-600 text-white hover:bg-red-500"
          : "border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
      }`}
    >
      {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      {isDeleting ? "Deleting" : isArmed ? "Confirm" : label}
    </button>
  );
}
