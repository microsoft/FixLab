import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalExecutionRepository } from "./executor-lease.js";

export const SETUP_PROFILE_PATH = join(".github", "fixlab", "repository-profile.json");
export const REPOSITORY_PROMPT_NAMES = ["bugfix", "intake", "diagnose", "reproduce", "fix", "validate", "live-test", "pr", "summary"]
  .map((name) => `fixlab.${name}.prompt.md`);

export function buildQuerySetupPrompt({ environment, approved = false }) {
  if (typeof environment !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(environment) ||
      /(?:^|[._-])(?:prod|prd|production)(?:[._-]|$)/u.test(environment) ||
      typeof approved !== "boolean") {
    throw new Error("Query setup requires an explicitly selected non-production environment and boolean approval.");
  }
  return [
    `FixLab query setup ${approved ? "APPLY" : "PLAN"} for the selected ${environment} environment.`,
    "This is a dedicated repository setup operation, not a product bug-fix or validation job. Do not start a dashboard/job, change branches, commit, push or publish a PR.",
    "Read repository instructions, the FixLab profile, existing browser/auth guards and their tests. Preserve unrelated work and existing authentication helpers.",
    "Inventory ALL read-only queries across the approved API scope, not only the reported feature. Verify each from its API contract AND implementation, including supported payloads, redirects and absence of business/workflow mutation. Route names and HTTP verbs alone are not evidence.",
    "Use one repository-owned query policy shared by browser guards and API helpers. Reuse an existing catalog when available. Include verified POST searches alongside GET/HEAD/OPTIONS, bound to the exact selected environment, API origin, base path and supported payload. Upgrade existing adapters as well as new setup; remove feature-specific drift, not safety controls.",
    "Include verified read-only application bootstrap queries, local public assets, UI font resources and required identity resources in that shared policy. Diagnose actual blocked method/origin/path metadata without retaining queries, credentials or response bodies; do not rebuild feature-sized allowlists in each generated journey. Match reviewed resources narrowly, keep telemetry suppression explicit, and retain HTTP/transport failure reporting. A successful resource request never proves authentication.",
    "Review legacy readOnlyPostPaths and any hard-coded URL lists or feature-sized limits in the actual adapter. Updating only the profile or agent instructions is not a completed repair. Do not introduce wildcards or permit arbitrary POSTs.",
    "Keep real POST/PUT/PATCH/DELETE writes behind the existing separately approved write tools. Neither query setup nor Allow all tools grants writes. Keep Save, Submit, Approve and autosave blocked; identity-only proof stays query-disabled.",
    "Do not contact a business API, perform authentication, inspect/copy browser state or credentials, or send business-data writes during setup. Never broaden another environment, production, API-only, unit-only or synthetic-only policy.",
    approved
      ? "The user approved this setup operation only. Before editing, show the exact proposed setup files and verified query scope. Modify only the repository-owned query policy, browser/API adapters and focused guard tests needed for that scope. Preserve product source and existing unrelated tests. If the read scope or proposed changes exceed this authorization, stop for a new scoped review. Normal runtime permissions still apply."
      : "PLAN ONLY: read and report the exact setup files, verified query scope, missing coverage and proposed offline test commands. Do not create, edit or delete files, install dependencies, or execute setup/validation commands. Ask the user to review this plan, then rerun fixlab setup-queries with the same environment and --yes to apply it.",
    "For an approved repair, run focused offline tests against the actual adapters: all verified query routes, unsupported payloads, same-origin other-environment paths, redirects, unapproved writes, and the separately approved write path. Do not enable writes to make a read test pass.",
    "Finish with actual changed files and test results or exact unresolved prerequisites. Never claim setup ready from a profile entry alone. Policy/helper changes require a fresh reviewed job; do not resume an executor with stale approvals or claim browser validation passed."
  ].join(" ");
}

export function localRepository(value) {
  if (typeof value !== "string" || value.length > 2048 || !isAbsolute(value)) {
    throw new Error("Choose an existing local Git repository using its absolute folder path.");
  }
  const root = realpathSync.native(value);
  if (!lstatSync(root).isDirectory() || root === parse(root).root) {
    throw new Error("A filesystem root is not a repository workspace.");
  }
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536
  });
  if (git.status !== 0 || realpathSync.native(git.stdout.trim()) !== root) {
    throw new Error("Select the root of an existing Git working tree, not a subfolder or bare repository.");
  }
  return root;
}

export function setupPath(root, value) {
  if (
    typeof value !== "string" || !value ||
    isAbsolute(value) || /^[A-Za-z]:|^[/\\]/u.test(value) ||
    value.split(/[/\\]/u).includes("..")
  ) {
    throw new Error("Setup files must use repository-relative paths without traversal");
  }
  const path = resolve(root, value);
  const parts = relative(root, path).split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Setup paths must not follow symbolic links: ${value}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return path;
}

function existingFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("Setup requires regular files no larger than 1 MiB");
  }
  return readFileSync(path);
}

export function planWorktreeSetup({ source, repository, templatePath }) {
  const sourceRoot = realpathSync.native(source);
  const targetRoot = realpathSync.native(repository);
  if (
    sourceRoot === targetRoot ||
    canonicalExecutionRepository(sourceRoot).key !== canonicalExecutionRepository(targetRoot).key
  ) {
    throw new Error("--from must identify another checkout of the same Git repository");
  }
  const sourceProfilePath = setupPath(sourceRoot, SETUP_PROFILE_PATH);
  const rawProfile = existingFile(sourceProfilePath);
  if (!rawProfile) {
    throw new Error("The --from checkout has no repository profile; configure it before worktree onboarding");
  }
  let profile;
  try {
    profile = JSON.parse(rawProfile.toString("utf8"));
  } catch {
    throw new Error("The source repository profile is invalid JSON; repair it before worktree onboarding");
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("The source repository profile must be a JSON object");
  }
  if (profile.worktreeSetup !== undefined && (
    !profile.worktreeSetup || typeof profile.worktreeSetup !== "object" || Array.isArray(profile.worktreeSetup)
  )) {
    throw new Error("worktreeSetup must be an object containing a files array");
  }
  const configuredFiles = profile.worktreeSetup?.files === undefined ? [] : profile.worktreeSetup.files;
  if (!Array.isArray(configuredFiles) || configuredFiles.some((value) => typeof value !== "string")) {
    throw new Error("worktreeSetup.files must be an array of repository-relative non-sensitive file paths");
  }
  const files = [...new Set([SETUP_PROFILE_PATH, ...configuredFiles])].map((name) => {
    if (
      /(?:^|[/\\])(?:\.git|node_modules|\.auth|\.edge-profile|\.npmrc|\.env(?:\.[^/\\]*)?)(?:[/\\]|$)|\.(?:pem|key|pfx|p12)$/iu.test(name)
    ) {
      throw new Error(`Worktree setup must not copy credentials, dependencies or browser state: ${name}`);
    }
    const sourcePath = setupPath(sourceRoot, name);
    const targetPath = setupPath(targetRoot, name);
    const content = existingFile(sourcePath);
    if (!content) {
      throw new Error(`Declared worktree setup file is missing from the source checkout: ${name}`);
    }
    const previous = existingFile(targetPath);
    const template = name === SETUP_PROFILE_PATH && previous && templatePath
      ? existingFile(templatePath)
      : null;
    const replaceTemplate = Boolean(template && previous.equals(template));
    if (previous && !previous.equals(content) && !replaceTemplate) {
      throw new Error(`Existing worktree configuration differs; merge it manually before setup: ${name}`);
    }
    return { name, sourcePath, targetPath, content, previous, replaceTemplate };
  });
  const configurationErrors = browserConfigurationErrors(profile, targetRoot, new Set(files.map((file) => file.targetPath)));
  if (configurationErrors.length) {
    throw new Error(configurationErrors.join("\n"));
  }
  return { source: sourceRoot, repository: targetRoot, profile, files };
}

export function applyWorktreeSetup(plan) {
  for (const file of plan.files) {
    setupPath(plan.source, file.name);
    setupPath(plan.repository, file.name);
    const source = existingFile(file.sourcePath);
    const target = existingFile(file.targetPath);
    if (
      !source?.equals(file.content) ||
      (file.previous ? !target?.equals(file.previous) : target !== null)
    ) {
      throw new Error(`Setup files changed after planning; review a new plan: ${file.name}`);
    }
  }
  for (const file of plan.files) {
    if (file.previous?.equals(file.content)) {
      continue;
    }
    mkdirSync(dirname(file.targetPath), { recursive: true });
    if (file.replaceTemplate) {
      writeFileSync(file.targetPath, file.content);
    } else {
      copyFileSync(file.sourcePath, file.targetPath, constants.COPYFILE_EXCL);
    }
  }
}

export function browserConfigurationErrors(profile, repository, plannedFiles = new Set()) {
  const command = profile?.browserAutomation?.testCommand;
  if (typeof command !== "string") {
    return [];
  }
  const errors = [];
  const root = realpathSync.native(repository);
  const directory = profile.browserAutomation.workingDirectory ?? ".";
  for (const match of command.matchAll(/(?:^|\s)--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gu)) {
    const name = match[1] ?? match[2] ?? match[3];
    try {
      if (isAbsolute(name) || /^[A-Za-z]:|^[/\\]/u.test(name)) {
        throw new Error("Use a repository-relative browser configuration");
      }
      const path = setupPath(root, join(directory, name));
      if (!plannedFiles.has(path) && !existingFile(path)) {
        errors.push(`browserAutomation.testCommand configuration is missing: ${name}. Provide it or declare it in worktreeSetup.files before onboarding`);
      }
    } catch (error) {
      errors.push(`browserAutomation.testCommand configuration is invalid: ${error.message}`);
    }
  }
  return errors;
}
import { spawnSync } from "node:child_process";
