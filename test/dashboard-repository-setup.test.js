import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { assignedJobWorktree, needsJobWorktree, prepareJobWorktree, restoreJobWorktree } from "../dashboard/job-worktree.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { applyWorktreeSetup, browserConfigurationErrors, planWorktreeSetup, SETUP_PROFILE_PATH } from "../dashboard/repository-setup.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-worktree-setup-"));
  const source = join(root, "source");
  const repository = join(root, "worktree");
  mkdirSync(source);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  writeFileSync(join(source, "tracked.txt"), "fixture");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture");
  git("worktree", "add", "--quiet", "--detach", repository);
  mkdirSync(join(source, ".github", "fixlab"), { recursive: true });
  mkdirSync(join(source, "frontend"));
  const profile = {
    browserAutomation: { workingDirectory: "frontend", testCommand: "playwright test --config=playwright.local.ts" },
    worktreeSetup: { files: ["frontend/playwright.local.ts"] }
  };
  writeFileSync(join(source, SETUP_PROFILE_PATH), JSON.stringify(profile));
  writeFileSync(join(source, "frontend", "playwright.local.ts"), "export default {};");
  return { root, source, repository, profile, git };
}

test("ticket snapshots use the selected commit and keep older investigations pinned", () => {
  const f = fixture();
  try {
    applyWorktreeSetup(planWorktreeSetup(f));
    writeFileSync(join(f.repository, "tracked.txt"), "preserve watcher edits");
    writeFileSync(join(f.source, "tracked.txt"), "new target revision");
    f.git("add", "tracked.txt");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "new target");
    const selected = f.git("rev-parse", "HEAD");
    const first = prepareJobWorktree({ repository: f.repository, jobId: randomUUID(), baseCommit: selected });
    assert.equal(first.baseCommit, selected);
    assert.equal(readFileSync(join(first.repository, "tracked.txt"), "utf8"), "new target revision");
    writeFileSync(join(f.source, "tracked.txt"), "next ticket revision");
    f.git("add", "tracked.txt");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "next target");
    const next = f.git("rev-parse", "HEAD");
    const second = prepareJobWorktree({ repository: f.repository, jobId: randomUUID(), baseCommit: next });
    assert.equal(second.baseCommit, next);
    assert.equal(readFileSync(join(second.repository, "tracked.txt"), "utf8"), "next ticket revision");
    assert.equal(readFileSync(join(first.repository, "tracked.txt"), "utf8"), "new target revision");
    assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "preserve watcher edits");
    assert.throws(() => prepareJobWorktree({
      repository: f.repository, jobId: first.jobId, baseCommit: next
    }), /commit|revision/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("detached editing jobs automatically receive a reusable owned checkout without changing the source", () => {
  const f = fixture();
  try {
    applyWorktreeSetup(planWorktreeSetup(f));
    const jobId = randomUUID();
    assert.equal(needsJobWorktree(f.repository, f.profile, "fix-and-validate"), true);
    assert.equal(needsJobWorktree(f.repository, f.profile, "playwright-only"), false);
    assert.equal(needsJobWorktree(f.repository, { worktreeSetup: { mode: "shared" } }, "fix-and-validate"), false);
    writeFileSync(join(f.repository, "tracked.txt"), "preserve unrelated source edits");
    const workspace = prepareJobWorktree({ repository: f.repository, jobId });
    assert.notEqual(workspace.repository, f.repository);
    assert.equal(readFileSync(join(f.repository, "tracked.txt"), "utf8"), "preserve unrelated source edits");
    assert.equal(readFileSync(join(workspace.repository, "tracked.txt"), "utf8"), "fixture");
    assert.deepEqual(JSON.parse(readFileSync(join(workspace.repository, SETUP_PROFILE_PATH))), f.profile);
    writeFileSync(join(workspace.repository, "tracked.txt"), "retained job changes");
    assert.deepEqual(prepareJobWorktree({ repository: f.repository, jobId }), workspace);
    assert.deepEqual(assignedJobWorktree({ repository: workspace.repository, jobId }), workspace);
    assert.equal(assignedJobWorktree({ repository: f.repository, jobId }), null);
    assert.equal(readFileSync(join(workspace.repository, "tracked.txt"), "utf8"), "retained job changes");
    writeFileSync(join(f.repository, SETUP_PROFILE_PATH), '{"changed":true}');
    assert.throws(() => prepareJobWorktree({ repository: f.repository, jobId }), /configuration changed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("owned checkout recovery retains verified configuration when only watcher diagnostics change", () => {
  const f = fixture();
  try {
    const jobId = randomUUID();
    const workspace = prepareJobWorktree({ repository: f.source, jobId });
    const receiptPath = join(f.source, ".git", "fixlab", "job-worktrees", `${jobId}.json`);
    const receipt = readFileSync(receiptPath);
    writeFileSync(join(workspace.repository, "tracked.txt"), "preserve this job's changes");
    const changed = { ...f.profile, analysis: { productionReadOnlyEvidence: [{
      id: "incident-records", kind: "cosmos", environment: "production", readOnly: true,
      workItemId: 42, correlationId: "incident-42", helper: ".github/fixlab/incident.mjs",
      revision: "a".repeat(64)
    }] } };
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify(changed));
    const recovered = prepareJobWorktree({ repository: f.source, jobId });
    assert.equal(recovered.profileSource, "saved-checkout");
    assert.equal(recovered.repository, workspace.repository);
    assert.equal(recovered.branch, workspace.branch);
    assert.ok(readFileSync(receiptPath).equals(receipt));
    assert.deepEqual(JSON.parse(readFileSync(join(workspace.repository, SETUP_PROFILE_PATH))), f.profile);
    assert.equal(readFileSync(join(workspace.repository, "tracked.txt"), "utf8"), "preserve this job's changes");
    assert.deepEqual(assignedJobWorktree({ repository: workspace.repository, jobId }), recovered);
    assert.throws(() => planWorktreeSetup({ source: f.source, repository: workspace.repository,
      preserveProfileRevision: "0".repeat(64) }), /saved worktree profile changed/);
    const setup = planWorktreeSetup({ source: f.source, repository: workspace.repository,
      preserveProfileRevision: workspace.profileRevision });
    assert.deepEqual(setup.profile, f.profile);
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ ...changed, changed: true }));
    assert.throws(() => applyWorktreeSetup(setup), /changed after planning/);
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify(changed));
    writeFileSync(join(workspace.repository, "frontend", "playwright.local.ts"), "preserve customized setup");
    assert.throws(() => prepareJobWorktree({ repository: f.source, jobId }), /merge it manually/);
    writeFileSync(join(workspace.repository, "frontend", "playwright.local.ts"), "export default {};");
    writeFileSync(join(workspace.repository, SETUP_PROFILE_PATH), JSON.stringify({ ...f.profile, changed: true }));
    assert.throws(() => prepareJobWorktree({ repository: f.source, jobId }), /configuration changed/);
    writeFileSync(join(workspace.repository, SETUP_PROFILE_PATH), JSON.stringify(f.profile));
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({
      ...changed, browserAutomation: { ...changed.browserAutomation, dataSafety: { productionAllowed: true } }
    }));
    assert.throws(() => prepareJobWorktree({ repository: f.source, jobId }), /configuration changed/);
    assert.ok(readFileSync(receiptPath).equals(receipt));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("owned checkout onboarding runs declared setup and reports a failed restore without claiming readiness", async () => {
  const f = fixture();
  try {
    const workspace = prepareJobWorktree({ repository: f.source, jobId: randomUUID() });
    const packageRoot = join(f.root, "helper");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    const cli = join(packageRoot, "bin", "fixlab.js");
    writeFileSync(cli, "if (process.argv[2] !== 'onboard' || !process.argv.includes('--from') || !process.argv.includes('--yes') || process.argv.includes('--authenticate')) process.exit(8); console.log('fixture restore');");
    const output = [];
    assert.equal((await restoreJobWorktree({ workspace, packageRoot, runtime: "copilot",
      onOutput: text => output.push(text) })).ready, true);
    assert.match(output.join(""), /fixture restore/);
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({
      ...f.profile, analysis: { productionReadOnlyEvidence: [] }
    }));
    const recovered = prepareJobWorktree({ repository: f.source, jobId: workspace.jobId });
    writeFileSync(cli, "if (process.argv.includes('--from') || !process.argv.includes('--yes')) process.exit(8); console.log('saved configuration restore');");
    assert.equal((await restoreJobWorktree({ workspace: recovered, packageRoot, runtime: "copilot",
      onOutput: text => output.push(text) })).ready, true);
    assert.match(output.join(""), /retaining.*verified.*configuration/);
    writeFileSync(cli, "process.exit(7);");
    const failed = await restoreJobWorktree({ workspace, packageRoot, runtime: "copilot" });
    assert.equal(failed.ready, false);
    assert.match(failed.message, /exited 7.*no check is claimed passed/);
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(restoreJobWorktree({ workspace, packageRoot, runtime: "copilot",
      signal: cancellation.signal }), { name: "AbortError" });
    writeFileSync(cli, "console.log('fixture running'); setInterval(() => {}, 1000);");
    const running = new AbortController();
    await assert.rejects(restoreJobWorktree({ workspace, packageRoot, runtime: "copilot",
      signal: running.signal, onOutput: text => { if (text.includes("fixture running")) { running.abort(); } }
    }), { name: "AbortError" });
    createExecutorLease(workspace.repository, "verified-setup-successor", { worktree: true })
      .acquire(workspace.jobId).release();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("automatic checkout recovery never borrows a different branch or invents job ownership", () => {
  const f = fixture();
  try {
    const jobId = randomUUID();
    const workspace = prepareJobWorktree({ repository: f.source, jobId });
    const changed = spawnSync("git", ["switch", "-c", "unrelated-work"], {
      cwd: workspace.repository, encoding: "utf8", windowsHide: true
    });
    assert.equal(changed.status, 0, changed.stderr);
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({
      ...f.profile, analysis: { productionReadOnlyEvidence: [] }
    }));
    assert.throws(() => prepareJobWorktree({ repository: f.source, jobId }), /owned worktree/);
    assert.throws(() => prepareJobWorktree({ repository: f.source, jobId: "../other" }), /valid job ID/);
    assert.equal(needsJobWorktree(f.source, { worktreeSetup: { mode: "isolated" } }, "fix-and-validate"), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("worktree setup is plan-first, explicit, idempotent and configuration-only", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, "frontend", "unrelated.txt"), "preserve");
    const plan = planWorktreeSetup(f);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    applyWorktreeSetup(plan);
    assert.deepEqual(JSON.parse(readFileSync(join(f.repository, SETUP_PROFILE_PATH))), f.profile);
    assert.equal(readFileSync(join(f.repository, "frontend", "playwright.local.ts"), "utf8"), "export default {};");
    assert.equal(existsSync(join(f.repository, "frontend", "unrelated.txt")), false);
    assert.deepEqual(browserConfigurationErrors(f.profile, f.repository), []);
    applyWorktreeSetup(planWorktreeSetup(f));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup preserves customized configuration and checks every file before writing", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repository, "frontend"));
    writeFileSync(join(f.repository, "frontend", "playwright.local.ts"), "customized");
    assert.throws(() => planWorktreeSetup(f), /merge it manually/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    assert.equal(readFileSync(join(f.repository, "frontend", "playwright.local.ts"), "utf8"), "customized");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup can replace only an unchanged generated template", () => {
  const f = fixture();
  try {
    const templatePath = join(f.root, "template.json");
    writeFileSync(templatePath, '{"example":true}');
    mkdirSync(join(f.repository, ".github", "fixlab"), { recursive: true });
    writeFileSync(join(f.repository, SETUP_PROFILE_PATH), '{"example":true}');
    applyWorktreeSetup(planWorktreeSetup({ ...f, templatePath }));
    assert.deepEqual(JSON.parse(readFileSync(join(f.repository, SETUP_PROFILE_PATH))), f.profile);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup refuses changed plans, unrelated repositories and sensitive paths", () => {
  const f = fixture();
  try {
    const plan = planWorktreeSetup(f);
    writeFileSync(join(f.source, "frontend", "playwright.local.ts"), "changed");
    assert.throws(() => applyWorktreeSetup(plan), /changed after planning/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    assert.throws(() => planWorktreeSetup({ ...f, repository: f.root }), /same Git repository/);
    for (const name of ["../outside.ts", "C:\\outside.ts", ".env", ".npmrc", "frontend/.auth/user.json", "frontend/.edge-profile/Default/Cookies", "frontend/node_modules/tool.js", "certificate.pem"]) {
      writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup: { files: [name] } }));
      assert.throws(() => planWorktreeSetup(f), /must not copy|repository-relative/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worktree setup and browser configuration refuse symlink escapes", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "config.ts"), "outside");
    symlinkSync(outside, join(f.source, "escape"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup: { files: ["escape/config.ts"] } }));
    assert.throws(() => planWorktreeSetup(f), /symbolic links/);
    assert.match(browserConfigurationErrors({
      browserAutomation: { workingDirectory: ".", testCommand: "playwright test --config=escape/config.ts" }
    }, f.source)[0], /symbolic links/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("browser configuration preflight names the missing prerequisite instead of skipping it", () => {
  const root = mkdtempSync(join(tmpdir(), "fixlab-browser-config-"));
  try {
    const profile = { browserAutomation: { workingDirectory: ".", testCommand: 'playwright test --config "missing config.ts"' } };
    assert.match(browserConfigurationErrors(profile, root)[0], /missing config.ts.*worktreeSetup.files/);
    assert.deepEqual(browserConfigurationErrors({ browserAutomation: { testCommand: "npm run test:e2e" } }, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree planning blocks omitted browser configuration and invalid file declarations", () => {
  const f = fixture();
  try {
    delete f.profile.worktreeSetup;
    writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify(f.profile));
    assert.throws(() => planWorktreeSetup(f), /configuration is missing.*worktreeSetup.files/);
    assert.equal(existsSync(join(f.repository, SETUP_PROFILE_PATH)), false);
    for (const worktreeSetup of [null, [], { files: null }, { files: "config.ts" }, { files: [1] }]) {
      writeFileSync(join(f.source, SETUP_PROFILE_PATH), JSON.stringify({ worktreeSetup }));
      assert.throws(() => planWorktreeSetup(f), /worktreeSetup/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
