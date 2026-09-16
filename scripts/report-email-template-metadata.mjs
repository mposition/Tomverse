// Where do stored template metadata and the code disagree?
//
//   npm run report:email-template-metadata
//   npm run report:email-template-metadata -- --json
//
// Contract: docs/policy/email-notifications.md §10.2.
//
// The migration that moved classification, purpose and requiresUnsubscribe onto
// TemplateVersion backfilled every version from its EmailTemplate row -- the
// value in force when it was published -- and deliberately corrected nothing.
// This lists what it did not correct: template rows and published versions
// whose send metadata differs from the definition in code.
//
// Writes nothing and exits 0 whatever it finds. A drifted *template row* is
// history and harmless now. A drifted *published version* is what the drain
// refuses, so a queued message pinned to one fails with
// `template_metadata_mismatch`; the next enqueue registers a new version.

import {
  EMAIL_TEMPLATE_KEYS,
  emailTemplateDefinition,
} from "../lib/emailTemplateDefinitions.ts";
import {
  templateMetadataMismatches,
  templateSendMetadata,
} from "../lib/emailTemplateMetadataCore.ts";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

const definitions = new Map(
  EMAIL_TEMPLATE_KEYS.map((key) => [key, templateSendMetadata(emailTemplateDefinition(key))])
);

let note = "No DATABASE_URL: nothing to compare the definitions against.";
const templateRows = [];
const versionRows = [];
const unknownKeys = [];

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const templates = await prisma.emailTemplate.findMany({
      select: {
        key: true,
        classification: true,
        purpose: true,
        requiresUnsubscribe: true,
        versions: {
          where: { status: "published" },
          select: {
            id: true,
            language: true,
            version: true,
            classification: true,
            purpose: true,
            requiresUnsubscribe: true,
          },
          orderBy: [{ language: "asc" }, { version: "asc" }],
        },
      },
      orderBy: { key: "asc" },
    });
    await prisma.$disconnect().catch(() => undefined);

    for (const template of templates) {
      const expected = definitions.get(template.key);
      if (!expected) {
        unknownKeys.push(template.key);
        continue;
      }
      const rowMismatches = templateMetadataMismatches(template, expected);
      if (rowMismatches.length > 0) {
        templateRows.push({ key: template.key, mismatches: rowMismatches });
      }
      for (const version of template.versions) {
        const mismatches = templateMetadataMismatches(version, expected);
        if (mismatches.length > 0) {
          versionRows.push({
            key: template.key,
            templateVersionId: version.id,
            language: version.language,
            version: version.version,
            mismatches,
          });
        }
      }
    }
    note = `Read ${templates.length} template row(s).`;
  } catch (error) {
    const message = String(error?.message || error).replaceAll(databaseUrl, "[redacted]");
    note = `DATABASE_URL was set but unreadable, so nothing was compared: ${message.slice(0, 200)}`;
  }
}

if (json) {
  console.log(JSON.stringify({ note, templateRows, versionRows, unknownKeys }, null, 2));
} else {
  const describe = (mismatches) =>
    mismatches.map((m) => `${m.field} stored=${m.stored} code=${m.expected}`).join(", ");

  console.log(`Email template metadata\n  ${note}\n`);
  console.log(`  ${versionRows.length} published version(s) that differ from the code.`);
  if (versionRows.length > 0) {
    console.log("  The drain refuses messages pinned to these; the next enqueue registers a new version.");
    for (const row of versionRows) {
      console.log(`    ${row.key} ${row.language} v${row.version}: ${describe(row.mismatches)}`);
    }
  }
  console.log(`\n  ${templateRows.length} template row(s) that differ from the code.`);
  if (templateRows.length > 0) {
    console.log("  History only -- no send is decided from these rows.");
    for (const row of templateRows) {
      console.log(`    ${row.key}: ${describe(row.mismatches)}`);
    }
  }
  if (unknownKeys.length > 0) {
    console.log(`\n  ${unknownKeys.length} stored template key(s) the code no longer defines:`);
    for (const key of unknownKeys) console.log(`    ${key}`);
  }
}
