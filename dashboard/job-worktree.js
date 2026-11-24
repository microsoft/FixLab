import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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

function checkoutProfile(repository) {
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("Checkout recovery requires a bounded regular repository profile.");
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

export async function restoreJobWorktree({
  workspace, packageRoot, runtime, onOutput, signal, dependenciesOnly = false, approvedProfile, timeoutMs = 10 * 60 * 1000
}) {
  signal?.throwIfAborted();
  let originalDiff;
  let originalHead;
  if (dependenciesOnly) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
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
    for (const application of ["frontend", "backend", "browser"]) {
      if (typeof commands[`${application}Restore`] !== "string" || !commands[`${application}Restore`].trim()) { continue; }
      const directory = setupPath(workspace.repository, application === "browser"
        ? profile.browserAutomation?.workingDirectory ?? profile.applications?.frontend?.workingDirectory ?? "."
        : profile.applications?.[application]?.workingDirectory ?? ".");
      if (!lstatSync(directory).isDirectory()) {
        throw new Error("Dependency preparation requires existing directories inside the owned checkout.");
      }
    }
    originalDiff = git(workspace.repository, ["diff", "HEAD", "--"]);
    originalHead = git(workspace.repository, ["rev-parse", "HEAD"]);
  }
  const useSavedProfile = workspace.profileSource === "saved-checkout";
  if (useSavedProfile) {
    onOutput?.("Source profile formatting or watcher-only diagnostics changed; retaining this job's verified saved configuration. No new diagnostic access was granted.\n");
  }
  const lease = createExecutorLease(workspace.repository, `setup-${workspace.jobId}`, { worktree: true }).acquire(workspace.jobId);
  const args = dependenciesOnly
    ? [join(packageRoot, "bin", "fixlab.js"), "prepare", workspace.repository, "--yes"]
    : [
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
  let timedOut = false;
  const timeout = dependenciesOnly ? setTimeout(() => { timedOut = true; cancel(); }, timeoutMs) : undefined;
  timeout?.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  const diagnostics = new Set();
  let failedRestore;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => {
      if (dependenciesOnly) {
        const text = chunk.toString("utf8");
        for (const code of text.match(/\b(?:NETSDK\d{4}|NU\d{4}|MSB\d{4}|E401|E403|ENOTFOUND|ECONNREFUSED|ETIMEDOUT)\b/gu) ?? []) {
          if (diagnostics.size < 5) { diagnostics.add(code); }
        }
        failedRestore ??= /(?:^|\n)(frontend|backend|browser) restore failed:/u.exec(text)?.[1];
      }
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
    if (dependenciesOnly && (originalHead !== git(workspace.repository, ["rev-parse", "HEAD"]) ||
        originalDiff !== git(workspace.repository, ["diff", "HEAD", "--"]))) {
      throw new Error("Dependency preparation changed tracked snapshot files; changes were preserved and read-only review was not started.");
    }
    const prerequisite = `${failedRestore ? ` ${failedRestore} restore failed.` : ""}${diagnostics.size ? ` Diagnostic codes: ${[...diagnostics].join(", ")}.` : ""}`;
    const ready = code === 0 && !timedOut;
    return { ready, message: ready
        ? dependenciesOnly
          ? "Owned checkout configured dependency restores completed; no application, browser or authentication was started. Tests have not yet run."
          : "Owned checkout onboarding and configured restores completed; authentication was not copied or started."
        : `Checkout ${dependenciesOnly ? "dependency preparation" : "onboarding"} ${timedOut ? "timed out" : `exited ${code ?? "without a code"}`}.${prerequisite} Continue independent code work and repair the reported setup prerequisite before its dependent validation; no check is claimed passed.` };
  } catch (error) {
    if (!child.pid) { lease.release(); }
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
}
