# evaluate(source)

Evaluates an arithmetic expression and returns a number.

- Numbers: decimal literals such as `42`, `3.14`, `5.` and `.5`. No exponents, no thousands separators.
- Operators: binary `+ - * / %`, unary `-` and `+`, and parentheses. Whitespace between tokens is ignored.
- Precedence, high to low: parentheses, unary `+ -`, then `* / %`, then `+ -`. Binary operators of the same level are left-associative (`10 - 3 - 2` is `5`, `100 / 10 / 5` is `2`). `%` is the JavaScript remainder.
- Division or remainder by zero throws a `RangeError` with the message `division by zero`.
- Anything that is not an expression throws a `SyntaxError`: an unknown character, a missing operand, a missing or extra parenthesis, two numbers in a row, or an empty expression.
