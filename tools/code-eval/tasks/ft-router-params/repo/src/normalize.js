// Splits a url or path into its path segments. The query string and hash are dropped.
export function splitPath(url) {
    const path = url.split("#")[0].split("?")[0];
    return path.split("/").filter(Boolean);
}

export function queryString(url) {
    const [beforeHash] = url.split("#");
    const index = beforeHash.indexOf("?");
    return index < 0 ? "" : beforeHash.slice(index + 1);
}
