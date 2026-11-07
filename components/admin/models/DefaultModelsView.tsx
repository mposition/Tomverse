"use client";

import Link from "next/link";
import { Check, RefreshCw, X } from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { modelCompanyName } from "@/components/admin/models/ModelRegistryList";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import { adminPlatformSettingsMessages } from "@/lib/adminMessages/platformSettings";
import type { FallbackTransitionCheckId } from "@/lib/defaultModelConsole";

export type DefaultModelOption = {
  id: string;
  name: string;
  provider: string;
  /** What one answer costs, from the model's own usage class and weight. */
  credits?: number | null;
};

const selectClass =
  "min-h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-bold text-white outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60";

/**
 * The Default models tab: the account default, the three models guests see,
 * and which of the three goes first.
 *
 * Presentation only. `PlatformSettingsPanel` keeps every request, validation
 * and audit path for these settings and hands this view the state and the
 * handlers, so the saves (`PATCH /api/admin/app-settings`, with its step-up
 * and its own validation) are exactly the ones the screen always made.
 */
export function DefaultModelsView({
  syncedLabel,
  reload,
  fallback,
  transition,
  lineup,
  lead,
  notices,
}: {
  syncedLabel: string | null;
  reload: { busy: boolean; onReload: () => void };
  fallback: { name: string; id: string; provider: string; credits: number | null };
  transition: {
    loaded: boolean;
    candidates: readonly DefaultModelOption[];
    candidateId: string;
    onCandidate: (id: string) => void;
    checks: ReadonlyArray<{ id: FallbackTransitionCheckId; pass: boolean }>;
    hasCandidate: boolean;
    onCopy: () => void;
  };
  lineup: {
    draft: readonly string[];
    /** The one provider each slot may take, or null when the saved lineup does not decide it. */
    slotProviders: ReadonlyArray<string | null>;
    options: readonly DefaultModelOption[];
    labelFor: (id: string) => string;
    changed: boolean;
    complete: boolean;
    saving: boolean;
    error: string | null;
    leadMovesTo: string | null;
    onSlot: (index: number, id: string) => void;
    onSave: () => void;
  };
  lead: {
    value: string;
    options: readonly DefaultModelOption[];
    inList: boolean;
    saving: boolean;
    error: string | null;
    onChange: (id: string) => void;
    onSave: () => void;
  };
  notices: {
    visibleOrder: string;
    missingProviders: string | null;
    storedNotApplied: { stored: string; effective: string } | null;
    substitutions: ReadonlyArray<{ id: string; missing: string; substitute: string }>;
    outsideTrio: ReadonlyArray<{ id: string; name: string }>;
  };
}) {
  const m = useAdminMessages(adminPlatformSettingsMessages);
  const d = useAdminMessages(adminModelsBoardMessages).defaults;
  const warn = "text-sm font-bold text-amber-300";

  return (
    <div id="default-models" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">{syncedLabel ? d.lastSynced(syncedLabel) : d.loadedOnOpen}</p>
        <button
          type="button"
          onClick={reload.onReload}
          disabled={reload.busy}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${reload.busy ? "animate-spin" : ""}`} aria-hidden />
          {m.reload}
        </button>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <AdminTile
          title={d.accountTitle}
          description={d.accountDescription}
          data-testid="admin-fallback-card"
        >
          <div className="flex items-center gap-3 rounded-2xl border border-blue-500/40 bg-blue-500/10 p-3">
            <ModelLogo provider={fallback.provider} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-zinc-100">{fallback.name}</p>
              <p className="text-xs text-zinc-400">
                {modelCompanyName(fallback.provider)}
                {fallback.credits !== null ? ` · ${d.credits(fallback.credits)}` : ""}
              </p>
            </div>
            <AdminStatusChip tone="info">{d.currentBadge}</AdminStatusChip>
          </div>
          <p className="text-xs text-zinc-500">{d.fixedInCode}</p>
          <p className="text-sm text-zinc-400">{m.decisions.fallbackApplies}</p>
          <p className="text-sm text-zinc-400">{m.decisions.fallbackProtection}</p>

          <div className="rounded-2xl border border-zinc-800 p-4">
            <p className="text-sm font-bold text-zinc-100">{m.decisions.checkTitle}</p>
            {transition.loaded && transition.candidates.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-400">{m.decisions.checkEmpty}</p>
            ) : (
              <>
                <label className="mt-3 block text-xs font-bold text-zinc-400">
                  {d.candidateLabel}
                  <select
                    value={transition.candidateId}
                    onChange={(event) => transition.onCandidate(event.target.value)}
                    className={`${selectClass} mt-1`}
                    data-testid="admin-fallback-candidate"
                  >
                    <option value="">{m.decisions.checkCandidate}</option>
                    {transition.candidates.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} ({model.id})
                      </option>
                    ))}
                  </select>
                </label>
                {transition.hasCandidate ? (
                  <ul className="mt-3 grid gap-1.5 text-sm text-zinc-300">
                    {transition.checks.map((check) => (
                      <li key={check.id} className="flex items-start gap-2">
                        {check.pass ? (
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                        ) : (
                          <X className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden />
                        )}
                        <span>
                          <span className="sr-only">{check.pass ? m.decisions.pass : m.decisions.fail} · </span>
                          {m.decisions.checks[check.id]}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <AdminWriteButton
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  disabled={!transition.hasCandidate}
                  data-testid="admin-fallback-copy"
                  onClick={transition.onCopy}
                >
                  {m.decisions.checkCopy}
                </AdminWriteButton>
              </>
            )}
          </div>
          <AdminTechInfo summary={fallback.id}>
            <p>{m.decisions.fallbackCurrent(fallback.name, fallback.id, fallback.provider)}</p>
            <p className="mt-2 font-sans">{m.decisions.fallbackDoesNot}</p>
            <p className="mt-2 font-sans">{m.decisions.fallbackHow}</p>
          </AdminTechInfo>
        </AdminTile>

        <AdminTile title={d.guestTitle} description={d.guestDescription}>
          <fieldset data-testid="admin-guest-lineup" className="min-w-0">
            <legend className="sr-only">{m.guestDefault.lineupTitle}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {lineup.draft.map((slotId, index) => {
                const provider = lineup.slotProviders[index];
                const slotModel =
                  lineup.options.find((model) => model.id === slotId) ??
                  lead.options.find((model) => model.id === slotId);
                const candidates = lineup.options.filter(
                  (model) => !provider || model.provider === provider
                );
                return (
                  <div
                    key={index}
                    className="flex min-w-0 flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-700 p-3 text-center"
                  >
                    <ModelLogo provider={provider ?? slotModel?.provider ?? "ai"} size="lg" />
                    <p className="text-xs text-zinc-500">{provider ? modelCompanyName(provider) : ""}</p>
                    <p className="min-h-10 text-sm font-bold text-zinc-100">{lineup.labelFor(slotId)}</p>
                    <label className="block w-full text-left">
                      <span className="mb-1 block text-xs font-medium text-zinc-500">
                        {m.guestDefault.lineupSlot(index + 1, provider ? modelCompanyName(provider) : "")}
                      </span>
                      <select
                        value={slotId}
                        disabled={lineup.saving}
                        data-testid={`admin-guest-lineup-slot-${index}`}
                        onChange={(event) => lineup.onSlot(index, event.target.value)}
                        className={selectClass}
                      >
                        {candidates.some((model) => model.id === slotId) ? null : (
                          <option value={slotId}>{lineup.labelFor(slotId)}</option>
                        )}
                        {candidates.map((model) => (
                          <option
                            key={model.id}
                            value={model.id}
                            disabled={model.id !== slotId && lineup.draft.includes(model.id)}
                          >
                            {model.name} - {model.provider}
                          </option>
                        ))}
                      </select>
                    </label>
                    {slotModel?.credits ? (
                      <p className="text-xs text-zinc-500">{d.credits(slotModel.credits)}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-sm text-zinc-400">{m.guestDefault.lineupDescription}</p>
            {lineup.leadMovesTo ? (
              <p className={`mt-2 ${warn}`} data-testid="admin-guest-lineup-lead-moves">
                {m.guestDefault.lineupLeadMoves(lineup.leadMovesTo)}
              </p>
            ) : null}
            {lineup.error ? (
              <p className={`mt-2 ${warn}`} data-testid="admin-guest-lineup-error">
                {lineup.error}
              </p>
            ) : null}
            <AdminWriteButton
              className="mt-3"
              stepUp
              onClick={lineup.onSave}
              disabled={lineup.saving || !lineup.changed || !lineup.complete}
              data-testid="admin-guest-lineup-save"
            >
              {m.guestDefault.saveLineup}
            </AdminWriteButton>
          </fieldset>

          <p className="text-sm text-zinc-300">{m.guestDefault.visibleOrder(notices.visibleOrder)}</p>
          {notices.missingProviders ? (
            <p className={warn} data-testid="admin-guest-lineup-provider-missing">
              {m.guestDefault.lineupProviderMissing(notices.missingProviders)}
            </p>
          ) : null}
          {notices.storedNotApplied ? (
            <p className={warn}>
              {m.guestDefault.storedNotApplied(notices.storedNotApplied.stored, notices.storedNotApplied.effective)}
            </p>
          ) : null}
          {notices.substitutions.map((item) => (
            <p key={item.id} className="text-sm text-amber-300">
              {m.guestDefault.substituted(item.missing, item.substitute)}{" "}
              <Link href={`/admin/models?q=${encodeURIComponent(item.id)}`} className="font-bold text-zinc-100 underline">
                {item.missing}
              </Link>
            </p>
          ))}
          {notices.outsideTrio.map((model) => (
            <p key={model.id} className="text-sm text-zinc-400">
              {m.guestDefault.outsideTrio(model.name, model.id)}
            </p>
          ))}

          <div className="border-t border-zinc-800 pt-4">
            <p className="text-sm font-bold text-zinc-100">{d.leadTitle}</p>
            {lead.options.length === 0 || !lead.inList ? (
              <AdminStateBlock kind="empty" title={m.guestDefault.noEligible} />
            ) : null}
            <label className="mt-2 block text-xs font-bold text-zinc-400">
              {m.guestDefault.leadingEngine}
              <select
                value={lead.inList ? lead.value : ""}
                disabled={lead.options.length === 0 || lead.saving}
                onChange={(event) => lead.onChange(event.target.value)}
                className={`${selectClass} mt-1`}
              >
                {lead.options.length === 0 || !lead.inList ? (
                  <option value="">{m.guestDefault.noEligible}</option>
                ) : null}
                {lead.options.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} - {model.provider}
                  </option>
                ))}
              </select>
            </label>
            {lead.error ? (
              <p className={`mt-2 ${warn}`} data-testid="admin-guest-lead-error">
                {lead.error}
              </p>
            ) : null}
            <AdminWriteButton
              className="mt-3"
              stepUp
              onClick={lead.onSave}
              disabled={lead.saving || lead.options.length === 0 || !lead.inList}
            >
              {m.guestDefault.saveLead}
            </AdminWriteButton>
          </div>
        </AdminTile>
      </div>

      <AdminTile
        title={m.decisions.accountTitle}
        description={m.decisions.accountBadge}
        data-testid="admin-account-default-card"
      >
        <p className="text-sm text-zinc-400">{m.decisions.accountBody}</p>
        <Link href="/admin/analytics" className="text-sm font-bold text-blue-300 underline underline-offset-4">
          {m.decisions.accountLink}
        </Link>
      </AdminTile>
    </div>
  );
}
