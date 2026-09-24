# 독립 검토 요청 — routing-snapshot ceiling, 2라운드

- 브랜치: `claude/to-develop/routing-snapshot-ceiling`
- 1라운드: `.github/audits/routing-snapshot-ceiling-review-prompt-2026-09-23.md`,
  판정 **approve_with_changes**, major 2 · minor 2.

## 1라운드 지적과 대응

**major 1 — 상한이 아직 상한이 아니었습니다.** 발행자가 entry와 같은 호출에
`approvedCeiling`을 넘겼으므로, 배포 100개에 상한 100을 적으면 둘 다
통과했습니다.

대응: 상한을 **별도의 승인 행**(`RoutingSnapshotCeilingApproval`)으로 만들고
manifest가 그것을 **인용**합니다.

- 승인 행은 append-only(UPDATE/DELETE/TRUNCATE trigger), 이름 있는 승인자
- manifest는 `ceilingApprovalId`(FK RESTRICT)와 값의 사본 `approvedCeiling`
- **BEFORE INSERT trigger**가 사본이 인용한 승인과 다르면 거절하고, 승인이
  publish보다 뒤면 거절합니다
- `ManifestInput`에서 자유 숫자 `approvedCeiling`을 없애고
  `ceilingApproval: CeilingApproval | null`로 바꿨습니다. 테스트가 그 필드
  부재를 고정합니다

주석에 한계를 적었습니다 — 쓰기 권한이 있는 사람은 같은 1분 안에 상한을
승인하고 그 아래 publish할 수 있습니다. 막는 것은 **귀속·날짜·불변인 승인이
아닌 숫자 아래 publish하는 것**이고, 이 스키마의 다른 승인이 주는 보증과
같습니다.

**major 2 — 주석과 테스트 이름이 코드보다 컸습니다.** "said twice on purpose,
and the two say different things", "the database says the same thing about the
stored count", "refused publication and the last approved snapshot stands".

대응: CHECK는 **한 행의 두 정수**에 관한 것이고 entry 행을 보지 않는다고
다시 적었습니다. `manifestProblems()`는 **보고할 뿐 쓰기를 거절하지
않으며** publisher가 아직 없다고 적었습니다. 테스트 이름을 "reported, not
trimmed", "two integers on one row"로 바꿨습니다.

**minor** — §5 → §8.5, 비어 있지 않은 테이블이면 migration이 실패해야
한다는 문장 추가.

## 이번에 봐 주셨으면 하는 것

1. **새 trigger가 major 1을 닫습니까?** 특히:
   - 사본이 승인과 같은지만 봅니다. entry 개수가 **승인된 값** 이하인지는
     여전히 `entryCount` 경유입니다. 이 경로로 상한을 넘는 manifest가 들어갈
     수 있습니까?
   - `approved_at > NEW."approvedAt"`의 방향이 맞습니까? 같은 시각은
     허용됩니다.
   - trigger가 `NOT FOUND`를 따로 거절합니다. FK가 이미 막는데 중복입니까,
     아니면 BEFORE INSERT 시점에 FK가 아직 검사되지 않아 필요합니까?
2. **새 테이블의 registry 행이 맞습니까?** `actor`·`retain`·`legal_hold`,
   `subjectReference: none`, export 제외.
3. **3치 논리.** trigger의 `<>`와 `>` 비교에 NULL이 들어갈 수 있습니까?
   `ceiling`·`approvedAt`·`approvedCeiling`은 전부 NOT NULL입니다.
4. **주장이 코드보다 큰 곳이 남았습니까?** 이번에 고친 문장들을 포함해서.

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
