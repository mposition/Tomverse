# Router development benchmark v1 독립 검토 기록

상태는 **`passed`**이며 round 0에서 종결됐습니다. author는 `codex`, reviewer는
`claude`입니다. 사용자가 제공한 대화형 Claude 판정 `approve`, `findings: []`를
변경 없이 받아 기존 `replayExchange`가 집계한 결과입니다. 제어 프로그램이
Claude CLI를 실행하거나 검토자 신원을 인증했다는 뜻은 아니며, 내부 Codex
검토나 로컬 테스트만으로 독립 검토 승인을 만든 것이 아닙니다.

- 소스 commit: `138bd4c60bd0534dbf131df5f7868fe9d1f623f4`
- 비교 base: `89288a8671ef25c30084b71f8a9266a3ae9f5475`
- round: `0`
- 검토 대상 전체 digest: `sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345`
- [검토 prompt](review-prompt.md), [원래 task](../router-development-benchmark-v1.task.json),
  [변경 diff](change-round0.diff), [package](package-round0.json),
  [exchange](exchange.json), [반영한 판정](verdict-round0.json)

## 실행 기록과 판정 출처

제어 프로그램의 실행 모드는 `--mode=package`뿐입니다. 제어 프로그램이
`npm run test:router-development-benchmark`와 `check:encoding`,
`check:doc-references`, `check:policy-section-references`,
`check:router-quality-eval`을 실제 실행하여 모두 성공을 관측했습니다.
package의 출력은 기존 도구가 보존하는 마지막 몇 줄이며, 검토자가 직접
테스트를 실행했다는 뜻은 아닙니다. `checkFailures`는 빈 배열,
현재 exchange의 `reviewConclusion`은 제공받은 판정에 따라 `approve`입니다.
이 import에서 package 테스트를 다시 실행한 것은 아닙니다.

검토 prompt의 guard 출력에 있는 공백만의 네 줄은 `renderReviewPrompt`의
원본 바이트를 보존한 것이며, 통과한 소스 코드 diff 검사와 별개입니다.

이 package 준비와 판정 import에서 Claude/Codex author·reviewer 실행기와
`preflight`, `review`, `live` 모드는
실행하지 않았습니다. `--skip-preflight`나 실패 검사 override를 승인하거나
사용하지 않았습니다. Claude CLI 검토를 시작할 권한 및 필요한 override는
별도 결정이며 이 파일이 대신하지 않습니다.

## 외부 판정 import

사용자는 “추가 CLI 재검토 없이 대화형 Claude 승인을 출처와 함께 기록하고
기존 집계기로 종결”하는 제안에 **“네 그렇게 해주세요”**라고 승인했습니다.
이는 제공된 판정의 기록 반영 범위이며, 검토자 CLI 실행·preflight 생략·
운영 승인·push·배포에 대한 승인이 아닙니다.

- 실제 import/replay 시각: `2026-09-10T01:22:03.982Z`
- import 당시 HEAD: `394387ce9ee4e540b7dbdc652015ca06757eb038`
- [원문 검토 메모](external-review/reviewnotesrouterdevelopmentbenchmarkv1round0.md),
  [원문 판정](external-review/verdictrouterdevelopmentbenchmarkv1round0.json),
  [원문 후보 record](external-review/verdictround0.candidaterecord.json)는 원본 바이트로 보존했습니다.
- 원본 출처는 로컬 `C:\Users\Vyper\Downloads`의 동일 파일명입니다.
  전체 경로와 hash는 반영한 판정의 `importProvenance.sourceArtifacts`에도 있습니다.

| 원문 파일 | SHA-256 |
|---|---|
| 검토 메모 | `ce6f558c37f3eb7251db9fb9f93bbedca4af160cd22eb1004c4a0f60ea4c8371` |
| 판정 | `b37ed72309e074c51abbc135570a6a66932a326489b6968cd10a4c08d3a9059e` |
| 후보 record | `5afdb5eb66c78f9601ddfd7667d9330f5b99c0f8de23e49a90657af82e7fb27c` |

원본과 보존본의 hash 및 바이트, 후보와 원문 판정의 내용, 소스/package digest,
기존 순수 집계 함수의 결과 일치를 importer가 직접 확인했습니다. Hash는 자료의
동일성을 확인하는 것이며 검토자 신원·전자서명·사람의 검수·실행 환경을 인증하지
않습니다. 후보의 `command`, `preflight`, `usage` 등 null 필드를 유지했습니다.
후보의 `overrides`는 제공된 설명을 보존한 것이지 도구 override를 사용하거나
preflight 생략을 새로 승인한 기록이 아닙니다.

후보의 `startedAt: 2026-09-10T00:50:00.000Z`는 근사 시작 시각이고,
`receivedAt: 2026-09-10T01:05:00.000Z`는 제공자가 판정 완료로 보고한 시각입니다.
둘 다 importer가 관측·검증한 세션 시각이 아닙니다. 메모의 직접 실행 95개 테스트,
형 검사·lint·읽기 전용 작업 등의 서술도 **검토자가 제공한 보고**로 보존하며,
이번 import에서 직접 실행하거나 sandbox를 확인한 증거로 승격하지 않았습니다.

`passed`는 위 전체 digest의 검토 기록 종결만 뜻합니다. 모델 품질·운영 준비·
실제 provider 실행·출시 승인이 아닙니다. 제어 프로그램·schema·소스 코드는
바꾸지 않았고, 기존 package의 lineage·headCommit·worktreeDirty·filesChanged와
실제 검사 기록을 보존한 채 순수 `replayExchange` 결과를 반영했습니다.

## 비차단 후속 관찰

검토자가 보고한 “선언된 모델 한도 256과 계획/답변 파서의 공유 200,000-node
예산 간 차이”는 판정 밖 후속 작업 후보로만 남깁니다. 126개 복제 카탈로그에서
거부되고 현재 42개에서는 77,417 nodes였다는 수치는 제공된 검토 보고이며,
이번 기록 작업에서 다시 실행한 결과가 아닙니다. findings에 추가하거나 코드를
수정하지 않았고 현재 digest의 approve 판정을 바꾸지 않았습니다.

## 당시 전달한 검토 요청 — 이력 보존

아래 요청과 생성된 `review-prompt.md`는 판정 전 인계 당시의 원문입니다.
현재 상태는 위의 `approve/passed`이며, 아래의 대기 문구는 현재 상태 안내가 아닙니다.

```text
H:\Project\tomverse-router-benchmark-v1-20260910\docs\ops\cross-review\packages\router-development-benchmark-v1\review-prompt.md를 읽고 그 응답 형식을 따르십시오.

원래 요구사항과 diff를 먼저 읽고, 그 다음 테스트 기록과 작성자 설명을 읽으십시오. 읽기 전용 검토이며 파일 수정, commit, provider 호출, 배포는 금지합니다. 테스트 기록에서 관측한 사실과 직접 실행해서 관측한 사실을 구분하십시오. 재현 가능한 정확성·집계·정답 노출·provenance·실행 경계 문제만 구체적인 위치와 재현 방법으로 보고하십시오.

판정은 taskId router-development-benchmark-v1, round 0, source commit 138bd4c60bd0534dbf131df5f7868fe9d1f623f4, digest sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345에만 적용됩니다. 다른 digest에 대한 판정은 재사용하지 마십시오. 실제 Claude 판정이 기록되기 전 exchange는 awaiting_review로 유지합니다. 이 요청 자체가 CLI 실행이나 preflight 생략을 승인하는 것은 아닙니다.
```

## 생성 경위와 남은 도구 제약

최초 package 시도에서는 PowerShell 실행 환경의 PATH에 `sh`가 없어 제어
프로그램의 테스트·guard 명령이 시작되지 못했습니다. 이후 Git에 포함된
`C:\Program Files\Git\bin\sh.exe`를 해당 package 실행 process의 PATH에만
추가했습니다. 전역 설정, 설치된 프로그램, 제어 코드와 writable scope는
바꾸지 않았습니다.

재생성 시 기존 출력 5개가 먼저 scope 밖 변경으로 거부되었습니다. 현재
package 도구는 outside-scope 검사를 출력 제외 처리보다 먼저 하므로,
`--diff-exclude`에 자기 출력 폴더를 지정해도 이 검사를 통과하지 못합니다.
실패한 최초 자료는 삭제하지 않고 아래 절대 경로로 폴더째 보관했습니다.

`H:\Project\router-benchmark-v1-initial-package-attempt-20260910`

보관한 자료는 실패한 첫 시도의 기록이며 최종 통과 증거가 아닙니다. 원래
출력 위치가 빈 상태에서 같은 미검토 round 0을 package 모드로 재생성하여
위 테스트·guard의 실제 성공 결과를 얻었습니다. 제외 경로는 이 package
출력 폴더 하나뿐이며, `generatedPaths`는 비어 있습니다.

도구의 review 모드는 scoped diff digest를 대조하므로 package 기록 commit과
소스 검토 대상을 구분할 수 있습니다. 다만 일반적으로 후속 round를 package할
때 이미 기록된 출력 파일도 outside-scope 검사에 걸리는 기존 제약은 남습니다.
이번 exchange는 round 0에서 `passed`로 종결됐으므로 새 소스 변경에는 새 검토
및 exchange가 필요합니다. 이번 작업은 제어 프로그램을 수정하지 않았으며,
후속 자동 수정·재검토 루프가 완전히 해결됐다고 주장하지 않습니다.
