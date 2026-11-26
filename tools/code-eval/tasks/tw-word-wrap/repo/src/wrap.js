export function wrap(text, width) {
    if (!Number.isInteger(width) || width < 1) throw new RangeError("width must be a positive integer");
    return String(text).split("\n").map((line) => wrapLine(line, width)).join("\n");
}

function wrapLine(line, width) {
    const lines = [];
    let current = "";
    for (let word of line.split(/\s+/).filter(Boolean)) {
        while (word.length > width) {
            if (current) {
                lines.push(current);
                current = "";
            }
            lines.push(word.slice(0, width));
            word = word.slice(width);
        }
        if (current === "") current = word;
        else if (current.length + 1 + word.length <= width) current += " " + word;
        else {
            lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.join("\n");
}
