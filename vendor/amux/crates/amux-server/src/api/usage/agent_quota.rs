//! Read-only account probes. No session, prompt, login or credential refresh.
//! Protocols match review-orchestrator's Cursor/Copilot quota probes.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::{provider_probe_unavailable, ProviderProbe};

const BODY_LIMIT: usize = 128_000;
const STREAM_LIMIT: usize = 256_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const CURSOR_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

fn unavailable(provider: &'static str, cause: &'static str) -> ProviderProbe {
    provider_probe_unavailable(
        provider,
        cause,
        &format!("{provider} account usage is unavailable ({cause})."),
    )
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn cursor_auth_path() -> Option<PathBuf> {
    let home = home_dir()?;
    #[cfg(target_os = "windows")]
    {
        Some(
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Roaming"))
                .join("Cursor/auth.json"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        Some(home.join(".cursor/auth.json"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Some(
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("cursor/auth.json"),
        )
    }
}

async fn read_credentials(path: &Path) -> io::Result<Value> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(BODY_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > BODY_LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| io::ErrorKind::InvalidData.into())
}

fn cursor_access_token<'a>(
    credential: &'a Value,
    api_key: Option<&str>,
    now: i64,
) -> Option<&'a str> {
    let token = credential
        .get("accessToken")?
        .as_str()
        .filter(|s| !s.is_empty())?;
    if api_key.is_some_and(|key| credential.get("apiKey").and_then(Value::as_str) != Some(key)) {
        return None;
    }
    // Only reject known expired JWTs. The service validates opaque tokens/signatures.
    if let Some(payload) = token
        .split('.')
        .nth(1)
        .and_then(|s| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(s)
                .ok()
        })
        .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
    {
        if payload
            .get("exp")
            .and_then(Value::as_f64)
            .is_some_and(|exp| exp <= now as f64)
        {
            return None;
        }
    }
    Some(token)
}

pub(super) async fn probe_cursor_usage() -> ProviderProbe {
    if std::env::var("CURSOR_API_BASE_URL")
        .ok()
        .is_some_and(|url| url != "https://api2.cursor.sh")
    {
        return unavailable("cursor", "unsupported_endpoint");
    }
    let Some(path) = cursor_auth_path() else {
        return unavailable("cursor", "no_credentials");
    };
    let credential = match read_credentials(&path).await {
        Ok(value) => value,
        Err(_) => return unavailable("cursor", "no_credentials"),
    };
    let key = std::env::var("CURSOR_API_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    let Some(token) =
        cursor_access_token(&credential, key.as_deref(), chrono::Utc::now().timestamp())
    else {
        return unavailable("cursor", "credential_unavailable");
    };
    let client = match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return unavailable("cursor", "probe_failed"),
    };
    let mut response = match client
        .post(CURSOR_URL)
        .bearer_auth(token)
        .header("Connect-Protocol-Version", "1")
        .json(&json!({}))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(response) if response.status().as_u16() == 401 => {
            return unavailable("cursor", "credential_unavailable")
        }
        Ok(_) | Err(_) => return unavailable("cursor", "probe_failed"),
    };
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= BODY_LIMIT => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return unavailable("cursor", "unexpected_shape"),
        }
    }
    match serde_json::from_slice(&bytes) {
        Ok(body) => ProviderProbe::Ok(body),
        Err(_) => unavailable("cursor", "unexpected_shape"),
    }
}

fn copilot_probe_process(token: Option<&str>) -> tokio::process::Command {
    let binary = std::env::var("AMUX_COPILOT_CMD")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "copilot".into());
    let mut args = vec![
        "--headless",
        "--stdio",
        "--no-auto-update",
        "--no-auto-login",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-remote",
        "--no-remote-export",
    ];
    if token.is_some() {
        args.extend([
            "--auth-token-env",
            "COPILOT_GITHUB_TOKEN",
            "--secret-env-vars",
            "COPILOT_GITHUB_TOKEN",
        ]);
    }
    #[cfg(unix)]
    let mut command = {
        // Match the worker's login-shell executable lookup, as Codex does.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut command = tokio::process::Command::new(shell);
        let quoted_binary = format!("'{}'", binary.replace('\'', "'\\''"));
        command.args(["-lc", &format!("exec {quoted_binary} {}", args.join(" "))]);
        command.process_group(0);
        command
    };
    #[cfg(not(unix))]
    let mut command = {
        let mut command = tokio::process::Command::new(binary);
        command.args(args);
        command
    };
    if let Some(token) = token {
        command.env("COPILOT_GITHUB_TOKEN", token);
    }
    if let Some(home) = home_dir() {
        command.current_dir(home);
    }
    command
}

pub(super) async fn probe_copilot_usage() -> ProviderProbe {
    if home_dir().is_none() {
        return unavailable("copilot", "no_credentials");
    }
    // Same SDK token precedence as the worker CLI; otherwise use saved CLI login.
    let token = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().filter(|s| !s.is_empty()));
    let key =
        std::env::var("AMUX_COPILOT_QUOTA_KEY").unwrap_or_else(|_| "premium_interactions".into());
    if key.len() > 64
        || key.is_empty()
        || !key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return unavailable("copilot", "invalid_quota_key");
    }
    let mut child = match copilot_probe_process(token.as_deref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return unavailable("copilot", "probe_failed"),
    };
    let result = if let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take())
    {
        tokio::time::timeout(
            PROBE_TIMEOUT,
            copilot_exchange(&mut stdin, stdout, token.as_deref()),
        )
        .await
    } else {
        Ok(Err(io::ErrorKind::BrokenPipe.into()))
    };
    // Terminate the entire probe group on Unix, including any CLI helpers.
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    match result {
        Ok(Ok(body)) => ProviderProbe::Ok(
            json!({"quota_key": key, "quota": body.pointer(&format!("/quotaSnapshots/{key}")).cloned()}),
        ),
        _ => unavailable("copilot", "probe_failed"),
    }
}

async fn send_frame<W: AsyncWrite + Unpin>(writer: &mut W, message: Value) -> io::Result<()> {
    let body = serde_json::to_vec(&message)?;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R, total: &mut usize) -> io::Result<Value> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        reader.read_exact(&mut byte).await?;
        header.push(byte[0]);
        if header.len() > 8_192 {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    let header_text = std::str::from_utf8(&header).map_err(|_| io::ErrorKind::InvalidData)?;
    let lengths = header_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case("Content-Length"))
        .map(|(_, value)| value.trim().parse::<usize>())
        .collect::<Vec<_>>();
    let length = match lengths.as_slice() {
        [Ok(length)] if (1..=BODY_LIMIT).contains(length) => *length,
        _ => return Err(io::ErrorKind::InvalidData.into()),
    };
    *total += header.len() + length;
    if *total > STREAM_LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(|_| io::ErrorKind::InvalidData.into())
}

async fn copilot_exchange<W: AsyncWrite + Unpin, R: AsyncRead + Unpin>(
    stdin: &mut W,
    stdout: R,
    token: Option<&str>,
) -> io::Result<Value> {
    send_frame(
        stdin,
        json!({"jsonrpc":"2.0","id":1,"method":"connect","params":{}}),
    )
    .await?;
    let mut reader = BufReader::new(stdout);
    let mut total = 0;
    let mut awaiting = 1;
    loop {
        let message = read_frame(&mut reader, &mut total).await?;
        if message.get("method").is_some() {
            if let Some(id) = message.get("id") {
                send_frame(stdin, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not supported"}})).await?;
            }
            continue;
        }
        if message.get("id").and_then(Value::as_i64) != Some(awaiting) {
            continue;
        }
        if awaiting == 1 && message.pointer("/error/code").and_then(Value::as_i64) == Some(-32601) {
            awaiting = 2;
            send_frame(
                stdin,
                json!({"jsonrpc":"2.0","id":2,"method":"ping","params":{}}),
            )
            .await?;
        } else if message.get("error").is_some() {
            return Err(io::ErrorKind::InvalidData.into());
        } else if awaiting == 3 {
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| io::ErrorKind::InvalidData.into());
        } else {
            if message
                .pointer("/result/protocolVersion")
                .and_then(Value::as_f64)
                .is_none()
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            awaiting = 3;
            send_frame(stdin, json!({"jsonrpc":"2.0","id":3,"method":"account.getQuota",
                "params":token.map(|token| json!({"gitHubToken":token})).unwrap_or_else(|| json!({}))})).await?;
        }
    }
}

fn shape_unavailable(id: &str, label: &str, cause: &str, reason: &str) -> Value {
    json!({"id":id,"label":label,"available":false,"measured":false,"metered":true,
        "n_considered":0,"cause":cause,"reason":reason,"windows":[]})
}

pub(super) fn shape_cursor_provider(probe: ProviderProbe) -> Value {
    let body = match probe {
        ProviderProbe::Ok(body) => body,
        ProviderProbe::Unavailable { cause, reason } => {
            return shape_unavailable("cursor", "Cursor", cause, &reason)
        }
    };
    let malformed = || {
        shape_unavailable(
            "cursor",
            "Cursor",
            "unexpected_shape",
            "Cursor did not report a supported included-plan quota.",
        )
    };
    let Some(plan) = body.get("planUsage").and_then(Value::as_object) else {
        return malformed();
    };
    let keys = [
        ("totalPercentUsed", "Included plan"),
        ("autoPercentUsed", "Auto models"),
        ("apiPercentUsed", "API models"),
    ];
    if keys.iter().any(|(key, _)| {
        plan.get(*key)
            .is_some_and(|v| v.as_f64().is_none_or(|n| n < 0.0))
    }) || plan.get("remaining").is_some_and(|v| v.as_f64().is_none())
    {
        return malformed();
    }
    let remaining = plan.get("remaining").and_then(Value::as_f64);
    let mut windows = keys.into_iter().filter_map(|(key, label)| {
        let used = plan.get(key)?.as_f64()?;
        Some(json!({"label":label,"kind":key,"used_percent":used,
            "remaining_percent":if remaining.is_some_and(|n| n <= 0.0) { 0.0 } else { (100.0-used).clamp(0.0,100.0) },
            "resets_at": body.get("billingCycleEnd").and_then(Value::as_str).and_then(|s| s.parse::<i64>().ok())
                .or_else(|| body.get("billingCycleEnd").and_then(Value::as_i64)).map(|ms| ms / 1000)}))
    }).collect::<Vec<_>>();
    if windows.is_empty() {
        let Some(remaining) = remaining else {
            return malformed();
        };
        let used = if remaining <= 0.0 {
            Some(100.0)
        } else {
            plan.get("limit")
                .and_then(Value::as_f64)
                .filter(|n| *n > 0.0)
                .map(|limit| 100.0 * (1.0 - remaining / limit))
        };
        if let Some(used) = used {
            windows.push(json!({"label":"Included plan","kind":"plan","used_percent":used.clamp(0.0,100.0),"remaining_percent":(100.0-used).clamp(0.0,100.0)}));
        }
    }
    // Monetary amounts are cents, not an invented percentage. Routing consumes
    // only measured percentages (or a proven zero); on-demand spending is not capacity.
    json!({"id":"cursor","label":"Cursor","available":true,"measured":true,"metered":true,
        "n_considered":windows.len(),"source":"Cursor CLI current-period usage",
        "remaining_usd":remaining.map(|n| n.max(0.0)/100.0),"windows":windows})
}

pub(super) fn shape_copilot_provider(probe: ProviderProbe) -> Value {
    let body = match probe {
        ProviderProbe::Ok(body) => body,
        ProviderProbe::Unavailable { cause, reason } => {
            return shape_unavailable("copilot", "GitHub Copilot", cause, &reason)
        }
    };
    let malformed = || {
        shape_unavailable(
            "copilot",
            "GitHub Copilot",
            "unexpected_shape",
            "Copilot did not report a supported account entitlement.",
        )
    };
    let Some(row) = body.get("quota").and_then(Value::as_object) else {
        return malformed();
    };
    let unlimited = row.get("isUnlimitedEntitlement") == Some(&json!(true))
        && row.get("entitlementRequests") == Some(&json!(-1));
    let remaining = if unlimited {
        100.0
    } else {
        let Some(remaining) = row
            .get("remainingPercentage")
            .and_then(Value::as_f64)
            .filter(|n| (0.0..=100.0).contains(n))
        else {
            return malformed();
        };
        let Some(entitlement) = row
            .get("entitlementRequests")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0)
        else {
            return malformed();
        };
        let Some(used) = row
            .get("usedRequests")
            .and_then(Value::as_f64)
            .filter(|n| *n >= 0.0)
        else {
            return malformed();
        };
        if used >= entitlement {
            0.0
        } else {
            remaining
        }
    };
    json!({"id":"copilot","label":"GitHub Copilot","available":true,"measured":true,"metered":true,
    "n_considered":1,"source":"Copilot account.getQuota","windows":[{
        "label":"Account entitlement","kind":body.get("quota_key").and_then(Value::as_str),
        "used_percent":100.0-remaining,"remaining_percent":remaining,"unlimited":unlimited,
        "entitlement_requests":row.get("entitlementRequests").and_then(Value::as_f64),
        "used_requests":row.get("usedRequests").and_then(Value::as_f64),
        "resets_at":row.get("resetDate").and_then(Value::as_str).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp())
    }]})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(plan: Value) -> Value {
        shape_cursor_provider(ProviderProbe::Ok(json!({"planUsage":plan,
            "billingCycleEnd":"1791504000000","accessToken":"do-not-forward"})))
    }

    fn copilot(row: Value) -> Value {
        shape_copilot_provider(ProviderProbe::Ok(
            json!({"quota_key":"premium_interactions",
            "quota":row,"accountId":"do-not-forward"}),
        ))
    }

    #[test]
    fn cursor_included_pools_preserve_exhaustion_and_money_units() {
        let row = cursor(
            json!({"remaining":1200,"totalPercentUsed":40,"autoPercentUsed":100,"apiPercentUsed":20}),
        );
        assert_eq!(row["measured"], true);
        assert_eq!(row["remaining_usd"], 12.0);
        assert_eq!(row["windows"][1]["remaining_percent"], 0.0);
        assert_eq!(row["windows"][0]["resets_at"], 1791504000i64);
        assert!(!row.to_string().contains("do-not-forward"));
        let zero = cursor(json!({"remaining":0,"totalPercentUsed":3}));
        assert_eq!(zero["windows"][0]["remaining_percent"], 0.0);
        let amount = cursor(json!({"remaining":400,"limit":2000}));
        assert_eq!(amount["windows"][0]["remaining_percent"], 20.0);
        assert_eq!(
            cursor(json!({"remaining":0}))["windows"][0]["remaining_percent"],
            0.0
        );
        assert_eq!(cursor(json!({"remaining":400}))["windows"], json!([]));
    }

    #[test]
    fn cursor_malformed_or_pooled_only_responses_stay_unknown() {
        for plan in [
            json!({}),
            json!({"remaining":"0"}),
            json!({"totalPercentUsed":-1}),
            json!({"remaining":100,"autoPercentUsed":null}),
        ] {
            let row = cursor(plan);
            assert_eq!(row["measured"], false);
            assert_eq!(row["cause"], "unexpected_shape");
        }
        assert_eq!(
            shape_cursor_provider(ProviderProbe::Ok(
                json!({"spendLimitUsage":{"pooledRemaining":1000}})
            ))["measured"],
            false
        );
    }

    #[test]
    fn cursor_tokens_must_match_the_worker_account_and_not_be_expired() {
        let expired = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":100}"#);
        let credential = json!({"accessToken":format!("x.{expired}.y"),"apiKey":"same"});
        assert!(cursor_access_token(&credential, Some("same"), 100).is_none());
        assert!(cursor_access_token(&credential, Some("different"), 99).is_none());
        assert!(cursor_access_token(&credential, Some("same"), 99).is_some());
        assert_eq!(
            cursor_access_token(&json!({"accessToken":"opaque"}), None, 100),
            Some("opaque")
        );
    }

    #[test]
    fn copilot_quota_is_entitlement_not_ai_credit_currency() {
        let row = copilot(
            json!({"isUnlimitedEntitlement":false,"entitlementRequests":300,
            "usedRequests":90,"remainingPercentage":70,"resetDate":"2026-11-01T00:00:00Z"}),
        );
        assert_eq!(row["windows"][0]["remaining_percent"], 70.0);
        assert_eq!(row["windows"][0]["resets_at"], 1793491200i64);
        assert!(row.get("remaining_usd").is_none());
        assert!(!row.to_string().contains("do-not-forward"));
        for (used, remaining) in [(300, 50), (90, 0)] {
            let row = copilot(json!({"entitlementRequests":300,"usedRequests":used,
                "remainingPercentage":remaining,"usageAllowedWithExhaustedQuota":true,
                "overageAllowedWithExhaustedQuota":true}));
            assert_eq!(row["windows"][0]["remaining_percent"], 0.0);
        }
        let unlimited = copilot(json!({"isUnlimitedEntitlement":true,"entitlementRequests":-1}));
        assert_eq!(unlimited["windows"][0]["remaining_percent"], 100.0);
        assert_eq!(unlimited["windows"][0]["unlimited"], true);
        for row in [
            json!({}),
            json!({"entitlementRequests":-1,"remainingPercentage":100,"usedRequests":0}),
            json!({"entitlementRequests":300,"usedRequests":0,"remainingPercentage":101}),
        ] {
            assert_eq!(copilot(row)["measured"], false);
        }
    }

    #[tokio::test]
    async fn copilot_transport_only_handshakes_and_reads_quota_with_same_token() {
        for legacy in [false, true] {
            let (client, server) = tokio::io::duplex(4096);
            let (output, input) = tokio::io::split(client);
            let fake = tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(server);
                let mut read = BufReader::new(read);
                let mut total = 0;
                let connect = read_frame(&mut read, &mut total).await.unwrap();
                assert_eq!(connect["method"], "connect");
                if legacy {
                    send_frame(
                        &mut write,
                        json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601}}),
                    )
                    .await
                    .unwrap();
                    let ping = read_frame(&mut read, &mut total).await.unwrap();
                    assert_eq!(ping["method"], "ping");
                }
                send_frame(&mut write, json!({"jsonrpc":"2.0","id":if legacy {2} else {1},"result":{"protocolVersion":3}})).await.unwrap();
                let quota = read_frame(&mut read, &mut total).await.unwrap();
                assert_eq!(quota["method"], "account.getQuota");
                assert_eq!(quota["params"], json!({"gitHubToken":"fixture-token"}));
                // The probe must refuse arbitrary server callbacks.
                send_frame(
                    &mut write,
                    json!({"jsonrpc":"2.0","id":99,"method":"permission.request","params":{}}),
                )
                .await
                .unwrap();
                assert_eq!(
                    read_frame(&mut read, &mut total).await.unwrap()["error"]["code"],
                    -32601
                );
                // Fragment a real Content-Length reply across writes.
                let response = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":3,"result":{"quotaSnapshots":{"premium_interactions":{"remainingPercentage":25}}}})).unwrap();
                let frame = [
                    format!("Content-Length: {}\r\n\r\n", response.len()).into_bytes(),
                    response,
                ]
                .concat();
                for chunk in frame.chunks(7) {
                    write.write_all(chunk).await.unwrap();
                }
            });
            let mut input = input;
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                copilot_exchange(&mut input, output, Some("fixture-token")),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                result["quotaSnapshots"]["premium_interactions"]["remainingPercentage"],
                25
            );
            fake.await.unwrap();
        }
    }

    #[tokio::test]
    async fn copilot_frames_reject_oversized_malformed_and_unbounded_streams() {
        for bytes in [
            b"Content-Length: 128001\r\n\r\n".to_vec(),
            b"Content-Length: nope\r\n\r\n".to_vec(),
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            b"Content-Length: 2\r\n\r\nxx".to_vec(),
            vec![b'x'; 8193],
        ] {
            assert!(read_frame(&mut bytes.as_slice(), &mut 0).await.is_err());
        }
        let bytes = b"Content-Length: 2\r\n\r\n{}";
        let mut total = STREAM_LIMIT;
        assert!(read_frame(&mut bytes.as_slice(), &mut total).await.is_err());
    }

    #[test]
    fn copilot_probe_flags_do_not_expose_token_or_create_a_session() {
        let command = copilot_probe_process(Some("secret-fixture"));
        let args = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(args.contains("--headless --stdio --no-auto-update --no-auto-login"));
        assert!(args.contains("--auth-token-env COPILOT_GITHUB_TOKEN"));
        assert!(!args.contains("secret-fixture"));
        assert!(!args.contains("--prompt"));
    }
}
