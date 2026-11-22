import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickBlock, setDatasetDir, datasetSize, names } from "./snippets";
import { render } from "./templates";

// ---- selection logic, on a tiny fixture ---------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp-snip-"));
const block = (n: number, name: string) => `if (${name}) {\n${Array.from({ length: n }, (_, i) => `\trun${name}(${i});`).join("\n")}\n}`;
fs.writeFileSync(path.join(tmp, "javascript.json"), JSON.stringify({
  v: 1, lang: "javascript", repos: ["a/b (MIT)", "c/d (Apache-2.0)"],
  items: [[block(2, "alpha"), 0], [block(5, "beta"), 1], [block(5, "gamma"), 0], ["for (const x of xs) {\n\tuse(x);\n\tuse(x);\n}", 1], ["import a from \"a\";\nimport b from \"b\";\nimport c from \"c\";", 0]],
}));
setDatasetDir(tmp);
assert.equal(datasetSize("javascript"), 5);
assert.equal(datasetSize("typescriptreact"), 0, "no file for that language -> nothing");

const a = pickBlock("javascript", "i", "");
assert.ok(a && a.body.startsWith("if ("), "`i` -> a block that starts with i (and not `for`)");
assert.ok(pickBlock("javascript", "fo", "")?.body.startsWith("for ("));
assert.equal(pickBlock("javascript", "zz", ""), undefined);
assert.equal(pickBlock("javascript", "x = 1", ""), undefined, "not at a statement start");
assert.equal(pickBlock("python", "i", ""), undefined, "language without data");

// names near the cursor decide among equals
assert.match(pickBlock("javascript", "i", "const gamma = 1; gamma.go(gamma)")!.body, /gamma/);
assert.match(pickBlock("javascript", "i", "const beta = 1; beta.go(beta)")!.body, /beta/);
// snake_case / camelCase are split into words: `runGamma` in the code matches `gamma`
assert.deepEqual([...new Set(names("const userId = get_user_name(runGamma)"))].sort(),["gamma", "get", "get_user_name", "name", "rungamma", "user", "userid"].sort()); // ("run" is boilerplate, not a name)
// the last lines before the cursor weigh more than older code
const old = "const gamma = 1;\n" + "x = y;\n".repeat(20) + "const beta = 2;\n";
assert.match(pickBlock("javascript", "i", old)!.body, /beta/, "recent names win");
// without any hint the choice depends on the surrounding code, so different places can get different blocks
const picks = new Set(Array.from({ length: 40 }, (_, k) => pickBlock("javascript", "i", "\n".repeat(k + 1))!.body)); // no names above the cursor
assert.ok(picks.size >= 2, "varies with the surrounding code");
// but is stable for the same code (no flicker between keystrokes)
assert.equal(pickBlock("javascript", "i", "\n\n\n")!.body, pickBlock("javascript", "i", "\n\n\n")!.body);
// the case that matters: variables were just declared above, no block uses them -> NO instant block (the model will)
assert.equal(pickBlock("cpp", "if", "int main() {\n    int nilai;\n    string keterangan;\n    "), undefined, "declared variables above, nothing similar");
assert.equal(pickBlock("javascript", "i", "const nilai = 80;\nlet keterangan = '';\n"), undefined, "same in javascript");
assert.ok(pickBlock("javascript", "i", "// start\n"), "a comment without names above does not block it");
// a file with real code that resembles no block gets NO instant block (the model answers instead)
const unrelated = Array.from({ length: 30 }, (_, k) => `const invoice${k}Total = computeLedger${k}(account${k});`).join("\n");
assert.equal(pickBlock("javascript", "i", unrelated), undefined, "real code, nothing similar -> nothing shown");
// ... but one that does resemble a block gets it
const similar = unrelated + "\nconst rowsAlpha = runAlpha(rowsBeta);\n";
assert.ok(pickBlock("javascript", "i", similar), "real code that shares names with a block -> shown");
assert.ok(pickBlock("javascript", "i", similar)!.similarity > 0.45);
// it renders as the rest of the block, cut after what is typed, with the line's indentation
assert.equal(render(pickBlock("javascript", "fo", "")!, "    ", "  "), "r (const x of xs) {\n      use(x);\n      use(x);\n    }");

// ---- the real data built by tools/build-dataset.mjs (skipped when it has not been built) -----------------------------
setDatasetDir(path.join(__dirname, "..", "media", "dataset"));
const FIRST = ["python", "javascript", "typescript", "java", "go", "rust", "php", "ruby", "csharp", "c", "cpp", "css", "html", "shell", "lua", "kotlin", "swift"];
const present = FIRST.filter((l) => datasetSize(l) > 0);
if (present.includes("cpp")) {
  // the case from real use: inside main(), variables just declared, the user types `i` / `if`
  const inMain = "int main() {\n    int nilai;\n    string keterangan;\n    ";
  for (const typed of ["    i", "    if", "    f", "    w", "    s"]) assert.equal(pickBlock("cpp", typed, inMain), undefined, `no instant block for "${typed.trim()}" inside main with variables above`);
  // and a function `main` is never offered inside a body, even with no names above
  const b = pickBlock("cpp", "    i", "\n\n");
  assert.ok(!b || !/^int\s+main/.test(b.body), "no `int main` block inside a body");
}
if (present.length) {
  for (const l of present) {
    const idx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "media", "dataset", l + ".json"), "utf8"));
    assert.ok(idx.items.length >= 10, `${l}: at least 10 blocks (got ${idx.items.length})`);
    assert.ok(idx.repos.every((r: string) => /\((MIT|Apache-2\.0|BSD-[23]-Clause|Unlicense|ISC)\)$/.test(r)), `${l}: only permissive licenses`);
    for (const [text, r] of idx.items) {
      const n = text.split("\n").length;
      assert.ok(n >= 2 && n <= (l === "html" ? 45 : 20) && text.length <= (l === "html" ? 2600 : 1000), `${l}: block size (${n} lines)`);
      assert.ok(!/(password|secret|token|api[_-]?key|https?:\/\/|@\w+\.\w+)/i.test(text), `${l}: no secrets or urls`);
      assert.ok(idx.repos[r], `${l}: every block names its repository`);
    }
  }
  console.log(`real dataset checks passed for: ${present.join(", ")}`);
}
console.log("snippet checks passed");
