import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createDevPostTool, createDevWriteApproval, createPpeWriteApproval, createPostBaseApproval, createPostWriteApproval, createNonProductionPostAccess } from "../dashboard/dev-post.js";
import { forwardApprovedBrowserPost, forwardApprovedBrowserRequest, startBrowserPostBridge } from "../dashboard/browser-post.js";
import { runCopilotSession } from "../dashboard/copilot-session.js";
import { createRuntimeRequestBridge, runtimeRequestId } from "../dashboard/runtime-requests.js";

function fixture(t, overrides = {}) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-dev-post-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  const path = join(repository, ".github", "fixlab", "repository-profile.json");
  const helper = join(repository, "session.mjs");
  writeFileSync(helper, 'export async function withApiToken(options, run) { await run("synthetic-value"); }\n');
  const url = "https://api.dev.example.test/items";
  const profile = {
    environments: ["DEV"], browserAutomation: {
      testSynthesis: { defaultDataSource: "non-production-approved", mutationMode: "approved-write" },
      dataSafety: { productionAllowed: false,
        devPost: { scope: "api://example-service/access", sessionHelper: "session.mjs",
          actions: [{ url, testRecord: { field: "name", value: "FIXLAB_TEST_001" } }] } }
    }
  };
  const save = () => writeFileSync(path, JSON.stringify(profile));
  save();
  const prompts = [];
  const requests = [];
  const args = { url, payload: { name: "FIXLAB_TEST_001", enabled: true }, purpose: "Verify synthetic item creation" };
  const settings = { repository, targetEnvironment: "DEV", mutationMode: "approved-write", isReady: () => true,
    async ask(prompt) { prompts.push(prompt); return { action: "allow" }; },
    async request(target, options) {
      requests.push({ target, options });
      return new Response(null, { status: 201 });
    }, ...overrides };
  return { repository, path, helper, url, profile, save, prompts, requests, args, settings,
    tool: () => createDevPostTool(settings) };
}

function approveOrigins(state, environment = "DEV") {
  const key = environment.toLowerCase();
  if (!state.profile.environments.includes(environment)) { state.profile.environments.push(environment); }
  state.profile.browserAutomation.dataSafety[`${key}Write`] = {
    scope: "api://example-service/access", sessionHelper: "session.mjs",
    origins: [`https://api.${key}.example.test`]
  };
  state.save();
  Object.assign(state.settings, {
    jobId: "11111111-1111-4111-8111-111111111111", allowPostRequests: true, targetEnvironment: environment
  });
  state.settings.postWriteApproval = (environment === "PPE" ? createPpeWriteApproval : createDevWriteApproval)(
    state.repository, environment, state.settings.jobId);
  return state.tool();
}

function approvePostBase(state, environment = "PPE") {
  const key = environment.toLowerCase();
  if (!state.profile.environments.includes(environment)) { state.profile.environments.push(environment); }
  state.postBase = `https://api.shared.example.test/api/${key}/v1`;
  state.profile.browserAutomation.dataSafety.post ??= {};
  state.profile.browserAutomation.dataSafety.post[key] = {
    scope: "api://example-service/access", sessionHelper: "session.mjs", baseUrls: [state.postBase]
  };
  state.save();
  Object.assign(state.settings, {
    jobId: "11111111-1111-4111-8111-111111111111", allowPostRequests: true, targetEnvironment: environment
  });
  state.settings.postWriteApproval = createPostBaseApproval(state.repository, environment, state.settings.jobId);
  return state.tool();
}

function browserRoute(state, overrides = {}) {
  const fulfilled = [];
  const aborted = [];
  return {
    fulfilled, aborted,
    request: () => ({
      method: () => "POST", url: () => state.args.url,
      headers: () => ({ "content-type": "application/json" }),
      postData: () => JSON.stringify(state.args.payload),
      ...overrides
    }),
    async fulfill(reply) { fulfilled.push(reply); },
    async abort(reason) { aborted.push(reason); }
  };
}

async function browserAccess(t, state) {
  const access = createNonProductionPostAccess(state.settings);
  const bridge = await startBrowserPostBridge({
    send: access.browserRequest ?? access.browserPost, serializeRequests: Boolean(access.browserRequest),
    revoke: access.revoke, jobId: state.settings.jobId,
    environment: state.settings.targetEnvironment.toLowerCase(), request: state.settings.request
  });
  t.after(() => bridge.close());
  return access;
}

test("browser POST relay reuses exact endpoint/test-record consent and existing authentication without exposing bodies to the tool", async (t) => {
  const state = fixture(t);
  Object.assign(state.settings, {
    allowPostRequests: true, jobId: "11111111-1111-4111-8111-111111111111"
  });
  state.settings.postWriteApproval = createPostWriteApproval(state.repository, "DEV", state.settings.jobId);
  const received = [];
  state.settings.request = async (target, options) => {
    received.push({ target, options });
    return new Response('{"id":"synthetic-record","enabled":true}', {
      status: 201, headers: { "content-type": "application/json", "set-cookie": "must-not-be-relayed" }
    });
  };
  await browserAccess(t, state);
  const route = browserRoute(state);
  const result = await forwardApprovedBrowserPost(route, { environment: "DEV", purpose: state.args.purpose });
  assert.equal(received.length, 1);
  assert.equal(received[0].options.headers.Authorization, "Bearer synthetic-value");
  assert.equal(received[0].options.redirect, "manual");
  assert.equal(route.fulfilled[0].body.toString(), '{"id":"synthetic-record","enabled":true}');
  assert.equal(result.validationPassed, false);
  assert.equal(result.responseBodyReturned, false);
  assert.equal(JSON.stringify(result).includes("synthetic-record"), false);
  assert.equal(JSON.stringify(route.fulfilled).includes("must-not-be-relayed"), false);
  assert.equal(state.prompts.length, 0);
  const invalid = browserRoute(state, { postData: () => '{"name":"ordinary-record"}' });
  await assert.rejects(forwardApprovedBrowserPost(invalid, { environment: "DEV", purpose: state.args.purpose }),
    /Browser POST failed: POST endpoint or test record/u);
  assert.deepEqual(invalid.aborted, ["blockedbyclient"]);
  assert.equal(received.length, 1);
});

test("PPE browser scenarios load, save and verify real response data with serialized GET and POST under one grant", async (t) => {
  const state = fixture(t);
  approveOrigins(state, "PPE");
  state.args.url = "https://api.ppe.example.test/records";
  let name = "original";
  let active = 0;
  let maximumActive = 0;
  state.settings.request = async (target, options) => {
    state.requests.push({ target, options });
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (options.method === "POST") { name = JSON.parse(options.body).name; }
    active--;
    return new Response(JSON.stringify({ name }), {
      status: options.method === "POST" ? 201 : 200,
      headers: { "content-type": "application/json" }
    });
  };
  const access = await browserAccess(t, state);
  const readRoute = () => browserRoute(state, {
    method: () => "GET", headers: () => ({}), postData: () => null
  });
  const reads = [readRoute(), readRoute(), readRoute()];
  await Promise.all(reads.map((route) => forwardApprovedBrowserRequest(route, {
    environment: "PPE", purpose: "Load approved PPE records."
  })));
  assert.equal(maximumActive, 1);
  assert.equal(JSON.parse(reads[0].fulfilled[0].body).name, "original");
  const write = browserRoute(state);
  await forwardApprovedBrowserRequest(write, { environment: "PPE", purpose: state.args.purpose });
  const verify = readRoute();
  const result = await forwardApprovedBrowserRequest(verify, {
    environment: "PPE", purpose: "Verify the approved saved PPE record."
  });
  assert.equal(JSON.parse(verify.fulfilled[0].body).name, state.args.payload.name);
  assert.deepEqual(state.requests.map(({ options }) => options.method), ["GET", "GET", "GET", "POST", "GET"]);
  assert.equal(state.requests[0].options.body, undefined);
  assert.equal(state.requests[0].options.headers.Authorization, "Bearer synthetic-value");
  assert.equal(result.source, "non-production-read-only");
  assert.equal(result.mutationMode, "none");
  assert.equal(result.validationPassed, false);
  assert.equal(result.responseBodyReturned, false);
  for (const change of [
    { method: () => "GET" },
    { method: () => "HEAD", postData: () => null },
    { url: () => "https://api.dev.example.test/records" },
    { url: () => "https://api.ppe.example.test.evil.invalid/records" }
  ]) {
    const invalid = browserRoute(state, change);
    await assert.rejects(forwardApprovedBrowserRequest(invalid, { environment: "PPE", purpose: state.args.purpose }));
    assert.deepEqual(invalid.aborted, ["blockedbyclient"]);
  }
  await assert.rejects(access.browserRequest({ ...state.args, method: "GET" }, state.settings.request), /requires/);
  assert.equal(state.requests.length, 5);
  assert.equal(state.prompts.length, 0);
});

test("slow serialized PPE requests retain their grant when queue time exceeds the dispatch timeout", { timeout: 35000 }, async (t) => {
  const state = fixture(t);
  approveOrigins(state, "PPE");
  state.args.url = "https://api.ppe.example.test/records";
  let active = 0;
  let maximumActive = 0;
  state.settings.request = async (target, options) => {
    state.requests.push({ target, options });
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (state.requests.length <= 2) {
        await delay(12000, undefined, { signal: options.signal });
      }
      return new Response(null, { status: 201 });
    } finally {
      active--;
    }
  };
  const access = await browserAccess(t, state);
  const routes = [browserRoute(state), browserRoute(state)];
  await Promise.all(routes.map(route => forwardApprovedBrowserRequest(route, {
    environment: "PPE", purpose: state.args.purpose
  })));
  assert.equal(maximumActive, 1);
  assert.ok(routes.every(route => route.fulfilled.length === 1 && route.aborted.length === 0));
  await access.tool.handler({ ...state.args, method: "POST" });
  assert.equal(state.requests.length, 3);
});

test("an unsuccessful PPE browser read revokes queued writes without retry or broadening POST-only grants", async (t) => {
  const state = fixture(t);
  approveOrigins(state, "PPE");
  state.args.url = "https://api.ppe.example.test/records";
  state.settings.request = async (target, options) => {
    state.requests.push({ target, options });
    return new Response(null, { status: 500 });
  };
  const access = await browserAccess(t, state);
  const results = await Promise.allSettled([
    forwardApprovedBrowserRequest(browserRoute(state, {
      method: () => "GET", headers: () => ({}), postData: () => null
    }), { environment: "PPE", purpose: "Read approved PPE records." }),
    forwardApprovedBrowserRequest(browserRoute(state), { environment: "PPE", purpose: state.args.purpose })
  ]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  assert.deepEqual(state.requests.map(({ options }) => options.method), ["GET"]);
  await assert.rejects(access.tool.handler({ ...state.args, method: "POST" }), /approval has stopped/);
});

for (const environment of ["DEV", "PPE"]) {
test(`PPE journey helpers cannot expand ${environment} POST-only grants to GET or PUT`, async (t) => {
  const state = fixture(t);
  approvePostBase(state, environment);
  state.args.url = `${state.postBase}/records`;
  const access = await browserAccess(t, state);
  assert.equal(access.browserRequest, null);
  for (const method of ["GET", "PUT"]) {
    await assert.rejects(forwardApprovedBrowserRequest(browserRoute(state, {
      method: () => method, headers: () => ({}), postData: () => null
    }), { environment, purpose: state.args.purpose }));
  }
  assert.equal(state.requests.length, 0);
});
}

for (const environment of ["DEV", "SIT", "UAT", "PPE"]) {
test(`browser POST relay enforces ${environment} API bases and rejects mismatched jobs, methods and environments`, async (t) => {
  const state = fixture(t);
  approvePostBase(state, environment);
  state.args.url = `${state.postBase}/items`;
  await browserAccess(t, state);
  await forwardApprovedBrowserPost(browserRoute(state), { environment, purpose: state.args.purpose });
  assert.equal(state.requests.length, 1);
  for (const change of ["method", "destination", "environment", "job", "key", "debug"]) {
    const previousKey = process.env.FIXLAB_BROWSER_POST_KEY;
    const previousJob = process.env.FIXLAB_BROWSER_POST_JOB;
    const route = browserRoute(state, change === "method" ? { method: () => "PUT" } :
      change === "destination" ? { url: () => `${state.postBase}-other/items` } : {});
    try {
      if (change === "job") { process.env.FIXLAB_BROWSER_POST_JOB = "22222222-2222-4222-8222-222222222222"; }
      if (change === "key") { process.env.FIXLAB_BROWSER_POST_KEY = "0".repeat(64); }
      if (change === "debug") { process.env.NODE_DEBUG = "http"; }
      await assert.rejects(forwardApprovedBrowserPost(route, {
        environment: change === "environment" ? "PROD" : environment, purpose: state.args.purpose
      }));
      assert.deepEqual(route.aborted, ["blockedbyclient"], change);
    } finally {
      process.env.FIXLAB_BROWSER_POST_KEY = previousKey;
      process.env.FIXLAB_BROWSER_POST_JOB = previousJob;
      delete process.env.NODE_DEBUG;
    }
  }
  assert.equal(state.requests.length, 1);
});
}

test("browser and native POST share failure revocation and changed helper/profile rejection", async (t) => {
  for (const failure of ["http", "ambiguous", "oversized-response", "helper", "profile", "stopped"]) {
    const state = fixture(t);
    approvePostBase(state, "DEV");
    state.args.url = `${state.postBase}/items`;
    let attempts = 0;
    let ready = true;
    state.settings.isReady = () => ready;
    state.settings.request = async () => {
      attempts++;
      if (failure === "ambiguous") { throw new Error("private-upstream-error"); }
      return new Response(failure === "oversized-response" ? "x".repeat(1024 * 1024 + 1) : null,
        { status: 302 });
    };
    const access = createNonProductionPostAccess(state.settings);
    const bridge = await startBrowserPostBridge({
      send: access.browserPost, revoke: access.revoke, jobId: state.settings.jobId, environment: "dev",
      request: state.settings.request
    });
    try {
      if (failure === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
      if (failure === "profile") { state.profile.name = "Changed"; state.save(); }
      if (failure === "stopped") { ready = false; }
      const route = browserRoute(state);
      await assert.rejects(forwardApprovedBrowserPost(route, { environment: "DEV", purpose: state.args.purpose }),
        /Browser POST failed:/u);
      await assert.rejects(access.tool.handler(state.args), /stopped|changed|shutdown/u);
      assert.equal(attempts, ["http", "ambiguous", "oversized-response"].includes(failure) ? 1 : 0, failure);
      assert.equal(route.fulfilled.length, 0);
    } finally {
      await bridge.close();
    }
  }
});

test("native and browser POST cannot race one approved attempt and closing the relay revokes both", async (t) => {
  const state = fixture(t);
  approvePostBase(state, "DEV");
  state.args.url = `${state.postBase}/items`;
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let attempts = 0;
  state.settings.request = async () => {
    attempts++;
    started();
    await pending;
    return new Response(null, { status: 201 });
  };
  const access = createNonProductionPostAccess(state.settings);
  const bridge = await startBrowserPostBridge({
    send: access.browserPost, revoke: access.revoke, jobId: state.settings.jobId,
    environment: "dev", request: state.settings.request
  });
  try {
    const operation = forwardApprovedBrowserPost(browserRoute(state), {
      environment: "DEV", purpose: state.args.purpose
    });
    await entered;
    await assert.rejects(access.tool.handler(state.args), /in-flight/u);
    release();
    await operation;
    assert.equal(attempts, 1);
  } finally {
    release();
    await bridge.close();
  }
  await assert.rejects(access.tool.handler(state.args), /approval has stopped/u);
  await assert.rejects(forwardApprovedBrowserPost(browserRoute(state), {
    environment: "DEV", purpose: state.args.purpose
  }));
  assert.equal(attempts, 1);
});

test("browser POST channel exists only with fresh configured job consent and never after session shutdown", async (t) => {
  const state = fixture(t);
  assert.equal(createNonProductionPostAccess(state.settings).browserPost, null);
  const before = process.env.FIXLAB_BROWSER_POST_URL;
  approvePostBase(state, "DEV");
  state.args.url = `${state.postBase}/items`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = state.settings.request;
  t.after(() => { globalThis.fetch = originalFetch; });
  let inherited;
  await runCopilotSession({
    repository: state.repository, sessionId: state.settings.jobId, targetEnvironment: "DEV",
    allowPostRequests: true, postWriteApproval: state.settings.postWriteApproval,
    testMutationMode: "approved-write", prompt: "Verify the synthetic browser POST."
  }, {
    output() {}, async ask() { assert.fail("Current job consent must not prompt again"); },
    client: {
      async start() { inherited = process.env.FIXLAB_BROWSER_POST_URL; },
      async createSession() {
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait({ prompt }) {
            assert.match(prompt, /forwardApprovedBrowserPost/u);
            assert.equal(prompt.includes(process.env.FIXLAB_BROWSER_POST_KEY), false);
            await forwardApprovedBrowserPost(browserRoute(state), { environment: "DEV", purpose: state.args.purpose });
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.match(inherited, /^http:\/\/127\.0\.0\.1:\d+\/post$/u);
  assert.equal(process.env.FIXLAB_BROWSER_POST_URL, before);
  assert.equal(state.requests.length, 1);
  await assert.rejects(forwardApprovedBrowserPost(browserRoute(state), { environment: "DEV", purpose: state.args.purpose }));
});

test("a replacement unchecked executor cannot inherit another job's browser POST channel", async (t) => {
  const state = fixture(t);
  approvePostBase(state, "DEV");
  state.args.url = `${state.postBase}/items`;
  await browserAccess(t, state);
  assert.ok(process.env.FIXLAB_BROWSER_POST_URL);
  await runCopilotSession({
    repository: state.repository, sessionId: "22222222-2222-4222-8222-222222222222",
    targetEnvironment: "DEV", allowPostRequests: false, prompt: "No write consent."
  }, {
    output() {}, async ask() { assert.fail("No action is requested"); },
    client: {
      async start() { assert.equal(process.env.FIXLAB_BROWSER_POST_URL, undefined); },
      async createSession() {
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait({ prompt }) {
            assert.equal(prompt.includes("private job-bound relay"), false);
            await assert.rejects(forwardApprovedBrowserPost(browserRoute(state), {
              environment: "DEV", purpose: state.args.purpose
            }));
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.equal(state.requests.length, 0);
});

for (const environment of ["DEV", "SIT", "UAT", "PPE"]) {
test(`${environment} POST-only approval accepts all scoped paths without granting other methods or shared-host environments`, async (t) => {
  const state = fixture(t);
  writeFileSync(state.helper, `export async function withApiToken(options, run) {
    if (options.environment !== "${environment.toLowerCase()}") { throw new Error("Wrong authentication environment"); }
    await run("synthetic-value");
  }\n`);
  delete state.profile.browserAutomation.dataSafety.devPost;
  const tool = approvePostBase(state, environment);
  assert.equal(tool.name, "fixlab_nonproduction_post");
  assert.equal(tool.parameters.properties.method, undefined);
  for (const [path, payload] of [
    ["queries/search", { filters: [] }], ["items/create", { name: "ANY_PPE_RECORD" }],
    ["items/submit", [{ id: "ordinary-record" }]], ["actions/refresh", undefined]
  ]) {
    const result = await tool.handler({ url: `${state.postBase}/${path}`,
      purpose: "Verify explicitly approved POST.", ...(payload === undefined ? {} : { payload }) });
    assert.equal(result.method, "POST");
    assert.equal(result.validationPassed, false);
    assert.equal(result.responseBodyReturned, false);
  }
  assert.equal(state.prompts.length, 0);
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    await assert.rejects(tool.handler({ ...state.args, url: `${state.postBase}/items`, method }),
      /requires/u);
  }
  for (const url of ["https://api.shared.example.test/api/prod/v1/items",
    `https://api.shared.example.test/api/${environment === "DEV" ? "sit" : "dev"}/v1/items`,
    `${state.postBase}-other/items`, `${state.postBase}/..%2f..%2fprod/items`,
    `${state.postBase}/%252e%252e/prod`, "https://other.api.shared.example.test/items",
    "http://api.shared.example.test/items"]) {
    await assert.rejects(tool.handler({ ...state.args, url }), /approved .* API bases/u);
  }
  assert.equal(state.requests.length, 4);
  assert.ok(state.requests.every(({ options }) => options.method === "POST" && options.redirect === "manual"));
});
}

test("all-POST setup rejects missing, ambiguous or production API bases before approval", (t) => {
  const state = fixture(t);
  approvePostBase(state, "SIT");
  const configuration = state.profile.browserAutomation.dataSafety.post.sit;
  for (const baseUrls of [
    [], ["https://api.shared.example.test/api/uat/v1"],
    ["https://api.uat.example.test/api/sit/v1"],
    ["https://api.shared.example.test/api/prod/sit"],
    ["http://api.shared.example.test/api/sit/v1"],
    ["https://user@api.shared.example.test/api/sit/v1"],
    ["https://api.shared.example.test/api/sit/v1?anything=true"],
    ["https://api.shared.example.test/api/sit/%2fprod"],
    ["https://api.shared.example.test/api/sit/v1/"]
  ]) {
    configuration.baseUrls = baseUrls;
    state.save();
    assert.throws(() => createPostBaseApproval(state.repository, "SIT", state.settings.jobId),
      /base URLs|POST API bases/u);
  }
  delete configuration.baseUrls;
  state.save();
  assert.throws(() => createPostBaseApproval(state.repository, "SIT", state.settings.jobId), /Configure.*baseUrls/u);
});

test("POST API bases normalize environment labels before rejecting conflicting destinations", (t) => {
  for (const [environment, accepted, rejected] of [
    ["PPE", ["https://api.shared.example.test/api/PPE/v1",
      "https://api.shared.example.test/api/PPE-v1"], [
      "https://api.ppe.example.test/api/SIT/v1",
      "https://api.development.example.test/api/ppe/v1",
      "https://api.ppe.example.test/api/Development/v1",
      "https://api.ppe.example.test/api/sit-v1",
      "https://api.ppe.example.test/api/dev_v1",
      "https://api.ppe.example.test/api/Development.v1"
    ]],
    ["DEV", ["https://api.development.example.test/api/DEV/v1",
      "https://api.shared.example.test/api/Development/v1",
      "https://api.shared.example.test/api/dev_v1"], [
      "https://api.development.example.test/api/PPE/v1",
      "https://api.dev.example.test/api/ppe-v1"
    ]]
  ]) {
    const state = fixture(t);
    approvePostBase(state, environment);
    const configuration = state.profile.browserAutomation.dataSafety.post[environment.toLowerCase()];
    for (const base of accepted) {
      configuration.baseUrls = [base];
      state.save();
      assert.doesNotThrow(() => createPostBaseApproval(state.repository, environment, state.settings.jobId), base);
    }
    for (const base of rejected) {
      configuration.baseUrls = [base];
      state.save();
      assert.throws(() => createPostBaseApproval(state.repository, environment, state.settings.jobId),
        /POST API bases/u, base);
    }
  }
});

test("PPE POST-only approval requires fresh matching job, configuration and execution consent", async (t) => {
  for (const change of ["job", "environment", "unchecked", "profile", "helper", "removed"]) {
    const state = fixture(t);
    const tool = approvePostBase(state);
    if (change === "job") { state.settings.jobId = "22222222-2222-4222-8222-222222222222"; }
    if (change === "environment") { state.settings.targetEnvironment = "DEV"; }
    if (change === "unchecked") { state.settings.allowPostRequests = false; }
    if (["job", "environment", "unchecked"].includes(change)) {
      assert.throws(state.tool, /Invalid job-scoped/u);
      continue;
    }
    if (change === "profile") { state.profile.name = "Changed"; }
    if (change === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
    if (change === "removed") { delete state.profile.browserAutomation.dataSafety.post.ppe; }
    state.save();
    await assert.rejects(tool.handler({ ...state.args, url: `${state.postBase}/items` }),
      /changed|not configured/u);
    assert.equal(state.requests.length, 0);
  }
});

test("PPE POST-only approval stops after an unsuccessful request without following redirects", async (t) => {
  const state = fixture(t, { request: async () => new Response(null, { status: 302 }) });
  const tool = approvePostBase(state);
  const args = { ...state.args, url: `${state.postBase}/items` };
  await assert.rejects(tool.handler(args), /HTTP 302.*Approval is spent/u);
  await assert.rejects(tool.handler(args), /approval has stopped/u);
});

test("broad DEV approval supports every write method and any record/path only on exact reviewed origins", async (t) => {
  const state = fixture(t);
  delete state.profile.browserAutomation.dataSafety.devPost;
  const tool = approveOrigins(state);
  assert.equal(tool.name, "fixlab_dev_write");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const args = { url: "https://api.dev.example.test/unlisted/path?record=ordinary-record",
      method, purpose: "Verify explicitly approved DEV writes.",
      ...(method !== "DELETE" ? { payload: method === "PATCH"
        ? [{ op: "replace", path: "/name", value: "ANY_DEV_RECORD" }] : { name: "ANY_DEV_RECORD" } } : {}) };
    const result = await tool.handler(args);
    assert.equal(result.method, method);
    assert.equal(result.validationPassed, false);
    const request = state.requests.at(-1);
    assert.equal(request.options.method, method);
    assert.equal(request.options.redirect, "manual");
    assert.equal(request.options.body, method === "DELETE" ? undefined : JSON.stringify(args.payload));
    assert.equal(result.responseBodyReturned, false);
  }
  assert.equal(state.prompts.length, 0);
  for (const url of [
    "https://api.sit.example.test/items", "https://api.uat.example.test/items",
    "https://api.production.example.test/items", "https://other.api.dev.example.test/items",
    "https://api.dev.example.test.evil.invalid/items", "https://api.dev.example.test:8443/items",
    "http://api.dev.example.test/items", "https://user@api.dev.example.test/items",
    "https://api.dev.example.test/items#fragment"
  ]) {
    await assert.rejects(tool.handler({ ...state.args, url, method: "PUT" }), /approved DEV origins/u, url);
  }
  for (const change of [
    { method: "GET" }, { method: "TRACE" }, { method: "put" },
    { payload: { password: "synthetic-private-value" } }, { payload: { name: "x".repeat(5000) } },
    { headers: { custom: "value" } }
  ]) {
    await assert.rejects(tool.handler({ ...state.args, method: "PUT", ...change }), /requires|sensitive|oversized/u);
  }
  assert.equal(state.requests.length, 4);
});

test("broad DEV approval requires reviewed DEV-only setup and never follows generic tool/POST preferences", async (t) => {
  const state = fixture(t);
  const tool = approveOrigins(state);
  assert.ok(tool);
  const jobId = state.settings.jobId;
  for (const environment of ["SIT", "UAT", "production", "local", ""]) {
    assert.throws(() => createDevWriteApproval(state.repository, environment, jobId), /explicitly selected DEV/u);
  }
  for (const origin of [
    "https://api.sit.example.test", "https://api.uat.example.test", "https://api.example.test",
    "https://api.dev.production.example.test", "https://api.dev.prod.example.test",
    "https://api.dev.uat.example.test", "https://api.dev.example.test/",
    "https://api.dev.ppe.example.test",
    "https://api.dev.example.test/path", "http://api.dev.example.test",
    "https://user@api.dev.example.test", "https://*.dev.example.test"
  ]) {
    state.profile.browserAutomation.dataSafety.devWrite.origins = [origin];
    state.save();
    assert.throws(() => createDevWriteApproval(state.repository, "DEV", jobId), /DEV.*origins/u, origin);
  }
  state.profile.browserAutomation.dataSafety.devWrite.origins = [];
  state.save();
  assert.throws(() => createDevWriteApproval(state.repository, "DEV", jobId), /1-16/u);
  delete state.profile.browserAutomation.dataSafety.devWrite;
  state.save();
  assert.throws(() => createDevWriteApproval(state.repository, "DEV", jobId), /Configure dataSafety\.devWrite/u);
  const noGrant = createDevPostTool({ ...state.settings, postWriteApproval: undefined, toolApprovalMode: "allow-all" });
  assert.equal(noGrant.name, "fixlab_nonproduction_post");
  await assert.rejects(noGrant.handler({ ...state.args, method: "PUT" }), /requires/u);
  assert.equal(state.requests.length, 0);
});

test("broad DEV grants bind the job/profile/helper and preserve stricter validation contracts", async (t) => {
  for (const change of ["job", "environment", "unchecked", "profile", "helper", "removed", "api", "unit", "production"]) {
    const state = fixture(t);
    const tool = approveOrigins(state);
    if (change === "job") { state.settings.jobId = "22222222-2222-4222-8222-222222222222"; }
    if (change === "environment") { state.settings.targetEnvironment = "SIT"; }
    if (change === "unchecked") { state.settings.allowPostRequests = false; }
    if (["job", "environment", "unchecked"].includes(change)) {
      assert.throws(state.tool, /Invalid job-scoped/u);
      continue;
    }
    for (const selectedMutationMode of ["none", "intercepted"]) {
      assert.equal(createDevPostTool({ ...state.settings, selectedMutationMode }), null);
    }
    if (change === "profile") { state.profile.name = "Changed"; }
    if (change === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
    if (change === "removed") { delete state.profile.browserAutomation.dataSafety.devWrite; }
    if (change === "api") { state.profile.browserAutomation.mode = "api"; }
    if (change === "unit") { state.profile.validation = { liveTestsRequired: false }; }
    if (change === "production") { state.profile.browserAutomation.apiAuthentication = { productionDatabaseReadOnly: true }; }
    state.save();
    await assert.rejects(tool.handler({ ...state.args, method: "PUT" }), /changed|not configured|read-only/u);
    assert.equal(state.requests.length, 0);
  }
});

test("broad DEV approval stops after redirects and failed or ambiguous writes", async (t) => {
  for (const status of [302, 401, 500, "network", "auth"]) {
    const state = fixture(t);
    if (status === "auth") {
      writeFileSync(state.helper, 'export async function withApiToken() { throw new Error("synthetic-private-value"); }\n');
    }
    approveOrigins(state);
    const requests = state.requests;
    const failing = createDevPostTool({ ...state.settings, request: async (url, options) => {
      requests.push({ url, options });
      if (status === "network") { throw new Error("synthetic-private-value"); }
      return new Response(null, { status: typeof status === "number" ? status : 200 });
    } });
    await assert.rejects(failing.handler({ ...state.args, method: "DELETE" }), /Approval is spent|no request was sent/u);
    await assert.rejects(failing.handler({ ...state.args, method: "PUT" }), /approval has stopped/u);
    assert.equal(state.requests.length, status === "auth" ? 0 : 1);
  }
});

test("PPE origin grants permit GET and CRUD but never accept DEV grants, mixed hosts or another environment", async (t) => {
  const state = fixture(t);
  state.args.url = "https://api.ppe.example.test/records";
  const tool = approveOrigins(state, "PPE");
  assert.equal(tool.name, "fixlab_ppe_write");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const result = await tool.handler({ ...state.args, ...(method === "GET" ? { payload: undefined } : {}), method });
    assert.equal(result.environment, "PPE");
    assert.equal(result.method, method);
    assert.equal(result.validationPassed, false);
  }
  assert.equal(state.prompts.length, 0);
  await assert.rejects(tool.handler({ ...state.args, method: "PUT", url: "https://api.dev.example.test/records" }),
    /approved PPE origins/u);
  const jobId = state.settings.jobId;
  assert.throws(() => createPpeWriteApproval(state.repository, "DEV", jobId), /explicitly selected PPE/u);
  assert.throws(() => createDevWriteApproval(state.repository, "PPE", jobId), /explicitly selected DEV/u);
  assert.throws(() => createDevPostTool({ ...state.settings, targetEnvironment: "DEV",
    postWriteApproval: { ...state.settings.postWriteApproval, environment: "dev" } }), /Invalid job-scoped/u);
  for (const origin of ["https://api.dev.example.test", "https://api.ppe.dev.example.test",
    "https://api.ppe.sit.example.test", "https://api.ppe.uat.example.test",
    "https://api.ppe.production.example.test", "https://api.ppe.example.test/path"]) {
    state.profile.browserAutomation.dataSafety.ppeWrite.origins = [origin];
    state.save();
    assert.throws(() => createPpeWriteApproval(state.repository, "PPE", jobId), /PPE.*origins/u);
  }
  assert.equal(state.requests.length, 5);
});

for (const [environment, postOnly] of [["DEV", false], ["PPE", false], ["PPE", true]]) {
test(`native SDK consumes ${environment} ${postOnly ? "POST-only" : "broad"} approval and expires it on executor shutdown`, async (t) => {
  const state = fixture(t);
  state.args.url = `https://api.${environment.toLowerCase()}.example.test/items`;
  if (postOnly) {
    approvePostBase(state, environment);
    state.args.url = `${state.postBase}/items`;
  } else {
    approveOrigins(state, environment);
  }
  const args = { ...state.args, ...(postOnly ? {} : { method: "PUT" }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = state.settings.request;
  t.after(() => { globalThis.fetch = originalFetch; });
  let exposedTool;
  await runCopilotSession({
    repository: state.repository, sessionId: state.settings.jobId, targetEnvironment: environment,
    allowPostRequests: true, postWriteApproval: state.settings.postWriteApproval,
    testMutationMode: "approved-write", prompt: "Synthetic approved DEV write."
  }, {
    output() {},
    async ask() { assert.fail("broad DEV approval must not ask again"); },
    client: {
      async start() {},
      async createSession(options) {
        exposedTool = options.tools[0];
        assert.equal(exposedTool.name, postOnly ? "fixlab_nonproduction_post" : `fixlab_${environment.toLowerCase()}_write`);
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait({ prompt }) {
            await exposedTool.handler(args);
            if (environment === "PPE" && !postOnly) {
              assert.match(prompt, /complete read\/write browser journeys through forwardApprovedBrowserRequest/);
              const route = browserRoute(state, {
                method: () => "GET", headers: () => ({}), postData: () => null
              });
              await forwardApprovedBrowserRequest(route, { environment, purpose: "Verify approved PPE data." });
              assert.equal(route.fulfilled[0].status, 201);
            }
          }
        };
      },
      async stop() { return []; }
    }
  });
  await assert.rejects(exposedTool.handler(args), /policy.*shutdown/u);
  assert.equal(state.requests.length, environment === "PPE" && !postOnly ? 2 : 1);
});
}

test("legacy DEV/SIT/UAT POST preferences still require individual confirmation", async (t) => {
  for (const environment of ["DEV", "SIT", "UAT", "PPE"]) {
    for (const enabled of [true, false]) {
      const state = fixture(t);
      const key = environment.toLowerCase();
      const configuration = structuredClone(state.profile.browserAutomation.dataSafety.devPost);
      configuration.actions[0].url = `https://api.${key}.example.test/items`;
      delete state.profile.browserAutomation.dataSafety.devPost;
      state.profile.browserAutomation.dataSafety.post = { [key]: configuration };
      state.profile.environments = ["DEV", "SIT", "UAT", "PPE"];
      state.profile.browserAutomation.testSynthesis = {
        defaultDataSource: "non-production-read-only", mutationMode: "none"
      };
      state.save();
      Object.assign(state.settings, {
        targetEnvironment: environment, mutationMode: "none", allowPostRequests: enabled
      });
      state.args.url = configuration.actions[0].url;
      const tool = state.tool();
      assert.equal(tool.name, "fixlab_nonproduction_post");
      assert.equal(state.prompts.length, 0, "the checkbox is not a permission grant");
      const result = await tool.handler(state.args);
      assert.equal(result.environment, environment);
      const prompt = state.prompts[0];
      assert.equal(prompt.title, `${enabled ? "Confirm" : "Allow"} one ${environment} POST action`);
      assert.equal(prompt.perAction, true);
      assert.equal(JSON.parse(prompt.details).enabledAtJobStart, enabled);
      assert.equal(state.requests.length, 1);
      await assert.rejects(tool.handler({ ...state.args, url: "https://api.other.example.test/items" }), /allowlisted/u);
      await tool.handler(state.args);
      assert.equal(state.prompts.length, 2, "each action still requires separate confirmation");
      for (const selectedMutationMode of ["none", "intercepted"]) {
        assert.equal(createDevPostTool({ ...state.settings, selectedMutationMode }), null);
      }
      assert.equal(createDevPostTool({ ...state.settings, targetEnvironment: "production" }), null);
      if (environment !== "DEV") {
        assert.equal(createDevPostTool({ ...state.settings, allowPostRequests: undefined,
          mutationMode: "approved-write" }), null, "older jobs must not gain a new environment capability");
      }
    }
  }
});

test("explicit job-scoped POST approval authorizes configured DEV/SIT/UAT writes without repeat prompts", async (t) => {
  for (const environment of ["DEV", "SIT", "UAT", "PPE"]) {
    const state = fixture(t);
    const key = environment.toLowerCase();
    const configuration = structuredClone(state.profile.browserAutomation.dataSafety.devPost);
    configuration.actions[0].url = `https://api.${key}.example.test/items`;
    delete state.profile.browserAutomation.dataSafety.devPost;
    state.profile.browserAutomation.dataSafety.post = { [key]: configuration };
    state.profile.environments = ["DEV", "SIT", "UAT", "PPE"];
    state.save();
    const jobId = "11111111-1111-4111-8111-111111111111";
    Object.assign(state.settings, {
      jobId, targetEnvironment: environment, allowPostRequests: true,
      postWriteApproval: createPostWriteApproval(state.repository, environment, jobId)
    });
    state.args.url = configuration.actions[0].url;
    const tool = state.tool();
    for (let action = 0; action < 2; action++) {
      const result = await tool.handler(state.args);
      assert.equal(result.environment, environment);
      assert.equal(result.mutationMode, "approved-write");
      assert.equal(result.validationPassed, false);
    }
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, 2);
    await assert.rejects(tool.handler({ ...state.args, payload: { name: "OTHER_RECORD" } }), /allowlisted/u);
    await assert.rejects(tool.handler({ ...state.args, url: "https://api.other.example.test/items" }), /allowlisted/u);
    assert.equal(state.requests.length, 2);
  }
});

test("job-scoped POST approval is bound to the job, environment and reviewed profile/helper", async (t) => {
  for (const change of ["job", "environment", "profile", "helper", "unchecked"]) {
    const state = fixture(t, { jobId: "11111111-1111-4111-8111-111111111111", allowPostRequests: true });
    state.settings.postWriteApproval = createPostWriteApproval(state.repository, "DEV", state.settings.jobId);
    if (change === "job") { state.settings.jobId = "22222222-2222-4222-8222-222222222222"; }
    if (change === "environment") { state.settings.targetEnvironment = "SIT"; }
    if (change === "unchecked") { state.settings.allowPostRequests = false; }
    if (["job", "environment", "unchecked"].includes(change)) {
      assert.throws(state.tool, /job-scoped POST approval/u);
    } else {
      const tool = state.tool();
      if (change === "profile") { state.profile.name = "Changed"; state.save(); }
      if (change === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
      await assert.rejects(tool.handler(state.args), /changed.*newly reviewed job/u);
    }
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, 0);
  }
});

test("job-scoped POST approval stops further writes after failed or ambiguous attempts", async (t) => {
  for (const status of [302, 401, 500, "network", "auth", "empty-auth"]) {
    const state = fixture(t, { jobId: "11111111-1111-4111-8111-111111111111", allowPostRequests: true });
    if (status === "auth") {
      writeFileSync(state.helper, 'export async function withApiToken() { throw new Error("synthetic-private-value"); }\n');
    }
    if (status === "empty-auth") {
      writeFileSync(state.helper, 'export async function withApiToken() {}\n');
    }
    state.settings.postWriteApproval = createPostWriteApproval(state.repository, "DEV", state.settings.jobId);
    state.settings.request = async (url, options) => {
      state.requests.push({ url, options });
      if (status === "network") { throw new Error("synthetic-private-value"); }
      return new Response(null, { status: typeof status === "number" ? status : 201 });
    };
    const tool = state.tool();
    await assert.rejects(tool.handler(state.args), /Approval is spent|no request was sent|did not complete one request/u);
    await assert.rejects(tool.handler(state.args), /job-scoped POST approval.*stopped/u);
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, ["auth", "empty-auth"].includes(status) ? 0 : 1);
  }
});

test("checkbox approval cannot gain endpoint scope added after job creation", async (t) => {
  const state = fixture(t, { jobId: "11111111-1111-4111-8111-111111111111", allowPostRequests: true });
  const configuration = state.profile.browserAutomation.dataSafety.devPost;
  delete state.profile.browserAutomation.dataSafety.devPost;
  state.save();
  state.settings.postWriteApproval = createPostWriteApproval(state.repository, "DEV", state.settings.jobId);
  const tool = state.tool();
  await assert.rejects(tool.handler(state.args), /not configured/u);
  state.profile.browserAutomation.dataSafety.devPost = configuration;
  state.save();
  await assert.rejects(tool.handler(state.args), /changed.*newly reviewed job/u);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
});

test("native SDK consumes job-scoped POST approval without prompting and revokes it on shutdown", async (t) => {
  const state = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = state.settings.request;
  t.after(() => { globalThis.fetch = originalFetch; });
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let exposedTool;
  await runCopilotSession({
    repository: state.repository, sessionId, targetEnvironment: "DEV", allowPostRequests: true,
    postWriteApproval: createPostWriteApproval(state.repository, "DEV", sessionId),
    testMutationMode: "approved-write", prompt: "Synthetic approved test-record write."
  }, {
    output() {},
    async ask() { assert.fail("checked POST must not ask for a second approval"); },
    client: {
      async start() {},
      async createSession(options) {
        exposedTool = options.tools[0];
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait() {
            assert.equal((await exposedTool.handler(state.args)).status, 201);
          }
        };
      },
      async stop() { return []; }
    }
  });
  await assert.rejects(exposedTool.handler(state.args), /policy.*shutdown/u);
  assert.equal(state.requests.length, 1);
});

test("deferred POST reports missing setup without asking for unsafe approval", async (t) => {
  const state = fixture(t, { allowPostRequests: false, mutationMode: "none" });
  delete state.profile.browserAutomation.dataSafety.devPost;
  state.save();
  const tool = state.tool();
  assert.ok(tool);
  await assert.rejects(tool.handler(state.args), /dataSafety\.post\.dev.*No request was sent/u);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
  assert.throws(() => createDevPostTool({ ...state.settings, allowPostRequests: "yes" }), /boolean/u);
});

test("DEV POST reviews the complete frozen action once and keeps credentials and bodies out of results", async (t) => {
  const state = fixture(t);
  const tool = state.tool();
  assert.equal(tool.name, "fixlab_dev_post");
  const result = await tool.handler(state.args);
  assert.equal(state.prompts.length, 1);
  const prompt = state.prompts[0];
  assert.equal(prompt.perAction, true);
  assert.equal(prompt.canAllowAll, undefined);
  const review = JSON.parse(prompt.details);
  assert.equal(review.url, state.url);
  assert.deepEqual(review.payload, state.args.payload);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].options.body, JSON.stringify(review.payload));
  assert.equal(state.requests[0].options.redirect, "manual");
  assert.equal(state.requests[0].options.headers.Authorization, "Bearer synthetic-value");
  assert.equal(result.status, 201);
  assert.equal(result.validationPassed, false);
  assert.equal(result.mutationMode, "approved-write");
  assert.doesNotMatch(JSON.stringify({ result, prompt }), /synthetic-value|Authorization/u);
  await tool.handler(state.args);
  assert.equal(state.prompts.length, 2, "a repeat action requires fresh individual confirmation");
});

test("DEV POST transport forbids batch/session grants and consumes only the exact pending request", (t) => {
  const state = fixture(t);
  let bridge;
  const sent = [];
  state.settings.ask = async (prompt) => {
    bridge = createRuntimeRequestBridge({ send: (value) => sent.push(value), onChange() {} });
    const id = runtimeRequestId();
    bridge.receive({ ...prompt, id });
    assert.throws(() => bridge.respond(id, { action: "allow", scope: "all-tools" }), /not available/u);
    bridge.respond(id, { action: "allow" });
    assert.throws(() => bridge.respond(id, { action: "allow" }), /stale/u);
    assert.throws(() => bridge.receive({ ...prompt, id: runtimeRequestId(), canAllowAll: true }), /invalid/u);
    return sent[0];
  };
  return state.tool().handler(state.args);
});

test("native SDK exposes DEV POST only with explicit run policy and never uses Allow all for its action", async (t) => {
  const state = fixture(t);
  let prompts = 0;
  await runCopilotSession({
    repository: state.repository, targetEnvironment: "DEV", testMutationMode: "approved-write",
    toolApprovalMode: "allow-all", prompt: "Synthetic approved DEV action."
  }, {
    output() {},
    async ask(prompt) {
      prompts++;
      assert.equal(prompt.perAction, true);
      assert.equal(prompt.canAllowAll, undefined);
      return { action: "deny" };
    },
    client: {
      async start() {},
      async createSession(options) {
        assert.equal(options.tools[0].name, "fixlab_dev_post");
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } }, on() {},
          async sendAndWait() {
            await assert.rejects(options.tools[0].handler(state.args), /not individually approved/u);
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.equal(prompts, 1);
});

test("DEV POST requires DEV, exact configured URLs and test records, and explicit approved-write policy", async (t) => {
  const state = fixture(t);
  for (const targetEnvironment of ["", "local", "SIT", "UAT", "production", undefined]) {
    assert.equal(createDevPostTool({ ...state.settings, targetEnvironment }), null);
  }
  for (const mutationMode of ["none", "intercepted", undefined]) {
    assert.equal(createDevPostTool({ ...state.settings, mutationMode }), null);
  }
  for (const args of [
    { ...state.args, url: `${state.url}/other` },
    { ...state.args, url: `${state.url}?redirect=other` },
    { ...state.args, payload: { name: "ANOTHER_RECORD" } },
    { ...state.args, payload: { name: "FIXLAB_TEST_001", password: "synthetic-private-value" } },
    { ...state.args, payload: { name: "FIXLAB_TEST_001", note: "x".repeat(4001) } },
    { ...state.args, payload: [] }, { ...state.args, headers: {} }
  ]) {
    await assert.rejects(state.tool().handler(args));
  }
  assert.equal(state.prompts.length, 0);
  assert.equal(state.requests.length, 0);
  state.profile.browserAutomation.mode = "api";
  state.save();
  assert.throws(state.tool, /read-only/u);
  delete state.profile.browserAutomation.mode;
  state.profile.browserAutomation.dataSafety.devPost.actions[0].url = "https://api.prod.example.test/items";
  state.save();
  assert.throws(state.tool, /exact credential-free/u);
});

test("DEV POST rejects denial, broad grants, expiry and changed policy/helper without sending", async (t) => {
  for (const change of ["deny", "grant", "expire", "helper", "profile", "policy"]) {
    const state = fixture(t);
    let time = 0;
    let ready = true;
    state.settings.now = () => time;
    state.settings.isReady = () => ready;
    state.settings.ask = async () => {
      if (change === "expire") { time = 300000; }
      if (change === "helper") { writeFileSync(state.helper, `${readFileSync(state.helper, "utf8")}\n`); }
      if (change === "profile") { state.profile.name = "Changed"; state.save(); }
      if (change === "policy") { ready = false; }
      return change === "deny" ? { action: "deny" }
        : change === "grant" ? { action: "allow", scope: "all-tools" } : { action: "allow" };
    };
    await assert.rejects(state.tool().handler(state.args), /not individually approved|expired|changed/u, change);
    assert.equal(state.requests.length, 0, change);
  }
});

test("DEV POST never follows redirects or retries ambiguous outcomes, and hides authentication errors", async (t) => {
  for (const status of [302, 401, 500, "network", "auth", "double-callback"]) {
    const state = fixture(t);
    if (status === "auth") {
      writeFileSync(state.helper, 'export async function withApiToken() { throw new Error("synthetic-private-value"); }\n');
    }
    if (status === "double-callback") {
      writeFileSync(state.helper, 'export async function withApiToken(options, run) { await run("synthetic-value"); await run("synthetic-value"); }\n');
    }
    state.settings.request = async (url, options) => {
      state.requests.push({ url, options });
      if (status === "network") { throw new Error("synthetic-private-value"); }
      return new Response(null, { status: typeof status === "number" ? status : 201 });
    };
    await assert.rejects(state.tool().handler(state.args), (error) => {
      assert.doesNotMatch(error.message, /synthetic-private-value/u);
      assert.match(error.message, /Approval is spent|no request was sent/u);
      return true;
    });

    assert.equal(state.requests.length, status === "auth" ? 0 : 1);
  }
});

test("DEV POST refuses credential-sensitive debug logging before asking or sending", async (t) => {
  const state = fixture(t);
  const original = process.env.NODE_DEBUG;
  try {
    process.env.NODE_DEBUG = "http";
    await assert.rejects(state.tool().handler(state.args), /debug logging/u);
    assert.equal(state.prompts.length, 0);
    assert.equal(state.requests.length, 0);
  } finally {
    if (original === undefined) { delete process.env.NODE_DEBUG; }
    else { process.env.NODE_DEBUG = original; }
  }
});
