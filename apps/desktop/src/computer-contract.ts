import { z } from "zod";

/** The typed commands of the Code screen's "computer" controls. The renderer names a window by an id it was just given; the main process looks the window up itself. */
export const computerCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  /** The windows the person can choose now (never a browser, terminal, password manager, system or Tomverse's own window). */
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("select"), id: z.string().regex(/^[0-9a-f]{1,16}:[0-9]{1,10}$/) }).strict(),
  z.object({ type: z.literal("revoke") }).strict(),
  /** `confirmed`: the person read "the agent sees and operates the window you choose" and agreed; turning on without it is refused. */
  z.object({ type: z.literal("enable"), enabled: z.boolean(), confirmed: z.boolean() }).strict(),
  /** The person takes direct control (the agent stops), or hands it back. */
  z.object({ type: z.enum(["take", "give"]) }).strict(),
]);
export type ComputerCommand = z.infer<typeof computerCommand>;

export type ComputerWindowRow = { id: string; title: string; app: string };

export type ComputerNotice = "user-input" | "stop-key" | "taken" | "window-closed" | "stop-key-unavailable";

export type ComputerState = {
  /** This operating system has an implementation that was checked. Elsewhere the feature says so and does nothing. */
  supported: boolean;
  /** The person's switch (off by default). */
  enabled: boolean;
  selected: ComputerWindowRow | null;
  /** working: a request of the agent is being done; stopped: the person took control, or touched the mouse or keyboard. */
  control: "idle" | "working" | "stopped";
  /** The global key that stops the agent from anywhere, as the person types it; null when it could not be registered. */
  stopKey: string | null;
  notice: ComputerNotice | null;
};

export type ComputerResult = { state: ComputerState; windows?: ComputerWindowRow[]; hidden?: number };
