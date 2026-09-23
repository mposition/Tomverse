"use client";

import { useCallback, useState } from "react";
import { Loader2, Lock, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  MARKETING_CHECKED,
  MarketingActionRail,
  instantFromLocalInput,
  localDateTimeValue,
  type MarketingAction,
} from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { discardResponseBody } from "@/lib/discardResponseBody";
import {
  MARKETING_CHANNEL_CAPS,
  MARKETING_LOCALES,
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_PROVIDERS,
  MARKETING_RESUME_REASON_CODES,
} from "@/lib/marketingAutomationSchema";
import {
  MARKETING_CONSOLE_SWITCH_CONTROLS,
  type MarketingConsoleSection,
} from "@/lib/marketingConsoleSections";

type Availability = { available: true } | { available: false; stage: "S4" | "S5" };

type SwitchState =
  | "on"
  | "off"
  | "scope-valid"
  | "scope-invalid"
  | "no-scope"
  | "unreadable";

type Row = Record<string, unknown>;

export type MarketingConsoleView = {
  section: MarketingConsoleSection;
  availability: Availability;
  ordering: "newest" | "by-account";
  pageSize: number;
  rows: Row[];
  switches: Record<string, SwitchState>;
  canWrite: boolean;
  configGeneration: number | null;
};

const stamp = (value: unknown) => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const int = (value: unknown) => (typeof value === "number" ? value : 0);

/** An empty box means "no override", which is a value the writer accepts. */
const capOverride = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** A week out, which is the ordinary answer and still an editable one. */
const defaultApprovalExpiry = () =>
  localDateTimeValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

const POST = (id: unknown, action: string) =>
  `/api/admin/marketing/posts/${encodeURIComponent(String(id))}/${action}`;
const ACCOUNT = (id: unknown, action: string) =>
  `/api/admin/marketing/accounts/${encodeURIComponent(String(id))}/${action}`;

/**
 * The whole Marketing console.
 *
 * The first payload arrives from the page's server component, so the rows are
 * in the HTML rather than appearing after hydration. Refreshing calls the same
 * loader through `GET /api/admin/marketing`, and so does every control here
 * once its write lands -- a screen that has just changed a row and still shows
 * the old one is a screen that will be acted on twice.
 *
 * One component for six sections because the sections differ in their columns
 * and in nothing else: the same switch strip, the same "newest N, not a total"
 * sentence, and the same treatment of a section a later stage owns. Six
 * components would be five copies of that sentence to keep in step.
 *
 * Every control sends a compare-and-set. The values it sends back -- an
 * envelope digest, a history version, a connection generation, a
 * configuration generation -- are read from the payload this screen rendered,
 * so a change is a decision about the row the operator was looking at rather
 * than whichever row is there when the request lands.
 */
export function AdminMarketingPanel({ initial }: { initial: MarketingConsoleView }) {
  const m = useAdminMessages(adminMarketingMessages);
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/marketing?section=${encodeURIComponent(initial.section)}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        // Every path consumes the body, not only the one that parses it:
        // `/api/*` answers `private, no-store`, under which an unconsumed body
        // did not reach `requestfinished` (lib/discardResponseBody.ts).
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      setView((await response.json()) as MarketingConsoleView);
    } catch {
      setError(m.loadFailed);
    } finally {
      setBusy(false);
    }
  }, [initial.section, m.loadFailed]);

  const heading = {
    queue: { title: m.queueTitle, description: m.queueDescription },
    published: { title: m.publishedTitle, description: m.publishedDescription },
    accounts: { title: m.accountsTitle, description: m.accountsDescription },
    reports: { title: m.reportsTitle, description: m.reportsDescription },
    experiments: { title: m.experimentsTitle, description: m.experimentsDescription },
    comments: { title: m.commentsTitle, description: m.commentsDescription },
  }[view.section];

  const unavailable = view.availability.available ? null : view.availability;

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            Marketing
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">{heading.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {heading.description}
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            {view.canWrite ? m.writesNote : m.readOnlyNote}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {m.refresh}
        </button>
      </div>

      <MarketingSwitchStrip
        switches={view.switches}
        canWrite={view.canWrite}
        configGeneration={view.configGeneration}
        section={view.section}
        onDone={() => void refresh()}
        m={m}
      />

      {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

      {unavailable ? (
        <p className="mt-4 flex items-start gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm leading-6 text-zinc-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          {unavailable.stage === "S4" ? m.unavailableS4 : m.unavailableS5}
        </p>
      ) : (
        <>
          {view.section === "accounts" && view.canWrite ? (
            <MarketingAccountCreate
              section={view.section}
              onDone={() => void refresh()}
              m={m}
            />
          ) : null}
          <p className="mt-4 text-xs text-zinc-500">
            {m.showing.replace("{count}", String(view.pageSize))}
          </p>
          {view.rows.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-400">{m.empty}</p>
          ) : (
            <div className="mt-4 grid gap-2">
              {view.rows.map((row) => (
                <article
                  key={String(row.id)}
                  data-testid="marketing-row"
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
                >
                  <MarketingRow section={view.section} row={row} m={m} />
                  <MarketingActionRail
                    actions={view.canWrite ? rowActions(view.section, row, m) : []}
                    section={view.section}
                    onDone={() => void refresh()}
                    m={m}
                  />
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What is switched on, on every section, and the three an operator may change.
 *
 * docs/policy/marketing-automation.md §6.1 makes each capability its own
 * switch, and the page's job is to answer "why did nothing publish".
 * "Drafts: off" is that answer, and it belongs beside the empty queue rather
 * than in another workspace.
 * `unreadable` is its own word: a read that failed is not evidence of `off`.
 *
 * A toggle is offered only for a switch whose state was actually read and only
 * when the configuration generation was read with it. Both come from the same
 * snapshot, so a screen cannot save a change against a state nobody saw;
 * without the generation there is nothing to compare and set against, and a
 * control whose only outcome is 409 is not a control.
 */
function MarketingSwitchStrip({
  switches,
  canWrite,
  configGeneration,
  section,
  onDone,
  m,
}: {
  switches: Record<string, SwitchState>;
  canWrite: boolean;
  configGeneration: number | null;
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const labels: [string, string][] = [
    ["drafts", m.switchDrafts],
    ["publish", m.switchPublish],
    ["autoPublish", m.switchAutoPublish],
    ["experiments", m.switchExperiments],
    ["webhookShadow", m.switchWebhookShadow],
    ["webhookApplyScope", m.switchWebhookApply],
  ];
  const word = (value: SwitchState) =>
    ({
      on: m.switchOn,
      off: m.switchOff,
      "scope-valid": m.switchScopeValid,
      "scope-invalid": m.switchScopeInvalid,
      "no-scope": m.switchNoScope,
      unreadable: m.switchUnreadable,
    })[value];
  // Only the five booleans go green. A stored apply scope is a document, not
  // an active capability -- the pipeline behind it is incomplete -- so it is
  // never drawn as though something were switched on.
  const tone = (value: SwitchState) =>
    value === "on"
      ? "text-emerald-300"
      : value === "unreadable" || value === "scope-invalid"
        ? "text-amber-300"
        : "text-zinc-400";

  const switchLabel = (name: string) =>
    ({
      drafts: m.switchDrafts,
      publish: m.switchPublish,
      autonomous: m.switchAutoPublish,
    })[name] ?? name;

  const toggles: MarketingAction[] =
    !canWrite || configGeneration === null
      ? []
      : MARKETING_CONSOLE_SWITCH_CONTROLS.flatMap((control) => {
          const state = switches[control.state];
          if (state !== "on" && state !== "off") return [];
          const turningOn = state === "off";
          return [
            {
              id: `switch-${control.name}`,
              label: (turningOn ? m.switchTurnOn : m.switchTurnOff).replace(
                "{switch}",
                switchLabel(control.name)
              ),
              path: "/api/admin/marketing/settings",
              // The route exports PATCH. Sending POST answered 405, which
              // reached the operator as "that did not go through" -- three
              // switches that looked broken rather than misaddressed.
              method: "PATCH",
              // Two switches the writer is certain to refuse, each drawn
              // disabled with its reason rather than hidden: someone looking
              // for a switch should find out why it is not theirs to move,
              // and a control whose only outcome is a 409 teaches them that
              // this screen's buttons are guesses.
              //
              // Publishing cannot go on before the publisher exists (S2c);
              // the writer answers `publisher_capability_unavailable`.
              // Autonomous cannot go on while drafts or publishing are off;
              // the writer answers `autonomous_needs_drafts_and_publish`.
              unavailable: !turningOn
                ? undefined
                : control.name === "publish"
                  ? m.switchPublishUnavailable
                  : control.name === "autonomous" &&
                      (switches.drafts !== "on" || switches.publish !== "on")
                    ? m.switchAutonomousNeedsBoth
                    : undefined,
              confirm: turningOn ? m.switchConfirmOn : undefined,
              body: () => ({
                switch: control.name,
                enabled: turningOn,
                expectedConfigGeneration: configGeneration,
              }),
            },
          ];
        });

  return (
    <div
      data-testid="marketing-switches"
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-3"
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
        {m.switchesTitle}
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {labels.map(([key, label]) => (
          <div key={key} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-xs text-zinc-400">{label}</dt>
            <dd
              data-state={switches[key] ?? "unreadable"}
              className={`text-xs font-bold ${tone(switches[key] ?? "unreadable")}`}
            >
              {word(switches[key] ?? "unreadable")}
            </dd>
          </div>
        ))}
      </dl>
      {/*
        Only when the version is genuinely unreadable. A reader who may not
        write has no missing version -- they have no business changing these
        -- and telling them something could not be read would send them
        looking for a fault that is not there.
      */}
      {canWrite && configGeneration === null ? (
        <p className="mt-2 text-[11px] text-amber-300">{m.switchNoGeneration}</p>
      ) : null}
      <MarketingActionRail
        actions={toggles}
        section={section}
        onDone={onDone}
        m={m}
      />
    </div>
  );
}

/**
 * Registering a brand account.
 *
 * It lands in `connect_pending`: registering an account is not connecting one,
 * and the row says so until a person confirms the connection separately.
 */
function MarketingAccountCreate({
  section,
  onDone,
  m,
}: {
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const action: MarketingAction = {
    id: "account-create",
    label: m.actCreateAccount,
    path: "/api/admin/marketing/accounts",
    fields: [
      {
        name: "channel",
        label: m.fieldChannel,
        kind: "select",
        options: Object.keys(MARKETING_CHANNEL_CAPS),
      },
      {
        name: "provider",
        label: m.fieldProvider,
        kind: "select",
        options: MARKETING_PROVIDERS,
      },
      {
        name: "externalAccountRef",
        label: m.fieldExternalRef,
        kind: "text",
        hint: m.hintOptional,
      },
      {
        name: "defaultLocale",
        label: m.fieldDefaultLocale,
        kind: "select",
        options: MARKETING_LOCALES,
      },
      {
        name: "allowedLocales",
        label: m.fieldAllowedLocales,
        kind: "text",
        hint: m.hintCommaSeparated,
      },
      {
        name: "scopesDigest",
        label: m.fieldScopesDigest,
        kind: "text",
        hint: m.hintDigest,
      },
      {
        name: "policyVersion",
        label: m.fieldPolicyVersion,
        kind: "number",
        initial: "1",
      },
    ],
    body: (values) => ({
      channel: values.channel,
      provider: values.provider,
      externalAccountRef:
        values.externalAccountRef.trim() === ""
          ? null
          : values.externalAccountRef.trim(),
      defaultLocale: values.defaultLocale,
      allowedLocales: values.allowedLocales
        .split(",")
        .map((locale) => locale.trim())
        .filter((locale) => locale !== ""),
      scopesDigest: values.scopesDigest.trim(),
      policyVersion: Number(values.policyVersion),
    }),
  };

  return (
    <div
      data-testid="marketing-account-create"
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3"
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
        {m.createAccountTitle}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{m.createAccountNote}</p>
      <MarketingActionRail
        actions={[action]}
        section={section}
        onDone={onDone}
        m={m}
      />
    </div>
  );
}

/**
 * Which controls a row can take, decided from the row's own state.
 *
 * The server decides every one of these again, and it is the server's answer
 * that counts. This only declines to draw a control whose sole outcome would
 * be a 409 -- offering "approve" on something already approved teaches an
 * operator that this screen's buttons are guesses.
 */
function rowActions(
  section: MarketingConsoleSection,
  row: Row,
  m: Record<string, string>
): MarketingAction[] {
  if (section === "queue") return queueActions(row, m);
  if (section === "published") return publishedActions(row, m);
  if (section === "accounts") return accountActions(row, m);
  return [];
}

/** The two values every post writer compares against. */
const postCas = (row: Row) => ({
  expectedEnvelopeDigest: str(row.envelopeDigest),
  expectedHistoryVersion: int(row.historyVersion),
});

const legalHoldAction = (row: Row, m: Record<string, string>): MarketingAction => {
  const held = row.legalHold === true;
  return {
    id: held ? "legal-hold-release" : "legal-hold-set",
    label: held ? m.actReleaseHold : m.actSetHold,
    path: POST(row.id, "legal-hold"),
    confirm: held ? m.confirmReleaseHold : undefined,
    body: () => ({ hold: !held, expectedHistoryVersion: int(row.historyVersion) }),
  };
};

function queueActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  if (row.status === "pending_approval") {
    actions.push({
      id: "approve",
      label: m.actApprove,
      path: POST(row.id, "approve"),
      fields: [
        {
          name: "approvalExpiresAt",
          label: m.fieldApprovalExpires,
          kind: "datetime",
          initial: defaultApprovalExpiry(),
          hint: m.hintLocalTime,
        },
      ],
      body: (values) => ({
        ...postCas(row),
        approvalExpiresAt: instantFromLocalInput(values.approvalExpiresAt),
      }),
    });
    actions.push({
      id: "edit",
      label: m.actEdit,
      path: POST(row.id, "edit"),
      fields: [
        {
          name: "renderedText",
          label: m.fieldRenderedText,
          kind: "textarea",
          initial: str(row.renderedText),
          hint: m.hintGuardReruns,
        },
      ],
      // Only the words go up. Everything else the envelope holds -- the
      // claims, the assets, the channel and locale it was written for -- stays
      // where it is, and the route merges against the stored row: an edit is a
      // correction to the copy, not a new draft wearing the old one's history.
      // The earlier shape sent a whole envelope the console never had, so
      // every edit was a 400 against the strict schema.
      body: (values) => ({
        ...postCas(row),
        renderedText: values.renderedText,
      }),
    });
    actions.push({
      id: "reject",
      label: m.actReject,
      path: POST(row.id, "reject"),
      confirm: m.confirmReject,
      danger: true,
      body: () => postCas(row),
    });
  }
  actions.push(legalHoldAction(row, m));
  return actions;
}

const TEMPLATE_SOURCE = new Set(["approved", "scheduled", "published", "verified"]);

/**
 * The account states in which the publisher is not taking posts.
 *
 * The same set the store's `marketingChannelWasStopped()` uses, and it has to
 * be: these are exactly the states a resume or reconnect can refuse from for a
 * backlog, so they are exactly the states where the drain that clears it must
 * be reachable.
 */
/**
 * Whether the publisher has a cap to lower on this channel.
 *
 * Read from the same table the store reads, through a guard rather than an
 * index expression: the row’s channel arrives as a `string` from a payload,
 * and indexing a closed record with it is the shape that needs a cast.
 */
const channelHasCaps = (channel: string): boolean =>
  Object.hasOwn(MARKETING_CHANNEL_CAPS, channel) &&
  MARKETING_CHANNEL_CAPS[channel as keyof typeof MARKETING_CHANNEL_CAPS] !== null;

const MARKETING_STOPPED_ACCOUNT_STATUSES = new Set([
  "paused",
  "disconnected",
  "connect_pending",
]);

function publishedActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  const status = str(row.status);

  if (status === "approved") {
    actions.push({
      id: "schedule",
      label: m.actSchedule,
      path: POST(row.id, "schedule"),
      fields: [
        {
          name: "scheduledAt",
          label: m.fieldScheduledAt,
          kind: "datetime",
          hint: m.hintLocalTime,
        },
      ],
      body: (values) => ({
        ...postCas(row),
        scheduledAt: instantFromLocalInput(values.scheduledAt),
      }),
    });
  }

  if (status === "failed") {
    actions.push({
      id: "requeue",
      label: m.actRequeue,
      path: POST(row.id, "requeue"),
      confirm: m.confirmRequeue,
      body: () => postCas(row),
    });
  }

  if (TEMPLATE_SOURCE.has(status) && row.reusableAsTemplate !== true) {
    actions.push({
      id: "mark-reusable",
      label: m.actMarkReusable,
      path: POST(row.id, "mark-reusable"),
      confirm: m.confirmMarkReusable,
      body: () => postCas(row),
    });
  }

  if (status === "outcome_unknown") {
    actions.push({
      id: "resolve-published",
      label: m.actResolvePublished,
      path: POST(row.id, "resolve-outcome"),
      fields: [
        { name: "externalPostId", label: m.fieldExternalPostId, kind: "text" },
        { name: "externalUrl", label: m.fieldExternalUrl, kind: "url" },
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
      ],
      body: (values) => ({
        resolution: "published",
        expectedHistoryVersion: int(row.historyVersion),
        externalPostId: values.externalPostId.trim(),
        externalUrl: values.externalUrl.trim(),
        evidenceRef: values.evidenceRef.trim(),
      }),
    });
    actions.push({
      id: "resolve-failed",
      label: m.actResolveFailed,
      path: POST(row.id, "resolve-outcome"),
      danger: true,
      fields: [
        { name: "errorCode", label: m.fieldErrorCode, kind: "text" },
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
      ],
      body: (values) => ({
        resolution: "failed",
        expectedHistoryVersion: int(row.historyVersion),
        errorCode: values.errorCode.trim(),
        evidenceRef: values.evidenceRef.trim(),
      }),
    });
  }

  if (status === "published" || status === "verified") {
    actions.push({
      id: "unpublish",
      label: m.actUnpublish,
      path: POST(row.id, "unpublish"),
      danger: true,
      // Both statements are the operator's, so both are boxes they tick.
      // Sending a silent `true` would be this screen saying, in their name,
      // that they had checked something they were never asked about.
      fields: [
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
        {
          name: "cancellationSupported",
          label: m.fieldCancellationSupported,
          kind: "checkbox",
          hint: m.hintCancellationSupported,
        },
        {
          name: "removalConfirmed",
          label: m.fieldRemovalConfirmed,
          kind: "checkbox",
          hint: m.hintRemovalConfirmed,
        },
      ],
      body: (values) => ({
        expectedStatus: status,
        expectedHistoryVersion: int(row.historyVersion),
        expectedExternalPostId: str(row.externalPostId),
        evidenceRef: values.evidenceRef.trim(),
        cancellationSupported: values.cancellationSupported === MARKETING_CHECKED,
        removalConfirmed: values.removalConfirmed === MARKETING_CHECKED,
      }),
    });
  }

  actions.push(legalHoldAction(row, m));
  return actions;
}

function accountActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  const status = str(row.status);
  const generation = int(row.connectionGeneration);
  const identityCas = {
    expectedScopesDigest: str(row.scopesDigest),
    expectedPolicyVersion: int(row.policyVersion),
    expectedGraduationEpoch: int(row.graduationEpoch),
  };

  if (status === "connect_pending") {
    actions.push({
      id: "confirm-connection",
      label: m.actConfirmConnection,
      path: ACCOUNT(row.id, "confirm-connection"),
      body: () => ({ expectedConnectionGeneration: generation }),
    });
  }

  if (status === "disconnected") {
    actions.push({
      id: "reconnect",
      label: m.actReconnect,
      path: ACCOUNT(row.id, "reconnect"),
      body: () => ({ expectedConnectionGeneration: generation }),
    });
  }

  if (status === "approval_mode" || status === "autonomous_mode") {
    actions.push({
      id: "pause",
      label: m.actPause,
      path: ACCOUNT(row.id, "pause"),
      danger: true,
      fields: [
        {
          name: "reasonCode",
          label: m.fieldReasonCode,
          kind: "select",
          options: MARKETING_PAUSE_REASON_CODES,
        },
      ],
      body: (values) => ({ expectedStatus: status, reasonCode: values.reasonCode }),
    });
    actions.push({
      id: "scopes",
      label: m.actChangeScopes,
      path: ACCOUNT(row.id, "scopes"),
      fields: [
        {
          name: "scopesDigest",
          label: m.fieldScopesDigest,
          kind: "text",
          hint: m.hintIdentityChange,
        },
      ],
      body: (values) => ({ ...identityCas, scopesDigest: values.scopesDigest.trim() }),
    });
    actions.push({
      id: "policy-version",
      label: m.actChangePolicyVersion,
      path: ACCOUNT(row.id, "policy-version"),
      fields: [
        {
          name: "policyVersion",
          label: m.fieldPolicyVersion,
          kind: "number",
          initial: String(int(row.policyVersion) + 1),
          hint: m.hintIdentityChange,
        },
      ],
      body: (values) => ({ ...identityCas, policyVersion: Number(values.policyVersion) }),
    });
  }

  if (status === "paused") {
    actions.push({
      id: "resume-approval",
      label: m.actResumeApproval,
      path: ACCOUNT(row.id, "resume"),
      body: () => ({ mode: "approval" }),
    });
    if (row.pausedFromMode === "autonomous_mode") {
      actions.push({
        id: "resume-autonomous",
        label: m.actResumeAutonomous,
        path: ACCOUNT(row.id, "resume"),
        fields: [
          {
            name: "reasonCode",
            label: m.fieldReasonCode,
            kind: "select",
            options: MARKETING_RESUME_REASON_CODES,
          },
        ],
        body: (values) => ({ mode: "autonomous", reasonCode: values.reasonCode }),
      });
    }
  }

  // Wherever a resume or a reconnect can refuse for a backlog, the drain that
  // clears it has to be reachable. Offered without first knowing a backlog
  // exists, because the console does not count due posts -- a control that
  // appeared only once one was visible would be missing exactly when the
  // refusals start. A disconnected account with a backlog and no drain had no
  // way back at all: there is no edge from `disconnected` into `paused`.
  if (MARKETING_STOPPED_ACCOUNT_STATUSES.has(status)) {
    actions.push({
      id: "drain",
      label: m.actDrain,
      path: ACCOUNT(row.id, "drain"),
      body: () => ({}),
      describe: (result) => {
        const value = result as
          | { expiredPostIds?: unknown; remaining?: unknown }
          | null;
        const expired = Array.isArray(value?.expiredPostIds)
          ? value.expiredPostIds.length
          : 0;
        return (value?.remaining === true ? m.drainMore : m.drainDone).replace(
          "{count}",
          String(expired)
        );
      },
    });
  }

  if (status !== "disconnected") {
    actions.push({
      id: "lower-caps",
      label: m.actLowerCaps,
      path: ACCOUNT(row.id, "caps"),
      // A manual channel has no publisher cap to override, so the writer
      // answers `manual_channel_has_no_caps` every time. The channel is in
      // the payload, so the screen can say so before the click instead of
      // after it.
      unavailable: channelHasCaps(str(row.channel))
        ? undefined
        : m.capsManualChannel,
      fields: [
        {
          name: "dailyCapOverride",
          label: m.fieldDailyCap,
          kind: "number",
          initial:
            typeof row.dailyCapOverride === "number" ? String(row.dailyCapOverride) : "",
          hint: m.hintCapEmpty,
        },
        {
          name: "weeklyCapOverride",
          label: m.fieldWeeklyCap,
          kind: "number",
          initial:
            typeof row.weeklyCapOverride === "number" ? String(row.weeklyCapOverride) : "",
          hint: m.hintCapEmpty,
        },
      ],
      body: (values) => ({
        dailyCapOverride: capOverride(values.dailyCapOverride),
        weeklyCapOverride: capOverride(values.weeklyCapOverride),
      }),
    });
    actions.push({
      id: "disconnect",
      label: m.actDisconnect,
      path: ACCOUNT(row.id, "disconnect"),
      confirm: m.confirmDisconnect,
      danger: true,
      body: () => ({
        expectedStatus: status,
        expectedConnectionGeneration: generation,
      }),
    });
  }

  return actions;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm text-zinc-200">{value}</p>
    </div>
  );
}

function MarketingRow({
  section,
  row,
  m,
}: {
  section: MarketingConsoleSection;
  row: Row;
  m: Record<string, string>;
}) {
  if (section === "queue") {
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={m.colAccount} value={`${row.accountSlug} / ${row.channel}`} />
          <Field label={m.colLocale} value={String(row.locale)} />
          <Field label={m.colStatus} value={`${row.status} / ${row.mode}`} />
          <Field
            label={m.colVerdict}
            value={
              [row.guardDecision as string, ...(row.guardCodes as string[])]
                .filter(Boolean)
                .join(", ") || m.none
            }
          />
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-300">
          {text(row.excerpt) ?? m.none}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {m.colCreated} {stamp(row.createdAt) ?? m.none} UTC / {m.colExpires}{" "}
          {stamp(row.approvalExpiresAt) ?? m.none}
          {row.legalHold === true ? ` / ${m.legalHeld}` : ""}
        </p>
      </>
    );
  }

  if (section === "published") {
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={m.colAccount} value={`${row.accountSlug} / ${row.channel}`} />
          <Field label={m.colStatus} value={`${row.status} / ${row.mode}`} />
          <Field label={m.colScheduled} value={stamp(row.scheduledAt) ?? m.none} />
          <Field label={m.colPublished} value={stamp(row.publishedAt) ?? m.none} />
          <Field
            label={m.colVerified}
            value={
              stamp(row.verifiedPublicAt)
                ? `${stamp(row.verifiedPublicAt)} (${row.verificationMethod ?? m.none})`
                : m.none
            }
          />
          <Field label={m.colUrl} value={text(row.externalUrl) ?? m.none} />
          <Field label={m.colAttempts} value={String(row.publishAttempt ?? 0)} />
          <Field
            label={m.colProblem}
            value={
              text(row.errorCode) ??
              (stamp(row.outcomeUnknownAt)
                ? `${m.outcomeUnknown} ${stamp(row.outcomeUnknownAt)}`
                : m.none)
            }
          />
        </div>
        {row.legalHold === true ? (
          <p className="mt-2 text-xs font-bold text-amber-300">{m.legalHeld}</p>
        ) : null}
      </>
    );
  }

  if (section === "accounts") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label={m.colAccount}
          value={`${row.accountSlug} / ${row.channel} / ${row.provider}`}
        />
        <Field label={m.colStatus} value={String(row.status)} />
        <Field
          label={m.colLocale}
          value={`${row.defaultLocale} (${(row.allowedLocales as string[]).join(", ")})`}
        />
        <Field
          label={m.colCaps}
          value={`${row.dailyCapOverride ?? m.noCap} / ${row.weeklyCapOverride ?? m.noCap}`}
        />
        <Field
          label={m.colPaused}
          value={
            stamp(row.pausedAt)
              ? `${stamp(row.pausedAt)} (${row.pauseReasonCode ?? m.none}, from ${row.pausedFromMode ?? m.none})`
              : m.notPaused
          }
        />
        <Field
          label={m.colIdentity}
          value={`v${row.policyVersion} / e${row.graduationEpoch} / c${row.connectionGeneration}`}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={m.colKind} value={String(row.kind)} />
      <Field
        label={m.colPeriod}
        value={`${stamp(row.periodStart) ?? m.none} - ${stamp(row.periodEnd) ?? m.none}`}
      />
      <Field label={m.colCreated} value={stamp(row.createdAt) ?? m.none} />
      <Field label={m.colSource} value={String(row.sourceVersion)} />
    </div>
  );
}
