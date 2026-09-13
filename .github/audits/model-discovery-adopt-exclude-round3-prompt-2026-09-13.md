# 3차 검토 요청 — 발견 대기열: 채택·제외, 재검토

2차 P2 6건에 대한 대응입니다. `git diff`(intent-to-add 포함)를 다시 봐 주세요.

## 대응

1. **요청 크기 / 4. 숨은 구성원의 분석.** 제외 요청을 패밀리 단위로 바꿨습니다:
   `families: [{representativeId, workItemIds, shownAnalysisFingerprint}]`. 운영자가 읽은 것은
   대표 행 하나이므로, 서버는 대표의 분석을 계산해 fingerprint(16 hex, `analysisFingerprint`)를
   비교하고, 일치하면 **대표의 분석을 모든 구성원 이벤트에 기록**합니다. 구성원이 대표와 다른
   패밀리면 409 `FAMILY_MISMATCH`, 대표가 구성원에 없으면 같은 409. 문장을 보내지 않아
   200건 벌크가 64 KiB 안에 들어갑니다(contract 테스트로 고정). 대표가 이미 채택 진행 중이라
   제외 대상에서 빠지면 패널이 대화상자를 열지 않습니다.
2. **채택 사유 1,001자.** route가 1,000자 초과를 400으로 거부하고, 폼 입력에 `maxLength`를
   두었으며, 서비스 `workItemDecisionRecordRefusal`이 `adopt`에도 길이·공백을 검사합니다.
3. **보기 전환 경쟁.** `switchView`가 세대를 즉시 올립니다.
5. **이미 `approved`·`implementation_pending`인 item의 채택.** 채택 기록을 `approved` 단계에 붙이지
   않고, 채택 경로를 끝낸 뒤 **별도 기록 이벤트**(`recordAdoptionDecision`, `fromStatus = toStatus`,
   `validation_pending`·`rollout_pending`·`communication_pending`만)로 남깁니다. 따라서 어느 상태에서
   채택하든 기록이 생깁니다. DB CHECK도 이 모양만 허용하고, 일일 요약의 전이 수에서 이 이벤트를
   뺍니다. `transitionWorkItems`는 `adopt`를 거부합니다.
6. **§51 API 계약** 갱신.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
