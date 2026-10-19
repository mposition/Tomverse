# QA·릴리스 병합 레인: dev DB 복구

병합 레인이 develop에 병합한 PR의 dev 배포가 실패해 레인이 latch했을 때, dev DB를 병합 직전 상태로 되돌리는
절차입니다(정책 `docs/policy/qa-release-agent.md` 8절 3항·5항). develop은 2026-10-13부터 Railway `dev` 환경이
배포하므로(`docs/ops/dev-test-lanes.md`) 대상은 staging이 아니라 **dev**입니다. production과 staging(Test)은
건드리지 않습니다.

## 1. 대상이 dev인지 확인 (Railway·Neon 대시보드, 읽기만)

1. Railway → `Tomverse` project → 환경 **dev** → `Tomverse` 서비스 → 실패한 배포를 엽니다. branch가 `develop`이고
   commit이 Admin의 latch 화면에 보이는 merge commit과 같아야 합니다.
2. 같은 서비스의 Variables에서 `DIRECT_DATABASE_URL`의 **host만** 봅니다. Neon 대시보드에서 그 host가 dev
   project의 branch임을 확인합니다. production이나 staging의 host이면 여기서 멈춥니다.
3. 배포 로그의 pre-deploy(`npm run db:migrate`) 출력에서 실패한 migration 이름을 적어 둡니다.

## 2. 무엇으로 되돌릴지 고르기

| 상황 | 방법 |
|---|---|
| 실패한 migration이 **적용되지 않고** 실패로만 남았고, 그 migration의 첫 문장에서 실패했거나 SQL 전체가 한 트랜잭션(`BEGIN`…`COMMIT`)이다 | 3-가: `migrate resolve --rolled-back` |
| 그 밖의 모든 경우(이미 적용된 migration이 있다, 실패 전에 일부 문장이 적용됐을 수 있다, 판단이 서지 않는다) | 3-나: Neon 시점 복원 |

`migrate resolve`는 이미 적용된 변경을 되돌리지 못합니다. 애매하면 3-나입니다.

## 3-가. 실패 기록만 지우기

**실행 위치:** 로컬 PC의 PowerShell, Tomverse clone 폴더 안(develop checkout). Node 22와 `npm ci`가 필요합니다.
**dev DB에 씁니다**(실패 행 하나를 rolled back으로 표시). production 자격증명은 필요 없습니다. 같은 창에서 이어 실행합니다.

```powershell
$env:DIRECT_DATABASE_URL = "<dev의 DIRECT_DATABASE_URL — 1-2에서 확인한 것>"
npx prisma migrate resolve --rolled-back <실패한 migration 이름>
```

Prisma CLI는 `prisma.config.ts`가 고르는 `DIRECT_DATABASE_URL`만 씁니다. 앱용 `DATABASE_URL`은 필요 없습니다. 창을 닫으면
`$env:DIRECT_DATABASE_URL`은 사라집니다. 이 값을 대화에 붙이지 않습니다.

## 3-나. Neon 시점 복원

1. Neon 대시보드 → dev project → Branches → dev가 쓰는 branch → **Restore**.
2. 시점은 Admin latch 화면의 시도 기록 시각(병합 직전)보다 앞, 그리고 그 뒤 dev에 다른 병합이 없었던 시각으로 고릅니다.
   Neon의 복원 가능 기간(history retention) 안이어야 합니다. 기간을 넘었으면 운영자 판단으로 dev DB를 새로 만들고
   `npm run db:migrate`로 처음부터 적용합니다(dev에는 실사용자 데이터가 없습니다).
3. 복원은 그 branch를 덮어씁니다. Neon이 남기는 복원 전 백업 branch는 4의 확인이 끝날 때까지 지우지 않습니다.

## 4. 원인 PR 되돌리기와 확인

1. GitHub에서 병합된 PR을 **Revert** 해 develop PR을 만들고 사람이 병합합니다. 이 PR은 병합 레인이 다루지 않습니다
   (`docs/policy/**`·migration을 건드리면 레인의 제외 대상이고, 그렇지 않아도 latch 중에는 레인이 병합하지 않습니다).
2. dev 재배포가 성공하는지 Railway에서 봅니다. 성공한 배포의 commit SHA(revert가 들어간 develop)를 적어 둡니다.
3. 로컬 checkout을 **그 SHA로** 맞춥니다. 비교는 로컬 `prisma/migrations`로 scratch DB를 만들므로, 실패한 migration이 남은
   checkout으로 비교하면 같은 migration에서 다시 실패하거나 복구된 dev와 차이를 보고합니다.

   ```powershell
   git fetch origin develop
   git switch --detach <2에서 적은 SHA>
   npm ci
   ```

4. schema 비교로 drift가 0인지 확인합니다. **실행 위치:** 로컬 PC의 PowerShell, 3에서 맞춘 clone 폴더 안.
   dev DB는 읽기만 하고, 두 번째 URL은 **비어 있고 버려도 되는** DB(예: Neon에서 만든 빈 branch)여야 합니다 — 그 내용은 지워집니다.

   ```powershell
   $env:COMPARE_SOURCE_DATABASE_URL = "<dev의 DIRECT_DATABASE_URL>"
   $env:COMPARE_SCRATCH_DATABASE_URL = "<빈 일회용 DB>"
   npm run db:compare-schema
   ```

   출력은 연결 문자열을 가린 차이 목록이라 그대로 붙여도 됩니다. 차이가 0이어야 합니다.

## 5. latch 풀기

Admin → Agent digest → QA·릴리스 → latch 해제에서 그 시도를 **"복구했음"(실패로 닫음)**으로 고릅니다(정책 8절 5항). 그 뒤
다음 10분 회차부터 레인이 다시 후보를 봅니다.
