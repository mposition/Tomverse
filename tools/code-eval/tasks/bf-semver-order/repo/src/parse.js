const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parse(text) {
    const match = PATTERN.exec(String(text).trim());
    if (!match) throw new TypeError(`invalid version: ${text}`);
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split(".") : [],
        build: match[5] ?? null,
    };
}
