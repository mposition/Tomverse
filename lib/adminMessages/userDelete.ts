import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the two-step user delete button on the Users list. */
export const adminUserDeleteMessages = defineAdminMessages({
  en: {
    delete: "Delete",
    currentAdmin: "Current admin",
    deleting: "Deleting",
    confirm: "Confirm",
    toast: {
      currentAdmin: "Use account settings to delete the currently signed-in admin account.",
      armed: "Click delete again to permanently remove this user account and all owned data.",
      typeConfirm: "Type DELETE USER before confirming account deletion.",
      failed: "Failed to delete user.",
      deleted: "User account deleted.",
    },
  },
  ko: {
    delete: "삭제",
    currentAdmin: "현재 관리자",
    deleting: "삭제 중",
    confirm: "확인",
    toast: {
      currentAdmin: "현재 로그인한 관리자 계정은 계정 설정에서 삭제하세요.",
      armed: "이 사용자 계정과 소유한 모든 데이터를 영구 삭제하려면 삭제를 한 번 더 누르세요.",
      typeConfirm: "계정 삭제를 확인하기 전에 DELETE USER를 입력하세요.",
      failed: "사용자를 삭제하지 못했습니다.",
      deleted: "사용자 계정을 삭제했습니다.",
    },
  },
});
