import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { repositoryState } from "../bin/structured-command.js";
import { createRuntimePermissionPolicy } from "./runtime-permission-policy.js";
import { safeRuntimeText } from "./runtime-requests.js";
import { setupPath, SETUP_PROFILE_PATH } from "./repository-setup.js";

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function sharedProfileFile(repository) {
  const path = setupPath(repository, SETUP_PROFILE_PATH);
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error("Shared setup requires a regular repository profile no larger than 1 MiB");
  }
  const previous = readFileSync(path);
  const profile = JSON.parse(previous.toString("utf8"));
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Shared setup requires an existing repository profile object");
  }
  return { path, previous, profile };
}

function requireIgnoredCommitProfile(repository) {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", SETUP_PROFILE_PATH], {
    cwd: repository, windowsHide: true, timeout: 10000
  });
  if (ignored.status !== 0 || ignored.error) {
    throw new Error("Automatic commit binding requires a Git-ignored local repository profile; keep the reusable template separately. Tracked profiles are never rewritten.");
  }
}

export function planSharedSetup(repository) {
  const file = sharedProfileFile(repository);
  const profile = structuredClone(file.profile);
  profile.worktreeSetup = { ...profile.worktreeSetup, mode: "shared" };
  const head = git(repository, ["rev-parse", "--verify", "HEAD"], "Shared setup commit verification");
  if (profile.validation?.expectedCommit !== undefined) {
    if (!commitPattern.test(profile.validation.expectedCommit)) {
      throw new Error("validation.expectedCommit must be a full Git commit before reusing setup");
    }
    requireIgnoredCommitProfile(repository);
    profile.worktreeSetup.bindExpectedCommit = true;
    profile.validation.expectedCommit = head;
  }
  const configuration = sharedWorktreeConfig(profile, repository);
  return { ...file, repository, profile, configuration, head };
}

export function applySharedSetup(plan) {
  const current = sharedProfileFile(plan.repository);
  if (!current.previous.equals(plan.previous) ||
      git(plan.repository, ["rev-parse", "--verify", "HEAD"], "Shared setup commit verification") !== plan.head) {
    throw new Error("The shared setup or checkout changed after planning; review a new plan");
  }
  sharedWorktreeConfig(plan.profile, plan.repository);
  if (plan.profile.worktreeSetup.bindExpectedCommit) {requireIgnoredCommitProfile(plan.repository);}
  writeFileSync(current.path, `${JSON.stringify(plan.profile, null, 2)}\n`);
}

function refreshSharedCommit(repository, profile) {
  if (!profile.worktreeSetup.bindExpectedCommit) {return;}
  requireIgnoredCommitProfile(repository);
  const current = sharedProfileFile(repository);
  if (JSON.stringify(current.profile) !== JSON.stringify(profile)) {
    throw new Error("Shared configuration changed during branch acquisition; review it before continuing");
  }
  const head = git(repository, ["rev-parse", "--verify", "HEAD"], "Shared commit binding");
  if (current.profile.validation.expectedCommit !== head) {
    current.profile.validation.expectedCommit = head;
    writeFileSync(current.path, `${JSON.stringify(current.profile, null, 2)}\n`);
  }
}

function verifyIdleGit(repository) {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const value = git(repository, ["rev-parse", "--git-path", name], "Git operation verification");
    if (existsSync(isAbsolute(value) ? value : resolve(repository, value))) {
      throw new Error("Finish the in-progress Git operation before reusing the shared worktree");
    }
  }
}

function git(repository, args, description, raw = false) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${description} failed (${result.error?.code ?? `Git exit ${result.status}`}). ` +
      "Resolve the Git prerequisite and retry; no reset, cleanup, force-switch or automatic stash restoration will be attempted."
    );
  }
  return raw ? result.stdout : result.stdout.trim();
}

function branchRef(repository, branch, description) {
  if (typeof branch !== "string" || !branch || branch.startsWith("-")) {
    throw new Error(`${description} must be a valid Git branch name`);
  }
  git(repository, ["check-ref-format", `refs/heads/${branch}`], description);
  return branch;
}

export function sharedWorktreeConfig(profile, repository) {
  const mode = profile.worktreeSetup?.mode;
  if (mode === undefined || mode === "isolated") {
    return null;
  }
  if (mode !== "shared") {
    throw new Error("worktreeSetup.mode must be shared or isolated");
  }
  const root = realpathSync.native(repository);
  const topLevel = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"], "Shared worktree repository verification"));
  if (root !== topLevel) {
    throw new Error("Shared worktree mode requires the Git checkout root");
  }
  const remote = profile.worktreeSetup.remote ?? "origin";
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) {
    throw new Error("worktreeSetup.remote must be a Git remote name");
  }
  const baseBranch = branchRef(
    root,
    profile.worktreeSetup.baseBranch ?? profile.pullRequests?.defaultTargetBranch,
    "worktreeSetup.baseBranch"
  );
  const naming = profile.pullRequests?.branchNaming;
  if (
    typeof naming?.userId !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(naming.userId) ||
    typeof naming.prefixTemplate !== "string" ||
    !naming.prefixTemplate.includes("{userId}")
  ) {
    throw new Error("Shared worktree mode requires pullRequests.branchNaming.userId and prefixTemplate");
  }
  const prefix = branchRef(root, naming.prefixTemplate.replaceAll("{userId}", naming.userId), "Shared branch prefix");
  if (profile.worktreeSetup.autoStash !== undefined && typeof profile.worktreeSetup.autoStash !== "boolean") {
    throw new Error("worktreeSetup.autoStash must be a boolean");
  }
  if (profile.worktreeSetup.bindExpectedCommit !== undefined &&
      typeof profile.worktreeSetup.bindExpectedCommit !== "boolean") {
    throw new Error("worktreeSetup.bindExpectedCommit must be a boolean");
  }
  if (profile.worktreeSetup.bindExpectedCommit) {
    if (!commitPattern.test(profile.validation?.expectedCommit ?? "")) {
      throw new Error("Commit-bound shared setup requires validation.expectedCommit");
    }
    requireIgnoredCommitProfile(root);
  }
  return { remote, baseBranch, prefix, autoStash: profile.worktreeSetup.autoStash === true };
}

export function reviewSharedWorktree(repository, profile, { autoStash = false } = {}) {
  const config = sharedWorktreeConfig(profile, repository);
  if (!config) {
    return null;
  }
  const branch = git(repository, ["branch", "--show-current"], "Workspace review");
  const prefix = `${config.prefix}/fixlab-`;
  const owner = branch.startsWith(prefix) ? branch.slice(prefix.length) : "";
  if (!jobIdPattern.test(owner) && !autoStash) {
    return null;
  }
  if (!branch) { throw new Error("Automatic stashing requires a named current branch."); }
  const state = repositoryState(repository);
  const untracked = git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], "Untracked file review", true)
    .split("\0").filter(Boolean);
  const tracked = autoStash
    ? git(repository, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], "Tracked file review", true).split("\0").filter(Boolean)
    : [];
  const files = [...new Set([...tracked, ...untracked])];
  const policy = createRuntimePermissionPolicy(repository);
  let reason = !autoStash && git(repository, ["status", "--porcelain", "--untracked-files=no"], "Tracked change review")
    ? "Preserve tracked changes separately before starting a fresh branch."
    : files.length > 50 ? "Too many changed files for automatic recovery; review them separately." : "";
  if (!reason && files.some((file) => {
    const path = resolve(repository, file);
    return !policy.isSourceFile(path) ||
      (existsSync(path) && lstatSync(path).size > 1024 * 1024);
  })) {
    reason = "Changed files include sensitive, linked, non-source or oversized files; preserve them separately.";
  }
  return {
    branch,
    head: state.head,
    dirty: Boolean(git(repository, ["status", "--porcelain", "--untracked-files=all"], "Workspace review")),
    fingerprint: createHash("sha256").update(JSON.stringify({ branch, config, state })).digest("hex"),
    freshBranch: {
      remote: config.remote, baseBranch: config.baseBranch,
      files: files.slice(0, 50), trackedFiles: tracked, available: !reason, reason
    }
  };
}

export function stashReviewedSharedWorktree({ repository, profile, reviewedWorkspace, autoStash = false, onStash = null }) {
  verifyIdleGit(repository);
  const review = reviewSharedWorktree(repository, profile, { autoStash });
  if (!review || review.branch !== reviewedWorkspace?.branch ||
      review.fingerprint !== reviewedWorkspace?.fingerprint) {
    throw new Error("The workspace changed since review. Review the branch and files again.");
  }
  if (!review.freshBranch.available) {
    throw new Error(review.freshBranch.reason);
  }
  const { files, remote, baseBranch } = review.freshBranch;
  const tracked = new Set(review.freshBranch.trackedFiles);
  const snapshots = new Map();
  for (const file of files) {
    const path = resolve(repository, file);
    if (existsSync(path) && !safeRuntimeText(readFileSync(path, "utf8"), 1024 * 1024)) {
      throw new Error("A reviewed source file may contain sensitive content; automatic stashing is unavailable.");
    }
    const entries = git(repository, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file], "Staged file review", true)
      .split("\0").filter(Boolean);
    let index = "";
    for (const entry of entries) {
      const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t/u.exec(entry);
      if (!match || !safeRuntimeText(git(repository, ["cat-file", "blob", match[2]], "Staged source review", true), 1024 * 1024)) {
        throw new Error("Staged files include unresolved, linked, oversized or sensitive content; preserve them separately.");
      }
      index = match[2];
    }
    snapshots.set(file, {
      index,
      working: existsSync(path) ? git(repository, ["hash-object", `--path=${file}`, "--", file], "Source preservation fingerprint") : ""
    });
  }
  let stashRef = null;
  if (files.length) {
    const previous = git(repository, ["stash", "list", "--max-count=1", "--format=%H"], "Existing stash review");
    git(repository, ["--literal-pathspecs", "stash", "push", "--include-untracked",
      "--message", `FixLab fresh branch from ${review.branch}`, "--", ...files], "Stash reviewed source files");
    stashRef = git(repository, ["stash", "list", "--max-count=1", "--format=%H"], "Saved stash verification");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(stashRef) || stashRef === previous) {
      throw new Error("A new stash could not be verified. Stop and inspect the checkout; no reset or cleanup will be attempted.");
    }
    onStash?.({ stashRef, files, previousBranch: review.branch, remote, baseBranch });
    for (const file of files) {
      const snapshot = snapshots.get(file);
      for (const [tree, expected] of [
        [tracked.has(file) ? stashRef : `${stashRef}^3`, snapshot.working],
        [`${stashRef}^2`, snapshot.index]
      ]) {
        const entry = git(repository, ["--literal-pathspecs", "ls-tree", "-z", tree, "--", file], "Stashed file verification", true);
        const actual = /^[0-7]{6} blob ([0-9a-f]{40,64})\t/u.exec(entry)?.[1] ?? "";
        if (actual !== expected) {
          throw new Error(`Stash preservation could not be verified. Preserved stash: ${stashRef}. No branch change or automatic restore was attempted.`);
        }
      }
    }
  }
  const remaining = git(repository, ["status", "--porcelain", "--untracked-files=all"], "Clean checkout verification");
  if (remaining) {
    const summary = safeRuntimeText(remaining, 8000) ? remaining : "Review local Git status for the remaining changes.";
    throw new Error(`The checkout is not clean. Preserved stash: ${stashRef ?? "none"}. No reset or cleanup will be attempted.\n${summary}`);
  }
  return { stashRef, files, previousBranch: review.branch, remote, baseBranch };
}

function recoveryRequired(repository, profile, message) {
  const error = new Error(message);
  error.workspaceReview = reviewSharedWorktree(repository, profile);
  return error;
}

export function prepareSharedWorktree({ repository, profile, jobId, saved = null, resume = false, resourcesRunning = false, reviewedWorkspace = null, onStash = null }) {
  const config = sharedWorktreeConfig(profile, repository);
  if (!config) {
    if (saved) {
      throw new Error("This job owns a shared worktree branch; restore shared mode before resuming it");
    }
    return null;
  }
  if (!jobIdPattern.test(jobId)) {
    throw new Error("Shared worktree jobs require a valid job ID");
  }
  verifyIdleGit(repository);
  const currentBranch = git(repository, ["branch", "--show-current"], "Current branch verification");
  const dirty = git(repository, ["status", "--porcelain", "--untracked-files=all"], "Shared worktree cleanliness check");
  if (reviewedWorkspace) {
    const current = reviewSharedWorktree(repository, profile);
    if (!current || current.branch !== reviewedWorkspace.branch ||
        current.fingerprint !== reviewedWorkspace.fingerprint) {
      throw recoveryRequired(repository, profile, "The workspace changed since review. Review the current branch and diff again before approving reuse.");
    }
    if (saved && saved.branch !== current.branch) {
      throw new Error("Reviewed reuse cannot replace this job's assigned branch.");
    }
    const baseCommit = git(repository, [
      "merge-base", "HEAD", `refs/remotes/${config.remote}/${config.baseBranch}`
    ], "Existing branch base verification");
    refreshSharedCommit(repository, profile);
    return {
      mode: "shared", branch: current.branch, baseCommit,
      remote: config.remote, baseBranch: config.baseBranch,
      reusedFromJobId: current.branch.slice(`${config.prefix}/fixlab-`.length)
    };
  }
  if (saved) {
    const branch = branchRef(repository, saved.branch, "Saved job branch");
    if (
      saved.mode !== "shared" ||
      !(saved.reusedFromJobId
        ? jobIdPattern.test(saved.reusedFromJobId) && branch === `${config.prefix}/fixlab-${saved.reusedFromJobId}`
        : branch.endsWith(`/fixlab-${jobId}`)) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(saved.baseCommit) ||
      typeof saved.remote !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(saved.remote)
    ) {
      throw new Error("Saved shared-worktree ownership is invalid; refusing to select a different branch");
    }
    branchRef(repository, saved.baseBranch, "Saved base branch");
    git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], "Saved branch verification");
    git(repository, ["merge-base", "--is-ancestor", saved.baseCommit, `refs/heads/${branch}`], "Saved branch ancestry verification");
    if (currentBranch !== branch) {
      if (resourcesRunning) {
        throw new Error("Stop the shared checkout's owned React and authentication sessions before reacquiring a different job branch");
      }
      if (dirty) {
        throw new Error("The shared worktree has uncommitted or untracked files; preserve them before reacquiring this job's branch");
      }
      git(repository, ["switch", "--no-guess", "--no-overwrite-ignore", branch], "Saved branch reacquisition");
    }
    refreshSharedCommit(repository, profile);
    return saved;
  }
  if (resume) {
    throw recoveryRequired(repository, profile, "This older job has no saved shared-worktree branch. Resume it with its original workspace policy or explicitly review and reuse the current job branch; do not guess its branch");
  }
  if (resourcesRunning) {
    throw recoveryRequired(repository, profile, "Stop the shared checkout's owned React and authentication sessions before starting another job branch, or explicitly review reuse of the current branch");
  }
  let workspaceStash = null;
  if (dirty && config.autoStash) {
    workspaceStash = stashReviewedSharedWorktree({
      repository, profile, autoStash: true, onStash,
      reviewedWorkspace: reviewSharedWorktree(repository, profile, { autoStash: true })
    });
  } else if (dirty) {
    throw recoveryRequired(repository, profile, "The shared worktree has uncommitted or untracked files; preserve them before starting another job, or explicitly review reuse of the current branch");
  }
  const branch = branchRef(repository, `${config.prefix}/fixlab-${jobId}`, "New job branch");
  git(repository, [
    "fetch", "--no-tags", config.remote,
    `+refs/heads/${config.baseBranch}:refs/remotes/${config.remote}/${config.baseBranch}`
  ], "Shared worktree base refresh");
  const baseCommit = git(repository, [
    "rev-parse", "--verify", `refs/remotes/${config.remote}/${config.baseBranch}^{commit}`
  ], "Fetched base verification");
  git(repository, ["switch", "--no-guess", "--no-overwrite-ignore", "-c", branch, baseCommit], "New job branch creation");
  refreshSharedCommit(repository, profile);
  return { mode: "shared", branch, baseCommit, remote: config.remote, baseBranch: config.baseBranch,
    ...(workspaceStash ? { workspaceStash } : {}) };
}

export function verifySharedWorktreeBranch(repository, workspace) {
  if (workspace && git(repository, ["branch", "--show-current"], "Completed job branch verification") !== workspace.branch) {
    throw new Error("The agent changed the shared checkout's assigned branch. Reconcile the saved job branch before resuming; its result cannot be accepted");
  }
}

export function sharedWorktreeGuidance(workspace) {
  if (!workspace) {
    return "";
  }
  return `\nShared worktree contract:
- The dashboard has exclusively acquired this checkout on branch ${workspace.branch}, based on ${workspace.remote}/${workspace.baseBranch} at ${workspace.baseCommit}.
- Work in this checkout and on this exact branch. Do not create another worktree, switch branches, reset, stash, clean, or merge/rebase the base branch.
- Reuse this job's existing PR on resume. Another job can use the same folder only after owned execution stops and the checkout is clean.
- When this branch was explicitly reused, continue its existing PR for this branch; do not create a duplicate PR or discard reviewed uncommitted changes.
- Check dependency and configuration readiness for the selected branch; cached dependencies are not proof that changed manifests were restored.
- Recheck frontend health and authenticated access after reacquisition. Browser/session state and build outputs are not evidence that a previous branch is still loaded.`;
}
