# 제품 경계 v1.2 staging 검증 체크리스트

제품 경계 결정 기록 v1.2(PR #831)를 production으로 승격하기 전에 staging에서
확인하는 항목입니다. 계약은 `docs/policy/conversation-product-key.md`,
`docs/policy/routing-run-product-attribution.md`,
`docs/ui-contracts/auto-model-selection.md`입니다.

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신하고 실행자가 보고한
관측을 기록 초안에 옮겨 적을 수 있습니다. 쓸 수 없는 것은 **판정과 서명**뿐이며,
지어낸 관측은 어느 쪽에서도 허용되지 않습니다 — 기록 README의 5번 참조.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는
`product-boundary-v1-2-staging-verification-records/`에 **날짜와 전체 deploy
SHA로 이름 붙인 별도 파일**로 남습니다.

- **template revision**: `2026-08-23b`
- 실행 방법과 파일 이름 규칙:
  `product-boundary-v1-2-staging-verification-records/README.md`
- 기록 template:
  `product-boundary-v1-2-staging-verification-records/_record-template.md`

## 무엇이 복구 불가인가 — 항목별 판정

`AGENTS.md`의 기준은 하나입니다. **무엇이 복구 불가인지 한 줄로 적을 수 없으면
차단이 아닙니다.** 이 변경의 표면을 하나씩 통과시킨 결과입니다.

| 표면 | 복구 가능한가 | 판정 |
|---|---|---|
| `Conversation.productKey` 컬럼 추가 | nullable·default 없음 → **행을 스캔하지 않는 metadata-only**. 되돌리면 잃을 데이터가 없는 새 컬럼 | 차단 아님 |
| `Conversation` NOT VALID CHECK 3종 | 기존 행을 검증하지 않음. `DROP CONSTRAINT`로 즉시 제거 | 차단 아님 |
| `RoutingRun` 인덱스 2개 + 즉시 검증 FK | **배포 중 쓰기를 막습니다.** 막힌 동안 실패한 턴은 되돌릴 수 없음 | **차단 A-1** |
| 새 `productKey` 값이 틀리게 저장됨 | 아직 아무 reader도 읽지 않음(`PRODUCT_KEY_READ_MODE` 미배선). `UPDATE`로 정정 가능 | 차단 아님 |
| 대화 생성 경로가 깨짐 | 고쳐서 배포하면 끝. 다만 **폭발 반경이 전체**이고 확인이 무료 | **차단 B** |
| 이름이 바뀐 이메일 | **발송된 메일은 회수되지 않습니다.** `buildAccountWelcomeEmail`과 billing 계열은 render 테스트가 없습니다 | **차단 C** |
| Stripe line item 이름 | 발행된 invoice는 수정 불가하나 크레딧노트·재발행이 성립. `AGENTS.md`가 잘못된 과금을 되돌릴 수 있음으로 분류 | 차단 아님 |
| SEO·OG·`SITE_NAME` | 색인은 재크롤로 회복. 기준값도 16개월은 남으나, **property가 검증돼 있지 않으면 소급 수집이 없음** | **배포 전 선행 P-1** |
| 생성 파일 `dc:creator` | 다운로드된 파일은 회수 불가하나, 아무 표면도 읽지 않는 메타데이터 | 차단 아님 |
| 공유·export 표기 | 고쳐서 배포하면 끝 | 차단 아님 |
| Auto 토글·배지 마운트 | 모든 계정에서 `offered=false`라 **아무것도 렌더하지 않음**. CI의 desktop·mobile `@ui-risk`가 증명 | 차단 아님 |
| `/review` alias | `noindex`이고 아무 링크도 가리키지 않음 | 차단 아님 |

**backfill은 이 회차의 대상이 아닙니다.** 실행되지 않았고, 실행에는 별도 승인과
dry-run 보고서가 필요합니다(`docs/ops/product-key-transition.md` §3).

## 필수는 7항목, 유료 1 turn

**이것만 하면 이 회차는 성립합니다.** 배포 전 선행 1건은 staging 항목이 아니라
순서의 문제입니다.

| 항목 | 무엇을 판별하는가 | 비용 |
|---|---|---|
| **P-1** | Search Console 기준값 — 깨끗한 시점에 찍어 두는 **순서**의 문제 | 무료 · 배포 전 |
| **A-1** | `RoutingRun` 크기 → 인덱스 락이 턴 쓰기를 막는 시간 | 무료 |
| **A-2** | 마이그레이션이 실제로 적용되고 얼마나 걸리는가 | 무료 |
| **B-1** | 새 대화가 만들어지고 `productKey`가 실제로 저장되는가 | 무료 |
| **B-2** | 기존 대화가 계속 열리는가 | 무료 |
| **B-3** | 턴이 실제로 답하는가 | **유료 1 turn** |
| **C-1** | render 테스트가 없는 welcome 메일이 실제로 렌더되는가 | 무료 |

`C-2`(billing 메일)는 Stripe test mode가 있으면 무료로 함께 하십시오. 없으면
`미기록`입니다 — billing builder도 render 테스트가 없다는 사실은 기록에 남습니다.

나머지 D 구획은 **선택**입니다. 하면 좋지만, 안 해도 이 회차는 유효하고 건너뛴
것은 기록의 `미기록`입니다.

<details>
<summary>전체를 다 할 때 — 14항목, 유료 2 turn</summary>

| 구획 | 항목 | 유료 turn |
|---|---|---|
| P 배포 전 선행 | 1 | 0 |
| A 마이그레이션 안전성 | 2 | 0 |
| B 대화 경로 | 3 | 1 |
| C 회수 불가 표면 | 2 | 0 |
| D 선택 | 6 | 1 |

</details>

---

## 배포 전 선행 — staging 항목이 아닙니다

- [ ] **P-1** Search Console에서 `Tomverse Insight`의 **최근 28일과 90일**
      노출·클릭·진입 페이지를 저장한다.

  `"Tomverse Review — formerly Tomverse Insight"` 병기를 **얼마나 오래
  유지할지**를 정하는 유일한 근거입니다
  (`docs/ops/tomverse-review-rename.md` §5.1–§5.2).

  **먼저 §5.1을 보십시오.** 이미 확보된 회차가 있으면 다시 추출하지 않습니다.
  이 항목이 다시 필요해지는 것은 그 뒤에 또 이름이 바뀔 때입니다.

  순서의 문제이지 회수 불가는 아닙니다. 성능 데이터는 16개월 보존이고 이름이
  바뀌어도 과거 질의 행은 남습니다. 소급이 불가능한 경우는 **property가 아직
  검증돼 있지 않은 경우** 하나뿐이며, 그때는 검증 자체가 배포보다 먼저입니다 —
  검증 이전 기간은 채워지지 않습니다.

  기록에는 숫자 자체가 아니라 **저장한 위치와 시각**을 적습니다.

---

## A. 마이그레이션이 이 production에서 안전한가

- [ ] **A-1** production 데이터베이스에 대고 실행한다.

  ```
  npm run report:routing-dispatch-readiness
  ```

  판정은 **`RoutingRun` 행 수**로 합니다. 이 숫자는 데이터베이스에서 읽으니
  그대로 믿을 수 있습니다.

  preflight에 찍히는 `ROUTING_DISPATCH_INSTRUMENTATION` 줄은 **참고만**
  하십시오. 리포트가 스스로 밝히듯(#839) 그 줄은 **리포트를 실행하는 프로세스의
  환경**이지 행을 쓴 서버의 환경이 아닙니다 — 배포된 서버는 부팅 시점의 값을
  들고 있습니다. 그러니 "off로 보이니 행이 없겠지"로 건너뛰지 말고 행 수를 직접
  보십시오. 행이 0이면 이 항목은 여기서 끝납니다.

  판별 대상은 이것입니다. 마이그레이션
  `20260822093000_routing_run_product_attribution`은 `RoutingRun`에 인덱스
  **2개**를 `CONCURRENTLY` 없이 만들고, 그 다음 FK를 **즉시 검증**으로 겁니다.
  `CREATE INDEX`는 SHARE 락을 잡아 **그 테이블의 쓰기를 막고**, `RoutingRun`은
  **디스패치된 턴마다 한 행**입니다. 막히는 쓰기가 곧 채팅 턴입니다.

  저장소가 이미 같은 판단을 문장으로 남겨두었습니다
  (`20260815030000_perplexity_async_job_updated_at_index`):

  > Created concurrently is not available inside Prisma's migration
  > transaction, and this table is small enough that the brief lock is not
  > worth splitting the migration over: **it holds one row per deep research
  > request, not per message.**

  `RoutingRun`은 그 문장이 명시적으로 제외한 쪽입니다.

  | 관측 | 다음 행동 |
  |---|---|
  | 행이 0이거나 적음 | 그대로 배포. 선례가 그대로 적용됨 |
  | 행이 많음 | **배포하지 말고 마이그레이션을 쪼갠다** — 인덱스를 별도 파일의 `CREATE INDEX CONCURRENTLY`로, FK를 `NOT VALID` + 후속 `VALIDATE`로 |

  두 번째는 **코드 변경**입니다. 그래서 이 항목이 배포 전에 있습니다. "많음"의
  경계는 이 저장소가 아니라 이 production의 쓰기량이 정하므로, 행 수와 함께
  **평소 분당 턴 수**를 기록에 적고 사람이 판정합니다.

- [ ] **A-2** staging에 `prisma migrate deploy`를 적용하고 **각 마이그레이션의
      소요 시간**을 적는다.

  `20260822090000_conversation_product_key_expand`는 nullable 컬럼과 NOT VALID
  제약뿐이라 **테이블 크기와 무관하게 즉시**여야 합니다. 여기가 느리면 그
  자체가 관측입니다 — 예상과 다른 무언가가 있다는 뜻이고, A-1의 판정을 다시
  봐야 합니다.

  적용 후 확인:

  ```sql
  SELECT conname, convalidated FROM pg_constraint
   WHERE conrelid = '"Conversation"'::regclass AND conname LIKE '%product%';
  ```

  세 제약이 모두 `convalidated = false`여야 합니다. `true`가 하나라도 있으면
  누군가 손으로 validate한 것이고, schema 비교가 drift로 잡습니다.

---

## B. 대화가 계속 만들어지고 답한다

이 구획은 한 자리에서 이어집니다. 항목을 나눈 것은 어디서 멈췄는지가 기록에
남게 하기 위해서입니다.

- [ ] **B-1** staging에서 새 대화를 하나 만들고, 저장된 행을 확인한다.

  ```sql
  SELECT id, kind, "selectionMode", "productKey"
    FROM "Conversation" ORDER BY "createdAt" DESC LIMIT 1;
  ```

  기대: `productKey = 'review'`, `kind = 'chat'`, `selectionMode = 'manual'`.

  판별 대상은 값이 아니라 **경로**입니다. 세 writer가 전부
  `lib/conversationCreation.ts`를 지나도록 바뀌었고, `productKey`는 선택이 아닌
  필수 인자입니다. `NULL`이 나오면 공통 서비스를 지나지 않은 경로가 남아 있다는
  뜻이고, 그것이 `check:conversation-writers`가 CI에서 막으려는 것입니다.

- [ ] **B-2** 배포 **이전에** 존재하던 대화를 연다.

  기대: 정상적으로 열리고, 응답의 `autoSelection.offered`가 `false`.
  그 대화의 `productKey`는 `NULL`입니다 — 아직 backfill하지 않았으니 정상입니다.

  판별 대상: 채팅 라우트의 대화 읽기가 cohort 조건에서 풀렸고
  (`productKey`를 cohort보다 먼저 읽어야 하므로), 그 읽기가 깨지면 **모든 턴이
  깨집니다.**

- [ ] **B-3** 그 대화에서 메시지 하나를 보낸다. **유료 1 turn.**

  기대: 답변이 정상 도착. Auto 배지는 **없어야 합니다** — 라우팅되지 않은
  턴이므로.

  A-1에서 recording이 켜져 있었다면 함께 확인합니다:

  ```sql
  SELECT "conversationId", "productKey", mode FROM "RoutingRun"
   ORDER BY "createdAt" DESC LIMIT 1;
  ```

  기대: `conversationId`가 채워져 있고(이전에는 받고 버렸습니다),
  `productKey`는 그 대화의 저장값 — 즉 backfill 전이므로 `NULL`. `mode`는
  `manual`. **`NULL`이 정상이라는 점이 이 항목의 요점입니다**: 과거 행을 근거
  없이 추정하지 않는다는 결정이 실제로 그렇게 동작하는지 봅니다.

---

## C. 회수되지 않는 표면

- [ ] **C-1** staging에서 계정을 하나 만들고 **welcome 메일을 실제로 받는다.**

  확인: 제목·본문·발신 표시 이름에 `Tomverse Insight`가 **없을 것**.

  이 항목이 필수인 이유는 문구가 중요해서가 아니라 **`buildAccountWelcomeEmail`에
  render 테스트가 없기 때문입니다.** `buildAccountDeletionScheduledEmail`과
  `buildAccountRestoredEmail`은 `tests/accountLifecycleEmails.test.mjs`가
  렌더까지 확인하므로 여기서 다시 볼 필요가 없습니다. 메일은 회수되지 않으므로,
  테스트가 덮지 않는 경로만 사람이 한 번 봅니다.

- [ ] **C-2** Stripe **test mode**에서 결제를 한 번 완료한다. *(test mode가
      없으면 `미기록`)*

  확인 두 가지 — Checkout 화면의 line item 이름, 그리고 도착한 billing welcome
  메일. billing builder 계열도 render 테스트가 없고, `lib/billingEmails.ts`에는
  이름이 바뀐 문자열이 가장 많습니다.

---

## D. 선택 — 안 해도 이 회차는 성립합니다

- [ ] **D-1** 이미지 대화를 하나 만든다. **유료 1 turn.**
      기대: `productKey = 'studio'`, `kind = 'image'`. 제품 라벨이
      `Tomverse Studio`. 세 writer 중 이미지 경로를 실제로 지나는 유일한 항목입니다.
- [ ] **D-2** 게스트 대화를 만들고 계정으로 이관한다.
      기대: `productKey = 'review'`. 이관은 소유권을 옮길 뿐 제품을 바꾸지 않습니다.
- [ ] **D-3** 공유 링크를 하나 만들어 로그아웃 상태로 연다. 표기 확인.
- [ ] **D-4** 대화 TXT export와 전체 export를 받는다. 헤더 표기 확인.
- [ ] **D-5** `/review`가 200을 반환하고 `/chat`과 같은 화면을 그리는지,
      그리고 `noindex`인지 확인한다. 아직 아무 링크도 여기를 가리키지 않습니다.
- [ ] **D-6** staging에서 backfill **dry-run**을 돌린다.

      ```
      npm run report:product-key-backfill
      ```

      기대: `selectionMode='auto'` 추출 **0건**. 0이 아니면 그 행들은 사람이
      개별 확인할 대상이고, production에서 같은 보고서를 돌리기 전에 알아두는
      편이 낫습니다. **쓰기는 하지 않습니다.**

---

## 이 회차가 답하지 않는 것

- **production backfill.** 별도 승인·실행자·티켓·dry-run digest가 필요하고
  (`docs/ops/product-key-transition.md` §3), 이 체크리스트의 대상이 아닙니다.
- **`VALIDATE CONSTRAINT`와 `NOT NULL`.** 각각 별도 마이그레이션이고 각각 별도
  증거를 갖습니다(`docs/policy/conversation-product-key.md` §7).
- **Auto가 실제로 라우팅하는가.** readiness gate 3개가 전부 `pending`이고 flag는
  꺼져 있습니다. 이 회차에서 **켜지 마십시오.**
- **Tomverse Chat 노출.** `/chat`의 의미는 바뀌지 않았습니다.
