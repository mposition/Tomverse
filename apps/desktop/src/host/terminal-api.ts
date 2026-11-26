import { terminalCommand, type TerminalInfo, type TerminalListing, type TerminalReplayResult } from "../terminal-contract";
import type { TerminalReadReply } from "../../../tomverse-cli/src/terminal-read.js";
import type { TerminalHost } from "./terminal-host";

export type TerminalWorkspace = { task: string; cwd: string };
export type TerminalApiOptions = {
  host: TerminalHost;
  /** The open task and the folder its terminals start in, or null when terminals are not allowed right now. Resolved by the host. */
  workspace: () => TerminalWorkspace | null;
  enabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
};

/** Runs the typed terminal commands from the window against the terminals of the task that is open. */
export function createTerminalApi(options: TerminalApiOptions) {
  const { host } = options;
  const listing = (task: string): TerminalListing => ({ enabled: options.enabled(), terminals: options.enabled() ? host.list(task) : [] });
  return {
    async run(value: unknown): Promise<TerminalListing | TerminalInfo | TerminalReplayResult | void> {
      const command = terminalCommand.parse(value);
      if (command.type === "set-enabled") {
        options.setEnabled(command.enabled);
        if (!command.enabled) await host.closeAll();
        return;
      }
      const current = options.workspace();
      if (command.type === "list") return listing(current?.task === command.task ? command.task : "");
      if (!options.enabled()) throw new Error("The terminal is off.");
      if (!current) throw new Error("Open a task in a project folder first.");
      switch (command.type) {
        case "open":
          // The task must be the one on screen; the folder comes from the host, never from the window.
          if (command.task !== current.task) throw new Error("The task changed.");
          return host.open(current.task, current.cwd, command.cols, command.rows);
        case "attach": return host.attach(command.terminal);
        case "input": host.input(command.terminal, command.data); return;
        case "resize": host.resize(command.terminal, command.cols, command.rows); return;
        case "share": host.share(command.terminal, command.shared); return;
        case "close": await host.close(command.terminal); return;
      }
    },
    /** The agent's read: only for the open task, only when terminals are on, and only shared terminals. */
    read(request: { terminal?: number; lines: number }): TerminalReadReply | null {
      const current = options.workspace();
      if (!options.enabled() || !current) return null;
      return host.read(current.task, request);
    },
  };
}
