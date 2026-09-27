/**
 * How the admin console describes a failed `/api/admin/**` response.
 *
 * Until the console had a toast viewport, none of this reached anyone, so the
 * copy was never under pressure to be accurate. Two answers in particular were
 * being flattened into a plain error:
 *
 * - **409 with an `approvalId`** is a leftover from the retired two-person
 *   queue. The action was not applied. The operator sends it again; an
 *   eligible administrator's own request runs immediately.
 * - **428** means the administrator's own sign-in is too old for a high-risk
 *   action. The fix is to sign in again, not to retry.
 *
 * Kept separate from any component so the mapping can be tested directly, and
 * so every panel says the same thing about the same response.
 */

import type { AdminLocale } from "@/lib/adminLocale";

export type AdminApiTone = "success" | "error" | "info";

export type AdminApiFailure = {
  message: string;
  tone: AdminApiTone;
  /** True when the operator has to sign in again before retrying. */
  requiresReauthentication: boolean;
  /** Set when a retired two-person response still names an approval row. */
  approvalId: string | null;
};

export const ADMIN_REAUTHENTICATION_MESSAGE =
  "Your administrator sign-in is no longer recent enough for this control. Sign in again, then retry the action.";

export const ADMIN_NETWORK_FAILURE_MESSAGE =
  "The request failed before the server answered. Check the connection and retry.";

export const adminApprovalPendingMessage = (approvalId: string) =>
  `This action was not applied. Two-person approval is no longer used. Send the same request again. Reference ${approvalId}.`;

/**
 * The same sentences for a console read in Korean. English stays the default
 * and is what a caller passing no locale receives. The server's own `error`
 * text is never translated here: it is shown as it arrives.
 */
const ADMIN_API_OUTCOME_KO = {
  reauthentication:
    "관리자 로그인이 이 작업에 필요한 만큼 최근이 아닙니다. 다시 로그인한 뒤 작업을 재시도하세요.",
  approvalPending: (approvalId: string) =>
    `이 작업은 적용되지 않았습니다. 두 번째 관리자 승인은 더 이상 쓰지 않습니다. 같은 요청을 다시 보내세요. 참조 ${approvalId}.`,
  serverAnswered: (fallback: string, status: number) =>
    `${fallback} 서버 응답 코드: ${status}.`,
};

export const describeAdminApiFailure = ({
  status,
  error,
  code,
  approvalId,
  fallback,
  locale = "en",
}: {
  status: number;
  error?: string | null;
  code?: string | null;
  approvalId?: string | null;
  /** What to say when the body carried no usable message. */
  fallback: string;
  /** The console language the sentence is shown in. */
  locale?: AdminLocale;
}): AdminApiFailure => {
  const ko = locale === "ko";
  if (status === 428 || code === "ADMIN_REAUTHENTICATION_REQUIRED") {
    return {
      message: ko ? ADMIN_API_OUTCOME_KO.reauthentication : ADMIN_REAUTHENTICATION_MESSAGE,
      tone: "error",
      requiresReauthentication: true,
      approvalId: null,
    };
  }

  const trimmed = (error || "").trim();

  if (approvalId) {
    return {
      message: ko
        ? ADMIN_API_OUTCOME_KO.approvalPending(approvalId)
        : adminApprovalPendingMessage(approvalId),
      tone: "error",
      requiresReauthentication: false,
      approvalId,
    };
  }

  return {
    message:
      trimmed ||
      (ko
        ? ADMIN_API_OUTCOME_KO.serverAnswered(fallback, status)
        : `${fallback} The server answered ${status}.`),
    tone: "error",
    requiresReauthentication: false,
    approvalId: null,
  };
};
