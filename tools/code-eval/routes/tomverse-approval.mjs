// Approval policy of the measurement harness for the Tomverse agent. It stands
// where the person would stand in `tomverse`: it approves a patch whose files
// are all inside the temporary working folder, and a command that runs inside
// it and does not reach the network, install packages or publish anything.
// It is a harness policy for throwaway folders, not a security boundary: an
// approved command still runs with this account's permissions, exactly as the
// CLI says on its approval screen. Run measurements on a machine you can lose.
import { isAbsolute, relative, resolve } from "node:path";

const fold = (path) => (process.platform === "win32" ? path.toLowerCase() : path);

export const isInside = (root, target) => {
    const rel = relative(fold(resolve(root)), fold(resolve(root, target)));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const BLOCKED_COMMAND = new RegExp(
    [
        String.raw`\b(curl|wget|iwr|irm|ssh|scp|sftp|ftp|nc|ncat|telnet|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b`,
        String.raw`\bgit\s+(push|remote|clone|fetch|pull|config|credential)\b`,
        String.raw`\b(npm|pnpm|yarn)\s+(i|install|ci|add|publish|login|adduser|config|exec|dlx)\b`,
        String.raw`\bnpx\b`,
        String.raw`\b(pip3?|gem|cargo|apt(-get)?|brew|winget|choco)\s+(i|install|add)\b`,
        String.raw`\bsudo\b`,
        String.raw`\b(rm|rmdir|del|erase|rd|Remove-Item)\b[^\n]*(\s|^)(/|~|[A-Za-z]:[\\/]|\.\.)`,
    ].join("|"),
    "i",
);

/** @returns {{approved: boolean, reason?: string}} */
export const decideApproval = (view, root) => {
    if (view.error) return { approved: false, reason: "the request was malformed" };
    if (view.patch) {
        const outside = view.patch.find((edit) => !isInside(root, edit.path));
        return outside ? { approved: false, reason: `path outside the working folder: ${outside.path}` } : { approved: true };
    }
    if (view.command) {
        if (!isInside(root, view.command.cwd)) return { approved: false, reason: "the command would run outside the working folder" };
        const text = [view.command.display, ...view.command.args].join("\n");
        if (BLOCKED_COMMAND.test(text)) return { approved: false, reason: "network, install, publish and path-escaping commands are not allowed in measurements" };
        return { approved: true };
    }
    return { approved: false, reason: "unknown request" };
};
