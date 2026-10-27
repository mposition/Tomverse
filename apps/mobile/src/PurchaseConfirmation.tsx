import { useEffect, useRef } from "react";
import { CircleCheck } from "lucide-react";
import type { MobileLanguage } from "../../../locales/mobile";
import { formatMobileBillingCopy, mobileBillingCopy } from "../../../locales/mobileBilling";
import type { PurchaseConfirmation as Confirmation } from "./billingPurchaseResult";

export function PurchaseConfirmation({ confirmation, language, onClose }: { confirmation: Confirmation; language: MobileLanguage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const c = mobileBillingCopy(language);
  const credits = confirmation.kind === "credits";
  const title = credits
    ? formatMobileBillingCopy(c.creditsCompleted, { credits: confirmation.credits.toLocaleString(language) })
    : formatMobileBillingCopy(c.planCompleted, { plan: confirmation.plan });
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className="purchase-confirmation" aria-labelledby="purchase-confirmation-title" aria-describedby="purchase-confirmation-description"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="purchase-confirmation-icon" aria-hidden="true"><CircleCheck size={36} strokeWidth={2} /></div>
    <h2 id="purchase-confirmation-title">{title}</h2>
    <p id="purchase-confirmation-description">{credits ? c.creditsCompletedDescription : c.planCompletedDescription}</p>
    <button type="button" className="purchase-confirmation-action" autoFocus onClick={onClose}>{c.confirmPurchase}</button>
  </dialog>;
}
