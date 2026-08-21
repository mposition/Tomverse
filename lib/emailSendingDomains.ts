import "server-only";

import { configuredSendingDomains } from "@/lib/emailSendingIdentity";
import {
  domainReportFindings,
  parseProviderDomains,
  type DomainFinding,
  type ProviderDomain,
} from "@/lib/emailSendingDomainsCore";

/**
 * What the provider says about the domains we send from.
 *
 * Contract: docs/policy/email-notifications.md §14.1, §17.3.
 *
 * Read-only. It lists domains and their DNS record status; it does not create,
 * verify or delete one. Registering a sending domain is a change to the
 * account's outward identity and to a DNS zone this process does not own, so
 * it stays an operator action with the runbook beside it
 * (docs/ops/email-sending-domains.md).
 */

const DOMAINS_ENDPOINT = "https://api.resend.com/domains";
const REQUEST_TIMEOUT_MS = 8_000;

export type SendingDomainReport = {
  checkedAt: string;
  configured: { transactional: string | null; marketing: string | null };
  /** Null when the provider could not be reached or is not configured. */
  providerDomains: ProviderDomain[] | null;
  providerError: string | null;
  findings: DomainFinding[];
};

/**
 * Fetch and evaluate. Never throws.
 *
 * A provider outage produces a report that says the provider could not be
 * reached, with no findings -- rather than findings derived from an empty list,
 * which would claim every configured domain is unregistered and send somebody
 * to re-create domains that already exist.
 */
export async function readSendingDomainReport(
  environment: NodeJS.ProcessEnv = process.env
): Promise<SendingDomainReport> {
  const configured = configuredSendingDomains(environment);
  const checkedAt = new Date().toISOString();
  const apiKey = environment.RESEND_API_KEY;

  if (!apiKey) {
    return {
      checkedAt,
      configured,
      providerDomains: null,
      providerError:
        "RESEND_API_KEY is not set on this deployment, so the provider's domain status cannot be read.",
      findings: [],
    };
  }

  let response: Response;
  try {
    response = await fetch(DOMAINS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      checkedAt,
      configured,
      providerDomains: null,
      // The message only: a transport error can carry the request URL, and the
      // URL carries nothing secret here, but the shape of "log whatever came
      // back" is how a key ends up in a report screen.
      providerError:
        error instanceof Error
          ? `The provider could not be reached: ${error.name}`
          : "The provider could not be reached.",
      findings: [],
    };
  }

  if (!response.ok) {
    await response.text().catch(() => "");
    return {
      checkedAt,
      configured,
      providerDomains: null,
      providerError: `The provider answered ${response.status} when listing domains.`,
      findings: [],
    };
  }

  const payload = await response.json().catch(() => null);
  const providerDomains = parseProviderDomains(payload);

  return {
    checkedAt,
    configured,
    providerDomains,
    providerError: null,
    findings: domainReportFindings({
      transactionalDomain: configured.transactional,
      marketingDomain: configured.marketing,
      providerDomains,
    }),
  };
}
