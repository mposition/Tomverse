import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  emailTemplateDefinition,
  type RenderedEmail,
} from "@/lib/emailTemplateDefinitions";

/**
 * Reconciles the templates in code with the rows a delivery can point at.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §10.2.
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
 * index caught it, which is all the caller below needs to know.
 */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002";

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

  const created = await prisma.emailPolicyVersion.upsert({
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

  const template = await prisma.emailTemplate.upsert({
    where: { key: definition.key },
    update: {},
    create: {
      key: definition.key,
      classification: definition.classification,
      purpose: definition.purpose,
      requiresUnsubscribe: definition.requiresUnsubscribe,
    },
    select: { id: true },
  });

  const existing = await prisma.templateVersion.findFirst({
    where: {
      templateId: template.id,
      language: input.language,
      contentHash,
      status: "published",
    },
    select: { id: true },
  });
  if (existing) {
    return { templateId: template.id, templateVersionId: existing.id };
  }

  const latest = await prisma.templateVersion.findFirst({
    where: { templateId: template.id, language: input.language },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  try {
    const created = await prisma.templateVersion.create({
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
    return { templateId: template.id, templateVersionId: created.id };
  } catch (error) {
    // Two sends arriving together after a copy change both read the same
    // `latest` and both try to write version N+1; the unique index lets one
    // through. Losing that race is not an error -- the row the winner wrote is
    // the row this caller wanted -- so it is read back rather than propagated.
    // Left unhandled it would surface as a failed sign-in or a dropped receipt,
    // which is a spectacular consequence for two people acting at once.
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.templateVersion.findFirst({
      where: {
        templateId: template.id,
        language: input.language,
        contentHash,
        status: "published",
      },
      select: { id: true },
    });
    if (!raced) throw error;
    return { templateId: template.id, templateVersionId: raced.id };
  }
}
