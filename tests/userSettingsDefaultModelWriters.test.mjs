import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

// Every write that can create a UserSettings row names `defaultModel` itself.
//
// The column's default used to fill it, and that default named whatever model
// was the application default when a migration last ran -- a second copy of
// APP_DEFAULTS.defaultModelId that had to be moved by hand every time the code
// moved. The writers now carry the value, so the column default can go. Until
// it does, the database would still fill a missing value silently, which is
// what this test is for: a new writer that leaves the field out fails here
// rather than in production on the day the default is dropped.

const ROOTS = ["lib", "app"];
const repositoryRoot = process.cwd();

const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

const propertyNamed = (object, name) =>
  object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name &&
      property.name.getText() === name
  );

const createObjects = () => {
  const found = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("userSettings.")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === "userSettings"
        ) {
          const method = node.expression.name.text;
          const argument = node.arguments[0];
          const location = `${relative(repositoryRoot, file)}:${
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
          }`;
          if (method === "create" || method === "upsert" || method === "createMany") {
            const key = method === "upsert" ? "create" : "data";
            const value =
              argument && ts.isObjectLiteralExpression(argument)
                ? propertyNamed(argument, key)?.initializer
                : undefined;
            found.push({
              location,
              method,
              object: value && ts.isObjectLiteralExpression(value) ? value : null,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return found;
};

test("every UserSettings create names defaultModel instead of leaving it to the column", () => {
  const writers = createObjects();
  // The settings route (2), the model finder (2), and the email paths that
  // create the row lazily: consent confirmation, jurisdiction (3) and
  // preferences. A lower count means the scan stopped seeing them.
  assert.ok(writers.length >= 9, `found only ${writers.length} UserSettings writers`);

  const unreadable = writers.filter((writer) => writer.object === null);
  assert.deepEqual(
    unreadable.map((writer) => writer.location),
    [],
    "a UserSettings create whose data is not an object literal cannot be checked; " +
      "write the object inline"
  );

  const missing = writers.filter(
    (writer) => writer.object && !propertyNamed(writer.object, "defaultModel")
  );
  assert.deepEqual(
    missing.map((writer) => writer.location),
    [],
    "these writes would take defaultModel from the column default; pass " +
      "APP_DEFAULTS.defaultModelId (or the model the request chose) explicitly"
  );
});
