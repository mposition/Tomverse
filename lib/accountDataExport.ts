import "server-only";

// The unified account export PRIVACY-02 grades.
//
// The domain states live in lib/accountDataExportDomains.ts, which is free of
// Prisma so the registry validator can import it. This file supplies a fetcher
// for every domain that is exported at all -- `included` or `included_filtered`
// -- and `exportDomainWiringProblems` keeps the two in step: an exported domain
// with no fetcher, or a fetcher for a domain declared excluded or unverified,
// is a wiring bug rather than a silent gap.

import {
  EXPORT_DOMAIN_DECLARATIONS,
  isExportedState,
  type ExportDomainDeclaration,
} from "@/lib/accountDataExportDomains";
import { prisma } from "@/lib/prisma";

/**
 * Bumped whenever the shape of the file changes in a way a reader has to know
 * about: a renamed key, a removed field, a different manifest. Domains coming
 * and going do not move it, because the manifest already names them.
 */
export const EXPORT_SCHEMA_VERSION = 1;

const EXPORT_ROW_CAP = 5_000;

/**
 * One fetcher per included domain, each with an explicit field allowlist.
 *
 * Never a spread, never `include`, never "everything except". This repository
 * has already shipped the other pattern once, when /api/models/catalog spread a
 * registry row and published Tomverse's per-model USD cost basis to anyone who
 * asked. An export is the same mistake with the user's data on one side and the
 * company's internals on the other, so a new column stays invisible here until
 * somebody adds it deliberately.
 */
const FETCHERS: Record<string, (userId: string) => Promise<unknown[]>> = {
  userSettings: (userId) =>
    prisma.userSettings.findMany({
      where: { userId },
      select: {
        theme: true,
        language: true,
        defaultModel: true,
        newConversationModelIds: true,
        preferredTasks: true,
        preferredPriority: true,
        usesFilesFrequently: true,
        timeZone: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  userMemorySettings: (userId) =>
    prisma.userMemorySettings.findMany({
      where: { userId },
      select: {
        masterEnabled: true,
        styleEnabled: true,
        defaultConversationMode: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  conversation: (userId) =>
    prisma.conversation.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        kind: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          select: { role: true, content: true, modelId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  conversationProject: (userId) =>
    prisma.conversationProject.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
      take: EXPORT_ROW_CAP,
    }),

  memoryItem: (userId) =>
    prisma.memoryItem.findMany({
      where: { userId },
      select: {
        id: true,
        kind: true,
        statement: true,
        status: true,
        sensitivity: true,
        confidence: true,
        importance: true,
        pinned: true,
        userEdited: true,
        expiresAt: true,
        approvedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  // Amounts the user was charged -- not what those requests cost Tomverse.
  // That distinction is the whole reason these are listed field by field.
  billingTransaction: (userId) =>
    prisma.billingTransaction.findMany({
      where: { userId },
      select: {
        id: true,
        productType: true,
        billingInterval: true,
        amountPaidMinor: true,
        currency: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // What the user bought and what is left of it. The funded-cost and
  // dispute-revocation columns are Tomverse's side of the same row.
  creditPurchase: (userId) =>
    prisma.creditPurchase.findMany({
      where: { userId },
      select: {
        id: true,
        packId: true,
        creditsPurchased: true,
        amountPaidCents: true,
        currency: true,
        refundedAmountCents: true,
        status: true,
        purchasedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  feedback: (userId) =>
    prisma.feedback.findMany({
      where: { userId },
      select: { id: true, message: true, status: true, createdAt: true },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The profile and the plan the user is on. Everything
  // Tomverse concluded *about* them -- billing risk, the security incident
  // note, why they were suspended and which operator did it -- is an internal
  // signal, and handing a user their own fraud assessment both teaches an
  // abuser how the controls work and exposes the operator behind them.
  user: (userId) =>
    prisma.user.findMany({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        accountStatus: true,
        accountDeletionScheduledFor: true,
        emailLoginEnabled: true,
        lastLoginAt: true,
        createdAt: true,
      },
    }),

  // included_filtered. Which providers are linked, never the tokens: an
  // exported refresh token is a live credential for the user's Google,
  // Microsoft or Apple account, and the export file would become one too.
  account: (userId) =>
    prisma.account.findMany({
      where: { userId },
      select: { provider: true, type: true },
    }),

  // included_filtered. When a session exists and when it lapses, never the
  // token -- a copy of that is a usable session.
  session: (userId) =>
    prisma.session.findMany({
      where: { userId },
      select: { expires: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The user's own usage record: which model, what
  // happened, how many credits it cost them, and when. The micro-USD cost
  // fields, pricingSnapshot, provider request identifiers and internal error
  // text are Tomverse's provider cost basis and stay out.
  chatCreditReservation: (userId) =>
    prisma.chatCreditReservation.findMany({
      where: { userId },
      select: {
        modelId: true,
        provider: true,
        status: true,
        outcome: true,
        reservedCredits: true,
        settledCredits: true,
        settledInputTokens: true,
        settledOutputTokens: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  imageCreditReservation: (userId) =>
    prisma.imageCreditReservation.findMany({
      where: { userId },
      select: {
        modelId: true,
        provider: true,
        status: true,
        outcome: true,
        preset: true,
        quality: true,
        size: true,
        reservedCredits: true,
        settledCredits: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  memoryExtractionCreditReservation: (userId) =>
    prisma.memoryExtractionCreditReservation.findMany({
      where: { userId },
      select: {
        extractionModelId: true,
        provider: true,
        status: true,
        outcome: true,
        chunkTotal: true,
        chunksCharged: true,
        reservedCredits: true,
        settledCredits: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The user's own record of who downloaded their account
  // data and when -- which is exactly the trail that has to survive an export
  // being taken by someone who should not have had it. The token hash is the
  // download credential and the request-context hashes identify a device, so
  // neither belongs in a file the user may forward.
  accountDataExportRequest: (userId) =>
    prisma.accountDataExportRequest.findMany({
      where: { userId },
      select: {
        status: true,
        refusalReason: true,
        expiresAt: true,
        consumedAt: true,
        exportSchemaVersion: true,
        includedDomainCount: true,
        filteredDomainCount: true,
        byteLength: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  privacyRequest: (userId) =>
    prisma.privacyRequest.findMany({
      where: { userId },
      // handledById and handledByEmail identify a Tomverse operator, not the
      // requester, so they stay internal.
      select: { id: true, requestType: true, status: true, createdAt: true, completedAt: true },
      take: EXPORT_ROW_CAP,
    }),
};

/**
 * Every exported domain needs a fetcher, every fetcher a declaration, and every
 * partial answer its reason.
 *
 * `included_filtered` is the state that needs the most care: it hands the user
 * a projection of a table and tells them so. Without `withheldReason` the user
 * receives something that looks complete and is not, which is worse than an
 * outright exclusion because nothing on the page says so.
 */
export const exportDomainWiringProblems = () => {
  const problems: string[] = [];
  const publicNames = new Map<string, string>();

  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    const exported = isExportedState(declaration.state);

    if (exported && !FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} is declared ${declaration.state} but has no fetcher`);
    }
    if (!exported && FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} has a fetcher but is declared ${declaration.state}`);
    }
    if (declaration.state === "excluded" && !declaration.exclusionReason?.trim()) {
      problems.push(`${declaration.domain} is excluded without a reason`);
    }
    if (declaration.state !== "excluded" && declaration.exclusionReason?.trim()) {
      problems.push(`${declaration.domain} is ${declaration.state} but explains an exclusion`);
    }
    if (declaration.state === "included_filtered" && !declaration.withheldReason?.trim()) {
      problems.push(
        `${declaration.domain} is included_filtered without a withheldReason. A projection the ` +
          "user is not told about reads as a complete answer."
      );
    }
    if (declaration.state !== "included_filtered" && declaration.withheldReason?.trim()) {
      problems.push(`${declaration.domain} is ${declaration.state} but explains a projection`);
    }

    // The public name is the part of this file a user's own tooling depends on,
    // so it has to be stable, unique, and obviously not a Prisma model name.
    if (!/^[a-z][a-z0-9_]*$/.test(declaration.publicName)) {
      problems.push(
        `${declaration.domain} has publicName "${declaration.publicName}", which is not a stable ` +
          "lower_snake_case name"
      );
    }
    const claimedBy = publicNames.get(declaration.publicName);
    if (claimedBy) {
      problems.push(
        `publicName "${declaration.publicName}" is claimed by both ${claimedBy} and ${declaration.domain}`
      );
    } else {
      publicNames.set(declaration.publicName, declaration.domain);
    }
  }

  for (const domain of Object.keys(FETCHERS)) {
    if (!EXPORT_DOMAIN_DECLARATIONS.some((declaration) => declaration.domain === domain)) {
      problems.push(`${domain} has a fetcher but no declaration`);
    }
  }
  return problems;
};

export type AccountDataExportManifest = {
  schemaVersion: number;
  generatedAt: string;
  /** Present in full. */
  includedDomains: string[];
  /** Present as a projection, each with what was held back and why. */
  filteredDomains: { domain: string; reason: string }[];
  /** Named with their reasons, so an export says what it is not. */
  excludedDomains: { domain: string; reason: string }[];
  /** Named without data, so a gap is visible rather than absent. */
  undecidedDomains: string[];
  /**
   * Domains that hit the row cap. A truncated list is indistinguishable from a
   * complete one unless the file says which it is.
   */
  truncatedDomains: { domain: string; rowCap: number }[];
};

export type AccountDataExport = {
  manifest: AccountDataExportManifest;
  userId: string;
  /** Keyed by public domain name, never by Prisma model name. */
  data: Record<string, unknown[]>;
};

/**
 * Builds the export. Excluded and undecided domains are named in the manifest
 * rather than omitted: an export that silently leaves a domain out is
 * indistinguishable from one where the domain held nothing, and a user cannot
 * tell they were given a partial answer.
 */
export const buildAccountDataExport = async (userId: string): Promise<AccountDataExport> => {
  const wiringProblems = exportDomainWiringProblems();
  if (wiringProblems.length > 0) {
    // Refuse rather than hand out a silently incomplete export.
    throw new Error(`Account export is mis-wired: ${wiringProblems.join("; ")}`);
  }

  const data: Record<string, unknown[]> = {};
  const includedDomains: string[] = [];
  const filteredDomains: { domain: string; reason: string }[] = [];
  const truncatedDomains: { domain: string; rowCap: number }[] = [];

  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    const fetch = FETCHERS[declaration.domain];
    if (!isExportedState(declaration.state) || !fetch) continue;

    const rows = await fetch(userId);
    data[declaration.publicName] = rows;

    if (declaration.state === "included_filtered") {
      filteredDomains.push({
        domain: declaration.publicName,
        reason: declaration.withheldReason ?? "",
      });
    } else {
      includedDomains.push(declaration.publicName);
    }
    if (rows.length >= EXPORT_ROW_CAP) {
      truncatedDomains.push({ domain: declaration.publicName, rowCap: EXPORT_ROW_CAP });
    }
  }

  return {
    manifest: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      includedDomains,
      filteredDomains,
      excludedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
        (declaration) => declaration.state === "excluded"
      ).map((declaration) => ({
        domain: declaration.publicName,
        reason: declaration.exclusionReason ?? "",
      })),
      undecidedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
        (declaration) => declaration.state === "unverified"
      ).map((declaration) => declaration.publicName),
      truncatedDomains,
    },
    userId,
    data,
  };
};

export const EXPORT_DOMAINS: ExportDomainDeclaration[] = EXPORT_DOMAIN_DECLARATIONS;
