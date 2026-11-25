import { coerce, setPath } from "./env.js";

export function fromArgs(argv = []) {
    const out = {};
    for (const arg of argv) {
        if (!arg.startsWith("--") || arg.length === 2) continue;
        const body = arg.slice(2);
        const eq = body.indexOf("=");
        if (eq < 0) {
            if (body.startsWith("no-") && body.length > 3) setPath(out, body.slice(3).split("."), false);
            else setPath(out, body.split("."), true);
        } else {
            setPath(out, body.slice(0, eq).split("."), coerce(body.slice(eq + 1), `--${body.slice(0, eq)}`));
        }
    }
    return out;
}
