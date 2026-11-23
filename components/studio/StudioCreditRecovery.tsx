"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { CreditPackPurchaseButton } from "@/components/billing/CreditPackPurchaseButton";
import { PlanChangeDialog } from "@/components/billing/PlanChangeDialog";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import { useUserUsage, notifyUserUsageChanged, normalizeUserPlan } from "@/components/chat/useUserUsage";
import { useModalDialog } from "@/components/useModalDialog";
import { StudioGenerationError } from "./studioGenerationClient";
import styles from "./studio.module.css";

const creditCodes = new Set([
  "CREDIT_BALANCE_INSUFFICIENT",
  "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "PLAN_ENTITLEMENT_EXHAUSTED",
  "PLAN_DAILY_CREDIT_LIMIT_REACHED",
]);

export function isStudioCreditShortfall(error: unknown): error is StudioGenerationError {
  return error instanceof StudioGenerationError && Boolean(error.code && creditCodes.has(error.code));
}

export function StudioCreditRecovery({ error, returnTo, onClose }: {
  error: StudioGenerationError | null;
  returnTo: string;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const { lang, t } = useLanguage();
  const usage = useUserUsage(Boolean(error));
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [changingPlan, setChangingPlan] = useState(false);
  const interval = usage?.subscription?.billingInterval;
  const plan = usage?.plan ?? (session?.user?.plan ? normalizeUserPlan(session.user.plan) : null);
  const close = () => {
    setChangingPlan(false);
    onClose();
  };

  useModalDialog({ open: Boolean(error) && !changingPlan, onClose: close, dialogRef, panelRef: dialogRef, initialFocusRef: closeRef });
  if (!error) return null;

  if (changingPlan && (interval === "monthly" || interval === "annual")) {
    return <PlanChangeDialog open lang={lang} billingInterval={interval} targetTier="Max"
      onSettled={notifyUserUsageChanged} onOpenChange={open => { if (!open) setChangingPlan(false); }} />;
  }

  let description = t("chat.monthlyLimitReachedBody");
  if (error.code === "PLAN_DAILY_CREDIT_LIMIT_REACHED") description = t("chat.imageGenerationErrorDailyLimit");
  else if (typeof error.details?.requiredCredits === "number" && typeof error.details?.availableCredits === "number") {
    description = t("chat.imageGenerationErrorInsufficientCredits")
      .replace("{required}", String(error.details.requiredCredits))
      .replace("{available}", String(error.details.availableCredits));
  }

  return <div className={styles.creditBackdrop} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialogRef} className={styles.creditDialog} data-testid="studio-credit-modal"
      role="dialog" aria-modal="true" aria-labelledby="studio-credit-title">
      <h2 id="studio-credit-title">{t("chat.accountLimitReachedTitle")}</h2>
      <p>{description}</p>
      <div className={styles.creditActions}>
        <CreditPackPurchaseButton returnTo={returnTo} trigger="limit_hit" ctaLocation="studio_credit_limit"
          className={styles.primary} />
        {plan === "Free" && <UpgradeInterestButton plan="Pro" trigger="limit_hit" returnTo={returnTo}
          className={styles.secondary}>{t("upgrade.upgradeToPro")}</UpgradeInterestButton>}
        {plan === "Pro" && (
          interval === "monthly" || interval === "annual"
            ? <button type="button" className={styles.secondary} onClick={() => setChangingPlan(true)}>{t("upgrade.upgradeToMax")}</button>
            : <UpgradeCtaLink targetPlan="Max" currentPlan="Pro" trigger="limit_hit" ctaLocation="studio_credit_limit"
              className={styles.secondary}>{t("upgrade.upgradeToMax")}</UpgradeCtaLink>
        )}
        <button ref={closeRef} type="button" className={styles.secondary} onClick={close}>{t("auth.cancel")}</button>
      </div>
    </div>
  </div>;
}
