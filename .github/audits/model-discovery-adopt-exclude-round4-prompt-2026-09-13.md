# 4차 검토 요청 — 발견 대기열: 채택·제외, 재검토

3차 P2 4건에 대한 대응입니다. `git diff`(intent-to-add 포함)를 다시 봐 주세요.

## 대응

1. **패밀리 전체 제외를 서버가 강제.** 제외 요청마다 `excludableQueueFamilies()`가 미결정
   (`discovered`·`awaiting_decision`·`deferred`) 대기열 전체를 읽어 familyKey별 구성원을 만들고,
   각 `families[].workItemIds`가 그 패밀리의 미결정 구성원 **전체와 정확히 같을 때만** 진행합니다
   (부분집합·다른 패밀리 포함·중복은 409 `FAMILY_MISMATCH`). 한 번에 다 읽지 못하면(1,000 초과)
   503 `QUEUE_TOO_LARGE`로 fail-closed.
2. **스냅샷 필수.** 서비스: 제외는 모든 item에 비어 있지 않은 스냅샷이 없으면
   `analysis_required`, 재검토는 스냅샷을 받지 않음, `recordAdoptionDecision`은 스냅샷 필수.
   DB CHECK: `exclude`·`adopt`는 `btrim(analysisSnapshot) <> ''`, `reopen`은 스냅샷 NULL.
3. **제외됨 보기 조회.** `DISTINCT ON ("workItemId") … ORDER BY "workItemId", "occurredAt" DESC, "id" DESC`
   raw SQL로 item당 최신 제외 한 건만 DB에서 고릅니다. 재제외 통합 테스트 추가.
4. **대화상자 복구.** `FAMILY_MISMATCH`·`QUEUE_TOO_LARGE`도 대화상자를 닫고 다시 불러오며,
   문구는 catalog(en/ko)에 있습니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
