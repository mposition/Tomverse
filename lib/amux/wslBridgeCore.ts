/**
 * Development runner that pulls Tomverse work from the operator workstation.
 *
 * The code latch ships false. A true latch is a later policy version and is
 * not implied by this module existing. The local AMUX process is an executor,
 * not a second board: this planner never targets `/api/board`.
 */

export const WSL_BRIDGE_CODE_LATCH = false;

export const WSL_BRIDGE_ENV_NAME = "TOMVERSE_AMUX_WSL_BRIDGE";

const SESSION_NAME = /^[A-Za-z0-9._:-]+$/;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONTROL_PLANE_MARKERS = [
  "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_ENABLED",
  "TOMVERSE_AMUX_EXECUTE",
  "TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON",
  "TOMVERSE_INTERNAL_URL",
  "DATABASE_URL",
] as const;

export type BridgeHalt = "running" | "halted";

export type RunningSession = {
  name: string;
  running: boolean;
};

export type LocalDispatchBody = {
  text: string;
  no_board: true;
  msg_id: string;
};

export type BridgeRefusal =
  | "bridge_latch_off"
  | "bridge_disabled"
  | "assignments_halted"
  | "local_unreachable"
  | "worker_not_running"
  | "duplicate_assignment"
  | "brief_absent"
  | "control_plane_leak"
  | "attempt_id_invalid"
  | "session_name_invalid";

export type DispatchPlan =
  | {
      action: "send";
      method: "POST";
      path: string;
      body: LocalDispatchBody;
    }
  | {
      action: "refuse";
      reason: BridgeRefusal;
    };

export const payloadLeaksControlPlane = (text: string) =>
  CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));

export const planLocalDispatch = (input: {
  latch: boolean;
  envValue: string | undefined;
  halt: BridgeHalt;
  localReachable: boolean;
  session: RunningSession | null;
  attemptId: string;
  prompt: string;
  reservedAttemptIds: readonly string[];
}): DispatchPlan => {
  if (!input.latch) return { action: "refuse", reason: "bridge_latch_off" };
  if (input.envValue !== "1") return { action: "refuse", reason: "bridge_disabled" };
  if (input.halt !== "running") return { action: "refuse", reason: "assignments_halted" };
  if (!input.localReachable) return { action: "refuse", reason: "local_unreachable" };
  if (!ATTEMPT_ID.test(input.attemptId)) {
    return { action: "refuse", reason: "attempt_id_invalid" };
  }
  if (input.reservedAttemptIds.includes(input.attemptId)) {
    return { action: "refuse", reason: "duplicate_assignment" };
  }
  if (!input.session?.running) return { action: "refuse", reason: "worker_not_running" };
  if (!SESSION_NAME.test(input.session.name)) {
    return { action: "refuse", reason: "session_name_invalid" };
  }
  if (
    !input.prompt.includes("Approved execution brief:\n") ||
    input.prompt.includes("Approved execution brief:\n(none)")
  ) {
    return { action: "refuse", reason: "brief_absent" };
  }
  if (payloadLeaksControlPlane(input.prompt)) {
    return { action: "refuse", reason: "control_plane_leak" };
  }

  return {
    action: "send",
    method: "POST",
    path: `/api/sessions/${encodeURIComponent(input.session.name)}/send`,
    body: {
      text: input.prompt,
      no_board: true,
      msg_id: input.attemptId,
    },
  };
};

export type SendInterpretation =
  | { kind: "pending"; completion: false; retry: false }
  | { kind: "dual_board"; completion: false; retry: false }
  | { kind: "unknown"; completion: false; retry: false; readBack: true }
  | { kind: "refused"; completion: false; retry: false };

/**
 * A local HTTP success means the message was accepted. It does not mean the
 * Tomverse attempt is finished. A refused no_board flag means the local board
 * would mint its own card, so the attempt must not be treated as dispatched.
 */
export const interpretSendResponse = (input: {
  transport: "ok" | "unknown";
  status?: number;
  body?: {
    ok?: boolean;
    id?: string | number | null;
    no_board_refused?: string | null;
  };
}): SendInterpretation => {
  if (input.transport === "unknown") {
    return { kind: "unknown", completion: false, retry: false, readBack: true };
  }
  const status = input.status ?? 0;
  if (status < 200 || status >= 300) {
    return { kind: "refused", completion: false, retry: false };
  }
  const refused = input.body?.no_board_refused;
  if (typeof refused === "string" && refused.length > 0) {
    return { kind: "dual_board", completion: false, retry: false };
  }
  const id = input.body?.id;
  if (input.body?.ok === true || (id !== null && id !== undefined && `${id}`.length > 0)) {
    return { kind: "pending", completion: false, retry: false };
  }
  return { kind: "unknown", completion: false, retry: false, readBack: true };
};

export const decideAfterReadBack = (found: true | false | "lookup_failed") => {
  if (found === "lookup_failed") return { send: false, halt: true };
  if (found === true) return { send: false, halt: false };
  return { send: true, halt: false };
};

export const classifyBridgeResult = (
  outcome: string,
):
  | { accept: true; toStatus: "review" | "todo" | "blocked" }
  | { accept: false; reason: "result_not_allowed" } => {
  if (outcome === "succeeded") return { accept: true, toStatus: "review" };
  if (outcome === "failed") return { accept: true, toStatus: "todo" };
  if (outcome === "blocked") return { accept: true, toStatus: "blocked" };
  return { accept: false, reason: "result_not_allowed" };
};

export const acceptLateResult = (input: {
  generation: number;
  liveGeneration: number | null;
  leaseExpiresAt: number;
  now: number;
}) =>
  input.liveGeneration === input.generation && input.leaseExpiresAt > input.now;

export type BridgeTickResult =
  | { disposition: "idle"; reason: BridgeRefusal }
  | { disposition: "pending"; attemptId: string }
  | { disposition: "dual_board"; attemptId: string }
  | { disposition: "halted"; attemptId: string }
  | { disposition: "refused"; attemptId: string }
  | { disposition: "settled"; attemptId: string; toStatus: "review" | "todo" | "blocked" }
  | { disposition: "result_rejected"; attemptId: string };

type SendReply = {
  transport: "ok" | "unknown";
  status?: number;
  body?: {
    ok?: boolean;
    id?: string | number | null;
    no_board_refused?: string | null;
  };
};

/**
 * One pull of an already-approved delivery. Transports are injected so the
 * tick can be proven without opening a socket. The shipped latch makes the
 * first branch refuse before either transport is called.
 */
export const runBridgeTick = async (input: {
  latch: boolean;
  envValue: string | undefined;
  halt: BridgeHalt;
  localReachable: boolean;
  session: RunningSession | null;
  attemptId: string;
  prompt: string;
  reservedAttemptIds: readonly string[];
  generation: number;
  liveGeneration: number | null;
  leaseExpiresAt: number;
  now: number;
  workerOutcome: string | null;
  send: (body: LocalDispatchBody) => Promise<SendReply>;
  readBack: (attemptId: string) => Promise<true | false | "lookup_failed">;
}): Promise<BridgeTickResult> => {
  const plan = planLocalDispatch({
    latch: input.latch,
    envValue: input.envValue,
    halt: input.halt,
    localReachable: input.localReachable,
    session: input.session,
    attemptId: input.attemptId,
    prompt: input.prompt,
    reservedAttemptIds: input.reservedAttemptIds,
  });
  if (plan.action === "refuse") {
    return { disposition: "idle", reason: plan.reason };
  }

  let interpretation = interpretSendResponse(await input.send(plan.body));
  if (interpretation.kind === "unknown") {
    const found = await input.readBack(input.attemptId);
    const decision = decideAfterReadBack(found);
    if (decision.halt) return { disposition: "halted", attemptId: input.attemptId };
    if (!decision.send) return { disposition: "pending", attemptId: input.attemptId };
    interpretation = interpretSendResponse(await input.send(plan.body));
    if (interpretation.kind === "unknown") {
      return { disposition: "halted", attemptId: input.attemptId };
    }
  }
  if (interpretation.kind === "dual_board") {
    return { disposition: "dual_board", attemptId: input.attemptId };
  }
  if (interpretation.kind !== "pending") {
    return { disposition: "refused", attemptId: input.attemptId };
  }
  if (input.workerOutcome === null) {
    return { disposition: "pending", attemptId: input.attemptId };
  }
  if (
    !acceptLateResult({
      generation: input.generation,
      liveGeneration: input.liveGeneration,
      leaseExpiresAt: input.leaseExpiresAt,
      now: input.now,
    })
  ) {
    return { disposition: "result_rejected", attemptId: input.attemptId };
  }
  const result = classifyBridgeResult(input.workerOutcome);
  if (!result.accept) return { disposition: "result_rejected", attemptId: input.attemptId };
  return {
    disposition: "settled",
    attemptId: input.attemptId,
    toStatus: result.toStatus,
  };
};
