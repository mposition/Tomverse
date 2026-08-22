# Assistant knowledge staging 검증 체크리스트

`feature.assistantKnowledgeEnabled`를 켜기 전에 staging에서 확인할 항목입니다.
정책 근거는 `docs/policy/external-conversation-import-and-memory.md` §14(지식
파일), §14.2(보존·R2 lifecycle), §15.1(활성화 순서)입니다.

**7항목, 유료 1턴입니다.** 짧은 것이 이 문서의 요점이므로 왜 짧은지부터
적습니다.

## 왜 7항목인가 — CI가 증명하지 못하는 것만 남깁니다

이 기능의 계약은 대부분 **이미 CI에서, 실제 PostgreSQL을 상대로** 증명되고
있습니다. `tests/integration/assistant-knowledge-pipeline.db.test.ts`,
`assistant-knowledge-schema.db.test.ts`, `chat-profile-context.db.test.ts`가
매 PR마다 다음을 주장합니다.

| 계약 | 이미 증명하는 test |
|---|---|
| 다른 계정의 chunk에 닿지 않는다 | `retrieval never reaches another account's chunks` · `a chunk is reachable by its own owner column, not only through its file` |
| 다른 계정의 version을 대화 id로 읽을 수 없다 | `another account's version is not readable through a conversation id` |
| manifest는 지금 존재하는 것에만 해석된다 | `a manifest resolves against what exists now, per owner` |
| `ready`가 아닌 파일에서 retrieval하지 않는다 | `a file that is not ready is not retrieved from` · `only a ready file may claim chunks` |
| 삭제가 같은 transaction에서 tombstone을 남긴다 | `deleting files enqueues their object keys in the same transaction` |
| profile·계정 삭제가 파일과 chunk를 지운다 | `deleting a profile removes its files and their chunks; so does deleting the account` |
| flag가 꺼지면 행을 읽지 않고 거절한다 | `the flag being off refuses the profile without reading its row` |
| excerpt가 §9.1 순서로 fenced 블록에 들어간다 | `knowledge excerpts reach the block, fenced, and move the bundle identity` · `the turn's system block is the profile's, in §9.1 order` |
| quota 집계가 profile별·계정별로 맞다 | `usage is per profile for the profile ceiling and per account for the rest` |

**이것들을 staging에서 손으로 다시 하는 것은 검증이 아니라 중복입니다.** 같은
코드가 같은 질의를 같은 스키마에 던지는 것을 두 번 보는 일이고, 두 번째가
첫 번째보다 더 알려주는 것이 없습니다.

남는 것은 **CI가 일부러 손대지 않는 것**입니다. pipeline test가 스스로 적어
두었습니다 — *"The processing worker itself needs R2, which this suite
deliberately does [not exercise]"*. DB test는 `r2Key` 문자열을 만들 뿐 bucket에
닿지 않습니다.

그래서 이 회차가 판별하는 것은 셋뿐입니다.

1. **배포된 빌드에서 flag가 무엇을 닫고 무엇을 닫지 않는가** — test는
   함수를 부르고, 여기서는 배포된 route가 답합니다
2. **R2 왕복이 실제로 일어나는가** — 업로드된 bytes가 추출되고, 검색되고,
   삭제 후 정말로 사라지는가
3. **전환이 감사 기록에 남는가** — Admin Console과 해시 체인

## 무엇이 되돌릴 수 없는가

**파일 내용의 소실**입니다.

삭제는 DB-first입니다. 행이 사라지고 같은 transaction에서 object key가
tombstone이 되며, 그 뒤에 sweep이 bytes를 지웁니다
(`lib/assistantKnowledgeLifecycle.ts`). 순서가 뒤집히면 chunk가 가리키는
bytes가 먼저 사라지고, **원본은 사용자 로컬에만 있으므로 복원할 수 없습니다.**

DB 쪽 순서는 CI가 증명합니다. **bytes가 실제로 언제 사라지는지는 R2를 가진
환경에서만 알 수 있고, 그것이 §C-3이 존재하는 이유입니다.**

반대 방향 — R2에 orphan이 남는 것 — 은 저장 비용이고 sweep을 다시 돌리면
됩니다. 되돌릴 수 있으므로 차단이 아닙니다.

유출은 회수되지 않지만, 유출을 막는 두 좁힘(`userId` 컬럼과 manifest)은 위
표대로 CI가 실제 DB에서 판정합니다. staging에서 한 번 더 보는 것은 §D에
선택으로 둡니다.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 실행 결과는 **날짜와 전체 deploy SHA로 이름
붙인 별도 파일**로 `assistant-knowledge-staging-verification-records/` 아래에
남습니다.

- **template revision**: `2026-08-22b`
- 실행 방법과 파일 이름 규칙:
  `assistant-knowledge-staging-verification-records/README.md`

## 비용

**유료는 §C-2 한 턴뿐입니다.** knowledge 처리에는 provider 호출도 embedding도
없고(`lib/assistantKnowledgeChunking.ts`: "there are no embeddings", 정책 §11이
외부 embedding 전송을 금지), 업로드·추출·삭제·sweep은 전부 0크레딧입니다.

기본 모델(`gpt-5-6-luna`) Standard 기준 **1크레딧**. §D를 하면 1크레딧 더.

## 사전 조건

- staging이 서비스 중인 전체 40자리 SHA를 `GET /api/build-info`에서 읽었다
- 그 SHA의 knowledge 표면이 production과 같다:
  `git diff <staging> <production> -- 'lib/assistantKnowledge*.ts' 'app/api/assistant-profiles/**' lib/chatProfileContext.ts` 가 비어 있다.
  **SHA를 직접 대조하지 않습니다** — 릴리스가 squash되므로 staging SHA는
  production 이력에 나타나지 않습니다
- `assistantProfilesEnabled`가 **켜져 있다.** `isAssistantKnowledgeEnabled()`가
  두 flag의 AND이므로, 꺼져 있으면 이 회차는 §A만 측정한다
- `assistantKnowledgeEnabled`가 **아직 꺼져 있다**
- staging R2 bucket이 production과 분리돼 있다

## A. 켜기 전 (0크레딧)

켠 뒤에는 이 상태를 다시 만들기 어려우므로 먼저 합니다.

- [ ] A-1. flag가 꺼진 상태에서 `POST`(`action: "prepare"`)와 `GET`이 403
      `ASSISTANT_KNOWLEDGE_DISABLED`
- [ ] A-2. **같은 상태에서 `DELETE`는 열려 있다.** 403이 아니어야 한다 —
      403이면 그것이 결함이다

`DELETE`가 예외인 것은 실수가 아니라 §15 rollback의 결과입니다. flag를 끄는
것은 기능을 닫는 일이지 **이미 저장한 데이터를 지울 능력을 뺏는 일이
아닙니다.** 그래서 삭제는 `assistantKnowledgeEnabled`와
`assistantProfilesEnabled`가 **둘 다** 꺼졌을 때만 닫힙니다
(`app/api/assistant-profiles/[profileId]/knowledge/[fileId]/route.ts`).

이 회차의 사전 조건은 profiles가 켜져 있는 것이므로, `DELETE`는 열려 있는
쪽이 정상입니다.

## B. 전환 (0크레딧)

- [ ] B-1. Admin Console(`PATCH /api/admin/app-settings`)로 전환했고
      `AdminAuditLog`에 시작·완료 두 행이 남았다
- [ ] B-2. `GET /api/admin/audit-integrity`가 `valid: true`이고
      `checkedEntries`가 전환 전보다 크다

## C. R2 왕복 (유료 1턴) — 이 회차의 이유

- [ ] C-1. 파일 하나를 업로드(`prepare` → `finalize`)하면
      `processingStatus`가 `ready`가 되고 chunk가 생긴다
- [ ] C-2. 그 파일에만 있는 내용을 묻는 turn 1건에서, 답이 그 내용을 쓴다.
      **판별 대상은 답의 품질이 아니라 excerpt가 prompt에 닿았다는 사실이다**
- [ ] C-3. 그 파일을 삭제하면 tombstone이 생기고, **sweep이 돈 뒤 R2 object가
      실제로 사라진다.** DB 쪽 순서는 CI가 이미 증명하므로, 여기서 보는 것은
      bytes다

## D. 더 확인하고 싶다면 (전부 차단 아님)

각 항목은 위 표대로 CI가 이미 판정합니다. staging 데이터로 한 번 더 보는
것이며, 건너뛰고 서명해도 됩니다 — 판정란에 그렇게 적습니다.

- [ ] D-1. 계정 2개로 교차 확인. 계정 1의 profile 대화에 계정 2의 파일이
      인용되지 않는다 (유료 1턴)
- [ ] D-2. 개별 32MiB·profile당 20개·계정당 100개 중 하나가 거절된다
- [ ] D-3. 지원하지 않는 mime이 거절된다

## 실행 기록

```
npm run new:staging-verification-record -- --feature assistant-knowledge --sha <staging에 실제 배포된 40자리 SHA>
```
