import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";

export const PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS = Object.freeze([
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
]);

const byFile = new Map(PROMPT_REFINER_PRODUCT_LIMITED_DARK_ACCESS.map(
    (entry) => [entry.file, entry]
));

const MIXED_EXPORT_READS = Object.freeze([
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

const targetFile = (importer, specifier) => {
    let resolved;
    if (specifier.startsWith("@/")) {
        resolved = specifier.slice(2);
    } else if (specifier.startsWith(".")) {
        resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
    } else {
        return null;
    }
    resolved = resolved.replace(/\.(?:js|mjs|cjs|ts|tsx)$/, "");
    const candidate = `${resolved}.ts`;
    return mixedByFile.has(candidate) ? candidate : null;
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
    const problems = [];
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
