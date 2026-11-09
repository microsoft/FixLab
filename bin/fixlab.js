#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { componentRetrievalGuidance } from "../dashboard/affected-surface.js";
import { createInterface } from "node:readline/promises";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  buildAgencyInvocation,
  buildCopilotInvocation,
  copilotModelArguments,
  configuredValidationEnvironments,
  configuredTestSynthesis,
  createDashboardServer,
  DEFAULT_DASHBOARD_PORT,
  FIXLAB_RUNTIMES,
  HYDRAFUSION_MODEL,
  inspectRepository,
  linkedDependencyDirectories,
  validateCopilotModel,
  validateTargetEnvironment,
  validateLiveTestProfile,
  validatePort
} from "../dashboard/server.js";
import { runChat } from "../dashboard/chat.js";
import { probeTimeoutMs, runJobPreflight } from "../dashboard/preflight.js";
import {
  parseKeepAwakeMinutes,
  runKeepAwake,
  startKeepAwake,
  stopKeepAwake
} from "./keep-awake.js";
import { runStructuredCommand } from "./structured-command.js";
import {
  applyWorktreeSetup,
  browserConfigurationErrors,
  planWorktreeSetup,
  REPOSITORY_PROMPT_NAMES
} from "../dashboard/repository-setup.js";
import { runValidationGate } from "./validation-gate-client.js";
import { installNotifications } from "./notifications.js";
import { linkedApiProofPlan, runLinkedApiProof } from "../dashboard/linked-api-proof.js";
import { runPortalApiProof } from "../dashboard/portal-api-proof.js";
import { configuredWorkflow, efficientWorkflowGuidance, allowsDraftIntegrationDeferral, UNVERIFIED_DRAFT_GUIDANCE, OPTIONAL_INTEGRATION_GUIDANCE, AUTONOMOUS_RECOVERY_GUIDANCE, DRAFT_INTEGRATION_GUIDANCE, COPILOT_EXECUTION_GUIDANCE, RUNTIME_RECOVERY_GUIDANCE, READ_ONLY_POST_GUIDANCE, API_ONLY_PLAYWRIGHT_GUIDANCE, UNIT_TEST_ONLY_GUIDANCE, TRANSIENT_PLAYWRIGHT_GUIDANCE, CONCISE_PR_GUIDANCE, PR_LEARNING_GUIDANCE } from "../dashboard/workflow-policy.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileRelativePath = join(
  ".github",
  "fixlab",
  "repository-profile.json"
);
const promptNames = REPOSITORY_PROMPT_NAMES;
const vscodeAgentName = "fixlab-autofix.agent.md";
const troubleshootingUrl =
  "https://github.com/microsoft/FixLab/blob/main/docs/troubleshooting.md";

function printTroubleshooting() {
  console.error(`Troubleshooting: ${troubleshootingUrl}`);
}

function redactCommandForDisplay(command) {
  return String(command)
    .replace(
      /((?:password|passwd|secret|token|authorization|bearer|cookie|client[-_]?secret|api[-_]?key)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(--(?:password|passwd|secret|token|authorization|bearer|cookie|client-secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

function printUsage() {
  console.log(`FixLab CLI

Usage:
  fixlab <repository> [--runtime <agency|copilot>] [--model <model>]
  fixlab onboard [repository] [--from <source-checkout>] [--yes] [--authenticate] [--start-dashboard] [--runtime <agency|copilot>] [--model <model>]
  fixlab init [repository]
  fixlab notifications [repository] [--yes]
  fixlab prepare [repository] [--yes]
  fixlab doctor [repository] [--runtime <agency|copilot>]
  fixlab setup-playwright [repository] [--yes]
  fixlab authenticate [repository] [--yes]
  fixlab linked-api-proof [repository] [--authenticate|--proof] [--yes]
  fixlab portal-api-proof [repository] [--authenticate|--proof] --yes
  fixlab exec [repository] [--cwd <path>] [--stage <name>] [--reuse] [--timeout-seconds <seconds>] -- <command> [args...]
  fixlab gate --port <port> --job <id> --gate <id> --repository <worktree>
  fixlab run [repository] [--runtime <agency|copilot>] [--model <model>] [--environment <name>] [--] [request...]
  fixlab validate [repository] --pr <number> [--runtime <agency|copilot>] [--model <model>]
  fixlab dashboard [repository] [--port <number>] [--open|--no-open] [--keep-awake-minutes <minutes>] [--runtime <agency|copilot>] [--model <model>]
  fixlab chat [repository] [--port <number>] [--runtime <agency|copilot>] [--model <model>]
  fixlab keep-awake --minutes <minutes>
  fixlab --help

Commands:
  <repository>
            Open an interactive FixLab shell for setup, fixes, and validation.
  onboard   Run the plan-first repository onboarding workflow.
  init      Add the FixLab repository profile template.
  notifications
            Plan or install change-only Copilot notifications (no AI polling).
  prepare   Plan or run repository-owned frontend and backend restore commands.
  doctor    Check required tools and repository configuration.
  setup-playwright
            Plan or install Playwright; API-only profiles need no browser.
  authenticate
            Plan or run the repository-owned browser or API authentication command.
  linked-api-proof
            Request fresh API proof from an explicitly linked frontend owner.
  portal-api-proof
            Run the portal-owned in-memory APIRequestContext authentication helper.
  exec      Run a command with compact structured output and private evidence.
  gate      Run a profile-defined validation gate owned by a dashboard job.
  run       Launch the FixLab agent for a request.
  validate  Launch validation-only mode for a pull request.
  dashboard Start the local FixLab dashboard (127.0.0.1:${DEFAULT_DASHBOARD_PORT}).
  chat      Chat with the active dashboard job, starting it when necessary.
  keep-awake
            Temporarily prevent system sleep for a bounded number of minutes.

Runtime:
  agency    Use Agency Copilot (default).
  copilot   Use GitHub Copilot CLI directly.

Set FIXLAB_RUNTIME or pass --runtime to select the runtime.
Set FIXLAB_MODEL or pass --model to select a GitHub Copilot CLI model.
HydraFusion research preview: --runtime copilot --model ${HYDRAFUSION_MODEL}.
Run with --environment to select an allowed non-production environment from the repository profile.
Run with --draft-without-checks for an unverified draft, --skip-live-tests to defer integration, or --deployed-backend to use the approved non-production API without local .NET.
For the Agency-like interactive experience, run FixLab with only the repository path.

Troubleshooting:
  ${troubleshootingUrl}`);
}

function resolveRepository(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
    throw new Error(
      'Repository argument must be a local directory, not a URL. Run FixLab from the local clone; to validate a pull request, use "fixlab validate --pr <number> --runtime agency".'
    );
  }
  return resolve(value && !value.startsWith("-") ? value : process.cwd());
}

function findExecutable(command) {
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", shell: false, windowsHide: true }
  );
  return result.status === 0;
}

function checkDotnetSdk(repository) {
  if (!findExecutable("dotnet")) {
    return {
      name: ".NET SDK",
      ok: false,
      detail: "dotnet"
    };
  }

  const result = spawnSync("dotnet", ["--version"], {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const version = result.stdout?.trim();
  if (result.status === 0 && version) {
    return {
      name: ".NET SDK",
      ok: true,
      detail: version
    };
  }

  const globalJsonPath = join(repository, "global.json");
  if (existsSync(globalJsonPath)) {
    try {
      const requiredVersion = JSON.parse(
        readFileSync(globalJsonPath, "utf8")
      )?.sdk?.version;
      if (typeof requiredVersion === "string" && requiredVersion.trim()) {
        return {
          name: ".NET SDK",
          ok: false,
          detail: `requires ${requiredVersion.trim()} from ${globalJsonPath}`
        };
      }
    } catch (error) {
      return {
        name: ".NET SDK",
        ok: false,
        detail: `global.json is invalid JSON: ${error.message}`
      };
    }
  }

  return {
    name: ".NET SDK",
    ok: false,
    detail:
      result.error?.message ??
      result.stderr?.trim().split(/\r?\n/, 1)[0] ??
      "dotnet --version failed"
  };
}

function checkPackageManager(command, workingDirectory) {
  const match = command?.match(
    /^\s*(npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\b/i
  );
  if (!match) {
    return null;
  }

  const manager = match[1];
  const timeout = probeTimeoutMs();
  const result = spawnSync(`${manager} --version`, {
    cwd: workingDirectory,
    encoding: "utf8",
    shell: true,
    timeout,
    windowsHide: true
  });
  const version = result.stdout?.trim();
  let failure =
    result.error?.message ??
    result.stderr?.trim().split(/\r?\n/, 1)[0] ??
    `${manager} --version failed`;
  const timedOut = (error) =>
    error?.code === "ETIMEDOUT"
      ? `${error.message} after ${timeout} ms; set FIXLAB_DOCTOR_TIMEOUT_MS to allow more time on a slow machine`
      : error?.message;
  failure = timedOut(result.error) ?? failure;
  if (result.status === 0 && version) {
    if (/^npm(?:\.cmd)?$/i.test(manager)) {
      const integrityResult = spawnSync(
        `${manager} pack --dry-run --ignore-scripts --json`,
        {
          cwd: packageRoot,
          encoding: "utf8",
          shell: true,
          timeout,
          windowsHide: true
        }
      );
      const integrityOutput = [
        integrityResult.stdout,
        integrityResult.stderr
      ].filter(Boolean).join("\n");
      const internalFailure = integrityOutput.match(
        /(?:Class extends value undefined|(?:TypeError|ReferenceError|SyntaxError):)[^\r\n]*/i
      );
      if (!integrityResult.error && !internalFailure) {
        return {
          name: "Frontend package manager",
          ok: true,
          detail: `${manager} ${version}`
        };
      }
      failure =
        timedOut(integrityResult.error) ??
        internalFailure?.[0]?.replace(/[",]+$/, "") ??
        "npm dependency graph probe failed internally";
    } else {
      return {
        name: "Frontend package manager",
        ok: true,
        detail: `${manager} ${version}`
      };
    }
  }

  return {
    name: "Frontend package manager",
    ok: false,
    detail: `${failure}. Run "${manager} --version" and "${manager} pack --dry-run --ignore-scripts --json" in this shell, then align the active Node.js and ${manager} installation before retrying`
  };
}

function loadProfile(repository) {
  const profilePath = join(repository, profileRelativePath);
  if (!existsSync(profilePath)) {
    return { profilePath, profile: null, error: "profile is missing" };
  }

  try {
    return {
      profilePath,
      profile: JSON.parse(readFileSync(profilePath, "utf8")),
      error: null
    };
  } catch (error) {
    return {
      profilePath,
      profile: null,
      error: `profile is invalid JSON: ${error.message}`
    };
  }
}

function playwrightWorkingDirectoryError(workingDirectory) {
  const exists = existsSync(workingDirectory);
  if (exists && statSync(workingDirectory).isDirectory()) {
    return null;
  }
  return [
    `working directory is ${exists ? "not a directory" : "missing"}: ${workingDirectory}.`,
    `Update browserAutomation.workingDirectory (or its applications.frontend.workingDirectory fallback) in ${profileRelativePath} to the actual existing application or test directory, relative to the repository root.`,
    "The template's frontend path is an example. Do not create an empty frontend folder to satisfy this check."
  ].join(" ");
}

function checkPlaywright(repository, profile) {
  const configuration = profile?.browserAutomation ?? {};
  const apiOnly = configuration.mode === "api";
  const runtimeName = apiOnly ? "Playwright API" : "Playwright browser";
  const workingDirectory = resolve(
    repository,
    configuration.workingDirectory ??
      profile?.applications?.frontend?.workingDirectory ??
      "."
  );
  const preferredPackage = configuration.package;
  const packages = [
    preferredPackage,
    "@playwright/test",
    "playwright"
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const browserName = configuration.browser ?? "chromium";
  const browserChannel = configuration.channel;

  const directoryError = playwrightWorkingDirectoryError(workingDirectory);
  if (directoryError) {
    return {
      packageCheck: { name: "Playwright package", ok: false, detail: directoryError },
      browserCheck: { name: runtimeName, ok: false, detail: directoryError }
    };
  }

  const packageProbe = `
    const packages = ${JSON.stringify(packages)};
    for (const name of packages) {
      try {
        require.resolve(name);
        process.stdout.write(name);
        process.exit(0);
      } catch {}
    }
    process.stderr.write("install @playwright/test in the configured working directory");
    process.exit(1);
  `;
  const packageResult = spawnSync(process.execPath, ["-e", packageProbe], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  const resolvedPackage = packageResult.stdout?.trim();
  const packageCheck = {
    name: "Playwright package",
    ok: packageResult.status === 0 && Boolean(resolvedPackage),
    detail:
      packageResult.error?.message ??
      (resolvedPackage ||
        packageResult.stderr?.trim() ||
        "package resolution failed")
  };

  if (!packageCheck.ok) {
    packageCheck.detail += `; verify browserAutomation.workingDirectory in ${profileRelativePath} points to the real application or test directory before reviewing "fixlab setup-playwright". An empty frontend folder does not configure the application.`;
    return {
      packageCheck,
      browserCheck: {
        name: runtimeName,
        ok: false,
        detail: "not checked because the Playwright package is unavailable"
      }
    };
  }

  if (apiOnly) {
    const apiProbe = `
      const { request } = require(${JSON.stringify(resolvedPackage)});
      (async () => {
        const context = await request.newContext();
        await context.dispose();
        process.stdout.write("APIRequestContext initialized without a browser");
      })().catch(() => {
        process.stderr.write("Playwright APIRequestContext initialization failed");
        process.exit(1);
      });
    `;
    const apiResult = spawnSync(process.execPath, ["-e", apiProbe], {
      cwd: workingDirectory,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    const expected = "APIRequestContext initialized without a browser";
    return {
      packageCheck,
      browserCheck: {
        name: runtimeName,
        ok: apiResult.status === 0 && apiResult.stdout === expected,
        detail: apiResult.status === 0 && apiResult.stdout === expected
          ? expected
          : "Playwright APIRequestContext initialization failed; verify the configured package"
      }
    };
  }

  const browserProbe = `
    const playwright = require(${JSON.stringify(resolvedPackage)});
    const browserType = playwright[${JSON.stringify(browserName)}];
    if (!browserType || typeof browserType.launch !== "function") {
      throw new Error("configured browser is not exported by Playwright");
    }
    (async () => {
      const browser = await browserType.launch({
        headless: true,
        ...(${JSON.stringify(browserChannel)} ? { channel: ${JSON.stringify(browserChannel)} } : {})
      });
      await browser.close();
      process.stdout.write(${JSON.stringify(
        browserChannel ? `${browserName}:${browserChannel}` : browserName
      )});
    })().catch((error) => {
      process.stderr.write(error.message);
      process.exit(1);
    });
  `;
  const browserResult = spawnSync(process.execPath, ["-e", browserProbe], {
    cwd: workingDirectory,
    encoding: "utf8",
    timeout: 45000,
    windowsHide: true
  });
  const launchedBrowser = browserResult.stdout?.trim();
  const expectedBrowser = browserChannel
    ? `${browserName}:${browserChannel}`
    : browserName;
  const browserCheck = {
    name: "Playwright browser",
    ok: browserResult.status === 0 && launchedBrowser === expectedBrowser,
    detail:
      browserResult.error?.message ??
      (launchedBrowser
        ? `${launchedBrowser.replace(":", " channel ")} launched successfully`
        : browserResult.stderr?.trim() ??
          "browser launch failed; install the configured Playwright browser")
  };

  return { packageCheck, browserCheck };
}

function init(repository) {
  const destination = join(repository, profileRelativePath);
  let created = 0;
  if (existsSync(destination)) {
    console.log(`Kept existing FixLab profile: ${destination}`);
    console.log(
      "Existing profiles are preserved and are not upgraded automatically. Run fixlab doctor and merge newly required fields from the current profile template."
    );
    try {
      const profile = JSON.parse(readFileSync(destination, "utf8"));
      if (profile?.browserAutomation?.testSynthesis === undefined) {
        console.log(
          "Profile upgrade required: add browserAutomation.testSynthesis with an approved data source, mutation mode, and scenario evidence requirement."
        );
      }
    } catch {
      console.log(
        "The existing profile could not be parsed; fix its JSON before running fixlab doctor."
      );
    }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      join(packageRoot, "templates", "repository-profile.json"),
      destination
    );
    console.log(`Created ${destination}`);
    created += 1;
  }

  const promptDirectory = join(repository, ".github", "prompts");
  mkdirSync(promptDirectory, { recursive: true });
  for (const promptName of promptNames) {
    const promptDestination = join(promptDirectory, promptName);
    if (existsSync(promptDestination)) {
      console.log(`Kept existing FixLab prompt: ${promptDestination}`);
      continue;
    }
    copyFileSync(join(packageRoot, "prompts", promptName), promptDestination);
    console.log(`Created ${promptDestination}`);
    created += 1;
  }

  const agentDirectory = join(repository, ".github", "agents");
  const agentDestination = join(agentDirectory, vscodeAgentName);
  if (existsSync(agentDestination)) {
    console.log(`Kept existing FixLab agent: ${agentDestination}`);
  } else {
    mkdirSync(agentDirectory, { recursive: true });
    copyFileSync(
      join(packageRoot, "templates", "fixlab-autofix.agent.md"),
      agentDestination
    );
    console.log(`Created ${agentDestination}`);
    created += 1;
  }

  console.log(
    created > 0
      ? `Created ${created} FixLab repository file(s).`
      : "FixLab repository setup is already present."
  );
  console.log("Update its paths, commands, ports, and allowed environments.");
  console.log(
    "The frontend and backend directories are example paths, not folders to create. Configure the actual application and test paths in the repository profile."
  );
  console.log("Do not create empty application folders to satisfy Doctor.");
  return 0;
}

function validateRuntime(value) {
  const runtime = String(value ?? "").trim().toLowerCase();
  if (!FIXLAB_RUNTIMES.includes(runtime)) {
    throw new Error(
      `runtime must be one of: ${FIXLAB_RUNTIMES.join(", ")}`
    );
  }
  return runtime;
}

function parseRuntimeArguments(args) {
  let runtime;
  let model = process.env.FIXLAB_MODEL ?? "";
  try {
    runtime = validateRuntime(process.env.FIXLAB_RUNTIME ?? "agency");
  } catch (error) {
    return { error: `FIXLAB_RUNTIME ${error.message}` };
  }
  const remaining = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      afterSeparator = true;
      remaining.push(argument);
      continue;
    }
    if (!afterSeparator && argument === "--runtime") {
      if (!args[index + 1]) {
        return { error: "--runtime requires agency or copilot" };
      }
      try {
        runtime = validateRuntime(args[index + 1]);
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (!afterSeparator && argument.startsWith("--runtime=")) {
      try {
        runtime = validateRuntime(argument.slice("--runtime=".length));
      } catch (error) {
        return { error: error.message };
      }
      continue;
    }
    if (!afterSeparator && argument === "--model") {
      if (!args[index + 1]) {
        return { error: "--model requires a model identifier" };
      }
      model = args[index + 1];
      index += 1;
      continue;
    }
    if (!afterSeparator && argument.startsWith("--model=")) {
      model = argument.slice("--model=".length);
      if (!model) {
        return { error: "--model requires a model identifier" };
      }
      continue;
    }
    remaining.push(argument);
  }
  try {
    model = validateCopilotModel(model, runtime);
  } catch (error) {
    return { error: error.message };
  }
  return { runtime, model, args: remaining };
}

function doctor(repository, runtime) {
  const checks = [
    ["Git", "git"],
    ["Node.js", "node"],
    ["PowerShell", "pwsh"],
    [runtime === "copilot" ? "GitHub Copilot CLI" : "Agency", runtime]
  ].map(([name, command]) => ({
    name,
    ok: findExecutable(command),
    detail: command
  }));
  checks.splice(2, 0, checkDotnetSdk(repository));

  const { profilePath, profile, error } = loadProfile(repository);
  checks.push({
    name: "Repository profile",
    ok: Boolean(profile),
    detail: error ?? profilePath
  });
  const grantedDirectories = new Set(linkedDependencyDirectories(repository));
  const unapprovedDirectories = linkedDependencyDirectories(repository, { discover: true })
    .filter((directory) => !grantedDirectories.has(directory));
  checks.push({
    name: "Runtime dependency access",
    ok: unapprovedDirectories.length === 0,
    detail: unapprovedDirectories.length
      ? `unapproved linked dependencies: ${unapprovedDirectories.join(", ")}; review fixlab onboard "${repository}" --runtime ${runtime}, then approve with --yes`
      : "no unapproved external dependency directories"
  });
  const frontendWorkingDirectory = resolve(
    repository,
    profile?.applications?.frontend?.workingDirectory ?? "."
  );
  const packageManager = checkPackageManager(
    profile?.validation?.commands?.frontendRestore,
    existsSync(frontendWorkingDirectory) && statSync(frontendWorkingDirectory).isDirectory()
      ? frontendWorkingDirectory : repository
  );
  if (packageManager) {
    checks.push(packageManager);
  }
  const liveTestProfile = profile
    ? validateLiveTestProfile(profile, repository)
    : { ok: false, detail: "not checked because the repository profile is unavailable" };
  checks.push({
    name: profile?.validation?.liveTestsRequired === false ? "Unit-test validation profile" : "Live-test profile",
    ok: liveTestProfile.ok,
    detail: liveTestProfile.detail
  });
  checks.push({
    name: "Git repository",
    ok: existsSync(join(repository, ".git")),
    detail: repository
  });
  if (profile?.validation?.liveTestsRequired !== false) {
    const playwright = checkPlaywright(repository, profile);
    checks.push(playwright.packageCheck, playwright.browserCheck);
  }

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} (${check.detail})`);
  }

  console.log(profile?.validation?.liveTestsRequired === false
    ? "SKIP  Live tests and authentication (explicit repository unit-test-only policy; no integration coverage)."
    : profile?.browserAutomation?.mode === "api"
    ? "Doctor does not prove API health or API authentication. Live validation needs the owning job's fresh API proof."
    : "Doctor does not prove an authenticated browser session. Required sign-in needs the owning job's fresh authentication proof.");
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`FixLab doctor found ${failed.length} blocking check(s).`);
    if (
      !liveTestProfile.ok &&
      liveTestProfile.detail.includes("authentication is not ready") &&
      profile?.browserAutomation?.authentication?.command
    ) {
      const authenticationDirectory = resolve(
        repository,
        profile.browserAutomation.workingDirectory
      );
      const authenticationCommand = redactCommandForDisplay(
        profile.browserAutomation.authentication.command
      );
      console.error(
        `Next action: run "${authenticationCommand}" from "${authenticationDirectory}", complete interactive sign-in, then rerun Doctor.`
      );
      if (
        Object.keys(
          profile.browserAutomation.authentication.environment ?? {}
        ).length > 0
      ) {
        console.error(
          "Set the browserAutomation.authentication.environment values from the repository profile before running the authentication command."
        );
      }
    }
    printTroubleshooting();
    return 1;
  }

  console.log(`FixLab configuration checks passed for ${profile.name ?? repository}.`);
  return 0;
}

function prepare(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot prepare repository because ${error}. Run "fixlab init ${repository}" first.`
    );
    printTroubleshooting();
    return 1;
  }

  const commands = profile.validation?.commands ?? {};
  const steps = [
    ["frontend", commands.frontendRestore],
    ["backend", commands.backendRestore]
  ]
    .filter(([, command]) => typeof command === "string" && command.trim())
    .map(([application, command]) => ({
      application,
      command: command.trim(),
      workingDirectory: resolve(
        repository,
        profile.applications?.[application]?.workingDirectory ?? "."
      )
    }));

  if (steps.length === 0) {
    console.error(
      "Repository profile has no frontendRestore or backendRestore command."
    );
    printTroubleshooting();
    return 1;
  }

  for (const step of steps) {
    if (!existsSync(step.workingDirectory)) {
      console.error(
        `${step.application} restore directory is missing: ${step.workingDirectory}`
      );
      printTroubleshooting();
      return 1;
    }
  }

  console.log("Repository preparation plan:");
  for (const step of steps) {
    console.log(
      `  ${step.application}: ${step.command} (${step.workingDirectory})`
    );
  }

  if (!approved) {
    console.log(
      "No commands executed. Review the plan and rerun with --yes to prepare the repository."
    );
    return 0;
  }

  const checkedPackageManagers = new Set();
  for (const step of steps) {
    const packageManager = checkPackageManager(
      step.command,
      step.workingDirectory
    );
    if (!packageManager || checkedPackageManagers.has(packageManager.detail)) {
      continue;
    }
    checkedPackageManagers.add(packageManager.detail);
    console.log(
      `${packageManager.ok ? "PASS" : "FAIL"}  ${packageManager.name} (${packageManager.detail})`
    );
    if (!packageManager.ok) {
      console.error(
        "Repository preparation stopped before dependency restore because the configured package manager is not runnable."
      );
      printTroubleshooting();
      return 1;
    }
  }

  for (const step of steps) {
    const result = spawnSync(step.command, {
      cwd: step.workingDirectory,
      stdio: "inherit",
      shell: true,
      windowsHide: true
    });
    if (result.status !== 0) {
      console.error(
        `${step.application} restore failed: ${step.command}`
      );
      printTroubleshooting();
      return result.status ?? 1;
    }
    console.log(`PASS  ${step.application} restore (${step.command})`);
  }

  console.log("Repository preparation completed.");
  return 0;
}

function detectPackageManager(workingDirectory) {
  if (existsSync(join(workingDirectory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(workingDirectory, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function playwrightSetupCommands(packageManager, packageName, browserTarget) {
  if (packageManager === "pnpm") {
    return [
      ["pnpm", ["add", "--save-dev", packageName]],
      ["pnpm", ["exec", "playwright", "install", browserTarget]]
    ];
  }
  if (packageManager === "yarn") {
    return [
      ["yarn", ["add", "--dev", packageName]],
      ["yarn", ["playwright", "install", browserTarget]]
    ];
  }
  return [
    ["npm", ["install", "--save-dev", packageName]],
    ["npx", ["playwright", "install", browserTarget]]
  ];
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function setupPlaywright(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot set up Playwright because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }

  const configuration = profile.browserAutomation ?? {};
  if (configuration.mode !== undefined && !["browser", "api"].includes(configuration.mode)) {
    console.error("browserAutomation.mode must be browser or api before Playwright setup.");
    return 1;
  }
  const workingDirectory = resolve(
    repository,
    configuration.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      "."
  );
  const directoryError = playwrightWorkingDirectoryError(workingDirectory);
  if (directoryError) {
    console.error(`Playwright ${directoryError}`);
    printTroubleshooting();
    return 1;
  }

  const packageName = configuration.package ?? "@playwright/test";
  const browserTarget = configuration.channel ?? configuration.browser ?? "chromium";
  const current = checkPlaywright(repository, profile);
  if (current.packageCheck.ok && current.browserCheck.ok) {
    console.log(`Playwright is already ready in ${workingDirectory}.`);
    console.log(`PASS  ${current.packageCheck.name} (${current.packageCheck.detail})`);
    console.log(`PASS  ${current.browserCheck.name} (${current.browserCheck.detail})`);
    return 0;
  }

  const packageManager = detectPackageManager(workingDirectory);
  if (!findExecutable(packageManager)) {
    console.error(`Required package manager is unavailable: ${packageManager}`);
    return 1;
  }

  const commands = playwrightSetupCommands(
    packageManager,
    packageName,
    browserTarget
  ).filter((_, index) => index === 0
    ? !current.packageCheck.ok
    : configuration.mode !== "api");

  console.log(`Playwright setup directory: ${workingDirectory}`);
  console.log(`Detected package manager: ${packageManager}`);
  console.log("Planned commands:");
  for (const [command, args] of commands) {
    console.log(`  ${formatCommand(command, args)}`);
  }

  if (!approved) {
    console.log("No changes made. Review the commands and rerun with --yes to execute them.");
    return 0;
  }

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: workingDirectory,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true
    });
    if (result.status !== 0) {
      console.error(`Playwright setup failed: ${formatCommand(command, args)}`);
      return result.status ?? 1;
    }
  }

  const verified = checkPlaywright(repository, profile);
  for (const check of [verified.packageCheck, verified.browserCheck]) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} (${check.detail})`);
  }
  if (!verified.packageCheck.ok || !verified.browserCheck.ok) {
    console.error("Playwright installation completed but verification failed.");
    return 1;
  }

  console.log(configuration.mode === "api"
    ? "Playwright API setup and request-context verification completed; no browser installed."
    : "Playwright setup and browser launch verification completed.");
  return 0;
}

function authenticate(repository, approved) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot authenticate because ${error}. Run "fixlab init ${repository}" first.`
    );
    printTroubleshooting();
    return 1;
  }

  const browserAutomation = profile.browserAutomation ?? {};
  if (browserAutomation.apiAuthentication?.productionDatabaseReadOnly &&
      browserAutomation.mode !== "api") {
    console.error("Production database approval permits dedicated portal-api-proof only, not ordinary portal UI authentication.");
    return 1;
  }
  const authenticationLabel = browserAutomation.mode === "api" ? "API" : "Browser";
  const authentication = browserAutomation.authentication ?? {};
  if (
    authentication.required !== true ||
    typeof authentication.command !== "string" ||
    !authentication.command.trim()
  ) {
    console.error(
      `Repository profile does not define a required ${authenticationLabel.toLowerCase()} authentication command.`
    );
    printTroubleshooting();
    return 1;
  }

  const workingDirectory = resolve(
    repository,
    browserAutomation.workingDirectory ??
      profile.applications?.frontend?.workingDirectory ??
      "."
  );
  if (!existsSync(workingDirectory)) {
    console.error(
      `${authenticationLabel} authentication working directory is missing: ${workingDirectory}`
    );
    printTroubleshooting();
    return 1;
  }

  const command = authentication.command.trim();
  const authenticationEnvironment = authentication.environment ?? {};
  console.log(`${authenticationLabel} authentication plan:`);
  console.log(`  command: ${redactCommandForDisplay(command)}`);
  console.log(`  working directory: ${workingDirectory}`);
  const environmentNames = Object.keys(authenticationEnvironment);
  if (environmentNames.length > 0) {
    console.log(`  environment: ${environmentNames.join(", ")}`);
  }

  if (!approved) {
    console.log(
      "No command executed. Review the plan and rerun with --yes to start interactive authentication."
    );
    return 0;
  }

  const result = spawnSync(command, {
    cwd: workingDirectory,
    env: { ...process.env, ...authenticationEnvironment },
    stdio: "inherit",
    shell: true,
    windowsHide: true
  });
  if (result.status !== 0) {
    console.error(`${authenticationLabel} authentication failed with exit code ${result.status ?? 1}.`);
    printTroubleshooting();
    return result.status ?? 1;
  }

  const missingStatusPaths = (authentication.statusPaths ?? [])
    .map((statusPath) => resolve(workingDirectory, statusPath))
    .filter((statusPath) => !existsSync(statusPath));
  if (missingStatusPaths.length > 0) {
    console.error(
      `${authenticationLabel} authentication command completed, but required state is missing: ${missingStatusPaths.join(", ")}`
    );
    printTroubleshooting();
    return 1;
  }

  console.log(browserAutomation.mode === "api"
    ? "API authentication helper completed and its status is present; this does not replace the owning job's fresh API proof."
    : "Browser authentication helper completed and required state is present; this does not prove sign-in. Run the repository-owned authenticated browser proof for the selected job and environment.");
  return 0;
}

function launch(repository, request, runtime, targetEnvironment = "", model = "", readOnly = false, interactiveRequest = "", choices = {}) {
  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(
      `Cannot launch FixLab because ${error}. Run "fixlab init ${repository}" first.`
    );
    return 1;
  }
  if (profile.browserAutomation?.apiAuthentication?.productionDatabaseReadOnly ||
      profile.browserAutomation?.testSynthesis?.defaultDataSource === "production-read-only") {
    console.error("Production-backed API jobs require dashboard-owned, fresh job-bound authentication and the database read-only check. Use fixlab dashboard or fixlab chat; direct run/validate does not grant production access.");
    return 1;
  }
  if (profile.worktreeSetup?.mode === "shared" && !readOnly) {
    console.error(
      "Shared worktree jobs require dashboard-owned branch acquisition and resumption. Use fixlab dashboard or fixlab chat for this repository."
    );
    return 1;
  }

  let selectedEnvironment;
  let workflow;
  let testEvidence;
  try {
    workflow = configuredWorkflow(profile);
    selectedEnvironment = validateTargetEnvironment(
      targetEnvironment,
      configuredValidationEnvironments(profile)
    );
    testEvidence = configuredTestSynthesis(profile, "", undefined, selectedEnvironment);
    if (choices.useDeployedBackend && (!/^(dev|development|ppe|sit|uat)$/iu.test(selectedEnvironment) ||
        testEvidence.unitTestsOnly)) {
      throw new Error("--deployed-backend requires an explicitly selected, profile-approved DEV/SIT/UAT/PPE environment permitting live access.");
    }
    if (choices.deferValidation || choices.skipLiveTests) {
      workflow = { ...workflow, publication: "draft" };
    }
  } catch (validationError) {
    console.error(validationError.message);
    return 1;
  }

  if (!findExecutable(runtime)) {
    console.error(
      `Cannot launch FixLab because ${runtime} is unavailable. Install and authenticate the selected runtime first.`
    );
    return 1;
  }

  const guidance = [
    COPILOT_EXECUTION_GUIDANCE,
    ...(request ? [RUNTIME_RECOVERY_GUIDANCE] : []),
    // Interactive sessions use packaged guidance; request prompts go through stdin.
    ...(request && profile.validation?.liveTestsRequired !== false &&
      profile.browserAutomation?.mode !== "api" ? [READ_ONLY_POST_GUIDANCE] : []),
    ...(request ? [componentRetrievalGuidance(profile, request)] : []),
    ...(profile.validation?.liveTestsRequired === false ? [UNIT_TEST_ONLY_GUIDANCE] : []),
    ...(readOnly ? [TRANSIENT_PLAYWRIGHT_GUIDANCE] : []),
    ...(!readOnly ? [CONCISE_PR_GUIDANCE] : []),
    ...(!readOnly && request ? [PR_LEARNING_GUIDANCE] : []),
    ...(!readOnly && request && !choices.deferValidation ? [AUTONOMOUS_RECOVERY_GUIDANCE] : []),
    ...(profile.browserAutomation?.mode === "api" ? [API_ONLY_PLAYWRIGHT_GUIDANCE] : []),
    ...(request && !choices.deferValidation && allowsDraftIntegrationDeferral({ mode: readOnly ? "validate-only" : "fix-and-validate", workflow })
      ? [DRAFT_INTEGRATION_GUIDANCE] : []),
    ...(choices.deferValidation ? [UNVERIFIED_DRAFT_GUIDANCE] : []),
    ...(choices.skipLiveTests || choices.useDeployedBackend || choices.deferValidation
      ? [OPTIONAL_INTEGRATION_GUIDANCE,
        `Selected job choices: deferValidation=${choices.deferValidation === true}; skipLiveTests=${choices.skipLiveTests === true || choices.deferValidation === true}; useDeployedBackend=${choices.useDeployedBackend === true}.`] : []),
    "For known external-folder prerequisites, offer permissionPreflight before executor launch; it only opens review, never grants access. Use reviewed component path-to-gate policies for change-aware validation; unknown paths, full-validation paths, explicit full coverage, and previously executed gates retain their required checks.",
    "Use fixlab_dashboard_control for user-authorized dashboard operations. Read status first and bind its instance and current job. Do not ask again for routine steps already authorized; ask only for missing decisions or required approvals. For 'test this PR', verify the assigned checkout matches the PR source commit, then start playwright-only using the repository's Playwright configuration, selected environment and human-controlled authentication. Do not change code or use another checkout's evidence. Normal guards apply.",
    "For a connected host conversation, use fixlab_dashboard_status and fixlab_dashboard_reply to surface a recovery question using the host's question UI and submit only the user's explicit answer to the same instance and job. Never infer approval. Honor user-selected scoped iteration: full regression is explicitly deferred, not passed; for strict ready publication, PR readiness stays blocked. Draft publication follows the local/integration distinction above. Efficient delivery permits publication after focused checks and explicitly required pre-publication gates. Continue independent safe checks after unrelated failures without bypassing dependencies. Reviewed workspace reuse must preserve the current branch, uncommitted work and existing PR; a changed fingerprint requires a new review. Runtime permissions and human authentication remain separate approvals.",
    choices.deferValidation ? "Explicit unverified draft overrides the default focused-check-before-publication checkpoint; preserve every actual gate outcome." : !readOnly && workflow.mode === "efficient"
      ? efficientWorkflowGuidance(workflow, { dashboard: false })
      : "Use strict delivery: all applicable local gates and required approvals remain mandatory before readiness. Honor the saved draft/ready publication choice. Read-only runs never create or update a PR.",
    "Do not delete or edit transient test artifacts while validation is discovering or executing them; wait for owned validation to finish before cleanup.",
    "Before validation in a new isolated worktree, plan `fixlab onboard WORKTREE --from SOURCE --runtime RUNTIME`. After scoped setup approval, add `--yes`. The source profile declares non-sensitive configuration in `worktreeSetup.files`. Never copy credentials or browser state. Missing configuration, authentication or denied runtime access is a blocker for the dependent check; do not retry unchanged approvals or grant blanket path access. Sign-in and MFA remain human-controlled. In read-only modes, do not provision or alter configuration; report missing prerequisites as blocked.",
    "Prefix FixLab-created pull-request titles with `FLAB:` followed by a concise coding-change description. Use the repository's PR template with clear Markdown sections for the problem, changes, validation and risks, and accurate validation checkboxes.",
    readOnly
      ? "Do not publish a pull request or change its draft status in read-only mode."
      : workflow.publication === "draft"
        ? `Keep the published PR draft and read back provider isDraft=true before reporting publication passed. Marking ready requires a separate reviewed decision. ${choices.deferValidation ? "Local and live checks are deferred, not passed." : "Strict required checks remain mandatory."}`
      : "After required local validation and approval gates pass or have an explicitly accepted outcome, publish the authorized PR by marking it ready for review. Do not wait for remote PR CI or build completion before publication; publication can trigger those checks. Verify the PR is no longer draft before reporting the PR stage passed. Report remote checks as pending, not passed, and leave merge policies intact. Use `gh pr ready PR_NUMBER` for GitHub or `az repos pr update --id PR_ID --draft false` for Azure DevOps, then read back `isDraft` from the provider to confirm it is false. If publication or state verification fails, report the PR stage blocked or failed, not passed.",
    "Treat runtime-synthesized Playwright scenarios as transient validation artifacts by default. Remove their source files and validation-only configuration edits before review, commit, push, or pull-request creation. Do not add newly generated authenticated tests such as *.auth.spec.ts unless the user explicitly requests permanent browser-test coverage or repository instructions require that exact persisted test.",
    ...(selectedEnvironment
      ? [
        `Use ${selectedEnvironment} as the user-selected validation environment for profile-defined application startup and Playwright live testing. Do not silently fall back to another environment; block with the exact prerequisite if ${selectedEnvironment} is unavailable or unsafe.`,
        ...(profile.browserAutomation?.mode !== "api" &&
        testEvidence.source === "non-production-read-only"
          ? [
              `Use the selected ${selectedEnvironment} backend and API as the primary business-data source. Keep backend access read-only and intercept every mutating request.`,
              "Do not fulfill or intercept business-data reads while the selected backend is available and returns safe records that can prove the required assertions.",
              "Fall back to synthetic-intercepted data only when the selected backend is unreachable, access prevents the read, or it returns no safe records capable of exercising the required behavior. Preserve the exact backend limitation.",
              "Do not replace an expected empty-state assertion with synthetic data. A synthetic pass proves the UI behavior only and must not be reported as validation of the selected backend or its data.",
              "When fallback occurs, emit FIXLAB_ACTIVITY with the reason and FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted."
            ]
          : [])
      ]
      : [])
  ].join(" ").replace(/\s+/gu, " ");
  const prompt =
    request || selectedEnvironment || interactiveRequest || Object.keys(choices).length
      ? `${guidance}${request || interactiveRequest ? ` Request: ${request || interactiveRequest}` : ""}`
      : "";
  const invocation = request
    ? runtime === "copilot"
      ? buildCopilotInvocation({
          packageRoot,
          prompt,
          sessionId: randomUUID(),
          model,
          additionalDirs: linkedDependencyDirectories(repository)
        })
      : buildAgencyInvocation({
          packageRoot,
          prompt,
          sessionId: randomUUID(),
          additionalDirs: linkedDependencyDirectories(repository)
        })
    : {
        args: [
          ...(runtime === "agency" ? ["copilot"] : []),
          "--plugin-dir",
          packageRoot,
          "--agent",
          "fixlab:fixlab",
          ...linkedDependencyDirectories(repository).flatMap((directory) => ["--add-dir", directory]),
          ...(runtime === "copilot" ? copilotModelArguments(model) : []),
          ...(prompt ? ["--interactive", prompt] : [])
        ]
      };
  const forwardsPrompt =
    typeof invocation.input === "string" && invocation.input.length > 0;
  const result = spawnSync(runtime, invocation.args, {
    cwd: repository,
    stdio: forwardsPrompt ? ["pipe", "inherit", "inherit"] : "inherit",
    input: forwardsPrompt ? invocation.input : undefined,
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function parseRunArguments(args) {
  let repositoryArgument;
  let targetEnvironment = "";
  const request = [];
  const choices = {};
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && ["--draft-without-checks", "--skip-live-tests", "--deployed-backend"].includes(argument)) {
      const key = argument === "--draft-without-checks" ? "deferValidation"
        : argument === "--skip-live-tests" ? "skipLiveTests" : "useDeployedBackend";
      choices[key] = true;
      continue;
    }
    if (!afterSeparator && argument === "--environment") {
      if (!args[index + 1]) {
        return { error: "run requires a value after --environment" };
      }
      targetEnvironment = args[index + 1];
      index += 1;
      continue;
    }
    if (!afterSeparator && argument.startsWith("--environment=")) {
      targetEnvironment = argument.slice("--environment=".length);
      if (!targetEnvironment) {
        return { error: "run requires a value after --environment" };
      }
      continue;
    }
    if (!afterSeparator && !repositoryArgument && !argument.startsWith("-")) {
      repositoryArgument = argument;
      continue;
    }
    request.push(argument);
  }
  return {
    repository: resolveRepository(repositoryArgument),
    request: request.join(" ").trim(),
    targetEnvironment,
    choices
  };
}

function parseValidateArguments(args) {
  const prIndex = args.indexOf("--pr");
  if (prIndex < 0 || !args[prIndex + 1]) {
    return { error: "validate requires --pr <number>" };
  }

  const pullRequest = args[prIndex + 1];
  if (!/^\d+$/.test(pullRequest)) {
    return { error: "pull request number must contain only digits" };
  }

  const repository = resolveRepository(args[0]);
  return { repository, pullRequest };
}

function parseDashboardArguments(args) {
  let repositoryArgument;
  let port = DEFAULT_DASHBOARD_PORT;
  let open = false;
  let keepAwakeMinutes = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--open") {
      open = true;
      continue;
    }
    if (argument === "--no-open") {
      open = false;
      continue;
    }
    if (argument === "--port") {
      if (!args[index + 1]) {
        return { error: "dashboard requires a value after --port" };
      }
      try {
        port = validatePort(args[index + 1]);
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (argument === "--keep-awake-minutes") {
      if (!args[index + 1]) {
        return {
          error: "dashboard requires a value after --keep-awake-minutes"
        };
      }
      try {
        keepAwakeMinutes = parseKeepAwakeMinutes(
          args[index + 1],
          "--keep-awake-minutes"
        );
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown dashboard option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "dashboard accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }
  return {
    repository: resolveRepository(repositoryArgument),
    port,
    open,
    keepAwakeMinutes
  };
}

function parseChatArguments(args) {
  let repositoryArgument;
  let port = DEFAULT_DASHBOARD_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      if (!args[index + 1]) {
        return { error: "chat requires a value after --port" };
      }
      try {
        port = validatePort(args[index + 1]);
      } catch (error) {
        return { error: error.message };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown chat option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "chat accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }
  return { port, repositoryArgument };
}

function parseOnboardArguments(args) {
  const runtimeArguments = parseRuntimeArguments(args);
  if (runtimeArguments.error) {
    return runtimeArguments;
  }

  let repositoryArgument;
  let approved = false;
  let source;
  let authenticateBrowser = false;
  let startDashboard = false;
  for (let index = 0; index < runtimeArguments.args.length; index += 1) {
    const argument = runtimeArguments.args[index];
    if (argument === "--from") {
      const value = runtimeArguments.args[++index];
      if (!value || value.startsWith("-")) {
        return { error: "onboard requires a source checkout after --from" };
      }
      source = resolveRepository(value);
      continue;
    }
    if (argument === "--yes") {
      approved = true;
      continue;
    }
    if (argument === "--authenticate") {
      authenticateBrowser = true;
      continue;
    }
    if (argument === "--start-dashboard") {
      startDashboard = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown onboard option: ${argument}` };
    }
    if (repositoryArgument) {
      return { error: "onboard accepts at most one repository path" };
    }
    repositoryArgument = argument;
  }

  return {
    repository: resolveRepository(repositoryArgument),
    runtime: runtimeArguments.runtime,
    model: runtimeArguments.model,
    source,
    approved,
    authenticateBrowser,
    startDashboard
  };
}

async function onboard({
  repository,
  runtime,
  model,
  source,
  approved,
  authenticateBrowser,
  startDashboard
}) {
  const profilePath = join(repository, profileRelativePath);
  let profileExisted = existsSync(profilePath);

  console.log("FixLab onboarding");
  console.log(`  repository: ${repository}`);
  console.log(`  runtime: ${runtime}`);
  if (model) {
    console.log(`  model: ${model}`);
  }

  if (source) {
    const plan = planWorktreeSetup({
      source,
      repository,
      templatePath: join(packageRoot, "templates", "repository-profile.json")
    });
    console.log(`  source profile: ${join(plan.source, profileRelativePath)}`);
    for (const file of plan.files) {
      console.log(`  ${file.replaceTemplate ? "Replace unchanged example" : file.previous ? "Preserve matching file" : "Provision"}: ${file.name}`);
    }
    if (!approved) {
      console.log("No files or commands changed. Review the source profile, declared worktreeSetup.files and restore commands, then rerun with --yes.");
      return 0;
    }
    applyWorktreeSetup(plan);
    profileExisted = true;
  }

  const initResult = init(repository);
  if (initResult !== 0) {
    return initResult;
  }

  console.log("");
  console.log("Review this repository-owned profile before approving setup:");
  console.log(`  ${profilePath}`);
  console.log("");

  if (!profileExisted) {
    console.log("FixLab created a new example profile.");
    console.log(
      "Update its frontend/backend paths, commands, ports, environments, and authentication settings."
    );
    console.log("Then rerun fixlab onboard for this repository.");
    return 0;
  }

  const { profile, error } = loadProfile(repository);
  if (error) {
    console.error(`Cannot onboard repository because ${error}.`);
    return 1;
  }
  const configurationErrors = browserConfigurationErrors(profile, repository);
  if (configurationErrors.length) {
    console.error(configurationErrors.join("\n"));
    return 1;
  }
  if (profile.trustedDependencyRoots !== undefined && !Array.isArray(profile.trustedDependencyRoots)) {
    console.error("trustedDependencyRoots must be an array of approved absolute dependency-directory paths.");
    return 1;
  }
  const grantedDirectories = new Set(linkedDependencyDirectories(repository));
  const dependencyDirectories = linkedDependencyDirectories(repository, { discover: true })
    .filter((directory) => !grantedDirectories.has(directory));
  for (const directory of dependencyDirectories) {
    console.log(`Runtime path approval required for linked dependencies: ${directory}`);
  }

  const preparationPlan = prepare(repository, false);
  if (preparationPlan !== 0) {
    return preparationPlan;
  }
  const playwrightPlan = setupPlaywright(repository, false);
  if (playwrightPlan !== 0) {
    return playwrightPlan;
  }

  if (!approved) {
    console.log("");
    console.log("No restore or Playwright installation commands were executed.");
    console.log("After reviewing the profile and plans, rerun with --yes.");
    console.log(
      "Add --authenticate to perform repository-owned browser sign-in."
    );
    console.log(
      "Add --start-dashboard to start the dashboard after Doctor passes."
    );
    return 0;
  }

  if (dependencyDirectories.length) {
    profile.trustedDependencyRoots = [
      ...(profile.trustedDependencyRoots ?? []),
      ...dependencyDirectories
    ];
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    console.log("Approved only the listed linked dependency directories; runtime deny rules remain in force.");
  }

  const preparationResult = prepare(repository, true);
  if (preparationResult !== 0) {
    return preparationResult;
  }
  const playwrightResult = setupPlaywright(repository, true);
  if (playwrightResult !== 0) {
    return playwrightResult;
  }
  if (authenticateBrowser) {
    const authenticationResult = authenticate(repository, true);
    if (authenticationResult !== 0) {
      return authenticationResult;
    }
  }

  const doctorResult = doctor(repository, runtime);
  if (doctorResult !== 0) {
    return doctorResult;
  }
  if (startDashboard) {
    return dashboard(repository, DEFAULT_DASHBOARD_PORT, false, runtime, 0, model);
  }

  console.log("");
  console.log("FixLab onboarding is ready.");
  console.log("Start the dashboard with:");
  console.log(`  fixlab dashboard "${repository}" --runtime ${runtime}${model ? ` --model ${model}` : ""}`);
  return 0;
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = process.env.ComSpec ?? "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true
  });
  child.on("error", (error) => {
    console.error(`Could not open the system browser: ${error.message}`);
  });
  child.unref();
}

async function dashboard(
  repository,
  port,
  shouldOpen,
  runtime,
  keepAwakeMinutes = 0,
  model = ""
) {
  const readiness = inspectRepository(repository);
  if (!readiness.repositoryReady) {
    console.error(`Cannot start FixLab dashboard: ${readiness.error}`);
    return 1;
  }
  const dashboardServer = createDashboardServer({
    repository,
    packageRoot,
    runtime,
    model,
    preflight: runJobPreflight
  });
  let address;
  try {
    address = await dashboardServer.listen({ port });
  } catch (error) {
    console.error(`Cannot start FixLab dashboard: ${error.message}`);
    return 1;
  }

  console.log(`FixLab dashboard: ${address.url}`);
  console.log(`Repository: ${repository}`);
  console.log(`Runtime: ${runtime}`);
  if (model) {
    console.log(`Model: ${model}`);
  }
  let keepAwakeHandle;
  if (keepAwakeMinutes > 0) {
    try {
      keepAwakeHandle = startKeepAwake(keepAwakeMinutes);
      await keepAwakeHandle.ready;
      keepAwakeHandle.child.once("error", (error) => {
        console.error(`Keep-awake timer failed: ${error.message}`);
      });
      console.log(
        `Keep-awake timer: ${keepAwakeMinutes} minute(s); screen locking is allowed, but interactive browser steps may require an unlocked desktop.`
      );
    } catch (error) {
      stopKeepAwake(keepAwakeHandle);
      await dashboardServer.close();
      console.error(`Cannot start keep-awake timer: ${error.message}`);
      return 1;
    }
  }
  console.log("Press Ctrl+C to stop the local dashboard.");
  if (shouldOpen) {
    openBrowser(address.url);
  }

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    stopKeepAwake(keepAwakeHandle);
    await dashboardServer.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return 0;
}

async function promptForChatRepository() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "no FixLab dashboard is running; rerun as fixlab chat <repository> or use an interactive terminal to choose the repository"
    );
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (
      await readline.question(
        `Repository path [${process.cwd()}]: `
      )
    ).trim();
    return resolveRepository(answer || process.cwd());
  } finally {
    readline.close();
  }
}

async function promptForRepositoryConfirmation(repository) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "";
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return (
      await readline.question(
        `Connected repository: ${repository}\nPress Enter to continue, or enter another repository path: `
      )
    ).trim();
  } finally {
    readline.close();
  }
}

async function canListenOnPort(port) {
  return new Promise((resolvePort) => {
    const server = createNetServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function findAvailableDashboardPort(startPort) {
  for (
    let candidate = startPort;
    candidate <= Math.min(65535, startPort + 20);
    candidate += 1
  ) {
    if (await canListenOnPort(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no available FixLab dashboard port was found from ${startPort} through ${Math.min(
      65535,
      startPort + 20
    )}`
  );
}

async function waitForDashboard(baseUrl, child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the FixLab dashboard exited with code ${child.exitCode}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`dashboard returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `the FixLab dashboard did not become ready within 15 seconds${
      lastError?.message ? `: ${lastError.message}` : ""
    }`
  );
}

async function startDashboardForChat({
  repositoryArgument,
  port,
  runtime,
  model,
  baseUrl
}) {
  let repository;
  if (repositoryArgument) {
    repository = resolveRepository(repositoryArgument);
  } else {
    const currentRepository = resolveRepository(process.cwd());
    repository = inspectRepository(currentRepository).repositoryReady
      ? currentRepository
      : await promptForChatRepository();
  }
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error(`repository does not exist or is not a directory: ${repository}`);
  }

  let readiness = inspectRepository(repository);
  if (!readiness.profileReady || doctor(repository, runtime) !== 0) {
    if (!existsSync(join(repository, profileRelativePath))) {
      const initResult = init(repository);
      if (initResult !== 0) {
        throw new Error(`could not initialize FixLab for ${repository}`);
      }
    }
    console.log(
      "The repository is not dashboard-ready. Opening the interactive FixLab onboarding session first."
    );
    const onboardingResult = launch(
      repository, "", runtime, "", model, false,
      `Set up this repository for FixLab. Read its instructions and manifests, configure the repository-owned profile, and review the setup plan with the user. After scoped approval, run fixlab onboard "${repository}" --runtime ${runtime} --yes. Add --authenticate only when the profile requires browser sign-in; let the user complete sign-in and MFA. Do not start a dashboard from this agent. Return only after Doctor passes, or report the exact unresolved prerequisite.`
    );
    if (onboardingResult !== 0) {
      throw new Error(
        `FixLab onboarding exited with code ${onboardingResult}`
      );
    }
    readiness = inspectRepository(repository);
    if (!readiness.profileReady || doctor(repository, runtime) !== 0) {
      throw new Error(
        `onboarding finished but the repository is not dashboard-ready: ${readiness.error}`
      );
    }
  }

  console.log(`Starting FixLab dashboard for ${repository}...`);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "dashboard",
      repository,
      "--port",
      String(port),
      "--no-open",
      "--runtime",
      runtime,
      ...(model ? ["--model", model] : [])
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  await waitForDashboard(baseUrl, child);
  child.unref();
  console.log(`FixLab dashboard started at ${baseUrl}.`);
  return baseUrl;
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  if (command === "onboard") {
    const parsed = parseOnboardArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return onboard(parsed);
  }

  if (command === "init") {
    return init(resolveRepository(rest[0]));
  }

  if (command === "notifications") {
    if (rest.filter((value) => !value.startsWith("-")).length > 1 ||
        rest.some((value) => value.startsWith("-") && value !== "--yes")) {
      throw new Error("Usage: fixlab notifications [repository] [--yes]");
    }
    const repository = resolveRepository(rest.find((value) => !value.startsWith("-")));
    console.log(JSON.stringify(installNotifications(repository, packageRoot, rest.includes("--yes")), null, 2));
    return 0;
  }

  if (command === "portal-api-proof" || command === "linked-api-proof") {
    const positional = rest.filter((value) => !value.startsWith("-"));
    if (positional.length > 1 || rest.some((value) => value.startsWith("-") &&
        !["--authenticate", "--proof", "--yes"].includes(value)) ||
        (rest.includes("--authenticate") && rest.includes("--proof"))) {
      throw new Error(`Usage: fixlab ${command} [repository] [--authenticate|--proof] [--yes]`);
    }
    const repository = resolveRepository(positional[0]);
    if (command === "portal-api-proof") {
      if (!rest.includes("--yes")) {
        throw new Error("Review portal API authentication in Repository Settings, then explicitly pass --yes.");
      }
      try {
        console.log(JSON.stringify(await runPortalApiProof(repository, {
          authenticate: rest.includes("--authenticate"), confirmed: true
        })));
        return 0;
      } catch {
        console.error("Portal-owned API proof failed. Inspect the repository session helper, approved API configuration and sign-in; credentials and response data were not logged.");
        return 1;
      }
    }
    if (!rest.includes("--yes")) {
      const plan = linkedApiProofPlan(repository);
      console.log(JSON.stringify({ application: plan.application, environment: plan.environment,
        origin: plan.origin, method: plan.method, path: plan.path, requiresConfirmation: true }));
      return 0;
    }
    const receipt = await runLinkedApiProof(repository, {
      authenticate: rest.includes("--authenticate"), confirmed: true
    });
    console.log(JSON.stringify(receipt));
    return 0;
  }

  if (command === "doctor") {
    const parsed = parseRuntimeArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return doctor(resolveRepository(parsed.args[0]), parsed.runtime);
  }

  if (command === "prepare") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return prepare(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
  }

  if (command === "setup-playwright") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return setupPlaywright(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
  }

  if (command === "authenticate") {
    const repositoryArgument = rest.find((value) => !value.startsWith("-"));
    return authenticate(
      resolveRepository(repositoryArgument),
      rest.includes("--yes")
    );
  }

  if (command === "exec") {
    return runStructuredCommand(rest, process.cwd());
  }
  if (command === "gate") {
    return runValidationGate(rest);
  }

  if (command === "run") {
    const parsed = parseRuntimeArguments(rest);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    const runArguments = parseRunArguments(parsed.args);
    if (runArguments.error) {
      console.error(runArguments.error);
      return 1;
    }
    return launch(
      runArguments.repository,
      runArguments.request,
      parsed.runtime,
      runArguments.targetEnvironment,
      parsed.model,
      false,
      "",
      runArguments.choices
    );
  }

  if (command === "validate") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseValidateArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return launch(
      parsed.repository,
      `Validate pull request ${parsed.pullRequest} without modifying source code or the pull request.`,
      runtimeArguments.runtime,
      "",
      runtimeArguments.model,
      true
    );
  }

  if (command === "dashboard") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseDashboardArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    return dashboard(
      parsed.repository,
      parsed.port,
      parsed.open,
      runtimeArguments.runtime,
      parsed.keepAwakeMinutes,
      runtimeArguments.model
    );
  }

  if (command === "keep-awake") {
    if (
      rest.length !== 2 ||
      rest[0] !== "--minutes"
    ) {
      console.error("keep-awake requires --minutes <minutes>");
      return 1;
    }
    try {
      return runKeepAwake(parseKeepAwakeMinutes(rest[1]));
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  if (command === "chat") {
    const runtimeArguments = parseRuntimeArguments(rest);
    if (runtimeArguments.error) {
      console.error(runtimeArguments.error);
      return 1;
    }
    const parsed = parseChatArguments(runtimeArguments.args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    const baseUrl = `http://127.0.0.1:${parsed.port}`;
    const switchRepository = async ({
      baseUrl: currentBaseUrl = baseUrl,
      readiness,
      repository: requestedRepository
    }) => {
      const connectedRepository = readiness?.repository;
      let repositoryArgument = requestedRepository;
      if (!repositoryArgument) {
        repositoryArgument = await promptForChatRepository();
      }
      const repository = resolveRepository(repositoryArgument);
      if (
        connectedRepository &&
        repository.toLowerCase() ===
          resolve(connectedRepository).toLowerCase()
      ) {
        return currentBaseUrl;
      }
      const alternatePort = await findAvailableDashboardPort(
        parsed.port + 1
      );
      const alternateUrl = `http://127.0.0.1:${alternatePort}`;
      return startDashboardForChat({
        repositoryArgument: repository,
        port: alternatePort,
        runtime: runtimeArguments.runtime,
        model: runtimeArguments.model,
        baseUrl: alternateUrl
      });
    };
    return runChat({
      baseUrl,
      model: runtimeArguments.model,
      recoverConnection: () =>
        startDashboardForChat({
          repositoryArgument: parsed.repositoryArgument,
          port: parsed.port,
          runtime: runtimeArguments.runtime,
          model: runtimeArguments.model,
          baseUrl
        }),
      selectRepository: async ({ readiness }) => {
        const connectedRepository = readiness?.repository;
        let requestedRepository = parsed.repositoryArgument;
        if (
          requestedRepository &&
          connectedRepository &&
          resolve(requestedRepository).toLowerCase() ===
            resolve(connectedRepository).toLowerCase()
        ) {
          return baseUrl;
        }
        if (!requestedRepository) {
          requestedRepository = await promptForRepositoryConfirmation(
            connectedRepository ?? "unknown"
          );
        }
        if (!requestedRepository) {
          return baseUrl;
        }
        return switchRepository({
          baseUrl,
          readiness,
          repository: requestedRepository
        });
      },
      switchRepository,
      openDashboard: ({ baseUrl: dashboardUrl }) =>
        openBrowser(dashboardUrl)
    });
  }

  if (!command.startsWith("-")) {
    const parsed = parseRuntimeArguments(args);
    if (parsed.error) {
      console.error(parsed.error);
      return 1;
    }
    if (parsed.args.length !== 1) {
      console.error(
        "interactive FixLab accepts one repository path and optional --runtime and --model values"
      );
      return 1;
    }
    return launch(
      resolveRepository(parsed.args[0]),
      "",
      parsed.runtime,
      "",
      parsed.model
    );
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
