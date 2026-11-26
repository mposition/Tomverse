import { safeLine } from "./display.js";
import { forkSession, listTurns, planRewind, rewindSession, RewindError, type RewindMode, type RewindOutcome, type RewindTurn } from "./rewind.js";
import type { Journal } from "./session.js";

/** The terminal side of rewinding and forking: what is shown and asked. The questions go to the person at the terminal only. */
export type Dialog = { ask: (question: string) => Promise<string | null>; say: (line: string) => void };

const describe = (turn: RewindTurn) => {
    const notes = [
        turn.kind === "follow_up" ? "follow-up" : "",
        turn.changes ? `${turn.changes} file change(s) after it` : "",
        turn.commands ? `${turn.commands} command(s)` : "",
        turn.conversation ? "" : "conversation folded into a summary",
    ].filter(Boolean).join(", ");
    return `${String(turn.index + 1).padStart(3)}. ${safeLine(turn.text)}${notes ? `  (${notes})` : ""}`;
};

/** A turn number as the person types it (from 1) to the index; null when it is not one of the turns. */
export const turnIndex = (text: string | null | undefined, turns: number) => {
    const n = Number((text ?? "").trim());
    return Number.isInteger(n) && n >= 1 && n <= turns ? n - 1 : null;
};

/**
 * /rewind: pick a turn, see what would be put back (and what would conflict, and which commands cannot be undone), choose what to
 * rewind, then do it. Returns what was done, or null when the person cancelled or nothing could be done.
 */
export const rewindDialog = async (journal: Journal, dialog: Dialog, afterCut?: () => void): Promise<RewindOutcome | null> => {
    const turns = listTurns(journal);
    if (!turns.length) {
        dialog.say("There is no turn to rewind to: this session was saved before turns were recorded, or nothing has been asked yet.");
        return null;
    }
    dialog.say("Turns of this session (a rewind takes the chosen message and everything after it out):");
    for (const turn of turns) dialog.say(describe(turn));
    const index = turnIndex(await dialog.ask("Rewind to the start of which turn? (number, Enter to cancel): "), turns.length);
    if (index === null) {
        dialog.say("Nothing was rewound.");
        return null;
    }
    const plan = planRewind(journal, index);
    if (plan.blocked) {
        dialog.say(plan.blocked);
        return null;
    }
    dialog.say(`Rewinding to before turn ${index + 1}: "${safeLine(plan.text)}"`);
    if (plan.files.length) {
        dialog.say("Files this session changed since then, newest first:");
        for (const file of plan.files) dialog.say(`  ${file.outcome === "will_undo" ? "put back" : "CONFLICT "} ${safeLine(file.path)} (${file.kind})${file.reason ? ` -- ${safeLine(file.reason)}` : ""}`);
        if (plan.files.some((file) => file.outcome === "conflict")) dialog.say("A file marked CONFLICT is left as it is (it was changed after the session wrote it, or a later change to it cannot come back first).");
    } else dialog.say("No file was changed by this session from that turn on.");
    if (plan.commands.length) {
        dialog.say("These commands ran in that part. Their effects cannot be undone:");
        for (const command of plan.commands) dialog.say(`  ${safeLine(command.display)}${command.exitCode !== undefined ? ` (exit ${command.exitCode})` : ` (${command.status})`}${command.background ? " [background]" : ""}`);
    }
    const options = plan.conversationAvailable
        ? "[b] files and conversation  [f] files only  [c] conversation only  [N] cancel: "
        : "[f] files only (the conversation there was folded into a summary)  [N] cancel: ";
    const answer = (await dialog.ask(options))?.trim().toLowerCase() ?? "";
    const mode: RewindMode | null = answer === "b" && plan.conversationAvailable ? "both" : answer === "f" ? "files" : answer === "c" && plan.conversationAvailable ? "conversation" : null;
    if (!mode) {
        dialog.say("Nothing was rewound.");
        return null;
    }
    let outcome: RewindOutcome;
    try {
        outcome = rewindSession(journal, index, mode);
    } catch (error) {
        if (error instanceof RewindError) {
            dialog.say(error.message);
            return null;
        }
        throw error;
    }
    if (outcome.conversationCut) afterCut?.();
    for (const item of outcome.undone) dialog.say(`  put back ${safeLine(item.path)}`);
    for (const item of outcome.conflicts) dialog.say(`  NOT put back ${safeLine(item.path)}: ${safeLine(item.reason)}`);
    dialog.say(outcome.conversationCut ? "The conversation was cut back." : "The conversation was left as it was.");
    if (outcome.conversationCut) dialog.say(`The message that was taken out (edit it and send it again if you like):\n${safeLine(plan.text)}`);
    return outcome;
};

/** /fork [n] and `sessions fork`: copy the conversation through turn n (the whole conversation when n is left out) into a new session. */
export const forkThrough = (home: string, journal: Journal, turn: string | undefined) => {
    const turns = listTurns(journal);
    if (!turns.length) throw new RewindError("There is no turn to fork at: this session was saved before turns were recorded, or nothing has been asked yet.");
    const index = turn === undefined ? turns.length - 1 : turnIndex(turn, turns.length);
    if (index === null) throw new RewindError(`The turn must be a number from 1 to ${turns.length}.`);
    const { journal: copy, turns: copied } = forkSession(home, journal, index);
    const id = copy.state.id;
    copy.release();
    return { id, turns: copied };
};
