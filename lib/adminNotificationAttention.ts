/** A delivered in-app halt still needs a person's acknowledgement. */
export const DAILY_PRODUCT_AGENT_NOTICE_TARGET = "DailyProductAgentRun";
export const ADMIN_NOTIFICATION_ATTENTION_WHERE = {
  acknowledgedAt: null,
  OR: [{ status: "failed" }, { channel: "in_app", targetType: DAILY_PRODUCT_AGENT_NOTICE_TARGET }],
};
export const adminNotificationNeedsAcknowledgement = (row: {
  status: string; channel: string; targetType?: string | null; acknowledgedAt?: unknown;
}) => !row.acknowledgedAt && (row.status === "failed" ||
  (row.channel === "in_app" && row.targetType === DAILY_PRODUCT_AGENT_NOTICE_TARGET));
