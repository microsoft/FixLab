import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import childProcess, { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { createServer as createHttpServer, request as createHttpRequest } from "node:http";
import { createServer } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import {
  formatJobStatus,
  parseNaturalChatCommand,
  runChat
} from "../dashboard/chat.js";
import {
  buildAgencyInvocation,
  buildCopilotInvocation,
  buildJobPrompt,
  createCacheContext,
  createCopilotExecutor,
  createAuthenticationDiagnostics,
  createDashboardServer,
  configuredTestSynthesis,
  createProcessCompletion,
  FIXLAB_STAGES,
  inspectRepository,
  linkedDependencyDirectories,
  MAX_JOB_ACTIVITY_ENTRIES,
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  MAX_DASHBOARD_HISTORY_ENTRIES,
  MAX_JOB_LOG_ENTRIES,
  openLocalUrl,
  normalizeEngineeringSummary,
  validateCopilotModel,
  validateLiveTestProfile
} from "../dashboard/server.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { createSessionRegistry } from "../dashboard/sessions.js";
import { createRuntimeRequestBridge, runtimePermissionPrompt, runtimeQuestionPrompt } from "../dashboard/runtime-requests.js";
import { runValidationGate } from "../bin/validation-gate-client.js";
import { dashboardControl, dashboardConversation } from "../mcp/dashboard-client.js";
import { compactControlResult, conversationOperations } from "../dashboard/conversation-operations.js";
import { runJobPreflight } from "../dashboard/preflight.js";

const packageRoot = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1"
);

test("authentication diagnostics classify split output without retaining private helper details", () => {
  const cases = [
    ["Cannot find module 'private-helper-path'", "missing-dependency"],
    ["Executable doesn't exist at private-browser-path", "browser-unavailable"],
    ["ProcessSingleton: browser profile is busy", "browser-profile-busy"],
    ["AADSTS53003: private identity and challenge", "authentication-required"],
    ["Error: No tests found", "configuration-error"],
    ["TimeoutError: private page locator timed out", "timeout"],
    ["Unrecognized private authentication failure", "unknown"]
  ];
  for (const [output, reason] of cases) {
    const diagnostics = createAuthenticationDiagnostics();
    diagnostics.observe("stdout", Buffer.from("private-token-sentinel\n"));
    const middle = Math.floor(output.length / 2);
    diagnostics.observe("stderr", Buffer.from(output.slice(0, middle)));
    diagnostics.observe("stderr", Buffer.from(output.slice(middle)));
    const result = diagnostics.failure();
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /private-|AADSTS53003|ProcessSingleton/);
    assert.ok(result.message.length > 20);
  }
  const diagnostics = createAuthenticationDiagnostics();
  diagnostics.observe("stdout", Buffer.from("Cannot find "));
  diagnostics.observe("stderr", Buffer.from("module: unrelated stream"));
  assert.equal(diagnostics.failure().reason, "unknown", "streams must not create a false diagnostic");
  diagnostics.observe("stderr", Buffer.from("\nAADSTS53003: restricted"));
  diagnostics.observe("stdout", Buffer.from("module 'private-dependency'"));
  assert.equal(diagnostics.failure().reason, "authentication-required",
    "access restrictions must not be hidden behind dependency diagnostics");
});

test("engineering summary validates detail fields, redacts sensitive text and rejects unsafe paths", () => {
  const detail = {
    problem: "A mapping cannot be removed",
    rootCause: "The gateway contract omitted an existing operation",
    codeFix: "Add the operation and its path parameters to the contract",
    changedFiles: ["deployment\\contract.json"],
    regression: ["Assert the operation and response schema"],
    risks: ["Deployment is required; live deletion is not verified"],
    workarounds: [],
    commit: "a".repeat(40)
  };
  const normalized = normalizeEngineeringSummary(detail);
  assert.equal(normalized.codeFix, detail.codeFix);
  assert.deepEqual(normalized.changedFiles, detail.changedFiles);
  assert.match(normalizeEngineeringSummary({ ...detail, problem: "password=private-sentinel" }).problem, /omitted/);
  assert.doesNotMatch(JSON.stringify(normalizeEngineeringSummary({
    ...detail, rootCause: "See https://private.example.test/path"
  })), /private\.example/);
  for (const sensitive of ["api_key=syntheticCredentialValue123", `ghp_${"A".repeat(36)}`]) {
    const sanitized = normalizeEngineeringSummary({ ...detail,
      problem: sensitive, expectedBehavior: sensitive, actualBehavior: sensitive,
      rootCause: sensitive, codeFix: sensitive, changedFiles: [sensitive],
      regression: [sensitive], risks: [sensitive], workarounds: [sensitive] });
    assert.ok(!JSON.stringify(sanitized).includes(sensitive));
    assert.match(sanitized.codeFix, /omitted/);
    assert.match(sanitized.regression[0], /omitted/);
  }
  for (const changedFiles of [["..\\outside.json"], ["C:\\outside.json"], ["/outside.json"],
    [" ../outside.json"], [" /outside.json"], ["folder/.. "], ["folder/ .. /outside.json"]]) {
    assert.throws(() => normalizeEngineeringSummary({ ...detail, changedFiles }), /relative paths/);
  }
  assert.throws(() => normalizeEngineeringSummary({ ...detail, codeFix: "" }), /required/);
  assert.throws(() => normalizeEngineeringSummary({ ...detail, passed: true }), /documented/);
  assert.throws(() => normalizeEngineeringSummary({ ...detail, regression: Array(21).fill("test") }), /20 bounded/);
});

test("engineering summaries survive history and restart, and reviewed notes cannot mutate another active job", async () => {
  const repository = createGitRepository();
  const detail = { problem: "Removal fails", rootCause: "Missing contract operation",
    codeFix: "Publish the existing operation", changedFiles: ["deployment\\contract.json"],
    regression: ["Original failure reproduced; contract assertion passed",
      'Literal FIXLAB_STAGE|pr|passed|{"example"} is not runner evidence'] };
  const executions = [];
  const executor = (input) => {
    executions.push(input);
    if (executions.length === 1) {
      input.onOutput("stdout", `FIXLAB_SUMMARY|${JSON.stringify(detail)}FIXLAB_STAGE|intake|skipped|Fixture.\n`);
      input.onOutput("stdout", "FIXLAB_SUMMARY|{private-sentinel-invalid-json\n");
      input.onOutput("stdout", `FIXLAB_SUMMARY|${JSON.stringify([detail,
        { codeFix: "api_key=private-sentinel-array" }])}\n`);
      input.onOutput("stdout", `FIXLAB_SUMMARY|${JSON.stringify(detail)} private-sentinel-trailing-text\n`);
      for (const stage of FIXLAB_STAGES.filter((stage) => stage !== "intake")) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|skipped|Fixture.\n`);
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  let current = await startDashboard(repository, executor);
  const post = (path, body, headers = {}) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Validate removal.", mode: "validate-only" });
    const firstId = started.body.job.id;
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      state = (await jsonRequest(current.url, "/api/status")).body;
      if (state.job.status === "passed") {break;}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.job.status, "passed");
    assert.equal(state.job.engineeringSummary.codeFix, detail.codeFix);
    assert.equal(state.job.engineeringSummaryOrigin, "agent-reported");
    assert.doesNotMatch(JSON.stringify(state.job.logs), /private-sentinel/);
    const second = await post("/api/jobs", { request: "Another job.", mode: "validate-only" });
    const secondId = second.body.job.id;
    const notes = { instanceId: state.instanceId, repository, jobId: firstId, confirmed: true,
      summary: { ...detail, codeFix: "Reviewed contract-only correction" } };
    for (const body of [
      { ...notes, instanceId: "wrong-instance" }, { ...notes, confirmed: false },
      { ...notes, jobId: secondId }, { ...notes, jobId: "missing-job" },
      { ...notes, summary: { ...detail, changedFiles: ["..\\outside.json"] } }
    ]) {
      const rejected = await post("/api/job/engineering-summary", body);
      assert.equal(rejected.response.status, 400, rejected.body.error);
    }
    assert.equal((await post("/api/job/engineering-summary", notes, { Origin: current.url })).response.status, 400);
    const reviewed = await post("/api/job/engineering-summary", notes);
    assert.equal(reviewed.response.status, 200, reviewed.body.error);
    const after = (await jsonRequest(current.url, "/api/status")).body;
    assert.equal(after.job.id, secondId);
    assert.equal(after.job.status, "running");
    assert.equal(executions.length, 2);
    assert.equal(after.history.find((job) => job.id === firstId).engineeringSummary.codeFix,
      "Reviewed contract-only correction");
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    const restored = (await jsonRequest(current.url, "/api/status")).body;
    const saved = [restored.job, ...restored.history, ...restored.held].find((job) => job?.id === firstId);
    assert.equal(saved.engineeringSummary.codeFix, "Reviewed contract-only correction");
    assert.equal(saved.engineeringSummaryOrigin, "reviewed-note");
    assert.equal(executions.length, 2);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("engineering notes report when the target falls outside the persisted history window", async () => {
  const repository = createGitRepository();
  let executions = 0;
  const executor = (input) => {
    executions += 1;
    if (executions === 1) {
      for (const stage of FIXLAB_STAGES) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|skipped|Fixture.\n`);
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const first = await post("/api/jobs", { request: "Older completed job.", mode: "validate-only" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await post("/api/jobs", { request: "Active job.", mode: "validate-only" });
    for (let index = 0; index < MAX_DASHBOARD_HISTORY_ENTRIES - 1; index += 1) {
      const queued = await post("/api/jobs", { request: `Queued job ${index}.`, mode: "validate-only" });
      assert.equal(queued.response.status, 202, queued.body.error);
      const held = await post("/api/jobs/hold", { jobId: queued.body.queuedJob.id });
      assert.equal(held.response.status, 202, held.body.error);
    }
    const state = (await jsonRequest(url, "/api/status")).body;
    const result = await post("/api/job/engineering-summary", {
      instanceId: state.instanceId, repository, jobId: first.body.job.id, confirmed: true,
      summary: { problem: "Older bug", rootCause: "Original cause", codeFix: "Reviewed correction" }
    });
    assert.equal(result.response.status, 503, result.body.error);
    assert.match(result.body.error, /could not be persisted/);
    const saved = JSON.parse(readFileSync(join(dirname(createCacheContext(repository).cachePath),
      "dashboard-jobs.json"), "utf8"));
    assert.ok(!saved.jobs.some((job) => job.id === first.body.job.id));
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("editing resumes retain the original detailed bug-to-code-fix explanation", async () => {
  const repository = createRepository();
  const detail = { problem: "Removal fails", rootCause: "Missing contract operation",
    codeFix: "Add the existing operation to the gateway contract" };
  const calls = [];
  const executor = (input) => {
    calls.push(input);
    if (!input.resume) {
      input.onOutput("stdout", `FIXLAB_SUMMARY|${JSON.stringify(detail)}\n`);
    }
    for (const stage of FIXLAB_STAGES) {
      input.onOutput("stdout", `FIXLAB_STAGE|${stage}|${!input.resume && stage === "live-test" ? "blocked" : "skipped"}|Fixture.\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    await post("/api/jobs", { request: "Fix removal.", mode: "fix-and-validate" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await jsonRequest(url, "/api/job")).body.job.status, "blocked");
    const resumed = await post("/api/job/input", { action: "continue", details: "Continue validation." });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].prompt.includes(JSON.stringify(normalizeEngineeringSummary(detail))));
    assert.match(calls[1].prompt, /recorded, not new verification/);
    assert.match(calls[1].prompt, /Preserve the original bug-to-fix explanation across retries/);
    assert.equal((await jsonRequest(url, "/api/job")).body.job.engineeringSummary.codeFix, detail.codeFix);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("linked node_modules directories are granted only inside trusted dependency roots", () => {
  const base = mkdtempSync(join(tmpdir(), "fixlab-linked-"));
  try {
    const repository = join(base, "repo");
    const trusted = join(base, "trusted");
    const external = join(trusted, "web", "node_modules");
    const untrusted = join(base, "untrusted", "node_modules");
    mkdirSync(join(repository, "apps", "web"), { recursive: true });
    mkdirSync(join(repository, "tools"), { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(untrusted, { recursive: true });
    symlinkSync(
      external,
      join(repository, "apps", "web", "node_modules"),
      "junction"
    );
    symlinkSync(untrusted, join(repository, "tools", "node_modules"), "junction");

    const writeProfile = (trustedDependencyRoots) => {
      const directory = join(repository, ".github", "fixlab");
      mkdirSync(directory, { recursive: true });
      const profile = validProfile({ trustedDependencyRoots });
      profile.browserAutomation.workingDirectory = "apps/web";
      profile.applications.frontend.workingDirectory = "apps/web";
      profile.applications.tools = { workingDirectory: "tools" };
      writeFileSync(
        join(directory, "repository-profile.json"),
        JSON.stringify(profile)
      );
    };

    writeProfile(undefined);
    assert.deepEqual(linkedDependencyDirectories(repository), []);
    assert.deepEqual(linkedDependencyDirectories(repository, { discover: true }), [
      realpathSync(external),
      realpathSync(untrusted)
    ]);
    assert.deepEqual(linkedDependencyDirectories(repository), []);

    writeProfile([parse(base).root]);
    assert.deepEqual(linkedDependencyDirectories(repository), []);

    writeProfile([trusted]);
    const directories = linkedDependencyDirectories(repository);
    assert.deepEqual(directories, [realpathSync(external)]);

    const invocation = buildCopilotInvocation({
      packageRoot: "C:\\FixLab",
      prompt: "x",
      sessionId: "11111111-1111-4111-8111-111111111111",
      additionalDirs: directories
    });
    const index = invocation.args.indexOf("--add-dir");
    assert.equal(invocation.args[index + 1], realpathSync(external));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Copilot models are validated and retained in fresh and resumed invocations", () => {
  assert.equal(validateCopilotModel(" HydraFusion "), "hydrafusion");
  assert.equal(validateCopilotModel("", "agency"), "");
  for (const model of [1, true, ["hydrafusion"], {}]) {
    assert.throws(() => validateCopilotModel(model), /model must be a string/);
  }
  assert.throws(() => validateCopilotModel("hydrafusion", "agency"), /copilot runtime/);
  for (const model of ["hydrafusion&whoami", "--model", "x".repeat(129)]) {
    assert.throws(() => validateCopilotModel(model), /model must be/);
  }
  for (const resume of [false, true]) {
    for (const model of ["", "hydrafusion", "claude-sonnet-4.5"]) {
      const invocation = buildCopilotInvocation({
        packageRoot: "C:\\FixLab",
        prompt: "Validate the selected model.",
        sessionId: "11111111-1111-4111-8111-111111111111",
        model,
        resume
      });
      assert.equal(invocation.args.includes("--experimental"), model === "hydrafusion");
      assert.equal(invocation.args.includes("--model"), Boolean(model));
      if (model) {
        assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], model);
      }
      assert.equal(invocation.input, "Validate the selected model.");
    }
  }
});

test("Agency executor keeps long prompts out of process arguments", () => {
  const prompt = `Fix this batch:\n${"x".repeat(40000)}`;
  const invocation = buildAgencyInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "11111111-1111-4111-8111-111111111111"
  });

  test("runtime invocation adds broad tool approval only after explicit opt-in", () => {
    for (const build of [buildAgencyInvocation, buildCopilotInvocation]) {
      for (const resume of [false, true]) {
        const config = { packageRoot, sessionId: randomUUID(), prompt: "Synthetic approval mode.", resume };
        assert.equal(build(config).args.includes("--allow-all-tools"), false);
        assert.equal(build({ ...config, toolApprovalMode: "allow-all" }).args.includes("--allow-all-tools"), true);
        for (const toolApprovalMode of [true, null, "all", []]) {
          assert.throws(() => build({ ...config, toolApprovalMode }), /toolApprovalMode/);
        }
      }
    }
  });

  assert.equal(invocation.input, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.equal(invocation.args.includes("--interactive"), false);
  assert.deepEqual(invocation.args.slice(0, 5), [
    "copilot",
    "--plugin-dir",
    "C:\\FixLab",
    "--agent",
    "fixlab:fixlab"
  ]);
  assert.deepEqual(invocation.args.slice(-2), [
    "--session-id",
    "11111111-1111-4111-8111-111111111111"
  ]);

  const resumed = buildAgencyInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: true
  });
  assert.equal(resumed.args.includes("--session-id"), false);
  assert.equal(
    resumed.args.at(-1),
    "--resume=11111111-1111-4111-8111-111111111111"
  );
});

test("local browser opener accepts only credential-free loopback URLs", async () => {
  const launches = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const launched = openLocalUrl("http://127.0.0.1:3000/app", {
    platform: "win32",
    spawnImpl(command, args, options) {
      launches.push({ command, args, options });
      return child;
    }
  });
  child.emit("spawn");
  await launched;
  assert.deepEqual(launches, [
    {
      command: "explorer.exe",
      args: ["http://127.0.0.1:3000/app"],
      options: {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    }
  ]);
  assert.throws(
    () =>
      openLocalUrl("http://user:password@localhost:3000", {
        platform: "win32",
        spawnImpl() {
          throw new Error("should not launch");
        }
      }),
    /credential-free HTTP\(S\) on loopback/
  );
  assert.throws(
    () =>
      openLocalUrl("https://example.com", {
        platform: "win32",
        spawnImpl() {
          throw new Error("should not launch");
        }
      }),
    /credential-free HTTP\(S\) on loopback/
  );

  const failedChild = new EventEmitter();
  failedChild.unref = () => {};
  const failedLaunch = openLocalUrl("http://localhost:3000", {
    platform: "linux",
    spawnImpl() {
      return failedChild;
    }
  });
  failedChild.emit("error", new Error("xdg-open is missing"));
  await assert.rejects(failedLaunch, /xdg-open is missing/);
});

test("executor completion settles after process exit when inherited pipes remain open", async () => {
  const child = new EventEmitter();
  const output = [];
  const completion = createProcessCompletion(
    child,
    (stream, text) => output.push({ stream, text }),
    5
  );

  child.emit("exit", 0, null);

  assert.deepEqual(await completion, { code: 0, signal: null });
  assert.deepEqual(output, []);
});

test("direct Copilot executor preserves stdin sessions and resume", () => {
  const prompt = `Validate this batch:\n${"x".repeat(40000)}`;
  const invocation = buildCopilotInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "22222222-2222-4222-8222-222222222222"
  });

  assert.equal(invocation.input, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.deepEqual(invocation.args.slice(0, 4), [
    "--plugin-dir",
    "C:\\FixLab",
    "--agent",
    "fixlab:fixlab"
  ]);
  assert.equal(invocation.args.includes("--autopilot"), true);
  assert.deepEqual(invocation.args.slice(-2), [
    "--session-id",
    "22222222-2222-4222-8222-222222222222"
  ]);

  const resumed = buildCopilotInvocation({
    packageRoot: "C:\\FixLab",
    prompt,
    sessionId: "22222222-2222-4222-8222-222222222222",
    resume: true
  });
  assert.equal(resumed.args.includes("--session-id"), false);
  assert.equal(
    resumed.args.at(-1),
    "--resume=22222222-2222-4222-8222-222222222222"
  );
});

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-dashboard-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify(validProfile())
  );
  return repository;
}

function validProfile(overrides = {}) {
  return {
    name: "Dashboard test repository",
    workflow: { mode: "strict" },
    applications: {
      frontend: {
        workingDirectory: ".",
        command: "npm start",
        port: 3000,
        healthUrl: "http://127.0.0.1:3000"
      }
    },
    browserAutomation: {
      workingDirectory: ".",
      package: "@playwright/test",
      browser: "chromium",
      testCommand: "npm run test:e2e",
      testSynthesis: {
        enabled: true,
        defaultDataSource: "synthetic-intercepted",
        mutationMode: "intercepted",
        requireScenarioEvidence: true
      },
      authentication: {
        required: false,
        command: "",
        statusPaths: []
      },
      dataSafety: {
        policy: "Use mocked data and intercept mutations.",
        productionAllowed: false
      }
    },
    environments: ["local", "dev", "sit"],
    pullRequests: {
      defaultTargetBranch: "develop",
      requireConfirmation: true,
      branchNaming: {
        userId: "fixlab-test",
        prefixTemplate: "users/{userId}"
      }
    },
    ...overrides
  };
}

test("dashboard readiness blocks a missing explicit Playwright configuration", () => {
  const repository = createRepository();
  try {
    const profile = validProfile();
    profile.browserAutomation.testCommand = "playwright test --config=playwright.local.ts";
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
    assert.equal(inspectRepository(repository).profileReady, false);
    assert.match(inspectRepository(repository).error, /configuration is missing.*worktreeSetup.files/);
    writeFileSync(join(repository, "playwright.local.ts"), "export default {};");
    assert.equal(inspectRepository(repository).profileReady, true);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function apiProfile() {
  const profile = validProfile({
    applications: {
      backend: {
        workingDirectory: ".",
        command: "dotnet run",
        port: 5087,
        healthUrl: "http://127.0.0.1:5087/health"
      }
    }
  });
  delete profile.browserAutomation.browser;
  profile.browserAutomation.mode = "api";
  profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
  profile.browserAutomation.testSynthesis.mutationMode = "none";
  profile.browserAutomation.dataSafety.allowedOrigins = ["http://127.0.0.1:5087"];
  profile.browserAutomation.dataSafety.allowedMethods = ["GET", "HEAD"];
  return profile;
}

function unitOnlyProfile() {
  return {
    name: "Offline unit-test repository",
    validation: {
      liveTestsRequired: false,
      liveTestsDeferredReason: "Local units only; integration is deferred by repository approval.",
      gates: [{
        id: "local-unit-tests", command: process.execPath,
        args: ["-e", "process.exit(0)"], workingDirectory: ".",
        kind: "tests", required: true, timeoutSeconds: 30
      }]
    }
  };
}

test("unit-test-only readiness requires an explicit reason and required offline tests without live configuration", () => {
  const repository = createRepository();
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const inspect = (profile) => {
    writeFileSync(path, JSON.stringify(profile));
    return inspectRepository(repository);
  };
  try {
    const ready = inspect(unitOnlyProfile());
    assert.equal(ready.profileReady, true);
    assert.equal(ready.unitTestsOnly, true);
    for (const [change, message] of [
      [(p) => { delete p.validation.liveTestsDeferredReason; }, /liveTestsDeferredReason/],
      [(p) => { p.validation.liveTestsDeferredReason = " "; }, /liveTestsDeferredReason/],
      [(p) => { p.validation.liveTestsRequired = "false"; }, /liveTestsRequired/],
      [(p) => { delete p.validation.gates; }, /required local tests gate/],
      [(p) => { p.validation.gates[0].required = false; }, /required local tests gate/],
      [(p) => { p.validation.gates[0].stage = "live-test"; }, /cannot configure live-test gates/],
      [(p) => { p.browserAutomation = validProfile().browserAutomation; }, /must omit browserAutomation/]
    ]) {
      const profile = unitOnlyProfile();
      change(profile);
      const readiness = inspect(profile);
      assert.equal(readiness.profileReady, false);
      assert.match(readiness.error, message);
    }
    const profile = unitOnlyProfile();
    delete profile.validation.liveTestsRequired;
    assert.equal(inspect(profile).profileReady, false, "live requirements remain the default");
    const evidence = configuredTestSynthesis(unitOnlyProfile());
    assert.equal(evidence.unitTestsOnly, true);
    assert.equal(evidence.enabled, false);
    assert.equal(evidence.requireScenarioEvidence, false);
    assert.throws(() => configuredTestSynthesis(unitOnlyProfile(), "none"), /Unit-test-only/);
    const prompt = buildJobPrompt({ request: "Run local units.", mode: "validate-only", testEvidence: evidence });
    assert.match(prompt, /Repository unit-test-only override/);
    assert.match(prompt, /do not start applications, authenticate, send API requests or access remote databases/);
    assert.match(prompt, /Mark local-stack and live-test skipped/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("unit-test-only dashboard admits and recovers normal jobs without API proof and rejects live run options", async () => {
  const repository = createGitRepository();
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(unitOnlyProfile()));
  const executions = [];
  const executor = (input) => {
    executions.push(input);
    return { completion: new Promise(() => {}), terminate() {} };
  };
  let current = await startDashboard(repository, executor, undefined, { autoTestEvidence: false });
  const post = (body) => jsonRequest(current.url, "/api/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    for (const body of [
      { mode: "playwright-only" }, { manualLocalhostTest: true }, { prestartFrontend: true },
      { recordPlaywrightVideo: true }, { runAllUiScenarios: true }
    ]) {
      const result = await post({ request: "Check explicit offline policy.", mode: "validate-only", ...body });
      assert.equal(result.response.status, 400, result.body.error);
      assert.match(result.body.error, /explicitly defers live tests/);
    }
    assert.equal(executions.length, 0);
    const started = await post({ request: "Run configured local unit tests.", mode: "validate-only" });
    assert.equal(started.response.status, 202, started.body.error);
    assert.equal(executions.length, 1);
    assert.equal(started.body.job.testEvidence.unitTestsOnly, true);
    assert.equal(started.body.job.testEvidence.enabled, false);
    assert.match(executions[0].prompt, /unit-test-only override/);
    const status = await jsonRequest(current.url, "/api/status");
    assert.equal(status.body.readiness.profileReady, true);
    await current.dashboard.close();
    current = await startDashboard(repository, executor, undefined, { autoTestEvidence: false });
    const restored = await jsonRequest(current.url, "/api/status");
    assert.equal(restored.body.job.testEvidence.unitTestsOnly, true);
    assert.equal(restored.body.job.testEvidence.liveTestsDeferredReason,
      unitOnlyProfile().validation.liveTestsDeferredReason);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only readiness requires backend, authentication and read-only safety without a frontend", () => {
  const repository = createRepository();
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const inspect = (profile) => {
    writeFileSync(path, JSON.stringify(profile));
    return inspectRepository(repository);
  };
  try {
    const ready = inspect(apiProfile());
    assert.equal(ready.profileReady, true, ready.error);
    assert.equal(ready.playwrightMode, "api");
    for (const [change, message] of [
      [(p) => { delete p.applications.backend; }, /applications\.backend/],
      [(p) => { p.applications.backend.port = 0; }, /applications\.backend\.port/],
      [(p) => { p.applications.backend.healthUrl = "https://example.invalid/health"; }, /credential-free loopback/],
      [(p) => { p.browserAutomation.mode = "unknown"; }, /browserAutomation\.mode/],
      [(p) => { p.browserAutomation.authentication.required = true; }, /authentication\.command/],
      [(p) => { p.browserAutomation.dataSafety.productionAllowed = true; }, /productionAllowed=false/],
      [(p) => { p.browserAutomation.dataSafety.allowedOrigins = []; }, /allowedOrigins/],
      [(p) => { p.browserAutomation.dataSafety.allowedOrigins = ["http://example.invalid"]; }, /allowedOrigins/],
      [(p) => { p.browserAutomation.dataSafety.allowedOrigins = ["https://example.invalid/path"]; }, /allowedOrigins/],
      [(p) => { p.browserAutomation.dataSafety.allowedMethods = ["POST"]; }, /allowedMethods/],
      [(p) => { p.browserAutomation.testSynthesis.mutationMode = "intercepted"; }, /mutationMode=none/],
      [(p) => { delete p.browserAutomation.testCommand; }, /testCommand/]
    ]) {
      const profile = apiProfile();
      change(profile);
      const readiness = inspect(profile);
      assert.equal(readiness.profileReady, false, String(message));
      assert.match(readiness.error, message);
    }
    const browser = validProfile();
    delete browser.applications.frontend;
    assert.match(inspect(browser).error, /applications\.frontend/);
    const fixture = apiProfile();
    fixture.browserAutomation.testSynthesis.defaultDataSource = "local-fixture";
    assert.equal(configuredTestSynthesis(fixture, "none").mutationMode, "none");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function productionApiProfile() {
  const profile = apiProfile();
  profile.applications.backend.port = 50443;
  profile.applications.backend.healthUrl = "https://localhost:50443/protected";
  profile.browserAutomation.apiAuthentication = { role: "portal",
    url: "https://localhost:50443/protected", scope: "api://fixture/read",
    sessionHelper: "session.mjs", productionDatabaseReadOnly: true };
  profile.browserAutomation.authentication = { required: true,
    command: "node auth.mjs", proofCommand: "node proof.mjs", statusPaths: [".auth/ready.json"] };
  profile.browserAutomation.dataSafety.allowedOrigins = ["https://localhost:50443"];
  profile.browserAutomation.testSynthesis.defaultDataSource = "production-read-only";
  return profile;
}

function createProductionApiRepository({ persisted = false } = {}) {
  const repository = persisted ? createGitRepository() : createRepository();
  mkdirSync(join(repository, ".auth"));
  writeFileSync(join(repository, ".auth", "ready.json"), '{"syntheticFixture":true}');
  writeFileSync(join(repository, "session.mjs"), "export async function assertReadOnlyDatabase() { return false; }");
  // Synthetic child processes exercise dashboard lifecycle, not database access.
  writeFileSync(join(repository, "auth.mjs"), "process.exit(0);");
  writeFileSync(join(repository, "proof.mjs"), "process.exit(0);");
  return repository;
}

test("production-backed API-only profiles require explicit local read-only configuration and truthful evidence", () => {
  const repository = createProductionApiRepository();
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  try {
    const profile = productionApiProfile();
    writeFileSync(path, JSON.stringify(profile));
    assert.equal(inspectRepository(repository).profileReady, true);
    const evidence = configuredTestSynthesis(profile, "none");
    assert.equal(evidence.productionDatabaseReadOnly, true);
    assert.equal(evidence.source, "production-read-only");
    for (const change of [
      p => { p.browserAutomation.apiAuthentication.productionDatabaseReadOnly = false; },
      p => { p.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only"; },
      p => { p.browserAutomation.testSynthesis.mutationMode = "approved-write"; },
      p => { p.browserAutomation.dataSafety.allowedOrigins.push("https://production.example.invalid"); },
      p => { p.browserAutomation.apiAuthentication.url = "https://production.example.invalid/protected"; },
      p => { p.browserAutomation.authentication.required = false; },
      p => { p.browserAutomation.dataSafety.productionAllowed = true; }
    ]) {
      const invalid = productionApiProfile();
      change(invalid);
      writeFileSync(path, JSON.stringify(invalid));
      assert.equal(inspectRepository(repository).profileReady, false);
    }
    profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = false;
    assert.throws(() => configuredTestSynthesis(profile), /explicitly approved/u);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

for (const source of ["production-read-only", "non-production-read-only"]) {
  test(`production-backed API jobs enforce local targets and ${source} evidence labeling`, async () => {
    const repository = createProductionApiRepository();
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"),
      JSON.stringify(productionApiProfile()));
    let prompt = "";
    const { dashboard, url } = await startDashboard(repository, input => {
      prompt = input.prompt;
      input.onOutput("stdout", `FIXLAB_TEST|${source}|none|Synthetic production-mode contract fixture.\n`);
      for (const stage of FIXLAB_STAGES) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|${["intake", "local-stack", "live-test"].includes(stage) ? "passed" : "skipped"}|Contract fixture.\n`);
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }, undefined, { autoTestEvidence: false });
    try {
      const remote = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Read approved API.", mode: "playwright-only", targetEnvironment: "dev" })
      });
      assert.equal(remote.response.status, 400);
      assert.match(remote.body.error, /only the local API environment/u);
      const created = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Read approved API.", mode: "playwright-only", targetEnvironment: "local" })
      });
      assert.equal(created.response.status, 202, JSON.stringify(created.body));
      const blocked = await jsonRequest(url, "/api/job");
      assert.equal(blocked.body.job.status, "blocked");
      assert.match(blocked.body.job.error, /database read-only check/u);
      assert.equal(prompt, "");
      assert.equal((await jsonRequest(url, "/api/playwright/connect", { method: "POST" })).response.status, 202);
      const deadline = Date.now() + 30000;
      let auth;
      do {
        await new Promise(resolve => setTimeout(resolve, 100));
        auth = await jsonRequest(url, "/api/playwright/status");
      } while (auth.body.running && Date.now() < deadline);
      assert.equal(auth.body.ready, true, JSON.stringify(auth.body));
      const resumed = await jsonRequest(url, "/api/job/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue", details: "Continue the synthetic contract test." })
      });
      assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
      const result = await jsonRequest(url, "/api/job");
      assert.match(prompt, /PRODUCTION database/u);
      assert.match(prompt, /assertReadOnlyDatabase/u);
      assert.equal(result.body.job.testEvidence.productionDatabaseReadOnly, true);
      assert.equal(result.body.job.testEvidence.reported, source === "production-read-only");
      if (source !== "production-read-only") {
        assert.equal(result.body.job.testEvidence.modeViolation, true);
        assert.equal(result.body.job.stages["live-test"].status, "failed");
      }
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

for (const [originallyApproved, changedOrigin] of [[false, false], [true, false], [true, true]]) {
  test(`saved API jobs cannot inherit changed production database approval (${originallyApproved}, origin ${changedOrigin})`, async () => {
    const repository = createProductionApiRepository({ persisted: true });
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = productionApiProfile();
    profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = originallyApproved;
    profile.browserAutomation.testSynthesis.defaultDataSource = originallyApproved
      ? "production-read-only" : "non-production-read-only";
    writeFileSync(path, JSON.stringify(profile));
    let running;
    try {
      running = await startDashboard(repository, ({ onOutput }) => {
        onOutput("stdout", "FIXLAB_STAGE|live-test|blocked|Synthetic prerequisite.\n");
        return { completion: Promise.resolve({ code: 0 }), terminate() {} };
      }, undefined, { autoTestEvidence: false });
      const created = await jsonRequest(running.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Read approved API.", mode: "playwright-only" })
      });
      assert.equal(created.response.status, 202);
      await running.dashboard.close();
      running = null;
      const history = JSON.parse(readFileSync(join(dirname(createCacheContext(repository).cachePath),
        "dashboard-jobs.json"), "utf8"));
      const saved = history.jobs.find(job => job.id === created.body.job.id);
      assert.equal(saved.testEvidence.productionDatabaseReadOnly === true, originallyApproved);
      if (changedOrigin) {
        profile.browserAutomation.dataSafety.allowedOrigins.push("https://production.example.invalid");
      } else {
        profile.browserAutomation.apiAuthentication.productionDatabaseReadOnly = !originallyApproved;
        profile.browserAutomation.testSynthesis.defaultDataSource = originallyApproved
          ? "non-production-read-only" : "production-read-only";
      }
      writeFileSync(path, JSON.stringify(profile));
      let launches = 0;
      running = await startDashboard(repository, () => {
        launches += 1;
        throw new Error("Changed approval must not launch an executor.");
      }, undefined, { autoTestEvidence: false });
      const restored = await jsonRequest(running.url, "/api/status");
      assert.equal(restored.body.job.id, created.body.job.id);
      assert.equal(restored.body.job.testEvidence.productionDatabaseReadOnly === true, originallyApproved);
      await jsonRequest(running.url, "/api/job/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue", details: "Resume the saved fixture." })
      });
      const result = await jsonRequest(running.url, "/api/job");
      assert.equal(launches, 0);
      assert.match(result.body.job.error, /newly reviewed local read-only job/u);
    } finally {
      await running?.dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("production database approval never enables portal UI authentication or UI jobs", async () => {
  const repository = createProductionApiRepository();
  const profile = validProfile();
  profile.browserAutomation.apiAuthentication = productionApiProfile().browserAutomation.apiAuthentication;
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("A portal UI executor must not start.");
  });
  try {
    const auth = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(auth.response.status, 403);
    const job = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Test portal.", mode: "playwright-only" })
    });
    assert.equal(job.response.status, 400);
    assert.match(job.body.error, /does not authorize portal UI jobs/u);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only jobs bypass browser ownership but reject UI options and require live scenario evidence", async () => {
  const repository = createRepository();
  const profile = apiProfile();
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  let ownershipCalls = 0;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    for (const stage of FIXLAB_STAGES) {
      input.onOutput("stdout", `FIXLAB_STAGE|${stage}|${["intake", "local-stack", "live-test"].includes(stage) ? "passed" : "skipped"}|API fixture\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  }, undefined, {
    autoTestEvidence: false,
    browserOwnership: () => { ownershipCalls += 1; throw new Error("API tests must not inspect browser profiles"); }
  });
  try {
    for (const option of ["manualLocalhostTest", "prestartFrontend", "recordPlaywrightVideo", "runAllUiScenarios"]) {
      const result = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Read the API.", mode: "playwright-only", [option]: true })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error, /API-only Playwright validation/);
    }
    const intercepted = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Read the API.", mode: "playwright-only", testMutationMode: "intercepted" })
    });
    assert.equal(intercepted.response.status, 400);
    assert.match(intercepted.body.error, /page interception does not protect APIRequestContext/);
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Read the API.", mode: "playwright-only" })
    });
    assert.equal(result.response.status, 202);
    const state = await jsonRequest(url, "/api/job");
    assert.equal(ownershipCalls, 0);
    assert.match(prompt, /Playwright-only mode: API validation/);
    assert.match(prompt, /APIRequestContext/);
    assert.match(prompt, /does not inherit page\.route interception/);
    assert.equal(state.body.job.stages["live-test"].status, "failed");
    assert.match(state.body.job.error, /FIXLAB_TEST scenario evidence/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const legacy of [false, true]) {
  test(`API-only ${legacy ? "legacy" : "current"} snapshots retain API guidance and reject synthetic evidence on resume`, async () => {
    const repository = createGitRepository();
    let current;
    try {
      writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(apiProfile()));
      current = await startDashboard(repository, ({ onOutput }) => {
        for (const stage of FIXLAB_STAGES) {
          onOutput("stdout", `FIXLAB_STAGE|${stage}|${stage === "live-test" ? "blocked" : "skipped"}|Awaiting API prerequisites.\n`);
        }
        return { completion: Promise.resolve({ code: 0 }), terminate() {} };
      }, undefined, { autoTestEvidence: false });
      const created = await jsonRequest(current.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Read the approved API.", mode: "playwright-only" })
      });
      assert.equal(created.response.status, 202);
      const jobId = created.body.job.id;
      await current.dashboard.close();
      current = null;
      const historyPath = join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json");
      const history = JSON.parse(readFileSync(historyPath, "utf8"));
      const saved = history.jobs.find((job) => job.id === jobId);
      assert.equal(saved.testEvidence.apiOnly, true);
      if (legacy) {
        delete saved.testEvidence.apiOnly;
        writeFileSync(historyPath, JSON.stringify(history));
      }
      let prompt;
      current = await startDashboard(repository, (input) => {
        prompt = input.prompt;
        input.onOutput("stdout", "FIXLAB_TEST|synthetic-intercepted|intercepted|Not real API evidence.\n");
        for (const stage of FIXLAB_STAGES) {
          input.onOutput("stdout", `FIXLAB_STAGE|${stage}|${["intake", "local-stack", "live-test"].includes(stage) ? "passed" : "skipped"}|API fixture.\n`);
        }
        return { completion: Promise.resolve({ code: 0 }), terminate() {} };
      }, undefined, { autoTestEvidence: false });
      const restored = await jsonRequest(current.url, "/api/status");
      assert.equal(restored.body.job.id, jobId);
      assert.equal(restored.body.job.testEvidence.apiOnly, true);
      const resumed = await jsonRequest(current.url, "/api/job/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue", details: "Continue read-only API validation." })
      });
      assert.equal(resumed.response.status, 202);
      assert.match(prompt, /Playwright-only mode: API validation/);
      assert.match(prompt, /APIRequestContext/);
      const result = await jsonRequest(current.url, "/api/status");
      assert.equal(result.body.job.testEvidence.apiOnly, true);
      assert.equal(result.body.job.testEvidence.modeViolation, true);
      assert.equal(result.body.job.testEvidence.reported, false);
      assert.equal(result.body.job.stages["live-test"].status, "failed");
    } finally {
      await current?.dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("dashboard readiness blocks an incomplete live-test profile", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    delete profile.browserAutomation.testCommand;
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.repositoryReady, true);
    assert.equal(readiness.profileReady, false);
    assert.match(readiness.error, /live-test profile is incomplete/);
    assert.match(readiness.error, /browserAutomation\.testCommand/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness rejects credentials in a loopback health URL", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const readiness = inspectRepository(repository);
  assert.equal(readiness.profileReady, false);
  assert.match(readiness.error, /credential-free loopback URL required/);
  rmSync(repository, { recursive: true, force: true });
});

test("dashboard readiness validates configured test synthesis", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    profile.browserAutomation.testSynthesis.mutationMode = "external-write";
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(
      readiness.error,
      /browserAutomation\.testSynthesis\.mutationMode/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness requires an explicit test synthesis contract", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile();
    delete profile.browserAutomation.testSynthesis;
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(readiness.error, /browserAutomation\.testSynthesis/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard readiness validates the agent idle timeout", () => {
  const repository = createRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );

  try {
    const profile = validProfile({
      validation: { agentIdleTimeoutMinutes: 0 }
    });
    writeFileSync(profilePath, JSON.stringify(profile));

    const readiness = inspectRepository(repository);

    assert.equal(readiness.profileReady, false);
    assert.match(
      readiness.error,
      /validation\.agentIdleTimeoutMinutes/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("connected Copilot recovery reuses reviewed work, preserves the same job and defers full regression", async () => {
  const source = createGitRepository();
  const repository = mkdtempSync(join(tmpdir(), "fixlab-conversation-"));
  const executions = [];
  const profile = validProfile({ worktreeSetup: { mode: "shared", baseBranch: "develop" } });
  writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(source, ["branch", "-m", "develop"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "shared profile"]);
  git(source, ["clone", "--quiet", source, repository]);
  const oldJob = randomUUID();
  const branch = `users/fixlab-test/fixlab-${oldJob}`;
  git(repository, ["switch", "--quiet", "-c", branch]);
  const originalTracked = readFileSync(join(repository, "tracked.txt"));
  writeFileSync(join(repository, "tracked.txt"), "existing fix");
  const executor = (input) => {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    executions.push({ input, finish });
    return { completion, terminate() { finish({ code: null, signal: "SIGTERM" }); } };
  };
  let current = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const created = await post("/api/jobs", { request: "Continue the existing fix and PR.", mode: "fix-and-validate" });
    assert.equal(created.body.job.status, "blocked");
    assert.equal(created.body.job.stages.intake.status, "blocked");
    assert.equal(created.body.job.stages.fix.status, "skipped");
    assert.doesNotMatch(created.body.job.error, /incomplete|missing stage/i);
    assert.equal(executions.length, 0);
    const args = { repository: realpathSync(repository), port: Number(new URL(current.url).port) };
    let status = await dashboardConversation(args);
    assert.equal(status.question.kind, "workspace");
    assert.equal(status.workspaceReview.branch, branch);
    assert.equal(JSON.stringify(status).includes("logs"), false);
    const reply = {
      ...args, instanceId: status.instanceId, jobId: status.job.id, confirmed: true,
      action: "continue", details: "Reuse this branch and its existing PR. Run scoped tests only.",
      reviewedWorkspace: status.workspaceReview, validationIntent: "scoped"
    };
    const staleInstance = await post("/api/conversation/reply", { ...reply, instanceId: "old-instance" });
    assert.equal(staleInstance.response.status, 409);
    for (const invalid of [
      { confirmed: false }, { jobId: randomUUID() }, { repository: source }
    ]) {
      assert.equal((await post("/api/conversation/reply", { ...reply, ...invalid })).response.status, 409);
    }
    const browserReply = await jsonRequest(current.url, "/api/conversation/reply", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
      body: JSON.stringify(reply)
    });
    assert.equal(browserReply.response.status, 403);
    writeFileSync(join(repository, "tracked.txt"), "changed after review");
    await assert.rejects(dashboardConversation(reply, true), /changed since review/);
    assert.equal(executions.length, 0);
    status = await dashboardConversation(args);
    reply.reviewedWorkspace = status.workspaceReview;
    const resumed = await dashboardConversation(reply, true);
    assert.equal(resumed.job.id, created.body.job.id);
    assert.equal(resumed.job.validationIntent, "scoped");
    assert.equal(resumed.job.pullRequestReadiness.ready, false);
    assert.match(resumed.job.pullRequestReadiness.message, /explicitly deferred/);
    assert.equal(git(repository, ["branch", "--show-current"]), branch);
    assert.equal(readFileSync(join(repository, "tracked.txt"), "utf8"), "changed after review");
    assert.equal(executions.length, 1);
    assert.equal(executions[0].input.sessionId, created.body.job.id);
    assert.equal(executions[0].input.resume, false, "admission never created a runtime session to resume");
    assert.match(executions[0].input.prompt, /Full regression is explicitly deferred/);
    assert.match(executions[0].input.prompt, /Continue independent safe checks/);
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    args.port = Number(new URL(current.url).port);
    const restored = await jsonRequest(current.url, "/api/status");
    assert.equal(restored.body.job.sharedWorkspace.branch, branch);
    assert.equal(restored.body.job.sharedWorkspace.reusedFromJobId, oldJob);
    assert.equal(restored.body.job.validationIntent, "scoped");
    writeFileSync(join(repository, "tracked.txt"), originalTracked);
    writeFileSync(join(repository, "preserved.ts"), "export const preserved = true;\n");
    const blocked = await post("/api/jobs/restart", { jobId: restored.body.job.id });
    assert.equal(blocked.body.job.status, "blocked");
    status = await dashboardConversation(args);
    const recovery = {
      confirmed: true, instanceId: status.instanceId, jobId: status.job.id,
      repository: realpathSync(repository), workspaceRecovery: status.workspaceReview
    };
    for (const invalid of [
      { confirmed: false }, { instanceId: "old-instance" }, { repository: source }, { jobId: oldJob }
    ]) {
      assert.equal((await post("/api/jobs/restart", { ...recovery, ...invalid })).response.status, invalid.jobId ? 404 : 409);
      assert.equal(existsSync(join(repository, "preserved.ts")), true);
    }
    writeFileSync(join(repository, "preserved.ts"), "export const preserved = 2;\n");
    assert.equal((await post("/api/jobs/restart", recovery)).response.status, 409);
    status = await dashboardConversation(args);
    recovery.workspaceRecovery = status.workspaceReview;
    const fresh = await post("/api/jobs/restart", recovery);
    assert.equal(fresh.response.status, 202, fresh.body.error);
    assert.notEqual(fresh.body.job.id, blocked.body.job.id);
    assert.equal(fresh.body.job.sharedWorkspace.branch, `users/fixlab-test/fixlab-${fresh.body.job.id}`);
    assert.equal(fresh.body.job.sharedWorkspace.baseCommit, git(source, ["rev-parse", "HEAD"]));
    assert.equal(git(repository, ["branch", "--show-current"]), fresh.body.job.sharedWorkspace.branch);
    assert.equal(git(repository, ["show", `${fresh.body.workspaceStash.stashRef}^3:preserved.ts`]), "export const preserved = 2;");
    assert.equal(existsSync(join(repository, "preserved.ts")), false);
    assert.equal(git(repository, ["rev-parse", branch]), git(source, ["rev-parse", "HEAD"]));
    assert.equal(executions.length, 2);
    assert.equal(executions[1].input.resume, false);
    assert.equal(executions[1].input.sessionId, fresh.body.job.id);
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    assert.equal((await jsonRequest(current.url, "/api/status")).body.job.workspaceStash.stashRef, fresh.body.workspaceStash.stashRef);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

for (const mode of ["fix-and-validate", "validate-only"]) {
  test(`automatic shared-job preservation respects ${mode} and records the stash before execution`, async () => {
    const source = createGitRepository();
    const repository = mkdtempSync(join(tmpdir(), "fixlab-auto-stash-server-"));
    const profile = validProfile({ worktreeSetup: { mode: "shared", baseBranch: "develop", autoStash: true } });
    writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
    git(source, ["branch", "-m", "develop"]);
    git(source, ["add", "."]);
    git(source, ["commit", "--quiet", "-m", "shared automatic preservation profile"]);
    git(source, ["clone", "--quiet", source, repository]);
    writeFileSync(join(repository, "pending.ts"), "export const pending = true;\n");
    let executions = 0;
    const current = await startDashboard(repository, () => {
      executions++;
      let finish;
      return { completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: null, signal: "SIGTERM" }); } };
    });
    try {
      const created = await jsonRequest(current.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Synthetic automatic workspace preparation.", mode })
      });
      assert.equal(created.response.status, 202, created.body.error);
      assert.equal(executions, 1, created.body.job.error);
      const job = created.body.job;
      if (mode === "fix-and-validate") {
        assert.equal(job.sharedWorkspace.branch, `users/fixlab-test/fixlab-${job.id}`);
        assert.match(job.workspaceStash.stashRef, /^[a-f0-9]{40,64}$/u);
        assert.equal(git(repository, ["show", `${job.workspaceStash.stashRef}^3:pending.ts`]), "export const pending = true;");
        assert.equal(existsSync(join(repository, "pending.ts")), false);
      } else {
        assert.equal(job.workspaceStash, null);
        assert.equal(git(repository, ["branch", "--show-current"]), "develop");
        assert.equal(git(repository, ["stash", "list"]), "");
        assert.equal(existsSync(join(repository, "pending.ts")), true);
      }
    } finally {
      await current.dashboard.close();
      rmSync(repository, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
}

test("connected control starts scoped browser jobs, manages the queue and stops only the owned execution", async () => {
  const repository = createGitRepository();
  const calls = [];
  let stopped = 0;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    calls.push(input);
    let finish;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { stopped += 1; finish({ code: null, signal: "SIGTERM" }); }
    };
  });
  const base = { repository: realpathSync(repository), port: Number(new URL(url).port) };
  const control = async (operation, parameters = {}, overrides = {}) => {
    const state = await dashboardConversation(base);
    return dashboardControl({
      ...base, instanceId: state.instanceId, jobId: state.job?.id ?? null,
      confirmed: true, operation, parameters, ...overrides
    });
  };
  try {
    for (const operation of ["sessions", "metrics", "onboarding-status"]) {
      assert.equal((await control(operation)).operation, operation);
    }
    await assert.rejects(control("job-start", {}, { confirmed: false }), /explicit user authorization/);
    await assert.rejects(control("job-start", {}, { instanceId: "stale" }), /current instance/);
    await assert.rejects(control("https://example.test"), /Unknown dashboard operation/);
    await assert.rejects(control("job-start", { request: "x".repeat(65537) }), /64 KiB/);
    await assert.rejects(control("job-start", {
      request: "Reject an invalid validation intent.", mode: "validate-only", validationIntent: "unlimited"
    }), /validationIntent/);
    assert.equal(calls.length, 0);
    const started = await control("job-start", {
      request: "Test the checked-out PR using configured Playwright settings. Do not modify code.",
      mode: "playwright-only", targetEnvironment: "dev", validationIntent: "scoped"
    });
    assert.equal(started.state.job.status, "running");
    assert.equal(started.state.job.validationIntent, "scoped");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "playwright-only");
    assert.match(calls[0].prompt, /Playwright-only mode/);
    assert.match(calls[0].prompt, /Do not edit files/);
    assert.match(calls[0].prompt, /Full regression is explicitly deferred/);
    assert.match(calls[0].prompt, /Assigned dashboard connection/u);
    assert.ok(calls[0].prompt.includes(`Repository: ${JSON.stringify(base.repository)}`));
    assert.ok(calls[0].prompt.includes(`Port: ${base.port}`));
    assert.ok(calls[0].prompt.includes(`Instance ID: ${started.state.instanceId}`));
    assert.ok(calls[0].prompt.includes(`Job ID: ${started.state.job.id}`));
    assert.doesNotMatch(calls[0].prompt, /Dashboard-owned required validation/u);
    assert.equal(JSON.stringify(started).includes('"logs"'), false);
    const queued = await control("job-start", { request: "Queue another check.", mode: "validate-only" });
    assert.equal(queued.result.queued, true);
    await control("queue-cancel", { jobId: queued.result.queuedJob.id });
    assert.equal(calls.length, 1);
    const current = await dashboardConversation(base);
    const stale = await jsonRequest(url, "/api/frontend/stop", {
      method: "POST", headers: {
        "Content-Type": "application/json", "x-fixlab-operation": "frontend-stop",
        "x-fixlab-instance": current.instanceId, "x-fixlab-job": "stale-job",
        "x-fixlab-repository": encodeURIComponent(base.repository), "x-fixlab-confirmed": "true"
      }, body: "{}"
    });
    assert.equal(stale.response.status, 409);
    await control("frontend-stop");
    await control("job-stop");
    assert.equal(stopped, 1);
    assert.equal(calls.length, 1);
    const state = await dashboardConversation(base);
    assert.equal(state.job.canResume, true);
    await control("job-dismiss");
    assert.equal((await dashboardConversation(base)).job, null);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("connected PPE jobs default reviewed writes and routine test access, preserving explicit opt-outs", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-approved";
  profile.browserAutomation.testSynthesis.mutationMode = "approved-write";
  profile.environments = ["dev", "sit", "uat", "ppe"];
  profile.browserAutomation.dataSafety.ppeWrite = {
    scope: "api://example-service/access", sessionHelper: "ppe-session.mjs",
    origins: ["https://api.ppe.example.test"]
  };
  writeFileSync(join(repository, "ppe-session.mjs"),
    'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const launches = [];
  const { dashboard, url } = await startDashboard(repository, (input) => {
    launches.push(input);
    input.onOutput("stdout", `${"Synthetic retained output. ".repeat(160)}\n`.repeat(40));
    return { completion: new Promise(() => {}) };
  }, undefined, { runtime: "copilot" });
  const base = { repository, port: Number(new URL(url).port) };
  const start = async (parameters) => {
    const state = await dashboardConversation(base);
    return dashboardControl({ ...base, instanceId: state.instanceId, jobId: state.job?.id ?? null,
      operation: "job-start", confirmed: true,
      parameters: { request: "Synthetic future-job defaults.", mode: "fix-and-validate",
        targetEnvironment: "ppe", ...parameters } });
  };
  try {
    assert.equal(inspectRepository(repository).ppeWriteConfigured, true);
    await start({});
    assert.equal(launches[0].postWriteApproval.mode, "ppe-origin");
    assert.equal(launches[0].fileAccess.mode, "source-read-write");
    assert.equal(launches[0].fileAccess.allowValidationGates, true);
    assert.equal(launches[0].toolApprovalMode, "ask");
    assert.ok(Buffer.byteLength(JSON.stringify((await jsonRequest(url, "/api/status")).body)) > 128 * 1024,
      "long-job logs must not enter the bounded MCP default lookup");
    for (const parameters of [
      { targetEnvironment: "dev" }, { targetEnvironment: "sit" }, { targetEnvironment: "uat" },
      { allowPpeWrites: false, routineFileAccess: false }, { ppeWriteApprovalConfirmed: false },
      { testMutationMode: "none" }, { testMutationMode: "intercepted" },
      { allowPostRequests: true }
    ]) {
      await start({ mode: "validate-only", ...parameters });
      const queued = (await jsonRequest(url, "/api/job")).body.queue.at(-1);
      assert.equal(queued.ppeWriteApproved, false, JSON.stringify(parameters));
      assert.equal(queued.fileAccess?.mode ?? null, parameters.routineFileAccess === false ? null : "source-read");
    }
    profile.browserAutomation.dataSafety.ppeWrite.origins = ["https://api.prod.example.test"];
    writeFileSync(profilePath, JSON.stringify(profile));
    const invalid = inspectRepository(repository);
    assert.equal(invalid.profileReady, true, "optional write setup must not block read-only validation");
    assert.equal(invalid.ppeWriteConfigured, false);
    assert.match(invalid.ppeWriteSetupError, /PPE write origins/);
    await start({});
    assert.equal((await jsonRequest(url, "/api/job")).body.queue.at(-1).ppeWriteApproved, false);
    await assert.rejects(start({ allowPpeWrites: true, ppeWriteApprovalConfirmed: true }), /PPE write origins/);
    delete profile.browserAutomation.dataSafety.ppeWrite;
    writeFileSync(profilePath, JSON.stringify(profile));
    await start({});
    assert.equal((await jsonRequest(url, "/api/job")).body.queue.at(-1).ppeWriteApproved, false);
    assert.equal(launches.length, 1, "future-job defaults do not resume or alter the active executor");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("connected control rechecks job identity after an asynchronous request body", async () => {
  const repository = createGitRepository();
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}), terminate() {}
  }));
  try {
    const state = (await jsonRequest(url, "/api/conversation")).body;
    let slow;
    const response = new Promise((resolveResponse, reject) => {
      slow = createHttpRequest(`${url}/api/jobs`, {
        method: "POST", headers: {
          "Content-Type": "application/json", "x-fixlab-operation": "job-start",
          "x-fixlab-instance": state.instanceId, "x-fixlab-job": "none",
          "x-fixlab-repository": encodeURIComponent(realpathSync(repository)),
          "x-fixlab-confirmed": "true"
        }
      }, (result) => {
        result.resume();
        result.once("end", () => resolveResponse(result.statusCode));
      });
      slow.once("error", reject);
      slow.write('{"request":"Do not queue this stale request",');
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "The current authorized job.", mode: "validate-only" })
    });
    slow.end('"mode":"validate-only"}');
    assert.ok([400, 409].includes(await response));
    const status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.queue.length, 0);
    assert.equal(status.body.job.request, "The current authorized job.");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("operation summaries omit logs, browser state, credentials and binary artifacts", () => {
  const compact = compactControlResult({
    job: { id: "job-1", status: "blocked", logs: [{ message: "private" }], screenshots: ["private"] },
    authentication: { connected: false, storageState: "private", statusPaths: ["private"] },
    headers: { authorization: "private" }, token: "private",
    error: "Blocked at https://example.test/private", sessions: [{ id: "owner-1", pid: 42 }]
  });
  assert.doesNotMatch(JSON.stringify(compact), /private|storageState|authorization|statusPaths|screenshots|"logs"/);
  assert.equal(compact.job.id, "job-1");
  assert.equal(compact.sessions[0].pid, 42);
  assert.equal(Object.keys(conversationOperations).length, 23);
  assert.deepEqual(conversationOperations["validation-select"], {
    method: "POST", path: "/api/job/checks"
  });
});

test("shared dashboard jobs refresh develop, reuse one checkout and reacquire held branches after restart", async () => {
  const source = createGitRepository();
  const repository = mkdtempSync(join(tmpdir(), "fixlab-shared-dashboard-"));
  const executions = [];
  const profile = validProfile({ worktreeSetup: { mode: "shared", baseBranch: "develop" } });
  writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(source, ["branch", "-m", "develop"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "configure shared runner"]);
  git(source, ["clone", "--quiet", source, repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  const executor = (input) => {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    executions.push({ input, finish, branch: git(repository, ["branch", "--show-current"]) });
    return { completion, terminate() { finish({ code: null, signal: "SIGTERM" }); } };
  };
  let current = await startDashboard(repository, executor);
  const requestJson = (path, body) => jsonRequest(current.url, path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const waitUntil = async (condition) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition());
  };
  const block = (execution) => {
    execution.input.onOutput("stdout", "FIXLAB_STAGE|intake|blocked|Retain this job.\n");
    execution.finish({ code: 0 });
  };
  try {
    const first = await requestJson("/api/jobs", { request: "First shared fix.", mode: "fix-and-validate" });
    assert.equal(first.response.status, 202);
    const firstId = first.body.job.id;
    const firstBranch = first.body.job.sharedWorkspace.branch;
    assert.equal(executions[0].branch, firstBranch);
    assert.match(executions[0].input.prompt, /Shared worktree contract/);
    writeFileSync(join(repository, "first-fix.txt"), "first fix");
    git(repository, ["add", "first-fix.txt"]);
    git(repository, ["commit", "--quiet", "-m", "first fix"]);
    const firstCommit = git(repository, ["rev-parse", "HEAD"]);
    block(executions[0]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    await requestJson("/api/jobs/hold", { jobId: firstId });
    writeFileSync(join(source, "upstream.txt"), "fresh develop");
    git(source, ["add", "upstream.txt"]);
    git(source, ["commit", "--quiet", "-m", "advance develop"]);
    const second = await requestJson("/api/jobs", { request: "Second independent fix.", mode: "fix-and-validate" });
    assert.equal(second.response.status, 202);
    assert.notEqual(second.body.job.sharedWorkspace.branch, firstBranch);
    assert.equal(second.body.job.sharedWorkspace.baseCommit, git(source, ["rev-parse", "HEAD"]));
    assert.equal(executions[1].input.repository, repository);
    assert.equal(existsSync(join(repository, "first-fix.txt")), false);
    assert.equal(readFileSync(join(repository, "upstream.txt"), "utf8"), "fresh develop");
    block(executions[1]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    await requestJson("/api/jobs/hold", { jobId: second.body.job.id });
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    const restored = await requestJson("/api/status");
    assert.equal(restored.body.held.find((job) => job.id === firstId).sharedWorkspace.branch, firstBranch);
    const resumed = await requestJson("/api/jobs/resume", { jobId: firstId });
    assert.equal(resumed.response.status, 202);
    assert.equal(executions[2].input.sessionId, firstId);
    assert.equal(executions[2].input.resume, true);
    assert.equal(git(repository, ["rev-parse", "HEAD"]), firstCommit);
    assert.equal(existsSync(join(repository, "upstream.txt")), false);
    assert.equal(readFileSync(join(repository, "first-fix.txt"), "utf8"), "first fix");
    block(executions[2]);
    await waitUntil(() => !existsSync(join(repository, ".git", "fixlab", "executor-lease")));
    const restarted = await requestJson("/api/jobs/restart", { jobId: firstId });
    assert.equal(restarted.response.status, 202);
    assert.notEqual(restarted.body.job.id, firstId);
    assert.notEqual(restarted.body.job.sharedWorkspace.branch, firstBranch);
    assert.equal(restarted.body.job.sharedWorkspace.baseCommit, git(source, ["rev-parse", "HEAD"]));
    assert.equal(executions[3].input.resume, false);
    assert.equal(existsSync(join(repository, "first-fix.txt")), false);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

for (const shared of [false, true]) {
test(`dashboard validation rejects sibling evidence in ${shared ? "shared" : "isolated"} mode`, async () => {
  const source = createGitRepository();
  const repository = mkdtempSync(join(tmpdir(), "fixlab-shared-validation-"));
  const sibling = mkdtempSync(join(tmpdir(), "fixlab-shared-sibling-"));
  writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
    ...(shared ? { worktreeSetup: { mode: "shared", baseBranch: "develop" } } : {}),
    validation: { gates: [{
      id: "tests", command: process.execPath,
      args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('tracked.txt','utf8'),'assigned fix')"],
      workingDirectory: ".", timeoutSeconds: 30
    }] }
  })));
  git(source, ["branch", "-m", "develop"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "shared validation"]);
  git(source, ["clone", "--quiet", source, repository]);
  git(repository, ["worktree", "add", "--quiet", "--detach", sibling]);
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}), terminate() {}
  }));
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Validate the assigned checkout.", mode: "fix-and-validate" });
    assert.equal(started.body.job.status, "running");
    assert.equal(Boolean(started.body.job.sharedWorkspace), shared);
    writeFileSync(join(repository, "tracked.txt"), "assigned fix");
    const rejected = await post("/api/validation/run", {
      jobId: started.body.job.id, gateId: "tests", repository: sibling
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /assigned checkout/);
    const pending = await jsonRequest(url, "/api/status");
    assert.equal(pending.body.job.validation.gates[0].status, "pending");
    const accepted = await post("/api/validation/run", {
      jobId: started.body.job.id, gateId: "tests", repository
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.status, 0);
  } finally {
    await dashboard.close();
    git(repository, ["worktree", "remove", "--force", sibling]);
    rmSync(repository, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
}

test("shared dashboard rejects dirty checkout acquisition without launching or retaining an executor lease", async () => {
  const repository = createGitRepository();
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
    worktreeSetup: { mode: "shared", baseBranch: "develop" }
  })));
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "shared policy"]);
  writeFileSync(join(repository, "uncommitted.txt"), "preserve");
  const { dashboard, url } = await startDashboard(repository, () => { throw new Error("Must not launch."); });
  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Preserve dirty state.", mode: "fix-and-validate" })
    });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.job.status, "failed");
    assert.match(result.body.job.error, /uncommitted or untracked/);
    assert.equal(readFileSync(join(repository, "uncommitted.txt"), "utf8"), "preserve");
    const reservation = createExecutorLease(repository, "test").acquire("test");
    reservation.release();
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

function createGitRepository() {
  const repository = createRepository();
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "fixlab@example.invalid"]);
  git(repository, ["config", "user.name", "FixLab Test"]);
  writeFileSync(join(repository, "tracked.txt"), "initial\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Initial state"]);
  return repository;
}

function createApiValidationRepository(baseRef = "HEAD") {
  const repository = createGitRepository();
  mkdirSync(join(repository, "api"));
  mkdirSync(join(repository, "web"));
  writeFileSync(join(repository, "api", "service.cs"), "initial");
  writeFileSync(join(repository, "web", "view.ts"), "initial");
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
    validation: {
      apiOnly: {
        baseRef,
        paths: ["api"],
        fullValidationPaths: ["api/Contracts"],
        gateIds: ["backend-tests"]
      },
      gates: [
        { id: "backend-tests", command: process.execPath, args: ["-e", "process.exit(0)"], workingDirectory: ".", timeoutSeconds: 30 },
        { id: "frontend-tests", command: process.execPath, args: ["-e", "process.exit(23)"], workingDirectory: ".", timeoutSeconds: 30 }
      ]
    }
  })));
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Reviewed API scope"]);
  return repository;
}

async function startDashboard(
  repository,
  executor,
  workItemLoader,
  options = {}
) {
  const effectiveExecutor =
    options.autoTestEvidence === false
      ? executor
      : (input) => {
          let reported = false;
          return executor({
            ...input,
            onOutput(stream, text) {
              if (/FIXLAB_TEST\|/u.test(text)) {
                reported = true;
              }
              if (
                !reported &&
                /FIXLAB_STAGE\|live-test\|passed\|/u.test(text)
              ) {
                input.onOutput(
                  "stdout",
                  "FIXLAB_TEST|synthetic-intercepted|intercepted|Test harness scenario evidence.\n"
                );
                reported = true;
              }
              input.onOutput(stream, text);
            }
          });
        };
  const trackedExecutor = (input) => {
    const handle = effectiveExecutor(input);
    if (options.deferTermination) {
      return handle;
    }
    let stopped;
    const termination = new Promise((resolve) => { stopped = resolve; });
    return {
      ...handle,
      completion: Promise.race([handle.completion, termination]),
      terminate() {
        handle.terminate?.();
        stopped({ code: null, signal: "SIGTERM" });
      }
    };
  };
  const dashboard = createDashboardServer({
    repository,
    packageRoot,
    executor: trackedExecutor,
    browserOpener() {},
    ...Object.fromEntries(
      Object.entries(options).filter(([name]) => name !== "autoTestEvidence")
    ),
    ...(workItemLoader ? { workItemLoader } : {})
  });
  const address = await dashboard.listen({ port: await availablePort() });
  return { dashboard, url: address.url };
}

async function jsonRequest(url, path, options) {
  const { body, ...requestOptions } = options ?? {};
  // Blocking Git work and restarts must not reuse the runtime's self-probe sockets.
  const result = await new Promise((resolve, reject) => {
    const request = createHttpRequest(`${url}${path}`, {
      ...requestOptions,
      agent: false,
      signal: requestOptions.signal ?? AbortSignal.timeout(300000)
    }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { content += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({
        response: { status: response.statusCode }, body: content
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
  return { response: result.response, body: JSON.parse(result.body) };
}

test("dashboard JSON fixtures isolate their sockets from runtime self-probes", async () => {
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    sockets.add(request.socket);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.writeHead(request.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        method: request.method,
        marker: request.headers["x-fixture"] ?? null,
        payload: body ? JSON.parse(body) : null
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await (await fetch(`${url}/api/session`)).json();
    await new Promise((resolve) => setImmediate(resolve));
    const created = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fixture": "isolated" },
      body: JSON.stringify({ request: "Synthetic fixture." })
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.body, {
      method: "POST", marker: "isolated", payload: { request: "Synthetic fixture." }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const status = await jsonRequest(url, "/api/status");
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body, { method: "GET", marker: null, payload: null });
    assert.equal(sockets.size, 3, "Fixture requests must not reuse self-probe or earlier fixture sockets.");
  } finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});

async function approvePreflightDirectory(url, job, directory) {
  const post = (body) => jsonRequest(url, "/api/job/permissions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const reviewed = await post({
    action: "review-directory", jobId: job.id, requestId: job.permissionRequest.id, directory
  });
  assert.equal(reviewed.response.status, 200, reviewed.body.error);
  return post({
    action: "approve-directory", jobId: job.id, requestId: reviewed.body.job.permissionRequest.id,
    directory: reviewed.body.job.permissionRequest.scope.directory, confirmed: true
  });
}

test("idle status polling and cache inspection hide their Git windows", async (context) => {
  const repository = createGitRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("Idle status polling must not start an executor");
  });
  const invocation = context.mock.method(childProcess, "spawnSync");
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 2; index += 1) {
      const status = await jsonRequest(url, "/api/status");
      assert.equal(status.response.status, 200);
      assert.equal(status.body.readiness.profileReady, true);
      assert.equal(status.body.job, null);
    }
    assert.ok(createCacheContext(repository)?.key);
    const probes = invocation.mock.calls
      .map((call) => call.arguments)
      .filter(([command]) => command === "git");
    assert.ok(probes.filter(([, args]) => args.includes("--git-common-dir")).length >= 3);
    assert.ok(probes.some(([, args]) => args.includes("HEAD")));
    for (const [, args, options] of probes) {
      assert.equal(options.windowsHide, true, `Git probe must not open a window: ${args.join(" ")}`);
      assert.equal(options.shell, false);
    }
  } finally {
    invocation.mock.restore();
    syncBuiltinESMExports();
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("job admission rejects invalid default validation profiles without stopping the dashboard", async () => {
  const repository = createGitRepository();
  let executions = 0;
  const { dashboard, url } = await startDashboard(repository, () => {
    executions += 1;
    return { completion: Promise.resolve({ code: 0 }) };
  });
  try {
    const gate = { id: "tests", command: process.execPath, args: ["--version"],
      workingDirectory: ".", timeoutSeconds: 30 };
    for (const [validation, expected] of [
      [{ gates: [] }, /validation\.gates/u],
      [{ gates: [gate], changeAware: { baseRef: "HEAD", fullValidationPaths: [".github"],
        scopes: [{ paths: ["api"], gateIds: ["unknown-gate"] }] } }, /unique gateIds/u]
    ]) {
      writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"),
        JSON.stringify(validProfile({ validation })));
      const rejected = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Validate safe invalid-profile admission.", mode: "validate-only" }),
        signal: AbortSignal.timeout(5000)
      });
      assert.equal(rejected.response.status, 400);
      assert.match(rejected.body.error, expected);
      assert.equal((await jsonRequest(url, "/api/status")).response.status, 200);
    }
    assert.equal(executions, 0);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("new DEV/PPE portal defaults use real reads only in their environments and preserve existing safety contracts", () => {
  const profile = validProfile();
  profile.browserAutomation.testSynthesis.devReadOnly = true;
  profile.browserAutomation.testSynthesis.ppeReadOnly = true;
  const original = JSON.stringify(profile);
  for (const environment of ["dev", "DEV", "development"]) {
    const evidence = configuredTestSynthesis(profile, "", undefined, environment);
    assert.equal(evidence.source, "non-production-read-only");
    assert.equal(evidence.mutationMode, "intercepted");
    assert.equal(evidence.devReadOnly, true);
    assert.equal(configuredTestSynthesis(profile, "none", undefined, environment).mutationMode, "none");
  }
  for (const environment of ["ppe", "PPE"]) {
    const evidence = configuredTestSynthesis(profile, "", undefined, environment);
    assert.equal(evidence.source, "non-production-read-only");
    assert.equal(evidence.mutationMode, "intercepted");
    assert.equal(evidence.ppeReadOnly, true);
    assert.equal(evidence.devReadOnly, undefined);
  }
  for (const environment of ["", "local", "sit", "uat", "production", "dev-production", "ppe-production"]) {
    const evidence = configuredTestSynthesis(profile, "", undefined, environment);
    assert.equal(evidence.source, "synthetic-intercepted", environment);
    assert.equal(evidence.devReadOnly, undefined);
  }
  assert.equal(JSON.stringify(profile), original);
  profile.browserAutomation.testSynthesis.devReadOnly = false;
  assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").source, "synthetic-intercepted");
  delete profile.browserAutomation.testSynthesis.devReadOnly;
  assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").source, "synthetic-intercepted");
  profile.browserAutomation.testSynthesis.devReadOnly = "yes";
  assert.throws(() => configuredTestSynthesis(profile, "", undefined, "dev"), /devReadOnly must be a boolean/u);
  assert.equal(validateLiveTestProfile(profile).ok, false);
  profile.browserAutomation.testSynthesis.devReadOnly = true;
  profile.browserAutomation.testSynthesis.ppeReadOnly = false;
  assert.equal(configuredTestSynthesis(profile, "", undefined, "ppe").source, "synthetic-intercepted");
  delete profile.browserAutomation.testSynthesis.ppeReadOnly;
  assert.equal(configuredTestSynthesis(profile, "", undefined, "ppe").source, "synthetic-intercepted");
  profile.browserAutomation.testSynthesis.ppeReadOnly = "yes";
  assert.throws(() => configuredTestSynthesis(profile, "", undefined, "ppe"), /ppeReadOnly must be a boolean/u);
  assert.equal(validateLiveTestProfile(profile).ok, false);
  profile.browserAutomation.testSynthesis.ppeReadOnly = true;
  profile.browserAutomation.testSynthesis.defaultDataSource = "local-fixture";
  assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").source, "local-fixture");
  profile.browserAutomation.mode = "api";
  profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
  profile.browserAutomation.testSynthesis.mutationMode = "none";
  assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").devReadOnly, undefined);
  profile.validation = { liveTestsRequired: false };
  assert.equal(configuredTestSynthesis(profile, "", undefined, "dev").unitTestsOnly, true);
});

test("connected starts accept explicitly confirmed all-POST and Allow all for selected lower environments", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.environments = ["dev", "sit", "uat"];
  profile.browserAutomation.dataSafety.post = Object.fromEntries(profile.environments.map((environment) => [
    environment, {
      scope: "api://example-service/access", sessionHelper: "post-session.mjs",
      baseUrls: [`https://api.shared.example.test/api/${environment}/v1`]
    }
  ]));
  writeFileSync(join(repository, "post-session.mjs"),
    'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const launches = [];
  const { dashboard, url } = await startDashboard(repository, (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  }, undefined, { runtime: "copilot" });
  const base = { repository, port: Number(new URL(url).port) };
  const start = async (parameters = {}, confirmed = true) => {
    const state = await dashboardConversation(base);
    return dashboardControl({
      ...base, instanceId: state.instanceId, jobId: state.job?.id ?? null,
      operation: "job-start", confirmed,
      parameters: {
        request: "Synthetic approved lower-environment live scenarios.", mode: "validate-only",
        targetEnvironment: "dev", allowPostRequests: true,
        postWriteApprovalConfirmed: true, postBaseApprovalConfirmed: true,
        toolApprovalMode: "allow-all", allowAllConfirmed: true, runAllUiScenarios: true,
        ...parameters
      }
    });
  };
  try {
    await assert.rejects(start({}, false), /explicit user authorization/u);
    for (const parameters of [
      { allowAllConfirmed: false }, { postWriteApprovalConfirmed: false },
      { postBaseApprovalConfirmed: "yes" }, { allowPostRequests: false },
      { targetEnvironment: "production" }, { testMutationMode: "none" },
      { testMutationMode: "intercepted" }
    ]) {
      await assert.rejects(start(parameters));
    }
    assert.equal(launches.length, 0);
    for (const environment of profile.environments) {
      await start({ targetEnvironment: environment });
      const state = (await jsonRequest(url, "/api/job")).body;
      const job = state.queue.at(-1) ?? state.job;
      assert.equal(job.targetEnvironment, environment);
      assert.equal(job.postWriteApproved, true);
      assert.equal(job.toolApprovalMode, "allow-all");
      assert.equal(job.runAllUiScenarios, true);
    }
    assert.equal(launches.length, 1, "queued grants never alter the active executor");
    assert.equal(launches[0].postWriteApproval.mode, "post-base");
    assert.equal(launches[0].postWriteApproval.environment, "dev");
    assert.equal(launches[0].toolApprovalMode, "allow-all");
    assert.equal(launches[0].allowPostRequests, true);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("PPE POST-only approval uses reviewed API bases without granting other methods or surviving recovery", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.environments = ["dev", "ppe"];
  profile.browserAutomation.dataSafety.post = { ppe: {
    scope: "api://example-service/access", sessionHelper: "ppe-session.mjs",
    baseUrls: ["https://api.shared.example.test/api/ppe/v1"]
  } };
  writeFileSync(join(repository, "ppe-session.mjs"),
    'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const launches = [];
  const executor = (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  };
  let running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  try {
    const post = (changes = {}, origin = running.url) => jsonRequest(running.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ request: "Approve all PPE POST requests for this job.", mode: "validate-only",
        targetEnvironment: "ppe", allowPostRequests: true, postWriteApprovalConfirmed: true,
        postBaseApprovalConfirmed: true, ...changes })
    });
    const created = await post();
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(launches[0].postWriteApproval.mode, "post-base");
    assert.equal(created.body.job.postWriteApproved, true);
    assert.equal(created.body.job.ppeWriteApproved, false);
    assert.match(launches[0].prompt, /all PPE POST requests, including writes/u);
    assert.match(launches[0].prompt, /fixlab_nonproduction_post/u);
    assert.doesNotMatch(launches[0].prompt, /Use fixlab_ppe_write/u);
    for (const changes of [
      { postBaseApprovalConfirmed: "yes" }, { allowPostRequests: false },
      { postWriteApprovalConfirmed: false }, { targetEnvironment: "dev" },
      { allowPpeWrites: true, ppeWriteApprovalConfirmed: true },
      { testMutationMode: "none" }, { testMutationMode: "intercepted" }
    ]) {
      assert.equal((await post(changes)).response.status, 400, JSON.stringify(changes));
    }
    for (const origin of ["", "https://example.invalid"]) {
      assert.equal((await post({}, origin)).response.status, 403);
    }
    const queued = await post();
    const held = await jsonRequest(running.url, "/api/jobs/hold", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: queued.body.queue[0].id })
    });
    assert.equal(held.body.held[0].postWriteApproved, false);
    await running.dashboard.close();
    running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    assert.equal((await jsonRequest(running.url, "/api/status")).body.job.postWriteApproved, false);
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const environment of ["dev", "ppe"]) {
for (const enabled of [true, false]) {
  test(`${environment.toUpperCase()} portal default ${enabled} is environment-bound, recovered and cannot change on retry`, async () => {
    const repository = createGitRepository();
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = validProfile();
    profile.environments = [environment, "sit"];
    const flag = environment === "dev" ? "devReadOnly" : "ppeReadOnly";
    profile.browserAutomation.testSynthesis[flag] = enabled;
    writeFileSync(path, JSON.stringify(profile));
    const prompts = [];
    const executor = ({ prompt }) => {
      prompts.push(prompt);
      return { completion: new Promise(() => {}), terminate() {} };
    };
    let running = await startDashboard(repository, executor);
    try {
      const create = (environment) => jsonRequest(running.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: `Validate the ${environment} portal using the reviewed environment.`,
          mode: "playwright-only", targetEnvironment: environment })
      });
      const started = await create(environment);
      assert.equal(started.response.status, 202, started.body.error);
      assert.equal(started.body.job.testEvidence.source, enabled ? "non-production-read-only" : "synthetic-intercepted");
      assert.equal(started.body.job.testEvidence.mutationMode, "intercepted");
      if (enabled) {
        assert.match(prompts[0], /primary business-data source/u);
        assert.match(prompts[0], /intercept every mutating request/u);
      }
      const queued = await create("sit");
      assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
      const sit = queued.body.queue.find((job) => job.targetEnvironment === "sit");
      assert.ok(sit, JSON.stringify(queued.body));
      assert.equal(sit.testEvidence.source, "synthetic-intercepted");
      await running.dashboard.close();
      running = await startDashboard(repository, executor);
      let recovered = (await jsonRequest(running.url, "/api/job")).body.job;
      assert.equal(recovered.testEvidence[flag] === true, enabled);
      const retry = () => jsonRequest(running.url, "/api/job/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", details: "Continue the same reviewed read policy." })
      });
      assert.equal((await retry()).response.status, 202);
      await running.dashboard.close();
      profile.browserAutomation.testSynthesis[flag] = !enabled;
      writeFileSync(path, JSON.stringify(profile));
      running = await startDashboard(repository, executor);
      const count = prompts.length;
      const changed = await retry();
      assert.equal(changed.response.status, 202);
      recovered = (await jsonRequest(running.url, "/api/job")).body.job;
      assert.match(recovered.error, new RegExp(`${environment.toUpperCase()} portal read policy changed.*newly reviewed job`, "u"));
      assert.equal(prompts.length, count);
      assert.equal(recovered.testEvidence[flag] === true, enabled);
    } finally {
      await running.dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
}

test("per-run interception keeps defaults unchanged and never grants live writes", () => {
  const profile = validProfile();
  profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
  const original = JSON.stringify(profile);
  assert.equal(configuredTestSynthesis(profile).mutationMode, "intercepted");
  assert.equal(configuredTestSynthesis(profile, "none").mutationMode, "none");
  assert.equal(configuredTestSynthesis(profile, "intercepted").mutationMode, "intercepted");
  assert.equal(JSON.stringify(profile), original);
  for (const value of ["approved-write", "disabled", true, [], null]) {
    assert.throws(() => configuredTestSynthesis(profile, value), /never authorizes real writes/);
  }
  profile.browserAutomation.testSynthesis.allowedMutationModes = ["intercepted"];
  assert.throws(() => configuredTestSynthesis(profile, "none"), /does not allow/);
  delete profile.browserAutomation.testSynthesis.allowedMutationModes;
  profile.browserAutomation.testSynthesis.defaultDataSource = "synthetic-intercepted";
  assert.throws(() => configuredTestSynthesis(profile, "none"), /permits non-production backend reads/);
});

test("POST start preference preserves default read-only evidence and cannot waive explicit safety", () => {
  const profile = validProfile();
  profile.browserAutomation.testSynthesis = {
    ...profile.browserAutomation.testSynthesis,
    defaultDataSource: "non-production-read-only", mutationMode: "none"
  };
  for (const enabled of [true, false]) {
    const result = configuredTestSynthesis(profile, "", enabled);
    assert.equal(result.allowPostRequests, enabled);
    assert.equal(result.source, "non-production-read-only");
    assert.equal(result.mutationMode, "none", "no POST has been approved or sent");
  }
  for (const selection of ["none", "intercepted"]) {
    assert.throws(() => configuredTestSynthesis(profile, selection, true), /cannot override/u);
    assert.equal(configuredTestSynthesis(profile, selection, false).allowPostRequests, false);
  }
  for (const value of ["true", null, 1, {}]) {
    assert.throws(() => configuredTestSynthesis(profile, "", value), /boolean/u);
  }
  assert.throws(() => configuredTestSynthesis(apiProfile(), "", true), /cannot override/u);
  assert.throws(() => configuredTestSynthesis(unitOnlyProfile(), "", true), /cannot override/u);
});

test("POST admission resolves a sole DEV environment and rejects invalid flags or overrides", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.environments = ["dev"];
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const running = await startDashboard(repository, () => ({ completion: new Promise(() => {}) }));
  const create = (changes) => jsonRequest(running.url, "/api/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: "Synthetic POST preference.", mode: "validate-only", ...changes })
  });
  try {
    for (const changes of [
      { allowPostRequests: "yes" }, { allowPostRequests: null },
      { allowPostRequests: true, testMutationMode: "none" },
      { allowPostRequests: true, testMutationMode: "intercepted" }
    ]) {
      const rejected = await create(changes);
      assert.equal(rejected.response.status, 400, rejected.body.error);
    }
    const accepted = await create({ allowPostRequests: true });
    assert.equal(accepted.response.status, 202, accepted.body.error);
    assert.equal(accepted.body.job.targetEnvironment, "dev");
    assert.equal(accepted.body.job.testEvidence.allowPostRequests, true);
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("DEV/SIT/UAT POST preferences reach the executor, queue and recovered job without grants", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.environments = ["dev", "sit", "uat"];
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const launches = [];
  const executor = (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  };
  let running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  try {
    for (const [environment, enabled] of [["dev", true], ["sit", false], ["uat", true]]) {
      const created = await jsonRequest(running.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Synthetic per-action POST preference.", mode: "validate-only",
          targetEnvironment: environment, allowPostRequests: enabled })
      });
      assert.equal(created.response.status, 202, created.body.error);
      const job = created.body.queuedJob ?? created.body.job;
      assert.equal(job.targetEnvironment, environment);
      assert.equal(job.testEvidence.allowPostRequests, enabled);
    }
    assert.equal(launches.length, 1);
    assert.equal(launches[0].allowPostRequests, true);
    assert.equal(launches[0].postWriteApproval, undefined);
    assert.match(launches[0].prompt, /Verified read-only POST searches:/u);
    assert.match(launches[0].prompt, /query allowlist independently of this checkbox/u);
    assert.match(launches[0].prompt, /Every data-changing action still requires separate exact destination\/payload confirmation/u);
    await running.dashboard.close();
    running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    const restored = await jsonRequest(running.url, "/api/job");
    assert.equal(restored.body.job.testEvidence.allowPostRequests, true);
    assert.equal(restored.body.job.toolApprovalMode, "ask");
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("POST checkbox write consent is origin-bound, job-scoped and never recovered or inherited", async () => {
  const repository = createGitRepository();
  const profile = validProfile();
  profile.environments = ["dev", "sit", "uat"];
  profile.browserAutomation.dataSafety.post = Object.fromEntries(profile.environments.map((environment) => [
    environment, { scope: "api://example-service/access", sessionHelper: "post-session.mjs",
      actions: [{ url: `https://api.${environment}.example.test/items`,
        testRecord: { field: "name", value: "FIXLAB_TEST_001" } }] }
  ]));
  writeFileSync(join(repository, "post-session.mjs"),
    'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const launches = [];
  const executor = (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  };
  let running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  try {
    const post = (changes = {}, origin = running.url) => jsonRequest(running.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ request: "Synthetic approved test-record writes.", mode: "validate-only",
        targetEnvironment: "dev", allowPostRequests: true, postWriteApprovalConfirmed: true, ...changes })
    });
    for (const changes of [
      { postWriteApprovalConfirmed: "yes" }, { postWriteApprovalConfirmed: null },
      { allowPostRequests: false },
      { testMutationMode: "none" }, { testMutationMode: "intercepted" }
    ]) {
      assert.equal((await post(changes)).response.status, 400);
    }
    for (const toolApprovalMode of [undefined, "ask", "allow-all"]) {
      for (const origin of ["", "https://example.invalid"]) {
        assert.equal((await post({ toolApprovalMode, allowAllConfirmed: true }, origin)).response.status, 403);
      }
    }
    const wrongHost = await new Promise((resolveResponse, reject) => {
      const request = createHttpRequest(`${running.url}/api/jobs`, {
        method: "POST",
        headers: { Host: "example.invalid", Origin: running.url, "Content-Type": "application/json" }
      }, (response) => {
        response.resume();
        response.once("end", () => resolveResponse(response.statusCode));
      });
      request.once("error", reject);
      request.end(JSON.stringify({ request: "Synthetic rejected origin.", mode: "validate-only",
        targetEnvironment: "dev", allowPostRequests: true, postWriteApprovalConfirmed: true }));
    });
    assert.equal(wrongHost, 403);
    assert.equal(launches.length, 0);
    const created = await post();
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(created.body.job.postWriteApproved, true);
    assert.equal(launches[0].postWriteApproval.jobId, created.body.job.id);
    assert.equal(launches[0].postWriteApproval.environment, "dev");
    assert.match(launches[0].postWriteApproval.revision, /^[a-f0-9]{64}$/u);
    assert.match(launches[0].prompt, /without repeat confirmation/u);
    assert.match(launches[0].prompt, /query allowlist independently of this checkbox/u);
    assert.equal((await post({ postWriteApprovalConfirmed: false })).body.queue[0].postWriteApproved, false);
    const queued = await post({ targetEnvironment: "sit" });
    assert.equal(queued.body.queue[1].postWriteApproved, true);
    assert.notEqual(queued.body.queue[1].id, created.body.job.id);
    const held = await jsonRequest(running.url, "/api/jobs/hold", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: queued.body.queue[1].id })
    });
    assert.equal(held.response.status, 202, held.body.error);
    assert.equal(held.body.held[0].postWriteApproved, false);
    const snapshot = readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8");
    assert.doesNotMatch(snapshot, /"postWriteApproval":/u);
    await running.dashboard.close();
    running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    const recovered = (await jsonRequest(running.url, "/api/status")).body;
    assert.equal(recovered.job.postWriteApproved, false);
    assert.ok([...recovered.queue, ...recovered.held].every((job) => job.postWriteApproved === false));
    const resumed = await jsonRequest(running.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Continue with individual write review." })
    });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(launches.at(-1).postWriteApproval, undefined);
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const environment of ["dev", "ppe"]) {
test(`${environment.toUpperCase()} write checkbox requires fresh native loopback consent and loses broad approval on hold/recovery`, async () => {
  const repository = createGitRepository();
  const writeField = environment === "dev" ? "allowDevWrites" : "allowPpeWrites";
  const confirmField = environment === "dev" ? "devWriteApprovalConfirmed" : "ppeWriteApprovalConfirmed";
  const approvedField = `${environment}WriteApproved`;
  const profile = validProfile();
  profile.environments = ["dev", "sit", "uat", "ppe"];
  if (environment === "ppe") {
    profile.browserAutomation.testSynthesis.ppeReadOnly = true;
  }
  profile.browserAutomation.dataSafety[`${environment}Write`] = {
    scope: "api://example-service/access", sessionHelper: "dev-session.mjs",
    origins: [`https://api.${environment}.example.test`]
  };
  writeFileSync(join(repository, "dev-session.mjs"),
    'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const launches = [];
  const executor = (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  };
  let running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  try {
    const post = (changes = {}, origin = running.url) => jsonRequest(running.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ request: `Synthetic approved broad ${environment} writes.`, mode: "validate-only",
        targetEnvironment: environment, [writeField]: true, [confirmField]: true,
        runAllUiScenarios: environment === "ppe", ...changes })
    });
    for (const changes of [
      { [writeField]: "yes" }, { [writeField]: null }, { [writeField]: false },
      { [confirmField]: "yes" }, { [confirmField]: null },
      { [confirmField]: false }, { allowPostRequests: true },
      { targetEnvironment: "sit" }, { targetEnvironment: "uat" },
      { targetEnvironment: environment === "dev" ? "ppe" : "dev" },
      { [environment === "dev" ? "allowPpeWrites" : "allowDevWrites"]: true },
      { testMutationMode: "none" }, { testMutationMode: "intercepted" }
    ]) {
      assert.equal((await post(changes)).response.status, 400, JSON.stringify(changes));
    }
    for (const origin of ["", "https://example.invalid"]) {
      assert.equal((await post({}, origin)).response.status, 403);
    }
    const created = await post();
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(created.body.job[approvedField], true);
    assert.equal(created.body.job[environment === "dev" ? "ppeWriteApproved" : "devWriteApproved"], false);
    assert.equal(created.body.job.postWriteApproved, false);
    assert.equal(launches[0].postWriteApproval.mode, `${environment}-origin`);
    assert.equal(launches[0].postWriteApproval.jobId, created.body.job.id);
    assert.equal(launches[0].allowPostRequests, true);
    assert.match(launches[0].prompt, new RegExp(`fixlab_${environment}_write.*POST, PUT, PATCH and DELETE`, "u"));
    if (environment === "ppe") {
      assert.equal(created.body.job.runAllUiScenarios, true);
      assert.match(launches[0].prompt, /run every repository-defined Playwright\/UI scenario/);
      assert.match(launches[0].prompt, /Do not intercept an authorized mutation/);
      assert.doesNotMatch(launches[0].prompt, /Keep all backend access read-only and intercept every mutating request/);
      const browserPrompt = buildJobPrompt({
        request: "Run all PPE scenarios.", mode: "playwright-only", runAllUiScenarios: true,
        targetEnvironment: "ppe", testEvidence: created.body.job.testEvidence
      });
      assert.match(browserPrompt, /Save, Submit, Approve, autosave and other writes require the current mediated native approval/);
      assert.doesNotMatch(browserPrompt, /No Save, Submit, Approve/);
    }
    const queued = await post();
    assert.equal(queued.body.queue[0][approvedField], true);
    const held = await jsonRequest(running.url, "/api/jobs/hold", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: queued.body.queue[0].id })
    });
    assert.equal(held.body.held[0][approvedField], false);
    const snapshot = readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8");
    assert.doesNotMatch(snapshot, /"postWriteApproval":|"(dev|ppe)-origin"|"(dev|ppe)WriteApproved":true/u);
    await running.dashboard.close();
    running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    assert.equal((await jsonRequest(running.url, "/api/status")).body.job[approvedField], false);
    const resumed = await jsonRequest(running.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Resume without broad DEV approval." })
    });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(launches.at(-1).postWriteApproval, undefined);
    assert.doesNotMatch(launches.at(-1).prompt, /The user explicitly authorized all (DEV|PPE) API writes/u);
    await running.dashboard.close();
    running = await startDashboard(repository, executor);
    assert.equal((await post()).response.status, 400, "Agency cannot gain this native capability");
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});
}

test("reviewed file trust is exact-job bound, persists on resume/restart and is never inherited by new jobs", async () => {
  const repository = createGitRepository();
  let finish;
  const launches = [];
  const executor = (input) => {
    launches.push(input);
    return { completion: new Promise((resolve) => { finish = resolve; }) };
  };
  let running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  try {
    const { url } = running;
    const created = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic reviewed source edits.", mode: "fix-and-validate" })
    });
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(created.body.job.fileAccess, null);
    const identity = (await jsonRequest(url, "/api/status")).body.instanceId;
    const review = (changes = {}, origin = url) => jsonRequest(url, "/api/job/file-access", {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({
        instanceId: identity, jobId: created.body.job.id, repository,
        mode: "source-read-write", allowValidationGates: true, confirmed: true, ...changes
      })
    });
    assert.equal((await review()).response.status, 409);
    finish({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const changes of [{ instanceId: randomUUID() }, { jobId: randomUUID() }]) {
      assert.equal((await review(changes)).response.status, 409);
    }
    for (const origin of ["", "https://example.invalid"]) {
      assert.equal((await review({}, origin)).response.status, 403);
    }
    for (const changes of [
      { confirmed: false }, { mode: "all" }, { repository: dirname(repository) }
    ]) {assert.equal((await review(changes)).response.status, 400);}
    const reviewed = await review();
    assert.equal(reviewed.response.status, 200, reviewed.body.error);
    assert.equal(reviewed.body.job.fileAccess.mode, "source-read-write");
    assert.equal(reviewed.body.job.fileAccess.allowValidationGates, true);
    assert.equal(launches.length, 1, "granting trust never resumes a job");
    const expected = reviewed.body.job.fileAccess;
    const snapshot = JSON.parse(readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8"));
    assert.match(JSON.stringify(snapshot), /"fileAccess":\{"mode":"source-read-write"/);
    await running.dashboard.close();
    running = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    const restored = (await jsonRequest(running.url, "/api/job")).body.job;
    assert.equal(restored.id, created.body.job.id);
    assert.deepEqual(restored.fileAccess, expected);
    const resumed = await jsonRequest(running.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Resume this explicitly trusted job." })
    });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.deepEqual(launches.at(-1).fileAccess, expected);
    assert.equal(launches.at(-1).dashboardPort, Number(new URL(running.url).port));
    finish({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await jsonRequest(running.url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "A different untrusted job.", mode: "validate-only",
        routineFileAccess: false, fileAccess: expected })
    });
    assert.equal(fresh.response.status, 202, fresh.body.error);
    const queued = fresh.body.queue.at(-1);
    assert.notEqual(queued.id, created.body.job.id);
    assert.equal(queued.fileAccess, null);
    assert.equal(launches.length, 2, "creating a queued job does not inherit or execute trusted access");
    const intakeHtml = await (await fetch(running.url)).text();
    const routineAccessInput = intakeHtml.match(/<input\b[^>]*name="routineFileAccess"[^>]*>/)?.[0];
    assert.ok(routineAccessInput, "dashboard intake must expose the routine access choice");
    const routineFileAccess = /\bchecked\b/.test(routineAccessInput);
    const submission = await jsonRequest(running.url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Explicit routine source consent.", mode: "fix-and-validate",
        routineFileAccess })
    });
    assert.equal(submission.response.status, 202, submission.body.error);
    const consented = submission.body.queue.at(-1);
    assert.equal(consented.fileAccess.mode, "source-read-write");
    assert.equal(consented.fileAccess.jobId, consented.id);
    assert.equal(consented.fileAccess.repository, realpathSync.native(repository));
    assert.equal(consented.fileAccess.allowValidationGates, true);
    const validation = await jsonRequest(running.url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Default access in read-only validation.", mode: "validate-only",
        routineFileAccess })
    });
    assert.equal(validation.response.status, 202, validation.body.error);
    assert.equal(validation.body.queue.at(-1).fileAccess.mode, "source-read");
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("oversized edit recovery retains denial and requires exact fresh authorization after stopped-job trust", async () => {
  const repository = createGitRepository();
  const sent = [];
  const launches = [];
  let bridge;
  let stopped = 0;
  const executor = (input) => {
    launches.push(input);
    bridge = createRuntimeRequestBridge({ send: (message) => sent.push(message),
      onChange: input.onRuntimeRequests });
    return { completion: new Promise(() => {}),
      respondToRuntimeRequest: (id, decision) => bridge.respond(id, decision),
      terminate() { stopped++; bridge.cancel(); } };
  };
  let current = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
  const post = (path, body, origin = current.url) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const created = await post("/api/jobs", { request: "Review a large source edit.", mode: "fix-and-validate" });
    const identity = (await jsonRequest(current.url, "/api/status")).body.instanceId;
    const id = randomUUID();
    bridge.receive({ ...runtimePermissionPrompt({ kind: "write", fileName: "src/header.tsx",
      diff: "synthetic-hidden-diff\n".repeat(500) }), id,
      sourceEditReview: { fileName: "src/header.tsx", reviewCharacters: 11000 } });
    const state = (await jsonRequest(current.url, "/api/job")).body.job;
    assert.equal(state.sourceEditReview.requestId, id);
    assert.doesNotMatch(JSON.stringify(state.sourceEditReview), /synthetic-hidden-diff/);
    const binding = { instanceId: identity, jobId: created.body.job.id, requestId: id, confirmed: true };
    for (const changes of [{ instanceId: randomUUID() }, { jobId: randomUUID() },
      { requestId: randomUUID() }, { confirmed: false }]) {
      assert.equal((await post("/api/job/source-edit-review", { ...binding, ...changes })).response.status, 409);
    }
    assert.equal((await post("/api/job/source-edit-review", binding, "https://example.invalid")).response.status, 409);
    assert.equal(stopped, 0);
    const denied = await post("/api/job/runtime-response", { ...binding, action: "deny", recover: true });
    assert.equal(denied.response.status, 200, denied.body.error);
    assert.deepEqual(sent, [{ type: "response", id, action: "deny", recover: true }]);
    assert.equal((await jsonRequest(current.url, "/api/job")).body.job.sourceEditReview.requestId, id);
    assert.equal((await post("/api/job/source-edit-review", binding)).response.status, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await jsonRequest(current.url, "/api/job")).body.job.canResume) { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stopped, 1);
    assert.throws(() => bridge.respond(id, { action: "allow" }), /stale/);
    const authorization = { action: "continue", details: state.sourceEditReview.authorization,
      instanceId: identity, jobId: created.body.job.id, sourceEditReviewId: id, confirmed: true };
    assert.equal((await post("/api/job/input", authorization)).response.status, 409);
    await current.dashboard.close();
    current = await startDashboard(repository, executor, undefined, { runtime: "copilot" });
    const restored = (await jsonRequest(current.url, "/api/status")).body;
    assert.equal(restored.job.sourceEditReview.requestId, id);
    assert.equal(restored.job.runtimeRequests.length, 0);
    assert.doesNotMatch(readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8"),
      /synthetic-hidden-diff/);
    authorization.instanceId = restored.instanceId;
    const trust = await post("/api/job/file-access", { instanceId: restored.instanceId,
      jobId: created.body.job.id, repository, mode: "source-read-write", confirmed: true });
    assert.equal(trust.response.status, 200, trust.body.error);
    assert.equal(launches.length, 1, "reviewing trust never resumes or approves an operation");
    for (const changes of [{ instanceId: identity }, { jobId: randomUUID() },
      { sourceEditReviewId: randomUUID(), validationIntent: "full" },
      { confirmed: false }, { details: "Different authorization" }]) {
      assert.equal((await post("/api/job/input", { ...authorization, ...changes })).response.status, 409);
    }
    assert.equal((await post("/api/job/input", authorization, "")).response.status, 409);
    assert.equal((await jsonRequest(current.url, "/api/job")).body.job.validationIntent, state.validationIntent);
    const resumed = await post("/api/job/input", authorization);
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(resumed.body.job.sourceEditReview, null);
    assert.equal(launches.length, 2);
    assert.match(launches[1].prompt, /explicitly authorize a fresh attempt/);
    assert.equal(sent.length, 1, "the old callback remains denied, never replayed");
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Allow all job consent is origin-bound, reaches the executor and is not recovered or inherited", async () => {
  const repository = createGitRepository();
  const launches = [];
  let running = await startDashboard(repository, (input) => {
    launches.push(input);
    return { completion: new Promise(() => {}) };
  }, undefined, { runtime: "copilot" });
  try {
    const post = (changes = {}, origin = running.url) => jsonRequest(running.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({
        request: "Synthetic explicit Allow all.", mode: "validate-only",
        toolApprovalMode: "allow-all", allowAllConfirmed: true, ...changes
      })
    });
    for (const toolApprovalMode of [true, null, {}, "all"]) {
      assert.equal((await post({ toolApprovalMode })).response.status, 400);
    }
    assert.equal((await post({ allowAllConfirmed: false })).response.status, 400);
    assert.equal((await post({}, "")).response.status, 403);
    assert.equal((await post({}, "https://example.invalid")).response.status, 403);
    assert.equal(launches.length, 0);
    const created = await post();
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(created.body.job.toolApprovalMode, "allow-all");
    assert.equal(launches[0].toolApprovalMode, "allow-all");
    const normal = await post({ toolApprovalMode: "ask", allowAllConfirmed: false });
    assert.equal(normal.body.queue[0].toolApprovalMode, "ask");
    const queued = await post();
    assert.equal(queued.body.queue[1].toolApprovalMode, "allow-all");
    const snapshot = JSON.parse(readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(snapshot), /"toolApprovalMode":"allow-all"/);
    await running.dashboard.close();
    running = await startDashboard(repository, (input) => {
      launches.push(input);
      return { completion: new Promise(() => {}) };
    }, undefined, { runtime: "copilot" });
    const recovered = (await jsonRequest(running.url, "/api/status")).body;
    assert.equal(recovered.job.toolApprovalMode, "ask");
    assert.ok(recovered.queue.every((job) => job.toolApprovalMode === "ask"));
    const resumed = await jsonRequest(running.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Resume without inheriting Allow all." })
    });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(launches.at(-1).toolApprovalMode, "ask");
  } finally {
    await running.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("input-token budgets pause without automatic continuation, preserve usage and require bound review", async () => {
  const repository = createGitRepository();
  let finish;
  let launches = 0;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    launches++;
    assert.equal(input.inputTokenLimit, launches === 1 ? 100 : 200);
    input.onUsage({
      inputTokens: 110, cachedInputTokens: 90, cacheWriteTokens: 20,
      outputTokens: 5, cacheReusePercent: 90 / 110 * 100
    });
    input.onOutput("stdout", "Tokens \u2191 110 (90 cached, 20 written) \u2022 \u2193 5\n");
    input.onOutput("stdout", "Tokens \u2191 0 (0 cached, 0 written) \u2022 \u2193 0\n");
    return { completion: new Promise((resolve) => { finish = resolve; }) };
  }, undefined, { runtime: "copilot" });
  try {
    const created = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic bounded-input scenario.", mode: "validate-only", inputTokenLimit: 100 })
    });
    assert.equal(created.response.status, 202, created.body.error);
    assert.equal(created.body.job.inputTokenLimit, 100);
    const identity = (await jsonRequest(url, "/api/status")).body;
    const review = (body, origin = url) => jsonRequest(url, "/api/job/budget", {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({
        instanceId: identity.instanceId, jobId: created.body.job.id,
        confirmed: true, inputTokenLimit: 200, ...body
      })
    });
    assert.equal((await review({})).response.status, 409, "running budgets cannot be silently changed");
    const commented = await jsonRequest(url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "comment", details: "Retain this pending scoped instruction." })
    });
    assert.equal(commented.response.status, 202);
    const error = new Error("Input-token ceiling reached (110/100, cached input included).");
    error.code = "INPUT_TOKEN_LIMIT";
    finish({ code: null, error });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paused = (await jsonRequest(url, "/api/job")).body.job;
    assert.equal(paused.status, "blocked");
    assert.equal(paused.budgetExceeded, true);
    assert.equal(paused.canResume, false);
    assert.equal(paused.usage.inputTokens, 110);
    assert.equal(paused.usage.cachedInputTokens, 90);
    assert.equal(paused.pendingInputCount, 1);
    assert.equal(launches, 1, "queued comments must not continue exhausted jobs");
    const conversation = (await jsonRequest(url, "/api/conversation")).body;
    assert.equal(conversation.question.kind, "budget");
    assert.deepEqual(conversation.question.actions, []);
    assert.equal(conversation.job.inputTokenLimit, 100);
    assert.equal(conversation.job.inputTokens, 110);
    assert.equal(conversation.job.budgetExceeded, true);
    const snapshot = JSON.parse(readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8"));
    assert.match(JSON.stringify(snapshot), /"inputTokenLimit":100/);
    assert.match(JSON.stringify(snapshot), /"budgetExceeded":true/);
    for (const body of [
      { instanceId: randomUUID() }, { jobId: randomUUID() }
    ]) {
      assert.equal((await review(body)).response.status, 409);
    }
    assert.equal((await review({}, "")).response.status, 403);
    assert.equal((await review({}, "https://example.invalid")).response.status, 403);
    for (const body of [
      { confirmed: false }, { inputTokenLimit: 110 }, { inputTokenLimit: 100 },
      { inputTokenLimit: -1 }, { inputTokenLimit: "200" }, { inputTokenLimit: 1.5 }
    ]) {
      assert.equal((await review(body)).response.status, 400);
    }
    const reviewed = await review({});
    assert.equal(reviewed.response.status, 200, reviewed.body.error);
    assert.equal(reviewed.body.job.inputTokenLimit, 200);
    assert.equal(reviewed.body.job.budgetExceeded, false);
    assert.equal(reviewed.body.job.usage.inputTokens, 110);
    assert.equal(launches, 1, "budget review never resumes the job");
    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Resume within the newly reviewed budget." })
    });
    assert.equal(resumed.response.status, 202, resumed.body.error);
    assert.equal(launches, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("new input-token ceilings are explicit safe integers and unsupported runtimes reject positive limits", async () => {
  const repository = createGitRepository();
  for (const runtime of ["copilot", "agency"]) {
    const { dashboard, url } = await startDashboard(repository, () => ({
      completion: new Promise(() => {})
    }), undefined, { runtime });
    try {
      for (const inputTokenLimit of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1, ...(runtime === "agency" ? [100] : [])]) {
        const result = await jsonRequest(url, "/api/jobs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request: "Synthetic ceiling validation.", mode: "validate-only", inputTokenLimit })
        });
        assert.equal(result.response.status, 400, JSON.stringify(inputTokenLimit));
        assert.match(result.body.error, /inputTokenLimit/);
      }
    } finally {
      await dashboard.close();
    }
  }
  rmSync(repository, { recursive: true, force: true });
});

test("native executor forwards budget/protected-path configuration and retains budget errors through owned termination", { timeout: 30000 }, async (t) => {
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "fixlab-budget-protocol-"));
  const sessionId = randomUUID();
  mkdirSync(join(runtime, "dashboard"));
  writeFileSync(join(runtime, "dashboard", "copilot-session.js"), `
process.stdin.once("data", (chunk) => {
  const config = JSON.parse(chunk.toString());
  const valid = config.inputTokenLimit === 100 &&
    config.fileAccess.mode === "source-read-write" &&
    config.fileAccess.jobId === config.sessionId &&
    config.postWriteApproval.jobId === config.sessionId &&
    config.postWriteApproval.environment === "dev" &&
    config.postWriteApproval.mode === "dev-origin" &&
    config.postWriteApproval.revision === "a".repeat(64) &&
    config.protectedPaths.length === 1 && config.protectedPaths[0].endsWith("session.js");
  process.stdout.write(JSON.stringify({
    type: "usage", usage: { inputTokens: 110, cachedInputTokens: 90, cacheWriteTokens: 20, outputTokens: 5 }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "error", message: "Synthetic input-token ceiling reached.",
    code: valid ? "INPUT_TOKEN_LIMIT" : "INVALID_BUDGET_CONFIGURATION"
  }) + "\\n");
});
setInterval(() => {}, 1000);
`);
  let handle;
  const usage = [];
  t.signal.addEventListener("abort", () => handle?.terminate(), { once: true });
  try {
    handle = createCopilotExecutor({ packageRoot: runtime })({
      repository, sessionId, prompt: "Synthetic owned budget protocol.",
      postWriteApproval: { jobId: sessionId, environment: "dev", revision: "a".repeat(64), mode: "dev-origin" },
      fileAccess: { mode: "source-read-write", repository: realpathSync.native(repository), jobId: sessionId },
      inputTokenLimit: 100, protectedPaths: [join(repository, "session.js")],
      onUsage(value) { usage.push(value); },
      onOutput() {}
    });
    const result = await handle.completion;
    assert.equal(result.error?.code, "INPUT_TOKEN_LIMIT");
    assert.match(result.error.message, /Synthetic input-token ceiling/);
    assert.equal(handle.hasStopped(), true);
    assert.equal(usage[0].inputTokens, 110);
  } finally {
    if (handle && !handle.hasStopped()) {
      handle.terminate();
    }
    rmSync(runtime, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const selection of ["intercepted", "none"]) {
  test(`per-run ${selection} selection reaches only its job and rejects conflicting evidence`, async () => {
    const repository = createGitRepository();
    const path = join(repository, ".github", "fixlab", "repository-profile.json");
    const profile = validProfile();
    profile.browserAutomation.testSynthesis.defaultDataSource = "non-production-read-only";
    writeFileSync(path, JSON.stringify(profile));
    const original = readFileSync(path, "utf8");
    let input;
    let complete;
    const { dashboard, url } = await startDashboard(repository, (value) => {
      input = value;
      return { completion: new Promise((resolve) => { complete = resolve; }) };
    }, undefined, { autoTestEvidence: false });
    try {
      const created = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: "Synthetic per-run interception scenario.", mode: "playwright-only",
          testMutationMode: selection
        })
      });
      assert.equal(created.response.status, 202, created.body.error);
      assert.equal(created.body.job.testEvidence.mutationMode, selection);
      assert.equal(created.body.job.testEvidence.selectedMutationMode, selection);
      assert.match(input.prompt, selection === "none" ? /explicitly selected live non-production read-only/ : /explicitly selected intercepted validation/);
      input.onOutput("stdout", "FIXLAB_TEST|non-production-approved|approved-write|Invalid broadened evidence.\n");
      for (const stage of FIXLAB_STAGES) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|Synthetic stage.\n`);
      }
      complete({ code: 0 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const finished = (await jsonRequest(url, "/api/job")).body.job;
      assert.equal(finished.status, "failed");
      assert.match(finished.error, /per-run mutation mode/);
      assert.equal(readFileSync(path, "utf8"), original);
      const restarted = await jsonRequest(url, "/api/jobs/restart", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: finished.id })
      });
      assert.equal(restarted.response.status, 202, restarted.body.error);
      assert.equal(restarted.body.job.testEvidence.selectedMutationMode, selection);
      assert.equal(restarted.body.job.testEvidence.mutationMode, selection);
      assert.notEqual(restarted.body.job.id, finished.id);
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("live native prompts require current instance/job/request, exact browser origin and confirmation", async () => {
  const repository = createGitRepository();
  const id = randomUUID();
  let bridge;
  let launches = 0;
  const sent = [];
  const { dashboard, url } = await startDashboard(repository, ({ onRuntimeRequests, prompt }) => {
    launches++;
    assert.match(prompt, /Native dashboard interaction replaces the exit-and-resume instruction/);
    assert.match(prompt, /use ask_user with clear safe choices/);
    bridge = createRuntimeRequestBridge({
      send: (message) => sent.push(message),
      onChange: onRuntimeRequests
    });
    bridge.receive({ ...runtimePermissionPrompt({ kind: "shell", fullCommandText: "npm test" }), id });

    return {
      completion: new Promise(() => {}),
      respondToRuntimeRequest: (id, decision) => bridge.respond(id, decision),
      terminate: () => bridge.cancel()
    };
  }, undefined, { runtime: "copilot", executionIdleTimeoutMs: 60 });
  try {
    const created = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic native approval scenario.", mode: "validate-only" })
    });
    const state = (await jsonRequest(url, "/api/status")).body;
    assert.equal(state.job.runtimeRequests[0].id, id);
    assert.equal(state.job.status, "running");
    const conversation = (await jsonRequest(url, "/api/conversation")).body;
    assert.equal(conversation.question.kind, "runtime-input");
    assert.deepEqual(conversation.question.actions, []);
    assert.equal(conversation.job.executionState, "waiting-for-permission");
    assert.equal(conversation.question.requestId, id);
    assert.equal(conversation.question.responseChannel, "dashboard");
    assert.doesNotMatch(JSON.stringify(conversation.question), /npm test/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await jsonRequest(url, "/api/job")).body.job.status, "running", "human wait suspends idle timeout");
    const valid = {
      instanceId: state.instanceId, jobId: created.body.job.id, requestId: id,
      action: "allow", confirmed: true
    };
    const post = (body, origin = url) => jsonRequest(url, "/api/job/runtime-response", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body)
    });
    for (const change of [
      { instanceId: randomUUID() }, { jobId: randomUUID() }, { requestId: randomUUID() }
    ]) {
      assert.equal((await post({ ...valid, ...change })).response.status, 409);
    }
    assert.equal((await post(valid, "https://example.invalid")).response.status, 403);
    assert.equal((await post(valid, "")).response.status, 403);
    assert.equal((await post({ ...valid, confirmed: false })).response.status, 400);
    assert.equal((await post({ ...valid, scope: "all-tools" })).response.status, 400);
    assert.equal((await jsonRequest(url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue", details: "Do not use as approval." })
    })).response.status, 409);
    assert.equal((await jsonRequest(url, "/api/conversation/reply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: realpathSync(repository), instanceId: state.instanceId,
        jobId: created.body.job.id, requestId: id, confirmed: true, action: "answer", details: "Allow"
      })
    })).response.status, 409, "a question answer cannot approve a native permission");
    assert.equal(sent.length, 0);
    assert.equal((await post(valid)).response.status, 200);
    assert.equal(sent[0].action, "allow");
    assert.equal((await post(valid)).response.status, 409);
    assert.equal(launches, 1, "responding continues the same live executor");
    const allToolsId = randomUUID();
    bridge.receive({
      ...runtimePermissionPrompt({ kind: "shell", fullCommandText: "npm test" }),
      id: allToolsId, canAllowAll: true
    });
    const allowed = await post({ ...valid, requestId: allToolsId, scope: "all-tools" });
    assert.equal(allowed.response.status, 200, allowed.body.error);
    assert.equal(allowed.body.job.toolApprovalMode, "allow-all");
    assert.equal(sent.at(-1).scope, "all-tools");
    const questionId = randomUUID();
    bridge.receive({
      ...runtimeQuestionPrompt({ question: "Ephemeral native question marker", choices: ["Continue", "Cancel"] }),
      id: questionId
    });
    await jsonRequest(url, "/api/status");
    const statusText = readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8");
    assert.doesNotMatch(statusText, /Ephemeral native question marker|fullCommandText|runtimeRequests/);
    await dashboard.close();
    assert.equal(sent.at(-1).action, "cancel");
    assert.throws(() => bridge.respond(questionId, { action: "answer", choice: 0 }), /stale/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("connected live answers are exact, single-use and continue only the same executor without logging answers", async () => {
  const repository = createGitRepository();
  let bridge;
  let launches = 0;
  const sent = [];
  const questionId = randomUUID();
  const { dashboard, url } = await startDashboard(repository, ({ onRuntimeRequests, onOutput }) => {
    launches++;
    onOutput("stdout", "FIXLAB_STAGE|diagnosis|passed|Retained diagnosis.\n");
    bridge = createRuntimeRequestBridge({ send: (value) => sent.push(value), onChange: onRuntimeRequests });
    bridge.receive({
      ...runtimeQuestionPrompt({
        question: "Which reviewed test scope?",
        choices: ["Focused answer sentinel", "Full"], allowFreeform: false
      }),
      id: questionId
    });
    return {
      completion: new Promise(() => {}),
      respondToRuntimeRequest: (id, decision) => bridge.respond(id, decision),
      terminate: () => bridge.cancel()
    };
  }, undefined, { runtime: "copilot" });
  const post = (body, origin) => jsonRequest(url, "/api/conversation/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const created = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic live question handoff.", mode: "validate-only" })
    });
    const args = { repository: realpathSync(repository), port: Number(new URL(url).port) };
    const state = await dashboardConversation(args);
    assert.equal(state.job.executionState, "waiting-for-input");
    assert.equal(state.job.status, "running");
    assert.equal(state.question.kind, "runtime-question");
    assert.equal(state.question.requestId, questionId);
    assert.deepEqual(state.question.actions, ["answer"]);
    assert.match(formatJobStatus((await jsonRequest(url, "/api/job")).body.job), /waiting-for-input.*\n[\s\S]*Action needed: Which reviewed test scope/);
    assert.equal(state.question.message, "Which reviewed test scope?");
    const reply = {
      ...args, instanceId: state.instanceId, jobId: created.body.job.id,
      requestId: questionId, confirmed: true, action: "answer", details: "Focused answer sentinel"
    };
    for (const change of [
      { instanceId: randomUUID() }, { jobId: randomUUID() }, { repository: tmpdir() },
      { requestId: randomUUID() }, { requestId: undefined }, { confirmed: false },
      { action: "comment" }, { action: "retry" }, { action: "allow" }
    ]) {
      const result = await post({ ...reply, ...change });
      assert.equal(result.response.status, 409, JSON.stringify(change));
    }
    assert.equal((await post(reply, url)).response.status, 403);
    for (const change of [
      { details: "An unavailable choice" }, { validationIntent: "scoped" },
      { scope: "all-tools" }, { recover: true }, { reviewedWorkspace: {} }
    ]) {
      assert.equal((await post({ ...reply, ...change })).response.status, 400, JSON.stringify(change));
    }
    await assert.rejects(dashboardConversation({ ...reply, requestId: randomUUID() }, true), /request ID/);
    assert.equal(sent.length, 0);
    const answered = await dashboardConversation(reply, true);
    assert.equal(answered.question, null);
    assert.equal(answered.job.executionState, "running");
    assert.equal(answered.job.stages.diagnosis.status, "passed");
    assert.equal(launches, 1);
    assert.deepEqual(sent, [{
      type: "response", id: questionId, action: "answer",
      answer: "Focused answer sentinel", wasFreeform: false
    }]);
    assert.equal((await post(reply)).response.status, 409);
    const freeformId = randomUUID();
    bridge.receive({ ...runtimeQuestionPrompt({ question: "What is the remaining symptom?" }), id: freeformId });
    assert.equal((await post({ ...reply, requestId: freeformId, details: "password=private-sentinel" })).response.status, 400);
    const freeform = await post({ ...reply, requestId: freeformId, details: "Freeform symptom sentinel" });
    assert.equal(freeform.response.status, 200);
    assert.equal(sent.at(-1).wasFreeform, true);
    bridge.receive({
      ...runtimeQuestionPrompt({ question: "Allow GET https://private.example.test/path?" }),
      id: randomUUID()
    });
    const hidden = await dashboardConversation(args);
    assert.equal(hidden.question.responseChannel, "dashboard");
    assert.doesNotMatch(JSON.stringify(hidden), /private\.example/);
    assert.equal((await post({ ...reply, requestId: hidden.question.requestId })).response.status, 409);
    const snapshot = readFileSync(join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json"), "utf8");
    const job = (await jsonRequest(url, "/api/job")).body.job;
    assert.doesNotMatch(snapshot, /Focused answer sentinel|Freeform symptom sentinel|Which reviewed test scope|private\.example/);
    assert.doesNotMatch(JSON.stringify(job.logs), /Focused answer sentinel|Freeform symptom sentinel/);
    assert.equal(job.pendingInputCount, 0);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const action of ["stop", "hold"]) {
  test(`native runtime requests cannot be answered after job ${action}`, async () => {
    const repository = createGitRepository();
    const sent = [];
    let bridge;
    const { dashboard, url } = await startDashboard(repository, ({ onRuntimeRequests }) => {
      bridge = createRuntimeRequestBridge({ send: (value) => sent.push(value), onChange: onRuntimeRequests });
      return {
        completion: new Promise(() => {}),
        respondToRuntimeRequest: (id, decision) => bridge.respond(id, decision),
        terminate: () => bridge.cancel()
      };
    }, undefined, { runtime: "copilot" });
    try {
      const created = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Synthetic cancellation scenario.", mode: "validate-only" })
      });
      const id = randomUUID();
      bridge.receive({ ...runtimePermissionPrompt({ kind: "shell", fullCommandText: "npm test" }), id });
      const state = (await jsonRequest(url, "/api/status")).body;
      const stopped = await jsonRequest(url, action === "hold" ? "/api/jobs/hold" : "/api/job/stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: created.body.job.id })
      });
      assert.equal(stopped.response.status, 202);
      assert.equal(sent[0].action, "cancel");
      const late = await jsonRequest(url, "/api/job/runtime-response", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: url },
        body: JSON.stringify({
          instanceId: state.instanceId, jobId: created.body.job.id, requestId: id,
          action: "allow", confirmed: true
        })
      });
      assert.equal(late.response.status, 409);
      assert.equal(sent.length, 1);
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("completed preflight resumes after recovery but a restarted job requires fresh approval", async () => {
  const repository = createGitRepository();
  const external = mkdtempSync(join(tmpdir(), "fixlab-preflight-recovery-"));
  const calls = [];
  const execute = (input) => {
    calls.push(input);
    return { completion: new Promise(() => {}), terminate() {} };
  };
  let current = await startDashboard(repository, execute);
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const created = await post("/api/jobs", {
      request: "Preserve the approved session.", mode: "validate-only", permissionPreflight: true
    });
    assert.equal((await approvePreflightDirectory(current.url, created.body.job, external)).response.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resume, false);
    await current.dashboard.close();
    current = await startDashboard(repository, execute);
    const restored = (await jsonRequest(current.url, "/api/job")).body.job;
    assert.equal(restored.permissionRequest, null);
    assert.deepEqual(restored.runtimeDirectoryGrants, []);
    const resumed = await post("/api/job/input", {
      action: "continue", details: "Continue the approved session with this new instruction."
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, created.body.job.id);
    assert.match(calls[1].prompt, /Continue the approved session with this new instruction/);
    assert.deepEqual(calls[1].runtimeDirectories, []);
    await current.dashboard.close();
    current = await startDashboard(repository, execute);
    const restarted = await post("/api/jobs/restart", { jobId: created.body.job.id });
    assert.equal(restarted.response.status, 202);
    assert.notEqual(restarted.body.job.id, created.body.job.id);
    assert.equal(restarted.body.job.permissionRequest.preflight, true);
    assert.deepEqual(restarted.body.job.runtimeDirectoryGrants, []);
    assert.equal(calls.length, 2);
    assert.equal((await approvePreflightDirectory(current.url, restarted.body.job, external)).response.status, 202);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].resume, false);
    assert.equal(calls[2].sessionId, restarted.body.job.id);
    assert.deepEqual(calls[2].runtimeDirectories, [realpathSync(external)]);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

for (const invalidateFolder of [false, true]) {
test(`preflight workspace recovery retains the approved grant for the first fresh launch${invalidateFolder ? " after replacing an invalidated folder" : ""}`, async () => {
  const source = createGitRepository();
  const repository = mkdtempSync(join(tmpdir(), "fixlab-preflight-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "fixlab-preflight-workspace-folder-"));
  const replacement = invalidateFolder
    ? mkdtempSync(join(tmpdir(), "fixlab-preflight-replacement-folder-"))
    : external;
  const profile = validProfile({ worktreeSetup: { mode: "shared", baseBranch: "develop" } });
  writeFileSync(join(source, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(source, ["branch", "-m", "develop"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "Shared preflight profile"]);
  git(source, ["clone", "--quiet", source, repository]);
  const branch = `users/fixlab-test/fixlab-${randomUUID()}`;
  git(repository, ["switch", "--quiet", "-c", branch]);
  writeFileSync(join(repository, "tracked.txt"), "Preserve existing work.");
  const calls = [];
  const { dashboard, url } = await startDashboard(repository, (input) => {
    calls.push(input);
    return { completion: new Promise(() => {}), terminate() {} };
  });
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const created = await post("/api/jobs", {
      request: "Continue existing work.", mode: "fix-and-validate", permissionPreflight: true
    });
    const approved = await approvePreflightDirectory(url, created.body.job, external);
    assert.equal(approved.response.status, 409);
    assert.equal(approved.body.job.status, "blocked");
    assert.equal(approved.body.job.permissionRequest, null);
    assert.deepEqual(approved.body.job.runtimeDirectoryGrants, [realpathSync(external)]);
    const status = (await jsonRequest(url, "/api/conversation")).body;
    assert.equal(status.question.kind, "workspace");
    assert.equal(calls.length, 0);
    if (invalidateFolder) {
      rmSync(external, { recursive: true, force: true });
    }
    const resumed = await post("/api/job/input", {
      action: "continue", details: "Reuse this reviewed branch.", reviewedWorkspace: status.workspaceReview
    });
    assert.equal(resumed.response.status, 202);
    if (invalidateFolder) {
      assert.equal(resumed.body.job.status, "blocked");
      assert.equal(resumed.body.job.permissionRequest.preflight, true);
      assert.deepEqual(resumed.body.job.runtimeDirectoryGrants, []);
      assert.equal(calls.length, 0);
      const replaced = await approvePreflightDirectory(url, resumed.body.job, replacement);
      assert.equal(replaced.response.status, 202, replaced.body.error);
      assert.equal(replaced.body.job.status, "running");
    } else {
      assert.equal(resumed.body.job.status, "running");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resume, false);
    assert.equal(calls[0].sessionId, created.body.job.id);
    assert.match(calls[0].prompt, /Continue existing work\./);
    assert.doesNotMatch(calls[0].prompt, /Resume the existing FixLab dashboard session/);
    assert.deepEqual(calls[0].runtimeDirectories, [realpathSync(replacement)]);
    assert.equal(git(repository, ["branch", "--show-current"]), branch);
    assert.equal(readFileSync(join(repository, "tracked.txt"), "utf8"), "Preserve existing work.");
  } finally {
    await dashboard.close();
    rmSync(source, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
    if (invalidateFolder) {
      rmSync(replacement, { recursive: true, force: true });
    }
  }
});
}

for (const recoverPreflight of [false, true]) {
test(`permission preflight reviews a job-bound folder before the first executor starts${recoverPreflight ? " after recovery" : ""}`, async () => {
  const repository = createGitRepository();
  const external = mkdtempSync(join(tmpdir(), "fixlab-preflight-scope-"));
  const calls = [];
  const execute = (input) => {
    calls.push(input);
    return { completion: new Promise(() => {}), terminate() {} };
  };
  let { dashboard, url } = await startDashboard(repository, execute);
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await post("/api/jobs", {
      request: "Review helper access.", mode: "validate-only", permissionPreflight: "yes"
    })).response.status, 400);
    const started = await post("/api/jobs", {
      request: "Review helper access.", mode: "validate-only", permissionPreflight: true
    });
    let job = started.body.job;
    assert.equal(started.response.status, 202);
    assert.equal(job.status, "blocked");
    assert.equal(job.permissionRequest.preflight, true);
    assert.equal(calls.length, 0);
    assert.equal(job.canReviewPermissions, true);
    if (recoverPreflight) {
      const previousRequest = job.permissionRequest.id;
      await dashboard.close();
      ({ dashboard, url } = await startDashboard(repository, execute));
      job = (await jsonRequest(url, "/api/job")).body.job;
      assert.equal(job.status, "blocked");
      assert.equal(job.permissionRequest.preflight, true);
      assert.notEqual(job.permissionRequest.id, previousRequest);
      assert.deepEqual(job.runtimeDirectoryGrants, []);
      assert.equal(calls.length, 0);
    }
    assert.equal((await post("/api/job/input", { action: "continue" })).response.status, 409);
    const reviewed = await post("/api/job/permissions", {
      action: "review-directory", jobId: job.id, requestId: job.permissionRequest.id, directory: external
    });
    job = reviewed.body.job;
    assert.equal(job.permissionRequest.preflight, true);
    assert.equal(calls.length, 0);
    const approval = {
      action: "approve-directory", jobId: job.id, requestId: job.permissionRequest.id,
      directory: job.permissionRequest.scope.directory, confirmed: true
    };
    assert.equal((await post("/api/job/permissions", { ...approval, confirmed: false })).response.status, 400);
    assert.equal((await post("/api/job/permissions", approval)).response.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resume, false, "No runtime session exists before preflight approval.");
    assert.deepEqual(calls[0].runtimeDirectories, [realpathSync(external)]);
    assert.match(calls[0].prompt, /Review helper access/);
    assert.equal((await post("/api/job/permissions", approval)).response.status, 409);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
}

test("permission denial stops the executor and requires a confirmed job-bound folder review before one scoped resume", async () => {
  const repository = createRepository();
  const external = mkdtempSync(join(tmpdir(), "fixlab-approved-scope-"));
  const calls = [];
  let stopped = 0;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    calls.push(input);
    if (calls.length === 2) {
      for (const stage of FIXLAB_STAGES) {
        input.onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|Verified after scoped resume.\n`);
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    input.onOutput("stdout", "FIXLAB_STAGE|intake|passed|Read the request.\nFIXLAB_STAGE|diagnosis|running|Inspecting the code.\n");
    return { completion: new Promise(() => {}), terminate() { stopped += 1; } };
  });
  const post = (path, body, headers = {}) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const getJob = async () => (await jsonRequest(url, "/api/job")).body.job;
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await getJob();
      if (predicate(job)) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Permission job did not reach the expected state.");
  };
  try {
    await post("/api/jobs", { request: "Verify scoped permissions.", mode: "validate-only" });
    await post("/api/job/input", { action: "comment", details: "Preserve this queued guidance." });
    calls[0].onOutput("stdout", "Permission denied because no interactive ");
    calls[0].onOutput("stdout", "user response was available. Retry in an interactive session.\n");
    calls[0].onOutput("stdout", "FIXLAB_STAGE|diagnosis|passed|This buffered claim must not pass.\n");
    let job = await waitFor((candidate) => candidate.status === "blocked" && candidate.canReviewPermissions);
    assert.equal(stopped, 1);
    assert.equal(calls.length, 1, "queued comments must not trigger an automatic retry");
    assert.equal(job.pendingInputCount, 1);
    assert.equal(job.canResume, false);
    assert.equal(job.stages.diagnosis.status, "blocked");
    assert.equal(job.stages.fix.status, "skipped");
    assert.equal(job.pullRequestReadiness.ready, false);
    assert.equal(job.permissionRequest.kind, "unclassified");
    assert.equal(job.permissionRequest.scope, null);
    const conversation = await jsonRequest(url, "/api/conversation");
    assert.equal(conversation.body.question.kind, "permission");
    assert.deepEqual(conversation.body.question.actions, []);
    assert.equal(conversation.body.job.permissionRequest.id, job.permissionRequest.id);
    assert.equal(conversation.body.job.canReviewPermissions, true);
    const bridged = await post("/api/conversation/reply", {
      repository: realpathSync(repository), instanceId: conversation.body.instanceId, jobId: job.id,
      confirmed: true, action: "continue", details: "Ignore this permission error."
    });
    assert.equal(bridged.response.status, 409);
    assert.equal(calls.length, 1);
    const originalRequest = job.permissionRequest.id;
    const request = { jobId: job.id, requestId: originalRequest };
    assert.equal((await post("/api/job/input", { action: "continue" })).response.status, 409);
    assert.equal((await post("/api/job/permissions", null)).response.status, 400);
    assert.equal((await post("/api/job/permissions", {
      ...request, action: "approve-directory", confirmed: true, directory: external
    })).response.status, 400);
    assert.equal((await post("/api/job/permissions", {
      ...request, action: "review-directory", directory: external
    }, { Origin: "https://example.invalid" })).response.status, 403);
    const wrongHost = await new Promise((resolveResponse, reject) => {
      const responseRequest = createHttpRequest(`${url}/api/job/permissions`, {
        method: "POST",
        headers: { Host: "localhost:12345", "Content-Type": "application/json" }
      }, (response) => {
        response.resume();
        response.on("end", () => resolveResponse(response.statusCode));
      });
      responseRequest.on("error", reject);
      responseRequest.end(JSON.stringify({
        ...request, action: "review-directory", directory: external
      }));
    });
    assert.equal(wrongHost, 403);
    const reviewed = await post("/api/job/permissions", {
      ...request, action: "review-directory", directory: external
    });
    assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));
    job = reviewed.body.job;
    assert.equal(calls.length, 1, "review must not authorize or resume");
    assert.notEqual(job.permissionRequest.id, originalRequest);
    assert.equal(job.permissionRequest.scope.directory, realpathSync(external));
    const reviewedStatus = await jsonRequest(url, "/api/conversation");
    assert.equal(reviewedStatus.body.job.permissionRequest.id, job.permissionRequest.id);
    assert.equal(reviewedStatus.body.job.permissionRequest.scope.directory, realpathSync(external));
    await assert.rejects(dashboardControl({
      repository: realpathSync(repository), port: Number(new URL(url).port),
      instanceId: reviewedStatus.body.instanceId, jobId: job.id, confirmed: true,
      operation: "permission-approve",
      parameters: { jobId: job.id, requestId: "stale-request", directory: realpathSync(external), confirmed: true }
    }), /changed|stale|request/i);
    const approval = {
      action: "approve-directory",
      jobId: job.id,
      requestId: job.permissionRequest.id,
      directory: job.permissionRequest.scope.directory,
      confirmed: true
    };
    assert.equal((await post("/api/job/permissions", { ...approval, requestId: originalRequest })).response.status, 409);
    assert.equal((await post("/api/job/permissions", { ...approval, confirmed: false })).response.status, 400);
    assert.equal((await post("/api/job/permissions", { ...approval, directory: repository })).response.status, 400);
    assert.equal((await post("/api/job/permissions", approval)).response.status, 202);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.deepEqual(calls[0].runtimeDirectories, []);
    assert.deepEqual(calls[1].runtimeDirectories, [realpathSync(external)]);
    assert.match(calls[1].prompt, /does not authorize a denied tool/);
    // The queued comment is intentionally delivered after the authorized turn.
    job = await waitFor((candidate) => calls.length === 3 && candidate.status === "running");
    calls[2].onOutput("stdout", "Denied, no one to approve\n");
    job = await waitFor((candidate) => candidate.status === "blocked" && candidate.canReviewPermissions);
    assert.equal(calls.length, 3);
    assert.notEqual(job.permissionRequest.id, approval.requestId);
    assert.equal(job.permissionRequest.scope, null);
    assert.equal((await post("/api/job/permissions", approval)).response.status, 409);
    const duplicate = await post("/api/job/permissions", {
      action: "review-directory",
      jobId: job.id,
      requestId: job.permissionRequest.id,
      directory: external
    });
    assert.equal(duplicate.response.status, 400);
    assert.match(duplicate.body.error, /already granted/);
    const restarted = await post("/api/jobs/restart", { jobId: job.id });
    assert.equal(restarted.response.status, 202, JSON.stringify(restarted.body));
    assert.equal(calls.length, 4);
    assert.notEqual(calls[3].sessionId, calls[0].sessionId);
    assert.deepEqual(calls[3].runtimeDirectories, []);
    assert.equal((await post("/api/job/permissions", approval)).response.status, 409);
    calls[3].onOutput("stdout", "Denied, no one to approve\n");
    await waitFor((candidate) => candidate.status === "blocked" && candidate.canReviewPermissions);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("permission review waits for owned termination and grants do not survive dashboard recovery", async () => {
  const repository = createGitRepository();
  const external = mkdtempSync(join(tmpdir(), "fixlab-expiring-scope-"));
  let emit;
  let finish;
  let first = await startDashboard(repository, ({ onOutput }) => {
    emit = onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() {}
    };
  }, undefined, { deferTermination: true, runtime: "copilot" });
  const post = (path, body) => jsonRequest(first.url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let reviewed;
  try {
    await post("/api/jobs", { request: "Retain an honest permission blocker.", mode: "validate-only" });
    emit("stdout", "Permission denied because no interactive user response was available.\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    let job = (await jsonRequest(first.url, "/api/job")).body.job;
    assert.equal(job.canReviewPermissions, false);
    assert.equal(job.canDismiss, false);
    assert.equal((await post("/api/job/permissions", {
      jobId: job.id, requestId: job.permissionRequest.id,
      action: "review-directory", directory: external
    })).response.status, 409);
    finish({ code: null, signal: "SIGTERM" });
    for (let attempt = 0; attempt < 100 && !job.canReviewPermissions; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = (await jsonRequest(first.url, "/api/job")).body.job;
    }
    assert.equal(job.canReviewPermissions, true);
    assert.equal(job.canDismiss, true);
    reviewed = await post("/api/job/permissions", {
      jobId: job.id, requestId: job.permissionRequest.id,
      action: "review-directory", directory: external
    });
    assert.equal(reviewed.response.status, 200);
    const scope = reviewed.body.job.permissionRequest.scope;
    assert.equal((await post("/api/job/permissions", {
      jobId: job.id, requestId: reviewed.body.job.permissionRequest.id,
      action: "approve-directory", directory: scope.directory, confirmed: true
    })).response.status, 202);
    emit("stdout", "Denied, no one to approve\n");
    finish({ code: null, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await jsonRequest(first.url, "/api/job")).body.job;
    assert.equal(job.status, "blocked");
    assert.deepEqual(job.runtimeDirectoryGrants, [realpathSync(external)]);
    await first.dashboard.close();
    const historyPath = join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json");
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    const interrupted = history.jobs.find((saved) => saved.id === job.id);
    interrupted.status = "running";
    interrupted.stages.diagnosis = { status: "running", message: "Waiting for permission pause termination." };
    interrupted.stages.fix = { status: "pending", message: "" };
    writeFileSync(historyPath, JSON.stringify(history));
    first = await startDashboard(repository, () => {
      throw new Error("Recovered permission requests must not automatically execute.");
    }, undefined, { runtime: "copilot" });
    job = (await jsonRequest(first.url, "/api/job")).body.job;
    assert.equal(job.status, "blocked");
    assert.equal(job.canReviewPermissions, true);
    assert.equal(job.canResume, false);
    assert.equal(job.permissionRequest.scope, null);
    assert.notEqual(job.permissionRequest.id, reviewed.body.job.permissionRequest.id);
    assert.deepEqual(job.runtimeDirectoryGrants, []);
  } finally {
    finish?.({ code: null, signal: "SIGTERM" });
    await first.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("whitespace permission stage markers pause execution and disable ordinary continuation", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_STAGE diagnosis blocked - Execution remains denied\n");
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|Buffered output must not bypass permission review.\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Respect both stage marker formats.", mode: "validate-only" })
    });
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = (await jsonRequest(url, "/api/job")).body.job;
      if (job.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "blocked");
    assert.equal(job.canReviewPermissions, true);
    assert.equal(job.canDismiss, true);
    assert.equal(job.canResume, false);
    assert.equal(job.stages.diagnosis.status, "blocked");
    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue" })
    });
    assert.equal(resumed.response.status, 409);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("a stale existing grant cannot overwrite its replacement permission request or poison later approvals", async () => {
  const repository = createRepository();
  const base = mkdtempSync(join(tmpdir(), "fixlab-stale-grants-"));
  const first = join(base, "first");
  const replacement = join(base, "replacement");
  const later = join(base, "later");
  const link = join(base, "link");
  for (const directory of [first, replacement, later]) {
    mkdirSync(directory);
  }
  symlinkSync(first, link, "junction");
  const calls = [];
  const { dashboard, url } = await startDashboard(repository, (input) => {
    calls.push(input);
    input.onOutput("stdout", "Denied, no one to approve\n");
    return { completion: new Promise(() => {}), terminate() {} };
  });
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const paused = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = (await jsonRequest(url, "/api/job")).body.job;
      if (job.canReviewPermissions) {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Permission job did not pause after verified termination.");
  };
  const review = async (job, directory) => {
    const result = await post("/api/job/permissions", {
      action: "review-directory", jobId: job.id,
      requestId: job.permissionRequest.id, directory
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body.job;
  };
  const approve = (job) => post("/api/job/permissions", {
    action: "approve-directory", jobId: job.id,
    requestId: job.permissionRequest.id,
    directory: job.permissionRequest.scope.directory, confirmed: true
  });
  try {
    await post("/api/jobs", { request: "Recover from substituted prior grants.", mode: "validate-only" });
    let job = await review(await paused(), link);
    assert.equal((await approve(job)).response.status, 202);
    job = await review(await paused(), later);
    const staleRequestId = job.permissionRequest.id;
    rmSync(link);
    symlinkSync(replacement, link, "junction");
    const failed = await approve(job);
    assert.equal(failed.response.status, 409);
    assert.match(failed.body.error, /previously approved folder changed/);
    job = failed.body.job;
    assert.equal(calls.length, 2, "no executor may start with a substituted prior grant");
    assert.notEqual(job.permissionRequest.id, staleRequestId);
    assert.equal(job.permissionRequest.scope, null);
    assert.deepEqual(job.runtimeDirectoryGrants, []);
    job = await review(job, later);
    assert.equal((await approve(job)).response.status, 202);
    await paused();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].runtimeDirectories, [realpathSync(later)]);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("Copilot dashboard retains model defaults, overrides and queue state through recovery", async () => {
  const repository = createGitRepository();
  const calls = [];
  let current = await startDashboard(repository, (input) => {
    calls.push(input);
    input.onOutput("stdout", "FIXLAB_STAGE|intake|blocked|Waiting for a prerequisite.\n");
    return { completion: Promise.resolve({ code: 1 }), terminate() {} };
  }, undefined, { runtime: "copilot", model: "hydrafusion" });
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const status = await jsonRequest(current.url, "/api/status");
    assert.deepEqual(status.body.runtime, {
      name: "copilot",
      defaultModel: "hydrafusion",
      supportsModelSelection: true,
      helperDirectory: realpathSync(packageRoot)
    });
    const started = await post("/api/jobs", {
      request: "Retain the configured model.",
      mode: "validate-only"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.job.model, "hydrafusion");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = await post("/api/job/input", {
      action: "continue",
      details: "The prerequisite is ready."
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(calls[1].model, "hydrafusion");
    assert.equal(calls[1].resume, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = await post("/api/jobs", {
      request: "Use an explicit stable model.",
      mode: "validate-only",
      model: "claude-sonnet-4.5"
    });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.body.queue[0].model, "claude-sonnet-4.5");
    const unconfigured = await post("/api/jobs", {
      request: "Use Copilot's own default.",
      mode: "validate-only",
      model: ""
    });
    assert.equal(unconfigured.response.status, 202);
    assert.equal(unconfigured.body.queue[1].model, "");
    await current.dashboard.close();
    current = await startDashboard(repository, (input) => {
      calls.push(input);
      return { completion: new Promise(() => {}), terminate() {} };
    }, undefined, { runtime: "copilot", model: "another-model" });
    const recovered = await jsonRequest(current.url, "/api/status");
    assert.equal(recovered.body.job.model, "hydrafusion");
    assert.equal(recovered.body.history.find((job) => job.id === queued.body.queue[0].id).model, "claude-sonnet-4.5");
    assert.equal(recovered.body.history.find((job) => job.id === unconfigured.body.queue[1].id).model, "");
    await post("/api/job/input", { action: "continue", details: "Resume the saved model." });
    assert.equal(calls.at(-1).model, "hydrafusion");
    await current.dashboard.close();
    current = await startDashboard(repository, () => {
      throw new Error("Cross-runtime recovery must not start an executor.");
    });
    const incompatible = await jsonRequest(current.url, "/api/status");
    assert.equal(incompatible.body.job, null);
    assert.ok(incompatible.body.history.some((job) => job.runtime === "copilot"));
    const rejected = await post("/api/job/input", { action: "continue", details: "Wrong runtime." });
    assert.equal(rejected.response.status, 404);
    assert.match(rejected.body.error, /no FixLab job/);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Agency dashboard rejects Copilot model overrides before starting an executor", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("Rejected jobs must not execute.");
  });
  try {
    const rejected = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Do not execute.", mode: "validate-only", model: "hydrafusion" })
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /copilot runtime/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const trailingNewline of [false, true]) {
  test(`adjacent markers survive chunk boundaries and ${trailingNewline ? "complete lines" : "final partial output"}`, async () => {
    const repository = createRepository();
    const { dashboard, url } = await startDashboard(repository, ({ onOutput }) => {
      const text = FIXLAB_STAGES.map((stage) => `FIXLAB_STAGE|${stage}|skipped|Read-only validation.`).join("") +
        "FIXLAB_ACTIVITY|intake|Recorded the required evidence." +
        (trailingNewline ? "\n" : "");
      const boundary = text.indexOf("FIXLAB_STAGE", 1) + 7;
      onOutput("stdout", text.slice(0, boundary));
      onOutput("stdout", text.slice(boundary));
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    });
    try {
      const started = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Validate marker boundaries.", mode: "validate-only" })
      });
      assert.equal(started.response.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const completed = await jsonRequest(url, "/api/job");
      assert.equal(completed.body.job.status, "passed");
      for (const stage of FIXLAB_STAGES) {
        assert.equal(completed.body.job.stages[stage].status, "skipped");
      }
      assert.equal(completed.body.job.activity.length, 1);
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("dashboard reports readiness and serves only known static assets", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("executor should not run");
  });

  try {
    const status = await jsonRequest(url, "/api/status");
    assert.equal(status.response.status, 200);
    assert.equal(status.body.readiness.repositoryReady, true);
    assert.equal(status.body.readiness.profileReady, true);
    assert.deepEqual(status.body.readiness.environments, [
      "local",
      "dev",
      "sit"
    ]);
    assert.equal(
      status.body.readiness.profileName,
      "Dashboard test repository"
    );

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /FixLab Dashboard/);
    assert.match(pageText, /Bug or required enhancement/);
    assert.match(pageText, /Enter manually/);
    assert.match(pageText, /Load from Azure DevOps/);
    assert.match(pageText, /Load work items/);
    assert.match(pageText, /Bugs, User Stories, Tasks, or Features/);
    assert.match(pageText, /Continue this job/);
    assert.match(pageText, /<label for="screenshots">Images \(optional\)<\/label>/);
    assert.match(pageText, /id="workspace-tools"[^>]* hidden>/);
    assert.match(pageText, /id="navigation-toggle"[^>]*aria-controls="repository-navigation" aria-expanded="false"/);
    assert.match(pageText, /id="close-workspace-tools"[^>]*>Back to chat<\/button>/);
    assert.match(pageText, /Secrets, external access and publication still need review/);
    assert.match(pageText, /proceeds autonomously/);

    const traversal = await fetch(`${url}/..%2fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard rejects validation-only work when preflight finds a missing tool", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(
    repository,
    () => {
      throw new Error("executor should not run");
    },
    undefined,
    {
      preflight: () => [{ check: "npm on PATH", detail: "npm was not found" }]
    }
  );

  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Fix the defect.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /Preflight failed: npm on PATH/);
    assert.equal(result.body.preflight.length, 1);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("code jobs receive missing-tool diagnostics for autonomous repair instead of a startup rejection", async () => {
  const repository = createRepository();
  let prompt;
  let finish;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); } };
  }, undefined, { preflight: () => [{ check: "npm on PATH", detail: "npm was not found" }] });
  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Repair the focused code path.", mode: "fix-and-validate" })
    });
    assert.equal(result.response.status, 202, result.body.error);
    assert.deepEqual(result.body.job.setupRecovery, ["npm on PATH: npm was not found"]);
    assert.match(prompt, /Autonomous recovery: diagnose and repair recoverable/);
    assert.match(prompt, /npm on PATH: npm was not found/);
    assert.equal(result.body.job.validation.fullValidationPassed, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("browser-only jobs pass their scope into preflight and do not require an unused backend toolchain", async () => {
  const repository = createRepository();
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const profile = validProfile();
  profile.applications.backend = { command: "dotnet run", workingDirectory: "." };
  profile.validation = { commands: { backendRestore: "dotnet restore" } };
  writeFileSync(path, JSON.stringify(profile));
  const checked = [];
  let finish;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); } };
  }, undefined, {
    preflight: (input) => runJobPreflight({ ...input,
      resolve: (tool) => { checked.push(tool); return tool === "npm"; } })
  });
  try {
    const result = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Reproduce the deployed browser behavior only.",
        mode: "playwright-only", targetEnvironment: "dev" })
    });
    assert.equal(result.response.status, 202);
    assert.deepEqual(checked, ["npm"]);
    assert.match(prompt, /Existing-application fast path/);
    assert.match(prompt, /selected environment/);
    assert.equal(result.body.job.sharedWorkspace, null);
    assert.equal(result.body.job.validation.gates.length, 0);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("loads Azure DevOps intake and passes local screenshots without caching them", async () => {
  const repository = createGitRepository();
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  writeFileSync(
    profilePath,
    JSON.stringify(validProfile({
      name: "ADO intake repository",
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }))
  );
  git(repository, [
    "add",
    join(".github", "fixlab", "repository-profile.json")
  ]);
  git(repository, ["commit", "--quiet", "-m", "Add ADO profile"]);

  const workItem = {
    id: 71,
    title: "Loaded bug",
    description: "Loaded description",
    reproduction: "Loaded reproduction",
    acceptanceCriteria: "Loaded acceptance",
    state: "Active",
    workItemType: "Feature",
    screenshots: [
      {
        name: "71-loaded.png",
        mimeType: "image/png",
        base64: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
        ]).toString("base64")
      }
    ],
    imagesWarning: "",
    webUrl:
      "https://dev.azure.com/profile-org/Profile%20Project/_workitems/edit/71"
  };
  let loaderInput;
  let receivedPrompt;
  let receivedArtifactDirectories;
  const executor = ({ prompt, artifactDirectories, onOutput }) => {
    receivedPrompt = prompt;
    receivedArtifactDirectories = artifactDirectories;
    onOutput(
      "stdout",
      "FIXLAB_BUG|71|external|upstream-system|The upstream system owns the rejected request; no repository change is required.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const workItemLoader = async (input) => {
    loaderInput = input;
    return workItem;
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    workItemLoader
  );
  let screenshotPath;

  try {
    const loaded = await jsonRequest(url, "/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItem: "71" })
    });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.workItem.title, "Loaded bug");
    assert.equal(loaded.body.workItem.workItemType, "Feature");
    const intakeModule = await fetch(`${url}/work-item-intake.js`);
    assert.equal(intakeModule.status, 200);
    assert.match(await intakeModule.text(), /export function workItemsRequest/u);
    assert.equal(loaded.body.workItem.screenshots.length, 1);
    assert.equal(loaded.body.workItem.screenshots[0].name, "71-loaded.png");
    assert.equal(
      loaderInput.profile.azureDevOps.organization,
      "profile-org"
    );

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Loaded bug and user notes.",
        requestType: "bug-fix",
        mode: "fix-and-validate",
        intakeSource: "azure-devops",
        workItem,
        screenshots: [
          {
            name: "screen.png",
            mimeType: "image/png",
            base64: png.toString("base64")
          }
        ]
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.job.intakeSource, "azure-devops");
    assert.equal(started.body.job.workItem.id, 71);
    assert.deepEqual(started.body.job.screenshots, [
      { name: "screen.png", mimeType: "image/png", bytes: 8 }
    ]);
    assert.equal("path" in started.body.job.screenshots[0], false);

    const pathLine = receivedPrompt
      .split(/\r?\n/)
      .find((line) => line.startsWith("- ") && line.endsWith(".png"));
    screenshotPath = pathLine?.slice(2);
    assert.ok(screenshotPath);
    assert.equal(existsSync(screenshotPath), true);
    assert.deepEqual(receivedArtifactDirectories, [dirname(screenshotPath)]);
    assert.match(receivedPrompt, /Loaded Azure DevOps selection/);
    assert.match(receivedPrompt, /"workItemType":\s*"Feature"/u);
    assert.match(receivedPrompt, /"acceptanceCriteria":\s*"Loaded acceptance"/u);
    assert.match(
      receivedPrompt,
      /Do not search for or download additional Azure DevOps attachments/
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const cacheContext = createCacheContext(repository);
    const cacheContent = readFileSync(cacheContext.cachePath, "utf8");
    assert.doesNotMatch(cacheContent, /screen\.png/);
    assert.doesNotMatch(cacheContent, /dashboard-artifacts/);
    assert.doesNotMatch(cacheContent, /Loaded description/);
  } finally {
    await dashboard.close();
    if (screenshotPath) {
      assert.equal(existsSync(screenshotPath), false);
    }
    rmSync(repository, { recursive: true, force: true });
  }
});

test("loads and starts one Azure DevOps multi-bug batch", async () => {
  const repository = createGitRepository();
  git(repository, [
    "remote",
    "add",
    "origin",
    "https://dev.azure.com/example/project/_git/dashboard-test"
  ]);
  let loadedProfile;
  const workItemLoader = async () => {
    throw new Error("single-item loader should not run");
  };
  workItemLoader.loadMany = async ({ workItems, profile }) => {
    loadedProfile = profile;
    return workItems.map((value) => ({
      id: Number(value),
      title: `Loaded bug ${value}`,
      description: "",
      reproduction: "",
      acceptanceCriteria: "",
      state: "Active",
      workItemType: "Bug",
      webUrl: `https://dev.azure.com/example/project/_workitems/edit/${value}`
    }));
  };
  let receivedPrompt = "";
  const openedLocalhostUrls = [];
  let resolveBrowserOpen;
  const executor = ({ onOutput, prompt }) => {
    receivedPrompt = prompt;
    for (const id of ["101", "202"]) {
      onOutput(
        "stdout",
        `FIXLAB_BUG|${id}|no-change|application|No repository change is required.\n`
      );
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    workItemLoader,
    {
      browserOpener(localhostUrl) {
        openedLocalhostUrls.push(localhostUrl);
        return new Promise((resolveOpen) => {
          resolveBrowserOpen = resolveOpen;
        });
      }
    }
  );

  try {
    const loaded = await jsonRequest(url, "/api/azure-devops/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItems: ["101", "202"] })
    });
    assert.equal(loaded.response.status, 200, JSON.stringify(loaded.body));
    assert.equal(loaded.body.workItem, null);
    assert.deepEqual(
      loaded.body.workItems.map((item) => item.id),
      [101, 202]
    );
    assert.deepEqual(loadedProfile.azureDevOps, {
      organization: "example",
      project: "project"
    });
    const onboarding = await jsonRequest(url, "/api/onboarding");
    assert.deepEqual(onboarding.body.azureDevOps, {
      organization: "example",
      project: "project"
    });
    const savedOnboarding = await jsonRequest(
      url,
      "/api/onboarding/azure-devops",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: "saved-org",
          project: "saved-project"
        })
      }
    );
    assert.equal(savedOnboarding.response.status, 200);
    const savedProfile = JSON.parse(
      readFileSync(
        join(
          repository,
          ".github",
          "fixlab",
          "repository-profile.json"
        ),
        "utf8"
      )
    );
    assert.deepEqual(savedProfile.azureDevOps, {
      organization: "saved-org",
      project: "saved-project"
    });

    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request:
          "Azure DevOps Bug 101: First bug\n\nAzure DevOps Bug 202: Second bug",
        mode: "fix-and-validate",
        pullRequestStrategy: "per-bug",
        runAllUiScenarios: true,
        manualLocalhostTest: true,
        intakeSource: "azure-devops",
        workItems: loaded.body.workItems
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.job.workItems.length, 2);
    assert.equal(started.body.job.pullRequestStrategy, "per-bug");
    assert.equal(started.body.job.runAllUiScenarios, true);
    assert.equal(started.body.job.manualLocalhostTest, true);
    assert.equal(
      started.body.job.manualLocalhostUrl,
      "http://127.0.0.1:3000"
    );
    assert.deepEqual(openedLocalhostUrls, ["http://127.0.0.1:3000"]);
    assert.equal(started.body.job.manualLocalhostOpenedAt, null);
    resolveBrowserOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = await jsonRequest(url, "/api/job");
    assert.ok(opened.body.job.manualLocalhostOpenedAt);
    assert.match(
      opened.body.job.logs.at(-1).message,
      /Opened the React localhost URL/
    );
    assert.equal("description" in started.body.job.workItems[0], false);
    assert.match(receivedPrompt, /Pull request strategy: per-bug/);
    assert.match(receivedPrompt, /isolated delivery unit/);
    assert.match(receivedPrompt, /every repository-defined Playwright\/UI scenario/);
    assert.match(
      receivedPrompt,
      /Open React localhost for manual validation: yes/
    );
    assert.match(
      receivedPrompt,
      /Manual React localhost validation is enabled independently of Playwright/
    );
    assert.match(receivedPrompt, /manual confirmation is pending/);
    assert.match(receivedPrompt, /users\/fixlab-test/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.deepEqual(
      completed.body.job.bugs.map((bug) => bug.id),
      ["101", "202"]
    );
    assert.equal(
      completed.body.job.pullRequestReadiness.status,
      "blocked"
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard records synchronous browser launcher failures", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    undefined,
    {
      browserOpener() {
        throw new Error("browser launcher is unavailable");
      }
    }
  );

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Open React localhost for manual validation.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.manualLocalhostOpenedAt, null);
    assert.ok(
      completed.body.job.logs.some((entry) =>
        /browser launcher is unavailable/.test(entry.message)
      )
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard finalizes a pending manual marker as blocked", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} complete\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Require manual localhost confirmation.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blocked = await jsonRequest(url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.manualLocalhostPending, true);
    assert.equal(blocked.body.job.stages["live-test"].status, "blocked");
    const conversation = await jsonRequest(url, "/api/conversation");
    assert.equal(conversation.body.question.kind, "manual-test");
    assert.deepEqual(conversation.body.question.actions, ["manual-pass", "manual-fail"]);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard keeps an explicit manual failure authoritative", async () => {
  const repository = createRepository();
  let callCount = 0;
  const executor = ({ onOutput }) => {
    callCount += 1;
    if (callCount === 1) {
      onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
      for (const stage of FIXLAB_STAGES) {
        const status = stage === "live-test" ? "blocked" : "passed";
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|${status}|${stage} initial\n`
        );
      }
    } else {
      for (const stage of FIXLAB_STAGES) {
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`
        );
      }
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Respect a failed manual localhost result.",
        requestType: "small-enhancement",
        mode: "fix-and-validate",
        manualLocalhostTest: true
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-fail" })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");
    assert.equal(failed.body.job.manualLocalhostResult, "failed");
    assert.equal(failed.body.job.stages["live-test"].status, "failed");
    assert.match(failed.body.job.error, /Manual React localhost validation failed/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard parses complete stage markers and passes a job", async () => {
  const repository = createRepository();
  let receivedPrompt;
  const executor = ({ prompt, onOutput }) => {
    receivedPrompt = prompt;
    onOutput(
      "stdout",
      "FIXLAB_BUG|17037209|external|upstream-system|The upstream system rejected parent validation and the application surfaced the returned error.\n"
    );
    onOutput(
      "stdout",
      "FIXLAB_BUG|17032997|fixed|application|Generation status displays the generated object type.\n"
    );
    onOutput(
      "stdout",
      "FIXLAB_TEST|synthetic-intercepted|intercepted|Two rapid approvals produce one approval request and one submission.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
      );
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request:
          "Azure DevOps Bug 17037209: Remap failed\nURL: https://dev.azure.com/example/project/_workitems/edit/17037209\n\nAzure DevOps Bug 17032997: Generic generation status",
        mode: "fix-and-validate",
        targetEnvironment: "sit"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.error, null);
    assert.equal(result.body.job.requestType, "bug-fix");
    assert.equal(result.body.job.targetEnvironment, "sit");
    assert.deepEqual(result.body.job.testEvidence, {
      enabled: true,
      source: "synthetic-intercepted",
      mutationMode: "intercepted",
      requireScenarioEvidence: true,
      reported: true,
      scenario:
        "Two rapid approvals produce one approval request and one submission."
    });
    assert.deepEqual(result.body.job.bugs, [
      {
        id: "17037209",
        title: "Remap failed",
        url: "https://dev.azure.com/example/project/_workitems/edit/17037209",
        outcome: "external",
        owner: "upstream-system",
        summary:
          "The upstream system rejected parent validation and the application surfaced the returned error."
      },
      {
        id: "17032997",
        title: "Generic generation status",
        url: "",
        outcome: "fixed",
        owner: "application",
        summary: "Generation status displays the generated object type."
      }
    ]);
    assert.match(receivedPrompt, /Read \.github\/fixlab\/repository-profile\.json/i);
    assert.match(receivedPrompt, /smallest complete change/i);
    assert.match(receivedPrompt, /Make no code change/i);
    assert.match(receivedPrompt, /self-review the effective diff/i);
    assert.match(receivedPrompt, /tests, type-checks, and builds/i);
    assert.match(
      receivedPrompt,
      /Do not skip Playwright merely because an unrelated non-browser/
    );
    assert.match(
      receivedPrompt,
      /Use local-stack only for profile-defined application startup and health/
    );
    assert.match(
      receivedPrompt,
      /Do not mark local-stack failed because a separate test, type-check, lint, or production build/
    );
    assert.match(receivedPrompt, /applications defined by the repository profile/i);
    assert.match(receivedPrompt, /repository-defined live test/i);
    assert.match(receivedPrompt, /Test synthesis: enabled/);
    assert.match(receivedPrompt, /Selected validation environment: sit/);
    assert.match(receivedPrompt, /Use exactly that repository-approved environment/);
    assert.match(receivedPrompt, /Do not silently fall back to local/);
    assert.match(
      receivedPrompt,
      /Configured test data source: synthetic-intercepted/
    );
    assert.match(receivedPrompt, /FIXLAB_TEST\|source\|mutation-mode\|scenario/);
    assert.match(receivedPrompt, /intercept every mutating request/);
    assert.match(
      receivedPrompt,
      /save at least one non-sensitive screenshot/i
    );
    assert.match(
      receivedPrompt,
      /Treat a synthesized Playwright scenario as a transient validation artifact/
    );
    assert.match(
      receivedPrompt,
      /Do not add a newly generated authenticated test such as `\*\.auth\.spec\.ts`/
    );
    assert.match(
      receivedPrompt,
      /Remove its source file and any validation-only configuration edits before diff review/
    );
    assert.match(
      receivedPrompt,
      /do not broaden the pull request to repair unrelated or stale browser journeys/
    );
    assert.match(receivedPrompt, /Do not invent or hardcode environment choices/i);
    assert.match(
      receivedPrompt,
      /create or update a draft pull request before remaining independent validation completes/i
    );
    assert.match(
      receivedPrompt,
      /Start long-running independent validation commands in parallel/i
    );
    assert.match(
      receivedPrompt,
      /Keep the pull request draft and clearly marked validation-in-progress/i
    );
    assert.match(
      receivedPrompt,
      /Mark ready\/pr passed only after required gates pass or repository policy explicitly accepts the outcome/i
    );
    assert.match(receivedPrompt, /publish the authorized PR by marking it ready for review/);
    assert.match(receivedPrompt, /Do not wait for remote PR CI or build completion before publication/);
    assert.match(receivedPrompt, /Verify the PR is no longer draft before reporting the PR stage passed/);
    assert.match(receivedPrompt, /Report remote checks as pending, not passed, and leave merge policies intact/);
    assert.match(receivedPrompt, /az repos pr update --id <id> --draft false/);
    assert.match(receivedPrompt, /authentication, unsafe-data approval/i);
    assert.match(receivedPrompt, /git status and effective diff/i);
    assert.match(receivedPrompt, /task-relevant symbols and files/i);
    assert.match(receivedPrompt, /Reuse this job\/session context/i);
    assert.match(receivedPrompt, /Do not reread unchanged files/i);
    assert.match(receivedPrompt, /reinstall available dependencies/i);
    assert.match(receivedPrompt, /commit changes and repository-profile or instruction changes as invalidation boundaries/i);
    assert.match(receivedPrompt, /do not feed unbounded raw output back into prompts/i);
    assert.match(receivedPrompt, /fixlab exec --stage <stage>/i);
    assert.match(receivedPrompt, /never wrap `fixlab exec` in `cmd \/c`/u);
    assert.match(receivedPrompt, /Never reuse startup, health, authentication/i);
    assert.match(receivedPrompt, /FIXLAB_STAGE\|stage\|status\|message/);
    assert.match(receivedPrompt, /FIXLAB_BUG\|id\|outcome\|owner\|summary/);
    assert.match(receivedPrompt, /Never generate markers through shell/);
    assert.match(receivedPrompt, /required machine-readable output/);
    assert.match(receivedPrompt, /before the terminal pr stage/);
    assert.match(
      receivedPrompt,
      /Do not call task_complete or return the final response/
    );
    assert.match(receivedPrompt, /external with owner upstream-system/);
    assert.match(receivedPrompt, /Do not create an empty pull request/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("read-only job prompts permit new transient journeys without authorizing product edits", () => {
  for (const mode of ["validate-only", "playwright-only"]) {
    const prompt = buildJobPrompt({ request: "Validate a missing browser scenario.", mode });
    assert.match(prompt, /Do not edit files other than job-owned transient Playwright journeys and runner evidence/u);
    assert.doesNotMatch(prompt, /Do not edit files, create commits/u);
    assert.match(prompt, /Never overwrite pre-existing tests/u);
    if (mode === "validate-only") {
      assert.match(prompt, /Reuse an equivalent existing journey first/u);
      assert.match(prompt, /configured test directory/u);
      assert.match(prompt, /Never overwrite pre-existing tests or change configuration, authentication helpers, credentials or browser state/u);
      assert.match(prompt, /this exception grants no runtime access or business writes/u);
    } else {
      assert.match(prompt, /prefer an existing journey or retained script/u);
      assert.match(prompt, /Do not copy browser state or credentials/u);
      assert.match(prompt, /writes require separate native approval/u);
    }
  }
});

test("job prompts omit irrelevant publication guidance and keep one output contract", () => {
  for (const [mode, limit] of [
    ["fix-and-validate", 19000], ["validate-only", 15000], ["playwright-only", 9500]
  ]) {
    const prompt = buildJobPrompt({
      request: "Validate the reported behavior.", mode, targetEnvironment: "dev"
    });
    assert.ok(prompt.length < limit, `${mode}: ${prompt.length} must be below ${limit}`);
    for (const marker of [
      "FixLab output protocol", "FIXLAB_TEST|source|mutation-mode|scenario",
      "FIXLAB_BUG|id|outcome|owner|summary"
    ]) {
      assert.equal(prompt.split(marker).length - 1, 1, `${mode}: ${marker}`);
    }
    if (mode === "validate-only") {
      assert.doesNotMatch(prompt, /Prefix FixLab-created pull-request titles|commit\/push the authorized checkpoint|Reusable PR learning/u);
      assert.match(prompt, /full regression is explicitly deferred, not passed/u);
      assert.match(prompt, /Runtime permissions and human authentication remain separate approvals/u);
    }
  }
});

test("dashboard fails a passed live test without required scenario evidence", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    { autoTestEvidence: false }
  );

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Require explicit browser scenario evidence.",
        mode: "validate-only"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "failed");
    assert.equal(result.body.job.stages["live-test"].status, "failed");
    assert.match(result.body.job.error, /required FIXLAB_TEST/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard accepts rendered text stage markers", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      const status =
        stage === "live-test"
          ? "skipped"
          : stage === "pr"
            ? "blocked"
            : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE ${stage} ${status} - ${stage} rendered result\n`
      );
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate rendered stage marker compatibility.",
        mode: "validate-only"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");
    assert.equal(result.body.job.status, "blocked");
    assert.equal(result.body.job.error, null);
    assert.equal(result.body.job.stages.intake.status, "passed");
    assert.equal(result.body.job.stages["live-test"].status, "skipped");
    assert.equal(result.body.job.stages.pr.status, "blocked");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("blocked job accepts user input and resumes the same Agency session", async () => {
  const repository = createRepository();
  const calls = [];
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (!resume) {
      for (const stage of FIXLAB_STAGES) {
        const status =
          stage === "live-test"
            ? "blocked"
            : stage === "pr"
              ? "skipped"
              : "passed";
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|${status}|${stage} result\n`
        );
      }
    } else {
      for (const stage of FIXLAB_STAGES) {
        onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`
        );
      }
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate an authenticated browser workflow.",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
    assert.match(
      started.body.job.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const blocked = await jsonRequest(url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.canResume, true);
    assert.equal(blocked.body.job.stages["live-test"].status, "blocked");
    assert.equal(blocked.body.job.manualLocalhostPending, false);

    const invalidManualResult = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-pass" })
    });
    assert.equal(invalidManualResult.response.status, 409);
    assert.match(
      invalidManualResult.body.error,
      /manual localhost confirmation is not pending/
    );

    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Authentication is complete. Continue the browser validation."
      })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.job.inputCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resume, false);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /Authentication is complete/);
    assert.match(calls[1].prompt, /Resume the existing FixLab dashboard session/);
    assert.match(calls[1].prompt, /it does not prohibit job-owned transient Playwright journeys/u);
    assert.match(calls[1].prompt, /Normal runtime permissions, prior denials/u);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("zero-progress failure retries as a fresh Copilot session", async () => {
  const repository = createRepository();
  const calls = [];
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (calls.length === 1) {
      return { completion: Promise.resolve({ code: 1 }), terminate() {} };
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} retried\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Repair a launch-blocked defect.",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");
    assert.equal(failed.body.job.stages.intake.status, "pending");

    const retried = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "retry",
        details: "The plugin compatibility issue is fixed."
      })
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resume, false);
    assert.equal(calls[1].resume, false);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /Repair a launch-blocked defect/);
    assert.match(calls[1].prompt, /failed before FixLab completed any stage/);
    assert.match(calls[1].prompt, /plugin compatibility issue is fixed/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard-owned pending review does not force a nonexistent runtime session on retry", async () => {
  const repository = createGitRepository();
  const profile = validProfile({
    validation: { gates: [{
      id: "tests", command: process.execPath, args: ["-e", "process.exit(0)"],
      workingDirectory: ".", timeoutSeconds: 30
    }] }
  });
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const calls = [];
  const executor = (input) => {
    calls.push(input);
    return { completion: Promise.resolve({ code: 1 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    await post("/api/jobs", { request: "Recover a launch that created no runtime session.", mode: "fix-and-validate" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.stages.review.status, "blocked");
    await post("/api/job/input", { action: "retry", details: "Retry the same job from intake; keep all required gates pending." });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, false);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.match(calls[1].prompt, /failed before FixLab completed any stage/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("running job queues a comment and resumes the same session", async () => {
  const repository = createRepository();
  const calls = [];
  let completeFirst;
  let firstOutput;
  const executor = ({ prompt, sessionId, resume, onOutput }) => {
    calls.push({ prompt, sessionId, resume });
    if (!resume) {
      firstOutput = onOutput;
      return {
        completion: new Promise((resolve) => {
          completeFirst = resolve;
        }),
        terminate() {}
      };
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|comment applied\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate the current bug batch.",
        mode: "validate-only"
      })
    });
    const sessionId = started.body.job.id;

    const commented = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "comment",
        details:
          "Keep every validated outcome attached to the existing pull request."
      })
    });
    assert.equal(commented.response.status, 202);
    assert.equal(commented.body.queued, true);
    assert.equal(commented.body.job.inputCount, 1);
    assert.equal(commented.body.job.pendingInputCount, 1);

    for (const stage of FIXLAB_STAGES) {
      firstOutput("stdout", `FIXLAB_STAGE|${stage}|passed|initial result\n`);
    }
    completeFirst({ code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = await jsonRequest(url, "/api/job");
    assert.equal(completed.body.job.status, "passed");
    assert.equal(completed.body.job.pendingInputCount, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, true);
    assert.equal(calls[1].sessionId, sessionId);
    assert.match(calls[1].prompt, /existing pull request/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("same-repository API-only authentication invalidates proof when its portal adapter changes", async () => {
  const repository = createRepository();
  const profile = validProfile();
  profile.applications.backend = { workingDirectory: ".", command: "dotnet run",
    port: 50443, healthUrl: "https://localhost:50443/protected" };
  Object.assign(profile.browserAutomation, { mode: "api", testCommand: "node api-tests.mjs",
    apiAuthentication: { role: "portal", scope: "api://fixture/read",
      url: "https://localhost:50443/protected", sessionHelper: "session.mjs" },
    authentication: { required: true, command: "node -e \"process.exit(0)\"",
      proofCommand: "node -e \"process.exit(0)\"", statusPaths: [".auth/api-ready.json"] } });
  Object.assign(profile.browserAutomation.dataSafety, {
    allowedOrigins: ["https://localhost:50443"], allowedMethods: ["GET"]
  });
  Object.assign(profile.browserAutomation.testSynthesis, {
    defaultDataSource: "non-production-read-only", mutationMode: "none"
  });
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  writeFileSync(join(repository, "session.mjs"), "export async function withApiToken() {}");
  mkdirSync(join(repository, ".auth"));
  writeFileSync(join(repository, ".auth", "api-ready.json"), '{"syntheticFixture":true}');
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("Authentication must not start a job.");
  });
  try {
    const started = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(started.response.status, 202);
    let status;
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
    } while (status.body.running && Date.now() < deadline);
    assert.equal(status.body.ready, true, JSON.stringify(status.body));
    writeFileSync(join(repository, "session.mjs"), "export async function withApiToken() { return; }");
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.ready, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard checks and starts repository-owned Playwright authentication", async () => {
  const repository = createRepository();
  let receivedPrompt = "";
  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  writeFileSync(
    profilePath,
    JSON.stringify(validProfile({
      name: "Playwright authentication repository",
      browserAutomation: {
        workingDirectory: ".",
        package: "@playwright/test",
        browser: "chromium",
        testCommand: "npm run test:e2e",
        testSynthesis: {
          enabled: true,
          defaultDataSource: "synthetic-intercepted",
          mutationMode: "intercepted",
          requireScenarioEvidence: true
        },
        authentication: {
          required: true,
          command: "node playwright-auth.js",
          statusPaths: ["e2e/.auth/user.json"]
        },
        dataSafety: {
          policy: "Use mocked data and intercept mutations.",
          productionAllowed: false
        }
      }
    }))
  );
  writeFileSync(
    join(repository, "playwright-auth.js"),
    'const fs = require("node:fs"); fs.mkdirSync("e2e/.auth", { recursive: true }); fs.writeFileSync("e2e/.auth/user.json", "{}");'
  );
  const screenshotDirectory = join(
    repository,
    "test-results"
  );
  const screenshot = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const video = Buffer.from("webm-video-evidence");
  const { dashboard, url } = await startDashboard(
    repository,
    ({ prompt }) => {
      receivedPrompt = prompt;
      return { completion: new Promise(() => {}), terminate() {} };
    },
    undefined,
    { browserOwnership: () => null }
  );

  try {
    const initial = await jsonRequest(url, "/api/playwright/status");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.configured, true);
    assert.equal(initial.body.ready, false);

    const started = await jsonRequest(url, "/api/playwright/connect", {
      method: "POST"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.started, true);

    let status;
    const authenticationDeadline = Date.now() + 10000;
    while (Date.now() < authenticationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
      if (!status.body.running) {
        break;
      }
    }
    assert.equal(status.body.ready, false, "a helper exit and state file are not authenticated browser proof");
    assert.equal(status.body.statePresent, true);
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    mkdirSync(join(repository, "e2e", ".edge-profile"));
    profile.browserAutomation.authentication.statusPaths.push("e2e/.edge-profile");
    profile.browserAutomation.authentication.proofCommand =
      "node -e \"require('node:fs').writeFileSync('e2e/.edge-profile/browser-lock', 'owned')\"";
    writeFileSync(profilePath, JSON.stringify(profile));
    assert.equal((await jsonRequest(url, "/api/playwright/connect", { method: "POST" })).response.status, 202);
    const proofDeadline = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
    } while (status.body.running && Date.now() < proofDeadline);
    assert.equal(status.body.ready, true, JSON.stringify(status.body));
    assert.equal(status.body.lastResult.ok, true);
    assert.equal(status.body.paths[0].path, "e2e/.auth/user.json");
    assert.equal(status.body.paths[1].path, "e2e/.edge-profile");
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.ready, true,
      "browser-profile directory metadata changes do not invalidate an unchanged state file");
    writeFileSync(join(repository, "e2e", ".auth", "user.json"), "{}\n");
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.ready, false,
      "changed browser-state metadata invalidates the existing proof");
    profile.browserAutomation.authentication.proofCommand = "node -e \"process.exit(7)\"";
    writeFileSync(profilePath, JSON.stringify(profile));
    assert.equal((await jsonRequest(url, "/api/playwright/connect", { method: "POST" })).response.status, 202);
    const failedProofDeadline = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
    } while (status.body.running && Date.now() < failedProofDeadline);
    assert.equal(status.body.ready, false);
    assert.equal(status.body.lastResult.ok, false);

    profile.browserAutomation.authentication.statusPaths = ["e2e/.edge-profile"];
    profile.browserAutomation.authentication.proofCommand = "node -e \"process.exit(0)\"";
    writeFileSync(profilePath, JSON.stringify(profile));
    assert.equal((await jsonRequest(url, "/api/playwright/connect", { method: "POST" })).response.status, 202);
    const directoryOnlyDeadline = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
    } while (status.body.running && Date.now() < directoryOnlyDeadline);
    assert.equal(status.body.ready, false, "profile-directory existence cannot replace a regular status file");
    assert.match(status.body.lastResult.message, /at least one regular status file/);
    profile.browserAutomation.authentication.statusPaths = ["e2e/.auth/user.json", "e2e/.edge-profile"];
    writeFileSync(profilePath, JSON.stringify(profile));

    writeFileSync(join(repository, "auth-failure.cjs"),
      "process.stderr.write('Error: No tests found; private-auth-output-sentinel'); process.exitCode = 1;");
    profile.browserAutomation.authentication.command = "node auth-failure.cjs";
    writeFileSync(profilePath, JSON.stringify(profile));
    assert.equal((await jsonRequest(url, "/api/playwright/connect", { method: "POST" })).response.status, 202);
    const diagnosticDeadline = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/playwright/status");
    } while (status.body.running && Date.now() < diagnosticDeadline);
    assert.equal(status.body.running, false, "failed authentication must settle");
    assert.equal(status.body.ready, false);
    assert.equal(status.body.lastResult.reason, "configuration-error");
    assert.match(status.body.lastResult.message, /configured working directory/u);
    assert.equal(compactControlResult(status.body).lastResult.reason, "configuration-error");
    assert.doesNotMatch(JSON.stringify(status.body), /private-auth-output-sentinel/u);
    assert.doesNotMatch(JSON.stringify((await jsonRequest(url, "/api/status")).body),
      /private-auth-output-sentinel/u);
    profile.browserAutomation.authentication.command = "node playwright-auth.js";
    writeFileSync(profilePath, JSON.stringify(profile));

    const job = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Capture browser evidence.",
        requestType: "bug-fix",
        mode: "playwright-only",
        recordPlaywrightVideo: true
      })
    });
    assert.equal(job.response.status, 202);
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.ready, false,
      "a different job must obtain its own browser proof");
    assert.equal(job.body.job.recordPlaywrightVideo, true);
    mkdirSync(screenshotDirectory, { recursive: true });
    writeFileSync(
      join(screenshotDirectory, "hold-option.png"),
      screenshot
    );
    writeFileSync(
      join(screenshotDirectory, "hold-option.webm"),
      video
    );
    const nestedDirectory = join(screenshotDirectory, "nested-journey");
    mkdirSync(nestedDirectory);
    writeFileSync(join(nestedDirectory, "nested-proof.png"), screenshot);
    const flowDirectory = join(screenshotDirectory, "latest-flow");
    mkdirSync(flowDirectory);
    const capturedAt = Date.now() / 1000 + 1;
    for (const [index, name] of [
      "01-search.png", "02-input-preview.png", "03-verified-result.png"
    ].entries()) {
      const path = join(flowDirectory, name);
      writeFileSync(path, screenshot);
      utimesSync(path, capturedAt + index / 10, capturedAt + index / 10);
    }
    const artifacts = await jsonRequest(
      url,
      `/api/playwright/artifacts?jobId=${job.body.job.id}`
    );
    assert.equal(artifacts.response.status, 200);
    assert.equal(artifacts.body.artifacts.length, 6);
    assert.deepEqual(artifacts.body.artifacts.slice(0, 3).map((artifact) => artifact.name), [
      "01-search.png", "02-input-preview.png", "03-verified-result.png"
    ]);
    const imageArtifact = artifacts.body.artifacts.find(
      (artifact) => artifact.name === "hold-option.png"
    );
    const videoArtifact = artifacts.body.artifacts.find(
      (artifact) => artifact.name === "hold-option.webm"
    );
    assert.equal(imageArtifact.kind, "image");
    assert.equal(videoArtifact.kind, "video");
    assert.equal(videoArtifact.mimeType, "video/webm");
    assert.ok(
      artifacts.body.artifacts.some((artifact) =>
        /test-results[\\/]nested-journey[\\/]nested-proof\.png/u.test(
          artifact.relativePath
        )
      )
    );
    assert.match(
      imageArtifact.relativePath,
      /test-results[\\/]hold-option\.png/
    );
    const image = await fetch(
      `${url}${imageArtifact.url}`
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), screenshot);
    const recording = await fetch(`${url}${videoArtifact.url}`);
    assert.equal(recording.status, 200);
    assert.equal(recording.headers.get("content-type"), "video/webm");
    assert.deepEqual(Buffer.from(await recording.arrayBuffer()), video);
    const partialRecording = await fetch(`${url}${videoArtifact.url}`, {
      headers: { Range: "bytes=0-3" }
    });
    assert.equal(partialRecording.status, 206);
    assert.equal(
      partialRecording.headers.get("content-range"),
      `bytes 0-3/${video.length}`
    );
    assert.deepEqual(
      Buffer.from(await partialRecording.arrayBuffer()),
      video.subarray(0, 4)
    );
    assert.match(receivedPrompt, /Record Playwright video evidence: yes/);
    assert.match(receivedPrompt, /Save the recording as WebM or MP4/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("blocked live-test resumes wait until authentication releases the browser profile", async () => {
  const repository = createRepository();
  const profile = validProfile();
  profile.browserAutomation.authentication = {
    required: true,
    command: "node auth-holder.js",
    statusPaths: ["auth-ready.json"]
  };
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(profile)
  );
  writeFileSync(join(repository, "auth-ready.json"), "{}");
  writeFileSync(
    join(repository, "auth-holder.js"),
    'const fs = require("node:fs"); setInterval(() => { if (fs.existsSync("auth-finished")) process.exit(0); }, 20);'
  );
  let executions = 0;
  const { dashboard, url } = await startDashboard(repository, ({ onOutput }) => {
    executions += 1;
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|${stage === "live-test" ? "blocked" : "passed"}|Fixture evidence\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  const input = (action) => jsonRequest(url, "/api/job/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, details: "Retry only the blocked browser gate." })
  });
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Check browser ownership before a live-test retry.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    let job;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      job = await jsonRequest(url, "/api/job");
      if (job.body.job.status === "blocked" && job.body.job.canResume) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(job.body.job.status, "blocked");
    assert.equal(executions, 1);
    const connected = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(connected.response.status, 202);
    for (const action of ["retry", "continue", "comment"]) {
      const rejected = await input(action);
      assert.equal(rejected.response.status, 409);
      assert.match(rejected.body.error, /Authentication is still running.*browser profile/);
    }
    assert.equal(executions, 1);
    const unchanged = await jsonRequest(url, "/api/job");
    assert.equal(unchanged.body.job.inputCount, 0);
    writeFileSync(join(repository, "auth-finished"), "");
    let authentication;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      authentication = await jsonRequest(url, "/api/playwright/status");
      if (!authentication.body.running) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(authentication.body.running, false);
    assert.equal(authentication.body.lastResult.ok, true);
    const resumed = await input("retry");
    assert.equal(resumed.response.status, 202);
    assert.equal(executions, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

async function checkFrontendCleanup(cleanup) {
  const repository = createRepository();
  const port = await availablePort();
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(
      validProfile({
        applications: {
          frontend: {
            workingDirectory: ".",
            command: "node frontend-launcher.js",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      })
    )
  );
  writeFileSync(
    join(repository, "frontend.js"),
    `require("node:http").createServer((q, s) => s.end(process.env.BROWSER ?? "unset")).listen(${port}, "127.0.0.1");`
  );
  writeFileSync(
    join(repository, "frontend-launcher.js"),
    `require("node:child_process").spawn(process.execPath, ["frontend.js"], { stdio: "inherit", detached: process.platform === "win32" }); process.exit(0);`
  );
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  const observer = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));

  try {
    const initial = await jsonRequest(url, "/api/frontend/status");
    assert.equal(initial.body.configured, true);
    assert.equal(initial.body.healthy, false);

    const started = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.started, true);

    let status;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await jsonRequest(url, "/api/frontend/status");
      if (status.body.healthy) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.body.healthy, true);
    assert.equal(status.body.owned, true);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "none");

    const again = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(again.response.status, 409);
    const conflict = await jsonRequest(observer.url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(conflict.response.status, 409);
    const ownerId = conflict.body.owner.id;

    if (cleanup === "close") {
      await dashboard.close();
    } else {
      const stopped = await jsonRequest(observer.url, "/api/sessions/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId,
          resource: "frontend",
          action: "stop",
          confirmed: true
        })
      });
      assert.equal(stopped.response.status, 202);
    }
    let healthy = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(1000)
        });
        await response.body?.cancel();
      } catch (error) {
        if (["ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)) {
          continue;
        }
        assert.equal(error.cause?.code, "ECONNREFUSED");
        healthy = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, false);
  } finally {
    await dashboard.close();
    await observer.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
}

test("dashboard starts, reuses and stops the profile-defined frontend", async () => {
  await checkFrontendCleanup("stop");
});

test("dashboard shutdown stops the frontend process tree", async () => {
  await checkFrontendCleanup("close");
});

test("managed frontend input stays open when EOF requests application shutdown", async () => {
  const repository = createRepository();
  const port = await availablePort();
  const profile = validProfile();
  profile.applications.frontend = {
    workingDirectory: ".",
    command: "node frontend-eof.js",
    port,
    healthUrl: `http://127.0.0.1:${port}`
  };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  writeFileSync(join(repository, "frontend-eof.js"), [
    `const server = require("node:http").createServer((q, s) => s.end("ready")).listen(${port}, "127.0.0.1");`,
    'process.stdin.on("end", () => server.close(() => process.exit(0)));',
    "process.stdin.resume();"
  ].join("\n"));
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  try {
    const started = await jsonRequest(url, "/api/frontend/start", { method: "POST" });
    assert.equal(started.response.status, 202);
    let status;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await jsonRequest(url, "/api/frontend/status");
      if (status.body.healthy || !status.body.running) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.body.healthy, true, JSON.stringify(status.body));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await jsonRequest(url, "/api/frontend/status")).body.healthy, true);
    const stopped = await jsonRequest(url, "/api/frontend/stop", { method: "POST" });
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.body.stopped, true);
    assert.equal(stopped.body.running, false);
    assert.equal(stopped.body.healthy, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard does not restart a frontend that is already healthy", async () => {
  const repository = createRepository();
  const port = await availablePort();
  writeFileSync(
    join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(
      validProfile({
        applications: {
          frontend: {
            workingDirectory: ".",
            command: "node does-not-exist.js",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      })
    )
  );
  const external = await new Promise((resolve) => {
    const instance = createHttpServer((request, response) =>
      response.end("ok")
    );
    instance.listen(port, "127.0.0.1", () => resolve(instance));
  });
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));

  try {
    const result = await jsonRequest(url, "/api/frontend/start", {
      method: "POST"
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.started, false);
    assert.equal(result.body.healthy, true);
    assert.equal(result.body.owned, false);
    const stopped = await jsonRequest(url, "/api/frontend/stop", {
      method: "POST"
    });
    assert.equal(stopped.body.stopped, false);
    assert.equal(stopped.body.healthy, true);
  } finally {
    await dashboard.close();
    await new Promise((resolve) => external.close(resolve));
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const scenario of [
  { environment: "local", prestartFrontend: true, warm: true },
  { environment: "LOCAL", prestartFrontend: true, warm: true },
  { environment: "local", prestartFrontend: false, warm: false },
  { environment: "dev", prestartFrontend: true, warm: false }
]) {
  test(`React warm-up is parallel and environment-bound (${scenario.environment}, ${scenario.prestartFrontend})`, async () => {
    const repository = createRepository();
    const port = await availablePort();
    writeFileSync(
      join(repository, ".github", "fixlab", "repository-profile.json"),
      JSON.stringify(validProfile({
        environments: scenario.environment === "LOCAL" ? ["LOCAL", "dev", "sit"] : ["local", "dev", "sit"],
        applications: {
          frontend: {
            command: "node frontend.js",
            workingDirectory: ".",
            port,
            healthUrl: `http://127.0.0.1:${port}`
          }
        }
      }))
    );
    writeFileSync(
      join(repository, "frontend.js"),
      `setTimeout(() => require("node:http").createServer((q, s) => s.end(process.env.BROWSER ?? "unset")).listen(${port}, "127.0.0.1"), 500);`
    );
    let invocation;
    const { dashboard, url } = await startDashboard(repository, (input) => {
      invocation = input;
      return { completion: new Promise(() => {}), terminate() {} };
    });
    try {
      const result = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: "Warm the local app while diagnosing.",
          requestType: "bug-fix",
          mode: "validate-only",
          targetEnvironment: scenario.environment,
          prestartFrontend: scenario.prestartFrontend
        })
      });
      assert.equal(result.response.status, 202);
      assert.ok(invocation, "the agent must start before React finishes compilation");
      if (scenario.warm) {
        assert.match(invocation.prompt, /healthy baseline server does not prove the fix/);
        let healthy = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const status = await jsonRequest(url, "/api/frontend/status");
          healthy = status.body.healthy;
          if (healthy) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(healthy, true);
        assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "none");
        const job = await jsonRequest(url, "/api/job");
        assert.equal(job.body.job.status, "running");
        assert.equal(job.body.job.stages["local-stack"].status, "pending");
        assert.ok(job.body.job.logs.some((entry) => /warm-up started in parallel/.test(entry.message)));
      } else {
        const session = await jsonRequest(url, "/api/session");
        assert.equal(session.body.frontend.running, false);
        assert.doesNotMatch(invocation.prompt, /React warm-up is requested/);
      }
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("zero exit with missing terminal markers fails as incomplete", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    onOutput("stderr", "original validation error\n");
    onOutput("stdout", "FIXLAB_STAGE|intake|passed|request accepted\n");
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Validate the request.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(result.body.job.status, "failed");
    assert.match(result.body.job.error, /Incomplete stage markers/);
    assert.equal(
      result.body.job.logs.some(
        (entry) => entry.message === "original validation error"
      ),
      true
    );
    assert.equal(result.body.job.stages.diagnosis.status, "pending");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("restarting a failed job advances the waiting queue without changing FIFO order", async () => {
  const repository = createRepository();
  const executions = [];
  const executor = () => {
    let complete;
    const completion = new Promise((resolve) => { complete = resolve; });
    executions.push({ complete });
    return { completion, terminate() { complete({ code: 1 }); } };
  };
  const { dashboard, url } = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  try {
    const first = await post("/api/jobs", {
      request: "Synthetic first job that fails.", mode: "validate-only"
    });
    const second = await post("/api/jobs", {
      request: "Synthetic oldest waiting job.", mode: "validate-only"
    });
    const third = await post("/api/jobs", {
      request: "Synthetic later waiting job.", mode: "validate-only"
    });
    executions[0].complete({ code: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await jsonRequest(url, "/api/status");
    assert.equal(failed.body.job.status, "failed");
    assert.equal(executions.length, 1, "failure must not automatically release waiting jobs");

    const restarted = await post("/api/jobs/restart", { jobId: first.body.job.id });
    assert.equal(restarted.response.status, 202, restarted.body.error);
    assert.equal(restarted.body.job?.id, second.body.queuedJob.id);
    assert.equal(restarted.body.job.status, "running");
    assert.equal(executions.length, 2);
    assert.deepEqual(restarted.body.queue.map((job) => job.id), [
      third.body.queuedJob.id, restarted.body.restartedJob.id
    ]);
    assert.equal(restarted.body.history.find((job) => job.id === first.body.job.id).status, "failed");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard queues concurrent jobs and starts the next passed job", async () => {
  const repository = createRepository();
  let resolveJob;
  let firstOutput;
  let executorCalls = 0;
  const completion = new Promise((resolve) => {
    resolveJob = resolve;
  });
  const executor = ({ onOutput }) => {
    executorCalls += 1;
    if (executorCalls === 1) {
      firstOutput = onOutput;
      return { completion, terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const invalid = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "",
        requestType: "unknown",
        mode: "unknown"
      })
    });
    assert.equal(invalid.response.status, 400);

    const invalidRequestType = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Reject this request type.",
        requestType: "feature",
        mode: "validate-only"
      })
    });
    assert.equal(invalidRequestType.response.status, 400);
    assert.match(invalidRequestType.body.error, /requestType/);

    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active.",
        requestType: "bug-fix",
        mode: "playwright-only"
      })
    });
    assert.equal(first.response.status, 202);
    assert.equal(first.body.job.mode, "playwright-only");

    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Run this job second.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(second.response.status, 202);
    assert.equal(second.body.queued, true);
    assert.equal(second.body.queue.length, 1);
    assert.equal(second.body.queue[0].position, 1);
    assert.equal(second.body.queue[0].status, "queued");
    assert.equal(second.body.queue[0].mode, "validate-only");
    assert.deepEqual(
      Object.keys(second.body.queue[0].stages),
      FIXLAB_STAGES
    );

    for (const stage of FIXLAB_STAGES) {
      firstOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|completed\n`
      );
    }
    resolveJob({ code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await jsonRequest(url, "/api/status");
    assert.equal(executorCalls, 2);
    assert.equal(status.body.job.request, "Run this job second.");
    assert.equal(status.body.job.status, "running");
    assert.deepEqual(status.body.queue, []);
    assert.equal(status.body.history.length, 1);
    assert.equal(status.body.history[0].request, "Keep this job active.");
    assert.equal(status.body.history[0].status, "passed");
    assert.deepEqual(
      Object.values(status.body.history[0].stages).map(
        (stage) => stage.status
      ),
      FIXLAB_STAGES.map(() => "passed")
    );
    assert.deepEqual(status.body.history[0].logs, []);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard cancels waiting jobs without interrupting the active job", async () => {
  const repository = createRepository();
  let executorCalls = 0;
  const executor = () => {
    executorCalls += 1;
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const active = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Cancel this waiting job by position.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const third = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Cancel this waiting job by ID.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    const secondId = second.body.queuedJob.id;
    const thirdId = third.body.queuedJob.id;

    const activeRejected = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: active.body.job.id })
    });
    assert.equal(activeRejected.response.status, 404);
    assert.match(activeRejected.body.error, /queued/);

    const invalidPosition = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 99 })
    });
    assert.equal(invalidPosition.response.status, 400);

    const cancelledSecond = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 1 })
    });
    assert.equal(cancelledSecond.response.status, 202);
    assert.equal(cancelledSecond.body.job.id, active.body.job.id);
    assert.equal(cancelledSecond.body.job.status, "running");
    assert.equal(cancelledSecond.body.cancelledJob.id, secondId);
    assert.equal(cancelledSecond.body.cancelledJob.status, "cancelled");
    assert.equal(cancelledSecond.body.queue.length, 1);
    assert.equal(cancelledSecond.body.queue[0].id, thirdId);
    assert.equal(cancelledSecond.body.queue[0].position, 1);
    assert.equal(cancelledSecond.body.history[0].id, secondId);

    const cancelledThird = await jsonRequest(url, "/api/jobs/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: thirdId })
    });
    assert.equal(cancelledThird.response.status, 202);
    assert.equal(cancelledThird.body.cancelledJob.id, thirdId);
    assert.deepEqual(cancelledThird.body.queue, []);
    assert.equal(executorCalls, 1);

    const metrics = await jsonRequest(url, "/api/metrics?period=all");
    assert.equal(metrics.body.metrics.cancelled, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard holds queued and active jobs and resumes the same session", async () => {
  const repository = createGitRepository();
  const executions = [];
  const executor = (options) => {
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const execution = {
      options,
      resolveCompletion,
      terminate() {
        resolveCompletion({ code: null, signal: "SIGTERM" });
      }
    };
    executions.push(execution);
    return {
      completion,
      terminate: execution.terminate
    };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Hold the active lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Hold the queued lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const firstId = first.body.job.id;
    const firstSessionId = executions[0].options.sessionId;
    const secondId = second.body.queuedJob.id;

    const heldQueued = await jsonRequest(url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: secondId })
    });
    assert.equal(heldQueued.response.status, 202);
    assert.equal(heldQueued.body.heldJob.status, "held");
    assert.deepEqual(
      heldQueued.body.held.map((job) => job.id),
      [secondId]
    );

    const historyPath = join(
      dirname(createCacheContext(repository).cachePath),
      "dashboard-jobs.json"
    );
    const persisted = JSON.parse(readFileSync(historyPath, "utf8"));
    const persistedHeldJob = persisted.jobs.find(
      (job) => job.id === secondId
    );
    assert.equal(persistedHeldJob.status, "held");

    const resumedQueued = await jsonRequest(url, "/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: secondId })
    });
    assert.equal(resumedQueued.response.status, 202);
    assert.deepEqual(
      resumedQueued.body.queue.map((job) => job.id),
      [secondId]
    );

    executions[0].options.onOutput(
      "stdout",
      'FIXLAB_SUMMARY|{"problem":"Removal fails","rootCause":"Missing operation","codeFix":"Retained correction"}\n'
    );
    executions[0].options.onOutput(
      "stdout",
      "FIXLAB_STAGE|intake|passed|Intake retainedFIXLAB_ACTIVITY|diagnosis|Retain partial output"
    );
    const holding = await jsonRequest(url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: firstId })
    });
    assert.equal(holding.response.status, 202);
    assert.equal(holding.body.job.status, "holding");

    for (
      let attempt = 0;
      attempt < 20 && executions.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(executions.length, 2);
    const activeAfterHold = await jsonRequest(url, "/api/status");
    assert.equal(activeAfterHold.body.job.id, secondId);
    assert.deepEqual(
      activeAfterHold.body.held.map((job) => job.id),
      [firstId]
    );
    assert.deepEqual(activeAfterHold.body.held[0].stages.intake, {
      status: "passed",
      message: "Intake retained"
    });
    assert.equal(activeAfterHold.body.held[0].canResume, true);

    const resumedActive = await jsonRequest(url, "/api/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: firstId })
    });
    assert.equal(resumedActive.response.status, 202);
    assert.deepEqual(
      resumedActive.body.queue.map((job) => job.id),
      [firstId]
    );
    assert.equal(resumedActive.body.queue[0].engineeringSummary.codeFix, "Retained correction");
    assert.equal(resumedActive.body.queue[0].engineeringSummaryOrigin, "agent-reported");
    const reloaded = await jsonRequest(url, "/api/status");
    assert.equal(reloaded.body.queue[0].engineeringSummary.codeFix, "Retained correction");

    for (const stage of FIXLAB_STAGES) {
      executions[1].options.onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
      );
    }
    executions[1].resolveCompletion({ code: 0 });

    for (
      let attempt = 0;
      attempt < 20 && executions.length < 3;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(executions.length, 3);
    assert.equal(executions[2].options.resume, true);
    assert.equal(executions[2].options.sessionId, firstSessionId);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restores held jobs after restart", async () => {
  const repository = createGitRepository();
  const first = await startDashboard(repository, () => ({
    completion: new Promise(() => {}),
    terminate() {}
  }));
  let heldJobId;

  try {
    await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active during dashboard restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const queued = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restore this held job after dashboard restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    heldJobId = queued.body.queuedJob.id;
    const held = await jsonRequest(first.url, "/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: heldJobId })
    });
    assert.equal(held.response.status, 202);
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring held jobs");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.deepEqual(
      status.body.held.map((job) => job.id),
      [heldJobId]
    );
    assert.equal(status.body.held[0].status, "held");
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restarts a completed job with a new id and session", async () => {
  const repository = createGitRepository();
  const executions = [];
  const executor = (options) => {
    executions.push(options);
    if (executions.length === 1) {
      options.onOutput("stdout",
        'FIXLAB_SUMMARY|{"problem":"Original bug","rootCause":"Original cause","codeFix":"Original correction"}\n');
      for (const stage of FIXLAB_STAGES) {
        options.onOutput(
          "stdout",
          `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`
        );
      }
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restart this completed lifecycle job.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const originalId = started.body.job.id;
    const originalSessionId = executions[0].sessionId;
    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await jsonRequest(url, "/api/status");
      if (status.body.job?.status === "passed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.status, "passed");

    const restarted = await jsonRequest(url, "/api/jobs/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: originalId })
    });
    assert.equal(restarted.response.status, 202);
    assert.notEqual(restarted.body.job.id, originalId);
    assert.notEqual(executions[1].sessionId, originalSessionId);
    assert.equal(restarted.body.job.status, "running");
    assert.equal(restarted.body.history[0].id, originalId);
    assert.equal(restarted.body.job.engineeringSummary, null);
    assert.equal(restarted.body.job.engineeringSummaryOrigin, null);
    assert.equal(restarted.body.history[0].engineeringSummary.codeFix, "Original correction");
    assert.equal(
      restarted.body.job.request,
      "Restart this completed lifecycle job."
    );
    assert.equal(executions[1].resume, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard purges only terminal history older than the selected age", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} completed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let oldJobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Create purgeable history.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    oldJobId = started.body.job.id;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await jsonRequest(first.url, "/api/status");
      if (status.body.job?.status === "passed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await first.dashboard.close();
  }

  const historyPath = join(
    dirname(createCacheContext(repository).cachePath),
    "dashboard-jobs.json"
  );
  const persisted = JSON.parse(readFileSync(historyPath, "utf8"));
  const oldJob = persisted.jobs.find((job) => job.id === oldJobId);
  oldJob.finishedAt = "2020-01-01T00:00:00.000Z";
  const heldJobId = "11111111-2222-4333-8444-555555555555";
  persisted.jobs.push({
    ...oldJob,
    id: heldJobId,
    sessionId: heldJobId,
    request: "Never purge this held job.",
    status: "held",
    startedAt: null,
    heldAt: "2020-01-01T00:00:00.000Z",
    finishedAt: null
  });
  writeFileSync(historyPath, JSON.stringify(persisted, null, 2));

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while purging history");
  });
  try {
    const invalid = await jsonRequest(second.url, "/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays: 0 })
    });
    assert.equal(invalid.response.status, 400);

    const purged = await jsonRequest(second.url, "/api/history/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays: 30 })
    });
    assert.equal(purged.response.status, 200);
    assert.equal(purged.body.deleted, 1);
    assert.equal(purged.body.history.length, 0);
    assert.equal(purged.body.job, null);
    assert.equal(purged.body.queue.length, 0);
    assert.deepEqual(
      purged.body.held.map((job) => job.id),
      [heldJobId]
    );
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard dismisses a failed job and starts the next queued job", async () => {
  const repository = createRepository();
  let executorCalls = 0;
  const executor = () => {
    executorCalls += 1;
    if (executorCalls === 1) {
      return {
        completion: Promise.resolve({ code: 1 }),
        terminate() {}
      };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const first = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "This failed job should remain in history.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(first.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await jsonRequest(url, "/api/job");
    assert.equal(failed.body.job.status, "failed");

    const second = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Start this queued job after dismissal.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    assert.equal(second.response.status, 202);
    assert.equal(second.body.queued, true);

    const dismissed = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(dismissed.response.status, 202, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.dismissedJob.status, "failed");
    assert.equal(dismissed.body.job.request, "Start this queued job after dismissal.");
    assert.equal(dismissed.body.job.status, "running");
    assert.deepEqual(dismissed.body.queue, []);
    assert.equal(dismissed.body.history[0].status, "failed");
    assert.equal(executorCalls, 2);

    const rejected = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.body.error, /still running/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard persists privacy-safe token and duration metrics", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "Token budget remains enabled.\n");
    onOutput("stdout", "Example only: Tokens \u2191 1 (0 cached, 0 written) \u2022 \u2193 0; not a runtime meter.\n");
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
    }
    onOutput(
      "stdout",
      "Tokens ↑ 2.4m (1.9m cached, 367.4k written) • ↓ 14.8k\n"
    );
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Private request text must not persist.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });

    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const metrics = await jsonRequest(
      first.url,
      "/api/metrics?period=24h"
    );
    assert.equal(metrics.body.metrics.queued, 1);
    assert.equal(metrics.body.metrics.completed, 1);
    assert.equal(metrics.body.metrics.totalInputTokens, 2_400_000);
    assert.equal(metrics.body.metrics.totalCachedInputTokens, 1_900_000);
    assert.equal(metrics.body.metrics.totalCacheWriteTokens, 367_400);
    assert.equal(metrics.body.metrics.totalOutputTokens, 14_800);
    assert.equal(metrics.body.metrics.cacheReusePercent, 79.2);
    const status = await jsonRequest(first.url, "/api/status");
    const messages = status.body.job.logs.map((entry) => entry.message);
    assert.ok(messages.includes("Token budget remains enabled."));
    assert.ok(messages.some((message) => message.startsWith("Example only: Tokens")));
    assert.equal(messages.some((message) => /^\s*Tokens\s+\u2191/.test(message)), false);

    const context = createCacheContext(repository);
    const metricsPath = join(
      dirname(context.cachePath),
      "dashboard-metrics.json"
    );
    const persisted = readFileSync(metricsPath, "utf8");
    assert.doesNotMatch(persisted, /Private request text/);
    assert.doesNotMatch(persisted, /comments|screenshots|logs/);
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while reading metrics");
  });
  try {
    const metrics = await jsonRequest(
      second.url,
      "/api/metrics?period=all"
    );
    assert.equal(metrics.body.metrics.queued, 1);
    assert.equal(metrics.body.metrics.completed, 1);
    assert.equal(metrics.body.metrics.cacheReusePercent, 79.2);
  } finally {
    await second.dashboard.close();
  }

  rmSync(repository, { recursive: true, force: true });
});

test("dashboard dismisses a blocked job and continues the queue", async () => {
  const repository = createGitRepository();
  let executorCalls = 0;
  const executor = ({ onOutput }) => {
    executorCalls += 1;
    if (executorCalls === 1) {
      for (const stage of FIXLAB_STAGES.slice(0, -1)) {
        onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
      }
      onOutput(
        "stdout",
        "FIXLAB_STAGE|pr|blocked|Approval is required before creating the pull request.\n"
      );
      return { completion: Promise.resolve({ code: 0 }), terminate() {} };
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    const post = (request) =>
      jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request,
          requestType: "bug-fix",
          mode: "validate-only"
        })
      });
    await post("This job ends blocked.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await jsonRequest(url, "/api/job")).body.job.status, "blocked");

    const queued = await post("This job waits behind the blocked one.");
    assert.equal(queued.body.queued, true);

    const dismissed = await jsonRequest(url, "/api/job/dismiss", {
      method: "POST"
    });
    assert.equal(dismissed.response.status, 202, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.dismissedJob.status, "blocked");
    assert.equal(dismissed.body.job.request, "This job waits behind the blocked one.");
    assert.equal(dismissed.body.job.status, "running");
    assert.equal(dismissed.body.history[0].status, "blocked");
    assert.equal(executorCalls, 2);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard restores private job summaries and PR readiness after restart", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "Tokens \u2191 625696 (543174 cached, 82498 written) \u2022 \u2193 2384\n");
    onOutput(
      "stdout",
      "FIXLAB_BUG|17032997|fixed|application|The focused source correction is complete.\n"
    );
    for (const stage of FIXLAB_STAGES.slice(0, -1)) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|completed\n`);
    }
    onOutput(
      "stdout",
      "FIXLAB_STAGE|pr|blocked|Approval is required before creating the pull request.\n"
    );
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Azure DevOps Bug 17032997: Persist this bug",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);
    jobId = started.body.job.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await jsonRequest(first.url, "/api/status");
    assert.equal(status.body.job.status, "blocked");
    assert.equal(
      status.body.job.pullRequestReadiness.status,
      "blocked"
    );
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring dashboard history");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.bugs[0].id, "17032997");
    assert.deepEqual(status.body.job.usage, {
      inputTokens: 625696,
      cachedInputTokens: 543174,
      cacheWriteTokens: 82498,
      outputTokens: 2384,
      cacheReusePercent: 86.8
    });
    assert.equal(
      status.body.job.pullRequestReadiness.status,
      "blocked"
    );

    const context = createCacheContext(repository);
    const historyPath = join(
      dirname(context.cachePath),
      "dashboard-jobs.json"
    );
    const persisted = readFileSync(historyPath, "utf8");
    assert.match(persisted, /Persist this bug/);
    assert.doesNotMatch(
      persisted,
      /logs|screenshots|authentication|source content/
    );
  } finally {
    await second.dashboard.close();
  }

  const historyPath = join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json");
  const legacyHistory = JSON.parse(readFileSync(historyPath, "utf8"));
  delete legacyHistory.jobs.find((job) => job.id === jobId).usage;
  writeFileSync(historyPath, JSON.stringify(legacyHistory));
  let resumedUsage;
  const third = await startDashboard(repository, ({ usage, onOutput }) => {
    resumedUsage = usage;
    onOutput("stdout", "Tokens \u2191 625796 (543174 cached, 82498 written) \u2022 \u2193 2394\n");
    onOutput("stdout", "FIXLAB_STAGE|pr|blocked|Approval remains required.\n");
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  try {
    const restored = await jsonRequest(third.url, "/api/status");
    assert.equal(restored.body.job.usage.inputTokens, 625696);
    const resumed = await jsonRequest(third.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue", details: "Continue the same synthetic test job without approving publication." })
    });
    assert.equal(resumed.response.status, 202);
    assert.deepEqual(resumedUsage, restored.body.job.usage);
    const status = await jsonRequest(third.url, "/api/status");
    assert.equal(status.body.job.usage.inputTokens, 625796);
    assert.equal(status.body.job.usage.outputTokens, 2394);
  } finally {
    await third.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard recovers an orphaned running job as failed and resumable", async () => {
  const repository = createGitRepository();
  const executor = () => ({
    completion: new Promise(() => {}),
    terminate() {}
  });
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Persist this running job before restart.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    jobId = started.body.job.id;
    await jsonRequest(first.url, "/api/status");
  } finally {
    await first.dashboard.close();
  }

  const second = await startDashboard(repository, () => {
    throw new Error("executor should not run while recovering a job");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.stages.intake.status, "failed");
    assert.match(status.body.job.error, /without an owned executor process/);
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard recovery preserves a completed manual localhost gate", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      const status =
        stage === "live-test"
          ? "blocked"
          : stage === "fix" || stage === "pr"
            ? "skipped"
            : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|${status}|${stage} completed\n`
      );
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const first = await startDashboard(repository, executor);
  let jobId;

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Retain this manual localhost gate after restart.",
        requestType: "bug-fix",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    jobId = started.body.job.id;
  } finally {
    await first.dashboard.close();
  }

  const historyPath = join(
    dirname(createCacheContext(repository).cachePath),
    "dashboard-jobs.json"
  );
  const legacyHistory = JSON.parse(readFileSync(historyPath, "utf8"));
  delete legacyHistory.jobs.find((job) => job.id === jobId)
    .manualLocalhostPending;
  writeFileSync(historyPath, JSON.stringify(legacyHistory, null, 2));

  let resumedPrompt = "";
  const second = await startDashboard(repository, ({ prompt, onOutput }) => {
    resumedPrompt = prompt;
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} resumed\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.id, jobId);
    assert.equal(status.body.job.status, "blocked");
    assert.equal(status.body.job.manualLocalhostTest, true);
    assert.equal(status.body.job.manualLocalhostPending, true);
    assert.equal(
      status.body.job.manualLocalhostUrl,
      "http://127.0.0.1:3000"
    );
    assert.equal(status.body.job.canResume, true);
    assert.equal(status.body.job.stages["live-test"].status, "blocked");
    assert.equal(status.body.job.error, null);

    const bypass = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Continue without a manual result."
      })
    });
    assert.equal(bypass.response.status, 409);
    assert.match(
      bypass.body.error,
      /explicit manual-pass or manual-fail/
    );

    const resumed = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "manual-pass" })
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.job.manualLocalhostPending, false);
    assert.equal(resumed.body.job.manualLocalhostResult, "passed");
    assert.match(resumedPrompt, /explicitly marked it passed/);
    assert.match(
      resumedPrompt,
      /Persisted manual React localhost result: passed/
    );
    assert.match(resumedPrompt, /stop only frontend processes owned by the current job/);
  } finally {
    await second.dashboard.close();
  }

  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const third = await startDashboard(repository, () => {
    throw new Error("executor should not run while restoring accepted evidence");
  });
  try {
    const restored = await jsonRequest(third.url, "/api/status");
    assert.equal(restored.body.job.status, "passed");
    assert.equal(restored.body.job.canResume, false);
    assert.equal(restored.body.job.manualLocalhostPending, false);
    assert.equal(restored.body.job.manualLocalhostResult, "passed");
    assert.equal(restored.body.job.manualLocalhostUrl, "");
  } finally {
    await third.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard disables an unsafe restored manual localhost gate", async () => {
  const repository = createGitRepository();
  const executor = ({ onOutput }) => {
    onOutput("stdout", "FIXLAB_MANUAL|localhost|pending\n");
    for (const stage of FIXLAB_STAGES) {
      const status = stage === "live-test" ? "blocked" : "passed";
      onOutput(
        "stdout",
        `FIXLAB_STAGE|${stage}|${status}|${stage} completed\n`
      );
    }
    return { completion: new Promise(() => {}), terminate() {} };
  };
  const first = await startDashboard(repository, executor);

  try {
    const started = await jsonRequest(first.url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Restore this manual localhost gate safely.",
        requestType: "bug-fix",
        mode: "validate-only",
        manualLocalhostTest: true
      })
    });
    assert.equal(started.response.status, 202);
  } finally {
    await first.dashboard.close();
  }

  const profilePath = join(
    repository,
    ".github",
    "fixlab",
    "repository-profile.json"
  );
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  profile.applications.frontend.healthUrl =
    "http://user:password@localhost:3000";
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  const second = await startDashboard(repository, () => {
    throw new Error("unsafe restored job must not resume");
  });
  try {
    const status = await jsonRequest(second.url, "/api/status");
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, false);
    assert.equal(status.body.job.manualLocalhostPending, false);
    assert.equal(status.body.job.manualLocalhostUrl, "");
    assert.doesNotMatch(JSON.stringify(status.body), /user:password/);

    const resumed = await jsonRequest(second.url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "continue",
        details: "Resume this unsafe job."
      })
    });
    assert.equal(resumed.response.status, 409);
    assert.match(resumed.body.error, /cannot be resumed safely/);
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("structured usage keeps a quiet executor active without token-meter output", async () => {
  const repository = createRepository();
  let heartbeat;
  let finish;
  let count = 0;
  const { dashboard, url } = await startDashboard(repository, ({ onUsage }) => {
    heartbeat = setInterval(() => onUsage({
      inputTokens: ++count, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0
    }), 20);
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: null, signal: "SIGTERM" }); }
    };
  }, undefined, { runtime: "copilot", executionIdleTimeoutMs: 500 });
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic quiet usage heartbeat.", mode: "validate-only" })
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    let status = await jsonRequest(url, "/api/status");
    assert.equal(status.body.job.status, "running");
    assert.ok(status.body.job.usage.inputTokens > 0);
    assert.equal(status.body.job.logs.some((entry) => /^\s*Tokens\s+\u2191/.test(entry.message)), false);
    clearInterval(heartbeat);
    for (let attempt = 0; attempt < 40 && status.body.job.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jsonRequest(url, "/api/status");
    }
    assert.equal(status.body.job.status, "failed", "idle detection still runs when usage stops");
    assert.match(status.body.job.error, /produced no output/);
  } finally {
    clearInterval(heartbeat);
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard stops an executor that exceeds the output idle timeout", async () => {
  const repository = createRepository();
  let resolveCompletion;
  let terminated = 0;
  let executorCalls = 0;
  let resumedPrompt = "";
  const executor = ({ onOutput, prompt }) => {
    executorCalls += 1;
    if (executorCalls === 2) {
      resumedPrompt = prompt;
    }
    if (executorCalls === 1) {
      onOutput("stdout", "FIXLAB_STAGE|intake|passed|Intake complete.\n");
      onOutput(
        "stdout",
        "FIXLAB_STAGE|diagnosis|passed|Diagnosis complete.\n"
      );
    }
    onOutput("stdout", "FIXLAB_STAGE|fix|running|Fix in progress.\n");
    return {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      terminate() {
        terminated += 1;
        resolveCompletion({ code: null, signal: "SIGTERM" });
      }
    };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    { executionIdleTimeoutMs: 100 }
  );

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Stop this job when the executor becomes idle.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await jsonRequest(url, "/api/status");
      if (status.body.job.status === "failed") {
        break;
      }
    }
    assert.equal(terminated, 1);
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, true);
    assert.match(status.body.job.error, /produced no output/);
    assert.ok(status.body.job.lastActivityAt);

    const resumed = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue" })
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(executorCalls, 2);
    assert.equal(resumed.body.job.status, "running");
    assert.equal(resumed.body.job.stages.intake.status, "passed");
    assert.equal(resumed.body.job.stages.diagnosis.status, "passed");
    assert.equal(resumed.body.job.stages.fix.status, "running");
    assert.match(resumedPrompt, /retained workflow state/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("idle finalization retains the atomic lease and blocks resume until executor termination", async () => {
  const repository = createGitRepository();
  let finish;
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise((resolve) => { finish = resolve; }),
    terminate() {}
  }), null, { executionIdleTimeoutMs: 25, deferTermination: true });
  const contender = createExecutorLease(repository, randomUUID());
  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Wait for confirmed termination before retrying.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    let status;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await jsonRequest(url, "/api/job");
      if (status.body.job.status === "failed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.canResume, false);
    assert.throws(() => contender.acquire("racing-retry"), /lease is reserved/);
    const resume = await jsonRequest(url, "/api/job/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Retry too soon." })
    });
    assert.equal(resume.response.status, 409);
    const instance = (await jsonRequest(url, "/api/status")).body.instanceId;
    const notes = { instanceId: instance, repository, jobId: status.body.job.id, confirmed: true,
      summary: { problem: "Removal fails", rootCause: "Missing operation", codeFix: "Reviewed correction" } };
    const importNotes = () => jsonRequest(url, "/api/job/engineering-summary", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(notes)
    });
    const unsettled = await importNotes();
    assert.equal(unsettled.response.status, 400);
    assert.match(unsettled.body.error, /settled executor/);
    finish({ code: null, signal: "SIGTERM" });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await jsonRequest(url, "/api/job");
      if (status.body.job.canResume) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.body.job.canResume, true);
    const settled = await importNotes();
    assert.equal(settled.response.status, 200, settled.body.error);
    assert.equal(settled.body.origin, "reviewed-note");
    contender.acquire("after-exit").release();
  } finally {
    finish?.({ code: null });
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard reports quiet long-running steps without resetting the idle timeout", async () => {
  const repository = createRepository();
  let resolveCompletion;
  const executor = ({ onOutput }) => {
    onOutput(
      "stdout",
      "FIXLAB_STAGE|review|running|Running the production build.\n"
    );
    return {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      terminate() {}
    };
  };
  const { dashboard, url } = await startDashboard(
    repository,
    executor,
    null,
    {
      executionHeartbeatMs: 20,
      executionIdleTimeoutMs: 500
    }
  );

  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Show progress while a quiet build runs.",
        requestType: "small-enhancement",
        mode: "fix-and-validate"
      })
    });
    const lastActivityAt = started.body.job.lastActivityAt;

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await jsonRequest(url, "/api/status");
      if (status.body.job.activity.length > 0) {
        break;
      }
    }

    assert.equal(status.body.job.status, "running");
    assert.equal(status.body.job.lastActivityAt, lastActivityAt);
    assert.equal(status.body.job.activity[0].stage, "review");
    assert.match(
      status.body.job.activity[0].message,
      /still running.*without new output/i
    );
    resolveCompletion({ code: 0 });
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard stops only the active executor when chat requests it", async () => {
  const repository = createRepository();
  let resolveCompletion;
  let terminated = 0;
  const executor = () => ({
    completion: new Promise((resolve) => {
      resolveCompletion = resolve;
    }),
    terminate() {
      terminated += 1;
      resolveCompletion({ code: null, signal: "SIGTERM" });
    }
  });
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Stop this job from terminal chat.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    const stopped = await jsonRequest(url, "/api/job/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });

    assert.equal(stopped.response.status, 202);
    assert.equal(stopped.body.stopping, true);
    assert.equal(terminated, 1);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("terminal chat sends free text to the active dashboard session", async () => {
  const requests = [];
  const job = {
    id: "job-1",
    status: "running",
    request: "Repair the defect",
    durationMs: 1000,
    pullRequestReadiness: { message: "Validation is running." },
    stages: {
      intake: { status: "running", message: "Inspecting the request." },
      pr: { status: "pending", message: "" }
    },
    logs: []
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      return new Response(JSON.stringify({ job, queued: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["Use my corporate account\n/exit\n"]),
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  });

  const submitted = requests.find(({ url }) =>
    url.endsWith("/api/job/input")
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(submitted.options.body), {
    action: "comment",
    details: "Use my corporate account"
  });
  assert.match(output, /FixLab chat is connected/);
  assert.match(output, /Guidance queued for the same session/);
});

test("terminal chat dispatches manual localhost pass and fail actions", async () => {
  const submitted = [];
  const job = {
    id: "manual-job",
    status: "blocked",
    request: "Validate React localhost",
    durationMs: 1000,
    manualLocalhostPending: true,
    pullRequestReadiness: { message: "Manual validation is pending." },
    stages: {
      "live-test": { status: "blocked", message: "Manual result required." },
      pr: { status: "skipped", message: "Manual result required." }
    },
    logs: []
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      submitted.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ job, queued: false }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["manual test passed\n/manual-fail\n/exit\n"]),
    output,
    errorOutput: output,
    fetchImpl,
    pollIntervalMs: 10000
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    submitted.map(({ action }) => action),
    ["manual-pass", "manual-fail"]
  );
});

test("terminal chat can recover by starting a dashboard connection", async () => {
  let dashboardStarted = false;
  const job = {
    id: "job-recovered",
    status: "passed",
    request: "Recover the job",
    durationMs: 2000,
    pullRequestReadiness: { message: "PR is ready." },
    stages: {
      pr: { status: "passed", message: "PR is ready." }
    },
    logs: []
  };
  const fetchImpl = async (url) => {
    if (!dashboardStarted) {
      throw new Error("connect ECONNREFUSED");
    }
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ job }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input: Readable.from(["/exit\n"]),
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    recoverConnection: async ({ baseUrl }) => {
      dashboardStarted = true;
      return baseUrl;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(dashboardStarted, true);
  assert.match(output, /Job job-recovered: passed/);
  assert.match(output, /FixLab chat is connected/);
});

test("terminal chat redraws the prompt while job logs stream", async () => {
  let statusReads = 0;
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  const fetchImpl = async (url) => {
    if (!url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    statusReads += 1;
    return new Response(JSON.stringify({
      job: {
        id: "job-streaming",
        status: "running",
        request: "Stream progress",
        durationMs: 1000,
        pullRequestReadiness: { message: "Validation is running." },
        stages: {},
        logs: statusReads > 1
          ? [{ index: 1, stream: "stdout", message: "Build is still running." }]
          : []
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && !output.includes("Build is still running."); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  input.end("/exit\n");

  assert.equal(await chat, 0);
  assert.match(output, /Build is still running/);
  assert.ok(output.match(/fixlab> /g)?.length >= 2);
});

test("terminal chat batches a poll into one redraw and removes runtime screen controls", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  let reads = 0;
  const fetchImpl = async () => {
    reads += 1;
    return new Response(JSON.stringify({
      job: {
        id: "batched-job",
        status: "running",
        request: "Batch output",
        stages: {},
        logs: reads === 1 ? [] : [
          ...Array.from({ length: 50 }, (_, index) => ({
            index,
            stream: "stdout",
            message: `\u001b[2J\u001b[Hprogress-${index}`
          })),
          { index: 50, stream: "stdout", message: "\u001b[2J\r" }
        ]
      }
    }), { headers: { "Content-Type": "application/json" } });
  };
  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && reads < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const streamed = output;
  input.end("/exit\n");
  assert.equal(await chat, 0);
  assert.match(streamed, /progress-49/);
  assert.doesNotMatch(streamed, /\u001b\[2J|\u001b\[H/);
  assert.equal(streamed.match(/fixlab> /g)?.length, 2);
});

test("terminal chat reports an unchanged polling failure once and announces recovery", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  let reads = 0;
  let disconnected = true;
  const fetchImpl = async () => {
    reads += 1;
    if (reads > 1 && disconnected) {
      throw new Error("connection unavailable");
    }
    return new Response(JSON.stringify({ job: null }), {
      headers: { "Content-Type": "application/json" }
    });
  };
  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  for (let attempt = 0; attempt < 100 && reads < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(output.match(/Dashboard polling failed/g)?.length, 1);
  disconnected = false;
  for (let attempt = 0; attempt < 100 && !output.includes("connection restored"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  input.end("/exit\n");
  assert.equal(await chat, 0);
  assert.equal(output.match(/Dashboard connection restored/g)?.length, 1);
});

test("terminal chat buffers streamed output while the user is typing", async () => {
  let statusReads = 0;
  let submittedComments = 0;
  const input = new PassThrough();
  input.isTTY = true;
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  outputStream.isTTY = true;
  const job = {
    id: "job-typing",
    status: "running",
    request: "Analyze a page error",
    durationMs: 1000,
    pullRequestReadiness: { message: "Validation is running." },
    stages: {},
    logs: []
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/status")) {
      statusReads += 1;
      return new Response(JSON.stringify({
        job: {
          ...job,
          logs: statusReads > 1
            ? [{ index: 1, stream: "stdout", message: "Background progress." }]
            : []
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/job/input")) {
      submittedComments += 1;
      return new Response(JSON.stringify({ job, queued: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  const chat = runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 5
  });
  input.write("Analyze the page");
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.write(" error\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.write("/exit\n");

  assert.equal(await chat, 0);
  assert.equal(submittedComments, 1);
  assert.match(output, /Background progress/);
});

test("terminal chat confirms and switches the connected repository", async () => {
  const input = Readable.from(["/exit\n"]);
  const requests = [];
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url) => {
    requests.push(url);
    const alternate = url.startsWith("http://127.0.0.1:4318");
    return new Response(JSON.stringify({
      readiness: {
        repository: alternate ? "C:\\repos\\catalog" : "C:\\repos\\storefront",
        repositoryReady: true,
        profileReady: true
      },
      job: null
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    selectRepository: async ({ readiness }) => {
      assert.equal(readiness.repository, "C:\\repos\\storefront");
      return "http://127.0.0.1:4318";
    }
  });

  assert.equal(exitCode, 0);
  assert.ok(requests.some((url) => url.startsWith("http://127.0.0.1:4318")));
  assert.match(output, /FixLab repository: C:\\repos\\catalog/);
});

test("terminal chat recognizes natural operational commands", () => {
  assert.deepEqual(parseNaturalChatCommand("start dashboard"), {
    command: "/dashboard",
    details: ""
  });
  assert.deepEqual(parseNaturalChatCommand("show logs 50"), {
    command: "/logs",
    details: "50"
  });
  assert.deepEqual(parseNaturalChatCommand("show pull request"), {
    command: "/pr",
    details: ""
  });
  assert.deepEqual(
    parseNaturalChatCommand("switch repository to C:\\repos\\catalog"),
    {
      command: "/repository",
      details: "C:\\repos\\catalog"
    }
  );
  assert.deepEqual(parseNaturalChatCommand("add a bug: Save button is disabled"), {
    command: "/new-bug",
    details: "Save button is disabled"
  });
  assert.deepEqual(parseNaturalChatCommand("cancel waiting job 4"), {
    command: "/cancel-job",
    details: "4"
  });
  assert.deepEqual(parseNaturalChatCommand("manual test passed"), {
    command: "/manual-pass",
    details: ""
  });
  assert.deepEqual(parseNaturalChatCommand("React test failed"), {
    command: "/manual-fail",
    details: ""
  });
  assert.deepEqual(
    parseNaturalChatCommand(
      "remove job 253ef92a-7bdf-47bd-b944-cdb0e6297580 from the queue"
    ),
    {
      command: "/cancel-job",
      details: "253ef92a-7bdf-47bd-b944-cdb0e6297580"
    }
  );
  assert.equal(
    parseNaturalChatCommand("Fix the hierarchy template bug"),
    null
  );
});

test("terminal chat opens the dashboard from natural language", async () => {
  let openedUrl;
  const input = Readable.from(["start dashboard\n/exit\n"]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      readiness: {
        repository: "C:\\repos\\storefront",
        repositoryReady: true,
        profileReady: true
      },
      job: null
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  const exitCode = await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000,
    openDashboard: async ({ baseUrl }) => {
      openedUrl = baseUrl;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(openedUrl, "http://127.0.0.1:4317");
  assert.match(output, /Opened FixLab dashboard/);
});

for (const model of ["", "hydrafusion"]) {
test(`terminal chat creates a separate bug job with ${model || "default model"} from natural language`, async () => {
  const requests = [];
  const input = Readable.from([
    "new bug Product search returns duplicate rows\n",
    "/exit\n"
  ]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({
        readiness: {
          repository: "C:\\repos\\storefront",
          repositoryReady: true,
          profileReady: true
        },
        job: {
          id: "current-job",
          status: "running",
          request: "Current work",
          durationMs: 1000,
          pullRequestReadiness: { message: "Validation is running." },
          stages: {},
          logs: []
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/jobs")) {
      return new Response(JSON.stringify({
        job: { id: "current-job" },
        queue: [{
          id: "new-bug-job",
          request: "Product search returns duplicate rows"
        }]
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  assert.equal(await runChat({
    baseUrl: "http://127.0.0.1:4317",
    model,
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  }), 0);

  const submitted = requests.find(({ url }) => url.endsWith("/api/jobs"));
  assert.deepEqual(JSON.parse(submitted.options.body), {
    request: "Product search returns duplicate rows",
    ...(model ? { model } : {}),
    mode: "fix-and-validate",
    requestType: "bug-fix",
    pullRequestStrategy: "common",
    runAllUiScenarios: false,
    recordPlaywrightVideo: false,
    manualLocalhostTest: false
  });
  assert.match(output, /New bug queued as job new-bug-job/);
});
}

test("terminal chat cancels a waiting job by queue position", async () => {
  const requests = [];
  const input = Readable.from(["cancel waiting job 2\n", "/exit\n"]);
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({
        readiness: {
          repository: "C:\\repos\\storefront",
          repositoryReady: true,
          profileReady: true
        },
        job: {
          id: "current-job",
          status: "running",
          request: "Current work",
          durationMs: 1000,
          pullRequestReadiness: { message: "Validation is running." },
          stages: {},
          logs: []
        },
        queue: []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/api/jobs/cancel")) {
      return new Response(JSON.stringify({
        job: { id: "current-job" },
        cancelledJob: { id: "cancelled-job", status: "cancelled" },
        queue: [{ id: "remaining-job" }]
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  };

  assert.equal(await runChat({
    baseUrl: "http://127.0.0.1:4317",
    input,
    output: outputStream,
    errorOutput: outputStream,
    fetchImpl,
    pollIntervalMs: 10000
  }), 0);

  const cancelled = requests.find(
    ({ url }) => url.endsWith("/api/jobs/cancel")
  );
  assert.deepEqual(JSON.parse(cancelled.options.body), { position: 2 });
  assert.match(
    output,
    /Cancelled queued job cancelled-job\. 1 job\(s\) waiting\./
  );
});

test("dashboard shutdown terminates only its active executor handle", async () => {
  const repository = createRepository();
  let terminated = 0;
  const executor = () => ({
    completion: new Promise(() => {}),
    terminate() {
      terminated += 1;
    }
  });
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Keep this job active until shutdown.",
        requestType: "bug-fix",
        mode: "validate-only"
      })
    });
    await dashboard.close();
    assert.equal(terminated, 1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("shutdown completes frontend and HTTP cleanup even when executor termination throws", async () => {
  const repository = createRepository();
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  const profile = validProfile();
  const port = await availablePort();
  profile.applications.frontend = {
    workingDirectory: ".",
    command: 'node -e "setInterval(() => {}, 1000)"',
    port,
    healthUrl: `http://127.0.0.1:${port}`
  };
  writeFileSync(profilePath, JSON.stringify(profile));
  let finish;
  const { dashboard, url } = await startDashboard(repository, () => ({
    completion: new Promise((resolve) => { finish = resolve; }),
    terminate() { throw new Error("Synthetic executor termination error"); }
  }));
  try {
    const start = await jsonRequest(url, "/api/frontend/start", { method: "POST" });
    assert.equal(start.response.status, 202);
    const session = await jsonRequest(url, "/api/session");
    const pid = session.body.frontend.pid;
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Exercise settled shutdown.", mode: "validate-only" })
    });
    await assert.rejects(dashboard.close(), (error) =>
      error instanceof AggregateError &&
      error.errors.some((failure) => /Synthetic executor termination error/.test(failure.message)));
    await assert.rejects(fetch(`${url}/api/status`));
    // POSIX signal delivery can finish after the HTTP listener has closed.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    finish({ code: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    finish?.({ code: null });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("same-repository session controls confirm the owner, stop and resume saved job context", async () => {
  const repository = createGitRepository();
  const calls = [];
  let finish;
  let stopped = 0;
  const owner = await startDashboard(repository, (input) => {
    calls.push(input);
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() {
        stopped += 1;
        finish({ code: null });
      }
    };
  });
  const other = await startDashboard(repository, () => {
    throw new Error("the other dashboard must not start an agent");
  });
  const post = (url, path, body) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const job = await post(owner.url, "/api/jobs", {
      request: "Retain this session context.",
      requestType: "bug-fix",
      mode: "validate-only"
    });
    const listed = await jsonRequest(other.url, "/api/sessions");
    assert.equal(listed.body.sessions.length, 2);
    const session = listed.body.sessions.find((entry) => entry.job?.running);
    assert.equal(session.job.id, job.body.job.id);
    assert.equal(session.url, owner.url);
    const conflict = await post(other.url, "/api/jobs", {
      request: "This must not start while another owner holds the repository.",
      requestType: "bug-fix",
      mode: "validate-only"
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.owner.id, session.id);
    const control = {
      ownerId: session.id,
      jobId: session.job.id,
      resource: "job",
      action: "stop"
    };
    const unconfirmed = await post(other.url, "/api/sessions/control", control);
    assert.equal(unconfirmed.response.status, 409);
    assert.equal(stopped, 0);
    const stale = await post(other.url, "/api/sessions/control", {
      ...control, confirmed: true, jobId: randomUUID()
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stopped, 0);
    const reconnect = await post(other.url, "/api/sessions/control", {
      ...control, action: "resume"
    });
    assert.equal(reconnect.response.status, 202);
    assert.equal(calls.length, 1);
    const confirmed = await post(other.url, "/api/sessions/control", {
      ...control, confirmed: true
    });
    assert.equal(confirmed.response.status, 202);
    assert.equal(stopped, 1);
    const blocked = await jsonRequest(owner.url, "/api/job");
    assert.equal(blocked.body.job.status, "blocked");
    assert.equal(blocked.body.job.canResume, true);
    const resumed = await post(other.url, "/api/sessions/control", {
      ...control, action: "resume"
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.equal(calls[1].resume, true);
    const shutdown = await post(other.url, "/api/sessions/control", {
      ...control, action: "shutdown", resource: "all", confirmed: true
    });
    assert.equal(shutdown.response.status, 202);
    assert.equal(stopped, 2);
    assert.equal((await jsonRequest(owner.url, "/api/status")).response.status, 200);
    await owner.dashboard.close();
    const remaining = await jsonRequest(other.url, "/api/sessions");
    assert.equal(remaining.body.sessions.length, 1);
  } finally {
    await owner.dashboard.close();
    await other.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard bounds retained raw logs while preserving stage summaries", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (let index = 0; index < MAX_JOB_LOG_ENTRIES + 20; index += 1) {
      onOutput("stdout", `diagnostic line ${index}\n`);
    }
    onOutput(
      "stdout",
      "FIXLAB_TEST|synthetic-intercepted|intercepted|Bounded logging scenario evidence.\n"
    );
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} summary\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Exercise bounded logging.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(result.body.job.status, "passed");
    assert.equal(result.body.job.logs.length, MAX_JOB_LOG_ENTRIES);
    assert.equal(result.body.job.droppedLogs, 29);
    assert.equal(result.body.job.stages.pr.message, "pr summary");
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard exposes bounded safe agent activity separately from raw logs", async () => {
  const repository = createRepository();
  const executor = ({ onOutput }) => {
    for (let index = 0; index < MAX_JOB_ACTIVITY_ENTRIES + 5; index += 1) {
      onOutput(
        "stdout",
        `FIXLAB_ACTIVITY|diagnosis|Evidence update ${index}\n`
      );
    }
    for (const stage of FIXLAB_STAGES) {
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${stage} summary\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  try {
    await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: "Show structured agent analysis.",
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await jsonRequest(url, "/api/job");

    assert.equal(
      result.body.job.status,
      "passed",
      JSON.stringify(result.body.job)
    );
    assert.equal(result.body.job.activity.length, MAX_JOB_ACTIVITY_ENTRIES);
    assert.deepEqual(result.body.job.activity[0], {
      timestamp: result.body.job.activity[0].timestamp,
      stage: "diagnosis",
      message: "Evidence update 5"
    });
    assert.equal(
      result.body.job.logs.some((entry) =>
        entry.message.startsWith("FIXLAB_ACTIVITY|")
      ),
      true
    );
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard cache hits and invalidates on profile or HEAD changes", async () => {
  const repository = createGitRepository();
  const prompts = [];
  const executor = ({ prompt, onOutput }) => {
    prompts.push(prompt);
    onOutput("stdout", "raw diagnostic output that must not be cached\n");
    for (const stage of FIXLAB_STAGES) {
      const summary =
        stage === "review" ? "token=must-not-be-cached" : `${stage} concise`;
      onOutput("stdout", `FIXLAB_STAGE|${stage}|passed|${summary}\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  };
  const { dashboard, url } = await startDashboard(repository, executor);

  async function runJob(label) {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: label,
        requestType: "bug-fix",
        mode: "fix-and-validate"
      })
    });
    assert.equal(started.response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  try {
    await runJob("first request is not cache content");
    assert.doesNotMatch(prompts[0], /Verified same-repository cache summary/);

    await runJob("second request is not cache content");
    assert.match(prompts[1], /Verified same-repository cache summary/);
    assert.match(prompts[1], /"result": "passed"/);

    const profilePath = join(
      repository,
      ".github",
      "fixlab",
      "repository-profile.json"
    );
    writeFileSync(
      profilePath,
      JSON.stringify(validProfile({ name: "Changed profile" }))
    );
    await runJob("profile hash invalidation");
    assert.doesNotMatch(prompts[2], /Verified same-repository cache summary/);

    await runJob("changed profile cache hit");
    assert.match(prompts[3], /Verified same-repository cache summary/);

    writeFileSync(join(repository, "tracked.txt"), "changed HEAD\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "-m", "Change HEAD"]);
    await runJob("HEAD invalidation");
    assert.doesNotMatch(prompts[4], /Verified same-repository cache summary/);

    const cacheContext = createCacheContext(repository);
    const cacheContent = readFileSync(cacheContext.cachePath, "utf8");
    const cache = JSON.parse(cacheContent);
    assert.ok(Buffer.byteLength(cacheContent) <= MAX_CACHE_BYTES);
    assert.ok(cache.entries.length <= MAX_CACHE_ENTRIES);
    assert.doesNotMatch(cacheContent, /raw diagnostic output/);
    assert.doesNotMatch(cacheContent, /first request is not cache content/);
    assert.doesNotMatch(cacheContent, /must-not-be-cached/);
    assert.match(cacheContent, /review: passed/);
    assert.doesNotMatch(cacheContent, /concise/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard gate execution rejects forged readiness and stale final-source evidence", async () => {
  const repository = createGitRepository();
  git(repository, ["checkout", "-b", "users/fixlab-test/strict-checkpoint"]);
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  writeFileSync(profilePath, JSON.stringify(validProfile({
    validation: {
      gates: [{
        id: "focused-tests",
        command: process.execPath,
        args: ["--test", "focused.test.cjs"],
        workingDirectory: ".",
        reuse: true,
        timeoutSeconds: 30
      }]
    }
  })));
  writeFileSync(join(repository, "focused.test.cjs"),
    "const test=require('node:test');for(let i=0;i<1000;i++)test('check '+i,()=>{});\n");
  let finish;
  let emit;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    emit = input.onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); }
    };
  });
  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Check focused behavior.", mode: "fix-and-validate" })
    });
    assert.equal(started.response.status, 202);
    const jobId = started.body.job.id;
    assert.match(prompt, /gate --port \d+ --job/);
    assert.match(prompt, /Required gate IDs: focused-tests/);
    const context = () => jsonRequest(url, "/api/job/publication-context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, repository, verify: true })
    });
    for (const stage of FIXLAB_STAGES.filter((stage) => stage !== "pr")) {
      emit("stdout", `FIXLAB_STAGE|${stage}|${stage === "live-test" ? "skipped" : "passed"}|synthetic gate-only fixture\n`);
    }
    assert.equal((await context()).body.ready, false, "strict stages cannot substitute for required gate proof");
    let status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.pullRequestReadiness.ready, false);
    const run = (overrides = {}, headers = {}) => jsonRequest(url, "/api/validation/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jobId, gateId: "focused-tests", repository, ...overrides })
    });
    assert.equal((await run({ jobId: "different-job" })).response.status, 400);
    assert.equal((await run({ gateId: "invented-gate" })).response.status, 400);
    assert.equal((await run({}, { Origin: "https://example.com" })).response.status, 400);
    const result = await run();
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 0);
    assert.match(result.body.summary, /1000 passed/);
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.validation.status, "passed");
    assert.ok(status.body.job.validation.gates[0].context.reductionPercent > 90);
    assert.ok(Buffer.byteLength(result.body.summary) < 2000);
    let output = "";
    const exitCode = await runValidationGate([
      "--port", new URL(url).port, "--job", jobId,
      "--gate", "focused-tests", "--repository", repository
    ], { stdout: { write(text) { output += text; } }, stderr: { write(text) { output += text; } } });
    assert.equal(exitCode, 0, output);
    assert.match(output, /unchanged job-local evidence reused/);
    assert.equal((await context()).body.ready, true, "strict publication retains verified gate and stage readiness");
    writeFileSync(join(repository, "tracked.txt"), "edited after validation\n");
    assert.equal((await context()).body.ready, false, "changed source invalidates strict publication consent readiness");
    emit("stdout", "FIXLAB_STAGE|pr|skipped|Stale required gate blocks publication\n");
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.status, "blocked");
    assert.equal(status.body.job.validation.gates[0].status, "stale");
    assert.equal(status.body.job.pullRequestReadiness.ready, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("unverified drafts bypass neither validation evidence nor merge policy and need no live authentication or local tools", async () => {
  const repository = createGitRepository();
  git(repository, ["checkout", "-b", "users/fixlab-test/unverified"]);
  const profile = validProfile({ environments: ["dev"],
    workflow: { mode: "strict", publication: "ready" }, validation: { gates: [
      { id: "local-tests", stage: "review", required: true, command: process.execPath,
        args: ["-e", "process.exit(7)"], workingDirectory: ".", timeoutSeconds: 30 },
      { id: "api-integration", stage: "live-test", required: true, command: process.execPath,
        args: ["-e", "process.exit(41)"], workingDirectory: ".", timeoutSeconds: 30 }
    ] } });
  profile.browserAutomation.authentication = { required: true, command: "npm run sso",
    statusPaths: ["missing-sign-in-state"] };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  let emit;
  let finish;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    emit = input.onOutput;
    prompt = input.prompt;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); } };
  }, undefined, { preflight: (input) => runJobPreflight({ ...input, resolve: () => false }) });
  try {
    const post = (body) => jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        request: "Create a reviewed unverified draft.", mode: "fix-and-validate",
        targetEnvironment: "dev", ...body
      })
    });
    for (const fields of [
      { deferValidation: "true" }, { skipLiveTests: "true" }, { useDeployedBackend: "true" },
      { deferValidation: true, mode: "validate-only" },
      { deferValidation: true, manualLocalhostTest: true },
      { deferValidation: true, holdForManualLiveTest: true },
      { deferValidation: true, runAllUiScenarios: true }
    ]) {
      assert.equal((await post(fields)).response.status, 400);
    }
    const started = await post({ deferValidation: true, useDeployedBackend: true, prestartFrontend: true });
    assert.equal(started.response.status, 202, started.body.error);
    assert.equal(started.body.job.workflow.publication, "draft");
    assert.equal(started.body.job.deferValidation, true);
    assert.equal(started.body.job.skipLiveTests, true);
    assert.equal(started.body.job.useDeployedBackend, true);
    assert.match(prompt, /Explicit unverified draft/);
    assert.match(prompt, /useDeployedBackend=true/);
    for (const stage of ["intake", "diagnosis", "fix", "review"]) {
      emit("stdout", `FIXLAB_STAGE|${stage}|passed|Code and effective diff reviewed\n`);
    }
    for (const stage of ["reproduce", "local-stack", "live-test"]) {
      emit("stdout", `FIXLAB_STAGE|${stage}|skipped|User deferred local and live checks\n`);
    }
    const context = await jsonRequest(url, "/api/job/publication-context", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: started.body.job.id, repository, verify: true })
    });
    assert.equal(context.body.ready, true, context.body.message);
    assert.equal(context.body.publication, "draft");
    emit("stdout", "FIXLAB_STAGE|pr|passed|Verified authorized draft; local and live checks not run\n");
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    const job = (await jsonRequest(url, "/api/job")).body.job;
    assert.equal(job.status, "passed", job.error);
    assert.equal(job.validation.fullValidationPassed, false);
    assert.equal(job.validation.status, "pending");
    assert.ok(job.validation.gates.every((gate) => gate.status === "pending"));
    assert.equal(job.stages["live-test"].status, "skipped");
    assert.equal(job.pullRequestReadiness.status, "created");
    assert.match(job.pullRequestReadiness.message, /Unverified draft/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

for (const [mode, publication] of [["efficient", "draft"], ["strict", "draft"], ["efficient", "ready"]]) {
  test(`${mode} ${publication} publication separates verified local checks from failed live integration`, async () => {
    const repository = createGitRepository();
    git(repository, ["checkout", "-b", "users/fixlab-test/integration"]);
    writeFileSync(join(repository, "local-fail.fixture"), "synthetic local failure");
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"),
      JSON.stringify(validProfile({ workflow: { mode, publication }, validation: { gates: [
        { id: "local-tests", stage: "review", required: true, command: process.execPath,
          args: ["-e", "process.exit(require('node:fs').existsSync('local-fail.fixture') ? 7 : 0)"],
          workingDirectory: ".", timeoutSeconds: 30 },
        { id: "api-integration", stage: "live-test", required: true, command: process.execPath,
          args: ["-e", "process.exit(41)"], workingDirectory: ".", timeoutSeconds: 30 }
      ] } })));
    let emit;
    let finish;
    const { dashboard, url } = await startDashboard(repository, (input) => {
      emit = input.onOutput;
      return { completion: new Promise((resolve) => { finish = resolve; }),
        terminate() { finish({ code: 130 }); } };
    });
    try {
      const started = await jsonRequest(url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Fix frontend/backend behavior; disclose unavailable DEV integration.",
          mode: "fix-and-validate", validationIntent: publication === "draft" ? "scoped" : "full" })
      });
      assert.equal(started.response.status, 202, started.body.error);
      const request = (path, fields = {}) => jsonRequest(url, path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: started.body.job.id, repository, ...fields })
      });
      for (const stage of ["intake", "diagnosis", "reproduce", "fix", "review"]) {
        emit("stdout", `FIXLAB_STAGE|${stage}|passed|Focused synthetic change and review\n`);
      }
      const context = () => request("/api/job/publication-context", { verify: true });
      assert.equal((await context()).body.ready, false, "local evidence is required");
      assert.equal((await request("/api/validation/run", { gateId: "local-tests" })).body.status, 7);
      assert.equal((await context()).body.ready, false, "local failure cannot be deferred");
      rmSync(join(repository, "local-fail.fixture"));
      assert.equal((await request("/api/validation/run", { gateId: "local-tests" })).body.status, 0);
      assert.equal((await context()).body.ready, publication === "draft");
      writeFileSync(join(repository, "backend-change.fixture"), "synthetic reviewed backend edit");
      assert.equal((await context()).body.ready, false, "changed source invalidates the local checkpoint");
      assert.equal((await request("/api/validation/run", { gateId: "local-tests" })).body.status, 0);
      assert.equal((await request("/api/validation/run", { gateId: "api-integration" })).body.status, 41);
      const verified = await context();
      assert.equal(verified.response.status, 200, verified.body.error);
      assert.equal(verified.body.ready, publication === "draft");
      assert.equal(verified.body.publication, publication);
      for (const stage of ["local-stack", "live-test"]) {
        emit("stdout", `FIXLAB_STAGE|${stage}|skipped|Integration failed; DEV/API validation deferred, not passed\n`);
      }
      emit("stdout", publication === "draft"
        ? "FIXLAB_STAGE|pr|passed|Verified draft; local tests passed, DEV integration failed and remains unverified\n"
        : "FIXLAB_STAGE|pr|blocked|Required live integration failed; ready publication is unavailable\n");
      finish({ code: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      const status = (await jsonRequest(url, "/api/job")).body.job;
      assert.equal(status.status, publication === "draft" ? "passed" : "blocked");
      assert.equal(status.validation.status, "blocked");
      assert.equal(status.validation.fullValidationPassed, false);
      assert.equal(status.validation.gates.find((gate) => gate.id === "api-integration").status, "failed");
      assert.equal(status.stages["live-test"].status, "skipped");
      assert.equal(status.stages.review.status, publication === "draft" ? "passed" : "blocked");
      assert.equal(status.pullRequestReadiness.status, publication === "draft" ? "created" : "blocked");
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("new efficient jobs publish the focused checkpoint while optional tests remain pending", async () => {
  const repository = createGitRepository();
  git(repository, ["checkout", "-b", "users/fixlab-test/checkpoint"]);
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"),
    JSON.stringify(validProfile({ workflow: undefined, validation: { gates: [{
      id: "unit-tests", kind: "tests", stage: "review", command: process.execPath,
      args: ["-e", "setTimeout(() => {}, require('node:fs').existsSync('wait.fixture') ? 30000 : 150)"],
      workingDirectory: ".", timeoutSeconds: 30
    }] } })));
  let emit;
  let finish;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    emit = input.onOutput;
    prompt = input.prompt;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); } };
  });
  try {
    const started = await jsonRequest(url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Fix synthetic behavior", mode: "fix-and-validate",
        validationIntent: "scoped" })
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.job.workflow.mode, "efficient");
    assert.match(prompt, /Required gate IDs: none/);
    assert.match(prompt, /Optional gate IDs: unit-tests/);
    const context = (overrides = {}, origin) => jsonRequest(url, "/api/job/publication-context", {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ jobId: started.body.job.id, repository, verify: true, ...overrides })
    });
    assert.equal((await context()).body.ready, false);
    assert.equal((await context({}, url)).response.status, 400);
    assert.equal((await context({ jobId: randomUUID() })).response.status, 400);
    const session = await jsonRequest(url, "/api/session");
    const migrate = (overrides = {}, origin = url) => jsonRequest(url, "/api/job/workflow", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ instanceId: session.body.id, jobId: started.body.job.id,
        repository, confirmed: true, mode: "strict", ...overrides })
    });
    assert.equal((await migrate()).response.status, 409);
    for (const stage of ["intake", "diagnosis", "reproduce", "fix", "review"]) {
      emit("stdout", `FIXLAB_STAGE|${stage}|passed|Focused regression and reviewed diff\n`);
    }
    let status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.status, "running");
    assert.equal(status.body.job.pullRequestReadiness.ready, true);
    assert.equal(status.body.job.validation.status, "advisory");
    assert.equal(status.body.job.validation.gates[0].status, "pending");
    assert.equal(status.body.job.validation.fullValidationPassed, false);
    const reviewedContext = await context();
    assert.equal(reviewedContext.response.status, 200, reviewedContext.body.error);
    assert.equal(reviewedContext.body.ready, true);
    assert.equal(reviewedContext.body.source, "users/fixlab-test/checkpoint");
    assert.equal(reviewedContext.body.target, "develop");
    assert.equal(reviewedContext.body.publication, "draft");
    emit("stdout", "FIXLAB_STAGE|pr|passed|Verified draft synthetic PR\n");
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.pullRequestReadiness.status, "created");
    const gate = await jsonRequest(url, "/api/validation/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: started.body.job.id, gateId: "unit-tests", repository })
    });
    assert.equal(gate.response.status, 200);
    assert.equal(gate.body.status, 0);
    for (const stage of ["local-stack", "live-test"]) {
      emit("stdout", `FIXLAB_STAGE|${stage}|skipped|No browser changes in synthetic fixture\n`);
    }
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.status, "passed");
    assert.equal(status.body.job.validation.gates[0].status, "passed");
    const usage = status.body.job.usage;
    const checks = (overrides = {}, origin = url) => jsonRequest(url, "/api/job/checks", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ instanceId: session.body.id, jobId: started.body.job.id,
        repository: realpathSync.native(repository), confirmed: true, action: "run", selection: "tests", ...overrides })
    });
    assert.equal((await checks({}, "https://example.invalid")).response.status, 400);
    assert.equal((await checks({ jobId: randomUUID() })).response.status, 400);
    assert.equal((await checks({ confirmed: false })).response.status, 400);
    assert.equal((await checks({ selection: "gate", value: "unknown" })).response.status, 400);
    const selectedRun = checks();
    const runningDeadline = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await jsonRequest(url, "/api/job");
    } while (status.body.job.validation.gates[0].status !== "running" && Date.now() < runningDeadline);
    assert.equal(status.body.job.validation.gates[0].status, "running");
    assert.equal((await checks()).response.status, 400, "overlapping checks remain rejected");
    assert.throws(() => createExecutorLease(repository, "other-dashboard").acquire("other-job"), /reserved/);
    assert.equal((await selectedRun).response.status, 200);
    const releasedLease = createExecutorLease(repository, "other-dashboard").acquire("other-job");
    releasedLease.release();
    assert.equal((await migrate({}, "https://example.com")).response.status, 403);
    assert.equal((await migrate({ jobId: randomUUID() })).response.status, 409);
    assert.equal((await migrate({ confirmed: false })).response.status, 400);
    let migrated = await migrate();
    assert.equal(migrated.response.status, 200);
    assert.equal(migrated.body.job.workflow.mode, "strict");
    assert.equal(migrated.body.job.validation.gates[0].required, true);
    assert.deepEqual(migrated.body.job.usage, usage);
    migrated = await migrate({ mode: "efficient" });
    assert.equal(migrated.response.status, 200);
    assert.equal(migrated.body.job.workflow.mode, "efficient");
    assert.equal(migrated.body.job.validation.gates[0].status, "passed");
    await dashboard.close();
    const restored = await startDashboard(repository);
    try {
      const saved = await jsonRequest(restored.url, "/api/job");
      assert.equal(saved.body.job.workflow.mode, "efficient");
      assert.deepEqual(saved.body.job.usage, usage);
      const restoredSession = await jsonRequest(restored.url, "/api/session");
      writeFileSync(join(repository, "wait.fixture"), "owned cancellation fixture\n");
      const selected = jsonRequest(restored.url, "/api/job/checks", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: restored.url },
        body: JSON.stringify({ instanceId: restoredSession.body.id, jobId: saved.body.job.id,
          repository: realpathSync.native(repository), confirmed: true, action: "run", selection: "tests" })
      });
      const activeDeadline = Date.now() + 10000;
      let active;
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        active = await jsonRequest(restored.url, "/api/job");
      } while (active.body.job.validation.gates[0].status !== "running" && Date.now() < activeDeadline);
      assert.equal(active.body.job.validation.gates[0].status, "running", "complete is exercised during the active optional gate");
      assert.throws(() => createExecutorLease(repository, "other-dashboard").acquire("other-job"), /reserved/);
      const queued = await jsonRequest(restored.url, "/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Next synthetic job", mode: "fix-and-validate" })
      });
      assert.equal(queued.response.status, 202);
      assert.equal(queued.body.queued, true, "intake cannot replace a job that owns optional validation");
      const completed = await jsonRequest(restored.url, "/api/job/checks", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: restored.url },
        body: JSON.stringify({ instanceId: restoredSession.body.id, jobId: saved.body.job.id,
          repository: realpathSync.native(repository), confirmed: true, action: "complete" })
      });
      assert.equal(completed.response.status, 200);
      assert.equal(completed.body.completed, true);
      assert.notEqual(completed.body.job?.id, saved.body.job.id);
      assert.equal((await selected).response.status, 200);
      const next = await jsonRequest(restored.url, "/api/job");
      assert.equal(next.body.job.id, queued.body.queue.at(-1).id);
    } finally {
      await restored.dashboard.close();
    }
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard API-only policy preserves scope across recovery and explicit full validation", async () => {
  const repository = createGitRepository();
  const profilePath = join(repository, ".github", "fixlab", "repository-profile.json");
  const profile = validProfile({
    validation: {
      apiOnly: {
        baseRef: "HEAD",
        paths: ["api"],
        fullValidationPaths: ["api/Contracts"],
        gateIds: ["backend-tests"]
      },
      gates: [
        { id: "backend-tests", command: process.execPath, args: ["-e", "process.exit(0)"], workingDirectory: ".", timeoutSeconds: 30 },
        { id: "frontend-tests", command: process.execPath, args: ["-e", "process.exit(23)"], workingDirectory: ".", timeoutSeconds: 30 }
      ]
    }
  });
  mkdirSync(join(repository, "api"));
  writeFileSync(profilePath, JSON.stringify(profile));
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Reviewed API validation policy"]);
  let finish;
  let emit;
  let prompt;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    emit = input.onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); }
    };
  });
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Validate the internal API correction.", mode: "validate-only" });
    const jobId = started.body.job.id;
    assert.equal(started.body.job.validationIntent, "affected");
    assert.match(prompt, /dashboard, not the agent, determines applicability/);
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    const excluded = await post("/api/validation/run", { jobId, gateId: "frontend-tests", repository });
    assert.equal(excluded.body.outcome, "not-applicable");
    assert.equal((await post("/api/validation/run", { jobId, gateId: "backend-tests", repository })).body.status, 0);
    emit("stdout", "FIXLAB_TEST|synthetic-intercepted|intercepted|Verify API-only validation policy.\n");
    for (const stage of FIXLAB_STAGES) {
      emit("stdout", `FIXLAB_STAGE|${stage}|passed|Verified applicable scope\n`);
    }
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    let status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.status, "passed");
    assert.equal(status.body.job.validation.scope, "api-only");
    assert.equal(status.body.job.validation.gates[1].status, "not-applicable");
    const conversation = await jsonRequest(url, "/api/conversation");
    assert.equal(conversation.body.job.validation.scope, "api-only");
    assert.equal(conversation.body.job.validation.gates[1].required, false);
    assert.match(conversation.body.job.validation.gates[1].reason, /API-only/);
    const resumed = await dashboardConversation({
      repository, port: new URL(url).port * 1,
      instanceId: conversation.body.instanceId, jobId,
      confirmed: true, action: "continue", details: "Run all configured checks explicitly.",
      validationIntent: "full"
    }, true);
    assert.equal(resumed.job.validationIntent, "full");
    assert.equal(resumed.job.validation.scope, "all");
    assert.equal((await post("/api/validation/run", { jobId, gateId: "frontend-tests", repository })).body.status, 23);
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    status = await jsonRequest(url, "/api/job");
    assert.equal(status.body.job.validation.status, "blocked");
    assert.equal(status.body.job.pullRequestReadiness.ready, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("dashboard automatically routes component-only profiles and supplies bounded retrieval hints", async () => {
  const repository = createGitRepository();
  const profile = validProfile({
    workflow: { mode: "efficient" },
    components: [
      { name: "backend", paths: ["api/src"], testPatterns: ["api/tests/**/*.cs"] },
      { name: "frontend", paths: ["web/src"], testPatterns: ["web/tests/**/*.test.ts"] }
    ],
    validation: {
      liveTestsRequired: false,
      liveTestsDeferredReason: "Approved offline units; integration is deferred.",
      gates: [
        { id: "backend-tests", command: process.execPath, args: ["-e", "process.exit(0)"], workingDirectory: "api", kind: "tests", required: true, timeoutSeconds: 30 },
        { id: "frontend-tests", command: process.execPath, args: ["-e", "process.exit(23)"], workingDirectory: "web", timeoutSeconds: 30 }
      ]
    }
  });
  profile.applications.frontend.workingDirectory = "web";
  delete profile.browserAutomation;
  mkdirSync(join(repository, "api", "src"), { recursive: true });
  mkdirSync(join(repository, "web", "src"), { recursive: true });
  writeFileSync(join(repository, "api", "src", "Service.cs"), "initial");
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Component-only profile"]);
  git(repository, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
  let prompt;
  let finish;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    prompt = input.prompt;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); }
    };
  });
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", {
      request: "Correct the exception at api/src/Service.cs.", mode: "validate-only"
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const jobId = started.body.job.id;
    assert.equal(started.body.job.validationIntent, "affected");
    assert.match(prompt, /"component":"backend"/);
    assert.doesNotMatch(prompt, /"component":"frontend"/);
    assert.match(prompt, /complete verified Git diff, not report keywords/);
    assert.match(prompt, /automatic component mappings/);
    writeFileSync(join(repository, "api", "src", "Service.cs"), "fixed");
    const excluded = await post("/api/validation/run", { jobId, gateId: "frontend-tests", repository });
    assert.equal(excluded.body.outcome, "not-applicable");
    const status = await jsonRequest(url, "/api/job");
    assert.deepEqual(status.body.job.validation.components, ["backend"]);
    assert.equal(status.body.job.validation.browserApplicable, false);
    assert.equal(status.body.job.validation.gates[1].status, "not-applicable");
    finish({ code: 0 });
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only recovery retains failed frontend gates across an actual dashboard restart", async () => {
  const repository = createApiValidationRepository();
  let finish;
  let emit;
  const executor = (input) => {
    emit = input.onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); }
    };
  };
  let current = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Preserve failed validation on recovery.", mode: "validate-only" });
    const jobId = started.body.job.id;
    const gate = (gateId) => post("/api/validation/run", { jobId, gateId, repository });
    writeFileSync(join(repository, "api", "service.cs"), "corrected");
    writeFileSync(join(repository, "web", "view.ts"), "frontend change");
    assert.equal((await gate("frontend-tests")).body.status, 23);
    writeFileSync(join(repository, "web", "view.ts"), "initial");
    assert.equal((await gate("backend-tests")).body.status, 0);
    for (const stage of FIXLAB_STAGES) {
      emit("stdout", `FIXLAB_STAGE|${stage}|passed|Retain actual gate evidence\n`);
    }
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await jsonRequest(current.url, "/api/job")).body.job.validation.status, "blocked");
    await current.dashboard.close();
    current = await startDashboard(repository, executor);
    const resumed = await post("/api/job/input", {
      action: "continue", details: "Continue the same job without discarding failed checks."
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    const frontend = resumed.body.job.validation.gates.find((gate) => gate.id === "frontend-tests");
    assert.equal(frontend.status, "failed");
    assert.equal(frontend.required, true);
    assert.equal(frontend.exitCode, 23);
    assert.equal((await gate("backend-tests")).body.status, 0);
    assert.equal((await jsonRequest(current.url, "/api/job")).body.job.validation.status, "blocked");
    assert.equal((await gate("frontend-tests")).body.status, 23);
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    const restarted = await post("/api/jobs/restart", { jobId });
    assert.equal(restarted.response.status, 202, JSON.stringify(restarted.body));
    assert.notEqual(restarted.body.job.id, jobId);
    assert.equal(restarted.body.job.validation.scope, "api-only");
    const newFrontend = restarted.body.job.validation.gates.find((gate) => gate.id === "frontend-tests");
    assert.equal(newFrontend.required, false);
    assert.equal(newFrontend.status, "not-applicable");
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("API-only fresh-runtime retry cannot recapture a missing baseline after dashboard recovery", async () => {
  const repository = createApiValidationRepository("validation-base");
  git(repository, ["branch", "validation-base"]);
  writeFileSync(join(repository, "web", "view.ts"), "earlier frontend change");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "Earlier frontend change"]);
  writeFileSync(join(repository, "api", "service.cs"), "corrected");
  let finish;
  const executions = [];
  const executor = (input) => {
    executions.push(input);
    return executions.length === 1
      ? { completion: Promise.resolve({ code: 1 }), terminate() {} }
      : {
          completion: new Promise((resolve) => { finish = resolve; }),
          terminate() { finish({ code: 130 }); }
        };
  };
  let current = await startDashboard(repository, executor);
  const post = (path, body) => jsonRequest(current.url, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Recover a legacy launch failure.", mode: "validate-only" });
    const jobId = started.body.job.id;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await jsonRequest(current.url, "/api/job")).body.job.status, "failed");
    await current.dashboard.close();
    const historyPath = join(dirname(createCacheContext(repository).cachePath), "dashboard-jobs.json");
    const saved = JSON.parse(readFileSync(historyPath, "utf8"));
    delete saved.jobs.find((job) => job.id === jobId).validationBaseline;
    writeFileSync(historyPath, JSON.stringify(saved));
    git(repository, ["branch", "-f", "validation-base", "HEAD"]);
    current = await startDashboard(repository, executor);
    const resumed = await post("/api/job/input", {
      action: "retry", details: "Retry with a new runtime, preserving original coverage."
    });
    assert.equal(resumed.response.status, 202, JSON.stringify(resumed.body));
    assert.equal(executions.length, 2);
    assert.equal(executions[1].resume, false, "exercise requiresFreshRetry after recovery");
    assert.equal(resumed.body.job.validation.scope, "all");
    assert.match(resumed.body.job.validation.reason, /No verified saved validation baseline/);
    assert.equal(resumed.body.job.validation.gates.find((gate) => gate.id === "frontend-tests").required, true);
    assert.equal((await post("/api/validation/run", { jobId, gateId: "frontend-tests", repository })).body.status, 23);
  } finally {
    await current.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("holding and held jobs cannot expose stale gate passes as PR readiness", async () => {
  const repository = createGitRepository();
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
    validation: { gates: [{
      id: "tests", command: process.execPath, args: ["-e", "process.exit(0)"],
      workingDirectory: ".", timeoutSeconds: 30
    }] }
  })));
  let finish;
  let emit;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    emit = input.onOutput;
    return {
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() {}
    };
  }, null, { deferTermination: true });
  const post = (path, body) => jsonRequest(url, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    const started = await post("/api/jobs", { request: "Hold verified work.", mode: "fix-and-validate" });
    const jobId = started.body.job.id;
    for (const stage of FIXLAB_STAGES) {
      emit("stdout", `FIXLAB_STAGE|${stage}|${stage === "pr" ? "blocked" : "passed"}|Waiting for approval\n`);
    }
    assert.equal((await post("/api/validation/run", { jobId, gateId: "tests", repository })).body.status, 0);
    writeFileSync(join(repository, "tracked.txt"), "changed after gate\n");
    const holding = await post("/api/jobs/hold", { jobId });
    assert.equal(holding.body.job.status, "holding");
    assert.equal(holding.body.job.validation.status, "passed");
    assert.equal(holding.body.job.pullRequestReadiness.ready, false);
    finish({ code: 0 });
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await jsonRequest(url, "/api/status");
      if (status.body.held.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.body.held[0].status, "held");
    assert.equal(status.body.held[0].pullRequestReadiness.ready, false);
    await post("/api/jobs/resume", { jobId });
    assert.equal((await post("/api/validation/run", { jobId, gateId: "tests", repository })).body.status, 0);
    finish({ code: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    status = await jsonRequest(url, "/api/status");
    assert.equal(status.body.job.validation.status, "passed");
    assert.equal(status.body.job.pullRequestReadiness.ready, true);
  } finally {
    finish?.({ code: 0 });
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("validation admission closes as soon as executor stop or dashboard shutdown begins", async () => {
  for (const action of ["stop", "close"]) {
    const repository = createGitRepository();
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
      validation: { gates: [{
        id: "tests", command: process.execPath, args: ["-e", "process.exit(0)"],
        workingDirectory: ".", timeoutSeconds: 30
      }] }
    })));
    let finish;
    let closing;
    let validationRequest;
    const { dashboard, url } = await startDashboard(repository, () => ({
      completion: new Promise((resolve) => { finish = resolve; }),
      terminate() {}
    }), null, { deferTermination: true });
    const post = (path, body) => jsonRequest(url, path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    try {
      const started = await post("/api/jobs", { request: "Reject late validation.", mode: "validate-only" });
      const body = JSON.stringify({ jobId: started.body.job.id, gateId: "tests", repository });
      const receiving = once(dashboard.server, "request");
      const pendingResponse = new Promise((resolve, reject) => {
        validationRequest = createHttpRequest(new URL("/api/validation/run", url), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        }, (response) => {
          let content = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { content += chunk; });
          response.on("error", reject);
          response.on("end", () => {
            resolve({ status: response.statusCode, body: JSON.parse(content) });
          });
        });
        validationRequest.on("error", reject);
        validationRequest.write(body.slice(0, -1));
      });
      await receiving;
      if (action === "stop") {
        assert.equal((await post("/api/job/stop", {})).response.status, 202);
      } else {
        closing = dashboard.close();
      }
      validationRequest.end(body.slice(-1));
      const rejected = await pendingResponse;
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /current running job/);
      const pending = await jsonRequest(url, "/api/status");
      assert.equal(pending.body.job.status, "running");
      assert.equal(pending.body.job.validation.gates[0].status, "pending");
    } finally {
      validationRequest?.destroy();
      finish?.({ code: null, signal: "SIGTERM" });
      await (closing ?? dashboard.close());
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("dashboard-owned gates suspend agent idle detection and rearm it after success or failure", async () => {
  for (const exitCode of [0, 2]) {
    const repository = createGitRepository();
    writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(validProfile({
      validation: { gates: [{
        id: "tests", command: process.execPath,
        args: ["-e", `setTimeout(()=>process.exit(${exitCode}),1000)`],
        workingDirectory: ".", timeoutSeconds: 30
      }] }
    })));
    let terminated = 0;
    const { dashboard, url } = await startDashboard(repository, () => ({
      completion: new Promise(() => {}),
      terminate() { terminated += 1; }
    }), null, { executionIdleTimeoutMs: 500 });
    try {
      const started = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: "Wait for an owned gate.", mode: "validate-only" })
      });
      const gate = await jsonRequest(url, "/api/validation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: started.body.job.id, gateId: "tests", repository })
      });
      assert.equal(gate.response.status, 200);
      assert.equal(gate.body.status, exitCode);
      assert.equal(terminated, 0);
      const running = await jsonRequest(url, "/api/status");
      assert.equal(running.body.job.status, "running");
      assert.equal(running.body.job.validation.gates[0].status, exitCode === 0 ? "passed" : "failed");
      const evidenceDirectory = running.body.job.validation.gates[0].evidenceDirectory;
      assert.deepEqual(JSON.parse(readFileSync(join(evidenceDirectory, "job.json"), "utf8")), {
        jobId: started.body.job.id, repository: realpathSync.native(repository), gateId: "tests"
      });
      for (let attempt = 0; attempt < 150 && !terminated; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(terminated, 1);
      const stopped = await jsonRequest(url, "/api/status");
      assert.match(stopped.body.job.error, /produced no output/);
    } finally {
      await dashboard.close();
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("dashboard PR strategies publish after local gates without waiting for remote CI", () => {
  for (const pullRequestStrategy of ["per-bug", "common"]) {
    const prompt = buildJobPrompt({
      request: "Fix the reported behavior.",
      mode: "fix-and-validate",
      requestType: "bug-fix",
      pullRequestStrategy
    });
    assert.match(prompt, /required local validation and approval gates/);
    assert.match(prompt, /publish the authorized PR by marking it ready for review/);
    assert.match(prompt, /Do not wait for remote PR CI or build completion before publication/);
    assert.match(prompt, /Verify the PR is no longer draft before reporting the PR stage passed/);
    assert.match(prompt, /Report remote checks as pending, not passed, and leave merge policies intact/);
    assert.match(prompt, /If publication or state verification fails, report the PR stage blocked or failed/);
    assert.match(prompt, /gh pr ready <number>/);
    assert.match(prompt, /az repos pr update --id <id> --draft false/);
  }
});

test("validate-only prompt protects product source and prohibits publication", () => {
  const prompt = buildJobPrompt({
    request: "Check the current behavior.",
    mode: "validate-only",
    requestType: "bug-fix"
  });

  assert.match(prompt, /Do not edit files other than job-owned transient Playwright journeys and runner evidence/);
  assert.match(prompt, /create commits/);
  assert.match(prompt, /create pull requests/);
  assert.match(prompt, /Do not create commits, push branches, create pull requests, or update pull requests/);
  assert.match(prompt, /fix and pr stages must be explicitly skipped/);
  assert.match(prompt, /FIXLAB_ACTIVITY\|stage\|summary/);
  assert.match(prompt, /not hidden chain-of-thought/);
  assert.match(prompt, /Do not publish a pull request or change its draft status in read-only mode/);
  assert.doesNotMatch(prompt, /publish the authorized PR by marking it ready for review/);
  assert.doesNotMatch(prompt, /gh pr ready|az repos pr update/);
});

test("selected non-production data falls back to synthetic only when required", () => {
  const prompt = buildJobPrompt({
    request: "Validate result rendering against DEV data.",
    mode: "validate-only",
    requestType: "bug-fix",
    targetEnvironment: "dev",
    testEvidence: {
      enabled: true,
      source: "non-production-read-only",
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    }
  });

  assert.match(prompt, /Use the selected dev backend and API as the primary/);
  assert.match(prompt, /Do not fulfill or intercept business-data reads while the selected backend is available/);
  assert.match(prompt, /returns no safe records capable of exercising/);
  assert.match(prompt, /fall back to synthetic-intercepted data/);
  assert.match(prompt, /Do not replace an expected empty-state assertion with synthetic data/);
  assert.match(prompt, /FIXLAB_TEST with source synthetic-intercepted and mutation mode intercepted/);
  assert.match(prompt, /A synthetic pass proves the UI behavior only/);
  assert.match(prompt, /do not claim the selected backend or its data was validated/);
});

test("scenario-first browser recovery applies across modes without overriding deferred or API contracts", () => {
  for (const mode of ["playwright-only", "validate-only", "fix-and-validate"]) {
    const prompt = buildJobPrompt({ request: "Validate the remap behavior.", mode });
    assert.match(prompt, /Scenario-first validation/u);
    assert.match(prompt, /not a setup check, sign-in or screenshot alone/u);
    assert.match(prompt, /repair its syntax\/selectors/u);
    assert.match(prompt, /discoverable \.spec file in a job-owned folder/u);
    assert.match(prompt, /configured testDir; honor testMatch\/project/u);
    assert.match(prompt, /Verify --list before execution/u);
    assert.match(prompt, /report file path, runner command and assertion results/u);
    assert.match(prompt, /approved synthetic\/intercepted data/u);
    assert.match(prompt, /Finish independent scenarios before asking/u);
    assert.match(prompt, /never use another checkout to prove an unpublished fix/u);
  }
  for (const overrides of [
    { testEvidence: { apiOnly: true } },
    { testEvidence: { unitTestsOnly: true } },
    { skipLiveTests: true },
    { deferValidation: true, workflow: { publication: "draft" } }
  ]) {
    assert.doesNotMatch(buildJobPrompt({
      request: "Preserve the selected validation contract.", mode: "fix-and-validate", ...overrides
    }), /Scenario-first validation/u);
  }
});

test("live-first recovery cannot offer synthetic fallback when interception is disabled", () => {
  for (const evidence of [
    { mutationMode: "none", selectedMutationMode: "none" },
    { mutationMode: "intercepted", selectedMutationMode: "none" },
    { mutationMode: "intercepted", enabled: false }
  ]) {
    const prompt = buildJobPrompt({
      request: "Validate using approved reads only.", mode: "playwright-only", targetEnvironment: "dev",
      testEvidence: { enabled: true, source: "non-production-read-only", ...evidence }
    });
    assert.doesNotMatch(prompt, /then fall back to synthetic-intercepted data/u);
    assert.match(prompt, /This run does not permit synthetic interception/u);
    assert.match(prompt, /block only dependent scenarios/u);
  }
});

test("backend-first prompt guidance requires environment and read-only source", () => {
  const withoutEnvironment = buildJobPrompt({
    request: "Validate result rendering.",
    mode: "validate-only",
    requestType: "bug-fix",
    testEvidence: {
      enabled: true,
      source: "non-production-read-only",
      mutationMode: "intercepted",
      requireScenarioEvidence: true
    }
  });
  assert.doesNotMatch(
    withoutEnvironment,
    /backend and API as the primary business-data source/
  );

  const withoutReadOnlySource = buildJobPrompt({
    request: "Validate result rendering against DEV data.",
    mode: "validate-only",
    requestType: "bug-fix",
    targetEnvironment: "dev",
    testEvidence: {
      enabled: true,
      source: "profile-defined",
      mutationMode: "profile-defined",
      requireScenarioEvidence: true
    }
  });
  assert.doesNotMatch(
    withoutReadOnlySource,
    /backend and API as the primary business-data source/
  );
});

test("dashboard rejects validation environments outside the profile allowlist", async () => {
  const repository = createRepository();
  const { dashboard, url } = await startDashboard(repository, () => {
    throw new Error("executor should not run");
  });

  try {
    for (const targetEnvironment of ["uat", "production"]) {
      const result = await jsonRequest(url, "/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: "Validate the selected environment.",
          mode: "playwright-only",
          targetEnvironment
        })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error, /targetEnvironment/);
    }
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("playwright-only prompt skips review and runs only required browser steps", () => {
  const prompt = buildJobPrompt({
    request: "Validate the Hold option in the browser.",
    mode: "playwright-only",
    requestType: "bug-fix"
  });

  assert.match(prompt, /Run a FixLab playwright-only job/);
  assert.match(prompt, /^FixLab output protocol/);
  assert.match(prompt, /Never defer or batch stage markers/);
  assert.match(prompt, /minimum setup required by the repository profile/);
  assert.match(prompt, /verify browser authentication/);
  assert.match(prompt, /focused Playwright journey/);
  assert.match(prompt, /Skip source diagnosis, separate reproduction, implementation, diff review/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /Do not reinstall dependencies that are already available/);
  assert.match(
    prompt,
    /diagnosis, reproduce, fix, review, and pr stages must be explicitly skipped/
  );
});

test("browser-only instructions are bounded and retain request, policy and execution evidence", () => {
  const request = "Validate 50 synthetic rows using 50 distinct units. Keep names alphanumeric.";
  const browser = buildJobPrompt({
    request, mode: "playwright-only", targetEnvironment: "dev"
  });
  const full = buildJobPrompt({
    request, mode: "fix-and-validate", targetEnvironment: "dev"
  });
  for (const prompt of [browser, full]) {
    assert.match(prompt, /page\.screenshot\(\{ path, fullPage: true \}\)/u);
    assert.match(prompt, /Default to unmasked full-page screenshots of approved portal pages/u);
    assert.match(prompt, /Do not blanket-mask the page or ask again for default screenshot capture/u);
    assert.match(prompt, /job-owned transient wrapper/u);
    assert.match(prompt, /Explicit repository privacy rules and genuinely sensitive content/u);
    assert.match(prompt, /API-only and unit-test-only runs require no browser screenshot/u);
  }
  assert.ok(browser.length < full.length * 0.6, `${browser.length} must be less than 60% of ${full.length}`);
  assert.ok(browser.length < 9500);
  assert.ok(browser.endsWith(request));
  assert.match(browser, /parameterized deterministic Playwright script/);
  assert.match(browser, /Keep the same-job script/);
  assert.match(browser, /all applicable repository instructions/);
  assert.match(browser, /No Save, Submit, Approve, autosave/);
  assert.match(browser, /Do not copy browser state or credentials/);
  assert.match(browser, /FIXLAB_TEST/);
  assert.match(browser, /FIXLAB_BUG/);
  assert.doesNotMatch(browser, /early-draft|commit and push|--draft false/);
});

test("API-only guidance retains safety and evidence across runtime and initialized agent entry points", () => {
  const prompt = buildJobPrompt({
    request: "Validate the read-only API.", mode: "playwright-only",
    testEvidence: configuredTestSynthesis(apiProfile())
  });
  assert.match(prompt, /APIRequestContext/);
  assert.match(prompt, /synthetic responses never prove a live API passed/);
  for (const path of [
    "../agents/fixlab.md",
    "../com.github.copilot/agents/fixlab.agent.md",
    "../templates/fixlab-autofix.agent.md",
    "../.github/agents/fixlab-autofix.agent.md",
    "../.github/agents/fixlab.agent.md"
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const phrase of ["APIRequestContext", "dataSafety.allowedOrigins", "allowedMethods", "page.route", "FIXLAB_TEST", "at most 120 words", "required headings/fields"]) {
      assert.ok(source.includes(phrase), `${path} must include ${phrase}`);
    }
  }
  const cliSource = readFileSync(new URL("../bin/fixlab.js", import.meta.url), "utf8");
  assert.match(cliSource, /profile\.browserAutomation\?\.mode === "api" \? \[API_ONLY_PLAYWRIGHT_GUIDANCE\]/);
  assert.match(cliSource, /!readOnly \? \[CONCISE_PR_GUIDANCE\]/);
  const editingPrompt = buildJobPrompt({ request: "Fix a defect.", mode: "fix-and-validate" });
  assert.match(editingPrompt, /Keep PR descriptions concise, normally at most 120 words/);
  assert.match(editingPrompt, /Preserve every required template heading\/field/);
  assert.match(editingPrompt, /Keep failed, skipped, pending and not-run checks explicit/);
  assert.match(readFileSync(new URL("../prompts/fixlab.pr.prompt.md", import.meta.url), "utf8"), /at most 120 words/);
});

test("PR guidance excludes usage statistics across generated and packaged entry points", () => {
  const prompt = buildJobPrompt({ request: "Fix a defect.", mode: "fix-and-validate" });
  const guidance = /Exclude token\/cache counts, AI-credit totals and model-cost summaries from PR\s+descriptions/;
  assert.match(prompt, guidance);
  for (const path of [
    "../agents/fixlab.md",
    "../com.github.copilot/agents/fixlab.agent.md",
    "../templates/fixlab-autofix.agent.md",
    "../.github/agents/fixlab-autofix.agent.md",
    "../.github/agents/fixlab.agent.md",
    "../prompts/fixlab.pr.prompt.md"
  ]) {
    assert.match(readFileSync(new URL(path, import.meta.url), "utf8"), guidance, path);
  }
});

test("small-enhancement prompt uses the risk-scaled fast path", () => {
  const prompt = buildJobPrompt({
    request: "Add a compact optional label.",
    mode: "fix-and-validate",
    requestType: "small-enhancement"
  });

  assert.match(prompt, /Request type: small-enhancement/);
  assert.match(prompt, /concise acceptance contract/);
  assert.match(prompt, /affected surface/);
  assert.match(prompt, /Do not manufacture a failing defect reproduction/);
  assert.match(prompt, /smallest existing focused test/);
  assert.match(prompt, /Skip broad test suites and full builds/);
  assert.match(prompt, /review, live-test, and pull-request evidence/);
  assert.match(prompt, /make no unrelated changes/);
});

test("browser preflight blocks unchanged retries before model execution and survives restart", async () => {
  const repository = createGitRepository();
  let busy = true;
  const calls = [];
  const options = { browserOwnership: () => busy ? {
    kind: "browser-profile-busy", pids: [777],
    message: "Synthetic browser PID 777 owns the configured profile. Close that test browser before retry."
  } : null };
  let resolveCompletion;
  const executor = (input) => {
    calls.push(input);
    return { completion: new Promise((resolve) => { resolveCompletion = resolve; }),
      terminate() { resolveCompletion({ code: 0 }); } };
  };
  const first = await startDashboard(repository, executor, undefined, options);
  let id;
  try {
    const result = await jsonRequest(first.url, "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic browser-only admission check.",
        requestType: "bug-fix", mode: "playwright-only" })
    });
    id = result.body.job.id;
    assert.equal(result.body.job.status, "blocked");
    assert.equal(result.body.job.browserBlocker.kind, "browser-profile-busy");
    assert.equal(result.body.job.stages.pr.status, "skipped");
    assert.equal(result.body.job.usage.inputTokens, 0);
    assert.equal(calls.length, 0);
    const retry = await jsonRequest(first.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "The user says to retry, but the owner has not exited." })
    });
    assert.equal(retry.response.status, 409);
    assert.equal(calls.length, 0);
    assert.equal((await jsonRequest(first.url, "/api/job")).body.job.inputCount, 0);
  } finally {
    await first.dashboard.close();
  }
  const second = await startDashboard(repository, executor, undefined, options);
  try {
    assert.equal((await jsonRequest(second.url, "/api/job")).body.job.id, id);
    busy = false;
    const retry = await jsonRequest(second.url, "/api/job/input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "The synthetic owner exited." })
    });
    assert.equal(retry.response.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resume, false, "no model session existed before browser admission");
    assert.equal(calls[0].mode, "playwright-only");
  } finally {
    await second.dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("browser-only resume retains scope, scripts and environment instead of PR lifecycle", async () => {
  const repository = createRepository();
  const calls = [];
  const { dashboard, url } = await startDashboard(repository, (input) => {
    calls.push(input);
    for (const stage of FIXLAB_STAGES) {
      input.onOutput("stdout", `FIXLAB_STAGE|${stage}|${stage === "live-test" ? "blocked" : "skipped"}|Synthetic browser prerequisite\n`);
    }
    return { completion: Promise.resolve({ code: 0 }), terminate() {} };
  });
  try {
    await jsonRequest(url, "/api/jobs", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Preserve exactly 50 synthetic rows; no writes.",
        requestType: "bug-fix", mode: "playwright-only", targetEnvironment: "dev" }) });
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await jsonRequest(url, "/api/job")).body.job.canResume) { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await jsonRequest(url, "/api/job/input", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", details: "Retry the focused browser step." }) });
    assert.equal(result.response.status, 202);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, true);
    assert.match(calls[1].prompt, /Browser-only continuation/);
    assert.match(calls[1].prompt, /Selected validation environment: dev/);
    assert.match(calls[1].prompt, /exactly 50 synthetic rows; no writes/);
    assert.match(calls[1].prompt, /Do not perform implementation, review, commits, push, pull-request creation/);
    assert.match(calls[1].prompt, /Keep the same-job test script/);
    assert.match(calls[1].prompt, /it does not prohibit job-owned transient Playwright journeys/u);
    assert.match(calls[1].prompt, /Normal runtime permissions, prior denials/u);
    assert.doesNotMatch(calls[1].prompt, /Reuse an existing pull request|Reuse the completed diagnosis/);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("held browser-admission-only work starts a fresh executor after the profile is released", async () => {
  const repository = createRepository();
  let busy = true;
  let resumed;
  let finish;
  const { dashboard, url } = await startDashboard(repository, (input) => {
    resumed = input;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 0 }); } };
  }, undefined, { browserOwnership: () => busy ? {
    kind: "browser-profile-busy", pids: [777], message: "Synthetic profile owner is running."
  } : null });
  const post = (path, body) => jsonRequest(url, path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/api/jobs", { request: "Synthetic held browser check",
      requestType: "bug-fix", mode: "playwright-only" });
    const jobId = created.body.job.id;
    assert.equal((await post("/api/jobs/hold", { jobId })).response.status, 202);
    busy = false;
    const result = await post("/api/jobs/resume", { jobId });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.queued, false);
    assert.equal(resumed.resume, false);
    assert.equal(resumed.sessionId, jobId);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("repository setup API binds reviewed writes to its owner and opens an idle workspace without interrupting the current job", async () => {
  const repository = createGitRepository();
  const another = createGitRepository();
  let launches = 0;
  let finish;
  const { dashboard, url } = await startDashboard(repository, () => {
    launches++;
    return { completion: new Promise((resolve) => { finish = resolve; }),
      terminate() { finish({ code: 130 }); } };
  });
  let childUrl;
  try {
    const instanceId = (await jsonRequest(url, "/api/status")).body.instanceId;
    const configure = (body, origin = url) => jsonRequest(url, "/api/repository/configuration", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ instanceId, ...body })
    });
    assert.equal((await configure({ action: "inspect" }, "http://untrusted.invalid")).response.status, 403);
    assert.equal((await configure({ action: "inspect", instanceId: "stale-owner" })).response.status, 409);
    const inspected = (await configure({ action: "inspect" })).body;
    const preview = await configure({ action: "preview", repository,
      revision: inspected.revision, values: { ...inspected.values, name: "Reviewed repository name" }, install: false });
    assert.equal(preview.response.status, 200, preview.body.error);
    assert.equal(preview.body.profile, undefined);
    const unverifiable = createSessionRegistry(createCacheContext(repository)?.repositoryIdentityHash ?? repository);
    const reusedPort = createHttpServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "different-port-owner" }));
    });
    await new Promise((resolve) => reusedPort.listen(0, "127.0.0.1", resolve));
    unverifiable.register(`http://127.0.0.1:${reusedPort.address().port}`);
    try {
      const before = readFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), "utf8");
      const blockedOwner = await configure({ action: "apply", planId: preview.body.planId, confirmed: true });
      assert.equal(blockedOwner.response.status, 400);
      assert.match(blockedOwner.body.error, /Cannot verify every registered owner/);
      assert.equal(readFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), "utf8"), before);
      const blockedOpen = await configure({ action: "open", repository, confirmed: true });
      assert.equal(blockedOpen.response.status, 400);
      assert.match(blockedOpen.body.error, /Cannot verify every registered owner/);
    } finally {
      unverifiable.unregister();
      reusedPort.closeIdleConnections();
      await new Promise((resolve) => reusedPort.close(resolve));
    }
    const apply = await configure({ action: "apply", planId: preview.body.planId, confirmed: true });
    assert.equal(apply.response.status, 200, apply.body.error);
    assert.equal(apply.body.saved, true);
    assert.equal((await configure({ action: "apply", planId: preview.body.planId, confirmed: true })).response.status, 400);
    const started = await jsonRequest(url, "/api/jobs", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "Synthetic existing run", mode: "validate-only" }) });
    assert.equal(started.response.status, 202);
    const latest = (await configure({ action: "inspect" })).body;
    const blockedPlan = (await configure({ action: "preview", repository,
      revision: latest.revision, values: { ...latest.values, name: "Must not change while running" }, install: false })).body;
    const blocked = await configure({ action: "apply", planId: blockedPlan.planId, confirmed: true });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.body.error, /active executor/);
    assert.equal((await configure({ action: "inspect" })).body.values.name, "Reviewed repository name");
    const [opened, concurrentOpen] = await Promise.all([
      configure({ action: "open", repository: another, confirmed: true }),
      configure({ action: "open", repository: another, confirmed: true })
    ]);
    assert.equal(opened.response.status, 200, opened.body.error);
    assert.equal(concurrentOpen.response.status, 200, concurrentOpen.body.error);
    childUrl = opened.body.url;
    assert.equal(concurrentOpen.body.url, childUrl);
    assert.equal(opened.body.startedJob, false);
    assert.equal((await jsonRequest(childUrl, "/api/status")).body.job, null);
    assert.equal((await configure({ action: "open", repository: another, confirmed: true })).body.url, childUrl);
    assert.equal((await jsonRequest(url, "/api/status")).body.job.id, started.body.job.id);
    assert.equal(launches, 1);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(another, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`${childUrl}/api/status`, { signal: AbortSignal.timeout(1000) }));
});

test("authentication connection rejects a busy profile or failed ownership inspection without spawning", async () => {
  const repository = createRepository();
  const profile = validProfile();
  profile.browserAutomation.authentication = { required: true,
    command: "node should-not-run.js", statusPaths: ["synthetic-profile"] };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  mkdirSync(join(repository, "synthetic-profile"));
  let failInspection = false;
  const { dashboard, url } = await startDashboard(repository,
    () => { throw new Error("No executor should start"); }, undefined, {
      browserOwnership() {
        if (failInspection) { throw new Error("Synthetic inspection failure"); }
        return { kind: "browser-profile-busy", pids: [777], message: "Synthetic browser is busy." };
      }
    });
  try {
    const busy = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(busy.response.status, 409);
    assert.equal(busy.body.blocker.kind, "browser-profile-busy");
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.running, false);
    failInspection = true;
    const failed = await jsonRequest(url, "/api/playwright/connect", { method: "POST" });
    assert.equal(failed.response.status, 409);
    assert.match(failed.body.error, /Browser preflight failed: Synthetic inspection failure/);
    assert.equal((await jsonRequest(url, "/api/playwright/status")).body.running, false);
  } finally {
    await dashboard.close();
    rmSync(repository, { recursive: true, force: true });
  }
});
