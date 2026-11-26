import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Language } from "../../../../lib/language";
import { en } from "../../../../locales/en";
import { ko } from "../../../../locales/ko";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import { fr } from "../../../../locales/fr";
import { de } from "../../../../locales/de";
import { es } from "../../../../locales/es";
import { pt } from "../../../../locales/pt";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopBillingCopy, fillBillingCopy } from "../../../../locales/desktopBilling";
import { billingErrorMessage, purchaseCtaCopy } from "../../../../components/billing/purchaseCopy";
import { normalizePlanChangeErrorCode, planChangeNeedsSupport, planChangeText, type PlanChangeCopyErrorCode } from "../../../../components/billing/planChangeCopy";
import {
  calculateDiscountedDisplayMinor, checkoutCopy, checkoutLegalCopy, creditPackCopy, creditUnit, foundingTesterPassCopy,
  promotionAppliesToCurrency, promotionPolicyCopy,
} from "../../../../components/billing/checkoutCopy";
import { classifyBillingError, resolvePlanCtaState } from "../../../../lib/purchaseIntent";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../../lib/checkoutPlanEligibilityCore";
import { formatBillingMinor, normalizeBillingCurrency } from "../../../../lib/billingMarkets";
import {
  purchaseItem,
  type BillingAction, type BillingConfig, type BillingPromotion, type BillingResult, type BillingState, type BillingUsage, type BillingValue,
  type DesktopBillingInput, type PlanChangeQuote, type PlanChangeReservation, type PurchaseIntent, type PurchaseItem, type PurchaseRecord,
} from "../billing-contract";
import { openDocs } from "./WebViewer";
import "./billing.css";

const dictionaries = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };
type Interval = "monthly" | "annual";
type ReadAction = "usage" | "config" | "creditPacks" | "planChange" | "refundStatus";

const billing = <Action extends BillingAction>(input: Extract<DesktopBillingInput, { action: Action }>) =>
  window.desktop.billing<Action>(input);

function useBillingEnabled() {
  const [enabled, setEnabled] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void window.desktop.state().then(snapshot => { if (live) setEnabled(snapshot.capabilities?.billing === true); }, () => {
      if (live) setEnabled(false);
    });
    const stop = window.desktop.subscribe(snapshot => setEnabled(snapshot.capabilities?.billing === true));
    return () => { live = false; stop(); };
  }, []);
  return enabled;
}

/**
 * The checkout window and the account's purchase records as the main process holds them. The
 * screen subscribes, then asks once for the current state, and keeps whichever is newer: a Plan
 * tab that mounts while a purchase is open or unconfirmed shows it as it is.
 */
function useBillingState() {
  const [state, setState] = useState<BillingState>({ version: -1, window: null, purchases: [] });
  useEffect(() => {
    let live = true;
    const apply = (next: BillingState) => { if (live) setState(current => next.version >= current.version ? next : current); };
    const stop = window.desktop.subscribeBilling(apply);
    void billing<"purchases">({ action: "purchases" }).then(result => { if (result.ok) apply(result.value); }, () => {});
    return () => { live = false; stop(); };
  }, []);
  return state;
}

function useBillingRead<Action extends ReadAction>(action: Action) {
  const [data, setData] = useState<BillingValue<Action>>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void billing<Action>({ action } as Extract<DesktopBillingInput, { action: Action }>).then(result => {
      if (!live) return;
      setFailed(!result.ok);
      if (result.ok) setData(result.value);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [action, attempt]);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { data, failed, reload, setData };
}

function Row({ label, children, description }: { label: ReactNode; children?: ReactNode; description?: ReactNode }) {
  return <div className="execution-setting-row account-setting-row">
    <div>{label}{description && <small>{description}</small>}</div>
    <div className="account-setting-control">{children}</div>
  </div>;
}

function ReadFailure({ language, retry }: { language: Language; retry(): void }) {
  return <div className="desktop-settings-feedback">
    <p role="alert">{desktopShellCopy[language].actionFailed}</p>
    <button type="button" className="soft" onClick={retry}>{desktopControlsCopy[language].retrySettings}</button>
  </div>;
}

const formatDate = (value: string | null | undefined, language: Language, utc = false) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(language, {
    year: "numeric", month: "long", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}),
  }).format(date);
};

const formatMinor = (amountMinor: number, currency: string) => {
  const normalized = normalizeBillingCurrency(currency);
  return normalized ? formatBillingMinor(amountMinor, normalized) : String(amountMinor);
};

/** A fixed USD discount, written as the web dialog writes it. */
const formatUsdCents = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, minimumFractionDigits: 0,
}).format(cents / 100);

/** The plan-change copy code for a failed request; anything unrecognised reads as a provider error. */
const planChangeErrorCode = (result: Extract<BillingResult<BillingAction>, { ok: false }>): PlanChangeCopyErrorCode =>
  result.code === "NETWORK_ERROR" ? "NETWORK_ERROR" : result.status === 401 ? "AUTHENTICATION_REQUIRED"
    : normalizePlanChangeErrorCode(result.code);

const tierOf = (planId: "pro" | "max") => planId === "max" ? "Max" : "Pro";

/** The message for a failed purchase request: Desktop's own codes first, then the web's purchase copy. */
function purchaseFailure(result: Extract<BillingResult<BillingAction>, { ok: false }>, language: Language) {
  const desk = desktopBillingCopy(language);
  if (result.code === "CHECKOUT_URL_REJECTED") return desk.urlRejected;
  if (result.code === "CHECKOUT_WINDOW_OPEN") return desk.windowBusy;
  return billingErrorMessage(classifyBillingError({
    status: result.status || null, code: result.code, wasAuthenticated: true, networkFailure: result.code === "NETWORK_ERROR",
  }), language);
}

/** A checkout request; sent again with the main process's hold when the customer repeats it. */
type StartRun = (repeatHold?: string) => Promise<BillingResult<"checkout"> | BillingResult<"buyCreditPack">>;
/** The main process held a new checkout of `item` back: it waits for the customer's choice in the warning. */
type Repeat = { item: PurchaseItem; hold: string; intent: PurchaseIntent; run: StartRun };

/**
 * The Plan tab with in-app purchases. Off (the server's `desktopBilling` capability),
 * it renders the existing balance-only view it is given.
 */
export function BillingSettings({ language, fallback }: { language: Language; fallback: ReactNode }) {
  const enabled = useBillingEnabled();
  if (enabled === undefined) return <p role="status">{dictionaries[language].auth.loading}</p>;
  return enabled ? <BillingPlan language={language} /> : <>{fallback}</>;
}

function BillingPlan({ language }: { language: Language }) {
  const usage = useBillingRead("usage");
  const config = useBillingRead("config");
  const packs = useBillingRead("creditPacks");
  const planChange = useBillingRead("planChange");
  const refund = useBillingRead("refundStatus");
  const [view, setView] = useState<{ kind: "overview" } | { kind: "checkout"; planId: "pro" | "max" } |
    { kind: "change"; tier: "Pro" | "Max"; interval: Interval }>({ kind: "overview" });
  const [cycle, setCycle] = useState<Interval>("monthly");
  // The window and the purchase records are the main process's; this screen only draws them.
  const billingState = useBillingState();
  const windowState = billingState.window;
  const [repeat, setRepeat] = useState<Repeat>();
  const [pass, setPass] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [starting, setStarting] = useState(false);
  const auth = dictionaries[language].auth;
  const desk = desktopBillingCopy(language);
  const purchase = purchaseCtaCopy[language];

  const { reload: reloadUsage } = usage;
  const { reload: reloadConfig } = config;
  const { reload: reloadPacks } = packs;
  const { reload: reloadPlanChange } = planChange;
  const { reload: reloadRefund } = refund;
  const refreshAccount = useCallback(() => {
    reloadUsage(); reloadConfig(); reloadPacks(); reloadPlanChange(); reloadRefund();
  }, [reloadUsage, reloadConfig, reloadPacks, reloadPlanChange, reloadRefund]);

  // A purchase the account now shows changes the plan and balances on this screen.
  const seenConfirmed = useRef(new Set<string>());
  useEffect(() => {
    const fresh = billingState.purchases.filter(record => record.stage === "confirmed" && !seenConfirmed.current.has(record.id));
    for (const record of fresh) seenConfirmed.current.add(record.id);
    if (fresh.length) queueMicrotask(refreshAccount);
  }, [billingState.purchases, refreshAccount]);

  const labelOf = (intent: PurchaseIntent) => intent.kind === "subscription"
    ? config.data?.plans.find(plan => plan.id === intent.planId)?.name ?? tierOf(intent.planId)
    : packs.data?.packs.find(pack => pack.id === intent.packId)?.name ?? intent.packId;

  const start = async (intent: PurchaseIntent, run: StartRun, repeatHold?: string) => {
    if (starting) return;
    setStarting(true);
    setFailure(undefined);
    setRepeat(undefined);
    setPass(false);
    try {
      const result = await run(repeatHold);
      if (!result.ok) return setFailure(purchaseFailure(result, language));
      setView({ kind: "overview" });
      if (result.value.kind === "pass") {
        setPass(true);
        return refreshAccount();
      }
      // The main process read the account again and still does not see the earlier payment of this item:
      // no checkout was created, and a new one opens only from the customer's choice in the warning.
      if (result.value.kind === "held") setRepeat({ item: purchaseItem(intent), hold: result.value.hold, intent, run });
    } catch {
      setFailure(desktopShellCopy[language].actionFailed);
    } finally {
      setStarting(false);
    }
  };

  if (!usage.data) {
    return usage.failed ? <ReadFailure language={language} retry={usage.reload} /> : <p role="status">{auth.loading}</p>;
  }
  const account = usage.data;
  const activeSubscription = typeof account.subscription.status === "string" &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(account.subscription.status);
  // No new checkout starts while the window is open; a repeat of an unconfirmed item is held back by the main process.
  const purchaseBusy = windowState !== null;
  const withHold = <Input extends object>(input: Input, repeatHold?: string) => repeatHold ? { ...input, repeatHold } : input;

  if (view.kind === "checkout" && config.data) {
    return <Checkout language={language} planId={view.planId} config={config.data} interval={cycle} onCycle={setCycle}
      busy={starting} failure={failure} onBack={() => { setFailure(undefined); setView({ kind: "overview" }); }}
      onStart={input => void start({ kind: "subscription", planId: input.planId },
        repeatHold => billing<"checkout">(withHold(input, repeatHold)))} />;
  }
  if (view.kind === "change") {
    return <PlanChange language={language} tier={view.tier} interval={view.interval}
      onBack={() => setView({ kind: "overview" })} onSettled={refreshAccount} />;
  }

  const format = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(language).format(value);
  const planName = account.plan === "Max" ? auth.maxPlan : account.plan === "Pro" ? auth.proPlan : auth.freePlan;
  const sidebar = dictionaries[language].sidebar;
  const planDescription = account.plan === "Max" ? sidebar.maxPlanDescription
    : account.plan === "Pro" ? sidebar.proPlanDescription : sidebar.freePlanDescription;
  const periodEnd = formatDate(account.subscription.currentPeriodEnd, language);
  const billingCopy = dictionaries[language].billing;
  const reservation = planChange.data?.reservation ?? null;
  const changeText = planChangeText(language);

  return <div data-testid="native-account-plan" data-billing="enabled">
    <CheckoutStatus language={language} windowState={windowState} pass={pass} purchases={billingState.purchases} repeat={repeat}
      labelOf={labelOf} onRepeat={next => void start(next.intent, next.run, next.hold)}
      onCheckAgain={item => {
        setRepeat(undefined);
        void billing<"checkPurchase">({ action: "checkPurchase", item }).catch(() => {});
      }} />
    {failure && <p className="notice" role="alert">{failure}</p>}

    <section className="desktop-setting-section" data-testid="native-billing-current">
      <h3>{auth.currentPlan}</h3>
      <Row label={planName} description={planDescription}><strong>{account.plan}</strong></Row>
      {account.subscription.billingInterval && <Row label={auth.billingInterval}>
        {account.subscription.billingInterval === "annual" ? billingCopy.intervalAnnual : billingCopy.intervalMonthly}
      </Row>}
      {periodEnd && <Row label={dictionaries[language].share.expires}
        description={account.subscription.cancelAtPeriodEnd ? auth.cancelPlanNotice : undefined}>{periodEnd}</Row>}
      {reservation && <Row label={reservation.execution === "immediate_upgrade" ? changeText.pendingPaymentTitle
        : changeText.scheduledTitle(reservation.toTier)}
        description={reservation.execution === "immediate_upgrade" ? changeText.pendingPaymentBody
          : changeText.scheduledBody(reservation.toTier, formatDate(reservation.appliesAt, language, true))}>
        <button type="button" className="soft" onClick={() => setView({ kind: "change", tier: reservation.toTier,
          interval: reservation.billingInterval })}>{changeText.cancelScheduled}</button>
      </Row>}
    </section>

    <section className="desktop-setting-section" data-testid="native-billing-balances">
      <h3>{desk.balancesTitle}</h3>
      <Row label={auth.dailyCreditsRemaining} description={account.balances.dailyRemainingCredits === null
        ? auth.dailyCreditsUnlimitedStandard
        : fillBillingCopy(auth.dailyCreditsResetAt, { time: formatDate(account.balances.dailyResetsAt, language) })}>
        {format(account.balances.dailyRemainingCredits)}
      </Row>
      <Row label={auth.planCreditsRemaining}
        description={fillBillingCopy(auth.dailyCreditsResetAt, { time: formatDate(account.balances.planResetsAt, language) })}>
        {format(account.balances.planRemainingCredits)}
      </Row>
      <Row label={auth.purchasedCreditsRemaining} description={account.balances.purchasedEarliestExpiry
        ? fillBillingCopy(desk.purchasedExpiry, { date: formatDate(account.balances.purchasedEarliestExpiry, language) }) : undefined}>
        {format(account.balances.purchasedRemainingCredits)}
      </Row>
    </section>

    <section className="desktop-setting-section" data-testid="native-billing-plans">
      <h3>{desk.plansTitle}</h3>
      <IntervalChoice language={language} interval={cycle} onCycle={setCycle} />
      {config.data ? <div className="billing-plans">
        {config.data.plans.filter(plan => plan.id !== "free").map(plan => {
          const planId = plan.id as "pro" | "max";
          const tier = tierOf(planId);
          const state = resolvePlanCtaState({
            sessionStatus: "authenticated", currentPlan: account.plan, cardPlan: tier,
            hasActiveSubscription: activeSubscription, currentBillingInterval: account.subscription.billingInterval,
          });
          const price = cycle === "annual" ? plan.displayAnnualPriceMinor : plan.displayMonthlyPriceMinor;
          return <article className="billing-card" key={plan.id} data-testid={"native-billing-plan-" + plan.id}>
            <header>
              <strong>{plan.name}</strong>
              <span className="billing-price">{fillBillingCopy(cycle === "annual" ? desk.pricePerYear : desk.pricePerMonth,
                { amount: formatMinor(price, plan.displayCurrency) })}</span>
            </header>
            <span className="billing-muted">{fillBillingCopy(desk.monthlyCredits,
              { credits: new Intl.NumberFormat(language).format(plan.monthlyMessageLimit) })}</span>
            <div className="billing-card-action">
              {state === "current_plan" ? <span className="billing-badge">{purchase.currentPlan}</span>
                : state === "upgrade" ? <button type="button" className="primary" disabled={purchaseBusy}
                  onClick={() => { setFailure(undefined); setView({ kind: "checkout", planId }); }}>{purchase.upgradeTo(plan.name)}</button>
                  : state === "change_plan" && account.subscription.billingInterval ? <button type="button" className="soft"
                    onClick={() => setView({ kind: "change", tier, interval: account.subscription.billingInterval as Interval })}>
                    {tier === "Max" ? purchase.upgradeTo(plan.name) : purchase.changePlanTo(plan.name)}</button>
                    : <>
                      <small className="billing-muted">{purchase.managePlanHint}</small>
                      <button type="button" className="soft" onClick={() => void openDocs("help")}>{purchase.managePlan}</button>
                    </>}
            </div>
          </article>;
        })}
      </div> : config.failed ? <ReadFailure language={language} retry={config.reload} /> : <p role="status">{auth.loading}</p>}
    </section>

    <CreditPacks language={language} packs={packs.data} failed={packs.failed} retry={packs.reload}
      busy={starting || purchaseBusy}
      onBuy={pack => void start({ kind: "credits", packId: pack.id }, repeatHold => billing<"buyCreditPack">(
        withHold({ action: "buyCreditPack" as const, packId: pack.id, currency: pack.currency, language }, repeatHold)))} />

    {(account.plan === "Pro" || account.plan === "Max") && <>
      <CancelSubscription language={language} account={account} periodEnd={periodEnd} onSettled={usage.reload} />
      <RefundRequest language={language} pending={refund.data?.pendingRequest ?? null} onSettled={refund.reload} />
    </>}
  </div>;
}

function IntervalChoice({ language, interval, onCycle }: { language: Language; interval: Interval; onCycle(value: Interval): void }) {
  const copy = checkoutCopy[language];
  return <div className="billing-segment" role="group" aria-label={copy.billingCycle}>
    {(["monthly", "annual"] as const).map(value => <button key={value} type="button" aria-pressed={interval === value}
      onClick={() => onCycle(value)}>{value === "annual" ? <>{copy.annual} <small>{copy.annualOff}</small></> : copy.monthly}</button>)}
  </div>;
}

function CheckoutStatus({ language, windowState, pass, purchases, repeat, labelOf, onCheckAgain, onRepeat }: {
  language: Language; windowState: BillingState["window"]; pass: boolean; purchases: PurchaseRecord[]; repeat?: Repeat;
  labelOf(intent: PurchaseIntent): string; onCheckAgain(item: PurchaseItem): void; onRepeat(repeat: Repeat): void;
}) {
  const desk = desktopBillingCopy(language);
  const billingCopy = dictionaries[language].billing;
  // The warning goes on the item's newest unconfirmed attempt; the older ones stay listed with their own times.
  const repeatOn = repeat ? purchases.filter(record => record.item === repeat.item && record.stage === "unconfirmed").at(-1)?.id : undefined;
  return <>
    {windowState && <div className="billing-notice" role="status" data-testid="native-billing-window">
      <p><strong>{desk.windowOpen}</strong></p>
      <p>{fillBillingCopy(desk.windowHost, { host: windowState.host })}</p>
      {windowState.failed ? <p role="alert">{desk.windowFailed}</p> : windowState.loading ? <p>{desk.windowLoading}</p> : null}
      <button type="button" className="soft" onClick={() => void billing<"closeCheckout">({ action: "closeCheckout" })}>{desk.closeWindow}</button>
    </div>}
    {pass && <div className="billing-notice" role="status" data-testid="native-billing-verification" data-stage="pass">
      <p><strong>{billingCopy.testerPassActivatedTitle}</strong></p><p>{billingCopy.testerPassNotice}</p>
    </div>}
    {purchases.filter(record => record.stage !== "open").map(record => <PurchaseNotice key={record.id} language={language}
      record={record} label={labelOf(record.intent)} onCheckAgain={onCheckAgain} onRepeat={onRepeat}
      repeat={record.id === repeatOn ? repeat : undefined} />)}
  </>;
}

/** One purchase record. Only the account decides "confirmed"; short of that it stays open with a way to check again. */
function PurchaseNotice({ language, record, label, repeat, onCheckAgain, onRepeat }: {
  language: Language; record: PurchaseRecord; label: string; repeat?: Repeat;
  onCheckAgain(item: PurchaseItem): void; onRepeat(repeat: Repeat): void;
}) {
  const desk = desktopBillingCopy(language);
  const purchase = purchaseCtaCopy[language];
  const credits = record.intent.kind === "credits";
  const started = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(record.startedAt));
  return <div className="billing-notice" role="status" data-testid="native-billing-verification" data-item={record.item}
    data-attempt={record.id} data-stage={repeat ? "repeat" : record.stage}>
    {record.stage === "confirmed" ? credits
      ? <><p><strong>{purchase.purchaseSuccessTitle}</strong></p><p>{purchase.purchaseSuccessBody(label)}</p></>
      : <p><strong>{fillBillingCopy(desk.planConfirmed, { plan: label })}</strong></p>
      : <>
        <p><strong>{label}</strong> <span className="billing-muted">{fillBillingCopy(desk.attemptStarted, { time: started })}</span></p>
        {record.stage === "checking" ? <p>{desk.verifying}</p> : <>
          {repeat ? <><p><strong>{desk.repeatTitle}</strong></p><p>{desk.repeatBody}</p></>
            : <p>{record.cancelled ? desk.notConfirmedCancelled : desk.notConfirmed}</p>}
          <div className="billing-notice-actions">
            <button type="button" className="soft" onClick={() => onCheckAgain(record.item)}>{desk.checkAgain}</button>
            {repeat && <button type="button" className="soft" data-testid="native-billing-repeat"
              onClick={() => onRepeat(repeat)}>{desk.startAnyway}</button>}
          </div>
        </>}
      </>}
  </div>;
}

type CheckoutInput = Extract<DesktopBillingInput, { action: "checkout" }>;

/** The web checkout dialog's choices and notices, ahead of Stripe's own payment page. */
function Checkout({ language, planId, config, interval, onCycle, busy, failure, onBack, onStart }: {
  language: Language; planId: "pro" | "max"; config: BillingConfig; interval: Interval; onCycle(value: Interval): void;
  busy: boolean; failure?: string; onBack(): void; onStart(input: CheckoutInput, label: string): void;
}) {
  const copy = checkoutCopy[language];
  const legal = checkoutLegalCopy[language];
  const pass = foundingTesterPassCopy[language];
  const desk = desktopBillingCopy(language);
  const plan = config.plans.find(item => item.id === planId);
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState<{ code: string; promotion: BillingPromotion; interval: Interval }>();
  const [validating, setValidating] = useState(false);
  const [promoError, setPromoError] = useState<string>();
  const request = useRef(0);
  const currency = plan?.displayCurrency ?? "USD";
  const featured = config.featuredPromotion;
  const featuredCode = featured && featured.appliesToPlanIds.includes(planId) && featured.billingIntervals.includes(interval)
    ? featured.code : null;

  const { invalidPromo, promotionCurrencyNotSupported } = copy;
  const promoMessage = (result: BillingResult<"validatePromotion"> | null) =>
    result && !result.ok && result.code === "PROMOTION_CURRENCY_NOT_SUPPORTED" ? promotionCurrencyNotSupported : invalidPromo;
  const requestPromotion = (promoCode: string, forInterval: Interval) =>
    billing<"validatePromotion">({ action: "validatePromotion", planId, billingInterval: forInterval, promoCode, currency }).catch(() => null);

  const validate = async (promoCode: string, forInterval: Interval) => {
    const id = ++request.current;
    setValidating(true);
    setPromoError(undefined);
    const result = await requestPromotion(promoCode, forInterval);
    if (request.current !== id) return null;
    setValidating(false);
    if (result?.ok) {
      const next = { code: promoCode, promotion: result.value.promotion, interval: forInterval };
      setApplied(next);
      return next;
    }
    setApplied(undefined);
    setPromoError(promoMessage(result));
    return null;
  };

  // The live featured offer is checked by the server the same way the web dialog does on open;
  // a featured code that does not apply to the chosen cycle is cleared.
  const featuredOffer = featured?.code ?? null;
  useEffect(() => {
    const id = ++request.current;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      if (!featuredCode) {
        // Any validation still in flight was for the previous cycle and no longer reports back.
        setValidating(false);
        if (featuredOffer) setCode(current => current.trim().toUpperCase() === featuredOffer ? "" : current);
        return;
      }
      setCode(featuredCode);
      setValidating(true);
      setPromoError(undefined);
    });
    if (featuredCode) {
      void billing<"validatePromotion">({ action: "validatePromotion", planId, billingInterval: interval, promoCode: featuredCode, currency })
        .catch(() => null).then(result => {
          if (!live || request.current !== id) return;
          setValidating(false);
          if (result?.ok) return setApplied({ code: featuredCode, promotion: result.value.promotion, interval });
          setApplied(undefined);
          setCode("");
          setPromoError(result && !result.ok && result.code === "PROMOTION_CURRENCY_NOT_SUPPORTED"
            ? promotionCurrencyNotSupported : invalidPromo);
        });
    }
    return () => { live = false; };
  }, [currency, featuredCode, featuredOffer, interval, invalidPromo, planId, promotionCurrencyNotSupported]);

  if (!plan) return <ReadFailure language={language} retry={onBack} />;
  const promotion = applied && applied.interval === interval ? applied.promotion : null;
  const chargeable = promotion && promotionAppliesToCurrency(promotion, currency) ? promotion : null;
  const priceMinor = interval === "annual" ? plan.displayAnnualPriceMinor : plan.displayMonthlyPriceMinor;
  const dueLabel = validating ? "…" : formatMinor(calculateDiscountedDisplayMinor(priceMinor, chargeable, currency), currency);
  const monthlyLabel = formatMinor(plan.displayMonthlyPriceMinor, currency);
  const annualLabel = formatMinor(plan.displayAnnualPriceMinor, currency);
  const discountLabel = chargeable?.discountPercent ? `-${chargeable.discountPercent}%`
    : chargeable?.discountAmountCents ? "-" + formatUsdCents(chargeable.discountAmountCents) : null;
  const months = chargeable && chargeable.durationMonths > 0 ? chargeable.durationMonths : null;
  const foundingPass = promotion?.fulfillmentType === "internal_pass" ? promotion : null;
  const typed = code.trim().toUpperCase();

  return <form className="account-settings-form billing-checkout" data-testid="native-billing-checkout" onSubmit={event => {
    event.preventDefault();
    if (busy || validating) return;
    void (async () => {
      let promoCode = promotion ? applied?.code : undefined;
      if (typed && typed !== promoCode) {
        const next = await validate(typed, interval);
        if (!next) return;
        promoCode = next.code;
      }
      onStart({ action: "checkout", planId, billingInterval: interval, currency, language, purchaseAttemptId: crypto.randomUUID(),
        ...(promoCode ? { promoCode } : {}) }, plan.name);
    })();
  }}>
    <button type="button" className="soft billing-back" onClick={onBack}>{desk.back}</button>
    <p className="billing-muted">{foundingPass ? pass.title : copy.secureCheckout}</p>
    <h3>{copy.upgradeTo(plan.name)}</h3>
    <p>{foundingPass ? pass.detail(foundingPass.accessDurationDays || 60) : copy.description}</p>

    <fieldset className="billing-cycle">
      <legend>{copy.billingCycle}</legend>
      {([["monthly", copy.monthly, monthlyLabel, copy.monthlyDescription], ["annual", copy.annual, annualLabel, copy.annualDescription]] as const)
        .map(([value, title, price, description]) => <label key={value} className="billing-cycle-option">
          <input type="radio" name="billing-interval" value={value} checked={interval === value} disabled={busy}
            onChange={() => { setApplied(undefined); setPromoError(undefined); onCycle(value); }} />
          <span><strong>{title}</strong>{value === "annual" && <small> {copy.annualOff}</small>}<br />
            <span>{price}</span> <small className="billing-muted">{description}</small></span>
        </label>)}
    </fieldset>

    <label>{copy.promoLabel}
      <span className="billing-promo">
        <input value={code} maxLength={32} placeholder={copy.promoPlaceholder} disabled={busy}
          onChange={event => { setCode(event.currentTarget.value); setPromoError(undefined); }} />
        <button type="button" className="soft" disabled={busy || validating || typed.length < 2}
          onClick={() => void validate(typed, interval)}>{copy.apply}</button>
      </span>
    </label>
    {promoError ? <p className="notice" role="alert">{promoError}</p>
      : promotion && applied && <p className="notice" role="status">{copy.promoApplied}</p>}
    <p className="billing-muted">{foundingPass ? pass.detail(foundingPass.accessDurationDays || 60)
      : `${copy.promoFinePrint} ${promotionPolicyCopy[language]}`}</p>

    <div className="billing-summary" data-testid="native-billing-summary">
      <strong>{copy.orderSummary}</strong>
      <div><span>{copy.plan}</span><span>{plan.name}</span></div>
      <div><span>{copy.billing}</span><span>{foundingPass ? pass.billingLabel : interval === "annual" ? copy.yearly : copy.monthly}</span></div>
      <div><span>{copy.subtotal}</span><span>{interval === "annual" ? annualLabel : monthlyLabel}</span></div>
      {interval === "annual" && <div><span>{copy.annualSavings}</span><span>20%</span></div>}
      {chargeable && applied && <div data-testid="native-billing-promotion">
        <span>{applied.code}{months && <small className="billing-muted"> {copy.promotionPeriod(months)}</small>}</span>
        <span>{discountLabel || copy.appliedAtCheckout}</span>
      </div>}
      <div className="billing-due"><span>{copy.dueToday}</span><span data-testid="native-billing-due">{dueLabel}</span></div>
      {!foundingPass && <small className="billing-muted">{copy.localPriceNote(dueLabel)}</small>}
    </div>

    <p className="billing-notice" data-testid="native-billing-renewal">{foundingPass ? pass.detail(foundingPass.accessDurationDays || 60)
      : months && interval === "monthly" ? copy.promotionRenewalNote(months, dueLabel, monthlyLabel)
        : copy.renewalNote(interval, interval === "annual" ? annualLabel : monthlyLabel)}</p>
    <p className="billing-muted">
      {legal.prefix}<button type="button" className="billing-link" onClick={() => void openDocs("terms")}>{legal.terms}</button>
      {legal.conjunction}<button type="button" className="billing-link" onClick={() => void openDocs("refund")}>{legal.refund}</button>
      {legal.suffix}
    </p>
    {failure && <p className="notice" role="alert">{failure}</p>}
    <button type="submit" className="primary" disabled={busy || validating} data-testid="native-billing-continue">
      {foundingPass ? pass.activate : copy.continueToCheckout}
    </button>
  </form>;
}

function CreditPacks({ language, packs, failed, retry, busy, onBuy }: {
  language: Language; packs?: BillingValue<"creditPacks">; failed: boolean; retry(): void; busy: boolean;
  onBuy(pack: BillingValue<"creditPacks">["packs"][number]): void;
}) {
  const copy = creditPackCopy[language];
  if (!packs) return failed ? <section className="desktop-setting-section"><h3>{copy.title}</h3><ReadFailure language={language} retry={retry} /></section> : null;
  if (!packs.packs.length) return null;
  return <section className="desktop-setting-section" data-testid="native-billing-credit-packs">
    <h3>{copy.title}</h3>
    <p className="billing-muted">{copy.body}</p>
    {packs.packs.map(pack => <Row key={pack.id}
      label={<><strong>{pack.name}</strong> · {new Intl.NumberFormat(language).format(pack.credits)} {creditUnit[language]}</>}
      description={copy.expiry.replace("{days}", String(pack.validityDays))}>
      <span>{formatMinor(pack.priceMinor, pack.currency)}</span>
      <button type="button" className="soft" disabled={busy} onClick={() => onBuy(pack)}>{copy.buy}</button>
    </Row>)}
    <p className="billing-notice">{copy.notice}</p>
  </section>;
}

/** The web's plan-change dialog, in place: quote first, confirm second, an existing change wins. */
function PlanChange({ language, tier, interval, onBack, onSettled }: {
  language: Language; tier: "Pro" | "Max"; interval: Interval; onBack(): void; onSettled(): void;
}) {
  const text = planChangeText(language);
  const desk = desktopBillingCopy(language);
  const [stage, setStage] = useState<"loading" | "quote" | "reserved" | "cancelled" | "error">("loading");
  const [quote, setQuote] = useState<PlanChangeQuote>();
  const [reservation, setReservation] = useState<PlanChangeReservation>();
  const [error, setError] = useState<PlanChangeCopyErrorCode>();
  const [resumeRenewal, setResumeRenewal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const fail = (code: PlanChangeCopyErrorCode) => { setError(code); setStage("error"); };

  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      setStage("loading"); setError(undefined); setQuote(undefined); setReservation(undefined); setResumeRenewal(false);
      inFlight.current = false;
    });
    void (async () => {
      // Read first: after an unknown outcome, the change that already exists is what the customer sees.
      const existing = await billing<"planChange">({ action: "planChange" }).catch(() => null);
      if (!live) return;
      if (existing?.ok && existing.value.reservation) {
        setReservation(existing.value.reservation);
        return setStage("reserved");
      }
      const result = await billing<"previewPlanChange">({ action: "previewPlanChange", targetTier: tier, billingInterval: interval });
      if (!live) return;
      if (!result.ok) { setError(planChangeErrorCode(result)); return setStage("error"); }
      setQuote(result.value.quote);
      setStage("quote");
    })().catch(() => { if (live) { setError("NETWORK_ERROR"); setStage("error"); } });
    return () => { live = false; };
  }, [attempt, interval, tier]);

  const confirm = async () => {
    if (!quote || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await billing<"confirmPlanChange">({ action: "confirmPlanChange", requestId: quote.requestId,
        ...(resumeRenewal ? { resumeRenewal: true as const } : {}) });
      if (!result.ok) { inFlight.current = false; return fail(planChangeErrorCode(result)); }
      setReservation(result.value.reservation);
      setStage("reserved");
      onSettled();
    } catch {
      inFlight.current = false;
      setError("NETWORK_ERROR");
      setStage("error");
    } finally {
      setBusy(false);
    }
  };

  const cancelScheduled = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await billing<"cancelPlanChange">({ action: "cancelPlanChange" });
      inFlight.current = false;
      if (!result.ok) return fail(planChangeErrorCode(result));
      setStage("cancelled");
      onSettled();
    } catch {
      inFlight.current = false;
      setError("NETWORK_ERROR");
      setStage("error");
    } finally {
      setBusy(false);
    }
  };

  const upgrade = (quote?.direction ?? reservation?.direction) === "upgrade";
  const shownTier = quote?.toTier ?? reservation?.toTier ?? tier;
  const effectiveDate = formatDate(quote?.effectiveAt ?? reservation?.appliesAt ?? null, language, true);
  return <section className="desktop-setting-section billing-change" data-testid="native-billing-plan-change" data-stage={stage}>
    <button type="button" className="soft billing-back" onClick={onBack}>{desk.back}</button>
    <h3>{upgrade ? text.upgradeTitle(shownTier) : text.downgradeTitle(shownTier)}</h3>
    {stage === "loading" && <p role="status">{text.loading}</p>}
    {stage === "quote" && quote && <>
      {quote.amountDueMinor !== null && <div className="billing-summary" data-testid="native-billing-change-amount">
        <span className="billing-muted">{text.dueNow}</span>
        <strong className="billing-due">{formatMinor(quote.amountDueMinor, quote.currency)}</strong>
      </div>}
      {quote.credits && <div className="billing-summary">
        <span className="billing-muted">{text.creditsLabel}</span>
        <span>{text.creditsRemaining(quote.credits.remainingPlanCredits, quote.credits.monthlyPlanCredits)}</span>
        {quote.credits.overageCredits > 0 && <small className="billing-muted">{text.creditsOverageNotice}</small>}
      </div>}
      <p>{upgrade ? text.upgradeBody(quote.toTier) : text.downgradeBody(quote.toTier, effectiveDate)}</p>
      <p className="billing-muted">{quote.effectiveAt ? text.effectiveOn(effectiveDate) : text.effectiveImmediately}</p>
      {quote.renewal === "cancellation_preserved" && <div className="billing-notice">
        <label className="billing-check"><input type="checkbox" checked={resumeRenewal} data-testid="native-billing-resume-renewal"
          onChange={event => setResumeRenewal(event.currentTarget.checked)} />{text.resumeRenewalLabel}</label>
        <p>{resumeRenewal ? text.resumeRenewalHint : text.cancellationPreservedNotice}</p>
      </div>}
      <button type="button" className="primary" disabled={busy} data-testid="native-billing-change-confirm" onClick={() => void confirm()}>
        {busy ? text.working : upgrade ? text.confirmUpgrade(quote.toTier) : text.confirmDowngrade(quote.toTier)}
      </button>
    </>}
    {stage === "reserved" && reservation && <>
      <p><strong>{reservation.status === "applied" ? text.upgradeDoneTitle(reservation.toTier)
        : reservation.execution === "immediate_upgrade" ? text.pendingPaymentTitle : text.scheduledTitle(reservation.toTier)}</strong></p>
      <p>{reservation.status === "applied" ? text.upgradeDoneBody : reservation.execution === "immediate_upgrade"
        ? text.pendingPaymentBody : text.scheduledBody(reservation.toTier, formatDate(reservation.appliesAt, language, true))}</p>
      {reservation.cancellable && <button type="button" className="soft" disabled={busy} data-testid="native-billing-change-cancel"
        onClick={() => void cancelScheduled()}>{busy ? text.working : text.cancelScheduled}</button>}
    </>}
    {stage === "cancelled" && <p role="status">{text.cancelScheduledDone}</p>}
    {stage === "error" && error && <div data-testid="native-billing-change-error" data-error-code={error}>
      <p className="notice" role="alert">{text.errors[error]}</p>
      {planChangeNeedsSupport(error)
        ? <button type="button" className="soft" onClick={() => void openDocs("help")}>{text.contactSupport}</button>
        : <button type="button" className="soft" onClick={() => setAttempt(value => value + 1)}>{text.retry}</button>}
    </div>}
  </section>;
}

function CancelSubscription({ language, account, periodEnd, onSettled }: {
  language: Language; account: BillingUsage; periodEnd: string; onSettled(): void;
}) {
  const auth = dictionaries[language].auth;
  const desk = desktopBillingCopy(language);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean }>();
  const scheduled = account.subscription.cancelAtPeriodEnd;
  return <section className="desktop-setting-section" data-testid="native-billing-cancel">
    <h3>{auth.cancelPlanTitle}</h3>
    <p>{fillBillingCopy(auth.cancelPlanDescription, { date: periodEnd || auth.cancelPlanFallbackDate })}</p>
    <button type="button" className="soft" disabled={busy || scheduled} data-armed={armed || undefined} onClick={() => {
      if (!armed) return setArmed(true);
      setArmed(false);
      setBusy(true);
      setMessage(undefined);
      void billing<"cancelSubscription">({ action: "cancelSubscription" }).then(result => {
        const date = result.ok ? formatDate(result.value.currentPeriodEnd, language) : "";
        setMessage(result.ok ? { text: date ? fillBillingCopy(auth.cancelPlanToastUntil, { date }) : auth.cancelPlanToastPeriodEnd, failed: false }
          : { text: auth.cancelPlanFailed, failed: true });
      }, () => setMessage({ text: auth.cancelPlanFailed, failed: true })).finally(() => {
        setBusy(false);
        // Success or not, the button follows what the server now reports.
        onSettled();
      });
    }}>{scheduled ? auth.cancelPlanButtonScheduled : busy ? auth.cancelPlanProcessing : armed ? desk.cancelConfirm : auth.cancelPlanButton}</button>
    {scheduled && <p className="billing-muted">{auth.cancelPlanNotice}</p>}
    {message && <p className="notice" role={message.failed ? "alert" : "status"}>{message.text}</p>}
  </section>;
}

function RefundRequest({ language, pending, onSettled }: {
  language: Language; pending: { requestedAt: string } | null; onSettled(): void;
}) {
  const auth = dictionaries[language].auth;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean }>();
  return <section className="desktop-setting-section account-settings-form" data-testid="native-billing-refund">
    <h3>{auth.refundRequestTitle}</h3>
    <p>{auth.refundRequestDescription}</p>
    <textarea value={reason} maxLength={1_000} rows={3} placeholder={auth.refundReasonPlaceholder} aria-label={auth.refundRequestTitle}
      disabled={busy || !!pending} onChange={event => setReason(event.currentTarget.value)} />
    <button type="button" className="soft" disabled={busy || !!pending} onClick={() => {
      setBusy(true);
      setMessage(undefined);
      void billing<"requestRefund">({ action: "requestRefund", reason }).then(result => {
        if (result.ok) setReason("");
        setMessage(result.ok ? { text: auth.refundRequestSuccess, failed: false } : { text: auth.refundRequestFailed, failed: true });
      }, () => setMessage({ text: auth.refundRequestFailed, failed: true })).finally(() => {
        setBusy(false);
        onSettled();
      });
    }}>{pending ? auth.refundRequested : busy ? auth.refundRequesting : auth.requestRefund}</button>
    {pending && <p className="billing-muted">{auth.refundRequestedAt}: {formatDate(pending.requestedAt, language)}</p>}
    {message && <p className="notice" role={message.failed ? "alert" : "status"}>{message.text}</p>}
  </section>;
}
