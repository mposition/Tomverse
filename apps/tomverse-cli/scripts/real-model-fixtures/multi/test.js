import { add } from "./src/add.js";
import { mul } from "./src/mul.js";
const bad = [];
if (add(2, 3) !== 5) bad.push("add");
if (mul(2, 3) !== 6) bad.push("mul");
if (bad.length) { console.error("FAIL " + bad.join(",")); process.exit(1); }
console.log("PASS");
