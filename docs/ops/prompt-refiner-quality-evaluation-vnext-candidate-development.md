---
status: development_only
approvedBy: mposition
approvalDate: 2026-10-01
approvedScope: DEVELOPMENT_CANDIDATE_AND_FIXTURE_EVALUATION
spendAuthority: none
dispatchAuthority: none
productConnectionAuthority: none
sourceClosure: prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json
---

# Prompt Refiner vNext 후보 개발·v6 증거 기록

운영자는 기존 v6 실패 3건의 **읽기 전용 진단**, 새 후보 model/adapter/system
prompt·strict parser·평가기의 합성 개발 fixture 검증, exact source closure 고정과
Claude Code Max 구독 CLI 독립 검토를 승인했다. 이는 새 holdout 작성·봉인,
provider 요청, stage/run 승인·실행, 제품 연결, PR 병합·배포 또는 실사용 traffic
권한이 아니다. `--skip-preflight` 예외는 구독 CLI의 읽기 전용 검토에만 적용한다.

## 기존 v6 관측과 한계

staging owner UI의 과거 `prompt-refiner-shadow-run-v6` evidence를 읽기 전용으로
확인했다. 고정 gate는 `fail`, 통과 13/16이다. 실패 3건은 다음과 같다.

| caseId | terminal | evidence | failureReason |
| --- | --- | --- | --- |
| `prsv1-ko-03` | `suggested` | `fail` | `required_concept_missing` |
| `prsv1-en-02` | `failed` | `fail` | `not_suggested` |
| `prsv1-en-08` | `failed` | `fail` | `not_suggested` |

이 read-only 화면에는 두 `failed`의 원시 답변·세부 terminalReason이 없으므로
원인을 모델·parser·provider 중 하나로 확정하지 않는다. 공개 v1 corpus에서
`prsv1-en-08`은 `no_change`를 예상한 음성 사례이고, `prsv1-ko-03`의 분석 요청과
기존 `requiredConceptGroups` 사이에는 rubric 긴장이 있다. 이것은 개발 가설이지
v6 판정 번복 근거가 아니다. v1 corpus/spec, v3~v6 run·gate는 불변이며 이 세
사례는 새 독립 holdout의 분자에 넣지 않는다.

## 후보와 개발용 공통 rubric

후보는 가격 pin의 직접 Luna identity, 4,096 output cap, 15초 timeout, retry 0을
참조하지만 provider revision은 미관측이고 **dispatch 권한이 없다**. Adapter는
현 단계에서 system/user 메시지를 구성하는 순수 함수일 뿐 provider client가
아니다. sourceText는 user 메시지의 JSON 데이터 필드에만 담고, embedded 지시는
분석 대상으로 취급한다. 응답은 기존 vNext strict parser의 `suggested` 또는
`abstained` 3필드 JSON만 허용하며 `no_change`는 실패다.

합성 개발 fixture의 공통 확인은 구조·방향 일치와 미리 지정한 exact literal의
문자열 보존에 한정한다. 리터럴 지정이 없는 제안의 해당 결과는 `null`(미검사)이지
`true`가 아니다. 방향 일치는 의미 보존이나 개선의 증거가 아니며,
리터럴 존재는 내용의 안전·동등성·충분성을 증명하지 않는다. 개발 평가 함수는
항상 `semanticPreservation: unverified`, `releaseDecision: not_admissible`을
반환한다. 사람의 제한 감사와 별도 미노출 holdout 없이 gate `pass`를 만들지
않는다. 회귀 fixture는 quoted unsafe directive의 분석, JSON literal 보존,
`no_change` 거부, unsupported abstention 거부, 실제 unsafe 자제 구조를 포함한다.

`sourceClosure`는 후보·평가기의 실행 시 참조하는 source, 승인된 설계 문서,
이번 합성 개발 fixture를 고정한다. 기존의 별도 회귀 테스트는 검토 guard로
실행하지만 후보 closure의 fixture가 아니다. JSON parser의 기존 모듈에 있는
`import type`은 런타임에 제거되는 타입 전용 참조이며 runtime closure가 아니다.
열거된 파일의 SHA-256이 하나라도 달라지면 이 후보는 같은 후보가 아니며
새로운 closure·검토가 필요하다. 이 manifest는 개발 snapshot 식별자이고
sealed holdout manifest 또는 운영 승인값이 아니다.
