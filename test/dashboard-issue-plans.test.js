import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileIssuePlan, executeBrowserPlan, executeTracePlan, issuePlanConfiguration, issuePlanContext, normalizeTraceEvidence, SOURCE_GUIDED_ANALYSIS, verifyTracePlanApproval } from "../dashboard/issue-plans.js";
import Reporter from "../bin/issue-plan-reporter.js";
import { createHash } from "node:crypto";
import { claimErrorPreviewApproval, readErrorPreviewApproval, sanitizeErrorPreview } from "../dashboard/error-preview.js";

test("single-record error preview requires exact fresh approval and never exports raw diagnostics", async t => {
  const f = fixture(t);
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const plan = { ...f.trace, limit: 1, filter: { field: "operation_Id", op: "eq", value: "private-operation" } };
  const approval = { version: 1, workItemId: 42, source: plan.source, planHash: hash(plan),
    policyRevision: plan.policyRevision, profileHash: hash(f.profile),
    timestamp: "2026-11-19T10:01:00.000Z", expiresAt: new Date(Date.now() + 600000).toISOString(), maxCharacters: 200 };
  const options = { ...f.options, errorPreviewApproval: approval };
  const compiled = compileIssuePlan(f.repository, f.profile, plan, options);
  assert.deepEqual(compiled.columns, ["timestamp", "severityLevel", "logMessage"]);
  assert.match(compiled.query, /timestamp == datetime\(2026-11-19T10:01:00.000Z\) and severityLevel >= 3/u);
  assert.doesNotMatch(compiled.query.split("| project")[1], /operation_Id|Payload|customDimensions/u);
  for (const change of [{ planHash: "0".repeat(64) }, { workItemId: 43 }, { profileHash: "0".repeat(64) },
    { timestamp: "2026-11-19T10:16:00.000Z" }, { expiresAt: "2000-01-01T00:00:00.000Z" },
    { maxCharacters: 201 }]) {
    assert.throws(() => compileIssuePlan(f.repository, f.profile, plan, {
      ...options, errorPreviewApproval: { ...approval, ...change }
    }), /single-record approval/u);
  }
  assert.equal(compileIssuePlan(f.repository, f.profile, plan, f.options).errorPreview, undefined);
  const body = rows => new Response(JSON.stringify({ tables: [{
    columns: compiled.columns.map(name => ({ name })), rows
  }] }));
  const raw = "HTTP 400 Bad Request for user alice@example.test at https://private.invalid/a?secret=value";
  const request = async () => body([[approval.timestamp, 3, raw]]);
  await assert.rejects(executeTracePlan(compiled, { tokenProvider: () => "synthetic", request }), /revalidation/u);
  const transport = { tokenProvider: () => "synthetic", request, verifyApproval: () => {} };
  const result = await executeTracePlan(compiled, transport);
  assert.deepEqual(result.columns, ["timestamp", "error"]);
  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0][1], /HTTP 400 Bad Request/u);
  assert.doesNotMatch(JSON.stringify(result), /alice@|private.invalid|secret=value|operation|severityLevel|traceEvidence/u);
  assert.equal(result.errorPreview.redacted, true);
  for (const rows of [[[approval.timestamp, 2, "Wrong severity."]],
    [["2026-11-19T10:02:00Z", 3, "Wrong record."]],
    [["2026-11-19T10:01:00.0000001Z", 3, "Wrong sub-millisecond record."]],
    [[approval.timestamp, 3, "First"], [approval.timestamp, 3, "Ambiguous"]]]) {
    await assert.rejects(executeTracePlan(compiled, { ...transport, request: async () => body(rows) }), /no messages accepted/u);
  }
  const preciseApproval = { ...approval, timestamp: "2026-11-19T10:01:00.0001234Z" };
  const precise = compileIssuePlan(f.repository, f.profile, plan, { ...options, errorPreviewApproval: preciseApproval });
  assert.ok(precise.query.includes(`datetime(${preciseApproval.timestamp})`));
  const preciseResult = await executeTracePlan(precise, {
    ...transport, request: async () => body([[preciseApproval.timestamp, 3, "HTTP 400 Bad Request."]])
  });
  assert.deepEqual(preciseResult.rows, [[preciseApproval.timestamp, "HTTP 400 Bad Request."]]);
  let attempts = 0;
  await assert.rejects(executeTracePlan(compiled, { ...transport, request: async () => {
    attempts++;
    throw Object.assign(new Error("private"), { code: "ECONNRESET" });
  } }), /after 1 attempt/u);
  assert.equal(attempts, 1);
  const path = join(f.repository, "reviewed-preview.json");
  writeFileSync(path, JSON.stringify(approval));
  const record = readErrorPreviewApproval(path);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/fixlab.js", import.meta.url)),
    "issue-plan", f.repository, "--environment", "dev", "--plan", "-", "--error-preview-approval", path], {
    input: JSON.stringify(plan), encoding: "utf8", timeout: 30000
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).query, compiled.query);
  claimErrorPreviewApproval(record);
  assert.throws(() => claimErrorPreviewApproval(record), /EEXIST/u);
});

test("error preview redacts before truncating and omits payloads, credentials and stack traces", () => {
  for (const value of ['Error: {"password":"private"}', "Error password=private", "Error\n at Private.Frame()",
    "<xml>private</xml>", "Bearer private", "Error eyJhbGciOiJIUzI1NiJ9.private.signature"]) {
    assert.equal(sanitizeErrorPreview(value).message, null);
  }
  const result = sanitizeErrorPreview("HTTP 500 failed for 'private-record' 12345678-1234-1234-1234-123456789abc " +
    "customer abc123 file C:\\private\\secret.txt. " + "retry ".repeat(100));
  assert.ok(result.message.length <= 200);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.message, /private-record|12345678|abc123|C:\\private/u);
  assert.equal(sanitizeErrorPreview("HTTP 400 Bad Request.").message, "HTTP 400 Bad Request.");
  assert.equal(sanitizeErrorPreview("Can't complete the request.").message, "Can't complete the request.");
  assert.equal(sanitizeErrorPreview("Error 'unclosed-private-value").message, null);
});

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

test("trace read recovery retries only transient failures with the same approved request", async t => {
  for (const failure of ["ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN", 503, 429]) {
    const f = fixture(t);
    const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
    const original = structuredClone(compiled);
    const attempts = [];
    const delays = [];
    let tokens = 0;
    const result = await executeTracePlan(compiled, {
      tokenProvider: async () => { tokens += 1; return "unit-test-placeholder"; },
      wait: async milliseconds => { delays.push(milliseconds); },
      request: async (url, options) => {
        attempts.push({ url, method: options.method, redirect: options.redirect,
          headers: options.headers, body: options.body });
        if (attempts.length === 1) {
          compiled.query = "unapproved query";
          compiled.policy.applicationId = "unapproved-application";
          if (typeof failure === "number") {
            return new Response("private denial body", { status: failure, headers: { "retry-after": "0" } });
          }
          throw new TypeError("private transport details", { cause: { code: failure } });
        }
        return new Response(JSON.stringify({ tables: [
          { columns: original.columns.map(name => ({ name })),
            rows: [["2026-11-19T10:01:00Z", "op-42", null, 3]] }
        ] }));
      }
    });
    assert.equal(result.status, "passed");
    assert.equal(result.recovery.attempts, 2);
    assert.equal(tokens, 1);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 0 && delays[0] <= 2000);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(JSON.parse(attempts[1].body).query, original.query);
    assert.ok(attempts[1].url.endsWith(`/${original.policy.applicationId}/query`));
    assert.doesNotMatch(JSON.stringify(result), /private|unapproved/u);
  }
});

test("trace read recovery stops at two attempts and reports sanitized missing evidence", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  let calls = 0;
  await assert.rejects(executeTracePlan(compiled, {
    tokenProvider: async () => "unit-test-placeholder", wait: async () => {},
    request: async () => {
      calls += 1;
      throw new TypeError("Bearer private-token https://private.example.test", { cause: { code: "ECONNRESET" } });
    }
  }), error => error.code === "TRACE_READ_CONNECTION_RESET" && error.attempts === 2 &&
    /2 attempts.*no rows accepted.*diagnostic evidence is still missing/u.test(error.message) &&
    !/private|Bearer|https:/u.test(error.message));
  assert.equal(calls, 2);
});

test("trace read recovery does not bypass denial, redirects, TLS, throttling or changed approval", async t => {
  const f = fixture(t);
  const compiled = compileIssuePlan(f.repository, f.profile, f.trace, f.options);
  for (const failure of [
    async () => new Response("private denial", { status: 401 }),
    async () => new Response("private denial", { status: 403 }),
    async () => new Response("private redirect", { status: 302 }),
    async () => new Response("private throttling", { status: 429, headers: { "retry-after": "120" } }),
    async () => new Response("private throttling", { status: 503, headers: { "retry-after": "invalid" } }),
    async () => new Response("private throttling", { status: 503, headers: { "retry-after": "-1" } }),
    async () => { throw new TypeError("private details", { cause: { message: "unexpected redirect" } }); },
    async () => { throw new TypeError("private details", { cause: { code: "CERT_HAS_EXPIRED" } }); },
    async () => { throw Object.assign(new Error("private details", { cause: { code: "CERT_HAS_EXPIRED" } }),
      { name: "TimeoutError" }); },
    async () => ({ status: 503, headers: new Headers(), body: {
      cancel: async () => { throw new Error("private cleanup failure"); }
    } }),
    async () => { throw new Error("private unknown failure"); }
  ]) {
    let calls = 0;
    let waits = 0;
    await assert.rejects(executeTracePlan(compiled, {
      tokenProvider: async () => "unit-test-placeholder",
      wait: async () => { waits += 1; },
      request: async () => { calls += 1; return failure(); }
    }), error => !/private/u.test(error.message));
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
  let calls = 0;
  await assert.rejects(executeTracePlan(compiled, {
    tokenProvider: async () => "unit-test-placeholder",
    verifyApproval: () => verifyTracePlanApproval(f.repository, f.profile, f.trace, f.options, compiled),
    wait: async () => {
      const changed = structuredClone(f.profile);
      changed.analysis.traceQueries[0].maxRows = 9;
      writeFileSync(join(f.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(changed));
    },
    request: async () => { calls += 1; return new Response("", { status: 503 }); }
  }), error => error.code === "TRACE_READ_APPROVAL_CHANGED" && error.attempts === 1);
  assert.equal(calls, 1);
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

test("URL-shape plans select reviewed source fields without widening default or production projections", t => {
  const f = fixture(t);
  const shape = { id: "outbound-lookup", table: "traces", field: "customDimensions.RequestUri", term: "ItemNumber eq '" };
  f.policy.diagnostics = { urlShapes: [shape] };
  const configuration = issuePlanConfiguration(f.repository, f.profile, "dev");
  const plan = { ...f.trace, policyRevision: configuration.traces[0].policyRevision };
  const ordinary = compileIssuePlan(f.repository, f.profile, plan, f.options);
  assert.doesNotMatch(ordinary.query, /RequestUri|observedUrl/u);
  const compiled = compileIssuePlan(f.repository, f.profile, { ...plan, urlShape: shape.id }, f.options);
  assert.match(compiled.query, /observedUrlLength = iff\(isempty\(tostring\(customDimensions\["RequestUri"\]\)\), long\(null\), strlen/u);
  assert.match(compiled.query, /observedUrlTermCount = iff\(isempty\(url_decode/u);
  assert.ok(compiled.query.includes(`countof(url_decode(tostring(customDimensions["RequestUri"])), ${JSON.stringify(shape.term)}, "normal")`));
  assert.deepEqual(compiled.columns.slice(-2), ["observedUrlLength", "observedUrlTermCount"]);
  assert.ok(!compiled.columns.includes("RequestUri"));
  for (const change of [{ urlShape: "unreviewed" }, { urlShape: { field: "url" } },
    { urlShape: shape.id, table: "dependencies" }, { projection: ["url"] }]) {
    assert.throws(() => compileIssuePlan(f.repository, f.profile, { ...plan, ...change }, f.options));
  }
  for (const invalid of [{ ...shape, field: 'customDimensions.X"] | take 99' },
    { ...shape, field: "message" }, { ...shape, table: "requests", field: "data" },
    { ...shape, term: "Authorization=Bearer synthetic-secret" },
    { ...shape, term: 'Item" | take 99' }, { ...shape, unknown: true }]) {
    f.policy.diagnostics.urlShapes = [invalid];
    assert.throws(() => issuePlanConfiguration(f.repository, f.profile, "dev"));
  }
  f.policy.diagnostics.urlShapes = [shape, shape];
  assert.throws(() => issuePlanConfiguration(f.repository, f.profile, "dev"), /unique/u);
  for (const [table, field] of [["requests", "url"], ["dependencies", "data"], ["exceptions", "payload.RequestUri"]]) {
    f.policy.diagnostics.urlShapes = [{ id: shape.id, table, field }];
    const policy = issuePlanConfiguration(f.repository, f.profile, "dev").traces[0];
    const result = compileIssuePlan(f.repository, f.profile, {
      ...plan, table, policyRevision: policy.policyRevision, urlShape: shape.id
    }, f.options);
    assert.equal(result.columns.at(-1), "observedUrlLength");
    assert.doesNotMatch(result.query, /observedUrlTermCount/u);
  }
  f.policy.environment = "production";
  f.policy.diagnostics.urlShapes = [shape];
  const production = issuePlanConfiguration(f.repository, f.profile, "dev", true).traces[0];
  assert.throws(() => compileIssuePlan(f.repository, f.profile, {
    ...plan, environment: "production", policyRevision: production.policyRevision, urlShape: shape.id
  }, f.options), /unavailable/u);
  assert.match(SOURCE_GUIDED_ANALYSIS, /excluded projection does not prove a value was not logged/u);
  assert.match(SOURCE_GUIDED_ANALYSIS, /same approved UTC window/u);
  assert.match(SOURCE_GUIDED_ANALYSIS, /outbound client\/configuration proves/u);
  assert.match(issuePlanContext(configuration), /Null means not captured\/decodable, not zero/u);
});

test("URL-shape transport preserves numeric evidence and unknowns but rejects raw or forged diagnostics", async t => {
  const f = fixture(t);
  const shape = { id: "outbound-lookup", table: "traces", field: "customDimensions.RequestUri", term: "ItemNumber eq '" };
  f.policy.diagnostics = { urlShapes: [shape] };
  const policy = issuePlanConfiguration(f.repository, f.profile, "dev").traces[0];
  const compiled = compileIssuePlan(f.repository, f.profile, {
    ...f.trace, policyRevision: policy.policyRevision, urlShape: shape.id
  }, f.options);
  const base = ["2026-11-19T10:01:00Z", "op-42", null, 1];
  const execute = measurements => executeTracePlan(compiled, {
    tokenProvider: async () => "unit-test-placeholder",
    request: async () => new Response(JSON.stringify({ tables: [
      { columns: compiled.columns.map(name => ({ name })), rows: measurements.map(values => [...base, ...values]) }
    ] }))
  });
  const result = await execute([[2056, 51], [null, null], [42, 0], [42, null]]);
  assert.deepEqual(result.traceEvidence.rows.map(row => row.urlShape), [
    { id: shape.id, characterCount: 2056, termCount: 51 },
    { id: shape.id, characterCount: null, termCount: null },
    { id: shape.id, characterCount: 42, termCount: 0 },
    { id: shape.id, characterCount: 42, termCount: null }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /RequestUri|https?:|ItemNumber|itemCount/u);
  for (const invalid of [["https://private.example.test?token=private", 1], ["2056", 51],
    [NaN, 1], [-1, 0], [16777217, 0], [1.5, 0], [null, 1], [1, 2]]) {
    await assert.rejects(execute([invalid]), error => /URL-shape/u.test(error.message) && !/private/u.test(error.message));
  }
  const evidence = result.traceEvidence;
  for (const invalid of [{ id: "unreviewed", characterCount: 42 }, { id: shape.id, characterCount: 42 },
    { id: shape.id, characterCount: 42, termCount: 1, url: "private" }]) {
    assert.throws(() => normalizeTraceEvidence({ ...evidence, rows: [
      { ...evidence.rows[0], urlShape: invalid }
    ] }, policy));
  }
  assert.throws(() => normalizeTraceEvidence(evidence, { ...policy, diagnostics: { urlShapes: [] } }), /approved measurement/u);
});

test("changing a reviewed URL-shape source invalidates the plan before authentication", async t => {
  const f = fixture(t);
  f.policy.diagnostics = { urlShapes: [{ id: "outbound", table: "traces", field: "customDimensions.RequestUri" }] };
  const policy = issuePlanConfiguration(f.repository, f.profile, "dev").traces[0];
  const plan = { ...f.trace, policyRevision: policy.policyRevision, urlShape: "outbound" };
  const compiled = compileIssuePlan(f.repository, f.profile, plan, f.options);
  f.policy.diagnostics.urlShapes[0].field = "customDimensions.OtherUri";
  writeFileSync(join(f.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(f.profile));
  await assert.rejects(executeTracePlan(compiled, {
    verifyApproval: () => verifyTracePlanApproval(f.repository, f.profile, plan, f.options, compiled),
    tokenProvider: () => assert.fail("Changed measurement must stop before authentication."),
    request: () => assert.fail("Changed measurement must stop before dispatch.")
  }), error => error.code === "TRACE_READ_APPROVAL_CHANGED" && error.attempts === 0);
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
