import type { ReactNode } from "react";
import { CreditCard, RotateCcw, UserMinus, Users } from "lucide-react";

type Props = {
  activePaidUsers: number;
  activeSubscriptions: number;
  pendingRefunds: number;
  approvedRefunds: number;
  rejectedRefunds: number;
  cancelAtPeriodEnd: number;
};

function Card({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone: "blue" | "amber" | "emerald" | "red";
}) {
  const toneClass =
    tone === "blue"
      ? "border-blue-500/25 bg-blue-500/10 text-blue-200"
      : tone === "amber"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
        : tone === "red"
          ? "border-red-500/25 bg-red-500/10 text-red-200"
          : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200";
  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em]">
        {icon}
        {label}
      </div>
      <p className="mt-3 text-3xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
    </div>
  );
}

export function AdminBillingLifecyclePanel({
  activePaidUsers,
  activeSubscriptions,
  pendingRefunds,
  approvedRefunds,
  rejectedRefunds,
  cancelAtPeriodEnd,
}: Props) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          Billing lifecycle
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">
          Refunds and cancellations split
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Separate paid subscribers, refund workflow, and subscriptions scheduled
          to end so finance and support do not treat them as the same state.
        </p>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card
          label="Paid users"
          value={String(activePaidUsers)}
          detail={`${activeSubscriptions} active subscriptions currently synced from Stripe.`}
          icon={<Users className="h-3.5 w-3.5" />}
          tone="blue"
        />
        <Card
          label="Canceling"
          value={String(cancelAtPeriodEnd)}
          detail="Users remain paid until the current Stripe period ends."
          icon={<UserMinus className="h-3.5 w-3.5" />}
          tone="amber"
        />
        <Card
          label="Refund queue"
          value={String(pendingRefunds)}
          detail={`${approvedRefunds} approved and ${rejectedRefunds} rejected requests recorded.`}
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          tone={pendingRefunds > 0 ? "red" : "emerald"}
        />
        <Card
          label="Payment state"
          value={activeSubscriptions > 0 ? "Live" : "Watch"}
          detail="Use Stripe webhooks and billing resync before manual plan changes."
          icon={<CreditCard className="h-3.5 w-3.5" />}
          tone="emerald"
        />
      </div>
    </section>
  );
}
