# Provider Model Catalogue 후보 필터 변경 — 독립 검토 요청 (2026-09-11)

## 검토 대상

- worktree: `H:\Project\tomverse-pmc-candidate-filter-20260911`
- branch: `claude/to-develop/provider-model-catalogue-candidate-filter` (base `origin/develop` = `30e03752`)
- 변경 파일: `git diff origin/develop --stat` 참조 (lib/modelLifecycleTriage.ts,
  lib/modelLifecycleWorkItemCore.ts, lib/modelLifecycleWorkItems.ts,
  lib/providerModelCatalogMonitor.ts, lib/providerModelCatalogReport.ts,
  app/api/internal/provider-model-catalog/check/route.ts,
  components/admin/AdminModelDiscoveryPanel.tsx,
  scripts/close-filtered-model-lifecycle-items.mjs, package.json, tests/\*)

## 고치려던 것 (운영자 신고 3건)

1. preview·beta·experimental 모델이 여전히 검토 큐에 들어온다.
2. 어제 No Action으로 닫은 모델이 오늘 다시 들어온다.
3. 같은 라인의 최신 버전을 이미 서비스 중인데 하위 버전이 권장 목록에 남는다.

## 변경 요지

- `PRERELEASE_MARKER`에 `exp|alpha|rc\d*|nightly|canary|early-access` 추가.
  `dev`·`draft`·`test`는 **의도적으로 제외**(FLUX.1-dev, speculative decoding
  draft 모델은 실제 서비스 모델).
- `candidateFamilyIdentity`를 고정 2회 → 변화가 없을 때까지 반복 제거로 바꾸고
  `-MM-DD`·`-MM-YYYY`·`-YYYY-MM` 날짜 패턴 추가.
- `candidateDecisionKey = family@stage` + `decisionSuppressesCandidate` 도입.
  stable 결정은 prerelease까지 억제하고, prerelease 결정은 stable을 억제하지 않음.
  결정 키를 `evidence.decisionKey`에 생성 시점에 저장.
- `modelLine`/`modelVersion`/`supersedingServedModel`/`newestByModelLine` 도입.
  파싱 실패(`version === null`)면 절대 억제하지 않음.
- `newCandidatesForQueue` → `selectQueueCandidates`(fresh + suppressed 반환).
- 일간 리포트의 "오늘의 신규 후보"를 관측 행(`newCandidates`)이 아니라 **큐가
  실제로 생성한 항목**에서 만들고, 큐 write 실패 시에는 옛 경로로 되돌림.
- 기존 큐 정리용 `npm run cleanup:model-lifecycle-queue`(dry run 기본,
  `--apply --actor` 필요, 상태기계 경유).

## 특별히 봐 주었으면 하는 것

1. **과도 억제(가장 큰 위험).** `modelLine`의 세그먼트 파서가 서로 다른 제품을
   같은 line으로 묶어 새 모델을 조용히 떨어뜨릴 수 있습니까? 특히:
   - 티어 단어가 없는 이름(`grok-4`, `sonar`, `kimi-k3`, `moonshot-v1-8k`)
   - 이름에 숫자가 붙은 형태(`qwen3-max`, `o4-mini`, `gpt-4o`)
   - 연속 정수 규칙(`claude-opus-4-6` → [4,6])이 날짜/컨텍스트 크기를 버전으로
     오독하는 경우
2. **과도 병합.** 새 `DATED_SUFFIXES`와 반복 제거 루프가 서로 다른 세대를 한
   family로 묶을 수 있습니까? (`gpt-5.5` vs `gpt-5.6`는 반드시 달라야 함)
3. **결정 원장의 stage 규칙.** preview No Action → GA 모델이 다시 올라오는
   경로가 실제로 열려 있습니까? 반대로 stable No Action이 영구 억제가 되는 것이
   맞습니까?
4. **리포트 회귀.** `candidateRowsFor`가 `discovery.recorded === false`일 때
   옛 경로로 되돌아가는 분기가 "오늘 신규 없음"을 잘못 주장하지 않습니까?
5. **저장소 계약 위반 여부.** 자동화가 결정하지 않는다(`actorEmail` 필수),
   조용한 누락 금지, 은퇴 감지 경로 불변 — 이 셋을 어디선가 깨고 있습니까?
6. `retire` 액션 항목에 supersession을 적용하지 않도록 막은 것이 충분합니까?

## 실행 방법

로컬 PowerShell, 위 worktree 폴더 안. Node 22, `node_modules`는 상위 clone에
junction으로 연결돼 있습니다. production 자격증명 불필요, 전부 읽기 전용입니다.

```powershell
npm run typecheck
node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-lifecycle-triage.test.ts tests/model-lifecycle-work-item-core.test.ts tests/modelOwner.test.mjs tests/provider-model-catalog-core.test.ts
```

전체 `npm run test:unit`은 이 환경에서 7건이 **변경 전에도** 실패합니다
(Git Bash 경로 `H:\H:\...` 스캔 테스트 6건 + Windows 실행 비트 1건). 기준선과
동일함을 확인했습니다.

## 원하는 산출물

발견한 결함을 심각도 순으로, 각 항목에 **재현 입력 → 잘못된 출력**을 적어
주세요. 결함이 없으면 없다고 적어 주세요. 코드는 수정하지 마세요.
