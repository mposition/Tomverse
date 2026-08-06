import "server-only";

// The unified account export PRIVACY-02 grades.
//
// The domain states live in lib/accountDataExportDomains.ts, which is free of
// Prisma so the registry validator can import it. This file supplies a fetcher
// for each included domain, and `exportDomainWiringProblems` keeps the two in
// step: an included domain with no fetcher, or a fetcher for a domain declared
// otherwise, is a wiring bug rather than a silent gap.

import {
  EXPORT_DOMAIN_DECLARATIONS,
  type ExportDomainDeclaration,
} from "@/lib/accountDataExportDomains";
import { prisma } from "@/lib/prisma";

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
        defaultModelId: true,
        language: true,
        theme: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  userMemorySettings: (userId) =>
    prisma.userMemorySettings.findMany({
      where: { userId },
      select: { memoryEnabled: true, createdAt: true, updatedAt: true },
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
      select: { id: true, name: true, instructions: true, createdAt: true, updatedAt: true },
      take: EXPORT_ROW_CAP,
    }),

  memoryItem: (userId) =>
    prisma.memoryItem.findMany({
      where: { userId },
      select: {
        id: true,
        content: true,
        category: true,
        status: true,
        confidence: true,
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

  creditPurchase: (userId) =>
    prisma.creditPurchase.findMany({
      where: { userId },
      select: { id: true, credits: true, status: true, createdAt: true },
      take: EXPORT_ROW_CAP,
    }),

  feedback: (userId) =>
    prisma.feedback.findMany({
      where: { userId },
      select: { id: true, message: true, status: true, createdAt: true },
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

/** Every included domain needs a fetcher, and every fetcher a declaration. */
export const exportDomainWiringProblems = () => {
  const problems: string[] = [];
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    if (declaration.state === "included" && !FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} is declared included but has no fetcher`);
    }
    if (declaration.state !== "included" && FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} has a fetcher but is declared ${declaration.state}`);
    }
    if (declaration.state === "excluded" && !declaration.exclusionReason?.trim()) {
      problems.push(`${declaration.domain} is excluded without a reason`);
    }
  }
  for (const domain of Object.keys(FETCHERS)) {
    if (!EXPORT_DOMAIN_DECLARATIONS.some((declaration) => declaration.domain === domain)) {
      problems.push(`${domain} has a fetcher but no declaration`);
    }
  }
  return problems;
};

export type AccountDataExport = {
  exportedAt: string;
  userId: string;
  /** Domains actually present below. */
  includedDomains: string[];
  /** Named with their reasons, so an export says what it is not. */
  excludedDomains: { domain: string; reason: string }[];
  /** Named without data, so a gap is visible rather than absent. */
  undecidedDomains: string[];
  data: Record<string, unknown[]>;
};

/**
 * Builds the export. Excluded and undecided domains are named in the output
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

  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    const fetch = FETCHERS[declaration.domain];
    if (declaration.state !== "included" || !fetch) continue;
    data[declaration.domain] = await fetch(userId);
    includedDomains.push(declaration.domain);
  }

  return {
    exportedAt: new Date().toISOString(),
    userId,
    includedDomains,
    excludedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
      (declaration) => declaration.state === "excluded"
    ).map((declaration) => ({
      domain: declaration.domain,
      reason: declaration.exclusionReason ?? "",
    })),
    undecidedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
      (declaration) => declaration.state === "unverified"
    ).map((declaration) => declaration.domain),
    data,
  };
};

export const EXPORT_DOMAINS: ExportDomainDeclaration[] = EXPORT_DOMAIN_DECLARATIONS;
