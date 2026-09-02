---
record: staging-verification
checklist: docs/ops/external-conversation-continuation-staging-checklist.md
templateRevision: 2026-09-01a
environment:
deploySha:
startedAtUtc:
completedAtUtc:
executor:
approver:
result:
frozen: false
digest:
---

# 외부 대화 이어가기 staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| production SHA와 동일한가 | |
| 다르다면 관련 표면 diff 결과 | |
| template revision | (기록을 열 때 front matter에서 채워집니다) |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| `externalConversationContinuationEnabled` (시작 시점) | |
| `externalConversationImportEnabled` | |
| `memoryExtractionEnabled` / `memoryInjectionEnabled` | |
| `20260830090000_conversation_continuation_bridge` 적용됨 | |

## 시료

| 시료 | 무엇을 담았는가 | 준비됨 |
|---|---|---|
| 평범한 import 대화 (user/assistant 10턴 이상) | | |
| prompt-injection 문자열과 fence marker를 담은 대화 | | |
| 잘린 메시지를 포함한 대화 | | |

## §A 삭제 의미 (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| A-1 Conversation·메시지 유지 | | |
| A-2 tombstone 표시, 원문 미표시 | | |
| A-3 삭제 후 새 메시지 응답 | | |
| A-4 import 전체 삭제도 동일 | | |

## §B share·export (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| B-1 share 409 | | |
| B-2 export에 외부 원문 없음 + provenance 3줄 | | |
| B-3 일반 대화 export 무변화 | | |

## §C 권한·lock (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| C-1 cross-account 404 | | |
| C-2 잠긴 snapshot 423 | | |
| C-3 재잠금 후 seed 없음 | | |
| C-4 grant namespace 교차 거절 | | |

## §D prompt boundary (차단)

| 항목 | 관측(답변 요지) | 판정 |
|---|---|---|
| D-0 role 경계 테스트 통과 | | |
| D-1 지시 미수행 | | |
| D-2 제공자 사칭 없음 | | |
| D-3 외부 발언을 자기 것으로 주장하지 않음 | | |

## §E flag off (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| E-1 기존 대화 열림 | | |
| E-2 flag off에서 새 메시지 응답 | | |
| E-3 CTA 403 | | |
| E-4 ordinary chat·Review 무회귀 | | |

## §H 목록 재진입 (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| H-1 목록에서 `/continuations/[id]`로 열림 | | |
| H-2 외부 원문·출처 재표시 | | |
| H-3 검색 결과도 같은 곳 | | |
| H-4 일반·이미지 대화 무회귀 | | |

## §I 플래그 경로 (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| I-1 전용 체크박스 존재 | | |
| I-2 GET이 값 반환 | | |
| I-3 audit 두 행 | | |
| I-4 끈 직후 발췌 없음, 사유 `flag_off` 또는 `flag_off_stale_cache` | | |
| I-5 다중 인스턴스에서 어느 turn에도 원문 없음 | | |
| I-6 배포 인스턴스 수 | | |

## §J 중복 방지 (차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| J-1 두 번 클릭 → 대화 1개 | | |
| J-2 응답 유실 후 재시도 → 대화 1개 | | |
| J-3 취소 후 재시도 → 새 fork | | |

## §K 다중 모델 계약 (차단)

<!-- 시작 상태: 모델 두 개를 고른 continuation. §A·§C·§E·§I는 모델 하나로
     실행했는지 여기 아래 "모델 개수"에 적습니다. -->

| 항목 | 관측 | 판정 |
|---|---|---|
| 모델 개수 — §A·§C·§E·§I 실행 시 / §K 실행 시 | | |
| K-1 질문 1개 → 패널 2개, 모델 이름 표시 | | |
| K-2 원본 구획이 화면에 한 번, 패널 안에 복제 없음, 원본 메시지 수 불변 | | |
| K-3(a) 요청 두 건의 `modelId`가 표시된 모델과 일치 | | |
| K-3(b) 요청 본문에 가져온 원본 문장 없음 | | |
| K-3(c) preflight 한 건, `modelIds`가 같은 두 모델 | | |
| K-4 전송 전 예상(모델별·합계) / 실제 소비 크레딧 | | |
| K-5 기존 continuation의 `selectedModels` 불변, surface 불변 | | |
| K-6 상한에서 교체를 묻는가, 취소 시 불변, 마지막 모델 제거 거절 | | |
| K-7 실패 격리 결정적 검사 통과 여부 (유료 turn 없음) | | |

## §F 화면 (비차단)

| 항목 | 관측 | 판정 |
|---|---|---|
| F-1 구획·divider | | |
| F-2 provider badge·외부 답변 | | |
| F-3 잘림 고지 | | |
| F-4 새로고침 구조 유지 | | |
| F-5 320px 겹침·overflow 없음 | | |
| F-6 한국어 IME | | |


## 크레딧

| 구획 | turn 수 | 사용 크레딧 |
|---|---|---|
| §A-1 (메시지 2개) | | |
| §A-3 | | |
| §A-4 (A-1~A-3 반복) | | |
| §C-3 | | |
| §D-1 · D-2 | | |
| §E-2 | | |
| §I-4 | | |
| §I-5 (다중 인스턴스일 때만) | | |
| §K-1 (모델 2개) | | |
| 합계 | | |

## 건너뛴 구획과 이유

## 판정

<!-- 통과 / 조건부 / 실패. 사람이 씁니다. -->

## 서명

<!-- 사람이 씁니다. -->
