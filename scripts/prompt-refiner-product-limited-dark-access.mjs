import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";

export const PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS = Object.freeze([
    Object.freeze({
        file: "lib/promptRefinerProductStageSnapshot.ts",
        sha256: "74ad9fd42081d6eee8afa9032bb73bc42f91ddde60735ed42f75737de3a42ac6",
        tables: Object.freeze(["PromptRefinerVnextOneShotStage"]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        sha256: "5bb5ef80cb3fb4d970561f354a9153994139818a67f749530c7f27b6189b50b3",
        tables: Object.freeze([
            "PromptRefinerVnextOneShotStage",
            "PromptRefinerVnextOneShotSlot",
        ]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotOperationalShadow.ts",
        sha256: "38ed57a470a50ab498cdca120701c866a3700a379f33280772f4da167b1881e4",
        tables: Object.freeze(["PromptRefinerVnextOneShotStage"]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
        sha256: "b2de8a7e900e3b122e827ff6a0cebdd63812ed87acedaec8478602eb856cebc6",
        tables: Object.freeze([
            "PromptRefinerVnextOneShotStage",
            "PromptRefinerVnextOneShotSlot",
        ]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotStageReadback.ts",
        sha256: "adce761677ea1907dd5f0aeba58d2dd76bcc9c033eac94c72472e991de94d130",
        tables: Object.freeze([
            "PromptRefinerVnextOneShotStage",
            "PromptRefinerVnextOneShotSlot",
        ]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotOutcomeRecovery.ts",
        sha256: "bfcb62b97199cfa8a54a9edae330f02cfdf332e198c4c4e5090b30b49fb7c7e2",
        tables: Object.freeze([
            "PromptRefinerVnextOneShotStage",
            "PromptRefinerVnextOneShotSlot",
        ]),
    }),
]);

const EXACT_PRODUCT_DARK_READ_SCOPE = Object.freeze([
    "lib/promptRefinerProductStageSnapshot.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotGateEvidence.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotGateEvidence.ts:PromptRefinerVnextOneShotSlot",
    "lib/promptRefinerVnextOneShotOperationalShadow.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotTerminalReceipt.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotTerminalReceipt.ts:PromptRefinerVnextOneShotSlot",
    "lib/promptRefinerVnextOneShotStageReadback.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotStageReadback.ts:PromptRefinerVnextOneShotSlot",
    "lib/promptRefinerVnextOneShotOutcomeRecovery.ts:PromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotOutcomeRecovery.ts:PromptRefinerVnextOneShotSlot",
]);

export const PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES = Object.freeze([
    Object.freeze({
        importer: "lib/promptRefinerProductReleaseStore.ts",
        target: "lib/promptRefinerProductStageSnapshot.ts",
        reads: Object.freeze(["readPromptRefinerProductStageSnapshot"]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerProductReleaseStore.ts",
        target: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        reads: Object.freeze([
            "readPromptRefinerVnextOneShotDisposition",
            "readPromptRefinerVnextOneShotGateEvidence",
        ]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        target: "lib/promptRefinerVnextOneShotOperationalShadow.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotOperationalShadow"]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        target: "lib/promptRefinerVnextOneShotStageReadback.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotStage"]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        target: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotTerminalReceipts"]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
        target: "lib/promptRefinerVnextOneShotStageReadback.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotStage"]),
    }),
    Object.freeze({
        importer: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
        target: "lib/promptRefinerVnextOneShotOutcomeRecovery.ts",
        reads: Object.freeze(["verifyPromptRefinerVnextOneShotConsumedRequest"]),
    }),
]);

const EXACT_PRODUCT_TRANSITIVE_READ_EDGES = Object.freeze([
    "lib/promptRefinerProductReleaseStore.ts->lib/promptRefinerProductStageSnapshot.ts:readPromptRefinerProductStageSnapshot",
    "lib/promptRefinerProductReleaseStore.ts->lib/promptRefinerVnextOneShotGateEvidence.ts:readPromptRefinerVnextOneShotDisposition,readPromptRefinerVnextOneShotGateEvidence",
    "lib/promptRefinerVnextOneShotGateEvidence.ts->lib/promptRefinerVnextOneShotOperationalShadow.ts:readPromptRefinerVnextOneShotOperationalShadow",
    "lib/promptRefinerVnextOneShotGateEvidence.ts->lib/promptRefinerVnextOneShotStageReadback.ts:readPromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotGateEvidence.ts->lib/promptRefinerVnextOneShotTerminalReceipt.ts:readPromptRefinerVnextOneShotTerminalReceipts",
    "lib/promptRefinerVnextOneShotTerminalReceipt.ts->lib/promptRefinerVnextOneShotStageReadback.ts:readPromptRefinerVnextOneShotStage",
    "lib/promptRefinerVnextOneShotTerminalReceipt.ts->lib/promptRefinerVnextOneShotOutcomeRecovery.ts:verifyPromptRefinerVnextOneShotConsumedRequest",
]);

export const promptRefinerProductLimitedDarkAccessConfigurationProblems = (
    entries = PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS,
    edges = PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES
) => {
    const actual = entries.flatMap((entry) => entry.tables.map(
        (table) => `${entry.file}:${table}`
    ));
    const problems = [];
    if (entries.length !== 6) {
        problems.push(`expected 6 reviewed sources, received ${entries.length}`);
    }
    if (actual.length !== EXACT_PRODUCT_DARK_READ_SCOPE.length ||
        actual.some((pair, index) => pair !== EXACT_PRODUCT_DARK_READ_SCOPE[index])) {
        problems.push("reviewed source/table pairs differ from the exact ten-pair grant");
    }
    if (entries.some((entry) => !/^[0-9a-f]{64}$/.test(entry.sha256))) {
        problems.push("a reviewed source hash is not a lowercase SHA-256 digest");
    }
    const actualEdges = edges.map((edge) =>
        `${edge.importer}->${edge.target}:${edge.reads.join(",")}`);
    if (actualEdges.length !== EXACT_PRODUCT_TRANSITIVE_READ_EDGES.length ||
        actualEdges.some((edge, index) =>
            edge !== EXACT_PRODUCT_TRANSITIVE_READ_EDGES[index])) {
        problems.push("transitive read edges differ from the exact seven-edge chain");
    }
    return Object.freeze(problems);
};

const byFile = new Map(PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.map(
    (entry) => [entry.file, entry]
));

const MIXED_EXPORT_READS = Object.freeze([
    Object.freeze({
        file: "lib/promptRefinerProductStageSnapshot.ts",
        reads: Object.freeze(["readPromptRefinerProductStageSnapshot"]),
        records: Object.freeze([]),
        callers: Object.freeze(["lib/promptRefinerProductReleaseStore.ts"]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotGateEvidence.ts",
        reads: Object.freeze([
            "readPromptRefinerVnextOneShotDisposition",
            "readPromptRefinerVnextOneShotGateEvidence",
        ]),
        records: Object.freeze([
            "recordPromptRefinerVnextOneShotDisposition",
            "recordPromptRefinerVnextOneShotGateEvidence",
        ]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotOperationalShadow.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotOperationalShadow"]),
        records: Object.freeze(["recordPromptRefinerVnextOneShotOperationalShadow"]),
    }),
    Object.freeze({
        file: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
        reads: Object.freeze(["readPromptRefinerVnextOneShotTerminalReceipts"]),
        records: Object.freeze(["recordPromptRefinerVnextOneShotTerminal"]),
    }),
]);

const mixedByFile = new Map(MIXED_EXPORT_READS.map((entry) => [entry.file, entry]));

const resolvedSourceFile = (importer, specifier) => {
    let resolved;
    if (specifier.startsWith("@/")) {
        resolved = specifier.slice(2);
    } else if (specifier.startsWith(".")) {
        resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
    } else {
        return null;
    }
    resolved = resolved.replace(/\.(?:js|mjs|cjs|ts|tsx)$/, "");
    return `${resolved}.ts`;
};

const targetFile = (importer, specifier) => {
    const candidate = resolvedSourceFile(importer, specifier);
    return mixedByFile.has(candidate) ? candidate : null;
};

const PRODUCT_RELEASE_STORE = "lib/promptRefinerProductReleaseStore.ts";
const PRODUCT_RELEASE_STORE_APPROVED_IMPORTS = new Map([
    ["lib/promptRefinerProductStageSnapshot.ts", new Set([
        "readPromptRefinerProductStageSnapshot",
    ])],
    ["lib/promptRefinerVnextOneShotGateEvidence.ts", new Set([
        "readPromptRefinerVnextOneShotDisposition",
        "readPromptRefinerVnextOneShotGateEvidence",
    ])],
]);

/** Keep the mutable product root out of every other hash-bound dark reader. */
export const promptRefinerProductReleaseStoreControlledImportProblems = (source) => {
    const problems = [];
    const sourceFile = ts.createSourceFile(
        PRODUCT_RELEASE_STORE,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const controlled = new Set(PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.map(
        (entry) => entry.file
    ));
    const constantTargets = new Map();
    const collectConstantTargets = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
            node.initializer && ts.isStringLiteral(node.initializer) &&
            ts.isVariableDeclarationList(node.parent) &&
            (node.parent.flags & ts.NodeFlags.Const) !== 0) {
            const target = resolvedSourceFile(PRODUCT_RELEASE_STORE, node.initializer.text);
            if (controlled.has(target)) constantTargets.set(node.name.text, target);
        }
        ts.forEachChild(node, collectConstantTargets);
    };
    collectConstantTargets(sourceFile);

    const report = (detail, target) => {
        problems.push(`${PRODUCT_RELEASE_STORE}: ${detail} ${target}`);
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const target = resolvedSourceFile(
                PRODUCT_RELEASE_STORE, node.moduleSpecifier.text);
            if (controlled.has(target)) {
                const approved = PRODUCT_RELEASE_STORE_APPROVED_IMPORTS.get(target);
                if (!approved) {
                    report("imports an unapproved controlled reader", target);
                } else {
                    const clause = node.importClause;
                    if (!clause || clause.name || !clause.namedBindings ||
                        ts.isNamespaceImport(clause.namedBindings)) {
                        report("uses a non-named controlled import from", target);
                    } else if (clause.isTypeOnly) {
                        report("uses a type-only controlled import from", target);
                    } else {
                        for (const element of clause.namedBindings.elements) {
                            const imported = element.propertyName?.text ?? element.name.text;
                            if (element.isTypeOnly) {
                                report(`uses type-only export ${imported} from`, target);
                            } else if (!approved.has(imported)) {
                                report(`imports unapproved export ${imported} from`, target);
                            }
                        }
                    }
                }
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const target = resolvedSourceFile(
                PRODUCT_RELEASE_STORE, node.moduleSpecifier.text);
            if (controlled.has(target)) report("re-exports controlled reader", target);
        } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const requireCall = ts.isIdentifier(node.expression) &&
                node.expression.text === "require";
            if (dynamicImport || requireCall) {
                const argument = node.arguments[0];
                const target = ts.isStringLiteral(argument)
                    ? resolvedSourceFile(PRODUCT_RELEASE_STORE, argument.text)
                    : ts.isIdentifier(argument)
                        ? constantTargets.get(argument.text) ?? null
                        : null;
                if (controlled.has(target)) report(dynamicImport
                    ? "dynamically imports controlled reader"
                    : "requires controlled reader", target);
                else if (!ts.isStringLiteral(argument)) report(dynamicImport
                    ? "uses an unresolved dynamic import"
                    : "uses an unresolved require", "from the product root");
            }
        } else if (ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression &&
            ts.isStringLiteral(node.moduleReference.expression)) {
            const target = resolvedSourceFile(
                PRODUCT_RELEASE_STORE, node.moduleReference.expression.text);
            if (controlled.has(target)) {
                report("uses import-equals for controlled reader", target);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return Object.freeze(problems);
};

/**
 * Null means the path is outside this approval. False means it is named by the
 * approval but its table or exact reviewed bytes do not match.
 */
export const promptRefinerProductLimitedDarkAccessPermitted = ({
    file,
    table,
    source,
}) => {
    const entry = byFile.get(file);
    if (!entry) return null;
    if (!entry.tables.includes(table)) return false;
    return createHash("sha256").update(source).digest("hex") === entry.sha256;
};

/**
 * The reviewed modules contain historical record exports because their bytes
 * are frozen. Production may import only the named read exports. Namespace,
 * default, re-export, require and dynamic imports fail closed.
 */
export const promptRefinerProductMixedExportImportProblems = ({ file, source }) => {
    const problems = [];
    const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const constantModuleTargets = new Map();
    const collectConstantTargets = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
            node.initializer && ts.isStringLiteral(node.initializer) &&
            ts.isVariableDeclarationList(node.parent) &&
            (node.parent.flags & ts.NodeFlags.Const) !== 0) {
            const target = targetFile(file, node.initializer.text);
            if (target) constantModuleTargets.set(node.name.text, target);
        }
        ts.forEachChild(node, collectConstantTargets);
    };
    collectConstantTargets(sourceFile);

    const report = (target, detail) => {
        problems.push(`${file}: ${detail} ${target}`);
    };

    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const target = targetFile(file, node.moduleSpecifier.text);
            if (target) {
                const reviewed = mixedByFile.get(target);
                const clause = node.importClause;
                if (!clause || clause.name || !clause.namedBindings ||
                    ts.isNamespaceImport(clause.namedBindings)) {
                    report(target, "uses a non-named import from");
                } else {
                    if (reviewed.callers && !reviewed.callers.includes(file)) {
                        report(target, "is not an approved caller of");
                    }
                    for (const element of clause.namedBindings.elements) {
                        const imported = element.propertyName?.text ?? element.name.text;
                        if (!reviewed.reads.includes(imported)) {
                            report(target, `imports non-reader export ${imported} from`);
                        }
                    }
                }
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const target = targetFile(file, node.moduleSpecifier.text);
            if (target) report(target, "re-exports the mixed-export module");
        } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
            const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const requireCall = ts.isIdentifier(node.expression) &&
                node.expression.text === "require";
            if (dynamicImport || requireCall) {
                const argument = node.arguments[0];
                const target = ts.isStringLiteral(argument)
                    ? targetFile(file, argument.text)
                    : ts.isIdentifier(argument)
                        ? constantModuleTargets.get(argument.text) ?? null
                        : null;
                if (target) report(target, dynamicImport
                    ? "dynamically imports" : "requires");
            }
        } else if (ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression &&
            ts.isStringLiteral(node.moduleReference.expression)) {
            const target = targetFile(file, node.moduleReference.expression.text);
            if (target) report(target, "imports the mixed-export module with import-equals");
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return Object.freeze(problems);
};

/**
 * Prove only the named read edges used by product admission. The frozen gate
 * still imports its historical lock helper for record exports; this check does
 * not grant or prohibit that separate legacy path.
 */
export const promptRefinerProductTransitiveReadEdgeProblems = (runtimeSources) => {
    const releaseStore = runtimeSources.get(PRODUCT_RELEASE_STORE);
    const problems = releaseStore === undefined
        ? []
        : [...promptRefinerProductReleaseStoreControlledImportProblems(releaseStore)];
    for (const edge of PROMPT_REFINER_PRODUCT_TRANSITIVE_READ_EDGES) {
        const source = runtimeSources.get(edge.importer);
        if (source === undefined) {
            problems.push(`${edge.importer}: product read-edge importer is absent`);
            continue;
        }
        if (!runtimeSources.has(edge.target)) {
            problems.push(`${edge.target}: product read-edge target is absent`);
            continue;
        }
        const sourceFile = ts.createSourceFile(
            edge.importer,
            source,
            ts.ScriptTarget.Latest,
            true,
            edge.importer.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const imported = new Set();
        let nonNamed = false;
        for (const statement of sourceFile.statements) {
            if (!ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                resolvedSourceFile(edge.importer, statement.moduleSpecifier.text) !==
                    edge.target) continue;
            const clause = statement.importClause;
            if (!clause || clause.name || !clause.namedBindings ||
                ts.isNamespaceImport(clause.namedBindings)) {
                nonNamed = true;
                continue;
            }
            if (!clause.isTypeOnly) {
                for (const element of clause.namedBindings.elements) {
                    if (!element.isTypeOnly) {
                        imported.add(element.propertyName?.text ?? element.name.text);
                    }
                }
            }
        }
        if (nonNamed) {
            problems.push(
                `${edge.importer}: product read edge uses a non-named import from ${edge.target}`
            );
        }
        for (const read of edge.reads) {
            if (!imported.has(read)) {
                problems.push(
                    `${edge.importer}: product read edge is missing ${read} from ${edge.target}`
                );
            }
        }
    }
    return Object.freeze(problems);
};

export const PROMPT_REFINER_PRODUCT_RECORD_EXPORTS = Object.freeze(
    MIXED_EXPORT_READS.flatMap((entry) => entry.records)
);

export const PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES =
Object.freeze([
    "app/api/admin/prompt-refiner/vnext-one-shot-disposition/route.ts",
    "app/api/admin/prompt-refiner/vnext-one-shot-gate/route.ts",
    "app/api/admin/prompt-refiner/vnext-operational-shadow/route.ts",
    "app/api/admin/prompt-refiner/vnext-paid-authorization/route.ts",
    "app/api/admin/prompt-refiner/vnext-stage-approval/route.ts",
    "app/api/admin/prompt-refiner/vnext-v5-stage-approval/route.ts",
    "app/api/admin/prompt-refiner/vnext-v5-stage-preflight/route.ts",
    "app/api/internal/prompt-refiner/vnext-one-shot-slot/route.ts",
    "app/api/internal/prompt-refiner/vnext-one-shot-terminal/route.ts",
    "lib/promptRefinerVnextOneShotPaidAuthorization.ts",
    "lib/promptRefinerVnextOneShotSlotConsumption.ts",
    "lib/promptRefinerVnextOneShotStageAdmission.ts",
    "lib/promptRefinerVnextOneShotV4StageWriter.ts",
    "lib/promptRefinerVnextOneShotV5PredecessorReadback.ts",
    "lib/promptRefinerVnextOneShotV5StageWriter.ts",
]);

export const promptRefinerProductSelectiveReleaseProblems = (runtimeSources) => {
    const problems = [
        ...promptRefinerProductLimitedDarkAccessConfigurationProblems(),
        ...promptRefinerProductTransitiveReadEdgeProblems(runtimeSources),
    ];
    for (const path of PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES) {
        if (runtimeSources.has(path)) {
            problems.push(`${path}: lifecycle source is present in the selective release`);
        }
    }
    for (const [file, source] of runtimeSources) {
        problems.push(...promptRefinerProductMixedExportImportProblems({ file, source }));
    }
    return Object.freeze(problems);
};
