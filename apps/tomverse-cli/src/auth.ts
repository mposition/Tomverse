/**
 * The API key comes from TOMVERSE_API_KEY or a masked prompt, and lives only
 * in this process's memory. There is deliberately no --api-key flag (it would
 * land in shell history), and the key is never written to config, sessions,
 * logs or a command's environment. Keys are created, capped and revoked in
 * Tomverse Settings > API keys.
 */

const KEY_PATTERN = /^tvk_[0-9a-z]{8}_[A-Za-z0-9_-]{43}$/;

export class AuthError extends Error {}

export const keyPrefix = (key: string) => key.slice(0, 12);

/** What diagnostics may show of a key: its public prefix only. */
export const maskKey = (key: string) => `${keyPrefix(key)}_…`;

export const validateKey = (key: string) => {
    if (!KEY_PATTERN.test(key)) {
        throw new AuthError("That is not a Tomverse API key (tvk_…). Create one in Tomverse Settings > API keys.");
    }
    return key;
};

export const readKey = async (
    env: NodeJS.ProcessEnv = process.env,
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stderr
): Promise<string> => {
    const fromEnv = env.TOMVERSE_API_KEY?.trim();
    if (fromEnv) {
        // Taken out of this process's environment at once, so no process the
        // CLI starts later -- a command, git, ripgrep -- can inherit it.
        delete env.TOMVERSE_API_KEY;
        return validateKey(fromEnv);
    }
    if (!input.isTTY) {
        throw new AuthError("Set TOMVERSE_API_KEY, or run in a terminal to type the key.");
    }
    return validateKey((await maskedPrompt("Tomverse API key (input hidden): ", input, output)).trim());
};

/** Reads one line from a TTY without echoing it. */
export const maskedPrompt = (question: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream) =>
    new Promise<string>((resolve, reject) => {
        output.write(question);
        const wasRaw = input.isRaw;
        input.setRawMode(true);
        input.resume();
        let value = "";
        const finish = (error?: Error) => {
            input.setRawMode(wasRaw);
            input.pause();
            input.off("data", onData);
            output.write("\n");
            if (error) reject(error);
            else resolve(value);
        };
        const onData = (chunk: Buffer) => {
            for (const ch of chunk.toString("utf8")) {
                if (ch === "\r" || ch === "\n") return finish();
                if (ch === "\u0003") return finish(new AuthError("Cancelled."));
                if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
                else if (ch >= " ") value += ch;
            }
        };
        input.on("data", onData);
    });
