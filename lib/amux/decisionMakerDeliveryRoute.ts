import "server-only";

import { dmRouteErrorResponse, type DmRouteRefusal } from "@/lib/amux/decisionMakerInternalRoute";
import { DecisionMakerJudgmentWriteError } from "@/lib/amux/decisionMakerJudgmentStore";

/**
 * The answer to an error the delivery routes' stores threw (stage S2-2b3,
 * app/api/internal/amux/decision-maker/deliveries/**): the judgment store's
 * own codes each have their answer, and everything else -- the request and
 * body stores' errors, a boundary deadline, an outcome the database left
 * unknown -- is the Decision Maker routes' shared answer
 * (`dmRouteErrorResponse`), which never claims a write that may have
 * committed. No message, which could carry a value, reaches the answer.
 */
export const dmDeliveryRouteErrorResponse = (
  operation: string,
  error: unknown,
  refused: DmRouteRefusal,
): Response => {
  if (error instanceof DecisionMakerJudgmentWriteError) {
    switch (error.code) {
      case "invalid_input":
        return refused(400, "invalid_input");
      case "settings_unreadable":
        return refused(503, "dm_settings_unreadable");
      case "state_unreadable":
        return refused(503, "dm_state_unreadable");
      case "no_operator":
        // A person's operation only; no delivery route calls one.
        break;
    }
  }
  return dmRouteErrorResponse(operation, error, refused);
};
