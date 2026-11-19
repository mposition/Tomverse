import * as calc from "./calc.js";
if (calc.sum(2, 3) !== 5) process.exit(1);
if (typeof calc.sub === "function" && calc.sub(5, 3) !== 2) process.exit(2);
console.log("PASS");
