# 독립 검토 요청 — 발견 대기열: 채택·제외, 재검토, 구조화된 결정 기록

`git diff`(intent-to-add 포함)를 검토해 주세요. 기준 브랜치는 `origin/develop`입니다.
계약 개정은 `.github/audits/model-lifecycle-email-2026-08-22.md` §51에 적었습니다.

## 운영자가 승인한 요구사항 (2026-09-13)

1. 운영 화면은 `채택`·`제외` 두 결정만. 아무것도 누르지 않으면 "아직 검토하지 않음".
2. `결정 필요` 버튼 제거 — 내부 상태와 자동 전이 기록은 유지.
3. `보류` 버튼 제거.
4. `조치 없음` → `제외`. 확인 문구 "이 모델 패밀리는 이후 자동 스캔에서도 다시 제안되지
   않습니다." 별도 `제외됨` 보기에서 확인, 관리자가 명시적으로 `재검토`하면 대기열로 복귀.
   자동 스캔은 제외를 되돌리지 않음.
5. 감사 기록 분리: `analysisSnapshot`(결정 당시 AI 분석), `operatorReason`, `decision`(채택/제외),
   `actor`, `decidedAt`. 행 분석 문장을 운영자 사유로 자동 기록하던 동작 제거.
6. 제외 사유 빠른 선택지 6개: 이미 상위 모델 제공 / 동일 모델·alias 중복 / Tomverse 제품 경로
   없음 / 가격·품질·컨텍스트 이점 부족 / 공급자에서 안정적으로 제공되지 않음 / 기타.

## 구현 요약

- `lib/modelLifecycleWorkItemCore.ts`: `closed_no_action → discovered`만 허용하는 재개
  (`REOPENABLE_WORK_ITEM_STATUSES`), `WORK_ITEM_EVENT_DECISIONS`, `WORK_ITEM_EXCLUSION_REASONS`,
  `workItemDecisionRecordRefusal`, `workItemDecisionTarget`. `rejected`·`completed`는 종단 유지.
- migration `20260913150000_model_lifecycle_decision_record`: 이벤트 테이블에 `decision`,
  `reasonCode`, `operatorReason`, `analysisSnapshot` + CHECK 3개(목록 2, shape 1).
- `lib/modelLifecycleWorkItems.ts`: `transitionWorkItems`의 `eventDecision`. 제외 시 item에
  `decision=reject` 등 기록, 재검토 시 `closedAt`·decision 필드 초기화. `listModelDiscoveryQueue`의
  `view: "excluded"`와 `workItemIds`, 마지막 제외 이벤트 요약, `analysisSnapshotsFor`(서버 계산).
- `app/api/admin/model-lifecycle/route.ts`: `{decision:"exclude"|"reopen"}` 형태 추가, 일반 전이로
  `closed_no_action`·`discovered` 이동은 400. `GET ?view=excluded`.
- `app/api/admin/models/route.ts`: 채택의 `approved` 단계 이벤트에 `decision=adopt`,
  `operatorReason`(채택 사유), `analysisSnapshot`.
- `components/admin/AdminModelDiscoveryPanel.tsx`: 보기 전환(검토 대기/제외됨), 행 버튼은
  채택·제외(대기) / 재검토(제외됨), 사유 대화상자, 벌크 제외·재검토. 문구는
  `lib/adminMessages/modelDiscovery.ts`(en/ko).
- 테스트: core 단위, route contract, DB integration `model-lifecycle-exclusion.db.test.ts`
  (로컬 DB가 없어 CI에서만 실행됨).

## 특히 봐 주실 것

1. **재개봉 정책 변경의 안전성.** 종단 불변조건을 완화한 것이 다른 경로(채택 preflight,
   일일 보고서, 자동 비활성화 retire item, cleanup 스크립트, 스캔 억제)에서 잘못된 상태를
   만들 수 있는지.
2. **감사 기록의 정확성.** 분석 스냅샷이 클라이언트 값으로 오염될 경로가 있는지, 사유와 분석이
   다시 섞이는 경로가 있는지, DB CHECK가 서비스 검사와 어긋나는지(NULL 비교 포함).
3. **벌크 동작.** 섞인 상태의 패밀리를 벌크 제외·재검토할 때 일부만 적용되거나, 이미 채택
   진행 중인 item이 제외되는 경로가 있는지.
4. **UI.** 보기 전환 중 이전 보기의 행이 다른 보기의 결정 버튼과 결합될 수 있는지, 대화상자가
   열린 채 데이터가 바뀌면 잘못된 id가 전송되는지.
5. 한국 admin locale 계약(`docs/ui-contracts/admin-console-ia.md` Language) 준수.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
