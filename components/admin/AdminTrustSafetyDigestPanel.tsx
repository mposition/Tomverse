import type { ReactNode } from "react";

import type { TrustSafetyDigestView } from "@/lib/trustSafetyDigestRead";

/**
 * The trust-safety section of the common Agent digest area
 * (docs/policy/trust-safety-compliance-agent.md §5.6 E2, §9, §14).
 *
 * **Read-only, and a server component.** §5.6 gives E2 no writes and no
 * outgoing requests, and the section's own files may not name `fetch` at all,
 * so the switch is a plain form posting to the activation route (E3) rather
 * than a client-side request. That is also why this component takes its copy
 * as a prop: the locale helpers are behind imports these files may not make,
 * so the page resolves the messages and hands them in.
 *
 * **It does not show when the observer last ran.** §5.3 keeps the run table
 * unread -- that is what makes the row a record rather than state -- and §8
 * gives "has it stopped?" to the external monitor. The fixed list at the
 * bottom says so, next to the other things §9 requires it to disclaim.
 */

type Messages = Record<string, string>;

/**
 * The two placeholders this copy uses, filled by name.
 *
 * §5.6 does not allow these files a computed property access or the name
 * `Object`, so there is no generic interpolation here -- the placeholders are
 * literals and there are two of them.
 */
const fillDays = (template: string, days: number) =>
  template.replaceAll("{days}", String(days));
const fillCode = (template: string, code: string) => template.replaceAll("{code}", code);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-zinc-400">{label}</dt>
    <dd className="text-zinc-100">{children}</dd>
  </>
);

export function AdminTrustSafetyDigestPanel({
  view,
  messages: m,
  canWrite,
  refusedCode,
  reauthenticationHref,
}: {
  /** Null when the read failed: the section degrades and the page stays usable. */
  readonly view: TrustSafetyDigestView | null;
  readonly messages: Messages;
  readonly canWrite: boolean;
  /** The refusal code the activation route redirected back with, if any. */
  readonly refusedCode: string | null;
  /**
   * Where a stale step-up sends the operator, back to this tab afterwards.
   * The page builds it: these files may not import the helper that makes it
   * (§5.6 closes their imports), and §6 calls a refusal with no link a defect.
   */
  readonly reauthenticationHref: string;
}) {
  const values = view !== null && view.permitted ? view : null;
  const counts = values?.counts ?? null;
  const fault = values?.activation.fault ?? null;
  const mode = values?.activation.mode ?? null;
  const nextMode = mode === "on" ? "off" : "on";
  // A table, read through a `Map`: §6's six faults by name, because a
  // computed lookup into the messages is one of the forms §5.6 refuses here.
  const faultText = new Map([
    ["config_row_missing", m.fault_config_row_missing],
    ["signature_unverified", m.fault_signature_unverified],
    ["binding_mismatch", m.fault_binding_mismatch],
    ["unhashed_entry_present", m.fault_unhashed_entry_present],
    ["chain_broken", m.fault_chain_broken],
    ["ping_url_missing", m.fault_ping_url_missing],
  ]);

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="trust-safety-digest">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-100">{m.title}</h2>
        <p className="text-sm text-zinc-400">{m.note}</p>
      </div>

      {view !== null && !view.permitted ? (
        <p className="text-sm text-zinc-400" data-testid="trust-safety-not-permitted">
          {m.notPermitted}
        </p>
      ) : values === null ? (
        <p className="text-sm text-zinc-400" data-testid="trust-safety-unavailable">
          {m.unavailable}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-200">{m.activationTitle}</h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <Row label={m.mode}>
                <span data-testid="trust-safety-mode">
                  {mode === null ? m.modeUnknown : mode === "on" ? m.mode_on : m.mode_off}
                </span>
              </Row>
              <Row label={m.version}>{values.version ?? "-"}</Row>
              <Row label={m.observedAt}>{values.observedAt}</Row>
            </dl>
            {fault !== null ? (
              <div className="flex flex-col gap-1 rounded border border-amber-700/50 bg-amber-950/20 p-3 text-sm">
                <span className="font-semibold text-amber-200">{m.faultTitle}</span>
                <span className="text-amber-100" data-testid="trust-safety-fault">
                  {faultText.get(fault) ?? fault}
                </span>
                {counts === null ? (
                  <span className="text-amber-200/80">{m.faultStopsCounting}</span>
                ) : null}
              </div>
            ) : null}
          </div>

          {counts === null ? null : (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">{m.countsTitle}</h3>
              <p className="text-xs text-zinc-500">{m.countsNote}</p>
              {/* §14's count comparison line. */}
              <dl
                className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm"
                data-testid="trust-safety-counts"
              >
                <Row label={m.observed}>{counts.observed.total}</Row>
                <Row label={m.overdue}>
                  {counts.overdue.total}
                  <span className="text-zinc-500">
                    {" "}
                    ({m.legalHold} {counts.overdue.legalHold})
                  </span>
                </Row>
                <Row label={m.imminent}>
                  {counts.imminentWithinDays === 0 ? (
                    <span className="text-zinc-400">{m.imminentWindowUnset}</span>
                  ) : (
                    <>
                      {counts.imminent.total}
                      <span className="text-zinc-500">
                        {" "}
                        ({fillDays(m.imminentWindow, counts.imminentWithinDays)})
                      </span>
                    </>
                  )}
                </Row>
              </dl>
              <p className="text-xs text-zinc-500">{m.legalHoldNote}</p>

              {/* §14's late-closure line: the count, and the worst overrun. */}
              <h3 className="text-sm font-semibold text-zinc-200">{m.lateTitle}</h3>
              <dl
                className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm"
                data-testid="trust-safety-late"
              >
                <Row label={m.closedLate}>
                  {counts.closedLate.total}
                  <span className="text-zinc-500">
                    {" "}
                    ({m.legalHold} {counts.closedLate.legalHold})
                  </span>
                </Row>
                <Row label={m.worstLateDays}>
                  {counts.worstLateClosureDays === null
                    ? m.worstLateNone
                    : counts.worstLateClosureDays === 0
                      ? m.worstLateSameDay
                      : fillDays(m.worstLateDaysValue, counts.worstLateClosureDays)}
                </Row>
              </dl>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-200">{m.switchTitle}</h3>
            {refusedCode === null ? null : (
              <p className="text-sm text-amber-200" data-testid="trust-safety-switch-refused">
                {refusedCode === "reauthentication_required" ? (
                  <>
                    {m.switchReauth}{" "}
                    {/* §6: the refusal is drawn with the way back, not just a
                        sentence. Independent review found the sentence alone. */}
                    <a
                      className="underline"
                      href={reauthenticationHref}
                      data-testid="trust-safety-reauthenticate"
                    >
                      {m.switchReauthLink}
                    </a>
                  </>
                ) : (
                  fillCode(m.switchRefused, refusedCode)
                )}
              </p>
            )}
            {canWrite ? (
              // A form, not a click handler: §5.6 does not allow these files to
              // name `fetch`, and the route answers a redirect back to here.
              //
              // **Both directions when the mode is not believed.** Offering
              // only the opposite of `mode` meant a chain fault -- where the
              // mode is null -- always offered `on`, which the store refuses
              // as `not_a_transition` if the stored row is already on: the
              // owner could not turn the observation off from the screen while
              // a fault stood. Independent review found it. With no believed
              // mode both are offered and the store judges each against the
              // stored row.
              <div className="flex gap-2">
                {(mode === null ? ["off", "on"] : [nextMode]).map((requested) => (
                  <form
                    key={requested}
                    method="post"
                    action="/api/admin/agents/trust-safety/activation"
                  >
                    <input type="hidden" name="mode" value={requested} />
                    <button
                      type="submit"
                      className="w-fit rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700"
                      data-testid={`trust-safety-switch-${requested}`}
                    >
                      {requested === "on" ? m.turnOn : m.turnOff}
                    </button>
                  </form>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">{m.switchOwnerOnly}</p>
            )}
          </div>
        </>
      )}

      <div className="flex flex-col gap-1 border-t border-zinc-800 pt-3">
        <h3 className="text-sm font-semibold text-zinc-200">{m.excludedTitle}</h3>
        <ul className="list-disc pl-5 text-sm text-zinc-400" data-testid="trust-safety-excluded">
          <li>{m.excluded_policy}</li>
          <li>{m.excluded_gates}</li>
          <li>{m.excluded_security}</li>
          <li>{m.excluded_moderation}</li>
          <li>{m.excluded_lastRun}</li>
        </ul>
      </div>
    </section>
  );
}
