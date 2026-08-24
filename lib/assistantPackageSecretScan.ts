/**
 * The one secret scanner, run by the browser and by the server (Slice 2).
 *
 * docs/policy/assistant-package-import.md §3 (A5).
 *
 * ## Why one module and not two
 *
 * A5 blocks publishing when a credential is found, and lets the owner wave off
 * a false positive. The waiver is bound into the approved digest: the client
 * sends what it chose to ignore, the server scans the same text itself, and a
 * finding the server has and the client did not wave is a refusal. That
 * comparison only means something if both sides find the same things -- two
 * scanners that drift apart turn the check into a formality that always agrees
 * with whoever wrote the request. So this module has no environment in it at
 * all and both sides import it.
 *
 * ## What a finding carries, and what it must never carry
 *
 * A finding is `(ruleId, source, offset, sha256 of the match)`. The matched
 * text is not in it. That is the whole reason the shape is what it is: the
 * finding travels in a request body, is folded into a digest, and may reach a
 * failure path that logs -- and §9 forbids the string in every one of those
 * places. A hash and a position are enough to say "the same finding", which is
 * the only question the override comparison asks.
 *
 * ## Why the rules are deliberately blunt
 *
 * These patterns are shaped to catch the credential formats that actually get
 * pasted into instructions and config files, and they will produce false
 * positives -- a base64 blob in a document, a hex digest in a changelog. That
 * is expected, and is why A5 keeps the waiver. What they must not be is clever
 * enough that a reader cannot tell what they match, because a rule nobody
 * understands is a rule nobody can decide to wave.
 *
 * Pure: no Prisma, no R2, no clock, no network. Hashing is injected, because
 * the browser and Node reach SHA-256 by different names.
 */

import { packageEntryExtension } from "@/lib/assistantPackageLimits";

export const ASSISTANT_PACKAGE_SECRET_RULES = [
    {
        id: "aws-access-key-id",
        label: "AWS access key id",
        pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    },
    {
        id: "github-token",
        label: "GitHub token",
        pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    },
    {
        id: "slack-token",
        label: "Slack token",
        pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
        id: "google-api-key",
        label: "Google API key",
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        id: "stripe-key",
        label: "Stripe key",
        pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
    },
    {
        /**
         * The `sk-ant-` prefix is excluded because the rule below claims it.
         * Two rules matching one string would be two findings, and A5's waiver
         * is per finding -- the owner would have to wave the same credential
         * twice to get past a check that found it once.
         */
        id: "openai-key",
        label: "OpenAI-style key",
        pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        id: "anthropic-key",
        label: "Anthropic-style key",
        pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        id: "private-key-block",
        label: "Private key block",
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    {
        id: "authorization-bearer",
        label: "Authorization header with a bearer token",
        pattern: /\bauthorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
    },
    {
        id: "json-web-token",
        label: "JSON Web Token",
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    },
    {
        /**
         * An assignment whose name says credential and whose value is not
         * obviously a placeholder. The negative lookahead is what keeps
         * `API_KEY=your-key-here` out of the results -- documentation says
         * that constantly, and a scanner that flags it teaches people to wave
         * everything.
         */
        id: "credential-assignment",
        label: "Assignment to a credential-shaped name",
        pattern:
            /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?(?!(?:your|my|the|a)[-_ ]|<|\{\{|\$\{|xxx|todo|changeme|example|placeholder|redacted)[A-Za-z0-9._~+/=-]{12,}/gi,
    },
] as const;

export type AssistantPackageSecretRuleId =
    (typeof ASSISTANT_PACKAGE_SECRET_RULES)[number]["id"];

/**
 * One finding. Identity is the quadruple, and it holds no plaintext.
 *
 * `offset` is a UTF-16 code-unit index into the scanned string, which is what
 * `RegExp.lastIndex` reports on both sides. It is part of the identity so that
 * the same credential appearing twice is two findings the owner can wave
 * separately.
 */
export type AssistantPackageSecretFinding = {
    ruleId: AssistantPackageSecretRuleId;
    /** Which field or package entry the text came from. Never a storage key. */
    source: string;
    offset: number;
    /** Lowercase hex SHA-256 of the matched substring. */
    matchDigest: string;
};

/**
 * SHA-256 as lowercase hex. Injected -- see the header.
 *
 * Bytes as well as strings, because the same hasher digests a matched
 * substring here and a knowledge file's contents in the review builder, and
 * two injected hashers is two things a caller can wire up differently. Strings
 * are encoded as UTF-8, which is what both platforms do by default.
 */
export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

/**
 * Every finding in one piece of text.
 *
 * `source` is supplied rather than derived, because the caller knows whether
 * this is the instructions, a starter, or an entry's text, and this module
 * must not start guessing at names.
 */
export async function scanForSecrets(
    input: { source: string; text: string },
    sha256Hex: Sha256Hex
): Promise<AssistantPackageSecretFinding[]> {
    const findings: AssistantPackageSecretFinding[] = [];
    for (const rule of ASSISTANT_PACKAGE_SECRET_RULES) {
        // A fresh RegExp per call: the module-level ones carry the global flag,
        // and a shared `lastIndex` between two callers is a scanner that
        // silently skips the start of the second string.
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
        let match: RegExpExecArray | null = pattern.exec(input.text);
        while (match !== null) {
            findings.push({
                ruleId: rule.id,
                source: input.source,
                offset: match.index,
                matchDigest: await sha256Hex(match[0]),
            });
            if (match[0].length === 0) pattern.lastIndex += 1;
            match = pattern.exec(input.text);
        }
    }
    return sortFindings(findings);
}

/**
 * A stable order, so two sides that found the same things produce the same
 * list and therefore the same digest.
 */
export const sortFindings = (
    findings: readonly AssistantPackageSecretFinding[]
): AssistantPackageSecretFinding[] =>
    [...findings].sort(
        (a, b) =>
            a.source.localeCompare(b.source) ||
            a.ruleId.localeCompare(b.ruleId) ||
            a.offset - b.offset ||
            a.matchDigest.localeCompare(b.matchDigest)
    );

/** The canonical string form of one finding, for digesting and comparison. */
export const findingKey = (finding: AssistantPackageSecretFinding): string =>
    `${finding.source} ${finding.ruleId} ${finding.offset} ${finding.matchDigest}`;

/**
 * The line the approved digest folds in.
 *
 * `"none"` rather than an empty string, so "the owner waved nothing" and "the
 * field was absent" cannot produce the same digest.
 */
export const secretOverrideFingerprint = (
    overrides: readonly AssistantPackageSecretFinding[]
): string =>
    overrides.length === 0
        ? "none"
        : sortFindings(overrides).map(findingKey).join("|");

export type SecretComparison =
    | { outcome: "clear" }
    /** Findings the server has that the client did not wave. Refuse. */
    | { outcome: "unwaived"; unwaived: AssistantPackageSecretFinding[] };

/**
 * The server's side of A5.
 *
 * Only one direction is a refusal. A waiver naming something the server did
 * not find is not a reason to reject the publish -- it describes text that is
 * no longer there, which is what happens when the owner edits an instruction
 * after waving a finding inside it. Refusing that would make correcting the
 * problem harder than ignoring it.
 */
export function compareSecretFindings(input: {
    serverFindings: readonly AssistantPackageSecretFinding[];
    clientOverrides: readonly AssistantPackageSecretFinding[];
}): SecretComparison {
    const waived = new Set(input.clientOverrides.map(findingKey));
    const unwaived = input.serverFindings.filter(
        (finding) => !waived.has(findingKey(finding))
    );
    return unwaived.length === 0
        ? { outcome: "clear" }
        : { outcome: "unwaived", unwaived: sortFindings(unwaived) };
}

/* ------------------------------------------------------------------ URLs */

/**
 * Hosts named by URLs in a piece of text, with a count.
 *
 * A6 discloses hosts rather than URLs: a path can carry a token, and the
 * disclosure exists to tell the owner where an instruction points, not to
 * reproduce the instruction. Deduplicated and sorted, so the same instruction
 * always renders the same list.
 */
export function collectUrlHosts(text: string): {
    count: number;
    hosts: string[];
} {
    const pattern = /\bhttps?:\/\/([^\s/?#"'<>)\]}]+)/gi;
    const hosts = new Set<string>();
    let count = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
        count += 1;
        const authority = match[1] ?? "";
        // Strip credentials and port. `user:pass@host` in an instruction is
        // itself a finding, and the credential rules above see the raw text --
        // what must not happen is this function republishing it as a "host".
        const host = authority.split("@").pop() ?? authority;
        hosts.add((host.split(":")[0] ?? "").toLowerCase());
        match = pattern.exec(text);
    }
    return { count, hosts: [...hosts].filter((host) => host !== "").sort() };
}

/* ------------------------------------------------------- what gets scanned */

/**
 * Extensions whose bytes are text this scanner can read.
 *
 * A PDF or a DOCX is a compressed container; running these rules over its
 * bytes finds nothing a credential is actually in and reports whatever random
 * base64 the compression produced. The server sees the extracted text of those
 * files and scans that instead, which is the same content read the right way.
 */
export const ASSISTANT_PACKAGE_TEXT_SCAN_EXTENSIONS = new Set([
    "txt",
    "text",
    "log",
    "md",
    "markdown",
    "csv",
    "json",
]);

export const isTextScannable = (name: string): boolean =>
    ASSISTANT_PACKAGE_TEXT_SCAN_EXTENSIONS.has(packageEntryExtension(name));

export type AssistantPackageScanInput = {
    name: string;
    description: string | null;
    instructions: string;
    starters: readonly string[];
    /** Only entries whose text is available. Omit the rest -- see below. */
    knowledge: readonly { name: string; text: string }[];
};

/**
 * The list of things to scan, in a fixed order, named the same way on both
 * sides.
 *
 * This exists so that "the server scans the same text" is a property of one
 * function rather than of two call sites agreeing. `source` is part of a
 * finding's identity, so a side that spells a field differently produces
 * findings the other cannot match, and every waiver silently stops working.
 *
 * A side that has less to scan is safe: the comparison only refuses on
 * findings the *server* has, so a client that scanned more just waived more
 * than it needed to.
 */
export function assistantPackageScanSources(
    input: AssistantPackageScanInput
): { source: string; text: string }[] {
    const sources: { source: string; text: string }[] = [
        { source: "profile.name", text: input.name },
        { source: "profile.description", text: input.description ?? "" },
        { source: "instructions", text: input.instructions },
    ];
    input.starters.forEach((starter, index) => {
        sources.push({ source: `starters[${index}]`, text: starter });
    });
    for (const entry of input.knowledge) {
        sources.push({ source: `knowledge:${entry.name}`, text: entry.text });
    }
    return sources.filter((source) => source.text !== "");
}

/** Every source scanned, flattened and sorted. */
export async function scanAssistantPackage(
    input: AssistantPackageScanInput,
    sha256Hex: Sha256Hex
): Promise<AssistantPackageSecretFinding[]> {
    const findings: AssistantPackageSecretFinding[] = [];
    for (const source of assistantPackageScanSources(input)) {
        findings.push(...(await scanForSecrets(source, sha256Hex)));
    }
    return sortFindings(findings);
}
