import type { Language } from "@/lib/language";

const en = {
  title: "Review Easy defaults", platformTitle: "Review platform defaults",
  description: "Choose the providers selected when you start a new Easy Review. Existing conversations keep their selection.",
  source: "Default providers", inherit: "Use platform defaults", personal: "Use my selection",
  providers: "Easy default providers", save: "Save Easy defaults", saving: "Saving…", saved: "Easy defaults saved.",
  loading: "Loading Easy defaults…", reload: "Reload saved defaults", loadFailed: "Defaults could not be loaded. Reload to try again.",
  saveUnknown: "The save could not be confirmed. Reload saved defaults before trying again.",
  unavailable: "No eligible providers are available. Choose another model or check availability before starting a Review.",
  limit: "Select 1–{count} providers available on your plan.", platformLimit: "Select 1–3 providers. Personal settings take priority.",
  select: "Choose at least one provider.",
};
export const reviewProviderPreferencesCopy = (language: Language) => language === "ko" ? {
  title: "Review Easy 기본값", platformTitle: "Review 플랫폼 기본값",
  description: "새 Easy Review에서 선택할 공급자입니다. 기존 대화의 선택은 유지됩니다.",
  source: "기본 공급자", inherit: "플랫폼 기본값 사용", personal: "내 공급자 선택 사용",
  providers: "Easy 기본 공급자", save: "Easy 기본값 저장", saving: "저장 중…", saved: "Easy 기본값을 저장했습니다.",
  loading: "Easy 기본값을 불러오는 중…", reload: "저장된 기본값 다시 불러오기", loadFailed: "기본값을 불러오지 못했습니다. 다시 불러와 주세요.",
  saveUnknown: "저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 저장된 기본값을 불러와 주세요.",
  unavailable: "사용 가능한 공급자가 없습니다. 모델을 변경하거나 사용 가능 여부를 확인한 후 Review를 시작해 주세요.",
  limit: "현재 플랜에서 사용 가능한 공급자를 1–{count}개 선택하세요.", platformLimit: "공급자를 1–3개 선택하세요. 개인 설정이 우선 적용됩니다.",
  select: "공급자를 한 개 이상 선택해 주세요.",
} : en;
