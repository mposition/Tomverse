"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Mail,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type AttentionItem = {
  title: string;
  detail: string;
  tone: string;
};

type EnvCheck = {
  name: string;
  configured: boolean;
  description: string;
};

type Props = {
  generatedAt: string;
  totalUsers: number;
  paidUsers: number;
  activeSubscriptions: number;
  openFeedbackCount: number;
  pendingRefundCount: number;
  providerAvailableCount: number;
  providerTotalCount: number;
  monthSpendLabel: string;
  needsAttention: AttentionItem[];
  envChecks: EnvCheck[];
};

const toneClass = (tone: string) => {
  if (tone === "red") return "border-red-500/30 bg-red-500/10 text-red-100";
  if (tone === "amber") return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  if (tone === "blue") return "border-blue-500/30 bg-blue-500/10 text-blue-100";
  return "border-zinc-800 bg-zinc-900/70 text-zinc-200";
};

export function AdminOperationsPanel({
  generatedAt,
  totalUsers,
  paidUsers,
  activeSubscriptions,
  openFeedbackCount,
  pendingRefundCount,
  providerAvailableCount,
  providerTotalCount,
  monthSpendLabel,
  needsAttention,
  envChecks,
}: Props) {
  const [isSendingTestEmail, setIsSendingTestEmail] = useState(false);

  const copyReport = async () => {
    const missingEnv = envChecks
      .filter((check) => !check.configured)
      .map((check) => check.name)
      .join(", ");
    const attention = needsAttention
      .map((item) => `- ${item.title}: ${item.detail}`)
      .join("\n");
    const report = [
      "Tomverse Admin Snapshot",
      `Generated: ${generatedAt} UTC`,
      `Users: ${totalUsers} total / ${paidUsers} paid / ${activeSubscriptions} active subscriptions`,
      `Providers: ${providerAvailableCount}/${providerTotalCount} available`,
      `Estimated monthly spend: ${monthSpendLabel}`,
      `Open feedback: ${openFeedbackCount}`,
      `Pending refunds: ${pendingRefundCount}`,
      `Missing environment setup: ${missingEnv || "none"}`,
      "Needs attention:",
      attention || "- none",
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      dispatchAppToast("Admin snapshot copied.", "success");
    } catch {
      dispatchAppToast("Could not copy admin snapshot.", "error");
    }
  };

  const sendTestEmail = async () => {
    if (isSendingTestEmail) return;
    setIsSendingTestEmail(true);
    try {
      const response = await fetch("/api/admin/test-email", {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        id?: string | null;
      } | null;
      if (!response.ok) {
        throw new Error(data?.error || "Could not send test email.");
      }
      dispatchAppToast(
        data?.id ? `Test email sent. Resend ID: ${data.id}` : "Test email sent.",
        "success"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not send test email.",
        "error"
      );
    } finally {
      setIsSendingTestEmail(false);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-blue-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            Command center
          </div>
          <h2 className="mt-3 text-2xl font-black text-white">
            Launch operations snapshot
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Review launch blockers, copy a support-ready status report, and jump to the
            operational systems that usually need action.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={copyReport}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-500"
          >
            <Clipboard className="h-4 w-4" />
            Copy snapshot
          </button>
          <button
            type="button"
            onClick={sendTestEmail}
            disabled={isSendingTestEmail}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-black text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Mail className="h-4 w-4" />
            {isSendingTestEmail ? "Sending..." : "Send test email"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Users
          </p>
          <p className="mt-2 text-2xl font-black text-white">{totalUsers}</p>
          <p className="mt-1 text-xs text-zinc-400">
            {paidUsers} paid / {activeSubscriptions} active subscriptions
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Providers
          </p>
          <p className="mt-2 text-2xl font-black text-white">
            {providerAvailableCount}/{providerTotalCount}
          </p>
          <p className="mt-1 text-xs text-zinc-400">available right now</p>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Work queue
          </p>
          <p className="mt-2 text-2xl font-black text-white">
            {openFeedbackCount + pendingRefundCount}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {openFeedbackCount} feedback / {pendingRefundCount} refunds
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Spend estimate
          </p>
          <p className="mt-2 text-2xl font-black text-white">{monthSpendLabel}</p>
          <p className="mt-1 text-xs text-zinc-400">reserved token budget basis</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_0.9fr]">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-300">
              Needs attention
            </h3>
            <Link
              href="#providers"
              className="inline-flex items-center gap-1 text-xs font-bold text-blue-300 hover:text-blue-200"
            >
              Providers <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="mt-3 grid gap-2">
            {needsAttention.length === 0 ? (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200">
                No immediate operational issues detected.
              </div>
            ) : (
              needsAttention.slice(0, 4).map((item) => (
                <div
                  key={`${item.title}-${item.detail}`}
                  className={`rounded-xl border px-3 py-2 ${toneClass(item.tone)}`}
                >
                  <p className="text-sm font-black">{item.title}</p>
                  <p className="mt-1 text-xs leading-5 opacity-80">{item.detail}</p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-300">
            Production setup
          </h3>
          <div className="mt-3 grid gap-2">
            {envChecks.map((check) => (
              <div
                key={check.name}
                className="flex items-start justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-black text-zinc-200">{check.name}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">
                    {check.description}
                  </p>
                </div>
                {check.configured ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <a
          href="https://dashboard.stripe.com"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
        >
          Stripe dashboard <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a
          href="https://railway.app/dashboard"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
        >
          Railway dashboard <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
        >
          Open app <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
