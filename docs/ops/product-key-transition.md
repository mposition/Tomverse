# Conversation.productKey 전환 runbook

계약: `docs/policy/conversation-product-key.md`.
결정 정본: 제품 경계 결정 기록 v1.2 §2.

**이 문서의 어떤 단계도 아직 production에서 실행되지 않았습니다.**

## 0. 지금 어디까지 와 있는가

| 단계 | 상태 |
|---|---|
| 1 Expand | 코드에 있음 (`20260822090000_conversation_product_key_expand`). **production 미배포** |
| 2 Dual-write | 코드에 있음 (`lib/conversationCreation.ts` + `check:conversation-writers`) |
| 3 Dual-read | **읽기 도구만 있음** — `lib/productKeyReadMode.ts`. 아직 어떤 reader도 부르지 않음 |
| 4 Backfill | **dry-run만** — `npm run report:product-key-backfill` |
| 5 Verify | 미실행 |
| 6 Strict | 미실행 |
| 7 Enforce | migration 미작성 |

## 1. 환경변수

| 변수 | 값 | 필수 시점 |
|---|---|---|
| `PRODUCT_KEY_READ_MODE` | `legacy_fallback` \| `strict` | 미설정 시 `legacy_fallback` |
| `PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT` | RFC 3339 | `legacy_fallback`인 동안 **필수** |
| `PRODUCT_KEY_EXPAND_DEPLOYED_AT` | RFC 3339 | 최대 수명 검사에 **필수** |

`resolveProductKeyReadMode()`가 거부하는 것 셋 — 결정 기록 §2가 요구한 그대로:

1. **만료값 없음** — "지정 release 또는 만료일까지"는 만료 규칙의 *자리*이지
   만료가 아닙니다. 값이 비면 `legacy_fallback`이 종착 상태가 됩니다.
2. **이미 지난 날짜** — 설정하고 잊은 값입니다.
3. **허용된 최대 수명보다 먼 날짜** — 이것이 없으면 운영자가 2099년을 넣어도
   나머지 검사를 전부 통과합니다.

최대 수명은 **expand production 배포 후 30일**입니다. 저장소는 배포 시각을 알 수
없으므로 `PRODUCT_KEY_EXPAND_DEPLOYED_AT`이 그 기준점이고, **그 값이 없는 것 자체가
네 번째 거부**입니다 — 입력이 없으면 조용히 적용을 멈추는 한도는 한도가 아닙니다.

결정 기록의 "**또는 production release 2회 중 먼저 도래하는 시점**"은 이 코드가
셀 수 없습니다. release counter가 없습니다. 그쪽은 이 runbook의 의무이고,
날짜 쪽만 기계화돼 있습니다. **두 조건 중 먼저 오는 쪽에서 멈춥니다.**

### 아직 하지 않은 배선

`/api/ready`에 이 검증을 아직 연결하지 않았습니다. **의도된 것입니다** — 지금은
어떤 reader도 productKey를 읽지 않으므로, 연결하면 쓰이지도 않는 기능 때문에
production readiness가 즉시 실패합니다. 연결은 **3단계(dual-read)와 같은 변경에서**
합니다. 그때 `PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT` 없이 배포하면 `/api/ready`가
실패해야 합니다.

## 2. Backfill

```
# 보고 (안전, 언제든)
npm run report:product-key-backfill

# 티켓에 붙일 JSON — --silent 필수, 아니면 npm 배너가 섞입니다
npm run --silent report:product-key-backfill -- \
  --classifications=<path.json> --json > report.json
```

읽는 것은 `Conversation.{id,kind,selectionMode,productKey}` 뿐입니다. 제목도
메시지도 읽지 않으므로 보고서를 티켓에 그대로 붙일 수 있습니다.

### 순서와 가운데의 게이트

1. `selectionMode='auto'` 행을 **추출**합니다 — 분류가 아니라 추출입니다.
2. 추출된 각 행을 **사람이** Drill 로그·trace·운영 증거로 분류합니다.
3. **게이트** — 미분류가 1건이라도 남아 있으면 backfill과 strict 전환이 **둘 다**
   중단됩니다.
4. `kind='image'` → `studio`
5. 나머지 NULL → `review`
6. 검증 — NULL = 0, 미분류 = 0, Drill 행이 전부 `chat`

**`selectionMode='auto'`는 분류 근거가 아닙니다.** 결정 3이 "selectionMode로 제품을
유도하거나 백필할 수 없다"고 확정했으므로, 두 절 뒤에서 그 값을 분류 기준으로 쓰면
같은 문서 안에서 모순입니다. 그것은 "확인이 필요한 Drill 후보 또는 비정상"을
가리키는 **신호**일 뿐이고, 그 신호가 만드는 것은 사람이 볼 목록입니다.

예상 건수는 **0**입니다 — 컬럼 기본값이 `manual`이고 Auto 토글이 마운트된 적이
없어 `auto`로 바꿀 경로가 없었습니다. 다만 **기본값과 UI 미마운트는 증거가 아니라
예상**이므로 production 보고서로 확인합니다.

`staging_drill_override`는 현재 메모리상 cohort decision에만 있고 RoutingRun에
영속화되지 않습니다. 로그 보존이 확인되지 않은 상태에서 이를 백필의 유일한 정본으로
삼지 마십시오.

### 미분류 행에 안전한 기본값이 없는 이유

- `review`로 덮으면 → 증거가 사라지고, 되돌릴 근거가 남지 않습니다.
- NULL로 남기면 → NULL = 0이라는 종료 조건을 만족할 수 없고, NOT NULL 전환도
  통과하지 못합니다.

**통과하는 유일한 경로는 모든 예외를 사람이 판정해 해소한 뒤 4·5단계를 실행하는
것입니다.** 예외 목록은 진행하면서 제외하는 목록이 아니라 진행을 막는 작업 목록입니다.

### 분류 파일 형식

```json
[
  {
    "conversationId": "cmt...",
    "productKey": "chat",
    "evidence": "staging drill log 2026-08-14, trace 9f2"
  }
]
```

`evidence`가 요점입니다. 없는 항목은 분류가 아니라 추측이고, 스크립트가 거부합니다.

## 3. 쓰기 (아직 실행 금지)

```
npm run report:product-key-backfill -- \
  --apply --approved-backfill \
  --ticket="<url>" --actor="<name>" \
  --classifications=<path.json> \
  --dry-run-report=<report.json>
```

전부 있어야 합니다. `--apply` 하나로는 "보고서를 읽고 예외가 0건임을 확인했다"와
"누가 명령줄을 복사했다"를 구분할 수 없고, 이 backfill이 덮는 행은 되돌릴 근거가
남지 않습니다.

`--dry-run-report`의 digest가 이번 실행이 계산한 digest와 다르면 **거부**합니다 —
보고서를 검토한 뒤 데이터가 움직였다는 뜻이고, 그 검토는 지금 쓰려는 것을 덮지
않습니다.

CI(`CI`, `GITHUB_ACTIONS`)와 npm build/start/deploy/migrate lifecycle에서는 **어떤
승인으로도** 쓰지 않습니다.

각 update는 `WHERE productKey IS NULL`을 함께 겁니다. 보고서 이후에 제품을 얻은
행은 이 실행이 덮을 대상이 아닙니다.

### 검증 완료 상태 (production 아님)

이 도구는 로컬 PostgreSQL 통합 테스트 DB에서 dry-run → 게이트 거부 →
전체 승인 write → 검증까지 끝까지 확인했습니다. **production에서는 실행되지
않았습니다.**

## 4. Strict 전환 (아직 실행 금지)

결정 기록 §2의 종료 조건 여섯이 전부 충족돼야 합니다.

1. NULL 행이 연속 검증 **2회 이상** 0건
2. 모든 Conversation 생성 경로의 명시적 write 테스트 통과
3. backfill 대상·제외 대상 보고서 보존
4. strict-read 전환 후 오류 0건
5. legacy-read **rollback rehearsal** 완료
6. `PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT`까지 전환

**제약 검증(`VALIDATE CONSTRAINT`)과 NOT NULL 전환은 같은 것이 아닙니다.** 각각
별도 migration이고 각각 별도 증거를 갖습니다. 절차는
`docs/policy/conversation-product-key.md` §7.
