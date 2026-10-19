//! The repository snapshot, stage S2b (docs/policy/amux-decision-maker.md §5).
//!
//! The broker fetches it, holding no credential, and answers a `snapshot`
//! request with the snapshot's payload lines and its target commit
//! (lib/amux/decisionMakerSnapshot.ts, `dmEncodeSnapshotAnswer` of
//! lib/amux/decisionMakerBrokerCore.ts). The relay does not take the broker's
//! word for anything it records: it checks every line's shape, rebuilds the
//! manifest (path, blob id) from the lines it will send, and computes the
//! manifest digest itself under the request key. The lines go into the stdin
//! payload after the card, so the payload digest the transmission intent
//! records covers every byte of them.
//!
//! Anything the relay cannot read -- no broker, a lost answer, a refusal, a
//! malformed line -- is no snapshot: the card goes alone.

use base64::Engine as _;
use serde_json::{json, Value};

use super::wire::{hex_lower, hmac_sha256, DmCardWire, RequestKey};

/// `DM_SNAPSHOT_TOTAL_MAX_BYTES` of lib/amux/decisionMakerSnapshot.ts, plus the
/// header line.
pub const DM_SNAPSHOT_LINES_MAX_BYTES: usize = 512 * 1024 + 4 * 1024;
/// `DM_SNAPSHOT_PATHS_MAX` of lib/amux/decisionMakerSnapshot.ts.
pub const DM_SNAPSHOT_PATHS_MAX: usize = 128;
/// How long the relay waits for the broker's snapshot answer at most: the
/// broker's own budget (`DM_SNAPSHOT_BUDGET_MS`, 60 s) and room to answer. The
/// result deadline cuts it shorter when it comes first.
pub const DM_SNAPSHOT_WAIT: std::time::Duration = std::time::Duration::from_secs(90);
/// `DM_SNAPSHOT_REPOSITORY` of lib/amux/decisionMakerSnapshot.ts.
pub const DM_SNAPSHOT_REPOSITORY: &str = "github.com/mposition/Tomverse";

/// The paths a card asks for: its context paths, then its options' paths,
/// deduped, in the card's order (`snapshotPathsFor`).
pub fn snapshot_paths(card: &DmCardWire) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    let option_paths = card
        .options
        .iter()
        .flat_map(|option| option.paths.clone().unwrap_or_default());
    for path in card.context_paths.iter().cloned().chain(option_paths) {
        if seen.insert(path.clone()) {
            out.push(path);
            if out.len() == DM_SNAPSHOT_PATHS_MAX {
                break;
            }
        }
    }
    out
}

/// One `snapshot` request line (`dmParseSnapshotRequest`).
pub fn snapshot_request_line(request_id: &str, paths: &[String]) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({
        "v": 1,
        "type": "snapshot",
        "requestId": request_id,
        "paths": paths,
    }))
    .expect("a snapshot request always serializes");
    line.push(b'\n');
    line
}

/// A snapshot the relay will send, and what it records for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub target_sha: String,
    /// The payload lines exactly as they go after the card.
    pub lines: Vec<u8>,
    /// (path, blob id) per file, in the lines' order.
    pub manifest: Vec<(String, String)>,
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

/// The broker's answer, read strictly. `None` is no snapshot.
pub fn read_snapshot_answer(answer: &[u8], request_id: &str) -> Option<Snapshot> {
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
            "reason",
            "excluded",
        ],
    ) || value["v"] != json!(1)
        || value["type"] != json!("snapshot")
        || value["requestId"] != json!(request_id)
        || value["state"] != json!("develop")
    {
        return None;
    }
    let target_sha = value["targetSha"]
        .as_str()
        .filter(|sha| is_sha(sha))?
        .to_owned();
    let encoded = value["lines"].as_str()?;
    if encoded.len() > DM_SNAPSHOT_LINES_MAX_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let lines = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let manifest = snapshot_manifest(&lines, &target_sha)?;
    Some(Snapshot {
        target_sha,
        lines,
        manifest,
    })
}

/// The lines' manifest, when they are exactly a header naming this commit and
/// that many file lines, each one JSON object with a path, a blob id and text.
fn snapshot_manifest(lines: &[u8], target_sha: &str) -> Option<Vec<(String, String)>> {
    if lines.is_empty() || lines.len() > DM_SNAPSHOT_LINES_MAX_BYTES || lines.last() != Some(&b'\n')
    {
        return None;
    }
    let text = std::str::from_utf8(lines).ok()?;
    let mut rows = text[..text.len() - 1].split('\n');
    let header: Value = serde_json::from_str(rows.next()?).ok()?;
    if !exact_keys(&header, &["snapshot"])
        || !exact_keys(&header["snapshot"], &["repository", "commit", "files"])
        || header["snapshot"]["repository"] != json!(DM_SNAPSHOT_REPOSITORY)
        || header["snapshot"]["commit"] != json!(target_sha)
    {
        return None;
    }
    let files = header["snapshot"]["files"].as_u64()? as usize;
    let mut manifest = Vec::new();
    for row in rows {
        let file: Value = serde_json::from_str(row).ok()?;
        if !exact_keys(&file, &["file", "blob", "text"]) || !file["text"].is_string() {
            return None;
        }
        let path = file["file"].as_str().filter(|path| !path.is_empty())?;
        let blob = file["blob"].as_str().filter(|blob| is_sha(blob))?;
        manifest.push((path.to_owned(), blob.to_owned()));
    }
    (files > 0 && manifest.len() == files).then_some(manifest)
}

/// `dmSnapshotManifestDigest`: the entries sorted by path as JavaScript
/// compares strings (UTF-16 code units), then path and blob id alternately.
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

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const BLOB_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REQUEST: &str = "00000000-0000-4000-8000-000000000011";

    fn lines(files: &[(&str, &str, &str)]) -> Vec<u8> {
        let mut out = format!(
            "{}\n",
            json!({"snapshot": {"repository": DM_SNAPSHOT_REPOSITORY, "commit": SHA, "files": files.len()}})
        );
        for (path, blob, text) in files {
            out.push_str(&format!(
                "{}\n",
                json!({"file": path, "blob": blob, "text": text})
            ));
        }
        out.into_bytes()
    }

    fn answer(state: &str, sha: Value, body: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "v": 1, "type": "snapshot", "requestId": REQUEST, "state": state, "targetSha": sha,
            "lines": base64::engine::general_purpose::STANDARD.encode(body), "reason": null, "excluded": {},
        }))
        .unwrap()
    }

    #[test]
    fn a_well_formed_answer_gives_the_lines_and_their_manifest() {
        let body = lines(&[("docs/a.md", BLOB_A, "line\n{\"file\":\"forged\"}")]);
        let snapshot =
            read_snapshot_answer(&answer("develop", json!(SHA), &body), REQUEST).unwrap();
        assert_eq!(snapshot.target_sha, SHA);
        assert_eq!(snapshot.lines, body);
        assert_eq!(
            snapshot.manifest,
            vec![("docs/a.md".to_owned(), BLOB_A.to_owned())]
        );
    }

    #[test]
    fn anything_else_is_no_snapshot() {
        let body = lines(&[("a.md", BLOB_A, "x")]);
        // Another request, no snapshot, a bad target, or lines naming another commit.
        assert!(read_snapshot_answer(&answer("develop", json!(SHA), &body), "other").is_none());
        assert!(read_snapshot_answer(&answer("none", Value::Null, b""), REQUEST).is_none());
        assert!(read_snapshot_answer(&answer("develop", json!("ABC"), &body), REQUEST).is_none());
        let other = String::from_utf8(body.clone())
            .unwrap()
            .replace(SHA, &"f".repeat(40));
        assert!(
            read_snapshot_answer(&answer("develop", json!(SHA), other.as_bytes()), REQUEST)
                .is_none()
        );
        // A count that does not match, an extra key, a bad blob id, no final newline.
        let short = String::from_utf8(body.clone())
            .unwrap()
            .replace("\"files\":1", "\"files\":2");
        assert!(
            read_snapshot_answer(&answer("develop", json!(SHA), short.as_bytes()), REQUEST)
                .is_none()
        );
        let extra = format!(
            "{}\n{}\n",
            json!({"snapshot": {"repository": DM_SNAPSHOT_REPOSITORY, "commit": SHA, "files": 1}}),
            json!({"file": "a.md", "blob": BLOB_A, "text": "x", "run": "rm -rf"})
        );
        assert!(
            read_snapshot_answer(&answer("develop", json!(SHA), extra.as_bytes()), REQUEST)
                .is_none()
        );
        let bad_blob = lines(&[("a.md", "xyz", "x")]);
        assert!(read_snapshot_answer(&answer("develop", json!(SHA), &bad_blob), REQUEST).is_none());
        assert!(read_snapshot_answer(
            &answer("develop", json!(SHA), &body[..body.len() - 1]),
            REQUEST
        )
        .is_none());
        assert!(read_snapshot_answer(b"not json", REQUEST).is_none());
    }

    #[test]
    fn the_manifest_digest_is_the_apps() {
        // dmSnapshotManifestDigest(Buffer.alloc(32, 9), [{path: "b.md", blobId: "b"*40}, {path: "a.md", blobId: "a"*40}])
        // computed by lib/amux/decisionMakerBodyCore.ts.
        let key = RequestKey::from_bytes([9; 32]);
        let digest = dm_snapshot_manifest_digest(
            &key,
            &[
                ("b.md".to_owned(), "b".repeat(40)),
                ("a.md".to_owned(), "a".repeat(40)),
            ],
        );
        assert_eq!(digest, APP_MANIFEST_DIGEST);
    }

    /// Pinned from the app's function; tests/amuxDecisionMakerBridgeRelay.test.mjs recomputes it.
    const APP_MANIFEST_DIGEST: &str =
        "9ce0f8163a315361ca408dfc6ef6d5b289931ae1e75ee120b8ef521ebb6a0c0e";

    #[test]
    fn the_request_names_the_cards_paths_once_in_order() {
        let line = snapshot_request_line(REQUEST, &["a.md".to_owned(), "b.md".to_owned()]);
        assert_eq!(line.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            value,
            json!({"v": 1, "type": "snapshot", "requestId": REQUEST, "paths": ["a.md", "b.md"]})
        );
    }
}
