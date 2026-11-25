import { queryString, splitPath } from "./normalize.js";

function parseQuery(text) {
    const query = {};
    if (!text) return query;
    for (const pair of text.split("&")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        const decode = (s) => {
            try {
                return decodeURIComponent(s.replaceAll("+", " "));
            } catch {
                return s;
            }
        };
        const key = decode(eq < 0 ? pair : pair.slice(0, eq));
        const value = eq < 0 ? "" : decode(pair.slice(eq + 1));
        if (key in query) query[key] = [].concat(query[key], value);
        else query[key] = value;
    }
    return query;
}

// Returns { params, score } or null. score entries: 2 static, 1 param, 0 wildcard.
function matchSegments(pattern, segments) {
    const params = {};
    const score = [];
    for (let i = 0; i < pattern.length; i++) {
        const part = pattern[i];
        if (part === "*" && i === pattern.length - 1) {
            if (segments.length <= i) return null;
            params["*"] = segments.slice(i).join("/");
            score.push(0);
            return { params, score };
        }
        if (i >= segments.length) return null;
        if (part.startsWith(":")) {
            try {
                params[part.slice(1)] = decodeURIComponent(segments[i]);
            } catch {
                return null;
            }
            score.push(1);
        } else if (part === segments[i]) {
            score.push(2);
        } else {
            return null;
        }
    }
    return pattern.length === segments.length ? { params, score } : null;
}

const better = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? -1;
        const y = b[i] ?? -1;
        if (x !== y) return x > y;
    }
    return false;
};

export class Router {
    #routes = [];

    add(method, path, handler) {
        this.#routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
        return this;
    }

    match(method, url) {
        const segments = splitPath(url);
        const wanted = method.toUpperCase();
        let best = null;
        for (const route of this.#routes) {
            if (route.method !== wanted && route.method !== "ANY") continue;
            const found = matchSegments(route.segments, segments);
            if (!found) continue;
            const exact = route.method === wanted ? 1 : 0;
            const score = [...found.score, exact];
            if (!best || better(score, best.score)) best = { ...found, score, handler: route.handler };
        }
        if (!best) return null;
        return { handler: best.handler, params: best.params, query: parseQuery(queryString(url)) };
    }

    allowedMethods(url) {
        const segments = splitPath(url);
        const methods = new Set();
        for (const route of this.#routes) if (matchSegments(route.segments, segments)) methods.add(route.method);
        return [...methods].sort();
    }
}
