import { sum } from "./sum.js";
if (sum(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
