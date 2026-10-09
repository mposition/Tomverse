// The readiness checks behind /api/ready, computed without side effects.
//
// Moved verbatim out of app/api/ready/route.ts so that a second reader -- the
// sre-ops agent's ops snapshot (docs/policy/sre-ops.md §8, S1a) -- asks exactly
// the same questions instead of a copy that drifts. This module only computes:
// it reports nothing, schedules nothing and writes nothing. The route keeps the
// trace id, the response and the after() reporting.

import { prisma } from "@/lib/prisma";
import { getSecurityEnvironmentStatus } from "@/lib/securityEnvironment";
import { getImageProviderBudgetReadiness } from "@/lib/imageProviderBudgetReadiness";
import { getVoiceModelPriceReadiness } from "@/lib/voiceModelPriceReadiness";
import { getVoiceProviderBudgetReadiness } from "@/lib/voiceProviderBudgetReadiness";
import { getSearchProviderBudgetReadiness } from "@/lib/searchProviderBudgetReadiness";
import { getSendingIdentityReadiness } from "@/lib/emailSendingIdentity";
import { snapshotKeyringReadiness } from "@/lib/emailSnapshotCrypto";
import { businessIdentityReadiness } from "@/lib/emailBusinessIdentity";
import { subjectLabelReadiness } from "@/lib/emailSubjectLabelReadiness";
import { biennialNoticeReadiness } from "@/lib/biennialConsentNoticeReadiness";
import { footerDisclosureReadiness } from "@/lib/emailFooterDisclosureReadiness";
import { marketingSendingConfigured } from "@/lib/emailUnsubscribeReadiness";
import { unsubscribeKeyringReadiness } from "@/lib/emailUnsubscribeReadiness";
import { getUnsubscribeKeyRetentionReadiness } from "@/lib/emailUnsubscribeKeyRetention";
import { consentKeyringReadiness } from "@/lib/emailConsentReadiness";
import { AVAILABLE_MODELS } from "@/lib/models";
import { amuxReviewApprovalReadiness } from "@/lib/amux/reviewApprovalCore";
import {
  getActiveProviders,
  getProviderBudgetReadiness,
} from "@/lib/providerCostBudget";

const DATABASE_CHECK_TIMEOUT_MS = 5_000;

const withDeadline = async <T>(work: Promise<T>, ms: number, message: string) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const checkDatabase = async () => {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Database readiness check timed out.")),
        DATABASE_CHECK_TIMEOUT_MS
      );
    });
    const result = await Promise.race([
      prisma.$queryRaw<Array<{ ready: number }>>`SELECT 1 AS "ready"`,
      timeoutPromise,
    ]);
    return {
      ready: result[0]?.ready === 1,
      error: undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ready: false,
      error,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export async function computeReadinessChecks() {
  const databaseResult = await checkDatabase();
  const securityStatus = getSecurityEnvironmentStatus();
  const securityEnvironment =
    process.env.NODE_ENV !== "production" || securityStatus.ready;
  // A provider budget is a global cap: misconfigured, it refuses every user of
  // that provider at once. Refusing traffic here is the cheaper failure.
  const budgetStatus = getProviderBudgetReadiness(
    getActiveProviders(AVAILABLE_MODELS)
  );
  const providerBudgets = budgetStatus.ready;
  // The image budget gates readiness only while the image generation flag is
  // ON: "flag off, budget absent" is the legal intermediate state of the
  // env-first deploy order (docs/policy/image-generation.md section 8). That
  // state is decided inside the function, which returns ready, so a thrown
  // error is never it -- it means the derivation itself failed, and the honest
  // answer to "is the budget usable?" is that nobody knows.
  //
  // This used to read `status?.ready ?? true`, which answered that question
  // with "yes". A missing environment variable was fatal while the check that
  // finds missing environment variables blowing up was healthy, so the louder
  // the failure the quieter the endpoint.
  const imageBudgetStatus = await getImageProviderBudgetReadiness().then(
    (status) => ({ status, error: null as string | null }),
    (error: unknown) => ({
      status: null,
      error:
        error instanceof Error
          ? error.message
          : "The image provider budget readiness check threw.",
    })
  );
  const imageProviderBudget = imageBudgetStatus.status?.ready ?? false;
  // The audio budget, on the same terms and for the same reason: flag off is
  // the legal intermediate state of an env-first deploy, flag on with no
  // budget is a misconfiguration between this product and unbounded
  // third-party usage (docs/policy/voice-input.md §6.1-4). It is a usage
  // budget, in seconds: it bounds how much audio leaves here, not how many
  // dollars that becomes. A thrown check is not "ready" -- nobody knows,
  // which is the answer that refuses traffic.
  const voiceBudgetStatus = await getVoiceProviderBudgetReadiness().then(
    (status) => ({ status, error: null as string | null }),
    (error: unknown) => ({
      status: null,
      error:
        error instanceof Error
          ? error.message
          : "The voice provider budget readiness check threw.",
    })
  );
  const voiceProviderBudget = voiceBudgetStatus.status?.ready ?? false;
  // Whether this deployment knows what its configured transcription model
  // costs, which is a different question from whether it has a budget: a
  // budget in seconds bounds how much audio leaves, and says nothing about a
  // model whose per-token price nobody has observed. CI cannot answer this one
  // because the model is an environment variable
  // (docs/policy/voice-input.md §6.1.4), so the running deployment has to.
  const voiceModelPriceStatus = await getVoiceModelPriceReadiness().then(
    (status) => ({ status, error: null as string | null }),
    (error: unknown) => ({
      status: null,
      error:
        error instanceof Error
          ? error.message
          : "The voice transcription model price readiness check threw.",
    })
  );
  const voiceModelPrice = voiceModelPriceStatus.status?.ready ?? false;
  // The search vendor this application calls itself. Unlike the image budget
  // there is no flag to be off: the capability register is compiled in, so a
  // build that ships Google models searching through a backend has already
  // decided. What this refuses is a production deployment that would offer the
  // search switch with no credential behind it, or spend at a vendor whose
  // operational cap could not be read. Deploy the variables first, the build
  // second -- the same order the provider budgets take.
  const searchBudgetStatus = (() => {
    try {
      return {
        status: getSearchProviderBudgetReadiness(),
        error: null as string | null,
      };
    } catch (error) {
      // The derivation itself failed, which is never "the budget is fine". Same
      // reasoning as the image budget above: the louder the failure, the
      // quieter this endpoint must not become.
      return {
        status: null,
        error:
          error instanceof Error
            ? error.message
            : "The search provider budget readiness check threw.",
      };
    }
  })();
  const searchProviderBudget = searchBudgetStatus.status?.ready ?? false;
  // The sending domains. Errors here are configurations that would send from
  // the wrong domain or from nothing at all; the outstanding move of
  // transactional mail onto its own subdomain
  // (docs/policy/email-notifications.md §14.1) is a warning, because gating on
  // it would refuse readiness on today's deployment in order to announce a
  // planned migration.
  const sendingIdentity = getSendingIdentityReadiness();
  const emailSendingIdentity = sendingIdentity.ready;
  // The keyring the standard lane seals its render snapshots with. Unlike the
  // image budget, there is no flag to be off: the lane is live wherever this
  // code is, it refuses to store the snapshot unencrypted, and its callers
  // swallow the throw so the user's own action still succeeds. Without this
  // check a deployment answers ready while every welcome email, receipt and
  // deletion notice is dropped -- and the first report of it is somebody
  // saying they never got a receipt.
  const snapshotKeyring = snapshotKeyringReadiness();
  const emailSnapshotKeyring = snapshotKeyring.ready;
  // The one-click unsubscribe keyring, and the only email dependency here that
  // is conditional. It becomes an error once MARKETING_EMAIL_FROM is set --
  // the state where a deployment answers ready while every marketing send is
  // refused for having no unsubscribe link (EM-10). Until then a missing key
  // is a warning, because gating on it would refuse today's deployment to
  // announce a capability nobody has turned on. A keyring that is present and
  // broken is an error either way.
  const unsubscribeKeyring = unsubscribeKeyringReadiness();
  const emailUnsubscribeKeyring = unsubscribeKeyring.ready;
  // Whether every unsubscribe key a message sent in the last year
  // depends on still opens its links (docs/policy/email-notifications.md
  // §11.4). Unconditional, unlike the keyring check above: it only has
  // anything to say once a link has been signed, and from then on dropping or
  // editing that version kills links already in inboxes -- which the recipient
  // answers with the spam button. Decrypt-only; it never calls the endpoint.
  // A thrown check is not ready, for the reason the image budget gives.
  // Skipped when the database check already failed -- asking the same database
  // again would only queue another probe behind it -- and bounded by the same
  // deadline when it runs.
  const unsubscribeRetentionStatus = databaseResult.ready
    ? await withDeadline(
        getUnsubscribeKeyRetentionReadiness(),
        DATABASE_CHECK_TIMEOUT_MS,
        "The unsubscribe key retention readiness check timed out."
      ).then(
        (status) => ({ status, error: null as string | null }),
        (error: unknown) => ({
          status: null,
          error:
            error instanceof Error
              ? error.message
              : "The unsubscribe key retention readiness check threw.",
        })
      )
    : {
        status: null,
        error: "Skipped: the database readiness check failed.",
      };
  const emailUnsubscribeKeyRetention = unsubscribeRetentionStatus.status?.ready ?? false;
  // The marketing consent confirmation keyring (docs/policy/email-double-opt-in.md
  // §11 item 10). Same condition as the unsubscribe keyring above: an error
  // once MARKETING_EMAIL_FROM is set, because from then on a missing key means
  // nobody can confirm a consent and no marketing can ever be sent.
  const consentKeyring = consentKeyringReadiness();
  const emailConsentKeyring = consentKeyring.ready;
  // Who the footer says sent the message. Conditional in the same shape as the
  // unsubscribe keyring, and for the same reason: an unset value drops the
  // whole footer rather than one line, but transactional mail is deliberately
  // not held for it, so gating readiness here would refuse today's deployment
  // over a gap that has been there since the footer shipped. It becomes an
  // error once MARKETING_EMAIL_FROM is set, because from then on an incomplete
  // identity means every marketing send is refused while this endpoint answers
  // yes -- the exact state EM-10 describes for the keyring.
  const businessIdentity = businessIdentityReadiness();
  const emailBusinessIdentity = businessIdentity.ready;
  // The subject labels a statute requires, read from the rows a send composes
  // under rather than from the seed (draft section 7.8). A warning until
  // MARKETING_EMAIL_FROM is set, for the reason the keyring gives, and only
  // asked at all once the database answered -- it reads the active policy
  // version, and a failing database has already made this endpoint not-ready.
  //
  // When it cannot answer -- a timeout or an error on this query alone, after
  // the database probe succeeded -- the result depends on whether the answer
  // matters. Before marketing is configured there is nothing to hold back, so
  // not knowing is not a reason to fail. Once it is, not knowing is exactly the
  // state EM-10 describes: answering ready while every Singaporean send would
  // be refused. Reading an unknown as ready was fail-open in the half where it
  // counts.
  const subjectLabels = databaseResult.ready
    ? await withDeadline(
        subjectLabelReadiness(),
        DATABASE_CHECK_TIMEOUT_MS,
        "The email subject label readiness check timed out."
      ).catch(() => null)
    : null;
  const emailSubjectLabels =
    subjectLabels === null ? !marketingSendingConfigured(process.env) : subjectLabels.ready;
  // The footer blocks a statute names, on the rows that send. Separate from
  // `emailBusinessIdentity` because that check reports a jurisdiction's own
  // block as a warning -- on purpose, since whether this deployment has Korean
  // recipients is not a fact an environment holds -- and a warning cannot answer
  // "is this duty done". Same unknown-answer rule as above.
  const footerDisclosures = databaseResult.ready
    ? await withDeadline(
        footerDisclosureReadiness(),
        DATABASE_CHECK_TIMEOUT_MS,
        "The email footer disclosure readiness check timed out."
      ).catch(() => null)
    : null;
  const emailFooterDisclosures =
    footerDisclosures === null
      ? !marketingSendingConfigured(process.env)
      : footerDisclosures.ready;
  // The two-yearly Korean notice is deferred, and section 7.7 asks for the
  // device that stops it being forgotten: the deadline is a fact about rows,
  // not the constant on the duty. Same shape as above, including what an
  // unanswerable query means.
  const biennialNotice = databaseResult.ready
    ? await withDeadline(
        biennialNoticeReadiness(),
        DATABASE_CHECK_TIMEOUT_MS,
        "The biennial consent notice readiness check timed out."
      ).catch(() => null)
    : null;
  // Reported, not gating. A Korean duty falling due is a reason to refuse
  // Korean marketing -- which the rule verdict does, from the same
  // `biennialNoticeReadiness()` answer -- and not a reason to take the whole
  // deployment down. A review was right that failing readiness here would have
  // done exactly that.
  const emailBiennialConsentNotice =
    biennialNotice === null ? !marketingSendingConfigured(process.env) : biennialNotice.healthy;
  const amuxReviewStatus = amuxReviewApprovalReadiness(process.env);
  const amuxReviewApproval = amuxReviewStatus.ready;
  const database = databaseResult.ready;
  const ready =
    database && securityEnvironment && providerBudgets &&
    imageProviderBudget && voiceProviderBudget && voiceModelPrice &&
    searchProviderBudget &&
    emailSendingIdentity && emailSnapshotKeyring && emailUnsubscribeKeyring &&
    emailUnsubscribeKeyRetention && emailConsentKeyring &&
    emailBusinessIdentity && emailSubjectLabels && emailFooterDisclosures &&
    amuxReviewApproval;
  return {
    databaseResult,
    securityStatus,
    budgetStatus,
    imageBudgetStatus,
    voiceBudgetStatus,
    voiceModelPriceStatus,
    searchBudgetStatus,
    sendingIdentity,
    snapshotKeyring,
    unsubscribeKeyring,
    unsubscribeRetentionStatus,
    consentKeyring,
    businessIdentity,
    subjectLabels,
    footerDisclosures,
    biennialNotice,
    amuxReviewStatus,
    checks: {
      database,
      securityEnvironment,
      providerBudgets,
      imageProviderBudget,
      voiceProviderBudget,
      voiceModelPrice,
      searchProviderBudget,
      emailSendingIdentity,
      emailSnapshotKeyring,
      emailUnsubscribeKeyring,
      emailUnsubscribeKeyRetention,
      emailConsentKeyring,
      emailBusinessIdentity,
      emailSubjectLabels,
      emailFooterDisclosures,
      emailBiennialConsentNotice,
      amuxReviewApproval,
    },
    ready,
  };
}
