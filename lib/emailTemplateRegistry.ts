import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

/** `prisma` or a transaction client: both answer the one read shared below. */
type PrismaLike = Pick<typeof prisma, "templateVersion">;
import {
  emailTemplateDefinition,
  type RenderedEmail,
} from "@/lib/emailTemplateDefinitions";

/**
 * Reconciles the templates in code with the rows a delivery can point at.
 *
 * Contract: docs/policy/email-notifications.md §10.2.
 *
 * Published versions are immutable, so changed copy becomes a *new* version
 * rather than an update. That is the difference between this and the seeding
 * pattern AGENTS.md warns about for `creditWeight`: there, `skipDuplicates`
 * left existing rows holding a value the code no longer said and nothing
 * reported the divergence. Here the content hash is part of the lookup, so code
 * that has moved on cannot silently keep pointing at the old row -- and the
 * deliveries that referenced the old version still describe what they sent.
 */

const BOOTSTRAP_POLICY_VERSION = "2026-08-21.1";

/** Unkeyed on purpose: this detects template drift, it guards nothing. */
export const templateContentHash = (parts: RenderedEmail) =>
  createHash("sha256")
    .update(`${parts.subject}\n${parts.html}\n${parts.text}`)
    .digest("hex");

/**
 * Prisma reports a unique-constraint conflict as P2002 regardless of which
 * index caught it, which is all the callers below need to know.
 */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002";

/**
 * An upsert that survives a second caller doing the same upsert at the moment.
 *
 * `prisma.upsert` on a row that does not exist yet is a read followed by an
 * insert, so two callers can both read "absent" and both insert; the unique
 * index lets one through and the other gets P2002. That is not an error here --
 * the row the winner wrote is the row this caller wanted -- so it is read back.
 *
 * The same reasoning already guarded `templateVersion.create` below, one
 * statement further down. It did not guard the two upserts, and the gap is not
 * theoretical: a campaign detail view asks the send gate and the content digest
 * in parallel, both ensure the same template, and the P2002 took the whole page
 * down. On the credential lane the same race is two people signing in for the
 * first time after a copy change, where losing it means one of them never
 * receives their code.
 */
const upsertSurvivingRace = async <T>(input: {
  upsert: () => Promise<T>;
  readBack: () => Promise<T | null>;
}): Promise<T> => {
  try {
    return await input.upsert();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await input.readBack();
    if (!raced) throw error;
    return raced;
  }
};

/**
 * The policy version deliveries resolve against.
 *
 * Bootstrap only: it carries no jurisdiction profile beyond the fallback,
 * because transactional and legal mail branch on none of them -- no advertising
 * label, no unsubscribe SLA, no quiet hours. The eight real profiles arrive with
 * M7 as a *new* version that a human approves, which is the only way a policy
 * version is ever supposed to become active (§12.5). This exists so the delivery
 * row has something truthful to point at in the meantime.
 */
export async function ensureBootstrapPolicyVersion(): Promise<string> {
  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (active) return active.id;

  const created = await upsertSurvivingRace({
    upsert: () =>
      prisma.emailPolicyVersion.upsert({
        where: { version: BOOTSTRAP_POLICY_VERSION },
        update: {},
        create: {
          version: BOOTSTRAP_POLICY_VERSION,
          status: "active",
          activatedAt: new Date(),
          changeSummary:
            "Bootstrap: transactional-only. Jurisdiction profiles land with M7 " +
            "as a separately approved version.",
        },
        select: { id: true },
      }),
    readBack: () =>
      prisma.emailPolicyVersion.findUnique({
        where: { version: BOOTSTRAP_POLICY_VERSION },
        select: { id: true },
      }),
  });
  return created.id;
}

/**
 * The published TemplateVersion for one template and language, creating it if
 * the copy in code has no matching row yet.
 *
 * Registers the template rendered with its *placeholder* payload, never with a
 * real one: a rendered message differs on every send, so hashing it would mint
 * a version per request and fill the table with one row per email.
 */
export async function ensureTemplateVersion(input: {
  templateKey: string;
  language: string;
}): Promise<{ templateId: string; templateVersionId: string }> {
  const definition = emailTemplateDefinition(input.templateKey);
  const rendered = definition.render(
    definition.placeholderPayload,
    input.language
  );
  const contentHash = templateContentHash(rendered);

  const template = await upsertSurvivingRace({
    upsert: () =>
      prisma.emailTemplate.upsert({
        where: { key: definition.key },
        update: {},
        create: {
          key: definition.key,
          classification: definition.classification,
          purpose: definition.purpose,
          requiresUnsubscribe: definition.requiresUnsubscribe,
        },
        select: { id: true },
      }),
    readBack: () =>
      prisma.emailTemplate.findUnique({
        where: { key: definition.key },
        select: { id: true },
      }),
  });

  const publishedMatch = (client: PrismaLike) =>
    client.templateVersion.findFirst({
      where: {
        templateId: template.id,
        language: input.language,
        contentHash,
        status: "published",
      },
      select: { id: true },
    });

  // The steady state: the copy has not moved and the row already exists. It
  // takes no lock, which is what keeps the lock below off the send path -- only
  // the first send after a copy change pays for it.
  const existing = await publishedMatch(prisma);
  if (existing) {
    return { templateId: template.id, templateVersionId: existing.id };
  }

  // Serialized per template and language, because the unique index cannot do
  // it. The index is on `(templateId, language, version)`, so two callers that
  // read `latest` at different moments write versions N and N+1 and *both*
  // succeed -- two published rows for one piece of copy, with the same content
  // hash. The send gate compares hashes and is unharmed, but "which version did
  // we send" then has two answers for copy that never changed, which is the
  // one thing this registry exists to be able to answer.
  //
  // `pg_advisory_xact_lock` rather than a row lock: there is no row to lock
  // yet, and it releases when the transaction ends however it ends.
  const versionId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-template-version:${template.id}:${input.language}`}))`;

    // Asked again inside the lock: the caller that held it before this one may
    // have written exactly this row.
    const settled = await publishedMatch(tx);
    if (settled) return settled.id;

    const latest = await tx.templateVersion.findFirst({
      where: { templateId: template.id, language: input.language },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    try {
      const created = await tx.templateVersion.create({
        data: {
          templateId: template.id,
          language: input.language,
          version: (latest?.version ?? 0) + 1,
          subject: rendered.subject,
          bodyHtml: rendered.html,
          bodyText: rendered.text,
          contentHash,
          status: "published",
          publishedAt: new Date(),
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      // Kept even with the lock above. A caller on another process that has not
      // taken the lock -- a migration, a console, an older deployment mid-roll
      // -- can still write version N+1 first, and losing that race is not an
      // error: the row the winner wrote is the row this caller wanted. Left
      // unhandled it would surface as a failed sign-in or a dropped receipt,
      // which is a spectacular consequence for two people acting at once.
      if (!isUniqueViolation(error)) throw error;
      const raced = await publishedMatch(tx);
      if (!raced) throw error;
      return raced.id;
    }
  });

  return { templateId: template.id, templateVersionId: versionId };
}
