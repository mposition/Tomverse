import { AlertTriangle, ShieldQuestion } from "lucide-react";

import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import type { AmuxIncidentBandState } from "@/lib/amux/adminIncidentRead";

/**
 * The red band across the top of the Execution board's three tabs while
 * incident mode is stopping admission. It says what stopped and that cards
 * already running continue.
 *
 * `state: null` is a failed read and is shown as "unavailable" (never hidden,
 * never drawn as calm). When incident mode is off and was read, nothing is
 * drawn. It only reports; incident mode is changed where it always was.
 */
export async function AmuxIncidentBand({ state }: { state: AmuxIncidentBandState | null }) {
  if (state !== null && !state.blocksAdmission) return null;
  const m = (await getAdminMessages(adminAmuxBoardViewsMessages)).incident;
  if (state === null) {
    return <div role="status" data-testid="amux-incident-band" data-state="unknown"
      className="flex items-start gap-3 rounded-2xl border border-dashed border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0"><p className="font-bold">{m.unknownTitle}</p>
        <p className="mt-0.5 text-xs opacity-90">{m.unknownDetail}</p></div>
    </div>;
  }
  return <div role="alert" data-testid="amux-incident-band" data-state={state.valid ? "frozen" : "invalid"}
    className="flex items-start gap-3 rounded-2xl bg-red-600 px-4 py-3 text-sm text-white">
    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
    <div className="min-w-0">
      <p className="font-bold">{state.valid ? m.frozenTitle : m.invalidTitle}</p>
      <p className="mt-0.5 text-xs opacity-90">{state.valid ? m.frozenDetail : m.invalidDetail}
        {state.valid ? " " + m.ticket(state.ticket) : ""}</p>
    </div>
  </div>;
}
