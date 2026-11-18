import { createInterface } from "node:readline/promises";
import { renderFileDiff, safeLine, safeText } from "./display.js";
import type { ApprovalView, Prompter } from "./agent.js";

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
    } else if (view.command) {
        const plan = view.command;
        lines.push("── Approval needed: run a command ──");
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
        lines.push(`  timeout: ${Math.round(plan.timeoutMs / 1000)} s`);
        lines.push(`  env:     ${plan.envNames.length} variables (${plan.envNames.join(", ")}); your Tomverse key is not passed`);
        lines.push("  It runs with your account's permissions and is not sandboxed: it can change files outside this folder and use the network.");
    }
    return lines.map((l) => safeText(l)).join("\n");
};

export const terminalPrompter = (): Prompter => ({
    async approve(view) {
        process.stderr.write(`\n${renderApproval(view)}\n`);
        return yes(await askLine(view.patch ? "Apply these changes? [y/N] " : "Run it? [y/N] "));
    },
    async confirm(question) {
        return yes(await askLine(`${safeLine(question)} [y/N] `));
    },
});
