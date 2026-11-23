import { spawn, spawnSync } from "node:child_process";
import { spawnWindowsExecutor, quoteWindowsArgument } from "../dashboard/windows-executor.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_CAPTURE_BYTES_PER_STREAM = 50 * 1024 * 1024;
const MAX_DIAGNOSTICS = 20;
const MAX_TAIL_LINES = 20;
const MAX_LINE_CHARACTERS = 64 * 1024;
const MAX_EVIDENCE_DIRECTORIES = 100;
const EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const HEADER_SECRET_PATTERN =
  /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*).+$/gimu;
const SECRET_PATTERN =
  /((?:"|')?(?:password|passwd|secret|token|authorization|bearer|cookie|client[-_]?secret|api[-_]?key)(?:"|')?\s*(?:=|:)\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SECRET_ARGUMENT_PATTERN =
  /(--(?:password|passwd|secret|token|authorization|bearer|cookie|client-secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu;
const AUTH_SCHEME_PATTERN = /(\b(?:bearer|basic)\s+)[^\s"',;]+/giu;
const CREDENTIAL_URL_PATTERN = /(https?:\/\/[^:\s/]+:)[^@\s]+@/giu;

function sanitize(value) {
  return String(value)
    .replace(HEADER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(SECRET_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ARGUMENT_PATTERN, "$1[REDACTED]")
    .replace(AUTH_SCHEME_PATTERN, "$1[REDACTED]")
    .replace(CREDENTIAL_URL_PATTERN, "$1[REDACTED]@");
}

export { sanitize as sanitizeCommandOutput };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repository, args) {
  return spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

function isContained(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child))
  );
}

export function resolveEvidenceRoot(repository) {
  const result = git(repository, [
    "rev-parse",
    "--git-path",
    "fixlab/command-evidence"
  ]);
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("fixlab exec requires a Git repository");
  }
  const path = result.stdout.trim();
  return resolve(repository, path);
}

export function repositoryState(repository) {
  const head = git(repository, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    throw new Error("fixlab exec could not resolve the repository HEAD");
  }
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  if (status.status !== 0) {
    throw new Error("fixlab exec could not inspect the repository worktree");
  }
  const files = git(repository, [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z"
  ]);
  if (files.status !== 0) {
    throw new Error("fixlab exec could not enumerate repository files");
  }
  const deleted = git(repository, ["ls-files", "--deleted", "-z"]);
  if (deleted.status !== 0) {
    throw new Error("fixlab exec could not inspect deleted repository files");
  }
  const deletedPaths = new Set(deleted.stdout.split("\0").filter(Boolean));
  const paths = files.stdout.split("\0").filter(Boolean);
  // A nested Git repository is listed as a directory and cannot be hashed.
  const nestedRepositories = paths.filter((path) => path.endsWith("/"));
  const filePaths = paths.filter((path) =>
    !path.endsWith("/") && !deletedPaths.has(path)
  );
  const regularPaths = filePaths.filter((path) => !/[\r\n]/u.test(path));
  const exceptionalPaths = filePaths.filter((path) => /[\r\n]/u.test(path));
  const contentHashes = [...deletedPaths].map((path) => `${path}\0deleted`);
  for (const path of nestedRepositories) {
    const nestedHead = git(join(repository, path), ["rev-parse", "HEAD"]);
    contentHashes.push(
      `${path}\0nested-repository:${nestedHead.status === 0 ? nestedHead.stdout.trim() : "unknown"}`
    );
  }
  if (regularPaths.length > 0) {
    const hashes = spawnSync(
      "git",
      ["hash-object", "--no-filters", "--stdin-paths"],
      {
        cwd: repository,
        encoding: "utf8",
        input: `${regularPaths.join("\n")}\n`,
        maxBuffer: 100 * 1024 * 1024,
        shell: false,
        windowsHide: true
      }
    );
    if (hashes.status !== 0) {
      throw new Error("fixlab exec could not fingerprint repository contents");
    }
    const values = hashes.stdout.trim().split(/\r?\n/u);
    if (values.length !== regularPaths.length) {
      throw new Error("fixlab exec received an incomplete content fingerprint");
    }
    for (const [index, path] of regularPaths.entries()) {
      contentHashes.push(`${path}\0${values[index]}`);
    }
  }
  for (const path of exceptionalPaths) {
    const hash = git(repository, ["hash-object", "--no-filters", "--", path]);
    if (hash.status !== 0) {
      throw new Error("fixlab exec could not fingerprint repository contents");
    }
    contentHashes.push(`${path}\0${hash.stdout.trim()}`);
  }
  contentHashes.sort();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profileHash = existsSync(profilePath)
    ? sha256(readFileSync(profilePath))
    : "";
  const instructions = paths.filter((path) =>
    /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/u.test(path) ||
    /^\.github\/(?:copilot-instructions\.md|instructions\/.*\.instructions\.md)$/u.test(path)
  );
  for (const path of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
    if (existsSync(resolve(repository, path))) {
      instructions.push(path);
    }
  }
  const instructionHash = sha256([...new Set(instructions)].sort().map(
    (path) => `${path}\0${deletedPaths.has(path)
      ? "deleted"
      : sha256(readFileSync(resolve(repository, path)))}`
  ).join("\0"));
  return {
    head: head.stdout.trim(),
    worktreeHash: sha256(`${status.stdout}\0${contentHashes.join("\0")}`),
    profileHash,
    instructionHash
  };
}

export function reusableValidationCommand(command, args) {
  const executable = basename(command).toLowerCase().replace(/\.cmd|\.exe$/gu, "");
  const first = String(args[0] ?? "").toLowerCase();
  const second = String(args[1] ?? "").toLowerCase();

  if (executable === "dotnet") {
    return ["build", "test"].includes(first);
  }
  if (executable === "node") {
    return first === "--test";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (first === "test") {
      return true;
    }
    if (first !== "run") {
      return false;
    }
    return /^(?:build|check|format:check|lint|test(?::unit)?|type-?check|typecheck)$/u.test(
      second
    );
  }
  return false;
}

function describeTool(command, args) {
  const executable = basename(command)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/gu, "");
  const first = String(args[0] ?? "").toLowerCase();
  const second = String(args[1] ?? "").toLowerCase();

  if (executable === "dotnet") {
    return first ? `dotnet ${first}` : "dotnet";
  }
  if (executable === "node") {
    return first === "--test" ? "Node.js test" : "Node.js";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (first === "run" && second) {
      return `${executable} run ${second}`;
    }
    return first ? `${executable} ${first}` : executable;
  }
  if (
    (executable === "npx" && first === "playwright") ||
    executable === "playwright"
  ) {
    return "Playwright";
  }
  return executable || "command";
}

function requiresWindowsCommandShell(command) {
  if (process.platform !== "win32") {
    return false;
  }
  const executable = basename(command).toLowerCase();
  return (
    /\.(?:bat|cmd)$/u.test(executable) ||
    ["npm", "npx", "pnpm", "yarn"].includes(executable)
  );
}

function quoteWindowsCommandArgument(value, commandPath = false) {
  const text = String(value);
  if (/[\r\n]/u.test(text)) {
    throw new Error("command arguments cannot contain newlines");
  }
  if (!commandPath && /[&|<>()^%!]/u.test(text)) {
    throw new Error(
      "Windows command-wrapper arguments cannot contain shell metacharacters"
    );
  }
  if (text.includes('"')) {
    throw new Error("Windows command-wrapper arguments cannot contain quotes");
  }
  return `"${text}"`;
}

function resolveWindowsNpmCommand(command, args) {
  if (
    process.platform !== "win32" ||
    basename(command).toLowerCase().replace(/\.cmd$/u, "") !== "npm"
  ) {
    return null;
  }
  const candidates = [
    process.env.npm_execpath,
    join(dirname(command), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  const npmCli = candidates.find(
    (candidate) =>
      basename(candidate).toLowerCase() === "npm-cli.js" &&
      existsSync(candidate)
  );
  return npmCli
    ? { command: process.execPath, args: [npmCli, ...args] }
    : null;
}

export function resolveWindowsAzureCommand(command, args, platform = process.platform, searchPath = process.env.PATH ?? "") {
  if (platform !== "win32" || !/^az(?:\.cmd)?$/i.test(basename(command))) {
    return null;
  }
  if (!isAbsolute(command) && command !== basename(command)) {
    return null;
  }
  const candidates = isAbsolute(command) ? [command] :
    searchPath.split(";").filter((path) => isAbsolute(path)).map((path) => join(path, "az.cmd"));
  for (const wrapper of candidates) {
    if (basename(dirname(wrapper)).toLowerCase() !== "wbin" ||
        basename(dirname(dirname(wrapper))).toLowerCase() !== "cli2") {
      continue;
    }
    const python = join(dirname(dirname(wrapper)), "python.exe");
    if (existsSync(wrapper) && existsSync(python) &&
        statSync(wrapper).isFile() && statSync(python).isFile() &&
        realpathSync.native(wrapper) === resolve(wrapper) &&
        realpathSync.native(python) === resolve(python)) {
      return { command: python, args: ["-m", "azure.cli", ...args] };
    }
  }
  return null;
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${name} must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`
    );
  }
  return number;
}

export function parseStructuredCommandArguments(
  args,
  defaultRepository = process.cwd()
) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error(
      "usage: fixlab exec [repository] [--cwd <path>] [--stage <name>] [--reuse] [--timeout-seconds <seconds>] -- <command> [args...]\n" +
        "hint: in Windows PowerShell an unquoted -- is dropped; write '--' (quoted) and do not wrap the command in cmd /c."
    );
  }

  const options = args.slice(0, separator);
  const command = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  let repositoryArgument = "";
  let cwdArgument = ".";
  let stage = "validation";
  let reuse = false;
  let timeoutSeconds = 0;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--reuse") {
      reuse = true;
      continue;
    }
    if (["--cwd", "--stage", "--timeout-seconds"].includes(option)) {
      const value = options[index + 1];
      if (!value) {
        throw new Error(`${option} requires a value`);
      }
      if (option === "--cwd") {
        cwdArgument = value;
      } else if (option === "--stage") {
        stage = value.trim();
      } else {
        timeoutSeconds = parsePositiveInteger(value, option);
      }
      index += 1;
      continue;
    }
    if (option.startsWith("-")) {
      throw new Error(`unknown fixlab exec option: ${option}`);
    }
    if (repositoryArgument) {
      throw new Error("fixlab exec accepts at most one repository path");
    }
    repositoryArgument = option;
  }

  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(stage)) {
    throw new Error("--stage must be a lowercase name of up to 32 characters");
  }

  const repositoryCandidate = resolve(repositoryArgument || defaultRepository);
  if (
    !existsSync(repositoryCandidate) ||
    !statSync(repositoryCandidate).isDirectory()
  ) {
    throw new Error(
      `repository does not exist or is not a directory: ${repositoryCandidate}`
    );
  }
  const repository = realpathSync(repositoryCandidate);
  const cwdCandidate = resolve(repository, cwdArgument);
  if (!existsSync(cwdCandidate) || !statSync(cwdCandidate).isDirectory()) {
    throw new Error(`command working directory does not exist: ${cwdCandidate}`);
  }
  const cwd = realpathSync(cwdCandidate);
  if (!isContained(repository, cwd)) {
    throw new Error("--cwd must stay within the repository");
  }

  return {
    repository,
    cwd,
    stage,
    reuse,
    timeoutSeconds,
    command,
    commandArgs
  };
}

function pruneEvidence(root, now = Date.now()) {
  if (!existsSync(root)) {
    return;
  }
  const directories = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "cache" &&
        /^\d{8}T\d{6}-[a-f0-9-]+$/u.test(entry.name)
    )
    .map((entry) => {
      const path = join(root, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of directories) {
    if (
      entry.mtimeMs < now - EVIDENCE_RETENTION_MS ||
      directories.indexOf(entry) >= MAX_EVIDENCE_DIRECTORIES
    ) {
      rmSync(entry.path, { recursive: true, force: true });
    }
  }
  const cacheDirectory = join(root, "cache");
  if (existsSync(cacheDirectory)) {
    const cacheFiles = readdirSync(cacheDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => {
        const path = join(cacheDirectory, entry.name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const [index, entry] of cacheFiles.entries()) {
      if (
        entry.mtimeMs < now - EVIDENCE_RETENTION_MS ||
        index >= MAX_EVIDENCE_DIRECTORIES
      ) {
        rmSync(entry.path, { force: true });
      }
    }
  }
}

function createCollector(path) {
  let capturedBytes = 0;
  let totalBytes = 0;
  let remainder = "";
  let oversizedLine = false;
  let oversizedLines = 0;
  let truncated = false;
  const errors = [];
  const warnings = [];
  const errorSet = new Set();
  const warningSet = new Set();
  const tail = [];
  let lineCount = 0;
  let failed = null;
  let passed = null;
  let skipped = null;
  let cancelled = 0;
  let total = null;
  let suites = null;
  let durationMs = null;

  const appendSanitized = (value) => {
    if (capturedBytes >= MAX_CAPTURE_BYTES_PER_STREAM) {
      truncated = true;
      return;
    }
    const remaining = MAX_CAPTURE_BYTES_PER_STREAM - capturedBytes;
    const buffer = Buffer.from(value);
    const output = buffer.subarray(0, remaining);
    writeFileSync(path, output, { flag: "a", mode: 0o600 });
    capturedBytes += output.length;
    truncated = output.length < buffer.length;
  };

  const remember = (collection, seen, line) => {
    const key = line.toLowerCase();
    if (!seen.has(key) && collection.length < MAX_DIAGNOSTICS) {
      seen.add(key);
      collection.push(line);
    }
  };

  const inspectLine = (rawLine) => {
    const line = sanitize(rawLine).trim().slice(0, 2000);
    lineCount += 1;
    if (!line) {
      return;
    }
    tail.push(line);
    if (tail.length > MAX_TAIL_LINES) {
      tail.shift();
    }
    if (
      /\b(?:error|exception|fatal|assertion failed|failed:)\b/iu.test(line) &&
      !/\b0\s+(?:error|errors|failed|failures)\b/iu.test(line)
    ) {
      remember(errors, errorSet, line);
    } else if (/\bwarning\b/iu.test(line)) {
      remember(warnings, warningSet, line);
    }

    const dotnet = line.match(
      /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/iu
    );
    if (dotnet) {
      [, failed, passed, skipped, total] = dotnet.map(Number);
      return;
    }
    const jest = line.match(
      /Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/iu
    );
    if (jest) {
      failed = Number(jest[1] ?? 0);
      skipped = Number(jest[2] ?? 0);
      passed = Number(jest[3] ?? 0);
      total = Number(jest[4]);
      return;
    }
    const playwright = line.match(
      /(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped(?:,\s*)?)?(\d+)\s+passed/iu
    );
    if (playwright) {
      failed = Number(playwright[1] ?? 0);
      skipped = Number(playwright[2] ?? 0);
      passed = Number(playwright[3]);
      total = failed + skipped + passed;
      return;
    }
    const tap = line.match(
      /^(?:#|\u2139)?\s*(tests|suites|pass|fail|cancelled|skipped|duration_ms)\s+([\d.]+)$/iu
    );
    if (tap) {
      const value = Number(tap[2]);
      switch (tap[1].toLowerCase()) {
        case "tests":
          total = value;
          break;
        case "suites":
          suites = value;
          break;
        case "pass":
          passed = value;
          break;
        case "fail":
          failed = value;
          break;
        case "cancelled":
          cancelled = value;
          break;
        case "skipped":
          skipped = value;
          break;
        case "duration_ms":
          durationMs = value;
          break;
      }
    }
  };

  const write = (chunk) => {
    const text = chunk.toString();
    totalBytes += Buffer.byteLength(text);
    const lines = `${remainder}${text}`.split(/\r?\n/u);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      const omitted = oversizedLine || line.length > MAX_LINE_CHARACTERS;
      const sanitizedLine = omitted
        ? "[Oversized output line omitted by the capture limit]"
        : sanitize(line);
      if (omitted) {
        oversizedLines += 1;
      }
      oversizedLine = false;
      appendSanitized(`${sanitizedLine}\n`);
      inspectLine(sanitizedLine);
    }
    if (oversizedLine || remainder.length > MAX_LINE_CHARACTERS) {
      oversizedLine = true;
      remainder = "";
    }
  };

  const finish = () => {
    if (remainder || oversizedLine) {
      const sanitizedLine = oversizedLine
        ? "[Oversized output line omitted by the capture limit]"
        : sanitize(remainder);
      if (oversizedLine) {
        oversizedLines += 1;
      }
      appendSanitized(sanitizedLine);
      inspectLine(sanitizedLine);
      remainder = "";
    }
    return {
      path,
      totalBytes,
      capturedBytes,
      truncated,
      oversizedLines,
      lineCount,
      errors,
      warnings,
      tail,
      tests:
        total === null
          ? null
          : {
              failed: failed ?? 0,
              passed: passed ?? 0,
              skipped: skipped ?? 0,
              cancelled,
              total,
              suites,
              durationMs
            }
    };
  };

  return { write, finish };
}

function cacheFingerprint(options, state, environment) {
  return sha256(
    JSON.stringify({
      version: 4,
      platform: process.platform,
      command: options.command,
      commandArgs: options.commandArgs,
      cwd: relative(options.repository, options.cwd),
      stage: options.stage,
      timeoutSeconds: options.timeoutSeconds,
      executionContext: Object.fromEntries(["FIXLAB_HELPER_ROOT", "FIXLAB_REPOSITORY",
        "FIXLAB_DEV_API_ENVIRONMENT", "FIXLAB_DEV_API_MUTATION_MODE",
        "FIXLAB_DEV_API_SELECTED_MUTATION_MODE"].map(key => [key, environment[key] ?? ""])),
      state
    })
  );
}

function formatSummary(result, reused = false) {
  const lines = [
    `${reused ? "REUSED" : result.status === 0 ? "PASS" : "FAIL"} fixlab exec: ${sanitize(result.displayCommand)} (${(result.durationMs / 1000).toFixed(1)}s)`,
    `Tool: ${sanitize(result.tool ?? "command")}`
  ];
  const tests = result.stdout.tests ?? result.stderr.tests;
  if (tests) {
    lines.push(
      `Tests: ${tests.passed} passed, ${tests.failed} failed, ${tests.cancelled ?? 0} cancelled, ${tests.skipped} skipped, ${tests.total} total`
    );
  }
  const errors = [
    ...result.stderr.errors,
    ...result.stdout.errors
  ].slice(0, MAX_DIAGNOSTICS);
  if (errors.length > 0) {
    lines.push("Errors:");
    lines.push(...errors.map((line) => `- ${line}`));
  } else if (result.status !== 0) {
    const tail = [...result.stderr.tail, ...result.stdout.tail].slice(
      -MAX_TAIL_LINES
    );
    if (tail.length > 0) {
      lines.push("Failure tail:");
      lines.push(...tail.map((line) => `- ${line}`));
    }
  }
  const warningCount =
    result.stderr.warnings.length + result.stdout.warnings.length;
  if (warningCount > 0) {
    lines.push(`Unique warnings retained: ${warningCount}`);
  }
  if (result.stdout.truncated || result.stderr.truncated) {
    lines.push(
      `Evidence capture reached the ${MAX_CAPTURE_BYTES_PER_STREAM / 1024 / 1024} MiB per-stream safety limit.`
    );
  }
  const oversizedLines = (result.stdout.oversizedLines ?? 0) + (result.stderr.oversizedLines ?? 0);
  if (oversizedLines > 0) {
    lines.push(`Oversized output lines omitted: ${oversizedLines} (64 KiB character limit).`);
  }
  lines.push(`Evidence: ${result.evidenceDirectory}`);
  const rawBytes = result.stdout.totalBytes + result.stderr.totalBytes;
  const rawLines = result.stdout.lineCount + result.stderr.lineCount;
  const structuredLines = lines.length + 1;
  let structuredBytes = Buffer.byteLength(`${lines.join("\n")}\n`);
  let text = "";
  let metrics = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reductionPercent =
      rawBytes > 0
        ? Math.max(0, 100 - (structuredBytes / rawBytes) * 100)
        : 0;
    metrics = {
      rawBytes,
      structuredBytes,
      estimatedRawTokens: Math.ceil(rawBytes / 4),
      estimatedStructuredTokens: Math.ceil(structuredBytes / 4),
      reductionPercent: Number(reductionPercent.toFixed(1)),
      rawLines,
      structuredLines,
      omittedLines: Math.max(0, rawLines - structuredLines)
    };
    const contextLine =
      `Context: ${metrics.rawLines} raw lines / ${metrics.rawBytes} bytes ` +
      `(~${metrics.estimatedRawTokens} tokens) -> ${metrics.structuredLines} summary lines / ` +
      `${metrics.structuredBytes} bytes (~${metrics.estimatedStructuredTokens} tokens), ` +
      `${metrics.reductionPercent.toFixed(1)}% reduction; ${metrics.omittedLines} lines omitted`;
    text = `${[...lines, contextLine].join("\n")}\n`;
    const nextStructuredBytes = Buffer.byteLength(text);
    if (nextStructuredBytes === structuredBytes) {
      metrics.structuredBytes = nextStructuredBytes;
      metrics.estimatedStructuredTokens = Math.ceil(nextStructuredBytes / 4);
      break;
    }
    structuredBytes = nextStructuredBytes;
  }
  return { text, metrics };
}

function readReusableResult(cachePath, evidenceRoot, stderr) {
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const result = JSON.parse(readFileSync(cachePath, "utf8"));
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    const stream = (value) => value && count(value.totalBytes) && count(value.lineCount) &&
      ["errors", "warnings", "tail"].every((key) => Array.isArray(value[key]) &&
        value[key].length <= 100 && value[key].every((line) => typeof line === "string" && line.length <= 65536)) &&
      (!value.tests || ["passed", "failed", "skipped", "total"].every((key) => count(value.tests[key])));
    const valid = result?.status === 0 && result.terminationVerified === true &&
      typeof result.displayCommand === "string" && result.displayCommand.length <= 8192 &&
      Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
      stream(result.stdout) && stream(result.stderr) &&
      typeof result.evidenceDirectory === "string" && dirname(result.evidenceDirectory) === evidenceRoot &&
      existsSync(result.evidenceDirectory) && lstatSync(result.evidenceDirectory).isDirectory() &&
      !lstatSync(result.evidenceDirectory).isSymbolicLink();
    if (valid) { return result; }
    stderr.write("Ignored invalid or unavailable reusable command evidence; running validation again.\n");
  } catch (error) {
    if (!(error instanceof SyntaxError)) { throw error; }
    stderr.write("Ignored malformed reusable command metadata; running validation again.\n");
  }
  return null;
}

export async function executeStructuredCommand(options, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const now = io.now ?? Date.now;
  const spawnProcess = io.spawn ?? spawn;
  const terminationGraceMs = io.terminationGraceMs ?? 5000;
  const evidenceRoot = resolveEvidenceRoot(options.repository);
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  pruneEvidence(evidenceRoot, now());

  const state = io.repositoryState ?? repositoryState(options.repository);
  const environment = { ...process.env, ...io.environment };
  delete environment.NODE_TEST_CONTEXT;
  const fingerprint = cacheFingerprint(options, state, environment);
  const cacheDirectory = join(evidenceRoot, "cache");
  const cachePath = join(cacheDirectory, `${fingerprint}.json`);
  const reusable =
    options.reuse &&
    reusableValidationCommand(options.command, options.commandArgs);
  if (reusable) {
    const cached = readReusableResult(cachePath, evidenceRoot, stderr);
    if (cached) {
      stdout.write(formatSummary(cached, true).text);
      return 0;
    }
  } else if (options.reuse) {
    stderr.write(
      "Reuse ignored: this command is not an eligible deterministic local validation.\n"
    );
  }

  const timestamp = new Date(now())
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "");
  const evidenceDirectory = join(
    evidenceRoot,
    `${timestamp}-${randomUUID()}`
  );
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const stdoutCollector = createCollector(join(evidenceDirectory, "stdout.log"));
  const stderrCollector = createCollector(join(evidenceDirectory, "stderr.log"));
  const startedAt = now();
  let terminationVerified = true;
  let executionFailed = false;
  const displayCommand = sanitize(
    [options.command, ...options.commandArgs].join(" ")
  );
  const windowsNpmCommand = resolveWindowsAzureCommand(options.command, options.commandArgs) ?? resolveWindowsNpmCommand(
    options.command,
    options.commandArgs
  );
  const windowsCommandShell =
    !windowsNpmCommand && requiresWindowsCommandShell(options.command);
  const windowsBatchFile = /\.(?:bat|cmd)$/iu.test(options.command);
  const shellCommand = windowsCommandShell
    ? [
        /\s/u.test(options.command)
          ? quoteWindowsCommandArgument(options.command, true)
          : options.command,
        ...options.commandArgs.map((argument) =>
          quoteWindowsCommandArgument(argument)
        )
      ].join(" ")
    : options.command;
  const spawnedCommand =
    windowsCommandShell && windowsBatchFile
      ? `call ${shellCommand}`
      : shellCommand;
  const executable = windowsCommandShell
    ? process.env.ComSpec || "cmd.exe"
    : windowsNpmCommand?.command || spawnedCommand;
  const spawnedArguments = windowsCommandShell
    ? ["/d", "/v:off", "/c", spawnedCommand]
    : windowsNpmCommand?.args || options.commandArgs;

  const status = await new Promise((resolveStatus) => {
    let settled = false;
    let timedOut = false;
    let timeout = null;
    let forceTimeout = null;
    let abandonTimeout = null;
    let cancelled = false;
    let containment = null;
    let child;
    let terminating = false;
    const ownedGroup = process.platform !== "win32" && io.ownProcessTree && !io.spawn;
    const settlementFailure = (message) => {
      terminationVerified = false;
      executionFailed = true;
      stderrCollector.write(`${message}; owned-tree settlement is unverified and its repository lease must remain held.\n`);
    };
    const verifyOwnedTree = () => {
      if (containment) {
        try {
          terminationVerified = containment.hasStopped();
          if (terminationVerified && executionFailed) {
            stderrCollector.write("Owned-tree stopped proof verified; the command failure is retained.\n");
          }
        } catch (error) {
          settlementFailure(`Owned containment proof failed (${error.code ?? "invalid proof"})`);
        }
      } else if (ownedGroup && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, 0);
          terminationVerified = false;
        } catch (error) {
          terminationVerified = error.code === "ESRCH";
        }
      } else {
        return false;
      }
      if (!terminationVerified) {
        stderrCollector.write("Owned command tree termination could not be verified; its repository lease must remain held.\n");
      }
      return terminationVerified;
    };
    const signalChild = (signal) => {
      try {
        if (ownedGroup && Number.isInteger(child.pid)) {
          process.kill(-child.pid, signal);
        } else if (!child.kill(signal)) {
          settlementFailure("Owned command termination was not accepted");
        }
      } catch (error) {
        if (!ownedGroup || error.code !== "ESRCH") {
          settlementFailure(`Owned command termination failed (${error.code ?? "unknown error"})`);
        }
      }
    };
    const terminate = (exitCode) => {
      if (terminating || settled) { return; }
      terminating = true;
      if (containment) {
        try {
          containment.terminate();
        } catch (error) {
          settlementFailure(`Owned containment termination failed (${error.code ?? "unknown error"})`);
        }
      } else if (process.platform === "win32" && Number.isInteger(child.pid)) {
        const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          encoding: "utf8",
          windowsHide: true
        });
        if (killed.status !== 0) {
          settlementFailure("Could not terminate the owned command tree");
          signalChild("SIGTERM");
        }
      } else {
        signalChild("SIGTERM");
      }
      forceTimeout = setTimeout(() => {
        if (!settled) {
          if (!containment) { signalChild("SIGKILL"); }
          abandonTimeout = setTimeout(() => {
            if (!settled) {
              if (!verifyOwnedTree()) {
                settlementFailure("Timed out waiting for owned command termination");
              } else {
                stderrCollector.write("Command close event was unavailable; owned-tree stopped proof verified and command failure retained.\n");
              }
              settled = true;
              clearTimers();
              child.stdout.destroy();
              child.stderr.destroy();
              resolveStatus(exitCode);
            }
          }, terminationGraceMs);
        }
      }, terminationGraceMs);
    };
    const abort = () => {
      cancelled = true;
      stderrCollector.write("Command cancelled by its dashboard job.\n");
      terminate(130);
    };
    const clearTimers = () => {
      io.signal?.removeEventListener("abort", abort);
      for (const timer of [timeout, forceTimeout, abandonTimeout]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
    const spawnOptions = {
      cwd: options.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32" && io.ownProcessTree === true && !io.spawn,
      windowsVerbatimArguments: windowsCommandShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    };
    if (process.platform === "win32" && io.ownProcessTree && !io.spawn) {
      containment = (io.spawnWindowsExecutor ?? spawnWindowsExecutor)({
        executable, args: spawnedArguments, repository: options.cwd,
        environment: { ...environment, NODE_TEST_CONTEXT: undefined },
        ...(windowsCommandShell ? { commandLine: `${quoteWindowsArgument(executable)} /d /v:off /c ${spawnedCommand}` } : {})
      });
    }
    child = containment?.child ?? spawnProcess(executable, spawnedArguments, spawnOptions);
    child.stdout.on("data", stdoutCollector.write);
    child.stderr.on("data", stderrCollector.write);
    io.signal?.addEventListener("abort", abort, { once: true });
    if (io.signal?.aborted) {
      abort();
    }
    child.on("error", (error) => {
      stderrCollector.write(`${error.message}\n`);
      if (!settled) {
        if (Number.isInteger(child.pid)) {
          settlementFailure("Owned command emitted a post-spawn error");
          terminate(cancelled ? 130 : timedOut ? 124 : 1);
          return;
        }
        settled = true;
        clearTimers();
        let exitCode = 1;
        if (cancelled) {
          exitCode = 130;
        } else if (timedOut) {
          exitCode = 124;
        } else if (error.code === "ENOENT") {
          exitCode = 127;
        }
        resolveStatus(exitCode);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        if (containment || ownedGroup) { verifyOwnedTree(); }
        settled = true;
        clearTimers();
        if (signal) {
          stderrCollector.write(`Command terminated by signal ${signal}.\n`);
        }
        let exitCode = 1;
        if (cancelled) {
          exitCode = 130;
        } else if (timedOut) {
          exitCode = 124;
        } else if (Number.isInteger(code)) {
          exitCode = code;
        }
        resolveStatus(terminationVerified && !executionFailed ? exitCode : exitCode || 1);
      }
    });
    if (!settled && options.timeoutSeconds > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderrCollector.write(
          `Command exceeded ${options.timeoutSeconds} second(s); requesting owned-tree termination.\n`
        );
        terminate(124);
      }, options.timeoutSeconds * 1000);
    }
  });

  const result = {
    version: 2,
    status,
    terminationVerified,
    stage: options.stage,
    displayCommand,
    tool: sanitize(describeTool(options.command, options.commandArgs)),
    cwd: relative(options.repository, options.cwd) || ".",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    repositoryState: state,
    fingerprint,
    evidenceDirectory,
    stdout: stdoutCollector.finish(),
    stderr: stderrCollector.finish()
  };
  const summary = formatSummary(result);
  result.context = summary.metrics;
  writeFileSync(
    join(evidenceDirectory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (reusable && status === 0) {
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600
    });
  }
  io.onResult?.(result);
  (status === 0 ? stdout : stderr).write(summary.text);
  return status;
}

export async function runStructuredCommand(
  args,
  defaultRepository = process.cwd(),
  io = {}
) {
  const options = parseStructuredCommandArguments(args, defaultRepository);
  return executeStructuredCommand(options, { ownProcessTree: true, ...io });
}
