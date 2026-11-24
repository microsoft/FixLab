import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalExecutionRepository, createExecutorLease } from "./executor-lease.js";
import { spawnWindowsExecutor } from "./windows-executor.js";
import { applyWorktreeSetup, planWorktreeSetup, setupPath, SETUP_PROFILE_PATH } from "./repository-setup.js";
import { resolveEvidenceRoot, runStructuredCommand } from "../bin/structured-command.js";

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 30000,
    maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Automatic checkout preparation failed (${result.error?.code ?? `Git exit ${result.status}`}): ${result.stderr?.trim() || "Git prerequisite unavailable"}. Existing work was not reset or removed.`);
  }
  return result.stdout.trim();
}

function checkoutProfile(repository, name = SETUP_PROFILE_PATH) {
  const path = setupPath(repository, name);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("Checkout recovery requires a bounded regular repository profile or setup file.");
  }
  return readFileSync(path);
}

function executionProfile(content) {
  let profile;
  try { profile = JSON.parse(content.toString("utf8")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) { throw error; }
    throw new Error("Checkout recovery requires valid saved and current profile JSON.");
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
      (profile.analysis !== undefined &&
       (!profile.analysis || typeof profile.analysis !== "object" || Array.isArray(profile.analysis)))) {
    throw new Error("Checkout recovery requires profile and analysis objects.");
  }
  const execution = { ...profile };
  if (profile.analysis !== undefined) {
    execution.analysis = { ...profile.analysis };
    delete execution.analysis.productionReadOnlyEvidence;
    if (!Object.keys(execution.analysis).length) { delete execution.analysis; }
  }
  return execution;
}

export function needsJobWorktree(repository, profile, mode) {
  if (mode !== "fix-and-validate" || profile.worktreeSetup?.mode === "shared") { return false; }
  if (profile.worktreeSetup?.mode === "isolated") { return true; }
  const branch = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 10000
  });
  if (branch.error || ![0, 1, 128].includes(branch.status)) {
    throw new Error("Cannot determine whether this job needs an isolated checkout.");
  }
  return branch.status === 1;
}

export function prepareJobWorktree({ repository, jobId, branchPrefix = "fixlab", baseCommit }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(jobId)) {
    throw new Error("Automatic checkouts require a valid job ID.");
  }
  if (baseCommit !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)) {
    throw new Error("Automatic checkout baseCommit must be an exact Git commit.");
  }
  const source = realpathSync.native(repository);
  const common = canonicalExecutionRepository(source);
  const branch = `${branchPrefix}/fixlab-${jobId}`;
  git(source, ["check-ref-format", `refs/heads/${branch}`]);
  const workspaceParent = setupPath(dirname(dirname(common.repository)),
    `${basename(dirname(common.repository))}.fixlab-worktrees`);
  const target = setupPath(workspaceParent, jobId);
  const receiptPath = setupPath(common.repository, join("fixlab", "job-worktrees", `${jobId}.json`));
  const sourceProfile = checkoutProfile(source);
  const profileRevision = createHash("sha256").update(sourceProfile).digest("hex");
  let receipt;
  if (existsSync(receiptPath)) {
    const info = lstatSync(receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) {
      throw new Error("The saved checkout ownership receipt is not a bounded regular file.");
    }
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.jobId !== jobId || receipt.branch !== branch || receipt.repository !== target ||
        receipt.source !== source || !/^[a-f0-9]{64}$/u.test(receipt.profileRevision ?? "") ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(receipt.baseCommit ?? "")) {
      throw new Error("Saved checkout ownership or configuration changed; existing work was preserved.");
    }
    if (baseCommit !== undefined && receipt.baseCommit !== baseCommit) {
      throw new Error("The saved investigation commit changed; its pinned checkout was preserved.");
    }
  } else {
    if (existsSync(target)) {
      throw new Error("The proposed checkout already exists without this job's ownership receipt; it will not be borrowed or overwritten.");
    }
    receipt = { jobId, source, repository: target, branch, profileRevision,
      baseCommit: git(source, ["rev-parse", "--verify", "--end-of-options", `${baseCommit ?? "HEAD"}^{commit}`]) };
    if (baseCommit !== undefined && receipt.baseCommit !== baseCommit) {
      throw new Error("Automatic checkout baseCommit must identify a commit, not another Git object.");
    }
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  }
  if (!existsSync(target)) {
    if (receipt.profileRevision !== profileRevision) {
      throw new Error("Saved checkout ownership or configuration changed; existing work was preserved.");
    }
    mkdirSync(workspaceParent, { recursive: true, mode: 0o700 });
    git(source, ["worktree", "add", "--no-track", "-b", branch, target, receipt.baseCommit]);
  }
  if (realpathSync.native(target) !== resolve(target) ||
      canonicalExecutionRepository(target).key !== common.key ||
      git(target, ["branch", "--show-current"]) !== branch ||
      realpathSync.native(git(target, ["rev-parse", "--show-toplevel"])) !== realpathSync.native(target)) {
    throw new Error("The saved checkout no longer matches this job's owned worktree.");
  }
  git(target, ["merge-base", "--is-ancestor", receipt.baseCommit, "HEAD"]);
  const useSavedProfile = receipt.profileRevision !== profileRevision;
  if (useSavedProfile) {
    const savedProfile = checkoutProfile(target);
    if (createHash("sha256").update(savedProfile).digest("hex") !== receipt.profileRevision ||
        !isDeepStrictEqual(executionProfile(savedProfile), executionProfile(sourceProfile))) {
      throw new Error("Saved checkout ownership or configuration changed; existing work was preserved.");
    }
  }
  const setup = planWorktreeSetup({ source, repository: target,
    preserveProfileRevision: useSavedProfile ? receipt.profileRevision : undefined });
  if (useSavedProfile && !setup.sourceProfile?.equals(sourceProfile)) {
    throw new Error("The source profile changed during checkout recovery; review it before retrying.");
  }
  applyWorktreeSetup(setup);
  return useSavedProfile ? { ...receipt, profileSource: "saved-checkout" } : receipt;
}

export function assignedJobWorktree({ repository, jobId, branchPrefix = "fixlab" }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(jobId)) {
    throw new Error("Checkout recovery requires a valid job ID.");
  }
  const root = realpathSync.native(repository);
  const common = canonicalExecutionRepository(root);
  const path = setupPath(common.repository, join("fixlab", "job-worktrees", `${jobId}.json`));
  if (!existsSync(path)) { return null; }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) {
    throw new Error("Checkout recovery requires a bounded regular ownership receipt.");
  }
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.repository !== root) { return null; }
  if (typeof receipt.source !== "string" ||
      canonicalExecutionRepository(receipt.source).key !== common.key) {
    throw new Error("The recovered checkout source is outside this repository.");
  }
  return prepareJobWorktree({ repository: receipt.source, jobId, branchPrefix });
}

function protectedSnapshotRevision(repository, steps) {
  const roots = steps.map(step => ({ ...step, directory: setupPath(repository, step.workingDirectory) }));
  const dependencyOutput = (path, name) => roots.some(root => {
    const suffix = relative(root.directory, path);
    return suffix && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) &&
      (name === "node_modules" || (name === "obj" && root.application === "backend"));
  });
  const revision = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let entries = 0;
  let bytes = 0;
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (directory === repository && entry.name === ".git") { continue; }
      const path = join(directory, entry.name);
      if (entry.isDirectory() && dependencyOutput(path, entry.name)) { continue; }
      if (++entries > 100000) { throw new Error("Dependency preparation exceeded the protected snapshot inventory limit."); }
      if (entry.isDirectory()) { visit(path); continue; }
      if (entry.isSymbolicLink()) {
        revision.update(JSON.stringify([relative(repository, path), "link", readlinkSync(path)]));
        continue;
      }
      if (!entry.isFile()) { throw new Error("Dependency preparation requires regular protected snapshot files or links."); }
      const info = lstatSync(path);
      if (!info.isFile()) { throw new Error("A protected snapshot file changed during dependency preparation inventory."); }
      if ((bytes += info.size) > 512 * 1024 * 1024) {
        throw new Error("Dependency preparation exceeded the protected snapshot content limit.");
      }
      revision.update(JSON.stringify([relative(repository, path), "file", info.size]));
      const file = openSync(path, "r");
      try {
        const opened = fstatSync(file);
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
          throw new Error("A protected snapshot file changed during dependency preparation inventory.");
        }
        let length;
        while ((length = readSync(file, buffer, 0, buffer.length, null)) > 0) {
          revision.update(buffer.subarray(0, length));
        }
      } finally { closeSync(file); }
    }
  };
  visit(repository);
  return revision.digest("hex");
}

async function restoreDependencies({ workspace, packageRoot, signal, approvedProfile, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483000) {
    throw new Error("Dependency preparation requires a positive bounded timeout.");
  }
  const content = checkoutProfile(workspace.repository);
  if (createHash("sha256").update(content).digest("hex") !== workspace.profileRevision) {
    throw new Error("Dependency preparation requires this checkout's reviewed profile revision.");
  }
  const profile = JSON.parse(content);
  if (approvedProfile !== undefined && !isDeepStrictEqual(profile, approvedProfile)) {
    throw new Error("The dependency preparation profile changed since watcher approval; review it and restart the watcher.");
  }
  const commands = profile.validation?.commands ?? {};
  const steps = [];
  for (const application of ["frontend", "backend", "browser"]) {
    if (typeof commands[`${application}Restore`] !== "string" || !commands[`${application}Restore`].trim()) { continue; }
    const workingDirectory = application === "browser"
      ? profile.browserAutomation?.workingDirectory ?? profile.applications?.frontend?.workingDirectory ?? "."
      : profile.applications?.[application]?.workingDirectory ?? ".";
    setupPath(workspace.repository, workingDirectory);
    steps.push({ application, workingDirectory });
  }
  if (!steps.length) {
    return { ready: false, message: "No dependency restore commands are configured; dependent checks require reviewed setup. Continue independent source analysis; no test is claimed passed." };
  }
  const revisions = new Map((profile.worktreeSetup?.files ?? [])
    .map(name => [name, createHash("sha256").update(checkoutProfile(workspace.repository, name)).digest("hex")]));
  const originalDiff = git(workspace.repository, ["diff", "HEAD", "--"]);
  const originalHead = git(workspace.repository, ["rev-parse", "HEAD"]);
  const originalSource = protectedSnapshotRevision(workspace.repository, steps);
  const lease = createExecutorLease(workspace.repository, `setup-${workspace.jobId}`, { worktree: true }).acquire(workspace.jobId);
  const outcomes = [];
  const diagnostics = new Set();
  const commandTimeoutSeconds = Math.ceil(timeoutMs / steps.length / 1000);
  let quiescent = true;
  try {
    for (const step of steps) {
      signal?.throwIfAborted();
      const directory = setupPath(workspace.repository, step.workingDirectory);
      let info;
      try { info = lstatSync(directory); }
      catch (error) {
        if (error.code !== "ENOENT") { throw error; }
        outcomes.push({ ready: false, message: `${step.application} restore directory is missing inside the owned checkout` });
        continue;
      }
      if (!info.isDirectory()) {
        outcomes.push({ ready: false, message: `${step.application} restore directory is not a directory` });
        continue;
      }
      const evidenceRoot = resolveEvidenceRoot(workspace.repository);
      const gitDirectory = realpathSync.native(resolve(evidenceRoot, "..", ".."));
      setupPath(gitDirectory, join("fixlab", "command-evidence"));
      let result;
      const code = await runStructuredCommand([
        "--stage", `watcher-${step.application}-restore`, "--timeout-seconds", String(commandTimeoutSeconds),
        "--", process.execPath, join(packageRoot, "bin", "fixlab.js"), "prepare", workspace.repository,
        "--yes", `--application=${step.application}`
      ], workspace.repository, {
        signal, stdout: { write() {} }, stderr: { write() {} },
        onSpawn() { quiescent = false; },
        onResult(value) { result = value; quiescent = value.terminationVerified; }
      });
      if (!quiescent) {
        throw new Error("Dependency preparation termination is unverified; its setup ownership was retained.");
      }
      signal?.throwIfAborted();
      if (createHash("sha256").update(checkoutProfile(workspace.repository)).digest("hex") !== workspace.profileRevision ||
          [...revisions].some(([name, revision]) =>
            createHash("sha256").update(checkoutProfile(workspace.repository, name)).digest("hex") !== revision)) {
        throw new Error("Dependency preparation changed the reviewed profile or reviewed setup files; changes were preserved and read-only review was not started.");
      }
      if (originalHead !== git(workspace.repository, ["rev-parse", "HEAD"]) ||
          originalDiff !== git(workspace.repository, ["diff", "HEAD", "--"])) {
        throw new Error("Dependency preparation changed tracked snapshot files; changes were preserved and read-only review was not started.");
      }
      if (originalSource !== protectedSnapshotRevision(workspace.repository, steps)) {
        throw new Error("Dependency preparation changed protected snapshot files outside permitted dependency outputs; changes were preserved and read-only review was not started.");
      }
      const output = [...result.stdout.tail, ...result.stderr.tail].join("\n");
      for (const diagnostic of output.match(/\b(?:NETSDK\d{4}|NU\d{4}|MSB\d{4}|E401|E403|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)\b/gu) ?? []) {
        if (diagnostics.size < 5) { diagnostics.add(diagnostic); }
      }
      outcomes.push({ ready: code === 0, message: `${step.application} restore ${
        code === 0 ? "completed" : code === 124 ? "timed out" : `failed (exited ${code})`}` });
    }
  } catch (error) {
    if (error.ownedExecutorRunning) { quiescent = false; }
    if (!quiescent) { error.ownedExecutorRunning = true; }
    throw error;
  } finally {
    if (quiescent) { lease.release(); }
  }
  const ready = outcomes.every(outcome => outcome.ready);
  return { ready, message: ready
    ? "Owned checkout configured dependency restores completed; no application, browser or authentication was started. Tests have not yet run."
    : `${outcomes.map(outcome => outcome.message).join("; ")}.${diagnostics.size ? ` Diagnostic codes: ${[...diagnostics].join(", ")}.` : ""} Continue independent code work and run only checks whose prerequisites are available; no check is claimed passed.` };
}

export async function restoreJobWorktree({
  workspace, packageRoot, runtime, onOutput, signal, dependenciesOnly = false, approvedProfile, timeoutMs = 10 * 60 * 1000
}) {
  signal?.throwIfAborted();
  if (dependenciesOnly) { return restoreDependencies({ workspace, packageRoot, signal, approvedProfile, timeoutMs }); }
  const useSavedProfile = workspace.profileSource === "saved-checkout";
  if (useSavedProfile) {
    onOutput?.("Source profile formatting or watcher-only diagnostics changed; retaining this job's verified saved configuration. No new diagnostic access was granted.\n");
  }
  const lease = createExecutorLease(workspace.repository, `setup-${workspace.jobId}`, { worktree: true }).acquire(workspace.jobId);
  const args = [
    join(packageRoot, "bin", "fixlab.js"), "onboard", workspace.repository,
    ...(useSavedProfile ? [] : ["--from", workspace.source]), "--runtime", runtime, "--yes"
  ];
  let containment;
  let child;
  try {
    containment = process.platform === "win32" ? spawnWindowsExecutor({
      executable: process.execPath, args, repository: workspace.repository
    }) : null;
    child = containment?.child ?? spawn(process.execPath, args, {
      cwd: workspace.repository, detached: true, stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    lease.release();
    throw error;
  }
  child.stdin?.end();
  const cancel = () => {
    if (containment) { containment.terminate(); }
    else if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") { throw error; } }
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => {
      if (bytes < 8192) { onOutput?.(chunk.toString("utf8").slice(0, 8192 - bytes)); }
      bytes += chunk.length;
    });
  }
  try {
    const code = await new Promise((resolveSetup, reject) => {
      child.once("error", reject);
      child.once("close", resolveSetup);
      if (signal?.aborted) { cancel(); }
    });
    if (containment) { await containment.waitForStopped(); }
    else if (child.pid) {
      try { process.kill(-child.pid, 0); throw new Error("Checkout setup descendants remain active; ownership was retained."); }
      catch (error) { if (error.code !== "ESRCH") { throw error; } }
    }
    lease.release();
    signal?.throwIfAborted();
    return { ready: code === 0, message: code === 0
        ? "Owned checkout onboarding and configured restores completed; authentication was not copied or started."
        : `Checkout onboarding exited ${code ?? "without a code"}. Continue independent code work and repair the reported setup prerequisite before its dependent validation; no check is claimed passed.` };
  } catch (error) {
    if (!child.pid) { lease.release(); }
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}
