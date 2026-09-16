# 이어가기 원문 검색·원문 포함 TXT·잠긴 제목·잠금 순서 설계안 (2026-09-15)

작성: Claude (claude/to-develop/cont-search-01 worktree). 상태: **v3.6 — Codex 8차 확인 검토(Reject: major 4) 반영,
9차 확인 검토 대기.**

개정 이력:
- v1: 초안.
- v2 (2026-09-15): Codex 1차 검토 8건 전부 반영. 검색 인가를 후보 상한 앞으로(#2), relation 이름·
  bridge/target 소유권 결속·timeline 조회 userId(#3), 원문 export의 전체 snapshot DTO(#4), wildcard escape·
  시간 상한·측정 계획(#5, 사용자 결정 반영), 갈래 선택 순서·take(#6), focus parser·scroll 순서·UTF-16 offset(#7),
  counter·nullable 타입·short viewport·정책 동시 PR(#8), completeExtractionChunk fenced Run 잠금·정산 전
  count 확인(#1). 사용자 결정: 잠긴 제목 A안, 원문 검색 2글자 유지 + 3초 임시 상한 + timeout 시 원문 결과
  전부 제외·전용 안내.
- v3 (2026-09-15): Codex 2차 반영. 인가·후보·상세를 한 READ ONLY REPEATABLE READ snapshot에서, 원문 스캔은 인가된
  snapshot 양의 집합으로, 후보는 최종 순위 기준 대화별 window 1회(OFFSET 반복 제거·186행 상한의 정확성 근거),
  원문 예산은 문장마다 남은 시간으로 statement_timeout 재설정, `truncated`에 모든 상한 포함, imported id를
  (메시지, 대화) 단위로, `snippetHighlight` 응답 계약 명시(#2·#5·#6·#9). delete-all 정산을 cancel 계약과 일치(#1).
  `isStagingExpired(row, now)` 호출 교정(#10). focus는 URL 대신 메모리 handoff.
- v3.1 (2026-09-16): Codex 3차(설계 #6 부분·구현 8건) 반영. naming bridge 소유권 fail-closed, 성공 경로 timeout 복원,
  동률 key 방향을 SQL과 일치, 목록의 잠금·삭제 변화 시 검색 결과 즉시 폐기·재조회, shell의 surfaceHint 전달, 페이지 로딩 상태를 요청 token에 귀속,
  57014를 adapter 중첩 구조로 판별, 계약 테스트·번역 보정.
- v3.2 (2026-09-16): Codex 4차 반영. native 후보 SQL이 소유권이 어긋난 naming chain을 window·LIMIT **전에** 제외,
  검색 결과를 읽은 시점의 목록 access signature에 귀속시켜 잠금·삭제 즉시 렌더에서 숨김(삭제 성공 시 로컬 목록에서도 즉시 제거),
  focus handoff를 결과 확정 시 소비하되 같은 대화를 끝 페이지로 다시 읽지 않음.
- v3.3 (2026-09-16): Codex 5차 반영. 검색 access signature에 계정 id와 대화별 원문 `sourceState` 포함(계정 전환·원문 잠금/삭제 즉시 숨김),
  focus는 목록이 실제로 이동한 뒤(`onFocusApplied`) 소비하고 살아 있는 요청의 결과만 목록에 전달(재마운트 시 재이동 없음),
  삭제 후처리는 요청 시점이 아닌 현재 열린 대화 기준, 설계 본문에 pre-window 소유권 JOIN 기술.
- v3.4 (2026-09-16): Codex 6차 반영. 응답에 `validUntil`(반환 결과가 기댄 unlock grant 중 가장 이른 만료)을 싣고
  사이드바가 그 시각에 결과를 숨기고 재조회(grant 만료 후 발췌 잔존 방지). focus handoff는 대상 대화에 **도착하기 전**에는
  다른 대화 표시를 무시하고(이동 중인 이전 화면), 도착 후 대화를 떠나면(`null` 포함) 소비, 도착하지 못한 요청은 30초 후 만료.
- v3.5 (2026-09-16): Codex 7차 반영. 응답 도착 시 `validUntil`이 이미 지났거나 5초 이내면 **그리지 않고** 재조회, timer는 5초 일찍,
  탭 복귀(`visibilitychange`·`pageshow`·`focus`) 시 즉시 재확인. 이미 열린 대화의 결과는 요청 시점에 도착으로 기록,
  만료 판정을 대상 일치보다 먼저 하고 store 자체 timer로 30초 후 소거(렌더가 시계를 읽지 않음).
- v3.6 (2026-09-16): Codex 8차 반영. grant 유효성과 만료를 한 번의 cookie 판독으로 결정(`resourceUnlockAccess`),
  `validUntil`은 반환 결과만이 아니라 **답이 기댄 모든 grant**(인가 열거에서 통과한 잠긴 대화·원문)의 최소 만료,
  만료 임박 응답은 즉시 재조회하지 않고 만료 1초 후 한 번 재조회(루프·rate limit 방지), "모두 보기" 44px, 검색 E2E를 `@ui-risk`로 PR에서 실행.
기준: develop `fd7af39caa390ddcb1d1e1eb0ade7f7e6652578d`, main `82551fd13a3979f5c22abb2fdf499d96caf6c029`.
근거 목록: 공유 작업 목록 `codex/product-idea-backlog-2026-09-15`의 B·C·D절(CONT-SEARCH-01,
CONT-EXPORT-01B D4~D6, IMPORT-LOCK-TITLE-01, task_9d445985, IMPORT-STAGING-FINALIZE-01).

이 문서는 구현 순서와 계약을 정합니다. production 배포·flag·운영 DB 조회는 포함하지 않으며
유료 모델 호출은 네 작업 모두 0회입니다. DB 동시성 테스트는 로컬 테스트 DB가 없으므로
CI의 PostgreSQL integration 단계가 판정합니다.

작업은 **네 개의 독립 PR**(각각 develop 대상, 이후 main 대상)로 나눕니다. 순서는 사용자 권장
순서 그대로입니다: ① CONT-SEARCH-01 → ② CONT-EXPORT-01B → ③ IMPORT-LOCK-TITLE-01 →
④ 잠금 순서 cycle 2건. ③은 제품 결정(§3.1) 확인 후 구현합니다. ④는 앞 작업과 파일 충돌이
없어 순서만 뒤입니다.

---

## 1. CONT-SEARCH-01 — 이어가기 원문 메시지 검색

### 1.1 확인된 현재 상태 (코드)

- `app/api/conversations/search/route.ts:39` — `prisma.message.findMany`로 native
  `Message.content`만 `contains/insensitive` 검색, `take: 100`, native grant 필터 후 30개.
  snippet은 앞 180자.
- 원문은 `ExternalMessage`(`@@unique([externalConversationId, ordinal])`, `@@index([userId])`,
  content 인덱스 없음). 한 snapshot에 bridge 여러 개 가능(`ConversationContinuationBridge.externalConversationId`
  비-unique, `onDelete: SetNull`), bridge당 Conversation 하나(`conversationId @unique`).
- 원문 페이지: `GET /api/conversations/{id}/continuation?offset=end|N&limit=N`
  → `getContinuationTimeline()`(`lib/externalContinuationService.ts:475`). native grant는
  route(423), 원문 grant는 service(`status: "locked"`). 페이지 100, 최대 200.
  클라이언트 `useContinuationSource`는 **뒤에서부터 older 방향만** 읽습니다.
- `ChatSidebar.tsx:1453` 결과 4개 표시, 클릭은 `conversationId + surface`만 전달.
  메시지 위치 이동·강조 기능은 저장소 어디에도 없습니다.
- 두 잠금: `hasConversationUnlockGrant`(native), `hasResourceUnlockGrant("external_conversation", …)`.
  둘은 HMAC key가 분리되어 서로 대체되지 않습니다.

### 1.2 API 계약

`GET /api/conversations/search?q=` — 인증·rate limit·q 길이(2~80, 한국어·영어 동일) 유지.

```ts
type SearchAnswer = {
  results: SearchResult[];
  /** 인가된 결과 중 어떤 상한(전체 30·대화당 5·원문 갈래 3·후보 행 상한)으로든 버려진 것이 있으면 true */
  truncated: boolean;
  sourceSearch: "ok" | "timed_out";
  /** 이 답이 기댄 모든 unlock grant(잠긴 대화·원문) 중 가장 이른 만료, 없으면 null (v3.4~3.6) */
  validUntil: string | null;
};
type SearchResult =
  | { kind: "native"; id: string /* Message.id */; conversationId; conversationTitle;
      ...ContinuationRowNaming; surface; role; modelId; snippet: string;
      snippetHighlight: { start: number; end: number } | null }
  | { kind: "imported"; id: `imported:${externalMessageId}:${conversationId}` /* 결과 단위로 유일 */;
      externalMessageId: string /* 이동용 raw id */; conversationId /* 이어가기 native Conversation */;
      conversationTitle; ...ContinuationRowNaming; surface /* 항상 continuation */;
      role: "user" | "assistant"; sourceModelLabel: string | null; snippet: string;
      snippetHighlight: { start: number; end: number } | null }
```

- `sourceProvider`는 `ContinuationRowNaming`에 이미 있습니다.
- imported에 `modelId`를 넣지 않습니다(원본 라벨을 runtime `modelId`로 바꾸지 않음).
- digest·ordinal·seed·sourceImportedAt·import id는 넣지 않습니다.
- 하위 호환 주장은 하지 않습니다. 사이드바는 같은 PR에서 갱신되며 `kind` 없는 항목은 native로 취급합니다.

### 1.3 서버 조회

> **개정 v3 (Codex 2차 #2·#5·#6·#9)**: 인가 열거와 후보·상세 조회를 **하나의 READ ONLY REPEATABLE READ
> transaction**에서 읽고, 원문 스캔 범위를 **인가된 snapshot의 양의 집합**으로 제한하며, 후보 선택을 최종
> 순위(대상 대화 `updatedAt`)와 같은 기준의 **대화별 window 조회 1회**로 바꿨습니다(OFFSET 페이지 반복 제거).

**전체 흐름** — `searchConversationMessages()`(`lib/conversationSearch.ts`), 한 transaction
(`isolationLevel: RepeatableRead`, 첫 문장 `SET TRANSACTION READ ONLY`, `timeout` 15초):

1. **인가 열거** (같은 snapshot이므로 이후 조회와 password 상태가 일치)
   - 잠긴 native 대화 `{ userId, password not null }` → grant 없는 id = `deniedConversationIds`.
   - 인가된 이어가기 bridge: `{ userId, externalConversationId not null, conversation: { userId },
     externalConversation: { userId, finalized: true } }`에서 `conversationId, conversation.updatedAt,
     externalConversationId, externalConversation.password`를 읽고, 대상 대화가 denied가 아니고 원문 grant가
     있는 bridge만 남깁니다(grant 판정은 쿠키 HMAC이라 DB 조회 없음).
   - snapshot별 갈래 = 남은 bridge를 `updatedAt desc, conversationId asc`로 정렬해 앞 3개.
     4개 이상이면 그 snapshot은 `branchesCapped`.
   - `authorizedSnapshotIds` = 갈래가 1개 이상인 snapshot을 **최상위 갈래의 `updatedAt` desc**로 정렬한 배열.
2. **native 후보** — raw SQL 1회. 대화마다 최신 6개(`row_number() over (partition by conversationId
   order by createdAt desc, id desc) <= 6`)만 남기고, 대화 `updatedAt desc, conversationId`로 정렬해
   `LIMIT 186`(= 31개 대화 × 6). 조건: `c."userId" = $user AND NOT (c.id = ANY($denied)) AND
   m.content ILIKE $pattern`, 그리고 bridge·source를 LEFT JOIN해 **naming chain의 소유자가 이 계정이 아닌 대화를
   window·LIMIT 전에 제외**(`b.id IS NULL OR (b.userId = $user AND (b.externalConversationId IS NULL OR e.userId = $user))`;
   `conversationId @unique`라 행이 늘지 않음). 따라서 186행 논증의 "순위가 높은 대화 31개"는 모두 표시 가능한 대화입니다.
   id·conversationId·updatedAt·createdAt·rn만 읽습니다.
3. **imported 후보** — `authorizedSnapshotIds`가 비면 건너뜀(`sourceSearch: "ok"`). 아니면 먼저
   `SELECT set_config('statement_timeout', $remainingMs, true)`로 **남은 원문 예산**을 걸고 raw SQL 1회:
   `m."userId" = $user AND m."externalConversationId" = ANY($authorizedSnapshotIds) AND m.content ILIKE $pattern`,
   snapshot마다 `ordinal desc` 최신 6개, `array_position($authorizedSnapshotIds, externalConversationId)`
   순서로 `LIMIT 186`. 스캔 대상이 인가된 원문뿐이라, 잠긴·권한 없는 원문의 양이 소요 시간이나
   `timed_out` 여부에 영향을 주지 않습니다.
4. **상세 조회** — 살아남은 id로만 `Message`·`ExternalMessage` 본문과 대상 대화 이름 정보를 읽습니다
   (`userId` 결속 유지). 원문 상세도 같은 원문 예산 안에서 실행하고, 성공해도 `ROLLBACK TO SAVEPOINT` → `RELEASE`로 끝내 낮춘 statement timeout이 이후 조회에 남지 않게 합니다(RELEASE만으로는 복원되지 않음 — Codex 3차 #2).
5. **순위·상한** — 순수 함수 `rankSearchHits()`: 결과 단위 (대상 대화, 메시지). imported 행은 그 snapshot의
   갈래(≤3)로 펼칩니다. 대상 대화 `updatedAt desc` → 대화 안에서 native(`createdAt desc`) 먼저,
   imported(`ordinal desc`) 다음 → key **내림차순**(native 후보 SQL의 `id COLLATE "C" DESC`와 같은 방향)으로 안정화. 대화당 5개, 전체 30개.
6. **발췌** — 반환되는 30개에만 `searchSnippet()` 적용.

**왜 186행이면 상위 30개가 정확한가**: 결과 r의 대상 대화 t가 후보 목록 밖이면, t보다 순위가 높은 서로 다른
대화 31개가 각각 1개 이상의 결과를 가져 r은 31위 이하입니다(원문은 snapshot 최상위 갈래 기준 정렬이라 같은
논리가 성립). 대화당 6행을 읽는 것은 5개 상한을 넘는지 판별하기 위해서입니다.

**이름 정보의 소유권**: 결과 대상 대화의 naming bridge는 `bridge.userId`와 `externalConversation.userId`까지 읽어, 셋 중 하나라도 이 계정이 아니면 그 대상의 결과를 **버립니다**(이름을 바꿔 보여 주지 않음). 스키마에 동일 소유자 복합 제약이 없기 때문입니다(Codex 3차 #1).

**`truncated` 정의** (모두 인가된 행만으로 결정): 결합 후 30개 초과 ∨ 어떤 대화든 5개 초과로 버림 ∨ 결과가 난
snapshot의 `branchesCapped` ∨ native 후보가 186행에 도달 ∨ imported 후보가 186행에 도달.

**검색어 — literal 부분 문자열**: `escapeLikePattern(q)`로 `\`→`\\`, `%`→`\%`, `_`→`\_`(PostgreSQL LIKE
기본 escape 문자 `\`). Prisma `contains`도 escape하지 않으므로(문서 확인) 기존 native 검색의 wildcard 의미가
literal로 바뀌는 것은 결함 수정으로 PR에 명시합니다.

**원문 시간 상한** (사용자 결정 2026-09-15: 2글자 유지, 3초는 임시 안전 상한)

- 원문 예산 3초는 **원문 단계 시작 시각** 기준입니다. 3·4단계 각 문장 **직전**에 남은 시간을 계산해
  `statement_timeout`을 그 값으로 낮추고(0 이하면 즉시 timeout 처리), 각 문장 **직후**와 반환 전에도
  경과를 확인합니다. 따라서 원문 단계 전체가 3초를 넘지 않습니다(+ 드라이버 왕복 오차).
- 57014(statement timeout) 또는 예산 초과면 **원문 결과를 전부 버립니다.** native 결과는 이미 메모리에
  있으므로 유지하고 `sourceSearch: "timed_out"`. 원문 단계가 transaction을 abort시켜도 native 결과에는
  영향이 없습니다(이미 읽음). native·인가 단계의 오류는 그대로 500입니다.
- 화면 문구: **"원문 검색 시간이 초과되어 Tomverse 메시지 결과만 표시합니다"**(7개 locale). "결과 없음"이나
  "일부 성공"으로 표시하지 않고, native 결과가 0개여도 이 문구를 보입니다.
- timeout은 `conversation_search_source_timeout` 구조화 로그(경과 ms·상한 ms만)로 남깁니다.
- **측정**: `scripts/measure-continuation-source-search.mjs` — disposable 테스트 DB에 계정 상한 근처
  (원문 10만 메시지·약 50MiB, 이어가기 연결) 합성 데이터를 만들고 일치 없음 / 빈번한 일치 / 동시 요청
  (5·10개)의 p50·p95·timeout 비율과 `EXPLAIN (ANALYZE, BUFFERS)`를 기록합니다. 로컬 테스트 DB가 없어
  CI 수동 실행 또는 사람이 준비한 DB에서 실행하며, 결과는 감사 기록으로 남깁니다. 측정 전 3초를 확정하지
  않고, 정상 사용에서 timeout이 반복되면 조회 구조·`pg_trgm` 인덱스를 재검토합니다.

**발췌**

- `searchSnippet(content, q, radius = 80)`(`lib/searchSnippet.ts`): 탐색·자르기는 code point 단위,
  대소문자 비교는 code point마다 `toLowerCase()`가 한 code point일 때만 접음. 반환 `highlight`는 반환 `text`의
  **UTF-16 offset**. 위치를 못 찾으면 앞 180 code point, `null`.
- 강조는 클라이언트가 텍스트 노드 + `<mark>`로만 그립니다(HTML·markdown 해석 없음).
- 응답 `Cache-Control: no-store`. 검색어·원문·id를 로그/analytics에 남기지 않습니다.

### 1.4 위치 이동 계약

> **개정 v3**: URL `focus` 파라미터 대신 메모리 handoff를 씁니다. 결과 클릭은 URL이 아니라 클릭이며,
> 새로고침·공유 링크는 기존처럼 대화 끝에서 열려야 하고, 정리할 query parameter가 남지 않습니다.
> 또한 대화 선택 handler(`handleSelectConversation`)의 surface 라우팅 prefix는 격리 실행 계약 테스트
> 대상이라 건드리지 않습니다.

**Handoff**: 사이드바는 imported 결과 클릭 시 `requestContinuationFocus(conversationId, externalMessageId)`
(`lib/continuationFocusHandoff.ts`, id와 증가 nonce만 보관)를 호출한 뒤 **기존과 똑같이**
`onSelectConversation(conversationId, false, surface)`로 대화를 엽니다(surface 결정·이동·잠금 확인은 기존 경로).
workspace는 `useSyncExternalStore`로 요청을 읽어, 요청의 대화가 화면 대화와 같을 때만 적용합니다.
다른 대화가 화면에 오르면 요청을 지워, 나중에 같은 대화로 돌아와도 옛 결과 위치로 가지 않습니다.
같은 결과를 다시 누르면 nonce가 달라 다시 이동합니다. handoff는 권한 증거가 아닙니다.

**서버**: continuation route에 `around=<externalMessageId>` 추가(`offset`과 동시에 오면 400 — 모호한 요청 거절;
형식은 `parseAroundMessageId()`가 cuid 문자 `^[a-z0-9]{1,64}$`만 허용). `getContinuationTimeline()`에서 기존 두 잠금·finalized 판정을
**모두 통과한 뒤에만**, 그리고 모든 원문 조회에 `userId`를 함께 넣습니다(기존 페이지 조회
`externalMessage.findMany`에도 `userId` 추가 — Codex #3):

```ts
const target = await prisma.externalMessage.findFirst({
  where: { id: around, userId, externalConversationId: snapshot.id },   // 정확한 snapshot + 계정
  select: { ordinal: true },
});
if (target) {
  const before = await prisma.externalMessage.count({
    where: { userId, externalConversationId: snapshot.id, ordinal: { lt: target.ordinal } },
  });                       // ordinal은 연속이 아니므로 count로 위치 계산(간격 있어도 정확)
  offset = clamp(before - floor(limit / 2), 0, max(0, messageTotal - limit));
}
// 응답에 focus: { found: boolean } 추가 — 찾지 못하면 기존 offset=end 동작
```

- 다른 snapshot·다른 계정의 id는 "없음"과 구분되지 않습니다(`found:false`, 기존 end 페이지).
- 잠김·삭제 상태면 `around`는 평가하지 않고 기존 상태 응답을 그대로 줍니다.
- `messageTotal`은 기존대로 `snapshot.messageCount`를 씁니다(finalized snapshot은 immutable).

**클라이언트 (`useContinuationSource`)**

- 첫 요청에 `around`를 실어 보냅니다. 응답의 `offset`·`limit`로 window `[start, end)`를 기록.
- 기존 `loadMore`(older) 유지 + **`loadNewer` 추가**: `end < messageTotal`일 때
  `offset=end&limit=min(100, messageTotal-end)`로 읽어 뒤에 붙입니다.
- `ChatMessageList`: window가 원문 끝에 닿지 않았으면 원문과 native 사이에
  `imported-load-newer` 버튼("이후 원문 N개 불러오기")을 둡니다. 이어짐을 암시하지 않기 위해
  native 후속 대화는 그 버튼 **아래**에 그대로 둡니다.
- 메시지 요소에 `data-message-id`(이미 있는 `imported:` id)를 추가. `ChatMessageList`가
  `focusMessageId` prop(요청마다 새 nonce)을 받고, **기존 auto-scroll layout effect 뒤에 선언된 layout
  effect**에서 대상 요소가 렌더된 순간 순서를 고정합니다: ① `setMode("paused")` ② 컨테이너 기준
  중앙 스크롤(programmatic scroll 플래그 사용) ③ `tabIndex=-1` 후 `focus({ preventScroll: true })`
  ④ 2초 강조 클래스. 이미 처리한 nonce는 다시 처리하지 않습니다. 초기 load의 bottom 이동과
  following 모드의 ResizeObserver가 이후에 덮지 않도록 ①이 먼저입니다.
- 수십 번 자동 더 보기 반복·전체 transcript 선로딩은 하지 않습니다. 한 번의 around 요청이 전부입니다.
- 결과는 대화별로 소유되는 `focusOutcome`(`found | not_found | locked | deleted | failed`)으로 남고,
  `found`가 아니면 toast "이 결과는 더 이상 열 수 없습니다"(locale 7개) 후 기존 화면(끝 페이지 또는 상태 문구).

**native 결과 이동**은 이번 범위 밖입니다(native 페이지는 cursor 기반이라 별도 계약 필요).
native 결과는 기존처럼 대화를 엽니다. PR과 작업 목록에 잔여로 적습니다.

### 1.5 사이드바 UI

- 결과 행에 imported는 "원문 · {provider}" 배지(기존 import accent 없이 neutral zinc — accent
  role 추가 금지), native는 배지 없음.
- 기본 4개 표시는 유지하고, 4개 초과 시 "결과 N개 모두 보기" 토글로 같은 목록(최대 30)을 펼칩니다.
  `truncated`면 "일부 결과만 표시" 한 줄.
- `sourceSearch === "timed_out"`이면 결과 목록 위에 "원문 검색 시간이 초과되어 Tomverse 메시지 결과만
  표시합니다" 한 줄(native 결과가 0개여도 표시하여 "결과 없음"으로 읽히지 않게 함).
- 클릭: imported는 handoff 기록 후 기존 `onSelectConversation`(§1.4). React key는
  `${id}:${conversationId}`.
- 모바일·데스크톱 shell 모두 `onSelectConversation(id, skipLockCheck, surfaceHint)` 세 인자를 그대로 전달합니다(모바일 wrapper가 surface를 버리던 기존 결함 — Codex 3차 #5).
- 오래된 결과 무효화: 잠금·삭제 후 결과를 눌러도 서버가 재검증하므로 누출은 없습니다. 추가로 기존
  잠금/삭제 성공 이벤트 발생 시 검색 결과 state를 비우고 재조회합니다.
- mobile drawer·composer 계약: 사이드바 검색 결과 영역만 바뀌므로 drawer spec 재실행.

### 1.6 정책·테스트

- 정책: `docs/policy/external-conversation-continuation.md` §8.2에 "검색" 소절 추가 — 대상(연결된
  finalized snapshot 원문), 두 grant, 결과 식별자, `focus`/`around`의 비권한성, 제외 범위(미연결
  import·의미 검색·Message/Memory 복제·모델 context 확대). "검색 가능 ≠ 모델 전달" 명시.
- 단위: `searchSnippet`(한글·영문·이모지 경계·일치 없음·긴 본문), 결과 결합·상한·정렬 순수 함수
  (`lib/conversationSearchResults.ts`로 분리해 route는 조회·인가만).
- contract: 검색 service가 두 resource type에 대해 `resourceUnlockAccess()`로 판정하고 denied id를 후보 SQL 조건에 넣음,
  imported 항목에 digest/ordinal/modelId 없음(`scripts/security-regression-check.mjs`).
- DB integration(`tests/integration/conversation-search.db.test.ts` 신규): 원문에만 있는 검색어,
  미연결 import 제외, staging 제외, 타 계정 제외(bridge 계정 ≠ target 대화 계정 시료 포함),
  **잠긴 일치 항목 100개 이상이 있어도 응답·정렬·`truncated`가 잠금 없는 기준 응답과 동일**,
  `%`·`_`·`\` literal 검색, timeout 시 imported 전부 제외 + `sourceSearch:"timed_out"`
  (`statement_timeout`을 테스트용으로 낮춰 `pg_sleep` 없이 유도), 원문 잠금(grant 없음/있음), 이어가기 잠금,
  원문 삭제 후 native 계속 검색, 한 snapshot 두 갈래, 대화당 상한, `around`의 정확한 offset
  (ordinal 간격 있는 시료), 다른 snapshot id의 `found:false`.
- E2E(`tests/e2e/external-conversation-continuation.spec.ts`의 "searching an imported original @ui-risk", API mock 기반): 결과 표시·배지·모두 보기,
  클릭 → 첫 페이지 밖 원문 강조·load newer, desktop + mobile.
- 차단 판정: 권한 없는 원문/제목/존재가 검색으로 새면 차단. 발췌 모양·강조·토글은 비차단.

---

## 2. CONT-EXPORT-01B — 원문 포함 TXT

작업 목록의 확정 기준 D4·D5를 그대로 구현합니다. 이 절은 코드에 맞춘 구체화입니다.

### 2.1 확인된 현재 상태

- export route는 `ReadableStream.pull`에서 20개씩 **transaction 없이** 페이지를 읽습니다.
  크기 상한·검증 header 없음. `continuationExportProvenance()` 2번째 줄이 "원문은 별도 다운로드".
- 저장소에 `isolationLevel`·`SET TRANSACTION READ ONLY` 사용처가 없습니다(새 helper 필요).
- 클라이언트는 `ChatPageClient.handleDownloadConversation`(`saveResponseAsFile` → `blob()`)
  하나이며 사이드바 메뉴 버튼 하나(`sidebar.downloadTxt`)입니다.
- 두 "locked" 의미: 이름용 `continuationSourceState`는 password 존재 기준, timeline/seed는 grant 기준.
  **원문 포함 export는 grant 기준**(timeline과 동일)을 씁니다. 파일명·제목은 01A대로 password 기준 유지.

### 2.2 서버

`GET /api/conversations/{id}/export?include=source` (그 외 값·미지정은 기존 동작, byte 단위 동일).

> **개정 v2 (Codex #4)**: native Conversation·제목·naming bridge까지 전부 같은 snapshot에서
> immutable DTO로 읽고, 조립·해시는 transaction 밖에서 합니다.

1. 로그인 → `allowDownloads` → rate limit(기존 키 공유). (여기서는 DB 대화 조회를 하지 않습니다.)
2. `readOnlySnapshotTransaction(fn, { timeout: 20_000, maxWait: 5_000 })` helper(검색 PR에서 추가됨)
   (`lib/readOnlySnapshotTransaction.ts`): `isolationLevel: RepeatableRead` + callback 첫 문장
   `SET TRANSACTION READ ONLY`(Prisma 7.10 adapter-pg가 `BEGIN → SET TRANSACTION ISOLATION` 순이라
   callback 첫 조회 전 실행 가능 — Codex 확인). **transaction 안에서 읽는 것 전부**:
   - owned Conversation(`{ id, userId }`: title·createdAt·password·kind) + naming bridge
     (`CONTINUATION_NAMING_BRIDGE_SELECT` + bridge id·`externalConversationId`). 없음 → 404.
     native grant 없음 → 423 `CONVERSATION_LOCKED`, kind 불가 → 기존 응답.
     bridge 없음 → 400 `EXPORT_SOURCE_NOT_CONTINUATION`.
   - snapshot을 `{ id: bridge.externalConversationId, userId }` 결속으로 조회. FK null 또는 snapshot 없음/`finalized=false`
     → 409 `EXPORT_SOURCE_DELETED`. grant 없음 → 423 `EXPORT_SOURCE_LOCKED`
     (사유는 소유권 확인 뒤에만 반환, 본문·제목 없음).
   - 같은 snapshot에서 `count` + `SUM(octet_length(content))` (원문·native 각각) → 조기 거절
     413 `EXPORT_TOO_LARGE`(상한 초과 시).
   - 원문: `externalConversationId` + `userId`, `ordinal asc`, 500개 keyset 페이지.
     native: 기존 `conversationId` 쿼리, 500개 cursor 페이지.
   - 대조: 행 수 = count, ordinal 엄격 증가(간격 허용). 불일치 → 500 `EXPORT_INCONSISTENT`
     (재시도 안내, 로그는 코드만).
   - transaction은 여기서 **DTO(`{conversation, bridge, snapshot fingerprint, importedMessages[], nativeMessages[]}`)
     를 반환하고 끝납니다.** 아래 조립·상한·해시는 transaction 밖, 이미 읽은 DTO만 사용합니다.
   - 조립: header(DTO의 표시 제목·포함 범위 `Includes: imported original + Tomverse continuation`·
     provenance 개정문) → 원문(`formatImportedMessage`: `[Imported · {provider} · {sourceModelLabel ?? role}] {sourceTimestamp ?? "time unknown"}`,
     truncated면 `(truncated at import)` 줄) → 경계 구분선 `===== Continued in Tomverse =====`
     → native(기존 `formatExportMessage`) → 완결 표식 `===== End of export (N imported, M Tomverse messages) =====`.
     `TextEncoder`로 최종 `Uint8Array`, BOM 없음. 최종 byte 상한 검사(10 MiB) → SHA-256(`node:crypto`).
   - 메시지 수 상한 10,000(합산). 상수는 `lib/continuationSourceExportLimits.ts` 전용.
4. **최신 조회 1회 재확인**(transaction 밖, 일반 읽기): native 대화 존재·소유, **같은 bridge id와 같은
   `externalConversationId`**, snapshot 존재·finalized, 대화·snapshot의 password가 DTO 시점과 같은지
   (password 값 자체를 비교, 응답·로그에 싣지 않음), native·원문 grant 현재 유효. 실패 → 해당 409/423.
5. 응답: `Content-Type: text/plain; charset=utf-8`, 01A 파일명, `Cache-Control: no-store`,
   `nosniff`, `X-Export-Bytes`, `X-Export-SHA256`(hex), `Access-Control-Expose-Headers` 불필요(same-origin).
   본문은 조립된 bytes 한 번에.

provenance: `continuationExportProvenance({ …, includesSource: true })` 2번째 줄을
"The imported original is included below as stored in Tomverse; content truncated or not stored at import is not recoverable."로.
미포함 모드 문구·3줄 계약은 유지(기존 contract test 그대로).

### 2.3 클라이언트

- `downloadVerifiedExport(response)`(`lib/browserDownload.ts`): `arrayBuffer()` → 두 header 필수·형식 검사
  (`^\d+$`, `^[0-9a-f]{64}$`) → byteLength 대조 → `crypto.subtle.digest("SHA-256")` 대조 →
  일치 시에만 `Blob` 저장. 실패는 저장 없이 toast `sidebar.downloadVerifyFailed`. 사유 코드만 console.
- 사이드바 메뉴: continuation 행(`conv.sourceState` 존재)에서 버튼 2개(D5):
  "원문과 이어진 대화 다운로드 (.txt)" + 보조 "저장된 원문 텍스트 포함 · 내려받은 파일은 회수할 수 없습니다",
  "Tomverse에서 이어진 부분만 다운로드 (.txt)". 일반 대화는 기존 버튼 1개.
- `sourceState`가 `deleted`면 원문 포함 버튼 비활성 + 이유. `locked`는 버튼 활성(grant 판정은 서버),
  423 응답이면 "원문 잠금을 해제한 뒤 다시 시도" toast. 409 deleted / 413 too large 각각 문구.
- `onDownload(id, title, { includeSource })`로 prop chain 확장(Desktop/Mobile shell).
- 메뉴 항목이 늘어나므로 mobile drawer 짧은 높이(short viewport) 매트릭스에서 두 버튼의 중심점
  reachability(`elementFromPoint`)를 확인합니다(Codex #8).
- 정책 §1·§9·§13 개정은 코드와 **같은 PR**에 들어갑니다(정책 없이 코드가 먼저 병합되지 않음).
- locale 7개 추가 키. 원문 미포함은 검증 header를 강제하지 않습니다.

### 2.4 정책·테스트

- 정책 개정: continuation 정책 §1 표(원문 일반 export 제외 → 명시적 원문 포함 모드만 허용),
  §9(포함 조건·순서·완결 검증·회수 불가·Share 아님), §13 차단 문구를 "사용자 명시 선택 없는 포함"으로 명확화.
- 단위: 조립 순서·표식·truncated·줄바꿈, 상한(경계 ±1 byte), header 검증 함수(누락·형식·불일치).
- contract: include=source만 transaction helper 사용, 미포함 경로 코드 경로 불변, route가 두 grant 사용.
- DB integration: read-only helper 안의 write가 거절됨(SQLSTATE 25006), 조립 중 동시 native
  append·rename·원문 삭제가 있어도 파일이 한 시점으로 일관(snapshot 고정 확인 후 커밋된 변경은 파일에 없음,
  원문 삭제는 재확인 단계 409), 원문 1페이지(500) 초과, ordinal 간격, native 후속, 원문 삭제 409, 잠김 423/grant 통과,
  타 계정 404, 상한 초과 413, 합산 메시지 상한, 두 갈래 중 정확한 snapshot만.
- E2E: 메뉴 2개 표시(continuation)/1개(일반), 검증 성공 저장·header 불일치 시 저장 안 됨, 기존
  `conversation-export.spec.ts` 유지(미포함 모드는 header 없이 성공).
- 클라이언트 메모리 최고치는 E2E에서 10 MiB 시료로 `performance.memory`(Chromium) 기록만, 판정값 아님.
- 차단: 권한 없는 원문/제목 포함, 일부만 담긴 파일을 성공 처리. 문구·표식 모양은 비차단.

---

## 3. IMPORT-LOCK-TITLE-01 — 잠긴 snapshot 제목

### 3.1 제품 결정 — 2026-09-15 사용자 결정: 권장안 A(항상 숨김) 채택

권장안 **A**: 잠긴 snapshot(`password !== null`)의 원문 제목은 **목록·상태 응답에서 grant 유무와 무관하게**
서버가 보내지 않습니다. 기존 `readableContinuationSourceTitle()`(이어가기 목록·TXT 파일명)과 같은 규칙이라
화면 간 일관성이 유지되고, grant 쿠키 30분 만료에 따라 목록 모양이 바뀌는 문제가 없습니다.
잠금 해제 후 **뷰어 본문 화면**(`getExternalConversation`, grant 검사 있음)에서는 제목을 보여 줍니다.

대안 B: grant가 있으면 목록에도 제목 표시. 편하지만 목록 응답이 쿠키 상태에 따라 달라지고, 공유 PC에서
30분간 목록 제목이 보입니다.

### 3.2 구현 (A 기준)

- 판정 공용화: `lib/continuationDisplayTitle.ts`의 `readableContinuationSourceTitle`을 import 쪽에서도 사용.
- `listExternalConversations()`: `title: readableContinuationSourceTitle(row)`(잠김이면 `null`),
  `titleWithheld: row.password !== null`.
- `getExternalImportStatus()`(`/api/imports/external/[id]`): 같은 규칙(현재 finalized·잠긴 행 제목도 반환 — 같은 누출).
- 클라이언트: `ExternalImportManagement.tsx`(행 제목·`ContinuationQuickAction` sourceTitle),
  `ExternalImportDetail.tsx`, `MemoryExtractionLauncher.tsx` — 세 곳의 `title: string` 타입을
  `string | null`로 바꾸고(컴파일러가 누락 사용처를 잡도록) e2e mock도 잠긴 행은 `title: null`로 고정.
  `title === null`이면 locale
  "잠긴 대화 · {provider} · {가져온 날짜}" 표시. 날짜는 기존 서버 표시 시간대 규칙 재사용.
- 잠금 설정·해제 후 목록 재조회(기존 이벤트)로 이전 응답 제목이 다시 그려지지 않는지 확인.
- 사용자가 직접 저장한 이어가기 대화명(`Conversation.title`)은 대상이 아닙니다.
- 정책: import 정책 §7에 "잠긴 snapshot의 원문 제목은 잠긴 내용의 일부" 조항 추가.
- 테스트: DB integration(목록·상태 응답의 잠긴 행 `title:null`, 잠금 해제 행 제목 유지), e2e mock
  수정(`external-conversation-lock.spec.ts`, `import-list-continuation-quick-action.spec.ts`),
  contract test(두 서비스 함수가 공용 판정 사용).
- 차단: 잠긴 제목이 목록/상태 응답에 포함. 대체 문구 모양은 비차단.

---

## 4. task_9d445985 — 기존 잠금 순서 cycle 2건

### 4.1 Run↔Chunk

현재: `claimMemoryExtractionRun` = Run UPDATE(:565) → 이전 generation Chunk UPDATE(:591).
`completeExtractionChunk` = credit advisory(:727) → Chunk UPDATE(:739) → Run UPDATE(:787) → 정산.
lease 재획득과 이전 worker 완료 보고가 겹치면 Chunk X ↔ Run 교착.

> **개정 v2 (Codex #1, blocker)**: 무조건부 Run 잠금은 cancel·delete-all 뒤의 stale worker를 막지 못하고,
> 현재 코드는 Run `updateMany` 결과를 무시한 채 정산합니다(기존 결함). 첫 잠금 자체를 fence로 만듭니다.

수정: **Run → Chunk로 통일하고, 첫 Run 잠금을 fence로.** `completeExtractionChunk`에서 credit lock 직후,
chunk를 읽거나 쓰기 전에:

```sql
SELECT id FROM "MemoryExtractionRun"
WHERE id = $runId AND "userId" = $userId AND status = 'running' AND "leaseGeneration" = $gen
FOR UPDATE
```

- 행이 없으면(취소·전체 삭제·superseded·종료) **Chunk를 건드리지 않고** 현재 run status만 읽어
  `applied:false` 반환. READ COMMITTED에서 `FOR UPDATE`는 대기 후 WHERE를 재평가하므로, claim이 먼저
  generation을 올렸다면 여기서 빈 결과가 됩니다.
- Run `updateMany`의 `count === 1`을 확인한 뒤에만 `settleExtractionRunCredits`를 호출합니다
  (잠금을 쥐고 있어 정상적으로 항상 1이지만, 0이면 throw로 전체 rollback — 조용한 정산 금지).
- commit 경로(`memoryExtractionCommit.ts:67`)가 이미 Run 먼저, claim도 Run → Chunk이므로 순서가 일치합니다.
  전체 순서: credit → (workflow advisory) → Run → Chunk → 정산 행. Codex 확인: claim `Run→Chunk`,
  commit/delete-all `Run→memory`, cancel `credit→Run`과 새 cycle 없음.
- `claimNextExtractionChunk`는 Chunk만 `FOR UPDATE OF c SKIP LOCKED`, Run은 읽기만 → 순환 없음(확인).
- `cancelMemoryExtractionRun`: credit → Run → (chunk count 읽기) → 정산. Chunk 잠금 없음 → 변경 불필요.
- 정적 테스트: `tests/creditLockOrder.test.mjs`에 "completeExtractionChunk는 Run FOR UPDATE를 첫 chunk write보다 먼저" assertion.
- DB 테스트(`tests/integration/memory-extraction.db.test.ts`): 두 실행 순서 고정 —
  (a) complete(terminal chunk)가 credit+Run을 잡은 상태에서 **lease 만료 이후 `now`로** claim 시작 →
      complete가 먼저 커밋해 run이 terminal이 되므로 claim은 대기 후 `null`, 정산 정확히 1회;
      비terminal chunk면 complete가 lease를 연장하므로 같은 `now`의 claim도 `null`임을 함께 고정;
  (b) claim(만료 이후 `now`)이 Run+Chunk를 잡은 상태에서 이전 generation의 complete 시작 → 대기 후
      fenced `applied:false`, chunk는 pending, 정산 0회;
  (c) cancel 후 이전 worker complete → `applied:false`, 정산은 cancel의 1회뿐;
  (d) `deleteAllMemories` 후 이전 worker complete → `applied:false`, chunk 불변, **delete-all 정산 정확히 1회 +
      stale complete 추가 정산 0회**;
  (e) delete-all이 대기(pending, worker 없음) run을 취소하면 reservation이 그 transaction에서 정산됨.
  모두 `40P01` 없음, 크레딧 잔액·reservation 정산 횟수 확인. 제어된 순서는 `pg_sleep`이 아니라
  외부 transaction이 행을 잡고 있다가 놓는 기존 `whileCreditAccountLocked` 패턴을 따릅니다.

**delete-all 정산 (개정 v3, Codex 2차 #1)**: 현재 `deleteAllMemories()`(`lib/memoryService.ts:706`)는 run을
`cancelled`로만 바꾸고 크레딧을 정산하지 않습니다. 대기 중(worker 없는) run의 reservation은 지금도 영구히
`reserved`로 남고, 실행 중 run은 지금까지 stale complete가 우연히 정산해 왔는데 v2 fence가 그 경로를 막습니다.
따라서 같은 PR에서 delete-all을 `cancelMemoryExtractionRun`과 같은 계약으로 바꿉니다:

```
credit lock → SELECT id FROM "MemoryExtractionRun" WHERE userId AND status IN (pending, running) ORDER BY id FOR UPDATE
→ 해당 id들 cancelled → run마다 completed chunk 수로 settleExtractionRunCredits(outcome: cancelled)
→ memory lock → MemoryItem 삭제
```

순서는 credit(§9) → Run 행 → memory 잠금으로, 기존 "Run 먼저, memory 나중"(`tests/sourceDeletionLockOrder.test.mjs`)과
`tests/creditLockOrder.test.mjs`의 credit 우선을 모두 지킵니다. 정산은 run별 1회(settle 자체도 멱등).

### 4.2 staging 만료 ↔ 전체 import 삭제 (+ IMPORT-STAGING-FINALIZE-01 같은 함수)

현재: `expireStagingImport` = Snapshot deleteMany → Import UPDATE. `deleteExternalImport` = Import FOR UPDATE →
Snapshot FOR UPDATE. sweep(`reconcileExpiredExternalImportStaging`)는 transaction 밖에서 후보를 고르고
안에서 상태·TTL 재확인 없이 만료.

수정: **Import → Snapshot으로 통일, 잠금 아래 재판정.**

```ts
async function expireStagingImport(tx, importId) {   // 호출자 계약: Import 행을 이미 FOR UPDATE로 잡음
  await tx.$queryRaw`SELECT id FROM "ExternalConversation" WHERE "importId" = ${importId} AND finalized = false ORDER BY id FOR UPDATE`;
  await tx.externalConversation.deleteMany({ where: { importId, finalized: false } });
  await tx.externalImport.update({ … failed … });
}

// sweep
for (const { id } of stale) {
  const expired = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT status, "createdAt", "updatedAt" FROM "ExternalImport" WHERE id = ${id} FOR UPDATE`;
    if (!row || !isOpenImportStatus(row.status) || !isStagingExpired(row, now)) return false;   // 기존 helper(Date 인자) 재사용
    await expireStagingImport(tx, id);
    return true;
  });
  if (expired) count++;
}
if (count > 0) await recordExternalImportCounter("staging_expired", count, now);   // 건너뛴 후보는 세지 않음
return { expiredImports: count };
```

- append/seal/finalize의 lazy 만료 호출은 이미 Import FOR UPDATE를 잡은 뒤이므로 순서 정합.
  (그 뒤 410 throw로 rollback되는 기존 동작은 이번 범위에서 바꾸지 않고 기록만 합니다.)
- 재판정은 기존 `isStagingExpired(row, now)`(`lib/externalImportService.ts:108`)를 그대로 쓰고, 후보 쿼리의
  조건과 같은지 단위 테스트로 고정합니다.
- IMPORT-STAGING-FINALIZE-01: 잠금 아래 status 재확인으로 "후보 선정 후 finalize 완료 → failed 덮어쓰기"가
  막힙니다. 작업 목록 요구대로 **별도 assertion**으로 추적: DB 테스트에서 후보 선정 → finalize 완료 → sweep
  실행 순서 시 import `completed` 유지·counter 미증가.
- DB 테스트: (a) delete가 Import+Snapshot 잡은 상태에서 sweep → 대기 후 import 없음으로 건너뜀;
  (b) sweep이 Import 잡은 상태에서 delete → 대기 후 `cancelled`가 아니라 이미 failed 상태 삭제 정상 동작;
  (c) 활동으로 `updatedAt` 갱신 후 sweep → 건너뜀. `40P01` 없음.
- 정적 테스트: `tests/sourceDeletionLockOrder.test.mjs`에 expire 경로 Import→Snapshot 순서 assertion.

### 4.3 정책

`docs/policy/external-conversation-import-and-memory.md` §13.1 잠금 순서 문단에 staging 만료 경로와
`MemoryExtractionRun → MemoryExtractionChunk` 행 순서를 추가. credit 정책 §9 순서(credit → workflow advisory →
lease 행)는 그대로이며 Run이 lease 행입니다.

---

## 5. 공통 경계

- PR은 작업별 분리. 브랜치: `claude/to-develop/cont-search-01`, `claude/to-develop/cont-export-01b`,
  `claude/to-develop/import-lock-title-01`, `claude/to-develop/lock-order-cycles`. main 대상은 develop 병합 후
  같은 변경을 main 기준 브랜치로 옮겨 별도 PR.
- 각 PR 전: typecheck, eslint, 관련 unit, `check:accent-tokens`, `check:doc-references`, 정책 인용 검사,
  build 후 해당 E2E(desktop+mobile)와 mobile drawer spec. DB integration은 CI.
- 각 구현 PR은 Codex 독립 검토 후 push.
- 작업 목록 상태 갱신은 공유 브랜치 규칙상 사용자 확인 후.
