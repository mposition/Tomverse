import { route as claude } from "./claude.mjs";
import { route as codex } from "./codex.mjs";
import { route as fake } from "./fake.mjs";
import { route as noop } from "./noop.mjs";
import { route as tomverse } from "./tomverse.mjs";

const ROUTES = [fake, noop, tomverse, codex, claude];
export const ROUTE_NAMES = ROUTES.map((r) => r.name);

export const getRoute = (name) => {
    const found = ROUTES.find((r) => r.name === name);
    if (!found) throw new Error(`Unknown route "${name}". Routes: ${ROUTE_NAMES.join(", ")}.`);
    return found;
};
