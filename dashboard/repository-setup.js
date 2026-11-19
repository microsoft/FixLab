import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalExecutionRepository } from "./executor-lease.js";

export const SETUP_PROFILE_PATH = join(".github", "fixlab", "repository-profile.json");
export const REPOSITORY_PROMPT_NAMES = ["bugfix", "intake", "diagnose", "reproduce", "fix", "validate", "live-test", "pr", "summary"]
  .map((name) => `fixlab.${name}.prompt.md`);

export function localRepository(value) {
  if (typeof value !== "string" || value.length > 2048 || !isAbsolute(value)) {
    throw new Error("Choose an existing local Git repository using its absolute folder path.");
  }
  if (preserveProfileRevision !== undefined) {
    const savedProfile = existingFile(setupPath(targetRoot, SETUP_PROFILE_PATH));
    if (typeof preserveProfileRevision !== "string" ||
        !/^[a-f0-9]{64}$/u.test(preserveProfileRevision) || !savedProfile ||
        createHash("sha256").update(savedProfile).digest("hex") !== preserveProfileRevision) {
      throw new Error("The saved worktree profile changed; review its configuration before setup.");
    }
    rawProfile = savedProfile;
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

export function planWorktreeSetup({ source, repository, templatePath, preserveProfileRevision }) {
  const sourceRoot = realpathSync.native(source);
  const targetRoot = realpathSync.native(repository);
  if (
    sourceRoot === targetRoot ||
    canonicalExecutionRepository(sourceRoot).key !== canonicalExecutionRepository(targetRoot).key
  ) {
    throw new Error("--from must identify another checkout of the same Git repository");
  }
  const sourceProfilePath = setupPath(sourceRoot, SETUP_PROFILE_PATH);
  let rawProfile = existingFile(sourceProfilePath);
  const sourceProfile = rawProfile;
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
    const sourcePath = setupPath(
      name === SETUP_PROFILE_PATH && preserveProfileRevision !== undefined ? targetRoot : sourceRoot, name
    );
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
  return { source: sourceRoot, repository: targetRoot, profile, files,
    ...(preserveProfileRevision !== undefined ? { sourceProfile } : {}) };
}

export function applyWorktreeSetup(plan) {
  if (plan.sourceProfile &&
      !existingFile(setupPath(plan.source, SETUP_PROFILE_PATH))?.equals(plan.sourceProfile)) {
    throw new Error(`Setup files changed after planning; review a new plan: ${SETUP_PROFILE_PATH}`);
  }
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
import { createHash } from "node:crypto";
