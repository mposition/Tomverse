# Backlog 카드를 Todo로 올리는 절차

Tomverse DB가 AMUX 카드의 정본이다. 로컬 AMUX Board는 이 절차의 결과를 보여 주지 않는다. 카드를 `backlog`에서 `todo`로 옮기는 사람의 경로는 둘이고, 둘 다 owner 계정과 최근 step-up이 필요하다. 올린 카드는 owner가 없는 Todo로 남는다. 배정은 claim이 한다.

## 어느 경로를 쓰는가

| 경로 | 화면 | 한 요청 | 용량 행 | 졸업 집계 |
|---|---|---|---|---|
| 추천 풀 결정 | `/admin/amux-board-recommendation` | 카드 한 장 | 같은 트랜잭션에서 재계산 | 센다 |
| 수동 승격 | `/admin/amux-board-promotion` | 카드 1~3장 | 거치지 않는다 | 세지 않는다 |

추천 풀은 남은 용량만큼만 카드를 포함한다. 포함되지 않은 카드를 approve하면 `not_included`로 거절된다. 이관 카드의 kind와 priority가 모두 같으면 점수가 같아서, 포함 순서가 사실상 카드 id 순서가 된다. 원하는 카드가 포함되지 않으면 수동 승격을 쓴다.

## 추천 풀 결정

1. preview를 보낸다. 본문은 `{"canonicalizationVersion":"amux-json-v1","policyVersion":7}`이다. 아무것도 쓰지 않는다.
2. prepare를 같은 본문으로 보낸다. snapshot이 생기고 15분 동안 유효하다.
3. decide를 보낸다. prepare한 같은 계정이어야 한다. approve 본문은 `canonicalizationVersion`, `policyVersion` 7, 새 UUID `decisionId`, `snapshotId`, `decision` `"approve"`, `item`이다. `item`은 아래 항목 규칙을 따른다.
4. 응답이 `outcome_unknown`이면 다시 보내지 않고 DB를 읽어 확인한다.

## 수동 승격

1. preview 본문은 `{"canonicalizationVersion":"amux-json-v1","policyVersion":3,"items":[...]}`이다. 항목은 1~3개다.
2. prepare, approve, apply 순서로 누른다. approve 창은 15분이다.
3. 여러 장이면 한 장을 먼저 올리고 결과를 읽은 뒤 나머지를 올린다. 이 순서는 운영 절차이고 코드가 강제하지 않는다.

## 항목 규칙

항목의 키는 정확히 `cardId`, `expectedRevision`, `sourceDigest`, `kind`, `priority`, `classification`, `executionBrief`다.

- `expectedRevision`과 `sourceDigest`는 카드의 현재 값과 같아야 한다.
- `kind`는 `blocker`, `escalation`, `bug`, `code`, `ops`, `investigation`, `research`, `chore`, `doc` 중 하나다. `unknown`은 거절된다.
- `classification`은 `task_kind`, `complexity`(1~10), `risk`(1~3), `files_expected`(0~1000)다.
- `executionBrief`는 공백이 아닌 8 KiB 이하 텍스트다. worker에게 그대로 전달된다.

## Brief에 쓸 수 없는 것

요청 본문 전체가 catalog 내용 검사기를 지난다. 하나라도 걸리면 `content_refused`로 거절되고 아무것도 쓰이지 않는다. 화면은 어느 문자열이 걸렸는지 말하지 않는다.

- 슬래시 `/`와 역슬래시. 파일 경로, 브랜치 이름 예시, `a/b` 같은 표기가 모두 해당한다. 경로 대신 파일 이름과 설명을 쓴다.
- URL과 `www.`
- 40자리 또는 64자리 16진수 문자열. 지정된 digest 필드는 예외다.
- 공백 없이 32자 이상 이어진 영숫자 문자열
- 토큰 접두어와 개인 키 머리글
- 비공개 문서 저장소 이름

brief는 공개 PR 설명에 옮겨질 수 있다고 보고 쓴다. 비공개 문서의 경로와 내용을 넣지 않는다.
