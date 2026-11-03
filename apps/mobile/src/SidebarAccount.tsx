import { useEffect, useState } from "react";
import { usagePercent } from "../../../components/chat/UsagePercentGauge";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import type { AccountUsage, ChatTransport } from "./chatTransport";
import { AppIcon } from "./AppIcon";
import { mobileSettingsCopy } from "../../../locales/mobileSettings";

/** Read the same account and monthly credit totals as the web sidebar. */
export function SidebarAccount({ transport, language, onSettings, onPlan }: {
  transport: ChatTransport; language: MobileLanguage; onSettings: () => void; onPlan: () => void;
}) {
  const [profile, setProfile] = useState<Awaited<ReturnType<ChatTransport["account"]>> | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const copy = mobileCopy[language];
  useEffect(() => {
    let active = true;
    void Promise.allSettled([transport.account(), transport.usage?.()]).then(([account, totals]) => {
      if (!active) return;
      setProfile(account.status === "fulfilled" ? account.value : null);
      setUsage(totals.status === "fulfilled" ? totals.value ?? null : null);
      setUnavailable(totals.status === "rejected" && totals.reason?.code === "NATIVE_USAGE_UNAVAILABLE");
      setLoading(false);
    });
    return () => { active = false; };
  }, [transport, revision]);
  const name = profile?.name || profile?.email || "Tomverse";
  const percent = usage ? usagePercent(usage.usage.creditsMonth, usage.limits.creditsMonth) : null;
  const label = { en: "Current usage", ko: "현재 사용량", zh: "当前用量", de: "Aktuelle Nutzung", fr: "Utilisation actuelle", es: "Uso actual", pt: "Uso atual" }[language];
  const retry = { en: "Retry usage", ko: "사용량 다시 불러오기", zh: "重试用量", de: "Nutzung erneut laden", fr: "Recharger l’utilisation", es: "Reintentar uso", pt: "Recarregar uso" }[language];
  const unavailableLabel = { en: "Usage is temporarily unavailable", ko: "사용량을 일시적으로 불러올 수 없습니다", zh: "用量暂时不可用", de: "Nutzung vorübergehend nicht verfügbar", fr: "Utilisation temporairement indisponible", es: "Uso temporalmente no disponible", pt: "Uso temporariamente indisponível" }[language];
  return <footer className="sidebar-account" data-testid="sidebar-account">
    <span className="account-avatar" aria-hidden="true">{name[0].toUpperCase()}</span>
    <div className="account-summary">
      <strong className="account-name" title={name}>{name}</strong>
      <div className="account-usage" aria-live="polite">
        {loading ? copy.loading : usage ? <><span>{usage.plan} · {label}</span><strong>{percent === null ? "—" : `${percent}%`}</strong></> : <span>{unavailable && <span role="status">{unavailableLabel}</span>}<button onClick={() => { setLoading(true); setRevision(value => value + 1); }}>{retry}</button></span>}
      </div>
      {percent !== null && <progress aria-label={label} max={100} value={percent} />}
    </div>
    <button aria-label={copy.settings} onClick={onSettings}><AppIcon name="settings" /></button>
    {import.meta.env.VITE_NATIVE_BILLING_ENABLED === "true" && <button type="button" className="sidebar-plan-entry" onClick={onPlan}>{mobileSettingsCopy(language).usageAndPlan}<span aria-hidden="true">→</span></button>}
  </footer>;
}
