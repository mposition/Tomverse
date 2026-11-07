import { AlertTriangle, Bell, Clock, Cpu, MessageCircle, RotateCcw, ShieldCheck, Webhook } from "lucide-react";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { DECISION_KIND_TEAM, initialsOf, type DecisionItem, type DecisionKind } from "@/lib/adminDecisionInbox";

const ICONS: Partial<Record<DecisionKind, typeof Clock>> = {
  refund: RotateCcw,
  feedback: MessageCircle,
  privacy: ShieldCheck,
  incident: AlertTriangle,
  webhook: Webhook,
  model: Cpu,
  alert: Bell,
  job: Clock,
};

/**
 * Who is asking: an AI team's pixel figure, a customer's initials, or the
 * system's icon for a decision no one raised.
 */
export function AdminDecisionAvatar({ item, size = 44 }: { item: DecisionItem; size?: number }) {
  const team = DECISION_KIND_TEAM[item.kind];
  if (team) return <AdminPixelAvatar team={team} unit={2} body={false} tile={size} />;
  if (item.requesterEmail) {
    return (
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-pink-500/20 text-sm font-bold text-pink-200"
        style={{ width: size, height: size }}
      >
        {initialsOf(item.requesterEmail)}
      </span>
    );
  }
  const Icon = ICONS[item.kind] ?? Clock;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-300"
      style={{ width: size, height: size }}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}
