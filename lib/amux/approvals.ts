import "server-only";

import type { Session } from "next-auth";
import {
  runWithAdminApproval,
} from "@/lib/adminApproval";
import type { AdminApprovalContext } from "@/lib/adminSoleApproverExecution";

type AmuxApprovalInput<T> = {
  session: Session;
  request?: Request;
  action: string;
  taskId: string;
  reason: string;
  payload?: Record<string, unknown>;
  operation: (context: AdminApprovalContext) => Promise<T>;
};

/**
 * Irreversible/high-risk AMUX operations use Tomverse's canonical approval
 * authority. Ordinary scheduler selection and CAS ownership claims do not.
 */
export async function runWithAmuxApproval<T>(
  input: AmuxApprovalInput<T>,
): Promise<T> {
  const action = input.action.startsWith("amux.")
    ? input.action
    : `amux.${input.action}`;

  return runWithAdminApproval(
    {
      session: input.session,
      request: input.request,
      action,
      targetType: "AmuxWorkItem",
      targetId: input.taskId,
      reason: input.reason,
      payload: input.payload || {},
    },
    input.operation,
  );
}
