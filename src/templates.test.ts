import assert from "node:assert/strict";
import { triggerToken, matchUserTemplate, disabledByUser, render } from "./templates";

// what counts as "the first letters of a construct"
assert.equal(triggerToken("python", "i"), "i");
assert.equal(triggerToken("python", "    fo"), "fo");
assert.equal(triggerToken("python", "x = 1"), undefined);
assert.equal(triggerToken("python", "print("), undefined);
assert.equal(triggerToken("c", "#inc"), "#inc");
assert.equal(triggerToken("html", "<ul><d"), "<d", "html: after `<`, anywhere in the line");
assert.equal(triggerToken("html", "table"), undefined, "html needs the `<`");
assert.equal(triggerToken("css", "  displ"), "displ");
assert.equal(triggerToken("scss", "  b"), "b", "scss shares css rules");

// the user's own templates: language beats "*", "" turns a trigger off
const mine = { python: { for: "for i in range(10):\n\tprint(i)" }, "*": { todo: "todo: write this" } };
const m = matchUserTemplate("python", "fo", mine)!;
assert.equal(render(m, "", "    "), "r i in range(10):\n    print(i)");
assert.equal(render(matchUserTemplate("rust", "to", mine)!, "", "    "), "do: write this");
assert.equal(matchUserTemplate("python", "zz", mine), undefined);
assert.equal(disabledByUser("python", "if", { python: { if: "" } }), true);
assert.equal(disabledByUser("python", "for", { python: { if: "" } }), false);

// indentation follows the current line: spaces or tabs; blank lines stay blank
assert.equal(render({ typed: "i", key: "if", body: "if a:\n\tb\n\n\tc" }, "    ", "  "), "f a:\n      b\n\n      c");
assert.equal(render({ typed: "i", key: "if", body: "if a {\n\tb\n}" }, "\t", "\t"), "f a {\n\t\tb\n\t}");
assert.equal(render({ typed: "sel", key: "SELECT", body: "SELECT 1" }, "", "  "), "ECT 1", "case-insensitive cut");

console.log("template helper checks passed");
