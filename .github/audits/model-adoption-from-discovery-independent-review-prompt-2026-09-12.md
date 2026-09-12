# 발견 큐 → 레지스트리 채택 기능 — 독립 검토 요청 (2026-09-12)

## 검토 대상

- worktree: `H:\Project\tomverse-model-adoption-20260912`
- branch: `claude/to-develop/model-adoption-from-discovery` (base `origin/develop` = `752547a9`)
- `git diff origin/develop` 로 전체 변경을 봅니다.

## 무엇을 만들었는가

`/admin/models`의 두 탭(discovery / registry)은 지금까지 연결돼 있지 않았습니다.
운영자가 발견 큐에서 모델을 채택하기로 정하면, 식별자를 눈으로 읽고 탭을 옮겨
빈 폼에 전부 다시 타이핑했고, work item은 모델이 추가됐다는 사실조차 몰랐습니다.

- `lib/modelAdoptionDraft.ts` (순수) — 스캔이 이미 저장한 값으로 폼 초안을 만들고,
  가격이 주어지면 **크레딧 하한**을 계산합니다.
- `GET /api/admin/model-lifecycle/adoption-draft?workItemId=` — 초안 조회(부작용 없음).
- `POST /api/admin/models?workItemId=` — 레지스트리 행 생성 + work item 전이 +
  `modelId` 연결을 **한 트랜잭션**으로 처리.
- `adoptionTransitionPath()` — 현재 상태에서 `validation_pending`까지의 전이 경로.
- UI — 발견 행의 "채택" 버튼 → `?tab=registry&adopt=<id>` → 초안이 채워진 모달,
  가격을 입력하면 하한이 실시간 계산됨.

## 설계 전제 (검토해 주실 것)

1. **크레딧 하한 산식.** `lib/chatCostGuardrails.ts`의 guardrail 유도를 반대로
   돌린 것입니다: 최악 턴 = `128,000 × 입력단가 + 출력한도 × 출력단가`(micro-USD),
   덮는 조건 = `credits × 입력배수(3) × COST_PER_CREDIT_CEILING_MICRO_USD(40,000)`.
   - 이 산식이 실제 과금과 어긋나는 지점이 있습니까? (reasoning 토큰 과금, cache
     write premium, native search 추가요금, tier별 가격 구간을 무시하고 있습니다)
   - "하한"이라고 부르는 것이 정당합니까, 아니면 어떤 경우 실제보다 낮게 나옵니까?
2. **전이 경로 자동 주파.** `discovered`에서 채택하면 네 번의 전이를 한 트랜잭션에서
   수행하고, `approved` 홉에는 "Adopted into the registry as <id>." 라는 결정 사유를
   기록합니다. 이것이 "자동화는 결정하지 않는다" 계약을 깨는 것입니까? 저는
   **폼을 채워 저장한 것이 곧 사람의 결정**이고 모든 홉에 실행자 이메일이 남으므로
   괜찮다고 판단했습니다 — 반대 근거가 있으면 지적해 주세요.
3. **초안이 채우지 않는 것.** 가격·판매 등급·최소 플랜·예약 출력 토큰·추론 강도는
   비워 두고 `unknowns`로 이름만 답니다. 반대로 **채운 것**(컨텍스트 윈도우, 최대
   출력, 이미지 입력, 표시명, id)이 잘못 채워질 수 있는 경우가 있습니까?
4. **`status: "coming-soon"` + `publiclyListed: false` 기본값.** 새 모델이 꺼진 채로
   태어나게 했습니다. 기존 폼 기본값(`disabled` / `publiclyListed: true`)과 다른데,
   이 변경이 기존 "새 모델 추가" 흐름(채택이 아닌 경우)에는 영향을 주지 않는지
   확인해 주세요.
5. **트랜잭션 경계.** 전이가 거부되면 `AdoptionRefused`를 던져 레지스트리 행까지
   롤백합니다. `transitionWorkItems`가 같은 tx에서 `FOR UPDATE`를 잡는데, 이 중첩이
   교착이나 부분 적용을 만들 수 있습니까?
6. **registry id 생성.** `gpt-5.6-sol` → `gpt-5-6-sol`. 충돌 시 `-2` 접미사.
   `catalogDeleted` 행까지 포함해 중복을 피하는데, 더 나쁜 충돌 경로가 있습니까?

## 실행 방법

로컬 PowerShell, 위 worktree 폴더 안. Node 22, `node_modules`는 상위 clone에 junction으로
연결돼 있습니다. production 자격증명 불필요, 전부 읽기 전용입니다.

```powershell
npm run typecheck
node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-adoption-draft.test.ts tests/model-lifecycle-work-item-core.test.ts
```

전체 `npm run test:unit`은 이 환경에서 7건이 **변경 전에도** 실패합니다(Git Bash 경로
스캔 6건 + Windows 실행 비트 1건).

## 원하는 산출물

`codex-review-findings.md` 파일에 발견한 결함을 심각도 순으로, 각 항목에 **재현 입력 →
잘못된 출력**과 파일:라인을 적어 주세요. 소스 코드는 수정하지 마세요.
