const TOKEN = /\s*(?:(\d+\.?\d*|\.\d+)|([-+*/%()]))/y;

// Splits source text into numbers and operator characters.
export function tokenize(source) {
    const tokens = [];
    const text = String(source);
    let end = 0;
    while (end < text.length) {
        TOKEN.lastIndex = end;
        const match = TOKEN.exec(text);
        if (!match) {
            if (text.slice(end).trim() === "") break;
            throw new SyntaxError(`unexpected character ${JSON.stringify(text.slice(end).trim()[0])}`);
        }
        tokens.push(match[1] !== undefined ? Number(match[1]) : match[2]);
        end = TOKEN.lastIndex;
    }
    return tokens;
}
