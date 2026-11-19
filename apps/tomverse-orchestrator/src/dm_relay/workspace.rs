//! The Decision Maker's workspace (owner decision 2026-11-15; it replaced
//! stage S2b's snapshot, docs/policy/amux-decision-maker.md §5, §10).
//!
//! Before the transmission intent the relay asks the app what the request's
//! workspace holds -- the commit and the card's whole evidence files
//! (`/api/internal/amux/decision-maker/workspace`) -- and hands that to the
//! broker in a `workspace` request (lib/amux/decisionMakerWorkspaceCore.ts).
//! The broker checks the files again, confirms the commit on GitHub's public
//! API and answers the workspace's payload lines: a header naming the commit
//! and one line per accepted file with its git blob id. The relay does not take
//! the broker's word for anything it records: it checks every line's shape,
//! rebuilds the manifest from the lines it will send, and computes the
//! manifest digest itself under the request key. The lines go into the stdin
//! payload after the card, so the payload digest the transmission intent
//! records binds every evidence byte; the launch line then carries the
//! accepted files, and the broker builds the workspace only when its own lines
//! are exactly the payload's end.
//!
//! Anything the relay cannot read -- no app answer, no broker, a malformed
//! line -- is no workspace: the card goes alone.

use base64::Engine as _;
use serde_json::{json, Value};

use super::wire::{hex_lower, hmac_sha256, RequestKey};

/// `dmSnapshotManifestDigest` of lib/amux/decisionMakerBodyCore.ts: the
/// entries sorted by path as JavaScript compares strings (UTF-16 code units),
/// then path and blob id alternately.
pub fn dm_snapshot_manifest_digest(key: &RequestKey, manifest: &[(String, String)]) -> String {
    let mut entries: Vec<&(String, String)> = manifest.iter().collect();
    entries.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    let mut parts: Vec<&[u8]> = vec![b"amux-dm-manifest-v1"];
    for (path, blob) in &entries {
        parts.push(path.as_bytes());
        parts.push(blob.as_bytes());
    }
    hex_lower(&hmac_sha256(key.bytes(), &parts))
}

/// `DM_WORKSPACE_REPOSITORY_NAME` of lib/amux/decisionMakerWorkspaceCore.ts.
pub const DM_WORKSPACE_REPOSITORY: &str = "github.com/mposition/Tomverse";
/// `DM_WORKSPACE_EVIDENCE_NAMES`.
pub const DM_WORKSPACE_EVIDENCE_NAMES: [&str; 4] = ["PATCH.diff", "FINDINGS.md", "CRITERIA.md", "CONTEXT.md"];
/// `DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES`: what the app's older `workspace` route holds in all
/// (evidence inline in one answer). The parts protocol below has no such bound.
pub const DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// The older route's answer: the evidence as base64 and a few hundred bytes more.
pub const DM_WORKSPACE_ANSWER_MAX_BYTES: usize =
    DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES.div_ceil(3) * 4 + 64 * 1024;
/// The parts route's answer: at most four short descriptions.
pub const DM_WORKSPACE_PARTS_ANSWER_MAX_BYTES: usize = 64 * 1024;
/// The chunk route's answer: one chunk as base64 and its envelope.
pub const DM_WORKSPACE_CHUNK_ANSWER_MAX_BYTES: usize =
    crate::tomverse_api::V22_TRANSFER_CHUNK_BYTES.div_ceil(3) * 4 + 64 * 1024;
/// The broker's lines: a header and one short line per evidence file.
const DM_WORKSPACE_LINES_MAX_BYTES: usize = 16 * 1024;
/// How long the relay waits for the broker's workspace answer at most: the
/// workspace's one time limit (`DM_WORKSPACE_TIME_LIMIT_MS` of
/// lib/amux/decisionMakerWorkspaceCore.ts, an hour). The result deadline cuts
/// it shorter when it comes first.
pub const DM_WORKSPACE_WAIT: std::time::Duration = std::time::Duration::from_millis(60 * 60 * 1000);

/// The evidence the app answered, base64 as it came: `{ name, content }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEvidence {
    pub target_sha: Option<String>,
    pub files: Vec<Value>,
    /// The app left nothing out (`excluded` is empty): what it sent is the
    /// card's whole evidence.
    pub complete: bool,
}

/// One evidence file as the app describes it in the parts protocol
/// (`workspace/parts`): the bytes come later, chunk by chunk, with the launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePart {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    /// The git blob id of the whole file, which the payload names.
    pub blob: String,
}

/// The evidence the app described.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceParts {
    pub target_sha: Option<String>,
    pub parts: Vec<WorkspacePart>,
    /// The app left nothing out (`excluded` is empty).
    pub complete: bool,
}

/// What the app says a request's workspace holds, in the protocol it was asked in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvidence {
    Inline(WorkspaceEvidence),
    Parts(WorkspaceParts),
}

impl AppEvidence {
    pub fn file_count(&self) -> usize {
        match self {
            AppEvidence::Inline(evidence) => evidence.files.len(),
            AppEvidence::Parts(parts) => parts.parts.len(),
        }
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

/// The app's answer (`found: true`): `None` for `workspace: null` (the card
/// alone) or for anything that is not the shape the app writes.
pub fn read_app_workspace(value: &Value) -> Option<WorkspaceEvidence> {
    let workspace = value.get("workspace")?;
    if !exact_keys(workspace, &["target_sha", "files", "excluded"]) {
        return None;
    }
    let target_sha = match &workspace["target_sha"] {
        Value::Null => None,
        Value::String(sha) if is_sha(sha) => Some(sha.clone()),
        _ => return None,
    };
    let files = workspace["files"].as_array()?;
    let mut seen = std::collections::BTreeSet::new();
    for file in files {
        let name = file.get("name")?.as_str()?;
        if !exact_keys(file, &["name", "content"])
            || !DM_WORKSPACE_EVIDENCE_NAMES.contains(&name)
            || !seen.insert(name.to_owned())
            || !file["content"].is_string()
        {
            return None;
        }
    }
    Some(WorkspaceEvidence {
        target_sha,
        files: files.clone(),
        complete: workspace["excluded"].as_object()?.is_empty(),
    })
}

/// The parts route's answer (`found: true`): `None` for `workspace: null` (the card
/// alone) or for anything that is not the shape the app writes.
pub fn read_app_parts(value: &Value) -> Option<WorkspaceParts> {
    let workspace = value.get("workspace")?;
    if !exact_keys(workspace, &["target_sha", "parts", "excluded"]) {
        return None;
    }
    let target_sha = match &workspace["target_sha"] {
        Value::Null => None,
        Value::String(sha) if is_sha(sha) => Some(sha.clone()),
        _ => return None,
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut parts = Vec::new();
    for part in workspace["parts"].as_array()? {
        let name = part.get("name")?.as_str()?;
        let bytes = part.get("bytes")?.as_u64()?;
        let sha256 = part.get("sha256")?.as_str()?;
        let blob = part.get("blob")?.as_str()?;
        if !exact_keys(part, &["name", "bytes", "sha256", "blob"])
            || !DM_WORKSPACE_EVIDENCE_NAMES.contains(&name)
            || !seen.insert(name.to_owned())
            || bytes == 0
            || !is_sha256(sha256)
            || !is_sha(blob)
        {
            return None;
        }
        parts.push(WorkspacePart {
            name: name.to_owned(),
            bytes,
            sha256: sha256.to_owned(),
            blob: blob.to_owned(),
        });
    }
    Some(WorkspaceParts {
        target_sha,
        parts,
        complete: workspace["excluded"].as_object()?.is_empty(),
    })
}

/// One `workspace` request line in the parts protocol (`dmParseWorkspaceRequest`):
/// descriptions, not bytes.
pub fn workspace_parts_request_line(request_id: &str, evidence: &WorkspaceParts) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({
        "v": 1,
        "type": "workspace",
        "requestId": request_id,
        "targetSha": evidence.target_sha,
        "parts": evidence.parts.iter().map(|part| json!({
            "name": part.name, "bytes": part.bytes, "sha256": part.sha256, "blob": part.blob,
        })).collect::<Vec<_>>(),
    }))
    .expect("a workspace request always serializes");
    line.push(b'\n');
    line
}

/// One `workspace` request line (`dmParseWorkspaceRequest`).
pub fn workspace_request_line(request_id: &str, evidence: &WorkspaceEvidence) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({
        "v": 1,
        "type": "workspace",
        "requestId": request_id,
        "targetSha": evidence.target_sha,
        "files": evidence.files,
    }))
    .expect("a workspace request always serializes");
    line.push(b'\n');
    line
}

/// A workspace the relay will send, and what it records for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// `develop`, `worker_head` or `none` (evidence only, no checkout).
    pub state: String,
    pub target_sha: Option<String>,
    /// The payload lines exactly as they go after the card.
    pub lines: Vec<u8>,
    /// (path, blob id) per manifest entry: `repo` and its commit, then each file.
    pub manifest: Vec<(String, String)>,
    /// The launch line's `workspace`: the state, the commit and the accepted files
    /// (or, in the parts protocol, their descriptions).
    pub launch: Value,
    /// The accepted files the broker will ask the bytes of, in its order; empty for an
    /// inline workspace, whose bytes `launch` carries.
    pub parts: Vec<WorkspacePart>,
}

/// What the broker's answer says, once read strictly: the state, the commit, the
/// payload lines, the manifest and the accepted files' names in its order.
struct ReadAnswer {
    state: String,
    target_sha: Option<String>,
    lines: Vec<u8>,
    manifest: Vec<(String, String)>,
    names: Vec<String>,
}

fn read_answer(answer: &[u8], request_id: &str) -> Option<ReadAnswer> {
    let value: Value = serde_json::from_slice(answer).ok()?;
    if !exact_keys(
        &value,
        &[
            "v",
            "type",
            "requestId",
            "state",
            "targetSha",
            "lines",
            "files",
            "reason",
            "excluded",
        ],
    ) || value["v"] != json!(1)
        || value["type"] != json!("workspace")
        || value["requestId"] != json!(request_id)
    {
        return None;
    }
    let state = value["state"].as_str()?.to_owned();
    let target_sha = match (&value["targetSha"], state.as_str()) {
        (Value::Null, "none") => None,
        (Value::String(sha), "develop" | "worker_head") if is_sha(sha) => Some(sha.clone()),
        _ => return None,
    };
    let encoded = value["lines"].as_str()?;
    if encoded.len() > DM_WORKSPACE_LINES_MAX_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let lines = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let names: Vec<String> = value["files"]
        .as_array()?
        .iter()
        .map(|name| name.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    let manifest = workspace_manifest(&lines, &state, target_sha.as_deref(), &names)?;
    Some(ReadAnswer {
        state,
        target_sha,
        lines,
        manifest,
        names,
    })
}

/// The broker's answer to an inline `workspace` request, read strictly, with the
/// evidence the relay sent it. `None` is no workspace.
pub fn read_workspace_answer(
    answer: &[u8],
    request_id: &str,
    evidence: &WorkspaceEvidence,
) -> Option<Workspace> {
    let read = read_answer(answer, request_id)?;
    // The accepted files, from what the relay itself sent, in the broker's order.
    let files = read
        .names
        .iter()
        .map(|name| {
            evidence
                .files
                .iter()
                .find(|file| file["name"].as_str() == Some(name.as_str()))
                .cloned()
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Workspace {
        launch: json!({"state": read.state, "targetSha": read.target_sha, "files": files}),
        state: read.state,
        target_sha: read.target_sha,
        lines: read.lines,
        manifest: read.manifest,
        parts: Vec::new(),
    })
}

/// The broker's answer to a `workspace` request in the parts protocol. The files it
/// accepted must be files the relay described, and each one's blob id in the lines
/// must be the one the app gave: the relay never sends a payload that names bytes
/// other than the ones it will deliver.
pub fn read_workspace_parts_answer(
    answer: &[u8],
    request_id: &str,
    evidence: &WorkspaceParts,
) -> Option<Workspace> {
    let read = read_answer(answer, request_id)?;
    let parts = read
        .names
        .iter()
        .map(|name| {
            evidence
                .parts
                .iter()
                .find(|part| part.name == *name)
                .cloned()
        })
        .collect::<Option<Vec<_>>>()?;
    let named_blobs: Vec<&str> = read
        .manifest
        .iter()
        .filter(|(path, _)| path.starts_with("evidence/"))
        .map(|(_, blob)| blob.as_str())
        .collect();
    if named_blobs.len() != parts.len()
        || named_blobs
            .iter()
            .zip(parts.iter())
            .any(|(blob, part)| *blob != part.blob)
    {
        return None;
    }
    Some(Workspace {
        launch: json!({
            "state": read.state,
            "targetSha": read.target_sha,
            "parts": parts.iter().map(|part| json!({
                "name": part.name, "bytes": part.bytes, "sha256": part.sha256,
            })).collect::<Vec<_>>(),
        }),
        state: read.state,
        target_sha: read.target_sha,
        lines: read.lines,
        manifest: read.manifest,
        parts,
    })
}

/// The lines' manifest, when they are exactly a header naming this commit and
/// these files, then one line per file with its workspace path, a blob id and
/// a size.
fn workspace_manifest(
    lines: &[u8],
    state: &str,
    target_sha: Option<&str>,
    names: &[String],
) -> Option<Vec<(String, String)>> {
    if lines.is_empty() || lines.len() > DM_WORKSPACE_LINES_MAX_BYTES || lines.last() != Some(&b'\n') {
        return None;
    }
    let text = std::str::from_utf8(lines).ok()?;
    let mut rows = text[..text.len() - 1].split('\n');
    let header: Value = serde_json::from_str(rows.next()?).ok()?;
    let head = &header["workspace"];
    if !exact_keys(&header, &["workspace"])
        || !exact_keys(head, &["repository", "commit", "state", "patch", "files"])
        || head["repository"] != json!(DM_WORKSPACE_REPOSITORY)
        || head["commit"] != json!(target_sha)
        || head["state"] != json!(state)
        || head["patch"] != json!(names.iter().any(|name| name == "PATCH.diff"))
        || head["files"] != json!(names.len())
    {
        return None;
    }
    let mut manifest: Vec<(String, String)> = target_sha
        .map(|sha| vec![("repo".to_owned(), sha.to_owned())])
        .unwrap_or_default();
    let mut count = 0;
    for (row, name) in rows.zip(names.iter()) {
        let file: Value = serde_json::from_str(row).ok()?;
        if !exact_keys(&file, &["file", "blob", "bytes"]) || !file["bytes"].is_u64() {
            return None;
        }
        let path = file["file"].as_str()?;
        if path != format!("evidence/{name}") || !DM_WORKSPACE_EVIDENCE_NAMES.contains(&name.as_str()) {
            return None;
        }
        let blob = file["blob"].as_str().filter(|blob| is_sha(blob))?;
        manifest.push((path.to_owned(), blob.to_owned()));
        count += 1;
    }
    (count == names.len() && text[..text.len() - 1].split('\n').count() == names.len() + 1)
        .then_some(manifest)
}

/// §10's manifest digest of a workspace (`dmWorkspaceManifestDigest`): the
/// snapshot's keyed function over `repo` and each evidence file.
pub fn dm_workspace_manifest_digest(key: &RequestKey, workspace: &Workspace) -> String {
    dm_snapshot_manifest_digest(key, &workspace.manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const BLOB: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REQUEST: &str = "00000000-0000-4000-8000-000000000011";

    fn evidence() -> WorkspaceEvidence {
        WorkspaceEvidence {
            target_sha: None,
            files: vec![json!({"name": "PATCH.diff", "content": "ZGlmZg=="})],
            complete: true,
        }
    }

    fn lines(state: &str, commit: Option<&str>, files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = format!(
            "{}\n",
            json!({"workspace": {"repository": DM_WORKSPACE_REPOSITORY, "commit": commit, "state": state,
                "patch": files.iter().any(|(name, _)| *name == "PATCH.diff"), "files": files.len()}})
        );
        for (name, blob) in files {
            out.push_str(&format!("{}\n", json!({"file": format!("evidence/{name}"), "blob": blob, "bytes": 4})));
        }
        out.into_bytes()
    }

    fn answer(state: &str, sha: Value, body: &[u8], files: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "v": 1, "type": "workspace", "requestId": REQUEST, "state": state, "targetSha": sha,
            "lines": base64::engine::general_purpose::STANDARD.encode(body), "files": files,
            "reason": null, "excluded": {},
        }))
        .unwrap()
    }

    #[test]
    fn a_well_formed_answer_gives_the_lines_the_manifest_and_the_launch_files() {
        let body = lines("develop", Some(SHA), &[("PATCH.diff", BLOB)]);
        let workspace = read_workspace_answer(
            &answer("develop", json!(SHA), &body, json!(["PATCH.diff"])),
            REQUEST,
            &evidence(),
        )
        .unwrap();
        assert_eq!(workspace.lines, body);
        assert_eq!(
            workspace.manifest,
            vec![("repo".to_owned(), SHA.to_owned()), ("evidence/PATCH.diff".to_owned(), BLOB.to_owned())]
        );
        assert_eq!(
            workspace.launch,
            json!({"state": "develop", "targetSha": SHA, "files": [{"name": "PATCH.diff", "content": "ZGlmZg=="}]})
        );
    }

    #[test]
    fn evidence_without_a_commit_is_still_a_workspace() {
        let body = lines("none", None, &[("PATCH.diff", BLOB)]);
        let workspace =
            read_workspace_answer(&answer("none", Value::Null, &body, json!(["PATCH.diff"])), REQUEST, &evidence())
                .unwrap();
        assert_eq!(workspace.manifest, vec![("evidence/PATCH.diff".to_owned(), BLOB.to_owned())]);
    }

    #[test]
    fn anything_else_is_no_workspace() {
        let body = lines("develop", Some(SHA), &[("PATCH.diff", BLOB)]);
        let files = json!(["PATCH.diff"]);
        // Another request; a state that does not fit the commit; lines naming another commit.
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &body, files.clone()), "other", &evidence()).is_none());
        assert!(read_workspace_answer(&answer("none", json!(SHA), &body, files.clone()), REQUEST, &evidence()).is_none());
        let other = lines("develop", Some(&"f".repeat(40)), &[("PATCH.diff", BLOB)]);
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &other, files.clone()), REQUEST, &evidence()).is_none());
        // A file the relay did not send; a name off the list; an extra key; a bad blob id; no final newline.
        let unsent = lines("develop", Some(SHA), &[("FINDINGS.md", BLOB)]);
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &unsent, json!(["FINDINGS.md"])), REQUEST, &evidence())
            .is_none());
        let off_list = lines("develop", Some(SHA), &[("../x", BLOB)]);
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &off_list, json!(["../x"])), REQUEST, &evidence())
            .is_none());
        let bad_blob = lines("develop", Some(SHA), &[("PATCH.diff", "xyz")]);
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &bad_blob, files.clone()), REQUEST, &evidence())
            .is_none());
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &body[..body.len() - 1], files), REQUEST, &evidence())
            .is_none());
        assert!(read_workspace_answer(b"not json", REQUEST, &evidence()).is_none());
    }

    #[test]
    fn the_app_answer_is_read_strictly() {
        let good = json!({"found": true, "workspace": {"target_sha": SHA, "files": [{"name": "PATCH.diff", "content": "eA=="}], "excluded": {}}});
        assert_eq!(read_app_workspace(&good).unwrap().target_sha.as_deref(), Some(SHA));
        assert!(read_app_workspace(&json!({"found": true, "workspace": null})).is_none());
        let bad_name = json!({"found": true, "workspace": {"target_sha": null, "files": [{"name": "x.sh", "content": "eA=="}], "excluded": {}}});
        assert!(read_app_workspace(&bad_name).is_none());
        let twice = json!({"found": true, "workspace": {"target_sha": null, "files": [
            {"name": "PATCH.diff", "content": "eA=="}, {"name": "PATCH.diff", "content": "eA=="}], "excluded": {}}});
        assert!(read_app_workspace(&twice).is_none());
    }

    #[test]
    fn the_manifest_digest_is_the_apps() {
        // dmSnapshotManifestDigest(Buffer.alloc(32, 9), [{path: "b.md", blobId: "b"*40}, {path: "a.md", blobId: "a"*40}])
        // computed by lib/amux/decisionMakerBodyCore.ts.
        let key = RequestKey::from_bytes([9; 32]);
        let digest = dm_snapshot_manifest_digest(
            &key,
            &[("b.md".to_owned(), "b".repeat(40)), ("a.md".to_owned(), "a".repeat(40))],
        );
        assert_eq!(digest, APP_MANIFEST_DIGEST);
    }

    /// Pinned from the app's function; tests/amuxDecisionMakerBridgeRelay.test.mjs recomputes it.
    const APP_MANIFEST_DIGEST: &str = "9ce0f8163a315361ca408dfc6ef6d5b289931ae1e75ee120b8ef521ebb6a0c0e";

    const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn parts_evidence() -> WorkspaceParts {
        WorkspaceParts {
            target_sha: None,
            parts: vec![WorkspacePart {
                name: "PATCH.diff".to_owned(),
                bytes: 9_000_000_000,
                sha256: SHA256.to_owned(),
                blob: BLOB.to_owned(),
            }],
            complete: true,
        }
    }

    #[test]
    fn the_apps_parts_answer_is_read_strictly_and_a_file_has_no_size_bound() {
        let good = json!({"found": true, "workspace": {"target_sha": SHA, "parts": [
            {"name": "PATCH.diff", "bytes": 9_000_000_000_u64, "sha256": SHA256, "blob": BLOB}], "excluded": {}}});
        let read = read_app_parts(&good).unwrap();
        assert_eq!(read.target_sha.as_deref(), Some(SHA));
        assert_eq!(read.parts[0].bytes, 9_000_000_000, "far past the 64 MiB the older route holds");
        assert!(read.complete);
        let left_out = json!({"found": true, "workspace": {"target_sha": null, "parts": [], "excluded": {"secret_content": 1}}});
        assert!(!read_app_parts(&left_out).unwrap().complete);
        assert!(read_app_parts(&json!({"found": true, "workspace": null})).is_none());
        let part = |edit: fn(&mut Value)| {
            let mut value = good.clone();
            edit(&mut value["workspace"]["parts"][0]);
            value
        };
        for bad in [
            part(|p| p["name"] = json!("x.sh")),
            part(|p| p["bytes"] = json!(0)),
            part(|p| p["bytes"] = json!(-1)),
            part(|p| p["sha256"] = json!("abc")),
            part(|p| p["blob"] = json!("A".repeat(40))),
            part(|p| p["extra"] = json!(1)),
            part(|p| {
                p.as_object_mut().unwrap().remove("blob");
            }),
        ] {
            assert!(read_app_parts(&bad).is_none(), "{bad}");
        }
        let twice = json!({"found": true, "workspace": {"target_sha": null, "excluded": {}, "parts": [
            {"name": "PATCH.diff", "bytes": 1, "sha256": SHA256, "blob": BLOB},
            {"name": "PATCH.diff", "bytes": 1, "sha256": SHA256, "blob": BLOB}]}});
        assert!(read_app_parts(&twice).is_none());
    }

    #[test]
    fn the_parts_request_carries_descriptions_and_never_a_byte() {
        let line = workspace_parts_request_line(REQUEST, &parts_evidence());
        assert_eq!(line.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            value,
            json!({"v": 1, "type": "workspace", "requestId": REQUEST, "targetSha": null,
                "parts": [{"name": "PATCH.diff", "bytes": 9_000_000_000_u64, "sha256": SHA256, "blob": BLOB}]})
        );
    }

    #[test]
    fn a_parts_answer_gives_the_lines_and_a_launch_that_names_the_files_by_description() {
        let body = lines("develop", Some(SHA), &[("PATCH.diff", BLOB)]);
        let workspace = read_workspace_parts_answer(
            &answer("develop", json!(SHA), &body, json!(["PATCH.diff"])),
            REQUEST,
            &parts_evidence(),
        )
        .unwrap();
        assert_eq!(workspace.lines, body);
        assert_eq!(
            workspace.manifest,
            vec![("repo".to_owned(), SHA.to_owned()), ("evidence/PATCH.diff".to_owned(), BLOB.to_owned())]
        );
        // The launch holds the description the broker checks the bytes against, not the blob id.
        assert_eq!(
            workspace.launch,
            json!({"state": "develop", "targetSha": SHA,
                "parts": [{"name": "PATCH.diff", "bytes": 9_000_000_000_u64, "sha256": SHA256}]})
        );
        assert_eq!(workspace.parts, parts_evidence().parts);
    }

    #[test]
    fn a_parts_answer_that_names_other_bytes_than_the_app_described_is_no_workspace() {
        let files = json!(["PATCH.diff"]);
        // Another blob id than the app's: the payload would name bytes the relay will not deliver.
        let b = "b".repeat(40);
        let other_blob = lines("develop", Some(SHA), &[("PATCH.diff", b.as_str())]);
        assert!(read_workspace_parts_answer(&answer("develop", json!(SHA), &other_blob, files.clone()), REQUEST, &parts_evidence()).is_none());
        // A file the app did not describe.
        let unsent = lines("develop", Some(SHA), &[("FINDINGS.md", BLOB)]);
        assert!(read_workspace_parts_answer(&answer("develop", json!(SHA), &unsent, json!(["FINDINGS.md"])), REQUEST, &parts_evidence()).is_none());
        // Another request, the shared strictness of the lines.
        let body = lines("develop", Some(SHA), &[("PATCH.diff", BLOB)]);
        assert!(read_workspace_parts_answer(&answer("develop", json!(SHA), &body, files.clone()), "other", &parts_evidence()).is_none());
        assert!(read_workspace_parts_answer(&answer("develop", json!(SHA), &body[..body.len() - 1], files), REQUEST, &parts_evidence()).is_none());
        // The inline reader still takes the inline evidence only.
        assert!(read_workspace_answer(&answer("develop", json!(SHA), &body, json!(["PATCH.diff"])), REQUEST, &evidence()).is_some());
    }

    #[test]
    fn the_older_routes_bound_is_the_apps() {
        // lib/amux/decisionMakerWorkspaceCore.ts DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES.
        assert_eq!(DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES, 64 * 1024 * 1024);
        assert_eq!(DM_WORKSPACE_CHUNK_ANSWER_MAX_BYTES, 5_592_408 + 64 * 1024);
    }

    #[test]
    fn the_request_carries_the_apps_evidence_as_it_came() {
        let line = workspace_request_line(REQUEST, &evidence());
        assert_eq!(line.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            value,
            json!({"v": 1, "type": "workspace", "requestId": REQUEST, "targetSha": null,
                "files": [{"name": "PATCH.diff", "content": "ZGlmZg=="}]})
        );
    }
}
