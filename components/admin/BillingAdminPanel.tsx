"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type {
  BillingPlanConfig,
  BillingPromotionConfig,
} from "@/lib/billingConfig";
import type {
  BillingPriceCatalog,
  BillingPriceCatalogSource,
} from "@/lib/billingPriceCatalog";
import {
  fixedAmountPromotionRefusal,
  type AdminPromotionPolicyInput,
} from "@/lib/billingPromotionAdminPolicy";
import { isFixedAmountPromotion } from "@/lib/billingPromotionCore";
import {
  BILLING_CURRENCIES,
  billingCurrencyFractionDigits,
  billingMajorToMinor,
  billingMinorToMajor,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { dispatchAppToast } from "@/lib/appToast";
import { adminBillingMessages } from "@/lib/adminMessages/billing";
import { publishPromotionDraftState } from "@/lib/promotionDiagnosticsEvents";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import {
  AdminDataTable,
  type AdminDataColumn,
} from "@/components/admin/ui/AdminDataTable";
import { AdminSaveBar } from "@/components/admin/ui/AdminSaveBar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminSwitch } from "@/components/admin/ui/AdminSwitch";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";

type BillingConfigPayload = {
  plans: BillingPlanConfig[];
  promotions: BillingPromotionConfig[];
  priceCatalog: BillingPriceCatalog;
  priceCatalogUpdatedAt: string | null;
  /**
   * Which table the catalogue above came from.
   *
   * Optional because the PATCH/GET response shape is shared with older
   * callers; absent reads as "not reported" rather than as "stored", so a
   * client that does not know about this cannot claim the row is in use.
   */
  priceCatalogSource?: BillingPriceCatalogSource;
};

/** How many accounts sit on each plan; `null` when the count could not be read. */
export type BillingSubscriberCounts = {
  free: number | null;
  pro: number | null;
  max: number | null;
};

type Props = BillingConfigPayload & {
  /** Whether this role may save: the same `billing:write` the PATCH route checks. */
  canWrite: boolean;
  subscribers: BillingSubscriberCounts;
  /**
   * The page's `?tab=` is the section: the panel follows `initialTab` and
   * draws no tab strip of its own, so the address and the screen cannot
   * disagree (2026-11-07).
   */
  initialTab?: "plans" | "prices" | "promotions";
  /** Drawn under the promotion codes, above the save bar (the risk monitor). */
  afterPromotions?: React.ReactNode;
};

type EditablePlan = BillingPlanConfig;
type EditablePromotion = BillingPromotionConfig;
type Copy = AdminMessageShape<typeof adminBillingMessages.en>;
type AdminBillingResponse = BillingConfigPayload & {
  error?: string;
  /**
   * Present when the save was refused by policy rather than failing. The
   * generic "retry, or reload" advice is wrong for these -- retrying the same
   * edit is refused again -- so the reason is shown instead.
   */
  code?: string;
};

const PROMOTION_POLICY_REFUSAL_CODE = "PROMOTION_FIXED_AMOUNT_BLOCKED";

const PLAN_DOT: Record<EditablePlan["id"], string> = {
  free: "bg-zinc-400",
  pro: "bg-blue-500",
  max: "bg-violet-500",
};

const dollars = (cents: number) =>
  (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);

const numberText = (value: number) => value.toLocaleString("en-US");

const toCents = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0;
};

const priceInputValue = (amountMinor: number, currency: BillingCurrency) =>
  billingMinorToMajor(amountMinor, currency).toFixed(
    billingCurrencyFractionDigits(currency)
  );

const priceMinorFromInput = (value: string, currency: BillingCurrency) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? billingMajorToMinor(parsed, currency)
    : 0;
};

const toDateInputValue = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const fromDateInputValue = (value: string) =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

/**
 * The same shape the endpoint judges a promotion write from, so the panel and
 * the server reach their answer through one function rather than two readings
 * of docs/policy/promotion-discount-currency.md section 4.
 */
const policyInput = (
  promotion: EditablePromotion
): AdminPromotionPolicyInput => ({
  code: promotion.code,
  discountPercent: promotion.discountPercent,
  discountAmountCents: promotion.discountAmountCents,
  maxRedemptions: promotion.maxRedemptions,
  durationMonths: promotion.durationMonths,
  appliesToPlanIds: promotion.appliesToPlanIds,
  startsAt: promotion.startsAt,
  endsAt: promotion.endsAt,
  isActive: promotion.isActive,
});

const newPromotion = (): EditablePromotion => ({
  id: `promo_${Date.now()}`,
  code: "NEWCODE",
  discountPercent: 10,
  discountAmountCents: null,
  maxRedemptions: 100,
  redeemedCount: 0,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription",
  accessDurationDays: null,
  appliesToPlanIds: ["pro", "max"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  allowAnnualStacking: false,
  isActive: true,
});

const PLAN_VALUE_FIELDS = [
  "monthlyPriceCents",
  "annualPriceCents",
  "dailyMessageLimit",
  "monthlyMessageLimit",
  "maxModels",
] as const;
const PLAN_FLAG_FIELDS = [
  "isActive",
  "allowAttachments",
  "allowSharing",
  "allowDownloads",
] as const;

/**
 * What differs between the stored plan and the draft, one short line each
 * ("Monthly credits 6,000 → 8,000"). Stripe IDs are named but never quoted:
 * they are internal identifiers, not something to read out in a summary.
 */
export function planChangeLines(
  baseline: EditablePlan | undefined,
  draft: EditablePlan,
  m: Copy["plan"]
): string[] {
  if (!baseline) return [];
  const lines: string[] = [];
  for (const key of PLAN_VALUE_FIELDS) {
    if (baseline[key] === draft[key]) continue;
    const isPrice = key === "monthlyPriceCents" || key === "annualPriceCents";
    const show = (value: number) =>
      isPrice ? `US$ ${dollars(value)}` : numberText(value);
    lines.push(m.change(m.changeLabel[key], show(baseline[key]), show(draft[key])));
  }
  for (const key of PLAN_FLAG_FIELDS) {
    if (baseline[key] === draft[key]) continue;
    const show = (value: boolean) => (value ? m.on : m.off);
    lines.push(m.change(m.changeLabel[key], show(baseline[key]), show(draft[key])));
  }
  if (
    (baseline.stripeProductId || null) !== (draft.stripeProductId || null) ||
    (baseline.stripePriceId || null) !== (draft.stripePriceId || null) ||
    (baseline.stripeAnnualPriceId || null) !== (draft.stripeAnnualPriceId || null)
  ) {
    lines.push(m.stripeIdsChanged);
  }
  return lines;
}

/** One line per added, removed or edited promotion code. */
export function promotionChangeLines(
  baselines: readonly EditablePromotion[],
  drafts: readonly EditablePromotion[],
  m: Copy
): string[] {
  const p = m.promotion;
  const show = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return p.unset;
    if (typeof value === "boolean") return value ? m.plan.on : m.plan.off;
    if (typeof value === "number") return numberText(value);
    if (Array.isArray(value)) return value.length ? value.join(", ") : p.unset;
    return String(value);
  };
  const fields: Array<{
    label: string;
    read: (promotion: EditablePromotion) => unknown;
  }> = [
    { label: p.code, read: (x) => x.code },
    { label: p.discountPercent, read: (x) => x.discountPercent },
    {
      label: p.fixedDiscountUsd,
      read: (x) =>
        x.discountAmountCents === null || x.discountAmountCents === undefined
          ? null
          : `US$ ${dollars(x.discountAmountCents)}`,
    },
    { label: p.maxRedemptions, read: (x) => x.maxRedemptions },
    { label: p.durationMonths, read: (x) => x.durationMonths },
    { label: p.fulfillment, read: (x) => x.fulfillmentType },
    { label: p.passDurationDays, read: (x) => x.accessDurationDays },
    { label: p.starts, read: (x) => toDateInputValue(x.startsAt) },
    { label: p.ends, read: (x) => toDateInputValue(x.endsAt) },
    { label: p.eligiblePlans, read: (x) => x.appliesToPlanIds },
    { label: p.allowAnnualStacking, read: (x) => x.allowAnnualStacking },
    { label: p.active, read: (x) => x.isActive },
  ];
  const lines: string[] = [];
  for (const draft of drafts) {
    const baseline = baselines.find((item) => item.id === draft.id);
    if (!baseline) {
      lines.push(p.added(draft.code));
      continue;
    }
    const changes = fields.flatMap((field) => {
      const from = field.read(baseline);
      const to = field.read(draft);
      return JSON.stringify(from) === JSON.stringify(to)
        ? []
        : [m.plan.change(field.label, show(from), show(to))];
    });
    if (
      (baseline.stripeCouponId || null) !== (draft.stripeCouponId || null) ||
      (baseline.stripePromotionCodeId || null) !== (draft.stripePromotionCodeId || null)
    ) {
      changes.push(p.stripeIdsChanged);
    }
    if (changes.length > 0) lines.push(p.changed(baseline.code, changes.join(", ")));
  }
  for (const baseline of baselines) {
    if (!drafts.some((item) => item.id === baseline.id)) {
      lines.push(p.removed(baseline.code));
    }
  }
  return lines;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-semibold text-zinc-400">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60 ${props.className || ""}`}
    />
  );
}

function PlanCard({
  plan,
  baseline,
  subscribers,
  onChange,
}: {
  plan: EditablePlan;
  baseline: EditablePlan | undefined;
  subscribers: number | null;
  onChange: (plan: EditablePlan) => void;
}) {
  const m = useAdminMessages(adminBillingMessages).plan;
  const hasStripeIds = Boolean(plan.stripeProductId && plan.stripePriceId);
  const annualSavings =
    plan.monthlyPriceCents > 0
      ? Math.max(
          0,
          100 -
            Math.round(
              (plan.annualPriceCents / (plan.monthlyPriceCents * 12)) * 100
            )
        )
      : 0;
  const changes = planChangeLines(baseline, plan, m);

  return (
    <AdminTile
      as="article"
      data-testid={`billing-plan-${plan.id}`}
      data-changed={changes.length > 0 ? "true" : undefined}
      className={changes.length > 0 ? "ring-2 ring-blue-500" : ""}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`h-3 w-3 shrink-0 rounded-sm ${PLAN_DOT[plan.id]}`}
          />
          <h3 className="truncate text-lg font-bold text-white">{plan.name}</h3>
        </div>
        {plan.id === "free" ? (
          <AdminStatusChip tone="idle">{m.noPayment}</AdminStatusChip>
        ) : hasStripeIds ? (
          <AdminStatusChip tone="ok">{m.stripeConnected}</AdminStatusChip>
        ) : (
          <AdminStatusChip tone="warn">{m.priceIdNeeded}</AdminStatusChip>
        )}
      </div>

      <div>
        <p className="text-3xl font-bold tabular-nums tracking-tight text-white">
          US$ {dollars(plan.monthlyPriceCents)}{" "}
          <span className="text-sm font-medium text-zinc-500">{m.perMonth}</span>
        </p>
        {plan.id !== "free" ? (
          <p className="mt-1 text-xs text-zinc-500">
            {m.annualLine(dollars(plan.annualPriceCents), annualSavings)}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3 rounded-xl bg-zinc-950 p-3">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">
            {plan.id === "free" ? m.users : m.subscribers}
          </p>
          <p
            className={`mt-1 tabular-nums ${
              subscribers === null
                ? "text-sm text-zinc-400"
                : "text-lg font-bold text-white"
            }`}
          >
            {subscribers === null ? m.unreadCount : numberText(subscribers)}
          </p>
        </div>
        <Field label={m.monthlyCredits}>
          <TextInput
            type="number"
            min="0"
            value={plan.monthlyMessageLimit}
            onChange={(event) =>
              onChange({
                ...plan,
                monthlyMessageLimit: Number(event.target.value) || 0,
              })
            }
            className="px-2 font-bold tabular-nums"
          />
        </Field>
        <Field label={m.comparedModels}>
          <TextInput
            type="number"
            min="1"
            max="10"
            value={plan.maxModels}
            onChange={(event) =>
              onChange({ ...plan, maxModels: Number(event.target.value) || 1 })
            }
            className="px-2 font-bold tabular-nums"
          />
        </Field>
      </div>

      <div className="flex flex-col">
        <AdminSwitch
          label={m.active}
          checked={plan.isActive}
          onChange={(isActive) => onChange({ ...plan, isActive })}
        />
        {(
          [
            ["allowAttachments", m.features.allowAttachments],
            ["allowSharing", m.features.allowSharing],
            ["allowDownloads", m.features.allowDownloads],
          ] as const
        ).map(([key, label]) => (
          <AdminSwitch
            key={key}
            label={label}
            checked={plan[key]}
            onChange={(next) => onChange({ ...plan, [key]: next })}
          />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={m.monthlyPriceUsd}>
          <TextInput
            type="number"
            min="0"
            step="0.01"
            value={dollars(plan.monthlyPriceCents)}
            onChange={(event) =>
              onChange({ ...plan, monthlyPriceCents: toCents(event.target.value) })
            }
          />
        </Field>
        <Field label={m.annualPriceUsd}>
          <TextInput
            type="number"
            min="0"
            step="0.01"
            value={dollars(plan.annualPriceCents)}
            onChange={(event) =>
              onChange({ ...plan, annualPriceCents: toCents(event.target.value) })
            }
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label={m.dailyCredits}>
            <TextInput
              type="number"
              min="0"
              value={plan.dailyMessageLimit}
              onChange={(event) =>
                onChange({
                  ...plan,
                  dailyMessageLimit: Number(event.target.value) || 0,
                })
              }
            />
          </Field>
        </div>
      </div>

      {plan.id !== "free" ? (
        <AdminTechInfo summary={m.stripeIdsSummary}>
          <div className="flex flex-col gap-3 font-sans">
            <Field label={m.stripeProductId}>
              <TextInput
                value={plan.stripeProductId || ""}
                onChange={(event) =>
                  onChange({ ...plan, stripeProductId: event.target.value || null })
                }
                placeholder="prod_..."
              />
            </Field>
            <Field label={m.stripeMonthlyPriceId}>
              <TextInput
                value={plan.stripePriceId || ""}
                onChange={(event) =>
                  onChange({ ...plan, stripePriceId: event.target.value || null })
                }
                placeholder="price_..."
              />
            </Field>
            <Field label={m.stripeAnnualPriceId}>
              <TextInput
                value={plan.stripeAnnualPriceId || ""}
                onChange={(event) =>
                  onChange({
                    ...plan,
                    stripeAnnualPriceId: event.target.value || null,
                  })
                }
                placeholder="price_..."
              />
            </Field>
          </div>
        </AdminTechInfo>
      ) : null}

      {changes.length > 0 ? (
        <div
          data-testid={`billing-plan-${plan.id}-changes`}
          className="flex flex-col gap-1 rounded-xl bg-blue-500/10 px-3 py-2 text-xs text-blue-300"
        >
          {changes.map((line) => (
            <p key={line} className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {m.changedNote(line)}
            </p>
          ))}
        </div>
      ) : null}
    </AdminTile>
  );
}

function PromotionCard({
  promotion,
  baseline,
  refusal,
  onChange,
  onDelete,
}: {
  promotion: EditablePromotion;
  /** The stored promotion this edit is judged against, or null if it is new. */
  baseline: EditablePromotion | null;
  refusal: string | null;
  onChange: (promotion: EditablePromotion) => void;
  onDelete: () => void;
}) {
  const m = useAdminMessages(adminBillingMessages).promotion;
  // Whether a fixed amount may be typed here at all is decided by what is
  // stored, not by what the draft currently says: a promotion that is a
  // percentage one in the database can never acquire an amount, and clearing
  // the field mid-edit must not be what unlocks it.
  const fixedAmountEditable = baseline
    ? isFixedAmountPromotion(baseline)
    : false;
  const amountDollars =
    promotion.discountAmountCents === null ||
    promotion.discountAmountCents === undefined
      ? ""
      : dollars(promotion.discountAmountCents);
  const remaining = promotion.maxRedemptions
    ? Math.max(0, promotion.maxRedemptions - (promotion.redeemedCount || 0))
    : null;

  return (
    <AdminTile as="article">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-white">{promotion.code}</h3>
            <AdminStatusChip tone={promotion.isActive ? "ok" : "idle"}>
              {promotion.isActive ? m.active : m.paused}
            </AdminStatusChip>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {m.redeemed(
              promotion.redeemedCount || 0,
              promotion.maxRedemptions,
              remaining
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <AdminSwitch
            label={m.active}
            checked={promotion.isActive}
            onChange={(isActive) => onChange({ ...promotion, isActive })}
            className="w-auto"
          />
          <button
            type="button"
            onClick={onDelete}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-red-300 hover:bg-red-500/15"
            aria-label={m.deletePromotion}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label={m.code}>
          <TextInput
            value={promotion.code}
            onChange={(event) =>
              onChange({ ...promotion, code: event.target.value.toUpperCase() })
            }
          />
        </Field>
        <Field label={m.discountPercent}>
          <TextInput
            type="number"
            min="0"
            max="100"
            value={promotion.discountPercent}
            onChange={(event) =>
              onChange({ ...promotion, discountPercent: Number(event.target.value) || 0 })
            }
          />
        </Field>
        <Field label={m.fixedDiscountUsd}>
          <TextInput
            type="number"
            min="0"
            step="0.01"
            disabled={!fixedAmountEditable}
            data-testid="promotion-fixed-amount-input"
            aria-describedby={`promotion-fixed-amount-note-${promotion.id}`}
            value={amountDollars}
            onChange={(event) =>
              onChange({
                ...promotion,
                discountAmountCents:
                  event.target.value.trim().length > 0
                    ? toCents(event.target.value)
                    : null,
              })
            }
          />
          <p
            id={`promotion-fixed-amount-note-${promotion.id}`}
            data-testid="promotion-fixed-amount-note"
            className="mt-1.5 text-[11px] font-medium leading-4 text-zinc-500"
          >
            {fixedAmountEditable
              ? m.fixedAmountEditableNote
              : m.fixedAmountLockedNote}
          </p>
        </Field>
      </div>

      {refusal ? (
        <p
          data-testid="promotion-policy-refusal"
          role="status"
          className="rounded-xl bg-red-500/10 px-3 py-2 text-xs font-semibold leading-5 text-red-300"
        >
          {refusal}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <Field label={m.fulfillment}>
          <select
            value={promotion.fulfillmentType}
            onChange={(event) => {
              const fulfillmentType = event.target.value as
                | "stripe_subscription"
                | "internal_pass";
              onChange({
                ...promotion,
                fulfillmentType,
                accessDurationDays:
                  fulfillmentType === "internal_pass"
                    ? promotion.accessDurationDays || 60
                    : null,
              });
            }}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          >
            <option value="stripe_subscription">{m.stripeSubscription}</option>
            <option value="internal_pass">{m.internalPass}</option>
          </select>
        </Field>
        <Field label={m.passDurationDays}>
          <TextInput
            type="number"
            min="1"
            max="366"
            disabled={promotion.fulfillmentType !== "internal_pass"}
            value={promotion.accessDurationDays || ""}
            onChange={(event) =>
              onChange({
                ...promotion,
                accessDurationDays: Number(event.target.value) || 60,
              })
            }
          />
        </Field>
        <Field label={m.durationMonths}>
          <TextInput
            type="number"
            min="1"
            max="36"
            value={promotion.durationMonths}
            onChange={(event) =>
              onChange({ ...promotion, durationMonths: Number(event.target.value) || 1 })
            }
          />
        </Field>
        <Field label={m.maxRedemptions}>
          <TextInput
            type="number"
            min="1"
            value={promotion.maxRedemptions || ""}
            onChange={(event) =>
              onChange({
                ...promotion,
                maxRedemptions:
                  event.target.value.trim().length > 0
                    ? Number(event.target.value) || 1
                    : null,
              })
            }
          />
        </Field>
        <Field label={m.starts}>
          <TextInput
            type="date"
            value={toDateInputValue(promotion.startsAt)}
            onChange={(event) =>
              onChange({ ...promotion, startsAt: fromDateInputValue(event.target.value) })
            }
          />
        </Field>
        <Field label={m.ends}>
          <TextInput
            type="date"
            value={toDateInputValue(promotion.endsAt)}
            onChange={(event) =>
              onChange({ ...promotion, endsAt: fromDateInputValue(event.target.value) })
            }
          />
        </Field>
      </div>

      {promotion.fulfillmentType === "internal_pass" ? (
        <p className="rounded-xl bg-blue-500/10 px-3 py-2 text-xs font-semibold leading-5 text-blue-300">
          {m.internalPassNote}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-zinc-400">{m.eligiblePlans}</span>
        {(["pro", "max"] as const).map((planId) => (
          <label
            key={planId}
            className="flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-semibold uppercase text-zinc-300"
          >
            <input
              type="checkbox"
              checked={promotion.appliesToPlanIds.includes(planId)}
              onChange={(event) =>
                onChange({
                  ...promotion,
                  appliesToPlanIds: event.target.checked
                    ? Array.from(new Set([...promotion.appliesToPlanIds, planId]))
                    : promotion.appliesToPlanIds.filter((item) => item !== planId),
                })
              }
              className="h-4 w-4 accent-blue-500"
            />
            {planId}
          </label>
        ))}
      </div>

      <div>
        <AdminSwitch
          label={m.allowAnnualStacking}
          checked={promotion.allowAnnualStacking}
          onChange={(allowAnnualStacking) =>
            onChange({ ...promotion, allowAnnualStacking })
          }
        />
        <p className="mt-1 text-xs leading-5 text-zinc-500">{m.stackingNote}</p>
      </div>

      <AdminTechInfo summary={m.stripeCouponLinkage}>
        <div className="grid gap-3 font-sans md:grid-cols-2">
          <Field label={m.stripeCouponId}>
            <TextInput
              value={promotion.stripeCouponId || ""}
              onChange={(event) =>
                onChange({ ...promotion, stripeCouponId: event.target.value || null })
              }
              placeholder="coupon_..."
            />
          </Field>
          <Field label={m.stripePromotionCodeId}>
            <TextInput
              value={promotion.stripePromotionCodeId || ""}
              onChange={(event) =>
                onChange({
                  ...promotion,
                  stripePromotionCodeId: event.target.value || null,
                })
              }
              placeholder="promo_..."
            />
          </Field>
        </div>
      </AdminTechInfo>
    </AdminTile>
  );
}

const LOCALIZED_PLAN_CURRENCIES = ["AUD", "CNY", "EUR", "KRW"] as const;
type LocalizedPlanCurrency = (typeof LOCALIZED_PLAN_CURRENCIES)[number];
const CREDIT_PACK_IDS = ["starter_500", "project_1500", "power_4000"] as const;

function LocalizedPriceEditor({
  catalog,
  updatedAt,
  source,
  onChange,
}: {
  catalog: BillingPriceCatalog;
  updatedAt: string | null;
  source: BillingPriceCatalogSource | undefined;
  onChange: (catalog: BillingPriceCatalog) => void;
}) {
  const m = useAdminMessages(adminBillingMessages).prices;
  const updatePlanPrice = (
    planId: "pro" | "max",
    currency: LocalizedPlanCurrency,
    interval: "monthly" | "annual",
    value: string
  ) => {
    onChange({
      ...catalog,
      plans: {
        ...catalog.plans,
        [planId]: {
          ...catalog.plans[planId],
          [currency]: {
            ...catalog.plans[planId][currency],
            [interval]: priceMinorFromInput(value, currency),
          },
        },
      },
    });
  };

  const updatePackPrice = (
    packId: keyof BillingPriceCatalog["creditPacks"],
    currency: BillingCurrency,
    value: string
  ) => {
    onChange({
      ...catalog,
      creditPacks: {
        ...catalog.creditPacks,
        [packId]: {
          ...catalog.creditPacks[packId],
          [currency]: priceMinorFromInput(value, currency),
        },
      },
    });
  };

  const planHeaders: Record<string, string> = {
    "pro-monthly": m.proMonthly,
    "pro-annual": m.proAnnual,
    "max-monthly": m.maxMonthly,
    "max-annual": m.maxAnnual,
  };
  const planColumns: AdminDataColumn<LocalizedPlanCurrency>[] = [
    {
      key: "currency",
      header: m.currency,
      render: (currency) => (
        <span className="font-bold text-white">{currency}</span>
      ),
    },
    ...(["pro", "max"] as const).flatMap((planId) =>
      (["monthly", "annual"] as const).map(
        (interval): AdminDataColumn<LocalizedPlanCurrency> => ({
          key: `${planId}-${interval}`,
          header: planHeaders[`${planId}-${interval}`],
          render: (currency) => (
            <TextInput
              type="number"
              min="0"
              step={currency === "KRW" ? "1" : "0.01"}
              value={priceInputValue(
                catalog.plans[planId][currency][interval],
                currency
              )}
              onChange={(event) =>
                updatePlanPrice(planId, currency, interval, event.target.value)
              }
              aria-label={m.priceInputLabel(planId, interval, currency)}
              className="min-w-24"
            />
          ),
        })
      )
    ),
  ];
  const packColumns: AdminDataColumn<BillingCurrency>[] = [
    {
      key: "currency",
      header: m.currency,
      render: (currency) => (
        <span className="font-bold text-white">{currency}</span>
      ),
    },
    ...CREDIT_PACK_IDS.map(
      (packId): AdminDataColumn<BillingCurrency> => ({
        key: packId,
        header: m.creditPacks[packId],
        render: (currency) => (
          <TextInput
            type="number"
            min="0.01"
            step={currency === "KRW" ? "1" : "0.01"}
            value={priceInputValue(catalog.creditPacks[packId][currency], currency)}
            onChange={(event) =>
              updatePackPrice(packId, currency, event.target.value)
            }
            aria-label={m.packInputLabel(m.creditPacks[packId], currency)}
            className="min-w-24"
          />
        ),
      })
    ),
  ];
  const savedAt = formatAestDateTime(updatedAt);

  return (
    <div className="flex flex-col gap-5">
      {source && source !== "stored" ? (
        <p
          data-testid="price-catalog-fallback-notice"
          role="status"
          className="rounded-2xl bg-amber-500/10 px-4 py-3 text-xs font-semibold leading-5 text-amber-300"
        >
          {source === "created_from_default"
            ? m.fallbackCreated
            : m.fallbackUnreadable}
        </p>
      ) : null}
      <AdminTile
        title={m.subscriptionTitle}
        description={m.subscriptionDescription}
        action={
          savedAt ? (
            <span className="text-xs text-zinc-500">{m.lastSaved(savedAt)}</span>
          ) : null
        }
      >
        <AdminDataTable
          caption={m.subscriptionTitle}
          columns={planColumns}
          rows={LOCALIZED_PLAN_CURRENCIES}
          rowKey={(currency) => currency}
        />
      </AdminTile>
      <AdminTile
        title={m.creditPackTitle}
        description={m.creditPackDescription}
      >
        <AdminDataTable
          caption={m.creditPackTitle}
          columns={packColumns}
          rows={BILLING_CURRENCIES}
          rowKey={(currency) => currency}
        />
      </AdminTile>
    </div>
  );
}

export function BillingAdminPanel({
  plans,
  promotions,
  priceCatalog,
  priceCatalogUpdatedAt,
  priceCatalogSource,
  canWrite,
  subscribers,
  initialTab = "plans",
  afterPromotions,
}: Props) {
  const m = useAdminMessages(adminBillingMessages);
  const [draftPlans, setDraftPlans] = useState<EditablePlan[]>(plans);
  const [draftPromotions, setDraftPromotions] =
    useState<EditablePromotion[]>(promotions);
  const [baselinePlans, setBaselinePlans] = useState<EditablePlan[]>(plans);
  const [baselinePromotions, setBaselinePromotions] =
    useState<EditablePromotion[]>(promotions);
  const [draftPriceCatalog, setDraftPriceCatalog] =
    useState<BillingPriceCatalog>(priceCatalog);
  const [baselinePriceCatalog, setBaselinePriceCatalog] =
    useState<BillingPriceCatalog>(priceCatalog);
  const [draftPriceCatalogUpdatedAt, setDraftPriceCatalogUpdatedAt] =
    useState<string | null>(priceCatalogUpdatedAt);
  const [catalogSource, setCatalogSource] = useState<
    BillingPriceCatalogSource | undefined
  >(priceCatalogSource);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isValidatingStripe, setIsValidatingStripe] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const activeTab = initialTab;
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [stripeValidation, setStripeValidation] = useState<
    Array<{
      planId: string;
      name: string;
      product: string;
      monthlyPrice: string;
      annualPrice: string;
      errors: string[];
    }>
  >([]);

  const dirtyPlanCount = useMemo(
    () =>
      draftPlans.filter((plan) => {
        const original = plans.find((item) => item.id === plan.id);
        const baseline = baselinePlans.find((item) => item.id === plan.id);
        return JSON.stringify(baseline || original) !== JSON.stringify(plan);
      }).length,
    [baselinePlans, draftPlans, plans]
  );
  const dirtyPromotionCount = useMemo(
    () =>
      draftPromotions.filter((promotion) => {
        const original = promotions.find((item) => item.id === promotion.id);
        const baseline = baselinePromotions.find((item) => item.id === promotion.id);
        return JSON.stringify(baseline || original) !== JSON.stringify(promotion);
      }).length +
      baselinePromotions.filter(
        (promotion) => !draftPromotions.some((item) => item.id === promotion.id)
      ).length,
    [baselinePromotions, draftPromotions, promotions]
  );
  /**
   * Which promotions carry unsaved edits, published for the diagnostics panel.
   *
   * Diagnostics read the saved row, so running one against a dirty draft would
   * answer a question the operator did not ask. The ids go out rather than a
   * count: the panel has to disable exactly the selected promotion, not every
   * promotion whenever any one of them is dirty.
   */
  const dirtyPromotionIds = useMemo(
    () =>
      draftPromotions
        .filter((promotion) => {
          const original = promotions.find((item) => item.id === promotion.id);
          const baseline = baselinePromotions.find(
            (item) => item.id === promotion.id
          );
          return JSON.stringify(baseline || original) !== JSON.stringify(promotion);
        })
        .map((promotion) => promotion.id),
    [baselinePromotions, draftPromotions, promotions]
  );
  useEffect(() => {
    publishPromotionDraftState({ dirtyPromotionIds });
    // The draft lives in this panel. When the operator leaves for a tab that
    // does not draw it (Diagnostics), nothing is dirty any more, and a stale
    // list would keep blocking that tab's diagnostics for a draft that is gone.
    return () => publishPromotionDraftState({ dirtyPromotionIds: [] });
  }, [dirtyPromotionIds]);

  const dirtyPriceCount = useMemo(
    () =>
      JSON.stringify(draftPriceCatalog) === JSON.stringify(baselinePriceCatalog)
        ? 0
        : 1,
    [baselinePriceCatalog, draftPriceCatalog]
  );
  const dirtyCount = dirtyPlanCount + dirtyPriceCount + dirtyPromotionCount;
  /**
   * The fixed-amount edits this draft would be refused for, keyed by promotion.
   *
   * Decided against `baselinePromotions` -- what is stored -- rather than
   * against the draft, and with the same function the endpoint uses, so the
   * panel refuses exactly what the server refuses. It is a refusal rather than
   * a warning: these saves are rejected, so offering the button would only
   * spend a round trip to find that out.
   */
  const promotionRefusals = useMemo(() => {
    const entries = new Map<string, string>();
    draftPromotions.forEach((promotion) => {
      const baseline = baselinePromotions.find(
        (item) => item.id === promotion.id
      );
      const refusal = fixedAmountPromotionRefusal({
        existing: baseline ? policyInput(baseline) : null,
        next: policyInput(promotion),
      });
      if (refusal) entries.set(promotion.id, refusal.message);
    });
    return entries;
  }, [baselinePromotions, draftPromotions]);

  const stripeWarnings = useMemo(() => {
    const warnings: string[] = [];
    draftPlans
      .filter((plan) => plan.id !== "free")
      .forEach((plan) => {
        if (!plan.stripeProductId?.startsWith("prod_")) {
          warnings.push(m.warnings.productId(plan.name));
        }
        if (!plan.stripePriceId?.startsWith("price_")) {
          warnings.push(m.warnings.monthlyPriceId(plan.name));
        }
        if (!plan.stripeAnnualPriceId?.startsWith("price_")) {
          warnings.push(m.warnings.annualPriceId(plan.name));
        }
      });
    draftPromotions.forEach((promotion) => {
      if (promotion.discountPercent > 100) {
        warnings.push(m.warnings.discountOver100(promotion.code));
      }
      if (promotion.appliesToPlanIds.length === 0) {
        warnings.push(m.warnings.noEligiblePlan(promotion.code));
      }
      if (
        promotion.isActive &&
        (!promotion.maxRedemptions || !promotion.endsAt)
      ) {
        warnings.push(m.warnings.activeNeedsCapAndEnd(promotion.code));
      }
      if (
        promotion.startsAt &&
        promotion.endsAt &&
        new Date(promotion.startsAt) >= new Date(promotion.endsAt)
      ) {
        warnings.push(m.warnings.endBeforeStart(promotion.code));
      }
      if (
        promotion.stripeCouponId &&
        !promotion.stripeCouponId.startsWith("coupon_")
      ) {
        warnings.push(m.warnings.couponId(promotion.code));
      }
      if (
        promotion.stripePromotionCodeId &&
        !promotion.stripePromotionCodeId.startsWith("promo_")
      ) {
        warnings.push(m.warnings.promotionCodeId(promotion.code));
      }
    });
    return warnings;
  }, [draftPlans, draftPromotions, m]);

  /** What the review dialog lists, one line per thing that would be saved. */
  const reviewLines = useMemo(() => {
    const planLines = draftPlans.flatMap((plan) => {
      const lines = planChangeLines(
        baselinePlans.find((item) => item.id === plan.id),
        plan,
        m.plan
      );
      return lines.length > 0 ? [`${plan.name}: ${lines.join(", ")}`] : [];
    });
    return [
      ...planLines,
      ...(dirtyPriceCount > 0 ? [m.review.pricesChanged] : []),
      ...promotionChangeLines(baselinePromotions, draftPromotions, m),
    ];
  }, [baselinePlans, baselinePromotions, dirtyPriceCount, draftPlans, draftPromotions, m]);

  const applyResponse = (data: BillingConfigPayload) => {
    setDraftPlans(data.plans);
    setDraftPromotions(data.promotions);
    setBaselinePlans(data.plans);
    setBaselinePromotions(data.promotions);
    setDraftPriceCatalog(data.priceCatalog);
    setBaselinePriceCatalog(data.priceCatalog);
    setDraftPriceCatalogUpdatedAt(data.priceCatalogUpdatedAt);
    setCatalogSource(data.priceCatalogSource);
    setLastSyncedAt(formatAestDateTime(new Date(), { seconds: true }) ?? "-");
  };

  /** Puts every draft back to what was last saved. Local only: nothing is sent. */
  const revert = () => {
    setDraftPlans(baselinePlans);
    setDraftPromotions(baselinePromotions);
    setDraftPriceCatalog(baselinePriceCatalog);
  };

  const refresh = async () => {
    if (isRefreshing || isSaving) return;
    setIsRefreshing(true);
    try {
      const response = await adminFetch("/api/admin/billing", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as AdminBillingResponse | null;
      if (!response.ok || !data?.plans || !data?.promotions || !data?.priceCatalog) {
        throw new Error(data?.error || "Billing refresh failed");
      }
      applyResponse(data);
      dispatchAppToast(m.toasts.reloaded, "success");
    } catch {
      dispatchAppToast(m.toasts.reloadFailed, "error");
    } finally {
      setIsRefreshing(false);
    }
  };

  const save = async () => {
    if (isSaving) return;
    if (promotionRefusals.size > 0) {
      setReviewOpen(false);
      dispatchAppToast(
        m.toasts.nothingSaved(Array.from(promotionRefusals.values())[0]),
        "error"
      );
      return;
    }
    setIsSaving(true);
    setReviewOpen(false);
    try {
      const response = await adminFetch("/api/admin/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plans: draftPlans,
          promotions: draftPromotions,
          priceCatalog: draftPriceCatalog,
          priceCatalogUpdatedAt: draftPriceCatalogUpdatedAt,
        }),
      });
      const data = (await response.json().catch(() => null)) as AdminBillingResponse | null;
      if (data?.code === PROMOTION_POLICY_REFUSAL_CODE && data.error) {
        dispatchAppToast(m.toasts.nothingSaved(data.error), "error");
        return;
      }
      if (!response.ok || !data?.plans || !data?.promotions || !data?.priceCatalog) {
        throw new Error(data?.error || "Billing save failed");
      }
      applyResponse(data);
      dispatchAppToast(m.toasts.saved, "success");
    } catch {
      dispatchAppToast(m.toasts.saveFailed, "error");
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * The only way to a save: the save bar opens this review, and the review's
   * confirm button runs `save`. There is no other button that calls it.
   */
  const requestReview = () => {
    if (!canWrite || isSaving || isRefreshing || dirtyCount === 0) return;
    setReviewOpen(true);
  };

  const validateStripeIds = async () => {
    if (isValidatingStripe) return;
    setIsValidatingStripe(true);
    try {
      const response = await adminFetch("/api/admin/stripe/validate", {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as
        | {
            results?: Array<{
              planId: string;
              name: string;
              product: string;
              monthlyPrice: string;
              annualPrice: string;
              errors: string[];
            }>;
            error?: string;
          }
        | null;
      if (!response.ok || !data?.results) {
        throw new Error(data?.error || m.toasts.stripeValidationFailed);
      }
      setStripeValidation(data.results);
      const failed = data.results.some((result) =>
        [result.product, result.monthlyPrice, result.annualPrice].some(
          (status) => status !== "ok"
        )
      );
      dispatchAppToast(
        failed ? m.toasts.stripeIssues : m.toasts.stripeValidated,
        failed ? "error" : "success"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toasts.stripeValidationFailed,
        "error"
      );
    } finally {
      setIsValidatingStripe(false);
    }
  };

  const stripeStatusChip = (status: string) => (
    <AdminStatusChip tone={status === "ok" ? "ok" : "bad"}>{status}</AdminStatusChip>
  );
  const reviewShown = reviewLines.slice(0, 10);
  const hasIssues = promotionRefusals.size > 0 || stripeWarnings.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          {lastSyncedAt ? m.toolbar.synced(lastSyncedAt) : m.toolbar.loadedOnOpen}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing || isSaving}
            className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRefreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {m.toolbar.reload}
          </button>
          <AdminWriteButton
            variant="secondary"
            size="sm"
            writable={canWrite}
            requiredRole="billing:write"
            onClick={validateStripeIds}
            disabled={isValidatingStripe}
          >
            {isValidatingStripe ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            )}
            {m.toolbar.validateStripe}
          </AdminWriteButton>
        </div>
      </div>

      {hasIssues ? (
        <AdminTile
          title={m.validation.title}
          action={
            <AdminStatusChip tone={promotionRefusals.size > 0 ? "bad" : "warn"}>
              {promotionRefusals.size + stripeWarnings.length}
            </AdminStatusChip>
          }
        >
          {promotionRefusals.size > 0 ? (
            <div>
              <p className="text-xs font-bold text-red-300">
                {m.validation.refusalsHeading}
              </p>
              <ul
                data-testid="promotion-policy-refusal-summary"
                className="mt-1 space-y-1 text-xs leading-5 text-red-300"
              >
                {Array.from(promotionRefusals.values()).map((message) => (
                  <li key={message}>- {message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {stripeWarnings.length > 0 ? (
            <div>
              <p className="text-xs font-bold text-amber-300">
                {m.validation.warningsHeading}
              </p>
              <ul className="mt-1 space-y-1 text-xs leading-5 text-amber-300">
                {stripeWarnings.slice(0, 5).map((warning) => (
                  <li key={warning}>- {warning}</li>
                ))}
                {stripeWarnings.length > 5 ? (
                  <li>- {m.validation.plusMore(stripeWarnings.length - 5)}</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </AdminTile>
      ) : null}

      {stripeValidation.length > 0 ? (
        <AdminTile
          title={m.stripeValidation.title}
          description={m.stripeValidation.description}
        >
          <AdminDataTable
            caption={m.stripeValidation.title}
            rows={stripeValidation}
            rowKey={(result) => result.planId}
            cardTitle={(result) => result.name}
            cardMeta={(result) => result.errors[0] || null}
            cardAside={(result) => stripeStatusChip(result.product)}
            columns={[
              {
                key: "plan",
                header: m.stripeValidation.plan,
                render: (result) => (
                  <span className="font-bold text-white">{result.name}</span>
                ),
              },
              {
                key: "product",
                header: m.stripeValidation.product,
                render: (result) => stripeStatusChip(result.product),
              },
              {
                key: "monthly",
                header: m.stripeValidation.monthly,
                render: (result) => stripeStatusChip(result.monthlyPrice),
              },
              {
                key: "annual",
                header: m.stripeValidation.annual,
                render: (result) => stripeStatusChip(result.annualPrice),
              },
              {
                key: "error",
                header: m.stripeValidation.firstError,
                hideOnCard: true,
                render: (result) => (
                  <span className="block max-w-xs truncate text-xs text-red-300">
                    {result.errors[0] || ""}
                  </span>
                ),
              },
            ]}
          />
        </AdminTile>
      ) : null}

      {activeTab === "plans" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {draftPlans.map((plan, index) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              baseline={baselinePlans.find((item) => item.id === plan.id)}
              subscribers={subscribers[plan.id]}
              onChange={(nextPlan) =>
                setDraftPlans((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? nextPlan : item
                  )
                )
              }
            />
          ))}
        </div>
      ) : activeTab === "prices" ? (
        <LocalizedPriceEditor
          catalog={draftPriceCatalog}
          updatedAt={draftPriceCatalogUpdatedAt}
          source={catalogSource}
          onChange={setDraftPriceCatalog}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-white">{m.promotions.title}</h2>
              <p className="mt-0.5 text-sm text-zinc-400">
                {m.promotions.description}
              </p>
            </div>
            <AdminWriteButton
              variant="secondary"
              writable={canWrite}
              requiredRole="billing:write"
              onClick={() =>
                setDraftPromotions((current) => [...current, newPromotion()])
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              {m.promotions.addCode}
            </AdminWriteButton>
          </div>
          {draftPromotions.length === 0 ? (
            <AdminStateBlock
              kind="empty"
              title={m.promotions.emptyTitle}
              detail={m.promotions.emptyDetail}
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {draftPromotions.map((promotion, index) => (
                <PromotionCard
                  key={promotion.id}
                  promotion={promotion}
                  baseline={
                    baselinePromotions.find(
                      (item) => item.id === promotion.id
                    ) || null
                  }
                  refusal={promotionRefusals.get(promotion.id) || null}
                  onDelete={() =>
                    setDraftPromotions((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index)
                    )
                  }
                  onChange={(nextPromotion) =>
                    setDraftPromotions((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? nextPromotion : item
                      )
                    )
                  }
                />
              ))}
            </div>
          )}
          {afterPromotions}
        </div>
      )}

      {dirtyCount > 0 ? (
        <AdminSaveBar
          regionLabel={m.saveBar.region}
          title={m.saveBar.title(dirtyCount)}
          detail={m.saveBar.detail}
          revertLabel={m.saveBar.revert}
          reviewLabel={m.saveBar.review}
          onRevert={revert}
          onReview={requestReview}
          busy={isSaving || isRefreshing}
          writable={canWrite}
          requiredRole="billing:write"
        />
      ) : null}

      <AdminConfirmDialog
        open={reviewOpen}
        title={m.review.title}
        summary={
          <div className="flex flex-col gap-1">
            <p className="font-bold">
              {m.review.summary(dirtyPlanCount, dirtyPriceCount, dirtyPromotionCount)}
            </p>
            <p className="text-xs text-zinc-400">{m.review.liveNote}</p>
            {hasIssues ? (
              <p className="text-xs text-amber-300">
                {m.review.warningsNote(
                  promotionRefusals.size + stripeWarnings.length
                )}
              </p>
            ) : null}
          </div>
        }
        effects={[
          ...reviewShown,
          ...(reviewLines.length > reviewShown.length
            ? [m.review.more(reviewLines.length - reviewShown.length)]
            : []),
        ]}
        confirmLabel={m.review.confirm}
        busy={isSaving}
        onConfirm={() => {
          void save();
        }}
        onClose={() => setReviewOpen(false)}
      />
    </div>
  );
}
