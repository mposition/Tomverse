# Prompt Refiner confirmatory shadow v5 successor 계약

상태: **구현 검증 중, provider 실행·제품 노출 미승인**

## 1. 목적

`prompt-refiner-shadow-v2`는 run 승인·실행 flag가 꺼진 배포에서 생성된 뒤, 두 flag를
활성화하는 재배포로 exact deployment 결속이 달라졌다. 이 기록은 삭제·수정·재사용하지
않고 immutable audit evidence로 보존한다. v5 successor는 같은 모델·합성 corpus·비용
상한을 새 identity로 다시 승인할 수 있게 하며, 같은 순서 오류가 재발하지 않게 한다.

- reservation stage: `prompt-refiner-shadow-v3`
- reservation authority: `prompt-refiner-reservation-authority-v3`
- stage admission: `prompt-refiner-stage-admission-v3`
- runtime source manifest: `prompt-refiner-runtime-source-manifest-v4`
- execution manifest: `prompt-refiner-shadow-execution-manifest-v3`
- run: `prompt-refiner-shadow-run-v5`

기존 v1/v3 및 v2/v4 stage·run·reservation·attempt 행과 audit는 그대로 유지한다. migration은
새 행을 seed하거나 기존 행을 backfill하지 않는다.

## 2. 선행 flag 게이트

서버 preview는 run 승인 flag와 execution flag를 각각 표시하고 두 값의 conjunction인
`activationReady`를 제공한다. 둘 중 하나라도 false면 브라우저는 stage 승인 버튼을
비활성화하고, server writer도 audit 또는 stage row를 만들기 전에 fail-closed한다.

따라서 immutable stage를 만든 뒤 flag 활성화를 위해 재배포하는 순서는 더 이상 가능하지
않다. 두 flag가 켜진 exact deployment에서만 60분 approval window가 시작된다.

## 3. runtime·비용 결속

stage preview와 writer는 승인 시점 staging deployment의 full commit SHA, Railway deployment
id와 **189개 고정 source 파일**의 exact bytes를 결속한다.
189개 중 178개는 8개 실행 root의 local TypeScript/JavaScript runtime import closure이며,
나머지 11개는 resolution
metadata, Prisma schema 및 세 migration이다. 파일당 8 MiB, 전체 16 MiB 상한은 유지한다.

PostgreSQL runtime validator v4는 successor migration을 exact ordered path에서 제거해 만든
188-file v3 manifest를 기존 validator로 다시 검증한다. v3 stage와 v5 run의 insert guard는
새 digest만 허용하고, 기존 행의 immutable/update guard는 유지한다.

비용 및 실행 경계는 v4와 동일하다.

- provider/model: `openai/gpt-5-6-luna`
- 합성 case: 16
- 요청당 최악 상한: US$0.024916
- run 최악 상한: US$0.398656
- stage authority 상한: US$2.491600 / 100 slots
- timeout: 15,000 ms
- retry: 0
- unknown outcome: stop, no redispatch

## 4. 비권한성

이 successor는 제품 Chat, 실제 사용자 prompt, 제안형 UI 또는 Router coupling을 활성화하지
않는다. `productAdapterReady`는 false이며 provider 실행에는 owner의 exact stage/run 승인과
별도 비용 승인이 계속 필요하다.

## 5. 검증 기준

- 빈 PostgreSQL 전체 migration 적용 및 schema drift 0
- 기존 v1/v2 stage와 v3/v4 run 기록 보존
- flag-off deployment에서 stage writer와 UI 모두 승인 차단
- flag-on exact deployment에서만 v3 stage와 v5 run 생성
- 189-file TypeScript/PostgreSQL ordered closure 일치
- content-free evidence, no-retry, unknown-stop 경계 유지
- unit, server-contract, DB integration, typecheck, lint, 저장소 gate 통과
- Claude Code Max 구독 CLI 독립 검토 승인
