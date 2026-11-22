import assert from "node:assert/strict";
import { relatedSnippets, trimToBlock, dropRepetition } from "./context";

// ---- related code from other files ----------------------------------------------------------------------------------
const billing = { name: "src/billing.py", text: "def compute_invoice_total(invoice, tax_rate):\n    subtotal = sum(line.price for line in invoice.lines)\n    return subtotal * (1 + tax_rate)\n\n" + "x = 1\n".repeat(40) };
const unrelated = { name: "src/colors.py", text: "RED = 1\nGREEN = 2\nBLUE = 3\n".repeat(20) };
const near = "def print_invoice(invoice, tax_rate):\n    total = ";
const r = relatedSnippets(near, [unrelated, billing]);
assert.ok(r.startsWith("// Path: src/billing.py"), "the file that shares names comes first (and is labelled with its path)");
assert.ok(r.includes("compute_invoice_total"), "the helper the user can reuse is in the snippet");
assert.ok(!r.includes("RED"), "an unrelated file adds nothing");
assert.equal(relatedSnippets("x", [billing]), "", "too little context to match anything");
assert.equal(relatedSnippets(near, [unrelated]), "", "nothing similar -> nothing sent");
assert.ok(relatedSnippets(near, [billing], { maxChars: 120 }).length < 160, "size is bounded");
assert.ok(relatedSnippets(near, [billing, { ...billing, name: "src/billing2.py" }], { maxSnippets: 1 }).split("// Path:").length === 2, "at most maxSnippets");

// ---- cutting at a block boundary -----------------------------------------------------------------------------------------
assert.equal(trimToBlock("a();\nb();", false), "a();\nb();", "not truncated: untouched");
assert.equal(trimToBlock("a();\nb();\nc(par", true), "a();\nb();", "partial last line dropped");
assert.equal(trimToBlock("if (x) {\n  a();\n  b();\n  c(", true), "if (x) {\n  a();\n  b();", "a block that is still open keeps its complete lines (nothing closed to go back to)");
assert.equal(trimToBlock("a();\nif (x) {\n  b();\n  c(", true), "a();", "go back to the last fully closed line");
assert.equal(trimToBlock("if (x) {\n  b();\n}\nfoo(1,\n  2", true), "if (x) {\n  b();\n}", "keeps whole closed blocks");
assert.equal(trimToBlock("single", true), "single", "one line is never emptied");

// ---- repetition ------------------------------------------------------------------------------------------------------------
assert.equal(dropRepetition("a = 1\nb = 2"), "a = 1\nb = 2", "normal code untouched");
assert.equal(dropRepetition("log('retrying request')\nlog('retrying request')\nlog('retrying request')\nlog('retrying request')"), "log('retrying request')\nlog('retrying request')", "the third copy and later are dropped");
assert.equal(dropRepetition("x\nfoo(1)\nbar(2)\nfoo(1)\nbar(2)\nfoo(1)\nbar(2)"), "x\nfoo(1)\nbar(2)", "a two-line pattern that loops");
assert.equal(dropRepetition("}\n}\n}\n}"), "}\n}\n}\n}", "short structural lines (closing braces) are not repetition");

console.log("context checks passed");
