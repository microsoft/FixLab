import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalExecutionRepository, createExecutorLease } from "./executor-lease.js";
import { spawnWindowsExecutor } from "./windows-executor.js";
import { applyWorktreeSetup, planWorktreeSetup, setupPath, SETUP_PROFILE_PATH } from "./repository-setup.js";

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

export function prepareJobWorktree({ repository, jobId, branchPrefix = "fixlab" }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(jobId)) {
    throw new Error("Automatic checkouts require a valid job ID.");
  }
  const source = realpathSync.native(repository);
  const common = canonicalExecutionRepository(source);
  const branch = `${branchPrefix}/fixlab-${jobId}`;
  git(source, ["check-ref-format", `refs/heads/${branch}`]);
  const workspaceParent = setupPath(dirname(dirname(common.repository)),
    `${basename(dirname(common.repository))}.fixlab-worktrees`);
  const target = setupPath(workspaceParent, jobId);
  const receiptPath = setupPath(common.repository, join("fixlab", "job-worktrees", `${jobId}.json`));
  const profileRevision = createHash("sha256")
    .update(readFileSync(setupPath(source, SETUP_PROFILE_PATH))).digest("hex");
  let receipt;
  if (existsSync(receiptPath)) {
    const info = lstatSync(receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) {
      throw new Error("The saved checkout ownership receipt is not a bounded regular file.");
    }
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.jobId !== jobId || receipt.branch !== branch || receipt.repository !== target ||
        receipt.source !== source || receipt.profileRevision !== profileRevision ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(receipt.baseCommit ?? "")) {
      throw new Error("Saved checkout ownership or configuration changed; existing work was preserved.");
    }
  } else {
    if (existsSync(target)) {
      throw new Error("The proposed checkout already exists without this job's ownership receipt; it will not be borrowed or overwritten.");
    }
    receipt = { jobId, source, repository: target, branch, profileRevision,
      baseCommit: git(source, ["rev-parse", "--verify", "HEAD^{commit}"]) };
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  }
  if (!existsSync(target)) {
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
  applyWorktreeSetup(planWorktreeSetup({ source, repository: target }));
  return receipt;
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

export async function restoreJobWorktree({ workspace, packageRoot, runtime, onOutput, signal }) {
  signal?.throwIfAborted();
  const lease = createExecutorLease(workspace.repository, `setup-${workspace.jobId}`, { worktree: true }).acquire(workspace.jobId);
  const args = [
    join(packageRoot, "bin", "fixlab.js"), "onboard", workspace.repository,
    "--from", workspace.source, "--runtime", runtime, "--yes"
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
