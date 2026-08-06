import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  CircleDollarSign,
  Cloud,
  CreditCard,
  Database,
  Gauge,
  KeyRound,
  LifeBuoy,
  ListChecks,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Timer,
  Users,
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
  infrastructure: Cloud,
  automation: Timer,
  alerts: Bell,
  platform: Settings2,
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
