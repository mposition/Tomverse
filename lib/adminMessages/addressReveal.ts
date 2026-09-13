import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the audited "show addresses" control on email ledgers. */
export const adminAddressRevealMessages = defineAdminMessages({
  en: {
    failed: "Could not show the addresses.",
    notPermitted: "Addresses are shown masked. Revealing them is an owner or ops action.",
    done: "Addresses shown, and recorded in the audit log. Reloading this page masks them again.",
    show: (count: number) => `Show addresses (${count})`,
  },
  ko: {
    failed: "주소를 표시하지 못했습니다.",
    notPermitted: "주소는 마스킹되어 표시됩니다. 주소 표시는 owner 또는 ops 역할의 작업입니다.",
    done: "주소를 표시했으며 감사 로그에 기록했습니다. 이 페이지를 새로고침하면 다시 마스킹됩니다.",
    show: (count: number) => `주소 표시 (${count})`,
  },
});
