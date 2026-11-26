import { createInterface } from "node:readline/promises";
import { renderFileDiff, safeLine, safeText } from "./display.js";
import type { ApprovalView, Prompter } from "./agent.js";
import { ApprovalMemory, type RememberedRule } from "./approvals.js";

/**
 * Questions to the person at the terminal. Answers are read from the TTY
 * only; a prompter does not exist in non-interactive runs, so nothing piped
 * in, written in a file or produced by the model can answer an approval.
 */

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** One line from the terminal, or null on end of input / Ctrl+C. */
export const askLine = async (question: string): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let interrupted = false;
    rl.on("SIGINT", () => {
        interrupted = true;
        rl.close();
    });
    try {
        const answer = await rl.question(question);
        return interrupted ? null : answer;
    } catch {
        return null;
    } finally {
        rl.close();
    }
};

const yes = (answer: string | null) => answer !== null && /^(y|yes)$/i.test(answer.trim());

export const renderApproval = (view: ApprovalView) => {
    const lines: string[] = [];
    if (view.patch) {
        lines.push(`── Approval needed: change ${view.patch.length} file(s) ──`);
        if (view.explanation) lines.push(safeLine(view.explanation));
        for (const edit of view.patch) {
            const notes = [edit.bom ? "keeps BOM" : "", edit.eol === "crlf" ? (edit.action === "create" ? "CRLF line endings" : "keeps CRLF") : edit.eol === "mixed" ? "mixed line endings" : ""].filter(Boolean).join(", ");
            lines.push("");
            lines.push(`${edit.action.toUpperCase()} ${safeLine(edit.path)}${notes ? ` (${notes})` : ""}`);
            lines.push(renderFileDiff(edit.path, edit.beforeText, edit.afterText));
        }
    } else if (view.web) {
        lines.push("── Approval needed: read a web page ──");
        lines.push(`  site:    ${safeLine(view.web.host)}`, `  address: ${safeLine(view.web.url)}`);
        lines.push("  A plain request for this address goes to that site: no cookies, no login, nothing from your folder. Its text is sent to the model as untrusted reference material.");
    } else if (view.command) {
        const plan = view.command;
        lines.push(plan.background ? "── Approval needed: run a command in the BACKGROUND ──" : "── Approval needed: run a command ──");
        if (plan.background) lines.push("  It keeps running in the background after you approve, with no time limit, until the task ends or the model stops it.");
        if (plan.mode === "argv") lines.push(`  program: ${safeLine(plan.file)}`, `  argv:    ${safeLine(plan.display)}`);
        else {
            // One shown line per real line, so a newline (a second command) is never
            // confused with the two characters "\n" inside a line.
            const commandLines = plan.display.split("\n");
            lines.push(`  shell:   ${safeLine(plan.file)} ${plan.args.slice(0, -1).map(safeLine).join(" ")}`);
            lines.push(`  command${commandLines.length > 1 ? ` (${commandLines.length} lines)` : ""}:`);
            for (const line of commandLines) lines.push(`    | ${safeText(line)}`);
        }
        lines.push(`  folder:  ${safeLine(plan.cwd)}`);
        lines.push(plan.background ? "  timeout: none (background)" : `  timeout: ${Math.round(plan.timeoutMs / 1000)} s`);
        lines.push(`  env:     ${plan.envNames.length} variables (${plan.envNames.join(", ")}); your Tomverse key is not passed`);
        lines.push(view.sandboxed
            ? "  It runs inside the command sandbox you turned on. What the sandbox enforces on this computer is listed in its settings."
            : "  It runs with your account's permissions and is not sandboxed: it can change files outside this folder and use the network.");
    }
    if (view.origin && lines.length) lines.splice(1, 0, `  asked by subagent ${safeLine(view.origin.id)}: ${safeLine(view.origin.title)}`);
    return lines.map((l) => safeText(l)).join("\n");
};

/** What is done without asking, shown so the person still sees every action. */
export const renderRemembered = (view: ApprovalView, rule: RememberedRule) => {
    if (rule === "web_host") return safeText(`  · reading without asking (you allowed this site for this run): ${safeLine(view.web!.url)}`);
    if (rule === "browser_origin") return safeText(`  · acting in the browser without asking (you allowed this site for this run): ${safeLine(view.browser!.selector)} on ${safeLine(view.browser!.origin)}`);
    if (rule === "file_edits") {
        const body = renderApproval(view).split("\n").slice(1).join("\n");
        return [`── Changing ${view.patch!.length} file(s) without asking: you allowed file edits for this run (/approvals clear to stop) ──`, body].join("\n");
    }
    return safeText(`  · running without asking (you allowed this exact command for this run): ${safeLine(view.command!.display)}`);
};

/** The question for one approval, with "always" only where it can be remembered. */
export const approvalQuestion = (view: ApprovalView, canRemember: boolean) => {
    if (view.web) return "Read this page? [y] yes  [a] yes, and read pages from this site without asking for the rest of this run  [N] no: ";
    if (view.patch) {
        return canRemember
            ? "Apply these changes? [y] yes  [a] yes, and allow file edits without asking for the rest of this run  [N] no: "
            : "Apply these changes? (deleting a file is always asked) [y/N] ";
    }
    return canRemember ? "Run it? [y] yes  [a] yes, and run this exact command again without asking in this run  [N] no: " : "Run it? [y/N] ";
};

/** y / a / anything else (no). "a" counts only where it was offered. */
export const parseApprovalAnswer = (answer: string | null, canRemember: boolean): "once" | "always" | "no" => {
    const text = answer?.trim().toLowerCase() ?? "";
    if (text === "y" || text === "yes") return "once";
    if (canRemember && (text === "a" || text === "always")) return "always";
    return "no";
};

export type TerminalPrompter = Prompter & { memory: ApprovalMemory };

/** `ask` and `write` are the terminal; tests pass stand-ins. */
export const terminalPrompter = (
    memory = new ApprovalMemory(),
    ask: (question: string) => Promise<string | null> = askLine,
    write: (text: string) => void = (text) => void process.stderr.write(text)
): TerminalPrompter => ({
    memory,
    async approve(view) {
        const rule = memory.match(view);
        if (rule) {
            write(`\n${renderRemembered(view, rule)}\n`);
            return { approved: true, remembered: rule };
        }
        const canRemember = memory.canRemember(view);
        write(`\n${renderApproval(view)}\n`);
        const answer = parseApprovalAnswer(await ask(approvalQuestion(view, canRemember)), canRemember);
        if (answer === "always") return { approved: true, remember: memory.remember(view) ?? undefined };
        return { approved: answer === "once" };
    },
    async confirm(question) {
        return yes(await ask(`${safeLine(question)} [y/N] `));
    },
});
