"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  TicketPercent,
  Trash2,
  WalletCards,
} from "lucide-react";
import type {
  BillingPlanConfig,
  BillingPromotionConfig,
} from "@/lib/billingConfig";
import { dispatchAppToast } from "@/lib/appToast";

type BillingConfigPayload = {
  plans: BillingPlanConfig[];
  promotions: BillingPromotionConfig[];
};

type Props = BillingConfigPayload & {
  paidUserCount: number;
  activeSubscriptionCount: number;
};

type EditablePlan = BillingPlanConfig;
type EditablePromotion = BillingPromotionConfig;
type AdminBillingResponse = BillingConfigPayload & {
  error?: string;
};

const PLAN_ACCENTS: Record<EditablePlan["id"], string> = {
  free: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/30",
  pro: "from-blue-500/20 to-blue-500/5 border-blue-500/30",
  max: "from-purple-500/20 to-purple-500/5 border-purple-500/30",
};

const dollars = (cents: number) =>
  (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);

const money = (cents: number) => `$${dollars(cents)}`;

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

const statusPill = (active: boolean) =>
  active
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-zinc-700 bg-zinc-900 text-zinc-400";

const newPromotion = (): EditablePromotion => ({
  id: `promo_${Date.now()}`,
  code: "NEWCODE",
  discountPercent: 10,
  discountAmountCents: null,
  maxRedemptions: 100,
  redeemedCount: 0,
  durationMonths: 1,
  appliesToPlanIds: ["pro", "max"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  allowAnnualStacking: false,
  isActive: true,
});

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
      className={`w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 ${props.className || ""}`}
    />
  );
}

function PlanEditor({
  plan,
  onChange,
}: {
  plan: EditablePlan;
  onChange: (plan: EditablePlan) => void;
}) {
  const hasStripeIds = Boolean(plan.stripeProductId && plan.stripePriceId);
  const annualSavings = plan.monthlyPriceCents > 0
    ? Math.max(0, 100 - Math.round((plan.annualPriceCents / (plan.monthlyPriceCents * 12)) * 100))
    : 0;

  return (
    <article className={`rounded-3xl border bg-gradient-to-br p-5 ${PLAN_ACCENTS[plan.id]}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-black text-white">{plan.name}</h3>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusPill(plan.isActive)}`}>
              {plan.isActive ? "Active" : "Hidden"}
            </span>
          </div>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
            {plan.id} / {plan.tier}
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs font-semibold text-zinc-300">
          Active
          <input
            type="checkbox"
            checked={plan.isActive}
            onChange={(event) => onChange({ ...plan, isActive: event.target.checked })}
            className="h-4 w-4 accent-blue-500"
          />
        </label>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
          <p className="text-xs font-semibold text-zinc-500">Monthly</p>
          <p className="mt-1 text-lg font-black text-white">{money(plan.monthlyPriceCents)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
          <p className="text-xs font-semibold text-zinc-500">Annual</p>
          <p className="mt-1 text-lg font-black text-white">{money(plan.annualPriceCents)}</p>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
          <p className="text-xs font-semibold text-zinc-500">Annual save</p>
          <p className="mt-1 text-lg font-black text-white">{annualSavings}%</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Field label="Monthly price USD">
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
        <Field label="Annual price USD">
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
        <Field label="Daily AI response credits (0 = no daily guardrail)">
          <TextInput
            type="number"
            min="0"
            value={plan.dailyMessageLimit}
            onChange={(event) =>
              onChange({ ...plan, dailyMessageLimit: Number(event.target.value) || 0 })
            }
          />
        </Field>
        <Field label="Monthly AI response credits">
          <TextInput
            type="number"
            min="0"
            value={plan.monthlyMessageLimit}
            onChange={(event) =>
              onChange({ ...plan, monthlyMessageLimit: Number(event.target.value) || 0 })
            }
          />
        </Field>
        <Field label="Max compared models">
          <TextInput
            type="number"
            min="1"
            max="10"
            value={plan.maxModels}
            onChange={(event) =>
              onChange({ ...plan, maxModels: Number(event.target.value) || 1 })
            }
          />
        </Field>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
          <p className="text-xs font-semibold text-zinc-500">Stripe status</p>
          <p className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${statusPill(hasStripeIds)}`}>
            {hasStripeIds ? "Linked" : "Price ID needed"}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        <Field label="Stripe Product ID">
          <TextInput
            value={plan.stripeProductId || ""}
            onChange={(event) =>
              onChange({ ...plan, stripeProductId: event.target.value || null })
            }
            placeholder="prod_..."
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stripe Monthly Price ID">
            <TextInput
              value={plan.stripePriceId || ""}
              onChange={(event) =>
                onChange({ ...plan, stripePriceId: event.target.value || null })
              }
              placeholder="price_..."
            />
          </Field>
          <Field label="Stripe Annual Price ID">
            <TextInput
              value={plan.stripeAnnualPriceId || ""}
              onChange={(event) =>
                onChange({ ...plan, stripeAnnualPriceId: event.target.value || null })
              }
              placeholder="price_..."
            />
          </Field>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {[
          ["allowAttachments", "Attachments"],
          ["allowSharing", "Sharing"],
          ["allowDownloads", "Downloads"],
        ].map(([key, label]) => (
          <label
            key={key}
            className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs font-semibold text-zinc-300"
          >
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
    </article>
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
  const remaining = promotion.maxRedemptions
    ? Math.max(0, promotion.maxRedemptions - (promotion.redeemedCount || 0))
    : null;

  return (
    <article className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-black text-white">{promotion.code}</h3>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusPill(promotion.isActive)}`}>
              {promotion.isActive ? "Active" : "Paused"}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Redeemed {promotion.redeemedCount || 0}
            {promotion.maxRedemptions ? ` / ${promotion.maxRedemptions}` : ""}
            {remaining !== null ? `, ${remaining} left` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-300">
            Active
            <input
              type="checkbox"
              checked={promotion.isActive}
              onChange={(event) =>
                onChange({ ...promotion, isActive: event.target.checked })
              }
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-xl border border-red-500/30 p-2 text-red-300 hover:bg-red-500/10"
            aria-label="Delete promotion"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <Field label="Code">
          <TextInput
            value={promotion.code}
            onChange={(event) =>
              onChange({ ...promotion, code: event.target.value.toUpperCase() })
            }
          />
        </Field>
        <Field label="Discount percent">
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
        <Field label="Fixed discount USD">
          <TextInput
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
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Field label="Duration months">
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
        <Field label="Max redemptions">
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
        <Field label="Starts">
          <TextInput
            type="date"
            value={toDateInputValue(promotion.startsAt)}
            onChange={(event) =>
              onChange({ ...promotion, startsAt: fromDateInputValue(event.target.value) })
            }
          />
        </Field>
        <Field label="Ends">
          <TextInput
            type="date"
            value={toDateInputValue(promotion.endsAt)}
            onChange={(event) =>
              onChange({ ...promotion, endsAt: fromDateInputValue(event.target.value) })
            }
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["pro", "max"] as const).map((planId) => (
          <label
            key={planId}
            className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold uppercase text-zinc-300"
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
        <label className="flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-100">
          <input
            type="checkbox"
            checked={promotion.allowAnnualStacking}
            onChange={(event) =>
              onChange({
                ...promotion,
                allowAnnualStacking: event.target.checked,
              })
            }
            className="h-4 w-4 accent-amber-500"
          />
          Allow stacking with annual discount
        </label>
      </div>
      <p className="mt-2 text-xs leading-5 text-zinc-500">
        Annual stacking is denied by default and must be explicitly enabled for
        this code. Active codes always require both a redemption cap and an end
        date.
      </p>

      <details className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <summary className="cursor-pointer text-sm font-bold text-zinc-200">
          Stripe coupon linkage
        </summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="Stripe Coupon ID">
            <TextInput
              value={promotion.stripeCouponId || ""}
              onChange={(event) =>
                onChange({ ...promotion, stripeCouponId: event.target.value || null })
              }
              placeholder="coupon_..."
            />
          </Field>
          <Field label="Stripe Promotion Code ID">
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
      </details>
    </article>
  );
}

export function BillingAdminPanel({
  plans,
  promotions,
  paidUserCount,
  activeSubscriptionCount,
}: Props) {
  const [draftPlans, setDraftPlans] = useState<EditablePlan[]>(plans);
  const [draftPromotions, setDraftPromotions] =
    useState<EditablePromotion[]>(promotions);
  const [baselinePlans, setBaselinePlans] = useState<EditablePlan[]>(plans);
  const [baselinePromotions, setBaselinePromotions] =
    useState<EditablePromotion[]>(promotions);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isValidatingStripe, setIsValidatingStripe] = useState(false);
  const [showSaveReview, setShowSaveReview] = useState(false);
  const [activeTab, setActiveTab] = useState<"plans" | "promotions">("plans");
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
  const stripeWarnings = useMemo(() => {
    const warnings: string[] = [];
    draftPlans
      .filter((plan) => plan.id !== "free")
      .forEach((plan) => {
        if (!plan.stripeProductId?.startsWith("prod_")) {
          warnings.push(`${plan.name}: Stripe product ID should start with prod_.`);
        }
        if (!plan.stripePriceId?.startsWith("price_")) {
          warnings.push(`${plan.name}: monthly Stripe price ID should start with price_.`);
        }
        if (!plan.stripeAnnualPriceId?.startsWith("price_")) {
          warnings.push(`${plan.name}: annual Stripe price ID should start with price_.`);
        }
      });
    draftPromotions.forEach((promotion) => {
      if (promotion.discountPercent > 100) {
        warnings.push(`${promotion.code}: discount percent cannot exceed 100%.`);
      }
      if (promotion.appliesToPlanIds.length === 0) {
        warnings.push(`${promotion.code}: choose at least one eligible plan.`);
      }
      if (
        promotion.isActive &&
        (!promotion.maxRedemptions || !promotion.endsAt)
      ) {
        warnings.push(
          `${promotion.code}: active codes require max redemptions and an end date.`
        );
      }
      if (
        promotion.startsAt &&
        promotion.endsAt &&
        new Date(promotion.startsAt) >= new Date(promotion.endsAt)
      ) {
        warnings.push(`${promotion.code}: end date must be after start date.`);
      }
      if (
        promotion.stripeCouponId &&
        !promotion.stripeCouponId.startsWith("coupon_")
      ) {
        warnings.push(`${promotion.code}: Stripe coupon ID should start with coupon_.`);
      }
      if (
        promotion.stripePromotionCodeId &&
        !promotion.stripePromotionCodeId.startsWith("promo_")
      ) {
        warnings.push(`${promotion.code}: Stripe promotion code ID should start with promo_.`);
      }
    });
    return warnings;
  }, [draftPlans, draftPromotions]);

  const totals = useMemo(() => {
    const paidPlans = draftPlans.filter((plan) => plan.id !== "free");
    const activePromotions = draftPromotions.filter((promotion) => promotion.isActive);
    return {
      paidPlanTypeCount: paidPlans.length,
      linkedPlanCount: paidPlans.filter(
        (plan) => plan.stripePriceId || plan.stripeAnnualPriceId
      ).length,
      activePromotionCount: activePromotions.length,
      monthlyRevenueSample: paidPlans.reduce(
        (sum, plan) => sum + plan.monthlyPriceCents,
        0
      ),
    };
  }, [draftPlans, draftPromotions]);

  const applyResponse = (data: BillingConfigPayload) => {
    setDraftPlans(data.plans);
    setDraftPromotions(data.promotions);
    setBaselinePlans(data.plans);
    setBaselinePromotions(data.promotions);
    setLastSyncedAt(new Date().toLocaleTimeString());
  };

  const refresh = async () => {
    if (isRefreshing || isSaving) return;
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/admin/billing", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as AdminBillingResponse | null;
      if (!response.ok || !data?.plans || !data?.promotions) {
        throw new Error(data?.error || "Billing refresh failed");
      }
      applyResponse(data);
      dispatchAppToast("Billing settings loaded from DB.", "success");
    } catch {
      dispatchAppToast("Failed to load billing settings from DB.", "error");
    } finally {
      setIsRefreshing(false);
    }
  };

  const save = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setShowSaveReview(false);
    try {
      const response = await fetch("/api/admin/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plans: draftPlans,
          promotions: draftPromotions,
        }),
      });
      const data = (await response.json().catch(() => null)) as AdminBillingResponse | null;
      if (!response.ok || !data?.plans || !data?.promotions) {
        throw new Error(data?.error || "Billing save failed");
      }
      applyResponse(data);
      dispatchAppToast("Billing settings saved to DB.", "success");
    } catch {
      dispatchAppToast("Failed to save billing settings.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  const requestSave = () => {
    if (dirtyPlanCount + dirtyPromotionCount > 0 && !showSaveReview) {
      setShowSaveReview(true);
      return;
    }
    save();
  };

  const validateStripeIds = async () => {
    if (isValidatingStripe) return;
    setIsValidatingStripe(true);
    try {
      const response = await fetch("/api/admin/stripe/validate", {
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
        throw new Error(data?.error || "Stripe validation failed.");
      }
      setStripeValidation(data.results);
      const failed = data.results.some((result) =>
        [result.product, result.monthlyPrice, result.annualPrice].some(
          (status) => status !== "ok"
        )
      );
      dispatchAppToast(
        failed ? "Stripe validation found issues." : "Stripe IDs validated.",
        failed ? "error" : "success"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Stripe validation failed.",
        "error"
      );
    } finally {
      setIsValidatingStripe(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20">
      <div className="border-b border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
              <CreditCard className="h-3.5 w-3.5" />
              Billing control center
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">
              Plans, Stripe IDs, and promotion codes
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              These values are loaded from the production database and saved back through
              the admin API. Stripe checkout reads the same records for monthly,
              annual, and zero-dollar promotional upgrades.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={isRefreshing || isSaving}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Reload DB
            </button>
            <button
              type="button"
              onClick={requestSave}
              disabled={isSaving || isRefreshing}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save to DB
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Paid users</p>
            <p className="mt-2 text-2xl font-black text-white">{paidUserCount}</p>
            <p className="mt-1 text-xs font-semibold text-zinc-500">
              Active Stripe: {activeSubscriptionCount}
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Stripe linked</p>
            <p className="mt-2 text-2xl font-black text-white">
              {totals.linkedPlanCount}/{totals.paidPlanTypeCount}
            </p>
            <p className="mt-1 text-xs font-semibold text-zinc-500">
              Paid plan types
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Active promos</p>
            <p className="mt-2 text-2xl font-black text-white">{totals.activePromotionCount}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">DB sync</p>
            <p className="mt-2 flex items-center gap-2 text-sm font-bold text-emerald-300">
              <Database className="h-4 w-4" />
              {lastSyncedAt ? `Synced ${lastSyncedAt}` : "Loaded on page open"}
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-200/80">
              Unsaved changes
            </p>
            <p className="mt-2 text-sm font-bold text-blue-100">
              {dirtyPlanCount} plan change{dirtyPlanCount === 1 ? "" : "s"} ·{" "}
              {dirtyPromotionCount} promotion change{dirtyPromotionCount === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-xs leading-5 text-blue-100/70">
              Review this preview before saving. Checkout uses these DB records immediately after publish.
            </p>
          </div>
          <div className={`rounded-2xl border p-4 ${
            stripeWarnings.length > 0
              ? "border-amber-500/30 bg-amber-500/10"
              : "border-emerald-500/20 bg-emerald-500/10"
          }`}>
            <p className={`text-xs font-black uppercase tracking-[0.16em] ${
              stripeWarnings.length > 0 ? "text-amber-200/80" : "text-emerald-200/80"
            }`}>
              Pre-save validation
            </p>
            {stripeWarnings.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100">
                {stripeWarnings.slice(0, 5).map((warning) => (
                  <li key={warning}>- {warning}</li>
                ))}
                {stripeWarnings.length > 5 ? <li>- Plus {stripeWarnings.length - 5} more.</li> : null}
              </ul>
            ) : (
              <p className="mt-2 text-sm font-bold text-emerald-100">
                Stripe ID formats and promotion rules look ready.
              </p>
            )}
          </div>
        </div>
        {showSaveReview ? (
          <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                <div>
                  <p className="text-sm font-black text-amber-100">
                    Review before publishing billing changes
                  </p>
                  <p className="mt-1 text-xs leading-5 text-amber-100/80">
                    Checkout uses these values immediately. Confirm that plan limits,
                    promotion windows, redemption caps, and Stripe IDs are correct.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setShowSaveReview(false)}
                  className="cursor-pointer rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={isSaving}
                  className="cursor-pointer rounded-xl bg-amber-500 px-3 py-2 text-xs font-black text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Publish changes
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
        <div className="inline-flex rounded-2xl border border-zinc-800 bg-zinc-900 p-1">
          {[
            ["plans", "Plans", WalletCards],
            ["promotions", "Promotions", TicketPercent],
          ].map(([value, label, Icon]) => {
            const active = activeTab === value;
            const TypedIcon = Icon as typeof WalletCards;
            return (
              <button
                key={value as string}
                type="button"
                onClick={() => setActiveTab(value as "plans" | "promotions")}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition ${
                  active
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-950/30"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <TypedIcon className="h-4 w-4" />
                {label as string}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected to BillingPlan / BillingPromotion
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing || isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Reload
          </button>
          <button
            type="button"
            onClick={validateStripeIds}
            disabled={isValidatingStripe}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-2 text-xs font-black text-purple-100 hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isValidatingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
            Validate Stripe
          </button>
          <button
            type="button"
            onClick={requestSave}
            disabled={isSaving || isRefreshing}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save changes
          </button>
        </div>
      </div>

      {stripeValidation.length > 0 ? (
        <div className="border-b border-zinc-800 px-5 py-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              Stripe validation
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {stripeValidation.map((result) => (
                <div key={result.planId} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                  <div className="font-black text-white">{result.name}</div>
                  <div className="mt-1 text-zinc-400">
                    Product {result.product} · Monthly {result.monthlyPrice} · Annual {result.annualPrice}
                  </div>
                  {result.errors.length > 0 ? (
                    <div className="mt-1 truncate text-red-300">{result.errors[0]}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="p-5">
        {activeTab === "plans" ? (
          <div className="grid gap-5 xl:grid-cols-3">
            {draftPlans.map((plan, index) => (
              <PlanEditor
                key={plan.id}
                plan={plan}
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
        ) : (
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-black text-white">Promotion codes</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Active codes require a redemption cap and end date. Annual
                  discount stacking is denied unless explicitly enabled per code.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setDraftPromotions((current) => [...current, newPromotion()])
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900"
                >
                  <Plus className="h-4 w-4" />
                  Add code
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={isSaving || isRefreshing}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save to DB
                </button>
              </div>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
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
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-zinc-800 bg-zinc-900/60 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-white">Ready to publish billing changes?</p>
          <p className="mt-1 text-xs text-zinc-400">
            Plan prices, Stripe IDs, and promotion rules are applied after saving to DB.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing || isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reload DB
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isSaving || isRefreshing}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save to DB
          </button>
        </div>
      </div>
    </section>
  );
}
