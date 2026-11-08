"use client";

import Link from "next/link";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { canUseModelWithPlan, type ModelTier } from "@/lib/models";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";

export function PricingKoreanPlanLimits({ plan, dailyCredits, allowAttachments, appInputTokenLimit }: {
  plan: ModelTier;
  dailyCredits: number | null;
  allowAttachments: boolean | undefined;
  appInputTokenLimit: number | null;
}) {
  const { publicModels } = useModelCatalog();
  const models = publicModels.filter((model) => model.enabled && canUseModelWithPlan(plan, model));
  const format = (value: number) => value.toLocaleString("ko-KR");
  return (
    <div data-testid={`pricing-plan-limits-${plan.toLowerCase()}`} className="mt-4 space-y-3 border-t border-current/20 pt-4 text-sm leading-6">
      <dl className="space-y-2">
        <div><dt className="font-bold">일일 플랜 크레딧</dt><dd>{dailyCredits === null ? "현재 일일 한도는 앱 사용량 안내에서 확인하세요." : dailyCredits === 0 ? "별도 일일 플랜 크레딧 한도 없음" : `${format(dailyCredits)} 크레딧`}</dd></div>
        <div><dt className="font-bold">파일 첨부</dt><dd>{allowAttachments === false ? "현재 플랜 설정에서 첨부 기능을 제공하지 않습니다." : `${allowAttachments === undefined ? "첨부가 허용된 계정: " : ""}메시지당 5개 · 파일당 10 MiB · 총 25 MiB`}</dd></div>
        <div><dt className="font-bold">앱 입력 상한</dt><dd>{appInputTokenLimit === null ? "현재 입력 상한을 불러오는 중입니다." : `${format(appInputTokenLimit)} 토큰 · 플랜 공통`}</dd></div>
      </dl>
      <p>월 크레딧, 모델별 한도와 운영 안전장치는 별도로 적용됩니다. 추가 구매 크레딧은 플랜 크레딧과 구분됩니다.</p>
      <details>
        <summary className="min-h-11 cursor-pointer py-2.5 font-bold underline underline-offset-4">모델별 맥락 최대값 보기</summary>
        <p>아래는 모델 카탈로그의 맥락 최대값입니다. 실제 입력은 위 앱 상한 안에서 처리되며, 출력 공간과 도구·시스템 문맥 때문에 사용 가능한 맥락이 더 작을 수 있습니다.</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          {models.map((model) => <li key={model.id}>{model.name}: {model.contextWindowTokens ? `${format(model.contextWindowTokens)} 토큰` : "카탈로그 수치 미제공"}</li>)}
        </ul>
      </details>
      <Link href="/ko/models" className="block font-bold underline underline-offset-4">지원 모델과 이용 시작 플랜 보기</Link>
      <Link href={chatWorkspaceGuideHref("ko", "files-and-drive")} className="block font-bold underline underline-offset-4">파일·Google Drive 상세 안내</Link>
    </div>
  );
}
