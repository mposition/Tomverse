# 독립 검토 결과 — Provider catalogue 필드 수집 P0

검토자: codex (독립 실행)
대상: `claude/to-develop/provider-catalog-field-coverage`, base `origin/develop` d61f2075
요청서: `provider-catalog-field-coverage-independent-review-prompt-2026-09-12.md`

## 1차 라운드 — P1 1건, P2 4건

### P1-1. `active: false`가 신규 후보 진입만 막음 — 반영함

`lib/providerModelCatalogCore.ts`, `lib/providerModelCatalogMonitor.ts:311`,
`lib/modelLifecycleWorkItems.ts:690`

관측 자체는 계속 저장되고 `lifecycle === null`이므로 등록 모델은
`status: "available"`, 큐는 `availability: "current"`가 되고 기존 add work item은
열린 채 남습니다. 즉 **Groq가 꺼 버린, Tomverse가 이미 서비스 중인 모델**에 대해
운영자가 어디서도 통지를 못 받습니다.

**반영:** `lifecycleFromRecord`가 Groq의 `active === false`를 `lifecycle:
"inactive"`로 승격합니다. `lifecycle`은 이 사실이 닿아야 하는 네 곳
— observation의 `available`, 스캔의 entry status, 일일 리포트의 lifecycle 경고,
큐의 availability 컬럼 — 이 **모두 읽는 유일한 통로**입니다
(`modelLifecycleWorkItems.ts`는 catalogue entry에서 `lifecycle`만 select합니다).

은퇴 어휘(`legacy`/`deprecated`/`retired`/`archived`/`sunset`)에 섞지 않고 자기
단어를 씁니다. Groq가 모델을 끈 것은 폐기 공지가 아니고, 리포트는 이 문자열을
그대로 출력합니다. `assessModelLifecycleItem`은 non-null lifecycle을
`no_action`으로 판정하므로 결과 문구도 정확합니다.

`shouldQueueProviderCatalogObservation`의 중복 검사는 **제거**했습니다 —
`lifecycle === null`이 이미 덮고, 두 검사가 있으면 서로 어긋날 자리가 생깁니다.

### P2-1. Groq 전용 의미가 12개 공급자 전체에 적용됨 — 반영함

**반영:** `providerReportedInactive`가 `provider === "groq"`로 한정합니다.
다른 공급자가 `active`를 다른 뜻으로 쓰면 진짜 모델이 발견에서 조용히
빠지는데, 그것이 `openai_prefix_heuristic`이 드러내려고 존재하는 실패입니다.
`metadata.active`도 Groq 외에는 `null`로 둡니다 — 기록만 하고 아무도 안 쓰는
필드는 나중에 누군가 쓰게 되는 자리입니다.

### P2-2. 빈 배열과 필드 부재가 구분되지 않음 — 주석을 코드에 맞춤

주석이 `null`과 `[]`를 구분한다고 했으나 `modalities([])`는 `null`을 반환합니다.

**반영: 코드가 아니라 주석을 고쳤습니다.** 두 해석 중 틀렸을 때 대가가 있는
쪽은 하나뿐입니다 — `[]`를 "지원 없음"으로 읽으면 채택 초안에 공급자가 부정한
적 없는 `supportsImage: false`가 올라가고, 운영자는 아무도 주장하지 않은
capability를 승인하게 됩니다. 계약상 항상 채워지는 필드가 비어 온 것은 비정상
응답이고, 비정상 응답에서 부정 capability를 유도하지 않습니다.

### P2-3. `effortLevels`를 수집했으나 채택 초안은 반대로 안내 — 반영함

초안이 `"추론 강도 — 공급자가 thinking 지원을 알렸을 뿐 등급은 알리지 않습니다."`
를 출력하는데, Anthropic 응답은 `capabilities.effort`로 단계를 전부 알립니다.

**반영:** `AdoptionObservation.metadata.effortLevels` 추가, adoption-draft
route가 전달, 문구가 관측된 단계를 명시합니다. 레지스트리 `reasoning`으로
자동 매핑은 **하지 않습니다** — 그것은 공급자의 어휘이고, 어느 단계로 파는지는
제품 결정입니다.

### P2-4. 기존에 오염된 큐 항목은 파서 수정으로 사라지지 않음 — 반영함

파서 수정은 내일의 스캔만 지배합니다. 이미 만들어진 `ModelLifecycleWorkItem`은
열린 채 남고, backfill을 다시 돌리면 재생성됩니다.

**반영:** `scripts/close-filtered-model-lifecycle-items.mjs`가
`foreign_product_surface`를 닫기 사유로 추가합니다. 이 스크립트의 선언된 목적이
정확히 "오늘의 필터라면 안 걸었을 항목을 닫는 것"입니다. 실행은
`npm run cleanup:model-lifecycle-queue -- --apply --actor <email>`이며 기본은
dry run입니다.

이 사유만 `(provider, apiModel)`로 판정합니다 — 나머지는 모델에 대한 사실이고,
이것은 **어느 endpoint가 그 항목을 걸었는가**에 대한 사실이기 때문입니다.

## 검토자가 확인한 사항 (수정 불필요)

- boolean fallback의 `??` 체인이 기존의 명시적 `false`를 보존함
- 숫자 `||`가 `0`을 건너뛰지만 token limit은 양수 계약이라 실패 경로 없음
- 새 metadata 값이 전부 scalar 계약을 지킴
- xAI 관측 가격이 파서와 테스트 밖에 소비자가 없고, adoption route가 allowlist
  방식이라 검증 가격 경로로 새지 않음
- 현행 Sonar 모델 ID가 전부 `sonar*`이라 Perplexity 정규식이 현행 모델을 막지 않음
- `heuristicallyExcluded`에 문서화된 제품 경계를 넣지 않은 판단이 타당함

## 확인 라운드 — 미완료

수정 반영 후 확인 라운드를 요청했으나 codex가 **사용량 한도**에 걸려
(복구 예정 2026-09-19) 판정을 받지 못했습니다. 대신 저장소에서 직접 확인한 것:

- `lifecycle` 소비자 전수 확인 — `providerModelCatalogReport.ts:243`과
  `AdminModelDiscoveryPanel.tsx:701`은 문자열을 그대로 출력하고, 값을 보고
  판정하는 곳은 `assessModelLifecycleItem` 하나뿐이며 non-null을 `no_action`으로
  읽습니다. allowlist나 switch가 없으므로 `"inactive"`가 깨뜨리는 곳은 없습니다.
- `ProviderModelCatalogEntry.status`에는 DB 제약이 없고, 이번 변경은 새 status
  값을 만들지 않습니다(`lifecycle_warning`을 재사용).

**이 라운드가 끝나지 않았다는 사실을 병합 판단의 입력으로 남깁니다.**

## 검증

- `npm run typecheck` 통과
- `npm run check:encoding:strict` 통과
- `npm run check:model-pricing` 통과 (36 profiles, 0 unpriced)
- 변경 파일 `eslint --max-warnings=0` 통과
- `tests/provider-model-catalog-core.test.ts` 36건 통과 (신규 13건)
- `npm run test:unit` — 실패 1건, `H:\H:\Project\...`로 드라이브 접두사가
  중복된 `providerErrorClassification.test.mjs`의 디렉터리 walk. assertion이
  아니라 Windows 경로 문제이고 이 변경과 무관합니다(러너 exit 0).
