// Launches a REAL VS Code (isolated profile, other extensions disabled) with WhoisPilot loaded and runs ./suite inside it.
//   npm run e2e            (set VSCODE_EXE to use another VS Code build)
import { runTests } from "@vscode/test-electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function main() {
  const root = path.resolve(__dirname, "../..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whoispilot-e2e-"));
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, ".env"), "API_SECRET=1\n"); // must never be sent anywhere
  const out = path.join(tmp, "results.txt");
  const exe = process.env.VSCODE_EXE ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
  let failed = false;
  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite"),
      extensionTestsEnv: { WHOISPILOT_E2E_OUT: out },
      launchArgs: [ws, "--user-data-dir", path.join(tmp, "ud"), "--extensions-dir", path.join(tmp, "ext"), "--disable-extensions", "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome"],
    });
  } catch (e) {
    failed = true;
    console.error("E2E run failed:", (e as Error).message);
  }
  if (fs.existsSync(out)) console.log("\n" + fs.readFileSync(out, "utf8"));
  else console.log("(no results file: VS Code did not reach the test suite)");
  process.exit(failed ? 1 : 0);
}

main();
