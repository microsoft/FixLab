import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../mcp/server.js", import.meta.url));

async function startServer() {
  const child = spawn(process.execPath, [server], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  async function request(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = responses.find((item) => item.id === message.id);
      if (response) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`MCP response timed out for ${message.method}`);
  }

  async function stop() {
    child.stdin.end();
    await once(child, "exit");
  }

  return { request, stop };
}

test("MCP server initializes and lists FixLab tools", async () => {
  const client = await startServer();
  try {
    const initialized = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      }
    });
    assert.equal(initialized.result.serverInfo.name, "fixlab");

    const listed = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["fixlab_inspect_repository", "fixlab_validation_commands", "fixlab_dashboard_status", "fixlab_dashboard_reply", "fixlab_dashboard_control"]
    );
  } finally {
    await client.stop();
  }
});

test("MCP server reports repository profile readiness", async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-mcp-"));
  const profileDirectory = join(repository, ".github", "fixlab");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "repository-profile.json"),
    JSON.stringify({
      name: "Example",
      applications: { frontend: {} },
      environments: { DEV: {} },
      browserAutomation: {}
    })
  );

  const client = await startServer();
  try {
    const response = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fixlab_inspect_repository",
        arguments: { repository }
      }
    });

    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.profileReady, true);
    assert.equal(result.name, "Example");
    assert.deepEqual(result.applicationNames, ["frontend"]);
  } finally {
    await client.stop();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("MCP dashboard bridge is asynchronous, explicit and bound to repository, instance and job", async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-mcp-dashboard-"));
  const state = { repository, controlProtocol: 1, instanceId: "instance-a", job: { id: "job-a", status: "blocked" }, question: null, workspaceReview: null };
  let replyCount = 0;
  let received;
  const dashboard = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      received = JSON.parse(body);
      replyCount += 1;
    }
    response.end(JSON.stringify(state));
  });
  dashboard.listen(0, "127.0.0.1");
  await once(dashboard, "listening");
  const client = await startServer();
  let id = 10;
  const call = (name, args) => client.request({
    jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args }
  });
  const args = { repository, port: dashboard.address().port };
  try {
    const status = await call("fixlab_dashboard_status", args);
    assert.equal(JSON.parse(status.result.content[0].text).instanceId, state.instanceId);
    for (const bad of [
      { confirmed: false, instanceId: state.instanceId, jobId: state.job.id },
      { confirmed: true, instanceId: "old-instance", jobId: state.job.id },
      { confirmed: true, instanceId: state.instanceId, jobId: "old-job" }
    ]) {
      const rejected = await call("fixlab_dashboard_reply", {
        ...args, action: "continue", details: "Continue scoped checks.", ...bad
      });
      assert.match(rejected.error.message, /explicit answer|current dashboard/);
    }
    assert.equal(replyCount, 0);
    const answer = await call("fixlab_dashboard_reply", {
      ...args, ...state, jobId: state.job.id, confirmed: true,
      action: "continue", details: "Run scoped tests; defer full regression.", validationIntent: "scoped"
    });
    assert.equal(answer.result.isError, false);
    assert.equal(replyCount, 1);
    assert.equal(received.validationIntent, "scoped");
    assert.equal(received.jobId, state.job.id);
    state.job.status = "running";
    state.question = {
      kind: "runtime-question", requestId: "question-a", responseChannel: "conversation",
      message: "Which test scope?", choices: ["Focused"], actions: ["answer"]
    };
    const answered = await call("fixlab_dashboard_reply", {
      ...args, instanceId: state.instanceId, jobId: state.job.id, confirmed: true,
      action: "answer", requestId: "question-a", details: "Focused"
    });
    assert.equal(answered.result.isError, false);
    assert.equal(received.requestId, "question-a");
    assert.equal(received.action, "answer");
    const beforeStale = replyCount;
    for (const change of [
      { requestId: "old-question" }, { validationIntent: "scoped" }, { reviewedWorkspace: {} }
    ]) {
      const rejected = await call("fixlab_dashboard_reply", {
        ...args, instanceId: state.instanceId, jobId: state.job.id, confirmed: true,
        action: "answer", requestId: "question-a", details: "Focused", ...change
      });
      assert.match(rejected.error.message, /request ID/);
    }
    state.question = { kind: "runtime-input", requestId: "permission-a", responseChannel: "dashboard", actions: [] };
    const permission = await call("fixlab_dashboard_reply", {
      ...args, instanceId: state.instanceId, jobId: state.job.id, confirmed: true,
      action: "answer", requestId: "permission-a", details: "Allow"
    });
    assert.match(permission.error.message, /permissions.*dashboard/);
    assert.equal(replyCount, beforeStale);
    state.question = null;
    const controlled = await call("fixlab_dashboard_control", {
      ...args, instanceId: state.instanceId, jobId: state.job.id, confirmed: true,
      operation: "permission-review",
      parameters: { jobId: state.job.id, requestId: "request-a", directory: repository, action: "approve-directory" }
    });
    assert.equal(controlled.result.isError, false);
    assert.equal(JSON.parse(controlled.result.content[0].text).operation, "permission-review");
    assert.equal(received.action, "review-directory", "a review cannot be changed into an approval");
    state.controlProtocol = 0;
    const incompatible = await call("fixlab_dashboard_control", {
      ...args, instanceId: state.instanceId, jobId: state.job.id, confirmed: true,
      operation: "frontend-stop", parameters: {}
    });
    assert.match(incompatible.error.message, /Update the FixLab dashboard/);
    state.controlProtocol = 1;
    const wrong = await call("fixlab_dashboard_status", { ...args, port: 0 });
    assert.match(wrong.error.message, /loopback dashboard port/);
    const invalid = await call("fixlab_dashboard_status", { ...args, port: "http://example.test" });
    assert.match(invalid.error.message, /loopback dashboard port/);
    state.repository = tmpdir();
    const mismatch = await call("fixlab_dashboard_status", args);
    assert.match(mismatch.error.message, /repository mismatch/);
  } finally {
    await client.stop();
    await new Promise((resolve) => dashboard.close(resolve));
    rmSync(repository, { recursive: true, force: true });
  }
});

test("MCP dashboard bridge rejects oversized, malformed and redirect responses without following them", async () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-mcp-response-"));
  let mode = "large";
  const dashboard = createServer((_request, response) => {
    if (mode === "redirect") {
      response.writeHead(302, { Location: "http://example.test" });
      response.end(JSON.stringify({ error: "redirect refused" }));
    } else {
      response.end(mode === "large" ? "x".repeat(129 * 1024) : "{invalid");
    }
  });
  dashboard.listen(0, "127.0.0.1");
  await once(dashboard, "listening");
  const client = await startServer();
  try {
    for (const [index, value] of ["large", "malformed", "redirect"].entries()) {
      mode = value;
      const result = await client.request({
        jsonrpc: "2.0", id: index + 30, method: "tools/call",
        params: { name: "fixlab_dashboard_status", arguments: { repository, port: dashboard.address().port } }
      });
      assert.ok(result.error, `${value} must not produce success-shaped status`);
    }
  } finally {
    await client.stop();
    await new Promise((resolve) => dashboard.close(resolve));
    rmSync(repository, { recursive: true, force: true });
  }
});
