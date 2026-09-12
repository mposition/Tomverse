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
    // Optional mutation anchors are consumed only by a mutation factory. Their
    // absence cannot replace a behavioral failure with an extraction failure.
    const span = (node) => ({ start: node.getStart(source), end: node.end });
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
        trailingAllowlist: findNodes(trailingDecision.expression, (node) => ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes" &&
            mentions(node, "data.surface")).map(span),
        trailingOrigin: findNodes(trailingDecision.expression, (node) => ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            accessPath(node.left) === "currentChatIdRef.current" && accessPath(node.right) === "id").map(span),
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
