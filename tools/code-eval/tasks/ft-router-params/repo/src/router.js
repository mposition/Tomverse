import { splitPath } from "./normalize.js";

export class Router {
    #routes = [];

    add(method, path, handler) {
        this.#routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
        return this;
    }

    match(method, url) {
        const segments = splitPath(url);
        const wanted = method.toUpperCase();
        for (const route of this.#routes) {
            if (route.method !== wanted) continue;
            if (route.segments.length !== segments.length) continue;
            if (route.segments.every((part, i) => part === segments[i])) return { handler: route.handler, params: {} };
        }
        return null;
    }
}
