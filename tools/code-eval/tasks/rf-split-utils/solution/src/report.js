import { groupBy, sortBy } from "./array.js";
import { mapValues, pick } from "./object.js";
import { capitalize, truncate } from "./string.js";

// One line per team: "Team (n): name, name"; names are shortened and sorted.
export function teamSummary(people) {
    const teams = groupBy(sortBy(people, (p) => p.name), (p) => p.team);
    const lines = Object.entries(mapValues(teams, (members) => members.map((m) => truncate(capitalize(m.name), 8)))).map(
        ([team, names]) => `${capitalize(team)} (${names.length}): ${names.join(", ")}`,
    );
    return lines.sort().join("\n");
}

export function publicProfile(person) {
    return pick(person, ["name", "team"]);
}
