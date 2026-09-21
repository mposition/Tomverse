export type AmuxAuditEvent = {
  action: string;
  taskId?: string;
  worker?: string;
  measured: boolean;
  verdict: string;
  metadata?: Record<string, unknown>;
};

export async function writeAmuxAudit(
  event: AmuxAuditEvent,
): Promise<void> {
  console.info(
    JSON.stringify({
      subsystem: "amux",
      ts: new Date().toISOString(),
      ...event,
    }),
  );
}
