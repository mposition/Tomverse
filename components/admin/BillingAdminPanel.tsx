"use client";

import { useState } from "react";
import { CreditCard, Loader2, Plus, Save, TicketPercent, Trash2 } from "lucide-react";
import type {
  BillingPlanConfig,
  BillingPromotionConfig,
} from "@/lib/billingConfig";
import { dispatchAppToast } from "@/lib/appToast";

type Props = {
  plans: BillingPlanConfig[];
  promotions: BillingPromotionConfig[];
};

type EditablePlan = BillingPlanConfig;
type EditablePromotion = BillingPromotionConfig;

const dollars = (cents: number) => (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);

const toCents = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0;
};

const toDateInputValue = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const fromDateInputValue = (value: string) =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

const newPromotion = (): EditablePromotion => ({
  id: `promo_${Date.now()}`,
  code: "NEWCODE",
  discountPercent: 10,
  discountAmountCents: null,
  maxRedemptions: null,
  redeemedCount: 0,
  durationMonths: 1,
  appliesToPlanIds: ["pro", "max"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
});

function PlanEditor({
  plan,
  onChange,
}: {
  plan: EditablePlan;
  onChange: (plan: EditablePlan) => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
          <p className="text-xs text-zinc-500">{plan.id} / {plan.tier}</p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          Active
          <input
            type="checkbox"
            checked={plan.isActive}
            onChange={(event) => onChange({ ...plan, isActive: event.target.checked })}
            className="h-4 w-4 accent-blue-500"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-zinc-400">
          Monthly price USD
          <input
            type="number"
            min="0"
            step="0.01"
            value={dollars(plan.monthlyPriceCents)}
            onChange={(event) =>
              onChange({ ...plan, monthlyPriceCents: toCents(event.target.value) })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Annual price USD
          <input
            type="number"
            min="0"
            step="0.01"
            value={dollars(plan.annualPriceCents)}
            onChange={(event) =>
              onChange({ ...plan, annualPriceCents: toCents(event.target.value) })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Max compared models
          <input
            type="number"
            min="1"
            max="10"
            value={plan.maxModels}
            onChange={(event) =>
              onChange({ ...plan, maxModels: Number(event.target.value) || 1 })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Daily messages (0 = unlimited)
          <input
            type="number"
            min="0"
            value={plan.dailyMessageLimit}
            onChange={(event) =>
              onChange({ ...plan, dailyMessageLimit: Number(event.target.value) || 0 })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Monthly messages
          <input
            type="number"
            min="0"
            value={plan.monthlyMessageLimit}
            onChange={(event) =>
              onChange({ ...plan, monthlyMessageLimit: Number(event.target.value) || 0 })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-3">
        <label className="text-xs font-semibold text-zinc-400">
          Stripe Product ID
          <input
            value={plan.stripeProductId || ""}
            onChange={(event) => onChange({ ...plan, stripeProductId: event.target.value || null })}
            placeholder="prod_..."
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Stripe Monthly Price ID
          <input
            value={plan.stripePriceId || ""}
            onChange={(event) => onChange({ ...plan, stripePriceId: event.target.value || null })}
            placeholder="price_..."
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Stripe Annual Price ID
          <input
            value={plan.stripeAnnualPriceId || ""}
            onChange={(event) => onChange({ ...plan, stripeAnnualPriceId: event.target.value || null })}
            placeholder="price_..."
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs font-semibold text-zinc-300">
        {[
          ["allowAttachments", "Attachments"],
          ["allowSharing", "Sharing"],
          ["allowDownloads", "Downloads"],
        ].map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2">
            <input
              type="checkbox"
              checked={Boolean(plan[key as keyof EditablePlan])}
              onChange={(event) =>
                onChange({ ...plan, [key]: event.target.checked })
              }
              className="h-4 w-4 accent-blue-500"
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}

function PromotionEditor({
  promotion,
  onChange,
  onDelete,
}: {
  promotion: EditablePromotion;
  onChange: (promotion: EditablePromotion) => void;
  onDelete: () => void;
}) {
  const amountDollars =
    promotion.discountAmountCents === null ||
    promotion.discountAmountCents === undefined
      ? ""
      : dollars(promotion.discountAmountCents);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">{promotion.code}</h3>
          <p className="text-xs text-zinc-500">
            Redeemed {promotion.redeemedCount || 0}
            {promotion.maxRedemptions ? ` / ${promotion.maxRedemptions}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            Active
            <input
              type="checkbox"
              checked={promotion.isActive}
              onChange={(event) => onChange({ ...promotion, isActive: event.target.checked })}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-red-500/30 p-2 text-red-300 hover:bg-red-500/10"
            aria-label="Delete promotion"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-semibold text-zinc-400">
          Code
          <input
            value={promotion.code}
            onChange={(event) => onChange({ ...promotion, code: event.target.value.toUpperCase() })}
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Discount %
          <input
            type="number"
            min="0"
            max="100"
            value={promotion.discountPercent}
            onChange={(event) => onChange({ ...promotion, discountPercent: Number(event.target.value) || 0 })}
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Fixed discount USD
          <input
            type="number"
            min="0"
            step="0.01"
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
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="text-xs font-semibold text-zinc-400">
          Duration months
          <input
            type="number"
            min="1"
            max="36"
            value={promotion.durationMonths}
            onChange={(event) => onChange({ ...promotion, durationMonths: Number(event.target.value) || 1 })}
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Max redeems
          <input
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
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Starts
          <input
            type="date"
            value={toDateInputValue(promotion.startsAt)}
            onChange={(event) =>
              onChange({ ...promotion, startsAt: fromDateInputValue(event.target.value) })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Ends
          <input
            type="date"
            value={toDateInputValue(promotion.endsAt)}
            onChange={(event) =>
              onChange({ ...promotion, endsAt: fromDateInputValue(event.target.value) })
            }
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-xs font-semibold text-zinc-300">
        {(["pro", "max"] as const).map((planId) => (
          <label key={planId} className="flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 uppercase">
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
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-zinc-400">
          Stripe Coupon ID
          <input
            value={promotion.stripeCouponId || ""}
            onChange={(event) => onChange({ ...promotion, stripeCouponId: event.target.value || null })}
            placeholder="coupon_..."
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
        <label className="text-xs font-semibold text-zinc-400">
          Stripe Promotion Code ID
          <input
            value={promotion.stripePromotionCodeId || ""}
            onChange={(event) => onChange({ ...promotion, stripePromotionCodeId: event.target.value || null })}
            placeholder="promo_..."
            className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          />
        </label>
      </div>
    </div>
  );
}

export function BillingAdminPanel({ plans, promotions }: Props) {
  const [draftPlans, setDraftPlans] = useState<EditablePlan[]>(plans);
  const [draftPromotions, setDraftPromotions] = useState<EditablePromotion[]>(promotions);
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plans: draftPlans,
          promotions: draftPromotions,
        }),
      });
      if (!response.ok) throw new Error("Billing save failed");
      const data = (await response.json()) as Props;
      setDraftPlans(data.plans);
      setDraftPromotions(data.promotions);
      dispatchAppToast("Billing settings saved.", "success");
    } catch {
      dispatchAppToast("Failed to save billing settings.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
            <CreditCard className="h-3.5 w-3.5" />
            Stripe billing
          </div>
          <h2 className="mt-3 text-xl font-semibold text-white">Plans, prices, and promotions</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Store public pricing and Stripe IDs in DB. Checkout uses Stripe Price IDs, and webhooks update user plans.
          </p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save billing
        </button>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        {draftPlans.map((plan, index) => (
          <PlanEditor
            key={plan.id}
            plan={plan}
            onChange={(nextPlan) =>
              setDraftPlans((current) =>
                current.map((item, itemIndex) => (itemIndex === index ? nextPlan : item))
              )
            }
          />
        ))}
      </div>

      <div className="mt-5">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <TicketPercent className="h-4 w-4 text-blue-300" />
            Promotion codes
          </div>
          <button
            type="button"
            onClick={() => setDraftPromotions((current) => [...current, newPromotion()])}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900"
          >
            <Plus className="h-4 w-4" />
            Add code
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {draftPromotions.map((promotion, index) => (
            <PromotionEditor
              key={promotion.id}
              promotion={promotion}
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
      </div>
    </section>
  );
}
