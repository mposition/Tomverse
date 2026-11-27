import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { WINDOWS_LOCATION_SETTINGS_URI } from "../src/host/os-location";

const hostDir = fileURLToPath(new URL("../src/host/", import.meta.url));

/** The named code a node sits in: a function declaration, or an IPC handler registered as main("channel", ...). */
function container(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return `function ${current.name.text}`;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "main") {
      const [channel] = current.arguments;
      if (channel && ts.isStringLiteralLike(channel)) return `ipc ${channel.text}`;
    }
  }
  return "top level";
}

/** Every place the host reaches the system browser through Electron's shell (calls, aliases and destructuring). */
function systemBrowserReferences() {
  const found: string[] = [];
  const files = readdirSync(hostDir, { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name)).sort();
  for (const name of files) {
    const source = ts.createSourceFile(name, readFileSync(join(hostDir, name), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const isShell = (expression: ts.Expression) =>
        ts.isIdentifier(expression) ? expression.text === "shell" : ts.isPropertyAccessExpression(expression) && expression.name.text === "shell";
      if (ts.isPropertyAccessExpression(node) && node.name.text === "openExternal" && isShell(node.expression)) found.push(`${name} ${container(node)}`);
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "openExternal" && isShell(node.expression)) found.push(`${name} ${container(node)}`);
      if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source) === "openExternal" &&
        ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.initializer && isShell(node.parent.parent.initializer)) found.push(`${name} ${container(node)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort();
}

test("Desktop reaches the system browser from exactly four places: sign-in, connecting Google or Microsoft as a login method, the Google Drive picker, and the fixed Windows location settings page", () => {
  assert.deepEqual(systemBrowserReferences(), [
    // Handed to the account-data API, which opens only the provider's own https page (host allow-list in login-method-link.ts).
    "main.ts function connectedAccountData",
    "main.ts function importDriveAttachments",
    // Opens the one constant OS settings address (WINDOWS_LOCATION_SETTINGS_URI), never a web address; checked below.
    "main.ts function openOsLocationSettings",
    "main.ts function signIn",
  ]);
});

test("No IPC handler opens the system browser directly, so a renderer cannot choose where it goes", () => {
  assert.deepEqual(systemBrowserReferences().filter((entry) => entry.includes(" ipc ")), []);
});

test("The Windows location settings call opens one fixed ms-settings address, never a value that can be a web address", () => {
  assert.equal(WINDOWS_LOCATION_SETTINGS_URI, "ms-settings:privacy-location");
  assert.doesNotMatch(WINDOWS_LOCATION_SETTINGS_URI, /^(https?|ftp|file):/i);
  const source = ts.createSourceFile("main.ts", readFileSync(join(hostDir, "main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const handler = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "openOsLocationSettings");
  assert.ok(handler, "the settings opener is a named function");
  assert.deepEqual(handler.parameters.map((parameter) => parameter.name.getText(source)), [], "it takes nothing from the renderer");
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "shell.openExternal") calls.push(node.arguments.map((argument) => argument.getText(source)).join(","));
    ts.forEachChild(node, visit);
  };
  visit(handler);
  assert.deepEqual(calls, ["WINDOWS_LOCATION_SETTINGS_URI"]);
  assert.match(handler.getText(source), /process.platform !== "win32"/);
});
