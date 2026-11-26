import { tokenize } from "./tokenize.js";

export function evaluate(source) {
    const tokens = tokenize(source);
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];

    function expression() {
        let value = term();
        while (peek() === "+" || peek() === "-") {
            const op = take();
            const right = term();
            value = op === "+" ? value + right : right - value;
        }
        return value;
    }

    function term() {
        let value = unary();
        while (peek() === "*" || peek() === "/" || peek() === "%") {
            const op = take();
            const right = unary();
            if ((op === "/" || op === "%") && right === 0) throw new RangeError("division by zero");
            value = op === "*" ? value * right : op === "/" ? value / right : value % right;
        }
        return value;
    }

    function unary() {
        if (peek() === "-") { take(); return -unary(); }
        if (peek() === "+") { take(); return unary(); }
        return primary();
    }

    function primary() {
        const token = take();
        if (typeof token === "number") return token;
        if (token === "(") {
            const value = expression();
            if (take() !== ")") throw new SyntaxError("expected )");
            return value;
        }
        throw new SyntaxError(`unexpected ${token === undefined ? "end of input" : token}`);
    }

    const result = expression();
    if (pos < tokens.length) throw new SyntaxError(`unexpected ${tokens[pos]}`);
    return result;
}
