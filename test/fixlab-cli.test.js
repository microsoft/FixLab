import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseKeepAwakeMinutes,
  startKeepAwake,
  stopKeepAwake
} from "../bin/keep-awake.js";

const cli = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));

function run(args, cwd, environment = {}, input = undefined, timeout = undefined) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    input,
    timeout
  });
}

function createPackageManagerShims(repository) {
  const executableDirectory = join(repository, "bin");
  mkdirSync(executableDirectory, { recursive: true });
  for (const command of ["npm", "npx"]) {
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? `${command}.cmd` : command
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? '@echo off\r\nif "%1"=="--version" (echo 10.0.0) else (echo [])\r\n'
        : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.0.0; else echo "[]"; fi\n'
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
  }
  return {
    PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
  };
}

test("help lists supported commands", () => {
  const result = run(["--help"], process.cwd());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /fixlab onboard/);
  assert.match(result.stdout, /fixlab init/);
  assert.match(result.stdout, /fixlab prepare/);
  assert.match(result.stdout, /fixlab authenticate/);
  assert.match(result.stdout, /fixlab setup-queries/);
  assert.match(result.stdout, /fixlab exec/);
  assert.match(result.stdout, /fixlab validate/);
  assert.match(result.stdout, /fixlab dashboard/);
  assert.match(result.stdout, /fixlab chat/);
  assert.match(result.stdout, /fixlab keep-awake/);
  assert.match(result.stdout, /--keep-awake-minutes <minutes>/);
  assert.match(result.stdout, /chat \[repository\]/);
  assert.match(result.stdout, /fixlab <repository>/);
  assert.match(result.stdout, /--runtime <agency\|copilot>/);
  assert.match(result.stdout, /--environment <name>/);
  assert.match(result.stdout, /FIXLAB_RUNTIME/);
  assert.match(result.stdout, /127\.0\.0\.1:4317/);
  assert.match(result.stdout, /docs\/troubleshooting\.md/);
});

function querySetupFixture(t) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-query-setup-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  assert.equal(run(["init", repository], repository).status, 0);
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const profile = JSON.parse(readFileSync(path, "utf8"));
  profile.environments = ["DEV", "SIT", "PPE", "Test"];
  profile.browserAutomation.testSynthesis = {
    defaultDataSource: "non-production-read-only", mutationMode: "none"
  };
  const save = () => writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
  save();
  const sentinel = join(repository, "product-source.txt");
  writeFileSync(sentinel, "preserve product source");
  const bin = join(repository, "bin");
  mkdirSync(bin);
  for (const runtime of ["agency", "copilot"]) {
    const executable = join(bin, process.platform === "win32" ? `${runtime}.cmd` : runtime);
    writeFileSync(executable, process.platform === "win32"
      ? "@echo off\r\necho RUNTIME_ARGS:%*\r\n"
      : "#!/bin/sh\nprintf 'RUNTIME_ARGS:%s\\n' \"$*\"\n");
    if (process.platform !== "win32") { chmodSync(executable, 0o755); }
  }
  return { repository, path, profile, save, sentinel, bin,
    environment: { PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` } };
}

test("query setup separates interactive planning from approved repair in both runtimes", (t) => {
  const f = querySetupFixture(t);
  const previous = readFileSync(f.path, "utf8");
  for (const runtime of ["agency", "copilot"]) {
    for (const approved of [false, true]) {
      const result = run(["setup-queries", f.repository, "--environment", "DEV",
        "--runtime", runtime, ...(approved ? ["--yes"] : [])], f.repository, f.environment);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--plugin-dir .* --agent fixlab:fixlab/u);
      assert.match(result.stdout, /--interactive FixLab query setup (?:PLAN|APPLY) for the selected dev environment/u);
      assert.match(result.stdout, approved
        ? /The user approved this setup operation only/
        : /PLAN ONLY: read and report/);
      assert.match(result.stdout, /ALL read-only queries across the approved API scope/u);
      assert.match(result.stdout, /Updating only the profile or agent instructions is not a completed repair/u);
      assert.match(result.stdout, /Do not contact a business API/u);
      assert.match(result.stdout, /fresh reviewed job/u);
      assert.doesNotMatch(result.stdout, /--allow-all|--allow-tool|--add-dir|--no-ask-user|--autopilot|--session-id/u);
      assert.equal(readFileSync(f.path, "utf8"), previous);
      assert.equal(readFileSync(f.sentinel, "utf8"), "preserve product source");
    }
  }
  const testEnvironment = run(["setup-queries", f.repository, "--environment", "Test",
    "--runtime", "copilot"], f.repository, f.environment);
  assert.equal(testEnvironment.status, 0, testEnvironment.stderr);
  assert.match(testEnvironment.stdout, /selected test environment/u);
});

test("query setup rejects unreviewed environments, malformed options and stricter policies before launch", (t) => {
  const f = querySetupFixture(t);
  for (const args of [
    [], ["--environment"], ["--environment", "production"],
    ["--environment", "unknown"], ["--environment", "DEV", "--environment", "SIT"],
    ["--environment", "DEV", "--yes", "--yes"], ["--environment", "DEV", "--allow-all-tools"],
    ["--environment", "DEV", "another-repository"]
  ]) {
    const result = run(["setup-queries", f.repository, "--runtime", "copilot", ...args],
      f.repository, f.environment);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /RUNTIME_ARGS:/u);
    assert.match(result.stderr, /Usage:|non-production|profile environments/u);
  }
  const original = JSON.stringify(f.profile);
  for (const change of ["api", "unit", "production", "synthetic"]) {
    Object.assign(f.profile, JSON.parse(original));
    if (change === "api") { f.profile.browserAutomation.mode = "api"; }
    if (change === "unit") { f.profile.validation.liveTestsRequired = false; }
    if (change === "production") { f.profile.browserAutomation.dataSafety.productionAllowed = true; }
    if (change === "synthetic") {
      Object.assign(f.profile.browserAutomation.testSynthesis, {
        defaultDataSource: "synthetic-intercepted", mutationMode: "intercepted", devReadOnly: false
      });
    }
    f.save();
    const result = run(["setup-queries", f.repository, "--environment", "DEV", "--yes",
      "--runtime", "copilot"], f.repository, f.environment);
    assert.equal(result.status, 1, change);
    assert.doesNotMatch(result.stdout, /RUNTIME_ARGS:/u);
    assert.match(result.stderr, /existing approved non-production browser read scope/u);
  }
});

test("query setup propagates runtime failure without reporting the adapter ready", (t) => {
  const f = querySetupFixture(t);
  const executable = join(f.bin, process.platform === "win32" ? "copilot.cmd" : "copilot");
  writeFileSync(executable, process.platform === "win32"
    ? "@echo off\r\nexit /b 7\r\n" : "#!/bin/sh\nexit 7\n");
  const result = run(["setup-queries", f.repository, "--environment", "DEV", "--yes",
    "--runtime", "copilot"], f.repository, f.environment);
  assert.equal(result.status, 7);
  assert.doesNotMatch(result.stdout, /setup ready|onboarding is ready/u);
});

test("direct shared-mode bug fixing requires dashboard-owned branch acquisition", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-shared-"));
  try {
    mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify({
      worktreeSetup: { mode: "shared" }
    }));
    const result = run(["run", repository, "--", "Fix a bug."], repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Shared worktree jobs require dashboard-owned branch acquisition/);
    assert.match(result.stderr, /fixlab dashboard or fixlab chat/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("CLI preserves model selection without interpreting request text as flags", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-model-"));
  const executableDirectory = join(repository, "bin");
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(executableDirectory, process.platform === "win32" ? "copilot.cmd" : "copilot");
    writeFileSync(executable, process.platform === "win32"
      ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
      : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n");
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const environment = {
      PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      FIXLAB_RUNTIME: "copilot",
      FIXLAB_MODEL: ""
    };
    for (const [options, model] of [
      [["--model", "HydraFusion"], "hydrafusion"],
      [["--model=claude-sonnet-4.5"], "claude-sonnet-4.5"],
      [[], "hydrafusion"]
    ]) {
      const result = run(
        ["run", repository, ...options, "--", "Explain", "--model", "in", "request", "text"],
        repository,
        { ...environment, ...(options.length ? {} : { FIXLAB_MODEL: "hydrafusion" }) }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`--model ${model.replaceAll(".", "\\.")}`));
      assert.equal(result.stdout.includes("--experimental"), model === "hydrafusion");
      assert.match(result.stdout, /Explain --model in request text/);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("CLI rejects unavailable runtime model selection and unsafe model identifiers", () => {
  for (const [runtime, model, message] of [
    ["agency", "hydrafusion", /copilot runtime/],
    ["copilot", "hydrafusion&whoami", /model must be/]
  ]) {
    const result = run(["run", "--runtime", runtime, "--model", model, "--", "Validate"], process.cwd());
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("onboard creates a new profile and stops before placeholder setup", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    const result = run(
      ["onboard", repository, "--runtime", "copilot"],
      repository,
      createPackageManagerShims(repository)
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /FixLab onboarding/);
    assert.match(result.stdout, /created a new example profile/i);
    assert.match(result.stdout, /Then rerun fixlab onboard/);
    assert.doesNotMatch(result.stderr, /restore directory is missing/);
    assert.equal(
      existsSync(
        join(
          repository,
          ".github",
          "fixlab",
          "repository-profile.json"
        )
      ),
      true
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("onboard plans existing repository setup without making changes", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.validation.commands.frontendRestore = "node prepare.js";
    profile.validation.commands.backendRestore = "node prepare.js";
    writeFileSync(profilePath, JSON.stringify(profile));
    for (const directory of ["frontend", "backend/src"]) {
      const workingDirectory = join(repository, directory);
      mkdirSync(workingDirectory, { recursive: true });
      writeFileSync(
        join(workingDirectory, "prepare.js"),
        'require("node:fs").writeFileSync("prepared.txt", "ready");'
      );
    }
    writeFileSync(join(repository, "frontend", "package-lock.json"), "{}");

    const result = run(
      ["onboard", repository, "--runtime", "copilot"],
      repository,
      createPackageManagerShims(repository)
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Repository preparation plan/);
    assert.match(result.stdout, /Playwright setup directory/);
    assert.match(
      result.stdout,
      /No restore or Playwright installation commands were executed/
    );
    assert.equal(
      existsSync(join(repository, "frontend", "prepared.txt")),
      false
    );
    assert.equal(
      existsSync(join(repository, "backend", "src", "prepared.txt")),
      false
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("onboard provisions a worktree only with approval, grants exact dependency paths and stops on restore failure", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-cli-worktree-"));
  const source = join(root, "source");
  const repository = join(root, "worktree");
  try {
    mkdirSync(join(source, "frontend"), { recursive: true });
    const git = (...args) => {
      const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--quiet");
    writeFileSync(join(source, "frontend", "prepare.js"),
      'require("node:fs").writeFileSync("prepared.txt", "attempted"); process.exit(3);');
    git("add", "frontend/prepare.js");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture");
    git("worktree", "add", "--quiet", "--detach", repository);
    assert.equal(run(["init", source], source).status, 0);
    const sourceProfile = join(source, ".github", "fixlab", "repository-profile.json");
    const profile = JSON.parse(readFileSync(sourceProfile, "utf8"));
    profile.validation.commands.frontendRestore = "node prepare.js";
    profile.validation.commands.backendRestore = "";
    profile.browserAutomation.testCommand = "playwright test --config=playwright.local.ts";
    profile.worktreeSetup = { files: ["frontend/playwright.local.ts"] };
    writeFileSync(sourceProfile, JSON.stringify(profile));
    writeFileSync(join(source, "frontend", "playwright.local.ts"), "export default {};");
    const dependencies = join(root, "dependencies", "node_modules");
    const playwright = join(dependencies, "@playwright", "test");
    mkdirSync(playwright, { recursive: true });
    writeFileSync(join(playwright, "index.js"),
      "exports.chromium = { launch: async () => ({ close: async () => {} }) };");
    symlinkSync(dependencies, join(repository, "frontend", "node_modules"), "junction");
    const environment = createPackageManagerShims(source);
    const args = ["onboard", repository, "--from", source, "--runtime", "copilot"];
    const plan = run(args, source, environment);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /No files or commands changed/);
    const targetProfile = join(repository, ".github", "fixlab", "repository-profile.json");
    assert.equal(existsSync(targetProfile), false);
    assert.equal(existsSync(join(repository, "frontend", "prepared.txt")), false);
    const approved = run([...args, "--yes"], source, environment);
    assert.notEqual(approved.status, 0);
    assert.match(approved.stdout, /Approved only the listed linked dependency directories/);
    assert.match(approved.stderr, /frontend restore failed/);
    assert.doesNotMatch(approved.stdout, /FixLab onboarding is ready/);
    assert.deepEqual(JSON.parse(readFileSync(targetProfile)).trustedDependencyRoots, [realpathSync(dependencies)]);
    assert.equal(readFileSync(join(repository, "frontend", "playwright.local.ts"), "utf8"), "export default {};");
    assert.equal(readFileSync(join(repository, "frontend", "prepared.txt"), "utf8"), "attempted");
    assert.equal(readFileSync(sourceProfile, "utf8"), JSON.stringify(profile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat opens explicit interactive setup for an incomplete profile and does not start after setup failure", async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-chat-setup-"));
  const probe = createServer();
  await new Promise((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePort);
  });
  const port = probe.address().port;
  await new Promise((resolvePort, reject) => probe.close((error) => error ? reject(error) : resolvePort()));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    delete profile.browserAutomation;
    writeFileSync(profilePath, JSON.stringify(profile));
    const environment = createPackageManagerShims(repository);
    const executable = join(repository, "bin", process.platform === "win32" ? "copilot.cmd" : "copilot");
    writeFileSync(executable, process.platform === "win32"
      ? "@echo off\r\necho ARGS:%*\r\nexit /b 7\r\n"
      : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\nexit 7\n");
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const result = run(["chat", repository, "--runtime", "copilot", "--port", String(port)], repository, environment, undefined, 30000);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /Opening the interactive FixLab onboarding session/);
    assert.match(result.stdout, /--interactive/);
    assert.match(result.stdout, /Set up this repository for FixLab/);
    assert.match(result.stderr, /onboarding exited with code 7/);
    assert.doesNotMatch(result.stdout, /FixLab dashboard started/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("onboard validates source arguments before initialization", () => {
  const result = run(["onboard", "--from", "--yes"], process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source checkout after --from/);
});

test("Windows bootstrap keeps NVM and Node changes explicit", () => {
  const installer = readFileSync(
    fileURLToPath(new URL("../scripts/install-fixlab.ps1", import.meta.url)),
    "utf8"
  );

  assert.match(installer, /\[switch\]\$InstallNode/);
  assert.match(installer, /\[switch\]\$Yes/);
  assert.match(installer, /NVM_HOME/);
  assert.match(installer, /settings\.txt/);
  assert.match(installer, /npm\.cmd/);
  assert.match(installer, /pack --dry-run --ignore-scripts --json/);
  assert.match(installer, /NVM reported success but did not create a coherent/);
  assert.match(installer, /Get-SafeSourceDisplay/);
  assert.match(installer, /\[REDACTED\]/);
  assert.doesNotMatch(installer, /Write-Output "FixLab source: \$Source"/);
  const missingRuntimeBranch = installer.indexOf(
    "if (-not $runtime -and $requestedVersion)"
  );
  const nodeApprovalGate = installer.indexOf(
    "if (-not $Yes)",
    missingRuntimeBranch
  );
  const nvmInstall = installer.indexOf("& $nvmExecutable install");
  assert.ok(missingRuntimeBranch >= 0);
  assert.ok(nodeApprovalGate > missingRuntimeBranch);
  assert.ok(nvmInstall > nodeApprovalGate);
  assert.match(
    installer,
    /Rerun with -InstallNode -Yes to approve the Node\.js installation/
  );
  assert.match(installer, /No changes made.*rerun with -Yes/s);
  assert.doesNotMatch(installer, /nvm\s+uninstall|setx\s+PATH/i);
});

test("portable Node repair is plan-first and checksum verified", () => {
  const repair = readFileSync(
    fileURLToPath(
      new URL("../scripts/repair-node-runtime.ps1", import.meta.url)
    ),
    "utf8"
  );

  assert.match(repair, /\[switch\]\$Yes/);
  assert.match(repair, /https:\/\/nodejs\.org\/dist\//);
  assert.match(repair, /SHASUMS256\.txt/);
  assert.match(repair, /Get-FileHash/);
  assert.match(repair, /-Algorithm SHA256/);
  assert.match(repair, /checksum mismatch/);
  assert.match(repair, /system PATH changes: none/);
  assert.match(repair, /NVM changes: none/);
  assert.match(repair, /\.fixlab-runtime-root/);
  assert.match(repair, /not marked as FixLab-owned/);
  assert.match(repair, /if \(-not \$Yes\)/);
  assert.match(repair, /No changes made/);
  assert.doesNotMatch(repair, /nvm\s+(?:install|uninstall)|setx\s+PATH/i);
});

test("init creates a parseable repository profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    const result = run(["init", repository], repository);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );

    assert.equal(result.status, 0);
    assert.equal(existsSync(profilePath), true);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    assert.equal(profile.browserAutomation.package, "@playwright/test");
    assert.equal(profile.browserAutomation.browser, "chromium");
    assert.equal(profile.browserAutomation.testCommand, "npm run test:e2e");
    assert.deepEqual(profile.browserAutomation.testSynthesis, {
      enabled: true,
      defaultDataSource: "synthetic-intercepted",
      devReadOnly: true,
      ppeReadOnly: true,
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    });
    assert.equal(profile.browserAutomation.authentication.required, false);
    assert.equal(profile.browserAutomation.dataSafety.productionAllowed, false);
    assert.equal(profile.pullRequests.branchNaming.userId, "your-user-id");
    assert.equal(
      profile.pullRequests.branchNaming.prefixTemplate,
      "users/{userId}"
    );
    const promptDirectory = join(repository, ".github", "prompts");
    const expectedPrompts = [
      "fixlab.bugfix.prompt.md",
      "fixlab.intake.prompt.md",
      "fixlab.diagnose.prompt.md",
      "fixlab.reproduce.prompt.md",
      "fixlab.fix.prompt.md",
      "fixlab.validate.prompt.md",
      "fixlab.live-test.prompt.md",
      "fixlab.pr.prompt.md",
      "fixlab.summary.prompt.md"
    ];
    for (const promptName of expectedPrompts) {
      assert.equal(existsSync(join(promptDirectory, promptName)), true);
    }
    const agentPath = join(
      repository,
      ".github",
      "agents",
      "fixlab-autofix.agent.md"
    );
    assert.equal(existsSync(agentPath), true);
    const agent = readFileSync(agentPath, "utf8");
    assert.match(agent, /target: vscode/);
    assert.match(agent, /Fix one reported bug/);
    assert.match(agent, /\.github\/fixlab\/repository-profile\.json/);
    assert.match(agent, /Never select production automatically/);

    const bugfixPrompt = readFileSync(
      join(promptDirectory, "fixlab.bugfix.prompt.md"),
      "utf8"
    );
    assert.match(bugfixPrompt, /agent: fixlab-autofix/);
    assert.match(bugfixPrompt, /smallest complete correction/);
    assert.equal(
      readFileSync(join(promptDirectory, "fixlab.summary.prompt.md"), "utf8"),
      readFileSync(new URL("../prompts/fixlab.summary.prompt.md", import.meta.url), "utf8")
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("init preserves existing profile and prompt files", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const promptPath = join(
      repository,
      ".github",
      "prompts",
      "fixlab.summary.prompt.md"
    );
    const agentPath = join(
      repository,
      ".github",
      "agents",
      "fixlab-autofix.agent.md"
    );
    writeFileSync(profilePath, '{"name":"custom"}');
    writeFileSync(promptPath, "custom prompt");
    writeFileSync(agentPath, "custom agent");
    const second = run(["init", repository], repository);

    assert.equal(second.status, 0);
    assert.match(second.stdout, /Kept existing FixLab profile/);
    assert.match(
      second.stdout,
      /Existing profiles are preserved and are not upgraded automatically/
    );
    assert.match(
      second.stdout,
      /Profile upgrade required: add browserAutomation\.testSynthesis/
    );
    assert.match(second.stdout, /Kept existing FixLab prompt/);
    assert.match(second.stdout, /Kept existing FixLab agent/);
    assert.equal(readFileSync(profilePath, "utf8"), '{"name":"custom"}');
    assert.equal(readFileSync(promptPath, "utf8"), "custom prompt");
    assert.equal(readFileSync(agentPath, "utf8"), "custom agent");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks when Playwright is unavailable", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    const initialized = run(["init", repository], repository);
    assert.equal(initialized.status, 0);
    assert.match(initialized.stdout, /frontend.*backend.*example paths/i);
    assert.match(initialized.stdout, /Do not create empty application folders/);
    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright package/);
    assert.match(result.stdout, /FAIL  Playwright browser/);
    assert.match(result.stdout, /browserAutomation\.workingDirectory/);
    assert.match(result.stdout, /applications\.frontend\.workingDirectory/);
    assert.ok(result.stdout.includes(join(".github", "fixlab", "repository-profile.json")));
    assert.match(result.stdout, /Do not create an empty frontend folder/);
    const setup = run(["setup-playwright", repository, "--yes"], repository);
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /browserAutomation\.workingDirectory/);
    assert.match(setup.stderr, /Do not create an empty frontend folder/);
    assert.doesNotMatch(setup.stdout, /Planned commands:/);
    assert.equal(existsSync(join(repository, "frontend")), false);
    assert.equal(existsSync(join(repository, "backend")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor and Playwright setup reject a file used as the working directory", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const frontend = join(repository, "frontend");
    writeFileSync(frontend, "preserve this file");
    const result = run(["doctor", repository], repository, createPackageManagerShims(repository));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright package \(working directory is not a directory:/);
    assert.match(result.stdout, /browserAutomation\.workingDirectory/);
    assert.doesNotMatch(result.stdout, /FAIL  Frontend package manager/);
    const setup = run(["setup-playwright", repository, "--yes"], repository);
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /working directory is not a directory:/);
    assert.doesNotMatch(setup.stdout, /Planned commands:/);
    assert.equal(readFileSync(frontend, "utf8"), "preserve this file");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor explains a missing Playwright package in an existing empty directory", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(join(repository, "frontend"));
    const result = run(["doctor", repository], repository, createPackageManagerShims(repository));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright package \(install @playwright\/test/);
    assert.match(result.stdout, /browserAutomation\.workingDirectory/);
    assert.match(result.stdout, /An empty frontend folder does not configure the application/);
    assert.match(result.stdout, /fixlab setup-playwright/);
    assert.equal(existsSync(join(repository, "frontend", "node_modules")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Playwright directory guidance preserves API-only checks and frontend fallback", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.mode = "api";
    profile.browserAutomation.workingDirectory = "api-tests";
    writeFileSync(path, JSON.stringify(profile));
    const result = run(["doctor", repository], repository);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Playwright API \(working directory is missing:/);
    assert.ok(result.stdout.includes(join(repository, "api-tests")));
    assert.doesNotMatch(result.stdout, /Playwright browser/);
    delete profile.browserAutomation.workingDirectory;
    profile.applications.frontend.workingDirectory = "ui-app";
    writeFileSync(path, JSON.stringify(profile));
    const setup = run(["setup-playwright", repository, "--yes"], repository);
    assert.equal(setup.status, 1);
    assert.ok(setup.stderr.includes(join(repository, "ui-app")));
    assert.match(setup.stderr, /applications\.frontend\.workingDirectory/);
    assert.doesNotMatch(setup.stdout, /Planned commands:/);
    assert.equal(existsSync(join(repository, "api-tests")), false);
    assert.equal(existsSync(join(repository, "ui-app")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only Doctor initializes request contexts without launching a browser or proving sign-in", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-api-"));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.applications = { backend: {
      workingDirectory: ".", command: "dotnet run", port: 5087,
      healthUrl: "http://127.0.0.1:5087/health"
    } };
    profile.browserAutomation.mode = "api";
    profile.browserAutomation.workingDirectory = ".";
    delete profile.browserAutomation.browser;
    profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
    profile.browserAutomation.testSynthesis.mutationMode = "none";
    profile.browserAutomation.dataSafety.allowedOrigins = ["http://127.0.0.1:5087"];
    profile.browserAutomation.dataSafety.allowedMethods = ["GET"];
    delete profile.validation.commands.frontendRestore;
    writeFileSync(path, JSON.stringify(profile));
    const packageDirectory = join(repository, "node_modules", "@playwright", "test");
    mkdirSync(packageDirectory, { recursive: true });
    const modulePath = join(packageDirectory, "index.js");
    writeFileSync(modulePath,
      "exports.request = { newContext: async () => ({ dispose: async () => {} }) }; exports.chromium = { launch: () => { throw Error('browser-must-not-launch'); } };");
    const result = run(["doctor", repository], repository);
    assert.match(result.stdout, /PASS  Live-test profile/);
    assert.match(result.stdout, /PASS  Playwright API \(APIRequestContext initialized without a browser\)/);
    assert.match(result.stdout, /Doctor does not prove API health or API authentication/);
    assert.doesNotMatch(result.stdout + result.stderr, /Playwright browser|browser-must-not-launch/);
    const ready = run(["setup-playwright", repository], repository);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /Playwright is already ready/);
    writeFileSync(modulePath, "exports.request = { newContext: async () => { throw Error('fixture-sensitive-detail'); } };");
    const failed = run(["doctor", repository], repository);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAIL  Playwright API/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /fixture-sensitive-detail/);
    rmSync(join(repository, "node_modules"), { recursive: true, force: true });
    const plan = run(["setup-playwright", repository], repository);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /npm install --save-dev @playwright\/test/);
    assert.doesNotMatch(plan.stdout, /playwright install/);
    profile.browserAutomation.mode = "unsupported";
    writeFileSync(path, JSON.stringify(profile));
    const invalid = run(["setup-playwright", repository, "--yes"], repository);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /browserAutomation.mode must be browser or api/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor and prepare block a broken frontend package manager", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    mkdirSync(join(repository, "frontend"), { recursive: true });
    mkdirSync(join(repository, "backend", "src"), { recursive: true });
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "npm.cmd" : "npm"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\nif \"%1\"==\"--version\" (\r\n  echo 11.17.0\r\n  exit /b 0\r\n)\r\necho TypeError: Class extends value undefined is not a constructor or null 1>&2\r\nexit /b 1\r\n"
        : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' '11.17.0'\n  exit 0\nfi\nprintf '%s\\n' 'TypeError: Class extends value undefined is not a constructor or null' >&2\nexit 1\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const path = [
      executableDirectory,
      process.env.PATH
    ].filter(Boolean).join(process.platform === "win32" ? ";" : ":");

    const doctorResult = run(["doctor", repository], repository, {
      PATH: path
    });
    assert.equal(doctorResult.status, 1);
    assert.match(doctorResult.stdout, /FAIL  Frontend package manager/);
    assert.match(
      doctorResult.stdout,
      /align the active Node\.js and npm installation/
    );

    const prepareResult = run(
      ["prepare", repository, "--yes"],
      repository,
      { PATH: path }
    );
    assert.equal(prepareResult.status, 1);
    assert.match(prepareResult.stdout, /FAIL  Frontend package manager/);
    assert.match(
      prepareResult.stderr,
      /stopped before dependency restore/
    );
    assert.match(prepareResult.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor and dashboard block an incomplete live-test profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    delete profile.browserAutomation.testCommand;
    profile.browserAutomation.authentication = {};
    profile.browserAutomation.dataSafety.productionAllowed = true;
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Live-test profile/);
    assert.match(result.stdout, /browserAutomation\.testCommand/);
    assert.match(result.stdout, /browserAutomation\.authentication\.required/);
    assert.match(result.stdout, /browserAutomation\.dataSafety\.productionAllowed=false/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks until required browser authentication is complete", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.authentication = {
      required: true,
      command: "npm run test:e2e:auth",
      statusPaths: ["e2e/.auth/user.json"]
    };
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL  Live-test profile/);
    assert.match(result.stdout, /browserAutomation authentication is not ready/);
    assert.match(result.stdout, /e2e\/\.auth\/user\.json/);
    assert.match(result.stderr, /Next action: run "npm run test:e2e:auth"/);
    assert.match(result.stderr, /complete interactive sign-in/);
    assert.match(result.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor redacts secrets from authentication command guidance", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.authentication = {
      required: true,
      command:
        "cross-env TOKEN=super-secret npm run auth --password hunter2 --url https://user:pass@example.test",
      statusPaths: ["e2e/.auth/user.json"]
    };
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /TOKEN=\[REDACTED\]/);
    assert.match(result.stderr, /--password \[REDACTED\]/);
    assert.match(result.stderr, /https:\/\/user:\[REDACTED\]@example\.test/);
    assert.doesNotMatch(result.stderr, /super-secret|hunter2|user:pass/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("authenticate runs the repository-owned command from the configured directory", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const frontendDirectory = join(repository, "frontend");
    mkdirSync(frontendDirectory);
    writeFileSync(
      join(frontendDirectory, "authenticate-fixture.js"),
      [
        'const { mkdirSync, writeFileSync } = require("node:fs");',
        'mkdirSync("e2e/.auth", { recursive: true });',
        'writeFileSync("e2e/.auth/user.json", process.env.E2E_START ?? "missing");'
      ].join("\n")
    );
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.workingDirectory = "frontend";
    profile.browserAutomation.authentication = {
      required: true,
      command: "node authenticate-fixture.js --token super-secret",
      environment: {
        E2E_START: "npm run start:test"
      },
      statusPaths: ["e2e/.auth/user.json"]
    };
    writeFileSync(profilePath, JSON.stringify(profile));

    const planned = run(["authenticate", repository], repository);
    assert.equal(planned.status, 0);
    assert.match(planned.stdout, /Browser authentication plan/);
    assert.match(planned.stdout, /--token \[REDACTED\]/);
    assert.match(planned.stdout, /working directory: .*frontend/);
    assert.match(planned.stdout, /environment: E2E_START/);
    assert.doesNotMatch(planned.stdout, /super-secret|npm run start:test/);
    assert.equal(
      existsSync(join(frontendDirectory, "e2e", ".auth", "user.json")),
      false
    );

    const executed = run(
      ["authenticate", repository, "--yes"],
      repository
    );
    assert.equal(executed.status, 0);
    assert.match(
      executed.stdout,
      /Browser authentication helper completed and required state is present; this does not prove sign-in/
    );
    assert.match(executed.stdout, /authenticated browser proof for the selected job and environment/);
    assert.doesNotMatch(executed.stdout, /required state is ready/);
    assert.equal(
      readFileSync(
        join(frontendDirectory, "e2e", ".auth", "user.json"),
        "utf8"
      ),
      "npm run start:test"
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor blocks when the repository-pinned .NET SDK cannot resolve", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    writeFileSync(
      join(repository, "global.json"),
      JSON.stringify({ sdk: { version: "8.0.421" } })
    );
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "dotnet.cmd" : "dotnet"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho A compatible .NET SDK was not found. 1>&2\r\nexit /b 1\r\n"
        : "#!/bin/sh\nprintf '%s\\n' 'A compatible .NET SDK was not found.' >&2\nexit 1\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const isolatedPath =
      process.platform === "win32"
        ? [
            executableDirectory,
            join(process.env.SystemRoot, "System32"),
            process.env.SystemRoot
          ].join(";")
        : `${executableDirectory}:/usr/bin:/bin`;
    const result = run(["doctor", repository], repository, {
      PATH: isolatedPath
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /FAIL  \.NET SDK \(requires 8\.0\.421 from .*global\.json\)/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("doctor launches the configured Playwright browser", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const playwrightDirectory = join(
      repository,
      "frontend",
      "node_modules",
      "@playwright",
      "test"
    );
    mkdirSync(playwrightDirectory, { recursive: true });
    writeFileSync(
      join(playwrightDirectory, "index.js"),
      "exports.chromium = { launch: async (options) => { if (options.channel !== 'msedge') throw new Error('missing Edge channel'); return { close: async () => {} }; } };"
    );
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.channel = "msedge";
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = run(["doctor", repository], repository);

    assert.match(result.stdout, /PASS  Playwright package/);
    assert.doesNotMatch(result.stdout, /FixLab is ready for/);
    assert.match(result.stdout, /does not prove an authenticated browser session/);
    assert.match(
      result.stdout,
      /PASS  Playwright browser \(chromium channel msedge launched successfully\)/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prepare plans and runs repository-owned restore commands", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.validation.commands.frontendRestore = "node prepare.js";
    profile.validation.commands.backendRestore = "node prepare.js";
    writeFileSync(profilePath, JSON.stringify(profile));

    for (const application of ["frontend", "backend/src"]) {
      const workingDirectory = join(repository, application);
      mkdirSync(workingDirectory, { recursive: true });
      writeFileSync(
        join(workingDirectory, "prepare.js"),
        'require("node:fs").writeFileSync("prepared.txt", "ready");'
      );
    }

    const planned = run(["prepare", repository], repository);
    assert.equal(planned.status, 0);
    assert.match(planned.stdout, /Repository preparation plan/);
    assert.match(planned.stdout, /No commands executed/);
    assert.equal(
      existsSync(join(repository, "frontend", "prepared.txt")),
      false
    );

    const prepared = run(["prepare", repository, "--yes"], repository);
    assert.equal(prepared.status, 0);
    assert.match(prepared.stdout, /PASS  frontend restore/);
    assert.match(prepared.stdout, /PASS  backend restore/);
    assert.equal(
      readFileSync(join(repository, "frontend", "prepared.txt"), "utf8"),
      "ready"
    );
    assert.equal(
      readFileSync(join(repository, "backend", "src", "prepared.txt"), "utf8"),
      "ready"
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("prepare restore failures include troubleshooting guidance", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.validation.commands.frontendRestore =
      'node -e "process.exit(7)"';
    delete profile.validation.commands.backendRestore;
    writeFileSync(profilePath, JSON.stringify(profile));
    mkdirSync(join(repository, "frontend"), { recursive: true });

    const result = run(["prepare", repository, "--yes"], repository);

    assert.equal(result.status, 7);
    assert.match(result.stderr, /frontend restore failed/);
    assert.match(result.stderr, /docs\/troubleshooting\.md/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("setup-playwright plans approved repository-local commands without changing files", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const frontend = join(repository, "frontend");
    mkdirSync(frontend, { recursive: true });
    writeFileSync(join(frontend, "package-lock.json"), "{}");

    const result = run(
      ["setup-playwright", repository],
      repository,
      createPackageManagerShims(repository)
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Detected package manager: npm/);
    assert.match(result.stdout, /npm install --save-dev @playwright\/test/);
    assert.match(result.stdout, /npx playwright install chromium/);
    assert.match(result.stdout, /No changes made/);
    assert.equal(existsSync(join(frontend, "node_modules")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("validate requires a numeric pull request", () => {
  const result = run(["validate", "--pr", "invalid"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only digits/);
});

test("repository commands reject pull request URLs", () => {
  const result = run(
    [
      "doctor",
      "https://example.test/project/_git/application/pullrequest/123"
    ],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a local directory, not a URL/);
  assert.match(result.stderr, /fixlab validate --pr <number>/);
  assert.doesNotMatch(result.stderr, /https:\\/);
});

test("dashboard rejects invalid ports before starting", () => {
  const result = run(["dashboard", "--port", "70000"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /integer between 1 and 65535/);
});

test("dashboard rejects unknown options before starting", () => {
  const result = run(["dashboard", "--public"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown dashboard option/);
});

test("dashboard browser opening is opt-in, including after onboarding", () => {
  const content = readFileSync(cli, "utf8");
  assert.match(
    content,
    /function parseDashboardArguments\(args\) \{[\s\S]*?let open = false;/
  );
  assert.match(content, /if \(argument === "--open"\) \{\s+open = true;/);
  assert.match(
    content,
    /return dashboard\(repository, DEFAULT_DASHBOARD_PORT, false, runtime, 0, model\);/
  );
  const missing = join(tmpdir(), `fixlab-browser-opt-in-${process.pid}`);
  const result = run(["dashboard", missing, "--open"], process.cwd());
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /unknown dashboard option/);
  assert.match(result.stderr, /Cannot start FixLab dashboard/);
});

test("keep-awake validates bounded timers", () => {
  assert.equal(parseKeepAwakeMinutes("90"), 90);
  assert.throws(
    () => parseKeepAwakeMinutes("0"),
    /integer between 1 and 1440/
  );
  assert.throws(
    () => parseKeepAwakeMinutes("1441"),
    /integer between 1 and 1440/
  );

  const result = run(["keep-awake", "--minutes", "0"], process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /integer between 1 and 1440/);
});

test("keep-awake uses an owned Windows execution-state process", async () => {
  let invocation;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = (signal) => {
    invocation.signal = signal;
    child.exitCode = 0;
    return true;
  };
  const handle = startKeepAwake(30, {
    platform: "win32",
    stdio: "ignore",
    startupDelayMs: 0,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });

  await handle.ready;
  assert.equal(invocation.command, "pwsh");
  assert.deepEqual(invocation.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command"
  ]);
  assert.match(invocation.args[3], /SetThreadExecutionState/);
  assert.match(invocation.args[3], /executionState -eq 0/);
  assert.match(invocation.args[3], /Start-Sleep -Seconds 1800/);
  assert.equal(invocation.options.shell, false);
  stopKeepAwake(handle);
  assert.equal(invocation.signal, "SIGTERM");
});

test("keep-awake rejects startup failures before reporting success", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => true;
  const handle = startKeepAwake(30, {
    platform: "linux",
    stdio: "ignore",
    startupDelayMs: 0,
    spawnProcess() {
      queueMicrotask(() => {
        const error = new Error("systemd-inhibit was not found");
        error.code = "ENOENT";
        child.emit("error", error);
      });
      return child;
    }
  });

  await assert.rejects(handle.ready, /systemd-inhibit was not found/);
});

test("dashboard rejects invalid keep-awake timers before starting", () => {
  const result = run(
    ["dashboard", "--keep-awake-minutes", "forever"],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /integer between 1 and 1440/);
});

test("dashboard rejects a missing repository before starting", () => {
  const missing = join(tmpdir(), `fixlab-missing-${Date.now()}`);
  const result = run(["dashboard", missing, "--no-open"], process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository does not exist/);
});

test("chat validates a repository before starting a missing dashboard", () => {
  const missing = join(tmpdir(), `fixlab-chat-missing-${Date.now()}`);
  const result = run(
    ["chat", missing, "--port", "4319"],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository does not exist/);
});

test("run launches the Agency-resolved FixLab agent with real DEV reads from new onboarding defaults", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.workflow.publication = "ready";
    writeFileSync(profilePath, JSON.stringify(profile));
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--environment",
        "development",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /ARGS:copilot --plugin-dir [^\r\n]+ --agent fixlab:fixlab/
    );
    assert.doesNotMatch(result.stdout, /--interactive/);
    assert.match(result.stdout, /Use development as the user-selected validation environment/);
    assert.match(result.stdout, /Do not silently fall back/);
    assert.match(result.stdout, /primary business-data source/);
    assert.match(result.stdout, /Verified read-only POST searches:/u);
    assert.match(result.stdout, /policy blocker, not backend unavailability/u);
    assert.match(result.stdout, /synthetic pass proves the UI behavior only/);
    assert.match(result.stdout, /FIXLAB_ACTIVITY/);
    assert.match(result.stdout, /FIXLAB_TEST/);
    assert.match(result.stdout, /transient validation artifacts/);
    assert.match(result.stdout, /publish the authorized PR by marking it ready for review/);
    assert.match(result.stdout, /Do not wait for remote PR CI or build completion before publication/);
    assert.match(result.stdout, /Verify the PR is no longer draft before reporting the PR stage passed/);
    assert.match(result.stdout, /\*\.auth\.spec\.ts/);
    assert.match(result.stdout, /Request: repair the defect/);
    const unverified = run([
      "run", repository, "--environment", "development", "--draft-without-checks",
      "--skip-live-tests", "--deployed-backend", "--", "prepare the code-only draft"
    ], repository, {
      PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
    });
    assert.equal(unverified.status, 0, unverified.stderr);
    assert.match(unverified.stdout, /Explicit unverified draft/);
    assert.match(unverified.stdout, /deferValidation=true; skipLiveTests=true; useDeployedBackend=true/);
    assert.match(unverified.stdout, /isDraft=true/);
    assert.doesNotMatch(unverified.stdout, /publish the authorized PR by marking it ready/);
    assert.match(unverified.stdout, /Request: prepare the code-only draft/);
    const validation = run(
      ["validate", repository, "--pr", "123", "--runtime", "agency"],
      repository,
      { PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` }
    );
    assert.equal(validation.status, 0);
    assert.match(validation.stdout, /Do not publish a pull request or change its draft status in read-only mode/);
    assert.doesNotMatch(validation.stdout, /gh pr ready|az repos pr update/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const runtime of ["agency", "copilot"]) {
  test(`${runtime} API-only CLI guidance never offers browser interception or synthetic fallback`, () => {
    const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-api-"));
    try {
      assert.equal(run(["init", repository], repository).status, 0);
      const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.browserAutomation.mode = "api";
      profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
      profile.browserAutomation.testSynthesis.mutationMode = "none";
      writeFileSync(profilePath, JSON.stringify(profile));
      const executableDirectory = join(repository, "bin");
      mkdirSync(executableDirectory);
      const executable = join(executableDirectory, process.platform === "win32" ? `${runtime}.cmd` : runtime);
      writeFileSync(executable, process.platform === "win32"
        ? "@echo off\r\nmore\r\n" : "#!/bin/sh\ncat\n");
      if (process.platform !== "win32") {
        chmodSync(executable, 0o755);
      }
      const environment = {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      };
      for (const readOnly of [false, true]) {
        const result = run(readOnly
          ? ["validate", repository, "--pr", "123", "--runtime", runtime]
          : ["run", repository, "--runtime", runtime, "--environment", "development", "--", "Check the API."],
        repository, environment);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /APIRequestContext/);
        assert.match(result.stdout, /synthetic responses never prove a live API passed/);
        if (!readOnly) {
          assert.match(result.stdout, /Use development as the user-selected validation environment/);
        }
        assert.doesNotMatch(result.stdout, /intercept every mutating request|Fall back to synthetic-intercepted data|When fallback occurs, emit|synthetic pass proves the UI behavior only/);
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("direct run and validate cannot bypass production database job-bound proof", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-production-"));
  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = JSON.parse(readFileSync(path, "utf8"));
    profile.browserAutomation.mode = "api";
    for (const approved of [true, false]) {
      profile.browserAutomation.apiAuthentication = { productionDatabaseReadOnly: approved };
      profile.browserAutomation.testSynthesis.defaultDataSource = "production-read-only";
      writeFileSync(path, JSON.stringify(profile));
      for (const args of [
        ["run", repository, "--", "Read the local API."],
        ["validate", repository, "--pr", "123"]
      ]) {
        const result = run(args, repository);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /dashboard-owned, fresh job-bound authentication/u);
      }
    }
    profile.browserAutomation.mode = "browser";
    profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = true;
    writeFileSync(path, JSON.stringify(profile));
    const authentication = run(["authenticate", repository, "--yes"], repository);
    assert.equal(authentication.status, 1);
    assert.match(authentication.stderr, /not ordinary portal UI authentication/u);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("Agency backend-first guidance requires both environment and effective read-only source", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\nmore\r\n"
        : "#!/bin/sh\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }
    const environment = {
      PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
    };

    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.browserAutomation.testSynthesis.devReadOnly = false;
    writeFileSync(profilePath, JSON.stringify(profile));
    const selectedWithoutReadOnly = run(
      [
        "run",
        repository,
        "--environment",
        "development",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      environment
    );
    assert.equal(selectedWithoutReadOnly.status, 0);
    assert.match(
      selectedWithoutReadOnly.stdout,
      /Use development as the user-selected validation environment/
    );
    assert.doesNotMatch(
      selectedWithoutReadOnly.stdout,
      /primary business-data source/
    );

    profile.browserAutomation.testSynthesis.defaultDataSource =
      "non-production-read-only";
    writeFileSync(profilePath, JSON.stringify(profile));
    const readOnlyWithoutSelection = run(
      ["run", repository, "--", "repair", "the", "defect"],
      repository,
      environment
    );
    assert.equal(readOnlyWithoutSelection.status, 0);
    assert.doesNotMatch(
      readOnlyWithoutSelection.stdout,
      /primary business-data source/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run launches the FixLab plugin directly through Copilot", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "copilot.cmd" : "copilot"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--runtime",
        "copilot",
        "--",
        "repair",
        "the",
        "defect"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /--plugin-dir [^\r\n]+ --agent fixlab:fixlab/
    );
    assert.match(result.stdout, /--autopilot/);
    assert.match(result.stdout, /transient validation artifacts/);
    assert.match(result.stdout, /authorized DRAFT pull request now/);
    assert.match(result.stdout, /read back provider isDraft=true before reporting publication passed/);
    assert.match(result.stdout, /Marking ready requires a separate reviewed decision/);
    assert.doesNotMatch(result.stdout, /gh pr ready|az repos pr update/);
    assert.match(result.stdout, /\*\.auth\.spec\.ts/);
    assert.match(result.stdout, /Request: repair the defect/);
    assert.doesNotMatch(result.stdout, /--interactive repair the defect/);
    const validation = run(
      ["validate", repository, "--pr", "123", "--runtime", "copilot"],
      repository,
      { PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` }
    );
    assert.equal(validation.status, 0);
    assert.match(validation.stdout, /Do not publish a pull request or change its draft status in read-only mode/);
    assert.doesNotMatch(validation.stdout, /gh pr ready|az repos pr update/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request preserves interactive Agency mode", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      ["run", repository],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      },
      "interactive input\n"
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /--plugin-dir [^\r\n]+ --agent fixlab:fixlab/
    );
    assert.doesNotMatch(result.stdout, /--interactive/);
    assert.match(result.stdout, /interactive input/);

    const directResult = run(
      [repository],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      },
      "direct interactive input\n"
    );

    assert.equal(directResult.status, 0);
    assert.match(
      directResult.stdout,
      /--plugin-dir [^\r\n]+ --agent fixlab:fixlab/
    );
    assert.doesNotMatch(directResult.stdout, /--interactive/);
    assert.match(directResult.stdout, /direct interactive input/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request keeps Agency guidance interactive", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "agency.cmd" : "agency"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      ["run", repository, "--environment", "development"],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--interactive/);
    assert.doesNotMatch(result.stdout, /Reusable PR learning:/);
    assert.doesNotMatch(result.stdout, /--session-id/);
    assert.doesNotMatch(result.stdout, /--no-ask-user/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run without a request keeps Copilot environment guidance interactive", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));
  const executableDirectory = join(repository, "bin");

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    mkdirSync(executableDirectory);
    const executable = join(
      executableDirectory,
      process.platform === "win32" ? "copilot.cmd" : "copilot"
    );
    writeFileSync(
      executable,
      process.platform === "win32"
        ? "@echo off\r\necho ARGS:%*\r\nmore\r\n"
        : "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\"\ncat\n"
    );
    if (process.platform !== "win32") {
      chmodSync(executable, 0o755);
    }

    const result = run(
      [
        "run",
        repository,
        "--runtime",
        "copilot",
        "--environment",
        "development"
      ],
      repository,
      {
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
      },
      "inherited-standard-input\n"
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--interactive/);
    assert.doesNotMatch(result.stdout, /Reusable PR learning:/);
    assert.match(
      result.stdout,
      /Use development as the user-selected validation environment/
    );
    assert.match(result.stdout, /authorized DRAFT pull request now/);
    assert.match(result.stdout, /Broader local unit tests are optional and are not automatically requested/);
    assert.match(result.stdout, /Optional builds are not automatically requested/);
    assert.match(result.stdout, /Leave their status not run\/pending/);
    assert.doesNotMatch(result.stdout, /READY-FOR-REVIEW|After creating the PR, run the broader local unit-test/);
    assert.doesNotMatch(result.stdout, /delivery policy[^:\r\n]*:\r?\n/);
    assert.doesNotMatch(result.stdout, /--session-id/);
    assert.doesNotMatch(result.stdout, /--no-ask-user/);
    assert.doesNotMatch(result.stdout, /--autopilot/);
    assert.match(result.stdout, /inherited-standard-input/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("runtime selection rejects unsupported values", () => {
  const result = run(
    ["run", "--runtime", "unknown", "--", "validate"],
    process.cwd()
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime must be one of: agency, copilot/);
});

test("run rejects an environment outside the repository profile", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-cli-"));

  try {
    assert.equal(run(["init", repository], repository).status, 0);
    const result = run(
      ["run", repository, "--environment", "production", "--", "validate"],
      repository
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-production environment/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
