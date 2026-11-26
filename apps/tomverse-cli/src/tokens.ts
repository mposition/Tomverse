/** What one image counts as in an estimate of a conversation's size. */
const IMAGE_TOKENS = 1600;

/** A rough, script-aware size: ASCII ~3.5 chars a token, other scripts ~1.3 tokens a char. */
export const estimateTokens = (value: unknown) => {
    // An image is counted at a flat size, not by its base64 text, which would be a hundred times too large.
    let images = 0;
    const text = typeof value === "string" ? value : JSON.stringify(value, (key, part) => {
        if (key === "image" && typeof part === "string" && part.length > 256) {
            images += 1;
            return "[image]";
        }
        return part;
    });
    let ascii = 0;
    let other = 0;
    for (const ch of text) {
        if (ch.charCodeAt(0) < 128) ascii += 1;
        else other += 1;
    }
    return Math.ceil(ascii / 3.5 + other * 1.3) + images * IMAGE_TOKENS;
};
