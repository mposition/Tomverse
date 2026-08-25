import "server-only";

import { providerApiKeyFor } from "@/lib/emailProviderPortCore";
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
  // Through the same resolver the sender uses, not `RESEND_API_KEY` directly.
  // This file read that one variable while `providerApiKeyFor()` prefers
  // `TRANSACTIONAL_RESEND_API_KEY`, so a deployment that set the specific name
  // would send with one key and report with another -- and the report's failure
  // would look like a fact about the domains. Two readings of one credential is
  // the same shape as the two readings of one sender that put three of four
  // senders on a stale domain (docs/ops/email-sending-domains.md §1.2).
  const apiKey = providerApiKeyFor("transactional", environment);

  if (!apiKey) {
    return {
      checkedAt,
      configured,
      providerDomains: null,
      providerError:
        "No provider API key is set for the transactional stream on this deployment, so the provider's domain status cannot be read.",
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
      // 401 is the ordinary answer from a sending-only key: Resend permits
      // `POST /emails` on one and refuses `GET /domains`. Said here rather than
      // left to the runbook, because the screen showing this is where somebody
      // reads it (docs/ops/email-sending-domains.md §3.5.2).
      providerError:
        response.status === 401
          ? "The provider answered 401 when listing domains. A sending-only API key gets this and still sends mail normally, so this is expected unless a test send also fails."
          : `The provider answered ${response.status} when listing domains.`,
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
