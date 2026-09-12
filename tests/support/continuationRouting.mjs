import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";

// The same AST/VM approach as chatWorkspaceEntry.test.mjs, scoped to the
// selection handler's routing decisions. Nothing mounts or imports the page.
const findNodes = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
        if (predicate(node)) matches.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
};
const unique = (matches, label) => {
    assert.equal(matches.length, 1, `routing: expected exactly one ${label}`);
    return matches[0];
};
const namedVariable = (name) => (node) => ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) && node.name.text === name;
const accessPath = (node) => ts.isIdentifier(node) ? node.text :
    ts.isPropertyAccessExpression(node) ? `${accessPath(node.expression)}.${node.name.text}` : "";
const unparenthesized = (node) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
};
const conjuncts = (node) => {
    const inner = unparenthesized(node);
    return ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [...conjuncts(inner.left), ...conjuncts(inner.right)] : [node];
};
// Recognize only strict comparisons joined by OR, not arbitrary boolean logic.
const comparedSurfaces = (node) => {
    node = unparenthesized(node);
    if (!ts.isBinaryExpression(node)) return null;
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const left = comparedSurfaces(node.left), right = comparedSurfaces(node.right);
        return left && right ? [...left, ...right] : null;
    }
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    const left = unparenthesized(node.left), right = unparenthesized(node.right);
    if (accessPath(left) === "data.surface" && ts.isStringLiteral(right)) return [right.text];
    if (accessPath(right) === "data.surface" && ts.isStringLiteral(left)) return [left.text];
    return null;
};
const isSurfaceAllowlist = (node) => {
    node = unparenthesized(node);
    let values = comparedSurfaces(node);
    if (ts.isCallExpression(node) && node.arguments.length === 1 &&
        accessPath(unparenthesized(node.arguments[0])) === "data.surface" &&
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes") {
        const array = unparenthesized(node.expression.expression);
        if (ts.isArrayLiteralExpression(array) && array.elements.every(ts.isStringLiteral)) {
            values = array.elements.map((element) => element.text);
        }
    }
    return values !== null && new Set(values).size === 3 &&
        values.every((value) => ["chat", "workspace", "continuation"].includes(value));
};

export function extractContinuationRouting(text) {
    const source = ts.createSourceFile("ChatPageClient.tsx", text,
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.equal(source.parseDiagnostics.length, 0, "routing: malformed source");
    const declaration = unique(findNodes(source, namedVariable("handleSelectConversation")), "selection handler");
    const handler = declaration.initializer;
    assert.ok(handler && ts.isArrowFunction(handler) && ts.isBlock(handler.body),
        "routing: selection handler must have a block body");
    assert.ok(handler.body.statements.length > 0, "routing: empty selection handler");

    const target = unique(findNodes(handler.body, namedVariable("targetSurface")), "targetSurface declaration");
    assert.ok(target.initializer, "routing: targetSurface must be initialized");
    const targetStatement = target.parent.parent;
    assert.ok(targetStatement.parent === handler.body, "routing: targetSurface must be a direct handler statement");
    const targetKeyword = target.parent.getFirstToken(source);
    assert.ok(targetKeyword && [ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.LetKeyword, ts.SyntaxKind.VarKeyword]
        .includes(targetKeyword.kind), "routing: targetSurface must have a declaration keyword");
    const boundary = unique(findNodes(handler.body, (node) => ts.isCallExpression(node) &&
        accessPath(node.expression) === "localComparisonResponsesRef.current.clear"), "workspace boundary");
    const boundaryStatement = boundary.parent;
    assert.ok(ts.isExpressionStatement(boundaryStatement) && boundaryStatement.parent === handler.body,
        "routing: workspace boundary must be a direct handler statement");
    const start = targetStatement.getStart(source);
    const end = boundaryStatement.getStart(source);
    assert.ok(start < end && text.slice(start, end).trim().length > 0,
        "routing: nonempty, ordered bounds required");
    const statements = handler.body.statements.slice(0, handler.body.statements.indexOf(boundaryStatement));
    // Extract only the later owned detail handoff's actual conditional block.
    // The tests execute it separately from unrelated workspace restoration.
    const trailingHandoff = unique(findNodes(handler.body, (node) => ts.isCallExpression(node) &&
        node.getStart(source) > end && accessPath(node.expression) === "router.push" &&
        node.arguments.some((argument) => ts.isCallExpression(argument) &&
            accessPath(argument.expression) === "conversationHandoffHref")), "trailing owned handoff");
    let trailingDecision = trailingHandoff.parent;
    while (trailingDecision && trailingDecision !== handler.body && !ts.isIfStatement(trailingDecision)) {
        trailingDecision = trailingDecision.parent;
    }
    assert.ok(trailingDecision && ts.isIfStatement(trailingDecision) &&
        trailingHandoff.parent.parent === trailingDecision.thenStatement,
    "routing: trailing owned handoff must be a direct conditional navigation");
    statements.push(trailingDecision);
    // Identifiers and computed property reads are executable evidence; prose
    // containing these words is not. The image-kind workspace branch is outside
    // these two surface decisions and is deliberately not a surface inference.
    for (const forbidden of ["productKey", "kind", "startsWith"]) {
        const references = statements.flatMap((statement) => findNodes(statement, (node) =>
            (ts.isIdentifier(node) && node.text === forbidden) ||
            (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
                node.argumentExpression.text === forbidden)));
        assert.equal(references.length, 0, `routing: surface must not be derived from ${forbidden}`);
    }
    // Extraction leaves mutation anchors optional, so behavior is still tested
    // for missing/wrong guards. A factory naming an unsupported shape reports
    // its own preparation failure without preventing later test registration.
    const span = (node) => ({ start: node.getStart(source), end: node.end });
    const conjunctSpan = (node) => {
        const result = span(node);
        while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            // Delete this conjunct and its AND by retaining the actual sibling.
            // Wrapping the sibling preserves precedence inside outer groups.
            const sibling = parent.left === node ? parent.right : parent.left;
            result.removal = { ...span(parent), replacement: `(${sibling.getText(source)})` };
        }
        return result;
    };
    const prefixNodes = (predicate) => statements.slice(0, -1).flatMap((statement) => findNodes(statement, predicate));
    const mentions = (node, path) => findNodes(node, (child) => accessPath(child) === path).length > 0;
    const anchors = {
        detailGuard: prefixNodes((node) => ts.isIfStatement(node) && mentions(node.expression, "detail.surface")).map(span),
        targetAssignment: prefixNodes((node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            accessPath(node.left) === "targetSurface").map(span),
        ownPath: prefixNodes(namedVariable("ownPath")).map((node) => span(node.parent.parent)),
        prefixHandoff: prefixNodes((node) => ts.isCallExpression(node) && accessPath(node.expression) === "conversationHandoffHref").map(span),
        listSurface: findNodes(target.initializer, (node) => ts.isPropertyAccessExpression(node) && node.name.text === "surface" &&
            ts.isCallExpression(node.expression) && accessPath(node.expression.expression) === "conversations.find").map(span),
        trailingHandoff: [span(trailingHandoff.parent)],
        trailingCondition: [span(trailingDecision.expression)],
        trailingAllowlist: conjuncts(trailingDecision.expression).filter(isSurfaceAllowlist).map(conjunctSpan),
        trailingOrigin: conjuncts(trailingDecision.expression).filter((node) => {
            node = unparenthesized(node);
            if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
            const sides = [node.left, node.right].map((side) => accessPath(unparenthesized(side)));
            return sides.includes("currentChatIdRef.current") && sides.includes("id");
        }).map(conjunctSpan),
    };
    return {
        anchors,
        start, end, handlerStart: handler.getStart(source), handlerEnd: handler.end,
        handlerNameStart: declaration.name.getStart(source), handlerNameEnd: declaration.name.end,
        targetKeywordStart: targetKeyword.getStart(source), targetKeywordEnd: targetKeyword.end,
        targetEnd: targetStatement.end, boundaryEnd: boundaryStatement.end,
        initializerStart: target.initializer.getStart(source), initializerEnd: target.initializer.end,
        // Keep the real parameters, ticket increment, lookup and navigation.
        // The sentinel only observes arrival at the first workspace mutation.
        executable: `(${text.slice(handler.getStart(source), end)} return "workspace"; })`,
        trailingExecutable: `(() => { ${trailingDecision.getText(source)} })`,
    };
}

export function compileContinuationRouting(text) {
    const routing = extractContinuationRouting(text);
    const javascript = (code) => ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const prefix = javascript(routing.executable);
    const trailing = javascript(routing.trailingExecutable);
    return {
        prefix: (context) => vm.runInNewContext(prefix, context),
        trailing: (context) => vm.runInNewContext(trailing, context),
    };
}
