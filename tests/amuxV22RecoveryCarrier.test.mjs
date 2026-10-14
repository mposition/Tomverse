import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = relative => readFile(new URL(`../${relative}`, import.meta.url), "utf8");
const directive = (text, name) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];

test("controller timer is an inert non-overlap 60 second carrier", async () => {
  const [timer, service, installer, env] = await Promise.all([
    source("scripts/systemd/amux-v22-recovery-controller.timer"),
    source("scripts/systemd/amux-v22-recovery-controller.service"),
    source("scripts/install-amux-v22-recovery-controller.sh"),
    source("scripts/systemd/amux-v22-recovery-controller.env.example"),
  ]);
  assert.equal(directive(timer, "OnBootSec"), "60s");
  assert.equal(directive(timer, "OnUnitInactiveSec"), "60s");
  assert.equal(directive(timer, "AccuracySec"), "1s");
  assert.equal(directive(timer, "RandomizedDelaySec"), "0");
  assert.equal(directive(timer, "Persistent"), "false");
  assert.equal(directive(timer, "Unit"), "amux-v22-recovery-controller.service");
  assert.doesNotMatch(timer, /^OnCalendar=|^OnUnitActiveSec=/m);
  assert.equal(directive(service, "Type"), "oneshot");
  assert.equal(directive(service, "User"), "root");
  assert.equal(directive(service, "Restart"), "no");
  assert.equal(directive(service, "TimeoutStartSec"), "30");
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/tomverse-amux-v22\/recovery-controller\.mjs$/m);
  assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.match(installer, /amux-v22-recovery-controller\.timer/);
  assert.match(installer, /systemd-analyze verify[\s\S]*recovery-controller\.service[\s\S]*recovery-controller\.timer/);
  assert.match(installer, /\/usr\/bin\/systemctl daemon-reload/);
  assert.doesNotMatch(installer,
    /\/usr\/bin\/systemctl\s+(?:enable|disable|start|restart|stop|try-restart|reload)\b/);
  assert.doesNotMatch(installer, /tomverse-bridge-watchdog/);
  assert.match(env, /^TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED=false$/m);
  assert.match(env, /^TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED=false$/m);
});

test("inspector timer stays non-root, instance-fixed, inspect-only and off by default", async () => {
  const [timer, service, installer, env, entry] = await Promise.all([
    source("scripts/systemd/amux-v22-recovery-inspector@.timer"),
    source("scripts/systemd/amux-v22-recovery-inspector@.service"),
    source("scripts/install-amux-v22-recovery-inspector.sh"),
    source("scripts/systemd/amux-v22-recovery-inspector.env.example"),
    source("scripts/amux-v22-recovery-checker.mjs"),
  ]);
  for (const [name, expected] of [["OnBootSec", "60s"], ["OnUnitInactiveSec", "60s"],
    ["AccuracySec", "1s"], ["RandomizedDelaySec", "0"], ["Persistent", "false"]])
    assert.equal(directive(timer, name), expected);
  assert.equal(directive(timer, "Unit"), "amux-v22-recovery-inspector@%i.service");
  assert.doesNotMatch(timer, /^OnCalendar=|^OnUnitActiveSec=/m);
  assert.equal(directive(service, "Type"), "oneshot");
  assert.equal(directive(service, "User"), "tomverse-amux-v22-inspector");
  assert.equal(directive(service, "Group"), "amux-v22-ipc");
  assert.equal(directive(service, "Restart"), "no");
  assert.equal(directive(service, "TimeoutStartSec"), "30");
  assert.match(service, /^Environment=TOMVERSE_AMUX_V22_WORKER=%i$/m);
  assert.match(service,
    /^Environment=TOMVERSE_AMUX_V22_SIDECAR_SOCKET=\/run\/tomverse-amux-v22-%i\/task\.sock$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/tomverse-amux-v22\/recovery-checker\.mjs$/m);
  assert.doesNotMatch(service, /^(?:Wants|Requires)=.*sidecar/m);
  assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.match(service, /^InaccessiblePaths=\/etc\/tomverse-amux-v22\/recovery-controller\.env$/m);
  assert.match(service, /^InaccessiblePaths=\/var\/lib\/tomverse-amux-v22\/recovery-stop-intents$/m);
  assert.match(env, /^TOMVERSE_AMUX_V22_RECOVERY_CHECKER=0$/m);
  assert.match(env, /^TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET=/m);
  assert.doesNotMatch(env, /SYNC_SECRET|CONTROLLER_SECRET|DATABASE_URL|GITHUB_TOKEN|API_KEY/);
  assert.match(entry, /AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV/);
  assert.match(entry, /"TOMVERSE_AMUX_SYNC_SECRET"/);
  assert.match(entry, /"TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET"/);
  assert.doesNotMatch(entry, /systemctl\s+(?:start|restart|stop)|spawn|execFile/);
  assert.match(installer, /inspector_uid == 0/);
  assert.match(installer, /id -G "\$inspector_user"/);
  assert.match(installer, /inspector_group_ids != \*" \$inspector_gid "\*/);
  assert.doesNotMatch(installer, /useradd|groupadd|usermod/);
  assert.match(installer, /systemd-analyze verify[\s\S]*recovery-inspector@\.service[\s\S]*recovery-inspector@\.timer/);
  assert.match(installer, /\/usr\/bin\/systemctl daemon-reload/);
  assert.doesNotMatch(installer,
    /\/usr\/bin\/systemctl\s+(?:enable|disable|start|restart|stop|try-restart|reload)\b/);
  assert.doesNotMatch(installer, /tomverse-bridge-watchdog/);
});

test("v43 keeps the v38-v42 recovery history", async () => {
  const policy = await source("docs/policy/development-agent-orchestration.md");
  const v38 = policy.slice(policy.indexOf("## 버전 38"), policy.indexOf("## 버전 39"));
  const v39 = policy.slice(policy.indexOf("## 버전 39"), policy.indexOf("## 버전 40"));
  const v40 = policy.slice(policy.indexOf("## 버전 40"), policy.indexOf("## 버전 41"));
  assert.match(policy, /상태\(v40 이력\): \*\*v40 FIRST Task 전용 읽기 전용 API executor 대안 계약 승인/);
  assert.match(policy, /상태\(v41 이력\): \*\*v41 packed Git object의 고정 읽기 전용 provenance 조회 승인/);
  assert.match(policy, /상태\(v42 이력\): \*\*v42 FIRST Task 전용 API 인증·모델 접근 증거 승인/);
  assert.match(policy, /상태\(최신\): \*\*v43 FIRST Task prior attempt ID 전사 오류 정정 승인/);
  assert.equal(policy.match(/^상태\(최신\):/gm)?.length, 1);
  assert.match(policy, /정책 버전: 38/);
  assert.match(policy, /정책 버전: 39/);
  assert.match(policy, /정책 버전: 40/);
  assert.match(policy, /정책 버전: 41/);
  assert.match(policy, /정책 버전: 42/);
  assert.match(policy, /정책 버전: 43/);
  // The corrected prior attempt is the real DB attempt; the typo survives only
  // as history inside the v43 correction.
  const v43 = policy.slice(policy.indexOf("## 버전 43"));
  assert.equal(policy.split("97858395-3d66-42fa-9bfb-0e5a6cba9bd8").length - 1, 1);
  assert.match(v43, /97858395-3d66-42fa-9bfb-0e5a6cba9bd8/);
  assert.match(v38, /TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET/);
  assert.match(v38, /secret 값의 생성·등록·host 배포는 이 승인에 포함되지 않는다/);
  assert.match(v38, /실제 script 실행, unit 설치,[\s\S]*timer enable\/start/);
  assert.match(v39, /accept_unknown_prior_effects/);
  assert.match(v39, /prior attempt의 결과, 외부 효과와 사용량은 계속 `unknown`이다/);
  assert.match(v39, /prior held \+ new maximum <= 6,800,000/);
  assert.match(v40, /read_only_api_retry_v1/);
  assert.match(v40, /모델이 볼 수 있는 tool은 형태가 고정된 `Read`, `Grep`, `Glob` 셋뿐이다/);
  assert.match(v40, /key 생성·등록,[\s\S]*provider 호출,[\s\S]*열지 않는다/);
});

test("60 second pickup does not invent a request TTL or consume the 90 second evidence window", async () => {
  const [service, runtime, policy] = await Promise.all([
    source("lib/amux/v22TaskRecoveryService.ts"),
    source("lib/amux/workerRuntime.ts"),
    source("docs/policy/development-agent-orchestration.md"),
  ]);
  const inspectPending = service.slice(service.indexOf("export function pendingAmuxV22RecoveryInspections"),
    service.indexOf("export function pendingAmuxV22LegacySafeStops"));
  const stopPending = service.slice(service.indexOf("export function pendingAmuxV22LegacySafeStops"),
    service.indexOf("export function reportAmuxV22RecoveryEvidence"));
  for (const body of [inspectPending, stopPending]) {
    const where = body.match(/where: \{([^}]*)\}/)?.[1] ?? "";
    assert.notEqual(where, "");
    assert.doesNotMatch(where, /requestedAt|expires|expiry/);
  }
  assert.match(runtime, /AMUX_WORKER_RUNTIME_LEASE_MS = 90_000/);
  assert.match(service, /age >= 0 && age <= AMUX_WORKER_RUNTIME_LEASE_MS/);
  assert.match(policy, /AccuracySec` 기본 1분 coalescing[\s\S]*1초로 좁혀/);
  assert.match(policy, /60초는[\s\S]*queue pickup 주기이지 request TTL이 아니며/);
  assert.match(policy, /90초는[\s\S]*`evidence\.recordedAt`부터 owner 승인까지/);
  assert.match(policy, /30초도 한 번의[\s\S]*host process 실행 상한/);
});
