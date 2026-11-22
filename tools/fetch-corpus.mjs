// Shallow-clones a fixed list of permissively licensed open-source repositories into a scratch folder.
// The clones are only read by build-dataset.mjs and deleted afterwards; only extracted code blocks are kept.
//   node tools/fetch-corpus.mjs <target-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.argv[2] ?? "corpus");
// [github repo, SPDX license as reported by GitHub / LICENSE file]
export const REPOS = [
  ["psf/requests", "Apache-2.0"], ["pallets/flask", "BSD-3-Clause"], ["tiangolo/fastapi", "MIT"],
  ["expressjs/express", "MIT"], ["axios/axios", "MIT"],
  ["typeorm/typeorm", "MIT"], ["colinhacks/zod", "MIT"],
  ["apache/commons-lang", "Apache-2.0"], ["square/okhttp", "Apache-2.0"], ["JamesNK/Newtonsoft.Json", "MIT"],
  ["libuv/libuv", "MIT"], ["fmtlib/fmt", "MIT"],
  ["spf13/cobra", "Apache-2.0"], ["gin-gonic/gin", "MIT"], ["gorilla/mux", "BSD-3-Clause"],
  ["BurntSushi/ripgrep", "Unlicense"], ["tokio-rs/axum", "MIT"],
  ["slimphp/Slim", "MIT"], ["sinatra/sinatra", "MIT"], ["jekyll/jekyll", "MIT"],
  ["lunarmodules/busted", "MIT"], ["nvm-sh/nvm", "MIT"], ["Alamofire/Alamofire", "MIT"],
  ["necolas/normalize.css", "MIT"], ["picocss/pico", "MIT"],
  ["StartBootstrap/startbootstrap-sb-admin-2", "MIT"], ["StartBootstrap/startbootstrap-sb-admin", "MIT"], ["ColorlibHQ/AdminLTE", "MIT"], ["h5bp/html5-boilerplate", "MIT"],
];

fs.mkdirSync(DIR, { recursive: true });
const manifest = [];
for (const [repo, license] of REPOS) {
  const dest = path.join(DIR, repo.replace("/", "__"));
  try {
    if (!fs.existsSync(dest)) execFileSync("git", ["clone", "--depth", "1", "--single-branch", "--no-tags", "-q", `https://github.com/${repo}.git`, dest], { stdio: "pipe", timeout: 300_000 });
    manifest.push({ repo, license, dir: dest });
    console.log("ok   ", repo);
  } catch (e) { console.log("FAIL ", repo, String(e.message).split("\n")[0]); }
}
fs.writeFileSync(path.join(DIR, "corpus.json"), JSON.stringify(manifest, null, 1));
console.log(`done: ${manifest.length}/${REPOS.length} repositories`);
