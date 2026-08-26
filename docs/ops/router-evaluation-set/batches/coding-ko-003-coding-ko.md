# coding-ko-003 — `coding/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=coding-ko-003`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**후보 14건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

아래 §후보에 prompt 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **「수정 후 채택」은 없습니다** — 
반려된 prompt는 고쳐서 채택하지 않고 **새 id로 다시 씁니다**. 그래야 반려 기록이 실제로
반려된 것을 계속 가리킵니다.

채택은 이 시트로 확정되지 않습니다. `status: adopted`와 `adoptedBy`·`adoptedAt`은 사람이
기입하는 값이고, 에이전트 산출물은 어떤 경우에도 `status: candidate`입니다.

---

## 초안 출처

| 항목 | 값 |
|---|---|
| provider | `zhipu` |
| modelId (Tomverse) | `glm-5.2` |
| 요청한 api model | `glm-5.2` |
| 응답이 밝힌 version | `glm-5.2` — **요청의 에코입니다. 버전 정보가 아닙니다** |
| 별칭이 가리킨 실제 모델 | *확정되지 않음 — no-alias-recorded* |
| 생성 파라미터 | `{"max_tokens":16000}` |
| promptTemplate | `router-eval-draft-v3` (`6033d9dfde0d4541`) |
| generatorCommit | `9614343` |
| draftedAt | 2026-08-26T05:42:03.232Z |

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 234건 | 0건 |
| cell ↔ language 정합성 | batch 14건 | 전건 통과 |
| status: candidate | batch 14건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 234건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.08 | 0.03 | `coding-ko-008` ~ `coding-ko-012` | coding/ko |
| 0.07 | 0.00 | `code-ko-001` ~ `coding-ko-009` | coding/ko |
| 0.07 | 0.00 | `coding-ko-006` ~ `coding-ko-011` | coding/ko |
| 0.07 | 0.02 | `coding-ko-002` ~ `coding-ko-008` | coding/ko |
| 0.07 | 0.04 | `coding-ko-004` ~ `coding-ko-006` | coding/ko |
| 0.06 | 0.00 | `code-ko-002` ~ `coding-ko-014` | coding/ko |
| 0.05 | 0.00 | `coding-ko-005` ~ `coding-ko-008` | coding/ko |
| 0.05 | 0.00 | `coding-ko-005` ~ `coding-ko-014` | coding/ko |
| 0.05 | 0.03 | `code-ko-001` ~ `coding-ko-006` | coding/ko |
| 0.05 | 0.00 | `coding-ko-003` ~ `coding-ko-014` | coding/ko |

---

## 후보 — 판정할 14건

### coding-ko-001

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 자바 Stream 쓰는 아래 코드에서 간헐적으로 NPE가 나는데 원인을 모르겠어요. `list.stream().map(x -> x.getValue()).collect(Collectors.toList());`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-002

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 금요일 배포인데 React 프로젝트 `npm run build`가 TypeScript 에러로 실패해요. `any` 끄라고 말하지 마시고 아래 코드에서 진짜 원인 좀 잡아 주세요. `interface User { id: number; name: string } const users: User[] = JSON.parse(response);`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-003

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> Spring Data JPA 쓰는데 N+1이 터져서 `@EntityGraph`도 넣어봤는데 여전히 쿼리가 두 번 나갑니다. 진단 좀 해 주세요. 엔티티: `@Entity public class Order { @ManyToOne(fetch = LAZY) private Member member; }` 리포지토리: `interface OrderRepository extends JpaRepository<Order, Long> { List<Order> findAllBy(); }`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-004

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 파이썬에서 `datetime.now()`로 저장해 둔 시간이 나중에 서버 타임존 바꾸니까 다 안 맞는데 왜 그런가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-005

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 회사 방화벽 때문에 외부 npm 패키지 설치가 안 됩니다. Node 18 기본 모듈만 써서 CSV 파일을 파싱해 객체 배열로 만들어 주세요. 첫 줄은 헤더고, 큰따옴표로 감싸진 필드 안에 쉼표가 들어 있는 경우도 있어요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-006

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아래 JS 코드가 `await`인데도 다음 줄이 먼저 실행돼요. 왜 그런가요? `await fetch(url); console.log('done');`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-007

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> RDS t3.small이라 메모리가 거의 없습니다. 아래 집계 쿼리가 OOM으로 죽는데, 임시 테이블 없이 같은 결과를 내는 방법 있을까요? `SELECT user_id, COUNT(*) FROM events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY user_id HAVING COUNT(*) > 100;`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-008

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아래 Dockerfile이 `COPY --from=builder` 단계에서 `file not found`로 실패합니다. 멀티스테이지인데 뭐가 잘못된 건가요? `FROM node:18 AS builder WORKDIR /app COPY . . RUN npm run build FROM nginx:alpine COPY --from=builder /app/build /usr/share/nginx/html`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-009

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아래 C++ 코드에 메모리 릭 있나요? 한 번 봐 주세요. `char* p = new char[100]; std::strcpy(p, "hello"); return p;`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-010

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> Git rebase로 커밋을 합치려니 충돌이 너무 많아서 포기했어요. `git merge --squash`로 같은 효과를 내려면 현재 브랜치 기준으로 어떻게 하면 되나요? 커밋 메시지는 한 줄짜리로 두고 싶습니다.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-011

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> Go에서 아래 코드가 deadlock으로 멈춰요. 이유 좀. `ch := make(chan int) ch <- 1 fmt.Println(<-ch)`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-012

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> k8s 파드가 `CrashLoopBackOff`인데 로그 보면 `exec format error`라고 나와요. M1 맥에서 빌드한 이미지를 EC2(amd64)에 올렸는데, Dockerfile 어디가 문제인가요? `FROM python:3.11-slim COPY . /app WORKDIR /app RUN pip install -r requirements.txt CMD ["python", "main.py"]`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-013

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 내일까지 기한이라 시스템 설정은 못 바꿉니다. 레거시 Java 8 프로젝트인데 아래 코드가 `ConcurrentModificationException`을 던져요. 스트림 안 쓰고 반복문 안에서 안전하게 삭제하려면 어떻게 고쳐야 하나요? `for (Item i : items) { if (i.isExpired()) items.remove(i); }`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-ko-014

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> pandas는 쓰면 안 되고 순수 파이썬만 써야 합니다. CSV에서 특정 컬럼 기준으로 중복 행을 제거하고 첫 행을 남기는 함수를 완성해 주세요. `def dedupe(rows, key):\n    # rows: list of dict\n    pass`

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

---

## batch 채택 결정

**20%를 보고 아무 말도 하지 않는 것은 채택이 아닙니다.** 판정을 채우신 뒤 아래를 기입해 주세요.

| 항목 | 값 |
|---|---|
| 검수자 | |
| 검수일 | |
| 채택 건수 | |
| 반려 건수 | |
| batch 결정 | <!-- 채택 / 전건 재검수 / 폐기 --> |

반려가 나오면 그 항목은 새 id로 다시 씁니다. cell 목표는 **채택본** 기준이므로, 반려분은
목표 수에 포함되지 않습니다.

