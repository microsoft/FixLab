import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileIssuePlan, executeBrowserPlan, executeTracePlan, issuePlanConfiguration, issuePlanContext } from "../dashboard/issue-plans.js";
import Reporter from "../bin/issue-plan-reporter.js";

function fixture(t) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-issue-plan-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  mkdirSync(join(repository, "browser", "journeys"), { recursive: true });
  writeFileSync(join(repository, "browser", "fixture.mjs"), "export const test = {};\n");
  writeFileSync(join(repository, "browser", "config.mjs"), "export default {};\n");
  writeFileSync(join(repository, "browser", "package.json"), '{"type":"module"}');
  const policy = { id: "app-traces", environment: "dev",
    subscriptionId: "12345678-1234-1234-1234-123456789abc",
    applicationId: "23456789-1234-1234-1234-123456789abc", maxWindowMinutes: 30, maxRows: 10 };
  const profile = {
    environments: ["dev", "sit"], applications: { frontend: { healthUrl: "http://localhost:3000" } },
    analysis: { traceQueries: [policy] },
    browserAutomation: { workingDirectory: "browser", testSynthesis: { enabled: true,
      issuePlans: { fixture: "browser/fixture.mjs", config: "browser/config.mjs", directory: "browser/journeys" } } }
  };
  const options = { environment: "dev" };
  const configuration = issuePlanConfiguration(repository, profile, "dev");
  const trace = { version: 1, kind: "trace", workItemId: 42, environment: "dev", source: policy.id,
    policyRevision: configuration.traces[0].policyRevision,
    start: "2026-11-19T10:00:00Z", end: "2026-11-19T10:15:00Z",
    table: "traces", filter: { field: "payload.RequestId", op: "eq", value: "request-42" }, limit: 5 };
  const browser = { version: 1, kind: "playwright", workItemId: 42, environment: "dev",
    policyRevision: configuration.browser.policyRevision, title: "Issue 42 preserves the selected name",
    steps: [{ action: "goto", path: "/requests" },
      { action: "fill", target: { by: "label", value: "Name" }, value: "New name" },
      { action: "click", target: { by: "role", role: "button", name: "Apply" } },
      { action: "assertValue", target: { by: "label", value: "Name" }, value: "New name" }] };
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  return { repository, profile, policy, options, trace, browser, configuration };
}

test("issue-driven trace compilation binds source, environment, revision, window and metadata projection", t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  assert.match(compiled.query, /parse_json\(tostring\(customDimensions\["Payload"\]\)\)\["RequestId"\]/u);
  assert.match(compiled.query, /take 6$/u);
  assert.doesNotMatch(compiled.query.split("| project")[1], /Payload|message/u);
  const injected = '" | app("outside").traces | take 999 //';
  const literal = compileIssuePlan(f.repository, f.profile, {
    ...f.trace, filter: { field: "message", op: "contains", value: injected }
  }, f.options);
  assert.ok(literal.query.includes(JSON.stringify(injected)));
  for (const change of [{ query: "traces" }, { environment: "sit" }, { policyRevision: "old" },
    { table: "externaldata" }, { limit: 11 }, { start: "2026-01-01T00:00:00Z" },
    { end: "2026-11-19T09:00:00Z" }, { filter: { field: "message", op: "evaluate", value: "x" } },
    { start: "2026-02-30T10:00:00Z", end: "2026-02-30T10:15:00Z" },
    { filter: { field: 'payload.X"] | take 99', op: "eq", value: "x" } }]) {
    assert.throws(() => compileIssuePlan(f.repository, f.profile, { ...f.trace, ...change }, f.options));
  }
  const changed = structuredClone(f.profile);
  changed.analysis.traceQueries[0].maxRows = 9;
  assert.throws(() => compileIssuePlan(f.repository, changed, f.trace, f.options), /revision/u);
});

test("production lookup requires a separately selected policy and explicit opt-in before authentication", t => {
  const f = fixture(t);
  f.profile.analysis.traceQueries[0].environment = "production";
  const configuration = issuePlanConfiguration(f.repository, f.profile, "dev");
  assert.equal(configuration.traces.length, 0);
  assert.doesNotMatch(issuePlanContext(configuration), /subscriptionId|applicationId/u);
  assert.throws(() => compileIssuePlan(f.repository, f.profile, { ...f.trace, environment: "production" }, f.options), /unavailable/u);
  const approved = issuePlanConfiguration(f.repository, f.profile, "dev", true);
  const plan = { ...f.trace, environment: "production", policyRevision: approved.traces[0].policyRevision };
  assert.equal(compileIssuePlan(f.repository, f.profile, plan, { ...f.options, allowProductionEvidence: true }).policy.environment, "production");
  assert.throws(() => compileIssuePlan(f.repository, { ...f.profile, validation: { liveTestsRequired: false } },
    plan, { ...f.options, allowProductionEvidence: true }), /Unit-test-only/u);
});

test("trace transport sends bounded compiled KQL once and preserves only metadata with truthful truncation", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  let calls = 0;
  const row = ["2026-11-19T10:01:00Z", "0123456789abcdef", null, 3];
  const response = rows => new Response(JSON.stringify({
    tables: [{ columns: compiled.columns.map(name => ({ name })), rows }]
  }));
  const request = async (url, options) => {
    calls += 1;
    assert.ok(url.endsWith(`/${f.policy.applicationId}/query`));
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer unit-test-placeholder");
    assert.equal(JSON.parse(options.body).query, compiled.query);
    return response([row]);
  };
  const options = { tokenProvider: async subscription => { assert.equal(subscription, f.policy.subscriptionId); return "unit-test-placeholder"; }, request };
  assert.equal((await executeTracePlan(compiled, options)).status, "passed");
  assert.equal(calls, 1);
  const hierarchical = ["2026-11-19T10:01:00Z", "root-42", "|root-42.span_1.", 3];
  const legacy = await executeTracePlan(compiled, { ...options, request: async () => response([hierarchical]) });
  assert.deepEqual(legacy.rows, [hierarchical]);
  const encoded = ["2026-11-19T10:01:00Z", "x/Ysh+M1TfU=", "|x/Ysh+M1TfU=.span_1.", 3];
  assert.deepEqual((await executeTracePlan(compiled, {
    ...options, request: async () => response([encoded])
  })).rows, [encoded]);
  const partial = await executeTracePlan(compiled, { ...options, request: async () => response(Array.from({ length: 6 }, () => row)) });
  assert.equal(partial.status, "partial");
  assert.equal(partial.rows.length, 5);
  for (const request of [
    async () => new Response("sensitive raw denial", { status: 403 }),
    async () => { throw new Error("sensitive transport details"); },
    async () => new Response(JSON.stringify({ error: { message: "partial query" }, tables: [] })),
    async () => new Response("x".repeat(262145)),
    async () => response([["2026-11-19T10:01:00Z", "Bearer sensitive-data", null, 3]])
  ]) {
    let attempted = 0;
    await assert.rejects(executeTracePlan(compiled, { ...options, request: async (...args) => { attempted += 1; return request(...args); } }),
      error => !/sensitive|raw denial/u.test(error.message));
    assert.equal(attempted, 1);
  }
});

test("trace request and dependency success accepts canonical wire booleans without truthy coercion", async t => {
  const f = fixture(t);
  for (const table of ["requests", "dependencies"]) {
    const compiled = compileIssuePlan(f.repository, f.profile, { ...f.trace, table }, f.options);
    const response = success => new Response(JSON.stringify({ tables: [
      { columns: compiled.columns.map(name => ({ name })),
        rows: [["2026-11-19T10:01:00Z", "root-42", "|root-42.span_1.", success, "500"]] }
    ] }));
    for (const [wire, expected] of [[true, true], [false, false], ["True", true], ["False", false],
      ["true", true], ["false", false], [null, null]]) {
      const result = await executeTracePlan(compiled, {
        tokenProvider: async () => "unit-test-placeholder", request: async () => response(wire)
      });
      assert.equal(result.rows[0][3], expected);
    }
    for (const wire of ["", " false ", "private-token", 0, 1, {}, []]) {
      await assert.rejects(executeTracePlan(compiled, {
        tokenProvider: async () => "unit-test-placeholder", request: async () => response(wire)
      }), { message: "Trace response contained unsupported metadata in success: expected a boolean or canonical true/false string; no rows accepted." });
    }
  }
});

test("trace metadata rejection identifies only the trusted column and reason without leaking values", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  const row = ["2026-11-19T10:01:00Z", "0123456789abcdef", null, 3];
  const cases = [
    [0, null, "timestamp", "expected a non-null timestamp"],
    [0, "private-invalid-time", "timestamp", "expected a valid UTC timestamp of at most 40 characters"],
    [1, 123, "operation_Id", "expected a string of at most 160 characters"],
    [1, "private-value".repeat(20), "operation_Id", "expected a string of at most 160 characters"],
    [2, "Bearer private-token", "operation_ParentId", "credential-shaped identifier"],
    [2, "private-value\n", "operation_ParentId", "unsupported identifier format"],
    [3, 5, "severityLevel", "expected an integer from 0 to 4"]
  ];
  for (const [index, value, column, reason] of cases) {
    const invalid = [...row];
    invalid[index] = value;
    let calls = 0;
    await assert.rejects(executeTracePlan(compiled, {
      tokenProvider: async () => "unit-test-placeholder",
      request: async () => {
        calls += 1;
        return new Response(JSON.stringify({ tables: [
          { columns: compiled.columns.map(name => ({ name })), rows: [row, invalid] }
        ] }));
      }
    }), { message: `Trace response contained unsupported metadata in ${column}: ${reason}; no rows accepted.` });
    assert.equal(calls, 1);
  }
});

test("trace correlation IDs reject credential shapes before output without rejecting legacy Base64 IDs", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"synthetic"}').toString("base64url")}.synthetic-signature`;
  for (const credential of [
    `AccountKey=${Buffer.alloc(64, 42).toString("base64")}`,
    `Authorization:Basic:${encoded}`, "Authorization=Bearer=synthetic-token",
    "token=synthetic-token", "client_secret=synthetic-secret", "api_key=synthetic-key",
    `ghp_${"A".repeat(36)}`, jwt, `Basic:${encoded}`, `basic=${encoded.replace(/=+$/u, "")}`,
    "Bearer:synthetic-token", "|root.BEARER=synthetic-token"
  ]) {
    for (const index of [1, 2]) {
      const row = ["2026-11-19T10:01:00Z", "x/Ysh+M1TfU=", "|x/Ysh+M1TfU=.span_1.", 3];
      row[index] = credential;
      const column = compiled.columns[index];
      await assert.rejects(executeTracePlan(compiled, {
        tokenProvider: async () => "unit-test-placeholder",
        request: async () => new Response(JSON.stringify({ tables: [
          { columns: compiled.columns.map(name => ({ name })), rows: [row] }
        ] }))
      }), { message: `Trace response contained unsupported metadata in ${column}: credential-shaped identifier; no rows accepted.` });
    }
  }
});

test("trace transport validates original UTC timestamps before calendar normalization", async t => {
  const f = fixture(t);
  f.policy.maxRows = 20;
  const configuration = issuePlanConfiguration(f.repository, f.profile, "dev");
  const compiled = compileIssuePlan(f.repository, f.profile, { ...f.trace,
    policyRevision: configuration.traces[0].policyRevision,
    start: "2026-03-02T10:00:00Z", end: "2026-03-02T10:15:00Z", limit: 20
  }, f.options);
  for (const timestamp of ["2026-02-30T10:01:00Z", "2026-03-02T11:01:00+01:00"]) {
    await assert.rejects(executeTracePlan(compiled, {
      tokenProvider: async () => "unit-test-placeholder",
      request: async () => new Response(JSON.stringify({ tables: [
        { columns: compiled.columns.map(name => ({ name })), rows: [
          ...Array.from({ length: 10 }, () => ["2026-03-02T10:01:00Z", "op-42", null, 3]),
          [timestamp, "op-42", null, 3]
        ] }
      ] }))
    }), /valid UTC timestamp/u);
  }
});

test("trace diagnostics expose only reviewed route and message literals and disclose omissions", async t => {
  const f = fixture(t);
  f.profile.analysis.traceQueries[0].diagnostics = {
    endpoints: ["GET /v1/items/lookup"], messages: ["Backend request failed."]
  };
  const configuration = issuePlanConfiguration(f.repository, f.profile, "dev");
  for (const table of ["requests", "dependencies", "traces", "exceptions"]) {
    const compiled = compileIssuePlan(f.repository, f.profile, {
      ...f.trace, table, policyRevision: configuration.traces[0].policyRevision
    }, f.options);
    const endpoint = ["requests", "dependencies"].includes(table);
    assert.match(compiled.query, endpoint ? /endpoint = name/u
      : table === "traces" ? /logMessage = message/u : /logMessage = outerMessage/u);
    const base = ["2026-11-19T10:01:00Z", "op-42", null,
      ...(endpoint ? [false, "500"] : table === "exceptions" ? [3, "System.Exception"] : [3])];
    const approved = endpoint ? "GET /v1/items/lookup" : "Backend request failed.";
    const result = await executeTracePlan(compiled, {
      tokenProvider: async () => "unit-test-placeholder",
      request: async () => new Response(JSON.stringify({ tables: [
        { columns: compiled.columns.map(name => ({ name })), rows: [
          [...base, approved], [...base, "private@example.test https://private.example.test?token=private-value".repeat(100)]
        ] }
      ] }))
    });
    assert.equal(result.rows[0].at(-1), approved);
    assert.equal(result.rows[1].at(-1), null);
    assert.equal(result.traceEvidence.omittedDiagnostics, 1);
    assert.equal(result.traceEvidence.rows[0][endpoint ? "endpoint" : "logMessage"], approved);
    assert.doesNotMatch(JSON.stringify(result), /private@example|private\.example|private-value/u);
  }
  assert.throws(() => compileIssuePlan(f.repository, f.profile, f.trace, f.options), /revision/u);
  const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64").replace(/=+$/u, "");
  for (const message of ["Authorization: Bearer private-value", "Bearer:synthetic-token",
    `Basic:${encoded}`, `basic=${encoded}`, "AccountKey=synthetic-key"]) {
    f.profile.analysis.traceQueries[0].diagnostics.messages = [message];
    assert.throws(() => issuePlanConfiguration(f.repository, f.profile, "dev"), /credential/u);
  }
});

test("browser plans generate runnable grounded actions and non-leaking assertions, not arbitrary scripts", t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.browser, f.options);
  const cleared = { ...f.browser, steps: [
    { action: "fill", target: { by: "label", value: "Name" }, value: "" },
    { action: "assertValue", target: { by: "label", value: "Name" }, value: "" }
  ] };
  assert.match(compileIssuePlan(f.repository, f.profile, cleared, f.options).source, /\.fill\(""\)/u);
  assert.match(compiled.source, /getByLabel\("Name", \{ exact: true \}\)\.fill\("New name"\)/u);
  assert.match(compiled.source, /expect\.poll/u);
  assert.doesNotMatch(compiled.source, /skip|fulfill|storageState/u);
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: compiled.source, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const steps of [
    [{ action: "goto", path: "//outside.example.test" }],
    [{ action: "evaluate", target: { by: "label", value: "Name" }, value: "process.exit(0)" }],
    [{ action: "click", target: { by: "role", role: "button", name: "Apply" } }],
    [{ action: "assertVisible", target: { by: "label", value: "Name" }, value: "silently-ignored" }]
  ]) {
    assert.throws(() => compileIssuePlan(f.repository, f.profile, { ...f.browser, steps }, f.options));
  }
  writeFileSync(join(f.repository, "browser", "fixture.mjs"), "export const test = { changed: true };\n");
  assert.throws(() => compileIssuePlan(f.repository, f.profile, f.browser, f.options), /revision/u);
});

test("browser execution requires local dependencies and ignored files, and cleans only its own artifacts", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.browser, f.options);
  await assert.rejects(executeBrowserPlan(f.repository, compiled), /missing/u);
  const module = join(f.repository, "browser", "node_modules", "@playwright", "test");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "package.json"), '{"exports":{"./cli":"./cli.js"}}');
  writeFileSync(join(module, "cli.js"), "");
  const git = spawnSync("git", ["init", f.repository], { encoding: "utf8", windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  await assert.rejects(executeBrowserPlan(f.repository, compiled), /Git-ignored/u);
  writeFileSync(join(f.repository, ".gitignore"), "browser/journeys/*\n");
  const existing = join(f.repository, "browser", "journeys", "existing.spec.mjs");
  writeFileSync(existing, "// existing user test\n");
  let ran = false;
  const result = await executeBrowserPlan(f.repository, compiled, { runner: async (_cli, args, _cwd, environment) => {
    ran = true;
    assert.equal(environment.FIXLAB_TARGET_ENVIRONMENT, "dev");
    assert.ok(args.includes("--forbid-only"));
    const config = args[args.indexOf("--config") + 1];
    assert.match(readFileSync(config, "utf8"), /retries: 0/u);
    assert.equal(readdirSync(compiled.browser.directory).length, 4);
    assert.equal(environment.FIXLAB_ISSUE_DEV_WRITES, "0");
    return { status: "failed", failedStep: 4, exitCode: 1 };
  } });
  assert.equal(ran, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(readdirSync(compiled.browser.directory), ["existing.spec.mjs"]);
  assert.equal(existsSync(existing), true);
  await assert.rejects(executeBrowserPlan(f.repository, compiled, { runner: async () => {
    throw Object.assign(new Error("Termination not confirmed"), { code: "FIXLAB_EXECUTION_NOT_QUIESCENT" });
  } }), /Termination not confirmed/u);
  assert.equal(readdirSync(compiled.browser.directory).length, 4,
    "Unconfirmed termination retains owned files instead of deleting a running test.");
});

test("the private reporter distinguishes executed, skipped and failed scenarios", () => {
  const reporter = new Reporter();
  reporter.onStepEnd(null, null, { title: "issue-step-4", error: {} });
  reporter.onTestEnd(null, { status: "failed" });
  reporter.onTestEnd(null, { status: "skipped" });
  assert.equal(reporter.result.failedStep, 4);
  assert.deepEqual(reporter.result, { total: 2, passed: 0, failed: 1, skipped: 1, failedStep: 4 });
});

test("DEV write capability is explicit, invocation-scoped and never available to traces or another environment", t => {
  const f = fixture(t);
  assert.throws(() => compileIssuePlan(f.repository, f.profile, f.browser, { ...f.options, allowDevWrites: true }), /DEV writes/u);
  f.profile.browserAutomation.testSynthesis.issuePlans.allowDevWrites = true;
  const browser = { ...f.browser, policyRevision: issuePlanConfiguration(f.repository, f.profile, "dev").browser.policyRevision };
  assert.equal(compileIssuePlan(f.repository, f.profile, browser, f.options).devWrites, false);
  assert.equal(compileIssuePlan(f.repository, f.profile, browser, { ...f.options, allowDevWrites: true }).devWrites, true);
  assert.throws(() => compileIssuePlan(f.repository, f.profile, f.trace, { ...f.options, allowDevWrites: true }), /DEV writes/u);
  const sit = { ...browser, environment: "sit",
    policyRevision: issuePlanConfiguration(f.repository, f.profile, "sit").browser.policyRevision };
  assert.throws(() => compileIssuePlan(f.repository, f.profile, sit, { environment: "sit", allowDevWrites: true }), /DEV writes/u);
});

test("CLI preview reads bounded stdin plans without authenticating or running a browser", t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "issue-plan", f.repository, "--environment", "dev", "--plan", "-"], {
    encoding: "utf8", input: JSON.stringify(f.trace), timeout: 20000,
    env: { ...process.env, DEBUG: "", PWDEBUG: "", NODE_DEBUG: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "compiled");
  const oversized = spawnSync(process.execPath, [cli, "issue-plan", f.repository, "--environment", "dev", "--plan", "-"], {
    encoding: "utf8", input: " ".repeat(65537), timeout: 20000,
    env: { ...process.env, DEBUG: "", PWDEBUG: "", NODE_DEBUG: "" }
  });
  assert.notEqual(oversized.status, 0);
});
