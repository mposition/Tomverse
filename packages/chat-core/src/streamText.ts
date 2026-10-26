/** Display projection shared by the web client and the locally bundled app. */
export function chatStreamDisplayText(raw: string): string {
  const nul = String.fromCharCode(0);
  let text = "";
  let offset = 0;
  for (;;) {
    const start = raw.indexOf(nul, offset);
    if (start < 0) return text + raw.slice(offset);
    text += raw.slice(offset, start);
    const rest = raw.slice(start + 1);
    if (rest.startsWith("TOMVERSE_SEARCH_METADATA")) return text;
    const marker = ["TOMVERSE_ROUTING_RETRY", "TOMVERSE_STREAM_KEEPALIVE", "TOMVERSE_ARTIFACT_PROGRESS", "TOMVERSE_MCP_PROGRESS"]
      .find((name) => rest.startsWith(name));
    // Hold incomplete and unknown controls back, including their partial names.
    if (!marker) return text;
    const jsonStart = start + 1 + marker.length;
    if (raw[jsonStart] !== "{") return text;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = jsonStart; i < raw.length; i++) {
      const char = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return text;
    offset = end;
  }
}
