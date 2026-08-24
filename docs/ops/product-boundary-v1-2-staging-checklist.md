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

- **template revision**: `2026-08-24a`
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
| 이름이 바뀐 이메일 | **발송된 메일은 회수되지 않습니다.** `buildAccountWelcomeEmail`과 billing 계열은 render 테스트가 없습니다 | **차단 C** (폐기명만. 브랜드 층위는 관측 — `docs/ops/tomverse-review-rename.md` §7) |
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
| **A-2** | 마이그레이션이 실제로 적용됐는가, 그리고 얼마나 걸렸는가 | 무료 |
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
  ROUTING_READINESS_WINDOW_DAYS=3650 npm run report:routing-dispatch-readiness
  ```

  **환경변수를 빼지 마십시오.** 기본 창은 7일이고
  (`scripts/report-routing-dispatch-readiness.mjs`의 `WINDOW_DAYS`), 그러면
  `Runs recorded`는 최근 7일에 쓰인 행 수가 됩니다. 이 항목이 묻는 것은
  **테이블 전체 크기**입니다 — 인덱스 빌드와 FK 검증은 7일치가 아니라 전부를
  훑기 때문입니다. 창을 넓히지 않고 읽은 숫자로 판정한 회차는 다른 질문에 답한
  회차입니다.

  판정은 `Runs recorded` 세 줄의 **합**으로 합니다. 이 숫자는 데이터베이스에서
  나오니 그대로 믿을 수 있습니다. 0이면 이 항목은 여기서 끝납니다.

  엄밀히 하려면 한 줄 더 봅니다. `mode`는 enum이 아니라 `String`이고
  (`prisma/schema.prisma`의 `model RoutingRun`), 리포트는 `manual`·`shadow`·
  `auto` 세 개만 출력하므로 다른 값의 행은 보이지 않습니다.

  ```
  psql "$DATABASE_URL" -c 'SELECT count(*) FROM "RoutingRun"'
  ```

  preflight의 `ROUTING_DISPATCH_INSTRUMENTATION` 줄은 **참고값**이고, 어디서
  실행했는지에 따라 의미가 다릅니다. 컨테이너 안에서(Railway 콘솔이나
  `railway ssh`) 돌렸다면 그 인스턴스의 실제 환경입니다. `railway run`으로
  돌렸다면 배포의 *설정*이지 행을 쓴 서버의 환경이 아닙니다 — 서버는 부팅 시점
  값을 들고 있습니다(#839). 어느 쪽이든 **"off로 보이니 행이 없겠지"로 건너뛰지
  말고** 행 수를 직접 보십시오. 기록에는 어디서 실행했는지를 함께 적습니다.

  ### 무엇이 얼마나 막히는가

  마이그레이션 `20260822093000_routing_run_product_attribution`은 `RoutingRun`에
  인덱스 **2개**를 `CONCURRENTLY` 없이 만들고, 그 다음 FK를 **즉시 검증**으로
  겁니다. 락은 두 테이블에 걸립니다.

  | 구문 | 락이 걸리는 테이블 | 막히는 것 |
  |---|---|---|
  | `ADD COLUMN` ×2 (nullable, default 없음) | — | metadata-only, 행을 안 봄 |
  | `CREATE INDEX` ×2 | `RoutingRun` | `RoutingRun` 쓰기 |
  | `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "Conversation"` | `RoutingRun` **과 `Conversation`** | 양쪽 쓰기 |
  | `ADD CONSTRAINT ... CHECK ... NOT VALID` | — | 스캔 없음 |

  **FK가 참조되는 테이블에도 락을 잡는다는 것이 이 항목의 핵심입니다.**
  PostgreSQL은 검증되는 외래키를 걸 때 제약이 붙는 테이블과 참조되는 테이블
  양쪽에 `SHARE ROW EXCLUSIVE`를 잡습니다. `RoutingRun`이 비어 있어도
  `Conversation`은 비어 있지 않습니다 — **대화마다 한 행**이고, 그 쓰기가 막히면
  새 대화와 대화 갱신이 막힙니다.

  그래서 위험을 정하는 것은 `RoutingRun`의 크기 자체가 아니라 **검증 스캔이
  얼마나 걸리는가**입니다. 스캔 대상이 `RoutingRun`이므로 그 크기가 곧 락을 쥐고
  있는 시간이고, 그 시간 동안 멈추는 것은 `Conversation` 쪽 트래픽입니다.

  저장소가 이미 같은 판단을 문장으로 남겨두었습니다
  (`20260815030000_perplexity_async_job_updated_at_index`):

  > Created concurrently is not available inside Prisma's migration
  > transaction, and this table is small enough that the brief lock is not
  > worth splitting the migration over: **it holds one row per deep research
  > request, not per message.**

  | 관측 | 다음 행동 |
  |---|---|
  | 행이 0이거나 적음 | 그대로 배포. 검증 스캔이 순간이므로 `Conversation` 락도 순간 |
  | 행이 많음 | **배포하지 말고 마이그레이션을 쪼갠다** — 인덱스를 별도 파일의 `CREATE INDEX CONCURRENTLY`로, FK를 `NOT VALID` + 후속 `VALIDATE`로 |

  두 번째는 **코드 변경**입니다. 그래서 이 항목이 배포 전에 있습니다.

  "많음"의 경계는 이 저장소가 아니라 이 production이 정하므로, 행 수와 함께
  **분당 쓰기 두 가지**를 기록에 적고 사람이 판정합니다.

  - `RoutingRun` 분당 쓰기 — `ROUTING_DISPATCH_INSTRUMENTATION`이 `observe`도
    `enforce`도 아니면 **0**입니다. 아무도 안 쓰는 테이블의 쓰기 차단은 비용이
    없습니다.
  - `Conversation` 분당 쓰기 — 이쪽은 recording 설정과 무관합니다. FK 구문이
    쥐는 락이 실제로 무엇을 멈추는지가 이 숫자입니다.

- [ ] **A-2** staging 배포 로그에서 **마이그레이션이 적용된 것과 걸린 시간**을
      확인하고, 제약 상태를 조회한다.

  **적용은 손으로 하지 않습니다. 이미 되어 있습니다.** staging 서비스는
  `develop`에서 배포되고 `preDeployCommand`가
  `npm run check:encoding:strict && npm run db:migrate`이며, `db:migrate`의
  끝이 `prisma migrate deploy`입니다(`package.json`). 즉 **develop에 머지되는
  순간 다음 배포가 적용합니다.** 이 항목은 그 일이 일어났는지를 확인하는
  것이지 일어나게 하는 것이 아닙니다.

  Railway에서 environment를 **staging**으로 두고, 마이그레이션이 develop에 들어온
  **직후의 배포**를 열어 deploy 로그를 `migrat`로 거릅니다. 찾는 것은 이
  네 줄입니다.

  ```
  N migrations found in prisma/migrations
  Applying migration `20260822090000_conversation_product_key_expand`
  Applying migration `20260822093000_routing_run_product_attribution`
  All migrations have been successfully applied.
  ```

  `Applying` 줄이 없는 배포는 이미 적용된 뒤의 배포입니다. **더 이전 배포를
  찾으십시오** — 없다고 판단하기 전에.

  ### 소요 시간은 합으로만 나옵니다

  로그 줄마다 타임스탬프가 붙지만 **마이그레이션별 소요 시간은 얻을 수
  없습니다.** `Applying` 두 줄과 `All migrations...` 줄의 타임스탬프가 마이크로초
  단위까지 같게 찍힙니다 — 플랫폼이 각 줄을 찍힌 시점이 아니라 **flush된 배치
  시점**으로 기록하기 때문입니다.

  그래서 기록에 적는 것은 `N migrations found`부터 `All migrations have been
  successfully applied.`까지의 **경과 시간 하나**이고, 그것은 두 마이그레이션을
  합친 **상한**입니다. 이 값을 한쪽 마이그레이션의 소요로 적지 마십시오.

  판별은 그 상한으로 충분합니다.
  `20260822090000_conversation_product_key_expand`는 nullable 컬럼과 NOT VALID
  제약뿐이라 **테이블 크기와 무관하게 즉시**여야 하고,
  `20260822093000_routing_run_product_attribution`은 A-1이 잰 `RoutingRun` 크기만큼
  걸립니다. 합이 짧으면 둘 다 짧습니다. **합이 예상보다 길면 그 자체가
  관측입니다** — A-1의 판정을 다시 봐야 한다는 뜻이고, 그때는 각각을 갈라 보기
  위해 staging에서 되돌린 뒤 하나씩 적용하는 별도 작업이 필요합니다.

  ### 제약 상태

  **찾는 이름을 먼저 늘어놓고 왼쪽 조인합니다.** 이름 패턴으로 거르지 마십시오 —
  이유는 아래에 있습니다.

  ```sql
  SELECT e.name, c.convalidated
    FROM (VALUES
      ('Conversation_product_key_check'),
      ('Conversation_product_modality_check'),
      ('Conversation_auto_only_chat_check'),
      ('RoutingRun_product_key_check'),
      ('RoutingRun_conversationId_fkey')
    ) AS e(name)
    LEFT JOIN pg_constraint c ON c.conname = e.name
   ORDER BY 1;
  ```

  다섯 행이 나와야 합니다. **`convalidated`가 `null`인 행은 그 제약이 없다는
  뜻**이고, 마이그레이션이 일부만 적용된 것이므로 A-2는 거기서 실패입니다.

  | 제약 | 기대 | 왜 |
  |---|---|---|
  | `Conversation_product_key_check` | `false` | `NOT VALID`로 걸었음 |
  | `Conversation_product_modality_check` | `false` | 〃 |
  | `Conversation_auto_only_chat_check` | `false` | 〃 |
  | `RoutingRun_product_key_check` | `false` | 〃 |
  | `RoutingRun_conversationId_fkey` | **`true`** | 유일하게 즉시 검증으로 걸린 제약 |

  `false`여야 할 자리에 `true`가 있으면 누군가 손으로 validate한 것이고, schema
  비교가 drift로 잡습니다. `true`여야 할 자리가 `false`면 FK가 검증되지 않은
  것이고, A-1이 `Conversation` 락을 따진 전제가 성립하지 않습니다.

  #### 이름 패턴으로 거르면 하나가 조용히 빠집니다

  이 항목은 한동안 `conname LIKE '%product%'`로 걸러고 있었고, 그 필터는
  **`Conversation_auto_only_chat_check`를 절대 반환하지 못합니다** — 이름에
  `product`가 없기 때문입니다. 마이그레이션이 만드는 CHECK 셋 중 하나가 검사
  범위 밖에 있었고, 실제 회차에서 네 행이 나온 것을 정상으로 읽을 뻔했습니다.

  그래서 위 쿼리는 이름을 명시하고 `LEFT JOIN`합니다. 빠진 제약이 **행이
  사라지는 대신 `null`로 보이게** 하려는 것이고, 이것이 A-2 전체를 관통하는
  규칙입니다 — **없는 것은 없다고 보여야 하지, 짧은 출력으로 보이면 안 됩니다.**

  ### 다음 항목으로 넘어가기 전에 — develop을 멈추십시오

  **staging은 develop에 머지될 때마다 재배포됩니다.** 기록 파일 이름은 deploy
  SHA **하나**인데, B와 C를 하는 동안 머지가 들어오면 항목마다 다른 SHA에서
  관측하게 되고 그 기록은 어느 커밋을 덮는지 말할 수 없게 됩니다 — 이 체크리스트
  구조가 존재하는 이유 그대로입니다(기록 README).

  A-2에서 SHA를 확정하고, **B-1부터 C까지를 그 배포 하나의 수명 안에서**
  끝내십시오. 중간에 재배포가 일어났다면 그 사실과 새 SHA를 기록에 적고, 앞선
  항목이 다른 빌드에서 관측됐다는 것을 남깁니다.

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

이 구획은 **서로 다른 두 가지**를 봅니다. 섞으면 둘 다 놓칩니다.

| | 질문 | 성격 |
|---|---|---|
| **(a) 폐기명** | `Tomverse Insight`가 남아 있는가 | **차단** |
| **(b) 브랜드 층위** | 새 이름이 맞는 층위에 있는가 | **관측·기록** |

(b)를 차단으로 올리지 않는 이유는 `AGENTS.md`의 기준 그대로입니다 — 층위가 어긋난
이름을 받은 사람이 잃는 것이 없습니다. 그래도 **메일은 회수되지 않으므로** 무엇이
나갔는지는 남겨야 합니다.

### (b)를 판정하는 법 — 문자열 검색으로는 안 됩니다

규칙은 `docs/ops/tomverse-review-rename.md` §7입니다. `Tomverse`는 상위 브랜드이자
공용 플랫폼이고, Chat·Review·Studio·Code는 그 아래 제품입니다. **이메일은 어느
화면에서 발생했는가가 아니라 무엇에 대해 책임지는가로 분류합니다.**

판정에 필요한 사실이 하나 있습니다. **현재 등록된 사용자 이메일 템플릿은 전부
플랫폼 공용입니다** — 로그인 코드, 계정 환영·삭제 예정·복구, billing welcome, founding
tester pass 3종, plan 변경, 모델 출시 (`lib/emailTemplateDefinitions.ts`). **제품 전용
이메일은 아직 하나도 없습니다.**

그래서 오늘 이 구획의 (b)는 한 줄로 판정됩니다:

> **제품명(`Tomverse Review` 등)을 쓰는 사용자 이메일은 전부 범위 불일치입니다.**
> 그것을 정당화할 제품 전용 이메일이 존재하지 않기 때문입니다.

`docs/ops/tomverse-review-rename.md` §7.6의 불일치 목록은 **이미 정리됐습니다.** 그러므로 플랫폼 공용 이메일에서
  제품명이 나오면 그것은 알려진 항목이 아니라 **회귀**입니다.

- [ ] **C-1** staging에서 계정을 하나 만들고 **welcome 메일을 실제로 받는다.**

  **(a) 폐기명 — 차단.** 제목·본문·발신 표시 이름에 `Tomverse Insight`가 **없을 것**.

  이 항목이 필수인 이유는 문구가 중요해서가 아니라 **`buildAccountWelcomeEmail`에
  render 테스트가 없기 때문입니다.** `buildAccountDeletionScheduledEmail`과
  `buildAccountRestoredEmail`은 `tests/accountLifecycleEmails.test.mjs`가
  렌더까지 확인하므로 여기서 다시 볼 필요가 없습니다. 메일은 회수되지 않으므로,
  테스트가 덮지 않는 경로만 사람이 한 번 봅니다.

  **(b) 층위 — 네 슬롯을 따로 적습니다.** 계정 환영은 **플랫폼 공용**이므로 네 곳
  모두 `Tomverse`가 맞습니다.

  | 슬롯 | 적을 것 |
  |---|---|
  | 발신 표시 이름 | 관측한 이름 (환경변수 소관 — §5.4) |
  | 제목 | 관측한 이름 |
  | 본문 헤더/브랜드 셸 | 관측한 이름 |
  | 본문 CTA | 관측한 이름 |

  본문 CTA만은 예외입니다 — 가입 진입점이 특정 제품이면 **CTA에서만** 그 제품을
  안내할 수 있습니다(`docs/ops/tomverse-review-rename.md` §7.4). `"Tomverse Review 계정이 생성되었습니다"`처럼 **계정을
  제품의 것으로 말하면** 공유 계정 구조와 충돌하므로, 그 표현이 보이면 적으십시오.

  네 슬롯이 서로 다른 층위를 말하면 그것도 관측입니다
  (`docs/ops/tomverse-review-rename.md` §7.5 4번).

- [ ] **C-2** Stripe **test mode**에서 결제를 한 번 완료한다. *(test mode가
      없으면 `미기록`)*

  **(a) 폐기명 — 차단.** Checkout 화면과 billing welcome 메일 어디에도
  `Tomverse Insight`가 없을 것.

  billing builder 계열은 render 테스트가 없고, `lib/billingEmails.ts`에 이름이 바뀐
  문자열이 가장 많습니다.

  **(b) 층위.** 결제는 계정에 대한 것이므로 **플랫폼 공용**입니다 — Review 화면에서
  시작해도 그렇습니다. C-1과 같은 네 슬롯을 적고, 여기에 하나를 더합니다.

  | 슬롯 | 적을 것 |
  |---|---|
  | Checkout line item 이름 | 관측한 이름 **과 그것이 어디서 왔는지** |

  **line item은 코드에서 안 나올 수 있습니다.** `plan.stripeProductId`가 설정돼
  있으면 코드의 `Tomverse Review {plan}`은 쓰이지 않고 **Stripe 대시보드의 Product
  이름**이 표시됩니다(`app/api/billing/checkout/route.ts:318-322`). 그러므로:

  | 화면에 보이는 것 | 무엇을 검증한 것인가 |
  |---|---|
  | `Tomverse {plan}` 계열 | Stripe 카탈로그. 코드 경로는 **미검증** |
  | `Tomverse Review {plan}` | 코드 fallback 경로 |
  | `Tomverse Insight …` | **(a) 실패** — 그리고 Stripe 대시보드 소관 |

  결제 화면과 결제 메일이 **서로 다른 이름**을 말하면, 그 자체가
  `docs/ops/tomverse-review-rename.md` §7.5 4번이 묻는 모순입니다. 둘 다 적으십시오.

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
