import type { ApprovalRequest, Change, CodeRewindMode, CodeRewindPlan, CompactHistoryResult, ChangeInspection, CodeNativeAssignment, CommandInspection, Decision, DeleteHistoryResult, Model, QueueOperation, RecoveryResult, StartInput, Task, UndoChangeResult } from "../contract";
import type { WorkspaceReference } from "../../../tomverse-cli/src/runtime";
import type { ProjectRoot } from "./project-root";
import type { HistoryScope } from "./history-scope";
import type { CodeExecutionMode, NativeFixtureProvider } from "../code-execution";
import type { CodeCliContinuation, CodeContinuation } from "../code-fallback";
import type { DesktopMcpAction, DesktopMcpReply } from "../../../../lib/desktopCodeMcpContract";
import type { CliFixtureInput } from "./cli-fixture-input";

export type Connection = { endpoint: string; key: string };
export type RecordedSession = { requestId: string; storage: string | null; sessionId: string; project: ProjectRoot;
  sourceProject?: ProjectRoot; scope: HistoryScope };
type RecordedItem = RecordedSession & { recordId: string };
type NativeFixtureTask = { runId: string; project: ProjectRoot; fixture: CliFixtureInput; prompt: string;
  mode: "ask" | "plan" | "agent"; protectedRoot: string; connectionKey: string;
  references?: WorkspaceReference[];
  history?: { id: string; directory: string; previous?: Task };
  afterQuota?: { requestId: string; connection: Connection } };
export type WorkerCommand =
  | { type: "catalog"; requestId: string; connection: Connection }
  | { type: "start"; runId: string; project: ProjectRoot; scope: HistoryScope; protectedRoot: string; connection: Connection; input: StartInput;
    references: WorkspaceReference[]; preference: CodeExecutionMode; browserSnapshot?: boolean;
    continuation?: CodeContinuation & { taskId: string; sourceHome: string; sourceProvider: "openai" | "anthropic" } }
  | (NativeFixtureTask & { type: "start-codex-fixture"; clientVersion: string;
    apiSource?: CodeCliContinuation & { scope: HistoryScope; connection: Connection } })
  | (NativeFixtureTask & { type: "start-claude-fixture" })
  | (Omit<NativeFixtureTask, "afterQuota"> & { type: "start-structured-cli-fixture"; provider: "qwen" | "moonshot" | "mistral" | "deepseek" | "zhipu" | "minimax" | "xai" | "google"; clientVersion: string })
  | (Omit<RecordedSession, "requestId"> & { type: "resume"; runId: string; protectedRoot: string; connection: Connection; previous: Task;
    afterClarification?: { requestId: string; text: string };
    afterQuota?: { requestId: string; refusedRequestId: string; text: string;
      continuation?: { segmentId: string; maximumKeyCreditCap: number } } })
  | { type: "code-plugin-result"; runId: string; requestId: string; result: DesktopMcpReply | null }
  | { type: "browser-snapshot-result"; runId: string; requestId: string; text: string | null }
  | { type: "answer"; runId: string; decision: Decision }
  | { type: "follow-up"; runId: string; requestId: string; text: string }
  | { type: "queue"; runId: string; requestId: string; operation: QueueOperation }
  | { type: "stop-background"; runId: string; handle: string }
  | { type: "stop"; runId: string }
  | (RecordedItem & { type: "read-change" })
  | { type: "read-native-change"; requestId: string; taskId: string; recordId: string; directory: string; project: ProjectRoot;
    provider: NativeFixtureProvider }
  | (RecordedItem & { type: "read-command" })
  | (RecordedSession & { type: "check-recovery"; connection: Connection })
  | (RecordedSession & { type: "compact-history"; connection: Connection; protectedRoot: string })
  | { type: "check-native-recovery"; requestId: string; directory: string; sessionId: string;
    segmentId?: string; session: CodeNativeAssignment; project: ProjectRoot;
    provider: "openai" | "anthropic"; fixture: CliFixtureInput; clientVersion: string }
  | { type: "cancel-recovery"; requestId: string }
  | { type: "discard-transient"; sessionId: string }
  | { type: "clean-deleted-history"; protectedRoot: string }
  | (RecordedSession & { type: "delete-history"; storage: string; protectedRoot: string; directoryIdentity: string;
    nativeSource?: { home: string; provider: NativeFixtureProvider; directory: string; identity: string } })
  | (RecordedItem & { type: "undo-change" })
  | (RecordedSession & { type: "plan-rewind"; turn: number })
  | (RecordedSession & { type: "rewind-history"; turn: number; mode: CodeRewindMode })
  | (RecordedSession & { type: "fork-history"; turn: number });

export type WorkerEvent =
  | { type: "catalog"; requestId: string; models: Model[] }
  | { type: "catalog-failed"; requestId: string }
  | { type: "task"; runId: string; task: Task }
  | { type: "code-plugin"; runId: string; requestId: string; action: DesktopMcpAction }
  | { type: "code-plugin-cancel"; runId: string; requestId: string }
  | { type: "browser-snapshot"; runId: string; requestId: string }
  | { type: "approval"; runId: string; request: ApprovalRequest }
  | { type: "follow-up-queued"; runId: string; requestId: string; queued: boolean }
  | { type: "queue-result"; runId: string; requestId: string; ok: boolean }
  | { type: "finished"; runId: string; task: Task }
  | { type: "change-diff"; requestId: string; inspection: ChangeInspection | null }
  | { type: "recovery-detail"; requestId: string; recovery: RecoveryResult; evidence?: Pick<Task, "changes" | "checks" | "transmission" | "apiUsage" | "actual"> }
  | { type: "command-detail"; requestId: string; inspection: CommandInspection | null }
  | { type: "history-deleted"; requestId: string; result: DeleteHistoryResult }
  | { type: "change-undone"; requestId: string; result: UndoChangeResult; changes?: Change[] }
  | { type: "history-compacted"; requestId: string; result: CompactHistoryResult }
  | { type: "rewind-planned"; requestId: string; plan: CodeRewindPlan | null }
  | { type: "history-rewound"; requestId: string; result: "rewound" | "unavailable" | "unconfirmed"; text?: string; undone: number; conflicts: number }
  | { type: "history-forked"; requestId: string; result: "forked" | "unavailable" | "unconfirmed"; id?: string };
