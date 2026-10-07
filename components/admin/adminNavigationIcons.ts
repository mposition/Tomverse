import {
  Activity,
  ArrowUpFromLine,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CircleDollarSign,
  ClipboardCheck,
  Cloud,
  CreditCard,
  Database,
  Gauge,
  GitPullRequest,
  Inbox,
  KeyRound,
  LifeBuoy,
  Mail,
  ListChecks,
  Megaphone,
  RotateCcw,
  Route,
  Search,
  Send,
  Settings2,
  Share2,
  ShieldCheck,
  Timer,
  Users,
  Workflow,
} from "lucide-react";
import { ADMIN_NAVIGATION, ADMIN_UNLISTED_PAGES } from "@/lib/adminNavigation";

/**
 * Icon per navigation entry, keyed by id.
 *
 * Held apart from `lib/adminNavigation.ts` so that module stays importable from
 * plain Node (the unit tests read the route table directly) and from server
 * components that only need the counts.
 */
export const ADMIN_NAV_ICONS = {
  overview: Gauge,
  "work-queue": ListChecks,
  analytics: BarChart3,
  users: Users,
  support: LifeBuoy,
  billing: CreditCard,
  refunds: RotateCcw,
  "credit-ledger": CircleDollarSign,
  providers: Activity,
  models: Bot,
  routing: Route,
  infrastructure: Cloud,
  automation: Timer,
  alerts: Bell,
  "email-delivery": Send,
  "email-campaigns": Megaphone,
  marketing: Share2,
  "engineering-agent": GitPullRequest,
  "sre-ops": Activity,
  "agent-digests": ClipboardCheck,
  office: Building2,
  platform: Settings2,
  "amux-backlog": Inbox,
  "amux-promotion": ArrowUpFromLine,
  "amux-execution": Workflow,
  "email-policy": Mail,
  audit: ShieldCheck,
  retention: Database,
  "admin-access": KeyRound,
  search: Search,
} as const satisfies Record<string, typeof Gauge>;

export type AdminNavIconKey = keyof typeof ADMIN_NAV_ICONS;

export const adminNavIcon = (id: string) =>
  ADMIN_NAV_ICONS[id as AdminNavIconKey] || Gauge;

/**
 * Every id in the route table has an icon.
 *
 * Enforced here rather than by a test: adding a navigation entry without an
 * icon would otherwise render a silently generic gauge in the sidebar, which no
 * one notices until an operator asks why two entries look identical.
 */
const missingIcon = [...ADMIN_NAVIGATION, ...ADMIN_UNLISTED_PAGES].find(
  (item) => !(item.id in ADMIN_NAV_ICONS)
);
if (missingIcon) {
  throw new Error(
    `Admin navigation entry "${missingIcon.id}" has no icon in ADMIN_NAV_ICONS.`
  );
}
