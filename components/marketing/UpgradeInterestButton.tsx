"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";

export function UpgradeInterestButton({
  plan,
  className,
  children,
}: {
  plan: "Pro" | "Max";
  className: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const [isSending, setIsSending] = useState(false);

  const submit = async () => {
    if (isSending) return;
    setIsSending(true);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!response.ok) throw new Error("Waitlist failed");
      dispatchAppToast(t("billing.waitlistSent"), "success");
    } catch {
      dispatchAppToast(t("billing.waitlistFailed"), "error");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <button type="button" onClick={submit} disabled={isSending} className={className}>
      {isSending ? t("billing.sending") : children}
    </button>
  );
}
