import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRuntimeText } from "./runtime-requests.js";
import { resolveEvidenceRoot } from "../bin/structured-command.js";

const sourceExtension = /^\.(?:[cm]?[jt]sx?|cs|csproj|sln|props|targets|md|mdx|html|css|scss|sass|less|fs|vb|go|rs|py|sh|ps1)$/i;
const sensitiveName = /auth|credential|secret|password|passwd|token|cookie|storage.?state|private|environment|appsettings/i;
const testCommand = /^(?:npm (?:test|run test(?::[\w-]+)?)|pnpm (?:test|run test(?::[\w-]+)?)|yarn test(?::[\w-]+)?|node --test|dotnet test|npx playwright test)(?: [A-Za-z0-9_./\\:= -]+)?$/;
const helperPath = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
const excludedPart = (part) => (part.startsWith(".") && part !== ".github") ||
  /^(?:node_modules|vendor|bin|obj|dist|build|artifacts|test-results|playwright-report)$/i.test(part) ||
  sensitiveName.test(part);

export function runtimeSourceName(name) {
  return name.replace(/(^|[._-])auth(?=\.(?:spec|test)\.[cm]?[jt]sx?$)/i, "$1source");
}

export function validateJobFileAccess(value, repository, jobId, mode) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!["source-read", "source-read-write"].includes(value.mode) ||
      (value.allowValidationGates !== undefined && typeof value.allowValidationGates !== "boolean") ||
      typeof jobId !== "string" || !/^[a-f0-9-]{36}$/i.test(jobId) ||
      value.jobId !== jobId || value.repository !== realpathSync.native(repository) ||
      (value.mode === "source-read-write" && mode !== "fix-and-validate")) {
    throw new Error("Repository file trust must match this exact job and canonical checkout; edits require fix-and-validate mode.");
  }
  return { mode: value.mode, jobId, repository: value.repository, allowValidationGates: value.allowValidationGates === true };
}

function safeProfile(path) {
  if (lstatSync(path).size > 256 * 1024) {
    return false;
  }
  const text = readFileSync(path, "utf8");
  if (!safeRuntimeText(text, 256 * 1024)) {
    return false;
  }
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {return false;}
    throw error;
  }
  const sensitive = (value) => value && typeof value === "object" &&
    Object.entries(value).some(([key, child]) =>
      /password|passwd|secret|token|cookie|credential|authorization|storage.?state|^origins$|^headers$/i.test(key) ||
      sensitive(child));
  return profile?.version === 1 && typeof profile.name === "string" && profile.name.trim().length > 0 &&
    !sensitive(profile);
}

export function createRuntimePermissionPolicy(repository, protectedPaths = [], fileAccess = null, dashboardPort = null,
  sessionId = null, copilotHome = join(homedir(), ".copilot")) {
  if (!Array.isArray(protectedPaths) || protectedPaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error("Protected runtime paths must be an array of absolute paths.");
  }
  let reads = null;
  const commands = new Set();
  const liveTools = new Map();

  const root = () => realpathSync.native(repository);
  const protectedPath = (path) => protectedPaths.some((protectedRoot) => {
    const suffix = relative(protectedRoot, path);
    return !suffix || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
  });
  const contained = (path, directory = root(), newFile = false) => {
    if (typeof path !== "string" || !path || /[*?\u0000-\u001f]/.test(path)) {
      return null;
    }
    const absolute = resolve(directory, path);
    const suffix = relative(directory, absolute);
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`) ||
        suffix.includes(":")) {
      return null;
    }
    let current = directory;
    const parts = suffix.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (newFile && error.code === "ENOENT" && index === parts.length - 1 &&
            dirname(absolute) === realpathSync.native(dirname(absolute))) {
          return absolute;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        return null;
      }
    }
    return absolute === realpathSync.native(absolute) ? absolute : null;
  };

  const eligible = (request, prompt) => typeof repository === "string" && isAbsolute(repository) &&
    (prompt.canApprove || (request.kind === "write" && fileAccess?.mode === "source-read-write" &&
      prompt.canUseFileTrust === true)) && !request.managedApprovalRequired &&
    !request.requestSandboxBypass && !request.requestSandboxPermissive &&
    !request.sandboxPathGrant && !request.warning && !request.hasWriteFileRedirection;
  const trustedHelper = (path) => path === helperPath &&
    contained(path, realpathSync.native(fileURLToPath(new URL("../", import.meta.url)))) === helperPath &&
    lstatSync(path).isFile();

  function checkpointRead(request, prompt) {
    if (request.kind !== "read" || !prompt.canApprove || typeof request.path !== "string" ||
        !isAbsolute(request.path) || !/^[a-f0-9-]{36}$/.test(sessionId ?? "") ||
        request.managedApprovalRequired || request.requestSandboxBypass || request.requestSandboxPermissive ||
        request.sandboxPathGrant || request.warning || request.hasWriteFileRedirection) { return null; }
    try {
      if (lstatSync(copilotHome).isSymbolicLink() || realpathSync.native(copilotHome) !== copilotHome) { return null; }
      const directory = join(copilotHome, "session-state", sessionId, "checkpoints");
      if (dirname(request.path) !== directory || !/^[^\\/]+\.md$/i.test(basename(request.path))) { return null; }
      const file = contained(request.path, copilotHome);
      if (!file || protectedPath(file) || (request.resolvedPath && request.resolvedPath !== file)) { return null; }
      const stat = lstatSync(file);
      return stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024
        ? "current session checkpoint Markdown (read only)" : null;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) { return null; }
      throw error;
    }
  }

  function candidate(request, prompt, automatic = false) {
    if (!eligible(request, prompt)) {
      return null;
    }
    try {
      const directory = root();
      if (lstatSync(repository).isSymbolicLink()) {
        return null;
      }
      if (automatic) {
        if (request.kind === "read" && request.intention === `Search in directory: ${request.path}`) {
          const requestedPath = typeof request.path === "string" ? resolve(directory, request.path) : null;
          const calls = [...liveTools.values()].filter((call) =>
            Date.now() - call.started < 60000 && call.toolName === "rg" &&
            (typeof call.arguments?.paths === "string" ||
              (Array.isArray(call.arguments?.paths) && call.arguments.paths.length === 1 &&
                typeof call.arguments.paths[0] === "string")) &&
            resolve(directory, typeof call.arguments.paths === "string"
              ? call.arguments.paths : call.arguments.paths[0]) === requestedPath);
          if (calls.length !== 1 || (request.toolCallId && request.toolCallId !== calls[0].toolCallId)) {
            return null;
          }
          const args = calls[0].arguments;
          const allowed = ["paths", "pattern", "glob", "output_mode", "head_limit", "-n", "-i", "-A", "-B", "-C"];
          const path = requestedPath === directory ? directory : contained(requestedPath, directory);
          if (!path || protectedPath(path) || !lstatSync(path).isDirectory() ||
              (request.resolvedPath && request.resolvedPath !== path) ||
              Object.keys(args).some((key) => !allowed.includes(key)) ||
              !safeRuntimeText(args.pattern, 256) || !args.pattern.trim() ||
              typeof args.glob !== "string" || args.glob.length > 120 ||
              !/^[A-Za-z0-9_.*?{},/\\-]+$/.test(args.glob) || args.glob.startsWith("!") ||
              args.glob.includes("..") ||
              !/^[A-Za-z0-9_*?/-]*\.(?:[cm]?[jt]sx?|cs|md|css|html|\{(?:[cm]?[jt]sx?|cs|md|css|html)(?:,(?:[cm]?[jt]sx?|cs|md|css|html))+\})$/.test(args.glob) ||
              !["content", "files_with_matches", "count"].includes(args.output_mode) ||
              !Number.isInteger(args.head_limit) || args.head_limit < 1 || args.head_limit > 100 ||
              ["-A", "-B", "-C"].some((key) => args[key] !== undefined &&
                (!Number.isInteger(args[key]) || args[key] < 0 || args[key] > 3)) ||
              ["-n", "-i"].some((key) => args[key] !== undefined && typeof args[key] !== "boolean")) {
            return null;
          }
          // Inspect the actual bounded filename selection, never infer safety from the intention alone.
          const selection = spawnSync("rg", ["--files", "--glob", args.glob, path], {
            encoding: "utf8", shell: false, windowsHide: true, timeout: 1000, maxBuffer: 128 * 1024
          });
          if (selection.error || ![0, 1].includes(selection.status)) { return null; }
          const files = selection.stdout.split(/\r?\n/).filter(Boolean);
          if (files.length > 500 || files.some((file) =>
            !candidate({ kind: "read", path: file }, { canApprove: true }))) {
            return null;
          }
          return { scope: "routine-read-only", key: "bounded live native source search" };
        }
        if (request.kind === "read" && typeof request.path === "string" &&
            request.intention === `Search for files matching pattern in: ${request.path}`) {
          // The native glob tool's fixed intention identifies filename-only discovery, not content search.
          const path = request.path === directory ? directory : contained(request.path, directory);
          if (path && !protectedPath(path) && lstatSync(path).isDirectory() &&
              !relative(directory, path).split(sep).some(excludedPart) &&
              (!request.resolvedPath || request.resolvedPath === path)) {
            return { scope: "routine-read-only", key: "repository filename discovery (no file contents)" };
          }
        }
        if (request.kind === "shell" && typeof request.fullCommandText === "string" &&
            !/[\r\n`$;&|<>()]/.test(request.fullCommandText) &&
            Array.isArray(request.possibleUrls) && request.possibleUrls.length === 0 &&
            Array.isArray(request.possiblePaths)) {
          const match = /^node (?:'([^']+)'|"([^"]+)"|([^\s'"]+)) --help$/.exec(request.fullCommandText);
          const path = match && (match[1] ?? match[2] ?? match[3]);
          if (trustedHelper(path) &&
              request.possiblePaths.every((reported) => reported === helperPath) &&
              (!request.resolvedPaths?.[path] || request.resolvedPaths[path] === helperPath)) {
            return { scope: "routine-read-only", key: "installed FixLab CLI --help" };
          }
        }
        return null;
      }
      if (["read", "write"].includes(request.kind)) {
        const writing = request.kind === "write";
        const requestedPath = writing ? request.fileName : request.path;
        let file = contained(requestedPath, directory, writing || Boolean(fileAccess));
        let evidenceRoot;
        if (!writing && fileAccess?.jobId && typeof requestedPath === "string" &&
            isAbsolute(requestedPath) && !file) {
          lstatSync(join(directory, ".git"));
          evidenceRoot = resolveEvidenceRoot(directory);
          if (realpathSync.native(evidenceRoot) !== evidenceRoot || protectedPath(evidenceRoot)) {return null;}
          file = contained(requestedPath, evidenceRoot);
        }
        if (!file || protectedPath(file) ||
            (request.resolvedPath && request.resolvedPath !== file)) {
          return null;
        }
        let stat;
        try {
          stat = lstatSync(file);
        } catch (error) {
          if ((!writing && !fileAccess) || error.code !== "ENOENT") {throw error;}
        }
        if (stat && (!stat.isFile() || stat.nlink !== 1)) {return null;}
        const parts = relative(directory, file).split(sep);
        const evidenceParts = evidenceRoot ? relative(evidenceRoot, file).split(sep) :
          parts.slice(0, 3).join("/") === ".git/fixlab/command-evidence" ? parts.slice(3) : [];
        if (!writing && stat && fileAccess?.jobId && evidenceParts.length === 2 &&
            /^\d{8}T\d{6}-[a-f0-9-]{36}$/i.test(evidenceParts[0]) &&
            ["stdout.log", "stderr.log"].includes(evidenceParts[1])) {
          const ownerPath = contained(join(dirname(file), "job.json"), evidenceRoot ?? directory);
          if (!ownerPath || protectedPath(ownerPath)) {return null;}
          const ownerStat = lstatSync(ownerPath);
          if (!ownerStat.isFile() || ownerStat.nlink !== 1 || ownerStat.size > 2048 ||
              stat.size > 1024 * 1024) {return null;}
          let owner;
          try {
            owner = JSON.parse(readFileSync(ownerPath, "utf8"));
          } catch (error) {
            if (error instanceof SyntaxError) {return null;}
            throw error;
          }
          return owner?.jobId === fileAccess.jobId && owner.repository === directory &&
              typeof owner.gateId === "string" && owner.gateId.length > 0 &&
              safeRuntimeText(readFileSync(file, "utf8").replace(/\u001b\[[0-9;]*m/g, ""), 1024 * 1024)
            ? { scope: "repository-reads", key: directory } : null;
        }
        // An auth marker in test source is not an authentication directory or saved state.
        const sourceName = runtimeSourceName(basename(file));
        if (parts.slice(0, -1).some(excludedPart) || excludedPart(sourceName)) {
          return null;
        }
        if (file === join(directory, ".github", "fixlab", "repository-profile.json")) {
          return !writing && safeProfile(file) ? { scope: "repository-reads", key: directory } : null;
        }
        if (writing) {
          if (!sourceExtension.test(extname(file)) || parts[0] === ".github" ||
              /^\.(?:csproj|sln|props|targets|sh|ps1)$/i.test(extname(file)) ||
              /^(?:AGENTS|CLAUDE|GEMINI)\.md$/i.test(basename(file)) ||
              /(?:^|[._-])(?:config|policy|settings)(?:[._-]|$)/i.test(basename(file))) {
            return null;
          }
          return { scope: "repository-source-write", key: directory };
        }
        if (!sourceExtension.test(extname(file)) && basename(file) !== "package.json" &&
            !/^tsconfig(?:\.[\w-]+)?\.json$/.test(basename(file))) {
          return null;
        }
        return { scope: "repository-reads", key: directory };
      }
      if (request.kind === "shell" && fileAccess?.allowValidationGates === true &&
          typeof request.fullCommandText === "string" && !/[\r\n`$;&|<>()]/.test(request.fullCommandText) &&
          Array.isArray(request.possiblePaths) && Array.isArray(request.possibleUrls) &&
          request.possibleUrls.length === 0) {
        const tokens = request.fullCommandText.match(/'[^']*'|"[^"]*"|[^\s'"]+/g);
        if (tokens?.length === 11 && tokens.join(" ") === request.fullCommandText) {
          const args = tokens.map((token) => /^['"]/.test(token) ? token.slice(1, -1) : token);
          const options = new Map();
          for (let index = 3; index < args.length; index += 2) {
            options.set(args[index], args[index + 1]);
          }
          if (args[0] === "node" && trustedHelper(args[1]) && args[2] === "gate" &&
              options.size === 4 && [...options.keys()].every((key) =>
                ["--port", "--job", "--gate", "--resource", "--repository"].includes(key)) &&
              /^\d{1,5}$/.test(options.get("--port")) && Number(options.get("--port")) === dashboardPort &&
              options.get("--job") === fileAccess.jobId && options.get("--repository") === directory &&
              ((options.has("--gate") && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(options.get("--gate"))) ||
                options.get("--resource") === "local-testing") &&
              request.possiblePaths.every((path) => [directory, helperPath].includes(path) &&
                (!request.resolvedPaths?.[path] || request.resolvedPaths[path] === path))) {
            return { scope: "reviewed-validation-gate", key: directory };
          }
        }
      }
      if (request.kind !== "shell" || request.canOfferSessionApproval !== true ||
          !testCommand.test(request.fullCommandText) ||
          /[A-Za-z]:[\\/]|(?:^|[\s=])(?:[/\\]|\.\.(?:[/\\]|\s|$))|[/\\]\.\.(?:[/\\]|$)/.test(request.fullCommandText) ||
          !Array.isArray(request.possiblePaths) || !Array.isArray(request.possibleUrls) ||
          request.possibleUrls.length > 0 || typeof request.resolvedWorkingDirectory !== "string") {
        return null;
      }
      const cwd = request.resolvedWorkingDirectory === directory
        ? directory : contained(request.resolvedWorkingDirectory, directory);
      if (!cwd || !lstatSync(cwd).isDirectory() ||
          relative(directory, cwd).split(sep).some((part) => part.startsWith(".") || sensitiveName.test(part)) ||
          request.possiblePaths.some((path) => {
            const file = typeof path === "string" ? contained(resolve(cwd, path), directory) : null;
            return !file || protectedPath(file) || (request.resolvedPaths?.[path] && request.resolvedPaths[path] !== file) ||
              relative(directory, file).split(sep).some((part) => part.startsWith(".") || sensitiveName.test(part));
          })) {
        return null;
      }
      const manifests = [];
      for (const path of new Set([directory, cwd])) {
        try {
          const manifest = contained(join(path, "package.json"), directory);
          if (!manifest || protectedPath(manifest) || !lstatSync(manifest).isFile() || lstatSync(manifest).size > 256 * 1024) {
            return null;
          }
          manifests.push(createHash("sha256").update(readFileSync(manifest)).digest("hex"));
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          manifests.push("absent");
        }
      }
      return {
        scope: "exact-test-command",
        key: JSON.stringify([directory, cwd, request.fullCommandText,
          request.possiblePaths, request.possibleUrls, request.commandSegments, manifests])
      };
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EINVAL", "ELOOP"].includes(error.code)) {
        return null;
      }
      throw error;
    }
  }

  return {
    observeToolEvent(event) {
      if (["session.idle", "session.error", "session.shutdown"].includes(event?.type)) {
        liveTools.clear();
        return;
      }
      const id = event?.data?.toolCallId;
      if (typeof id !== "string" || id.length > 200) { return; }
      if (event.type === "tool.execution_start") {
        if (liveTools.size >= 8) { liveTools.clear(); }
        liveTools.set(id, { ...event.data, started: Date.now() });
      } else if (event.type === "tool.execution_complete") {
        liveTools.delete(id);
      }
    },
    clear() {
      liveTools.clear();
      reads = null;
      commands.clear();
    },
    automaticApproval(request, prompt) {
      return checkpointRead(request, prompt) ?? candidate(request, prompt, true)?.key ?? null;
    },
    review(request, prompt) {
      const match = candidate(request, prompt);
      return ["repository-reads", "exact-test-command"].includes(match?.scope) ? match : null;
    },
    scopeFor(request, prompt) {
      const match = candidate(request, prompt);
      return ["repository-reads", "exact-test-command"].includes(match?.scope) ? match.scope : null;
    },
    isSourceFile(path) {
      return candidate({ kind: "write", fileName: path }, { canApprove: true })?.scope === "repository-source-write";
    },
    reviewSourceEdit(request, prompt) {
      if (request.kind !== "write" || prompt.canApprove || prompt.canUseFileTrust !== true ||
          prompt.canRecover !== true || prompt.blockedReasons?.length !== 1 ||
          prompt.blockedReasons[0] !== "oversized" ||
          candidate(request, { ...prompt, canApprove: true })?.scope !== "repository-source-write") {
        return null;
      }
      const fileName = relative(root(), resolve(root(), request.fileName));
      if (!safeRuntimeText(fileName, 400)) { return null; }
      return {
        fileName,
        reviewCharacters: prompt.reviewCharacters
      };
    },
    allows(request, prompt) {
      const match = candidate(request, prompt);
      return Boolean(match && (match.scope === "repository-reads"
        ? reads === match.key || (fileAccess?.repository === match.key &&
          ["source-read", "source-read-write"].includes(fileAccess.mode))
        : match.scope === "repository-source-write"
          ? fileAccess?.repository === match.key && fileAccess.mode === "source-read-write"
          : match.scope === "reviewed-validation-gate"
            ? fileAccess?.repository === match.key && fileAccess.allowValidationGates === true
            : commands.has(match.key)));
    },
    grant(request, prompt, scope, reviewed) {
      const match = candidate(request, prompt);
      if (!match || !["repository-reads", "exact-test-command"].includes(scope) ||
          match.scope !== scope || reviewed?.scope !== scope || reviewed.key !== match.key ||
          (scope === "exact-test-command" && commands.size >= 16)) {
        throw new Error("This request cannot receive the selected job-scoped grant. Review it again or allow once.");
      }
      if (scope === "repository-reads") {
        reads = match.key;
      } else {
        commands.add(match.key);
      }
    }
  };
}
