import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createRuntimeRequestBridge,
  MAX_RUNTIME_REQUESTS,
  PERMISSION_RECOVERY_GUIDANCE,
  runtimeConversationQuestion,
  runtimePermissionPrompt,
  runtimeQuestionPrompt,
  validateRuntimeUsage
} from "../dashboard/runtime-requests.js";
import { extensionLaunchProvider, runCopilotSession } from "../dashboard/copilot-session.js";
import { join } from "node:path";

function managedPolicyRpc(policy = { failClosed: false }) {
  return {
    managedSettings: { async get() { return policy; } },
    model: { async getCurrent() { return { modelId: "synthetic-model" }; } },
    metadata: { async recomputeContextTokens() { return { messagesTokenCount: 0 }; } }
  };
}

function fixture() {
  const sent = [];
  let requests = [];
  const bridge = createRuntimeRequestBridge({
    send: (message) => sent.push(message),
    onChange: (value) => { requests = value; }
  });
  const permission = (command = "npm test") => ({
    ...runtimePermissionPrompt({ kind: "shell", fullCommandText: command }),
    id: randomUUID()
  });
  return { bridge, sent, permission, get requests() { return requests; } };
}

test("connected blockers distinguish answerable questions from private questions and permission recovery", () => {
  const question = {
    ...runtimeQuestionPrompt({ question: "Which test scope?", choices: ["Focused", "Full"] }),
    id: randomUUID()
  };
  const view = runtimeConversationQuestion(question);
  assert.equal(view.kind, "runtime-question");
  assert.equal(view.requestId, question.id);
  assert.equal(view.message, "Which test scope?");
  assert.deepEqual(view.choices, ["Focused", "Full"]);
  assert.deepEqual(view.actions, ["answer"]);
  for (const request of [
    { ...question, details: "Allow GET https://private.example.test/path?" },
    { ...question, choices: ["https://private.example.test/path"] },
    { ...question, details: "Enter the verification code" },
    { ...question, title: "Enter your PIN" },
    ...["Enter your API key", "Enter your refresh token", "Enter your PIN",
      "API key?", "Refresh token required to continue:", "PIN?", "API keys?", "Refresh tokens:", "Passcode?", "Credentials:"]
      .map((details) => ({ ...question, details }))
  ]) {
    const hidden = runtimeConversationQuestion(request);
    assert.equal(hidden.responseChannel, "dashboard");
    assert.deepEqual(hidden.actions, []);
    assert.doesNotMatch(JSON.stringify(hidden), /private\.example|verification code/);
    if (!request.details.includes("https:") && !request.choices.some((value) => value.includes("https:"))) {
      assert.throws(() => fixture().bridge.receive(request), /invalid/);
    }
  }
  const blocked = runtimeConversationQuestion({
    ...runtimePermissionPrompt({ kind: "write", fileName: "test.js", diff: 'const token = "private-sentinel";' }),
    id: randomUUID()
  });
  assert.equal(blocked.kind, "runtime-input");
  assert.deepEqual(blocked.blockedReasons, ["sensitive-content"]);
  assert.equal(blocked.canRecover, true);
  assert.match(blocked.message, /Deny and request safe recovery/);
  assert.doesNotMatch(JSON.stringify(blocked), /private-sentinel|test\.js/);
});

test("blocked permission diagnostics distinguish causes without exposing original details", () => {
  for (const [request, expected] of [
    [{ kind: "shell", fullCommandText: "x".repeat(8193) }, ["oversized"]],
    [{ kind: "write", fileName: "test.js", diff: 'const token = "synthetic-private-value";' }, ["sensitive-content"]],
    [{ kind: "shell", fullCommandText: "test\u0000command" }, ["control-characters"]],
    [{ kind: "read", path: ".auth/user.json" }, ["sensitive-path"]],
    [{ kind: "unknown" }, ["unsupported"]]
  ]) {
    const view = runtimePermissionPrompt(request);
    assert.equal(view.canApprove, false);
    assert.deepEqual(view.blockedReasons, expected);
    assert.doesNotMatch(view.details, /synthetic-private-value|x{100}/u);
    const state = fixture();
    state.bridge.receive({ ...view, id: randomUUID() });
    assert.deepEqual(state.requests[0].blockedReasons, expected);
  }
});

test("guided recovery denies only the exact request, never creates a grant and cannot be replayed", () => {
  const state = fixture();
  const request = state.permission("x".repeat(8193));
  state.bridge.receive(request);
  assert.equal(state.requests[0].canRecover, true);
  assert.throws(() => state.bridge.respond(request.id, { action: "allow", recover: true }), /not available/u);
  assert.throws(() => state.bridge.respond(request.id, { action: "deny", recover: true, scope: "all-tools" }), /not available/u);
  state.bridge.respond(request.id, { action: "deny", recover: true });
  assert.deepEqual(state.sent[0], { type: "response", id: request.id, action: "deny", recover: true });
  assert.throws(() => state.bridge.respond(request.id, { action: "deny", recover: true }), /stale/u);
  for (const source of [
    { kind: "read", path: ".auth/user.json" },
    { kind: "shell", fullCommandText: "x".repeat(8193), managedApprovalRequired: true },
    { kind: "shell", fullCommandText: "x".repeat(8193), requestSandboxBypass: true }
  ]) {
    const view = { ...runtimePermissionPrompt(source), id: randomUUID() };
    assert.equal(view.canRecover, undefined);
    state.bridge.receive(view);
    assert.throws(() => state.bridge.respond(view.id, { action: "deny", recover: true }), /not available/u);
  }
});

test("large-edit review metadata survives transport but cannot approve or replay the hidden operation", () => {
  const state = fixture();
  const view = runtimePermissionPrompt({ kind: "write", fileName: "Header.tsx", diff: "+".repeat(9000) });
  const request = { ...view, id: randomUUID(),
    sourceEditReview: { fileName: "Header.tsx", reviewCharacters: view.reviewCharacters } };
  state.bridge.receive(request);
  assert.deepEqual(state.requests[0].sourceEditReview, request.sourceEditReview);
  assert.doesNotMatch(state.requests[0].details, /\+{100}/u);
  assert.throws(() => state.bridge.respond(request.id, { action: "allow" }), /not available/u);
  state.bridge.respond(request.id, { action: "deny", recover: true });
  assert.equal(state.sent[0].action, "deny");
  assert.throws(() => state.bridge.respond(request.id, { action: "allow" }), /stale/u);
  for (const metadata of [
    null, { fileName: "..\\Header.tsx", reviewCharacters: 9000 },
    { fileName: "Header.tsx", reviewCharacters: 8192 },
    { fileName: "Header.tsx", reviewCharacters: 9000, diff: "Hidden source" }
  ]) {
    assert.throws(() => state.bridge.receive({ ...request, id: randomUUID(), sourceEditReview: metadata }),
      /Invalid|invalid/u);
  }
});

test("SDK safe recovery returns a denial with bounded feedback rather than approving the hidden operation", async () => {
  let decisions = 0;
  await runCopilotSession({ repository: "synthetic-repository", prompt: "Recover safely.", toolApprovalMode: "allow-all" }, {
    output() {},
    async ask(prompt) {
      decisions++;
      assert.equal(prompt.canRecover, true);
      assert.equal(prompt.canApprove, false);
      return { action: "deny", recover: true };
    },
    client: {
      async start() {},
      async createSession(options) {
        return { rpc: managedPolicyRpc(), on() {}, async sendAndWait() {
          assert.deepEqual(await options.onPermissionRequest({ kind: "shell", fullCommandText: "x".repeat(8193) }),
            { kind: "reject", feedback: PERMISSION_RECOVERY_GUIDANCE });
        } };
      },
      async stop() { return []; }
    }
  });
  assert.equal(decisions, 1);
  assert.match(PERMISSION_RECOVERY_GUIDANCE, /Do not replay, encode, conceal, split or repackage/u);
  assert.match(PERMISSION_RECOVERY_GUIDANCE, /Keep completed evidence and existing failures/u);
});

test("runtime permission approval is exact, single-use and never session-wide", () => {
  const state = fixture();
  const first = state.permission();
  const second = state.permission("npm run build");
  state.bridge.receive(first);
  state.bridge.receive(second);
  assert.equal(state.requests.length, 2);
  assert.throws(() => state.bridge.respond(first.id, { action: "approve-for-session" }));
  assert.equal(state.requests.length, 2);
  state.bridge.respond(first.id, { action: "allow" });
  assert.deepEqual(state.sent, [{ type: "response", id: first.id, action: "allow" }]);
  assert.equal(state.requests[0].id, second.id);
  assert.throws(() => state.bridge.respond(first.id, { action: "allow" }), /stale/);
  state.bridge.respond(second.id, { action: "deny" });
  assert.equal(state.requests.length, 0);
});

test("Allow all transport requires an explicitly offered live capability", () => {
  const state = fixture();
  const ordinary = state.permission();
  state.bridge.receive(ordinary);
  assert.throws(() => state.bridge.respond(ordinary.id, { action: "allow", scope: "all-tools" }), /not available/);
  const offered = { ...state.permission(), canAllowAll: true };
  state.bridge.receive(offered);
  assert.throws(() => state.bridge.respond(offered.id, { action: "deny", scope: "all-tools" }), /not available/);
  state.bridge.respond(offered.id, { action: "allow", scope: "all-tools" });
  assert.equal(state.sent[0].scope, "all-tools");
  assert.throws(() => state.bridge.respond(offered.id, { action: "allow", scope: "all-tools" }), /stale/);
  assert.throws(() => state.bridge.receive({
    ...state.permission(), canApprove: false, canAllowAll: true
  }), /invalid/);
  assert.throws(() => state.bridge.receive({
    ...runtimeQuestionPrompt({ question: "Continue?" }), id: randomUUID(), canAllowAll: true
  }), /invalid/);
});

for (const selection of ["ask", "allow-all", "live-grant"]) {
  test(`SDK Allow all ${selection} preserves manual boundaries`, async () => {
    let options;
    let prompts = 0;
    const output = [];
    const routine = { kind: "shell", fullCommandText: "npm test" };
    const manual = [
      { ...routine, managedApprovalRequired: true },
      { ...routine, requestSandboxBypass: true },
      { ...routine, requestSandboxPermissive: true },
      { ...routine, sandboxPathGrant: { path: "synthetic" } },
      { ...routine, warning: "Review this warning" },
      { ...routine, hasWriteFileRedirection: true },
      { ...routine, canOfferSessionApproval: false },
      { kind: "read", path: ".auth/user.json" },
      { kind: "unsupported" },
      { kind: "shell", fullCommandText: 'git commit -m "Reviewed checkpoint"' }
    ];
    await runCopilotSession({
      repository: "synthetic-repository", prompt: "Synthetic tool-approval choices.",
      toolApprovalMode: selection === "allow-all" ? "allow-all" : "ask"
    }, {
      client: {
        async start() {},
        async createSession(value) {
          options = value;
          return {
            rpc: managedPolicyRpc(), on() {},
            async sendAndWait() {
              if (selection === "live-grant") {
                assert.deepEqual(await options.onPermissionRequest(routine), {
                  kind: "approve-once", approvedInteractively: true
                });
              }
              assert.deepEqual(await options.onPermissionRequest(routine), selection === "ask"
                ? { kind: "reject" } : { kind: "approve-once", approvedInteractively: false });
              for (const request of manual) {
                assert.deepEqual(await options.onPermissionRequest(request), { kind: "reject" });
              }
              await assert.rejects(options.onUserInputRequest({ question: "Complete normal sign-in?" }), /cancelled/);
            }
          };
        },
        async stop() { return []; }
      },
      async ask(request) {
        prompts++;
        if (selection === "live-grant" && prompts === 1) {
          assert.equal(request.canAllowAll, true);
          return { action: "allow", scope: "all-tools" };
        }
        if (prompts > (selection === "ask" ? 1 : selection === "live-grant" ? 1 : 0)) {
          assert.notEqual(request.canAllowAll, true);
        }
        return { action: "cancel" };
      },
      output: (stream, text) => output.push(text)
    });
    assert.equal(prompts, manual.length + 1 + (selection === "allow-all" ? 0 : 1));
    assert.equal(output.some((text) => text.includes("Applied the user's Allow all")), selection !== "ask");
  });
}

test("a live Allow all grant is never inherited by a replacement SDK executor", async () => {
  let launches = 0;
  let prompts = 0;
  const client = {
    async start() {},
    async createSession(options) {
      const launch = ++launches;
      return {
        rpc: managedPolicyRpc(), on() {},
        async sendAndWait() {
          const request = { kind: "shell", fullCommandText: "npm test" };
          assert.deepEqual(await options.onPermissionRequest(request), launch === 1
            ? { kind: "approve-once", approvedInteractively: true } : { kind: "reject" });
          if (launch === 1) {
            assert.deepEqual(await options.onPermissionRequest(request), {
              kind: "approve-once", approvedInteractively: false
            });
          }
        }
      };
    },
    async stop() { return []; }
  };
  const config = { repository: "synthetic-repository", prompt: "Synthetic executor lifetime." };
  const dependencies = {
    client, output() {},
    async ask() {
      return ++prompts === 1 ? { action: "allow", scope: "all-tools" } : { action: "deny" };
    }
  };
  await runCopilotSession(config, dependencies);
  await runCopilotSession(config, dependencies);
  assert.equal(prompts, 2);
});

test("SDK rejects invalid Allow all choices and unresolved managed policy before executing", async () => {
  let executions = 0;
  const client = {
    async start() {},
    async createSession() {
      return {
        rpc: managedPolicyRpc({ failClosed: true }), on() {},
        async sendAndWait() { executions++; }
      };
    },
    async stop() { return []; }
  };
  for (const toolApprovalMode of [true, null, {}, "all", "ALLOW-ALL"]) {
    await assert.rejects(runCopilotSession({ toolApprovalMode }, {
      client, ask() { throw new Error("No user request expected"); }, output() {}
    }), /toolApprovalMode/);
  }
  await assert.rejects(runCopilotSession({ toolApprovalMode: "allow-all" }, {
    client, ask() { throw new Error("No user request expected"); }, output() {}
  }), /Enterprise policy/);
  assert.equal(executions, 0);
});

test("structured SDK usage is monotonic, bounded and independent of rendered token summaries", () => {
  const previous = {
    inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 10, outputTokens: 5
  };
  const next = { inputTokens: 110, cachedInputTokens: 90, cacheWriteTokens: 12, outputTokens: 7 };
  assert.deepEqual(validateRuntimeUsage({ ...next, arbitrary: "Not retained" }, previous), {
    ...next, cacheReusePercent: 90 / 110 * 100
  });
  for (const value of [
    null, {}, { ...next, inputTokens: 99 }, { ...next, cachedInputTokens: 79 },
    { ...next, outputTokens: -1 }, { ...next, outputTokens: "7" },
    { ...next, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...next, cachedInputTokens: 111 }
  ]) {
    assert.throws(() => validateRuntimeUsage(value, previous), /structured/);
  }
});
test("sensitive, malformed and oversized permission details cannot be approved", () => {
  for (const request of [
    { kind: "shell", fullCommandText: "curl -H 'Authorization: Bearer not-a-real-test-token' https://example.invalid" },
    { kind: "shell", fullCommandText: "x".repeat(8193) },
    { kind: "shell" },
    { kind: "write", fileName: "example.txt" },
    { kind: "read", path: "e2e\\.auth\\user.json" },
    { kind: "write", fileName: ".env.local", diff: "Synthetic empty change" },
    { kind: "mcp", serverName: "example", toolName: "test", args: { password: "synthetic-private-value" } },
    { kind: "unknown" }
  ]) {
    const state = fixture();
    const view = { ...runtimePermissionPrompt(request), id: randomUUID() };
    assert.equal(view.canApprove, false);
    assert.doesNotMatch(view.details, /not-a-real-test-token|synthetic-private-value/);
    state.bridge.receive(view);
    assert.throws(() => state.bridge.respond(view.id, { action: "allow" }), /not available/);
    state.bridge.respond(view.id, { action: "deny" });
  }
});

test("permission views disclose sandbox escalation and managed human review", () => {
  const view = runtimePermissionPrompt({
    kind: "shell", fullCommandText: "npm test",
    requestSandboxBypass: true, requestSandboxPermissive: true,
    requestSandboxBypassReason: "The normal sandbox blocked this command.",
    managedApprovalRequired: true
  });
  const details = JSON.parse(view.details);
  assert.equal(details.sandboxBypass, true);
  assert.equal(details.sandboxPermissiveRetry, true);
  assert.equal(details.managedHumanApprovalRequired, true);
});

test("runtime questions preserve offered choices and enforce freeform policy", () => {
  const state = fixture();
  const request = {
    ...runtimeQuestionPrompt({
      question: "Authentication is required. Complete sign-in in the normal browser.",
      choices: ["Ready", "Stop"], allowFreeform: false
    }),
    id: randomUUID()
  };
  state.bridge.receive(request);
  assert.throws(() => state.bridge.respond(request.id, { action: "allow" }));
  assert.throws(() => state.bridge.respond(request.id, { action: "answer", answer: "Other" }));
  assert.throws(() => state.bridge.respond(request.id, { action: "answer", choice: -1 }));
  state.bridge.respond(request.id, { action: "answer", choice: 0 });
  assert.deepEqual(state.sent[0], {
    type: "response", id: request.id, action: "answer", answer: "Ready", wasFreeform: false
  });
  const freeform = { ...runtimeQuestionPrompt({ question: "Which scenario?" }), id: randomUUID() };
  state.bridge.receive(freeform);
  assert.throws(() => state.bridge.respond(freeform.id, { action: "answer", answer: "password=synthetic-only" }));
  state.bridge.respond(freeform.id, { action: "answer", answer: "Validate the selected scenario." });
  assert.equal(state.sent[1].wasFreeform, true);
});

test("runtime input rejects credential collection and malformed choices", () => {
  for (const request of [
    { question: "Please enter your password" },
    { question: "What is your password?" },
    { question: "Paste your MFA code" },
    ...["Enter your API key", "Enter your refresh token", "Enter your PIN",
      "Provide your API_key", "Paste your refresh_token", "Tell me your client secret",
      "Send your private key", "Enter\nyour PIN", "Provide your one-time password",
      "Your API key is required; paste it below.", `Enter ${"a".repeat(100)} then your refresh token`,
      "API key?", "Refresh token required to continue:", "PIN?", "API keys?", "Refresh tokens:", "Passcode?", "Credentials:"]
      .map((question) => ({ question })),
    { question: "Choose an option", choices: ["Enter your API key"] },
    { question: "Choose", choices: ["x".repeat(1001)] },
    { question: "Choose", choices: new Array(21).fill("Option") },
    { question: "Choose", choices: [], allowFreeform: false },
    { question: null }
  ]) {
    assert.throws(() => runtimeQuestionPrompt(request));
  }
});

test("runtime questions and replies allow credential-related test diagnostics without collecting credentials", () => {
  for (const question of [
    "Which password-reset test should I run?",
    "Should I run the API key validation tests?",
    "Which refresh token rotation spec reproduces the failure?"
  ]) {
    const state = fixture();
    const request = { ...runtimeQuestionPrompt({ question }), id: randomUUID() };
    state.bridge.receive(request);
    assert.equal(runtimeConversationQuestion(request).responseChannel, "conversation");
    for (const answer of ["PIN: 1234", "Refresh token: synthetic-value"]) {
      assert.throws(() => state.bridge.respond(request.id, { action: "answer", answer }), /non-sensitive/);
    }
    const answer = "The password reset test fails";
    state.bridge.respond(request.id, { action: "answer", answer });
    assert.equal(state.sent[0].answer, answer);
    assert.equal(state.sent[0].wasFreeform, true);
  }
  for (const question of [
    "Enter your API key for the validation test",
    "Provide the password reset test credentials"
  ]) {
    assert.throws(() => runtimeQuestionPrompt({ question }), /sensitive/);
  }
});

test("pending requests are bounded, cancelled on stop and never reusable", () => {
  const state = fixture();
  for (let index = 0; index < MAX_RUNTIME_REQUESTS; index++) {
    state.bridge.receive(state.permission());
  }
  assert.throws(() => state.bridge.receive(state.permission()), /excessive/);
  const id = state.requests[0].id;
  state.bridge.cancel();
  assert.equal(state.requests.length, 0);
  assert.equal(state.sent.length, MAX_RUNTIME_REQUESTS);
  assert.ok(state.sent.every((item) => item.action === "cancel"));
  assert.throws(() => state.bridge.respond(id, { action: "allow" }), /stale/);
});

test("invalid transport requests and disconnected requests fail closed", () => {
  const state = fixture();
  assert.throws(() => state.bridge.receive({ ...state.permission(), id: "../other" }));
  assert.throws(() => state.bridge.receive({ ...state.permission(), details: "password=synthetic-only" }));
  const request = state.permission();
  state.bridge.receive(request);
  assert.throws(() => state.bridge.receive(request));
  state.bridge.cancel(false);
  assert.equal(state.sent.length, 0);
  assert.equal(state.requests.length, 0);
});

for (const resume of [false, true]) {
  test(`SDK ${resume ? "resumed" : "fresh"} session waits for real permission and question responses`, async () => {
    const events = [];
    let config;
    let stopped = false;
    const session = {
      rpc: managedPolicyRpc(),
      on(listener) { events.push(listener); },
      async sendAndWait(input) {
        assert.equal(input.prompt, "Synthetic native-bridge scenario.");
        const permission = await config.onPermissionRequest({
          kind: "shell", fullCommandText: "npm test", managedApprovalRequired: true
        });
        assert.deepEqual(permission, { kind: "approve-once", approvedInteractively: true });
        assert.deepEqual(await config.onUserInputRequest({
          question: "Continue the synthetic scenario?", choices: ["Continue", "Cancel"]
        }), { answer: "Continue", wasFreeform: false });
        events[0]({ type: "assistant.message_delta", data: { deltaContent: "Scenario complete." } });
      }
    };
    const client = {
      async start() {},
      async createSession(value) { assert.equal(resume, false); config = value; return session; },
      async resumeSession(id, value) { assert.equal(resume, true); assert.equal(id, "test-session"); config = value; return session; },
      async stop() { stopped = true; return []; }
    };
    const output = [];
    await runCopilotSession({
      sessionId: "test-session", repository: "test-repository", additionalDirs: ["reviewed-directory"],
      model: "hydrafusion", prompt: "Synthetic native-bridge scenario.", resume
    }, {
      client,
      ask: async (request) => request.kind === "permission"
        ? { action: "allow" }
        : { action: "answer", answer: "Continue", wasFreeform: false },
      output: (stream, text) => output.push({ stream, text })
    });
    assert.equal(stopped, true);
    assert.equal(config.agent, "fixlab:fixlab");
    assert.equal(config.enableManagedSettings, true);
    assert.deepEqual(config.toolSearch, { enabled: true, deferThreshold: 1 });
    assert.deepEqual(config.largeOutput, { enabled: true, maxSizeBytes: 8192 });
    assert.equal(config.enableConfigDiscovery, true);
    assert.equal(config.availableTools, undefined);
    assert.equal(config.excludedTools, undefined);
    assert.equal(config.customAgents, undefined);
    assert.equal(config.systemMessage, undefined);
    assert.equal(config.model, "hydrafusion");
    assert.equal(config.enableExperimentalMode, true);
    assert.deepEqual(config.additionalDirectories, ["reviewed-directory"]);
    assert.deepEqual(output, [{ stream: "stdout", text: "Scenario complete." }]);
  });
}

test("SDK denial, cancelled questions and shutdown errors are not approvals", async () => {
  let stopped = false;
  const client = {
    async start() {},
    async createSession(config) {
      assert.deepEqual(await config.onPermissionRequest({ kind: "shell", fullCommandText: "npm test" }), { kind: "reject" });
      await assert.rejects(config.onUserInputRequest({ question: "Continue?" }), /cancelled/);
      return { rpc: managedPolicyRpc(), on() {}, async sendAndWait() {} };
    },
    async stop() { stopped = true; return [new Error("Synthetic cleanup failure")]; }
  };
  await assert.rejects(runCopilotSession({ prompt: "Test" }, {
    client, ask: async () => ({ action: "cancel" }), output() {}
  }), /shutdown failed/);
  assert.equal(stopped, true);
});

test("SDK output preserves final messages and cumulative usage on resume", async () => {
  let listener;
  const output = [];
  const usageSnapshots = [];
  const client = {
    async start() {},
    async resumeSession() {
      return {
        rpc: managedPolicyRpc(),
        on(value) { listener = value; },
        async sendAndWait() {
          listener({ type: "assistant.message", data: { content: "Final message without streaming." } });
          listener({ type: "assistant.usage", data: {
            inputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 5, outputTokens: 7
          } });
        }
      };
    },
    async stop() { return []; }
  };
  await runCopilotSession({
    resume: true,
    usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 3, outputTokens: 10 }
  }, {
    client, ask() {}, output: (stream, text) => output.push(text),
    onUsage(usage) { usageSnapshots.push(usage); }
  });
  assert.equal(output[0], "Final message without streaming.");
  assert.deepEqual(usageSnapshots.at(-1), {
    inputTokens: 130, cachedInputTokens: 32, cacheWriteTokens: 8, outputTokens: 17
  });
  assert.doesNotMatch(output.join(""), /Tokens\s+\u2191/);
});

test("SDK extension discovery retains the official bootstrap within owned containment", async () => {
  const bootstrap = join(process.cwd(), "test-bootstrap.mjs");
  const entry = join(process.cwd(), "extension.mjs");
  const provider = extensionLaunchProvider(bootstrap);
  assert.deepEqual(await provider.resolve({ modulePath: entry }), {
    launch: { executable: process.execPath, args: [bootstrap], env: { EXTENSION_PATH: entry } }
  });
  await assert.rejects(provider.resolve({ modulePath: "relative-extension.mjs" }), /unsupported/);
  await assert.rejects(provider.resolve({ modulePath: join(process.cwd(), "extension.ps1") }), /unsupported/);
});

for (const resume of [false, true]) {
  test(`SDK ${resume ? "resumed" : "fresh"} session fails closed before prompting on unresolved enterprise policy`, async () => {
    for (const policy of [{}, { failClosed: true }, null]) {
      let stopped = false;
      const session = {
        rpc: managedPolicyRpc(policy),
        on() { assert.fail("Unresolved policy must block execution"); },
        async sendAndWait() { assert.fail("Unresolved policy must block execution"); }
      };
      const open = async (config) => {
        assert.equal(config.enableManagedSettings, true);
        return session;
      };
      const client = {
        async start() {},
        createSession: open,
        async resumeSession(id, config) { return open(config); },
        async stop() { stopped = true; return []; }
      };
      await assert.rejects(runCopilotSession({ resume }, {
        client, ask() { assert.fail("Local approval cannot override unresolved policy"); }, output() {}
      }));
      assert.equal(stopped, true);
    }

    let stopped = false;
    const open = async () => ({
      rpc: { managedSettings: { async get() { throw new Error("Policy service unavailable"); } } }
    });
    const client = {
      async start() {},
      createSession: open,
      resumeSession: open,
      async stop() { stopped = true; return []; }
    };
    await assert.rejects(runCopilotSession({ resume }, {
      client, ask() {}, output() {}
    }), /Policy service unavailable/);
    assert.equal(stopped, true);
  });
}

for (const mode of ["playwright-only", "validate-only", "fix-and-validate"]) {
test(`oversized ${mode} resumes compact retained history once before executing, preserving safety and usage`, async () => {
      for (const messagesTokenCount of [24000, 24001]) {
        const calls = [];
        let listener;
        const output = [];
        const usageSnapshots = [];
        const session = {
          rpc: {
            ...managedPolicyRpc(),
            model: { async getCurrent() { return { modelId: "synthetic-model" }; } },
            metadata: { async recomputeContextTokens(value) {
              assert.deepEqual(value, { modelId: "synthetic-model" });
              return { messagesTokenCount };
            } },
            history: { async compact(value) {
              calls.push("compact");
              assert.match(value.customInstructions, /denied and pending permissions/);
              assert.match(value.customInstructions, /Never include credentials/);
              listener({ type: "assistant.usage", data: { inputTokens: 100, outputTokens: 10 } });
              return { success: true, tokensRemoved: 18000 };
            } }
          },
          on(value) { listener = value; },
          async sendAndWait() { calls.push("send"); }
        };
        const client = {
          async start() {},
          async resumeSession(id, options) {
            assert.equal(options.enableManagedSettings, true);
            assert.deepEqual(options.infiniteSessions, {
              enabled: true, backgroundCompactionThreshold: 0.25, bufferExhaustionThreshold: 0.4
            });
            return session;
          },
          async stop() { calls.push("stop"); return []; }
        };
        await runCopilotSession({
          mode, resume: true, usage: { inputTokens: 500 }
        }, { client, ask() { assert.fail("Compaction cannot grant permission"); },
          output(stream, text) { output.push(text); },
          onUsage(usage) { usageSnapshots.push(usage); } });
        assert.deepEqual(calls, messagesTokenCount > 24000
          ? ["compact", "send", "stop"] : ["send", "stop"]);
        if (messagesTokenCount > 24000) {
          assert.match(output.join(""), /18000 context tokens removed/);
        }
        assert.equal(usageSnapshots.at(-1).inputTokens, messagesTokenCount > 24000 ? 600 : 500);
        assert.doesNotMatch(output.join(""), /Tokens\s+\u2191/);
      }
    });
}

    test("browser resume blocks on failed compaction without clearing history or sending the job", async () => {
      for (const result of [
        { success: false, tokensRemoved: 0 }, { success: true, tokensRemoved: 0 }
      ]) {
        let stopped = false;
        const client = {
          async start() {},
          async resumeSession() {
            return {
              on() {},
              rpc: {
                ...managedPolicyRpc(),
                model: { async getCurrent() { return { modelId: "synthetic-model" }; } },
                metadata: { async recomputeContextTokens() { return { messagesTokenCount: 80000 }; } },
                history: { async compact() { return result; } }
              },
              async sendAndWait() { assert.fail("Failed compaction must not send a prompt"); }
            };
          },
          async stop() { stopped = true; return []; }
        };
        await assert.rejects(runCopilotSession({ mode: "playwright-only", resume: true }, {
          client, ask() {}, output() {}
        }), /could not be compacted/);
        assert.equal(stopped, true);
      }
    });

test("scoped grants require the offered permission scope and remain outside pending-only batches", () => {
  const state = fixture();
  const request = { ...state.permission(), grantScope: "exact-test-command" };
  state.bridge.receive(request);
  assert.throws(() => state.bridge.respond(request.id, { action: "allow", scope: "repository-reads" }), /not available/);
  assert.throws(() => state.bridge.respond(request.id, { action: "deny", scope: request.grantScope }), /not available/);
  state.bridge.respond(request.id, { action: "allow", scope: request.grantScope });
  assert.deepEqual(state.sent[0], {
    type: "response", id: request.id, action: "allow", scope: "exact-test-command"
  });
  const ordinary = state.permission();
  state.bridge.receive(ordinary);
  assert.throws(() => state.bridge.respond(ordinary.id, { action: "allow", scope: "exact-test-command" }), /not available/);
  state.bridge.respond(ordinary.id, { action: "allow" });
  assert.equal(state.sent[1].scope, undefined);
  assert.throws(() => state.bridge.receive({
    ...state.permission(), grantScope: "all-tools"
  }), /invalid/);
});

for (const inputTokenLimit of [0, 129, 130, 131]) {
  test(`SDK cumulative input ceiling ${inputTokenLimit} includes cached input and preserves exact usage`, async () => {
    let listener;
    let stopped = false;
    let sent = false;
    const output = [];
    const usageSnapshots = [];
    const client = {
      async start() {},
      async createSession(options) {
        assert.deepEqual(options.infiniteSessions, {
          enabled: true, backgroundCompactionThreshold: 0.25, bufferExhaustionThreshold: 0.4
        });
        return {
          rpc: managedPolicyRpc(),
          on(value) { listener = value; },
          async sendAndWait() {
            sent = true;
            listener({ type: "assistant.usage", data: {
              inputTokens: 30, cacheReadTokens: 25, cacheWriteTokens: 5, outputTokens: 7
            } });
            if (inputTokenLimit && inputTokenLimit <= 130) {
              return new Promise(() => {});
            }
          }
        };
      },
      async stop() { stopped = true; return []; }
    };
    const run = runCopilotSession({
      inputTokenLimit, mode: "fix-and-validate",
      usage: { inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 3, outputTokens: 10 }
    }, {
      client, ask() {}, output(stream, text) { output.push(text); },
      onUsage(usage) { usageSnapshots.push(usage); }
    });
    if (inputTokenLimit && inputTokenLimit <= 130) {
      await assert.rejects(run, (error) => error.code === "INPUT_TOKEN_LIMIT");
    } else {
      await run;
    }
    assert.equal(sent, true);
    assert.equal(stopped, true);
    assert.deepEqual(usageSnapshots.at(-1), {
      inputTokens: 130, cachedInputTokens: 105, cacheWriteTokens: 8, outputTokens: 17
    });
    assert.doesNotMatch(output.join(""), /Tokens\s+\u2191/);
  });
}

test("SDK exhausted resumed budgets block before opening a runtime and invalid ceilings fail explicitly", async () => {
  const client = {
    start() { assert.fail("An exhausted budget must not open a runtime"); },
    async stop() { return []; }
  };
  await assert.rejects(runCopilotSession({
    resume: true, inputTokenLimit: 100, usage: { inputTokens: 100 }
  }, { client, ask() {}, output() {} }), (error) => error.code === "INPUT_TOKEN_LIMIT");
  for (const inputTokenLimit of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(runCopilotSession({ inputTokenLimit }, {
      client, ask() {}, output() {}
    }), /non-negative safe integer/);
  }
});

test("compaction usage counts toward the ceiling before any continuation is sent", async () => {
  let listener;
  const output = [];
  const usageSnapshots = [];
  const client = {
    async start() {},
    async resumeSession() {
      return {
        on(value) { listener = value; },
        rpc: {
          ...managedPolicyRpc(),
          metadata: { async recomputeContextTokens() { return { messagesTokenCount: 80000 }; } },
          history: { async compact() {
            listener({ type: "assistant.usage", data: { inputTokens: 110, cacheReadTokens: 90 } });
            return { success: true, tokensRemoved: 60000 };
          } }
        },
        async sendAndWait() { assert.fail("An exhausted compacted session cannot continue"); }
      };
    },
    async stop() { return []; }
  };
  await assert.rejects(runCopilotSession({
    resume: true, mode: "validate-only", inputTokenLimit: 200, usage: { inputTokens: 100 }
  }, {
    client, ask() {}, output(stream, text) { output.push(text); },
    onUsage(usage) { usageSnapshots.push(usage); }
  }),
  (error) => error.code === "INPUT_TOKEN_LIMIT");
  assert.deepEqual(usageSnapshots.at(-1), {
    inputTokens: 210, cachedInputTokens: 90, cacheWriteTokens: 0, outputTokens: 0
  });
  assert.doesNotMatch(output.join(""), /Tokens\s+\u2191/);
});

test("a pending human permission is not approved after the input ceiling is reached", async () => {
  let listener;
  let respond;
  let permission;
  const client = {
    async start() {},
    async createSession(options) {
      return {
        rpc: managedPolicyRpc(),
        on(value) { listener = value; },
        async sendAndWait() {
          permission = options.onPermissionRequest({ kind: "shell", fullCommandText: "npm test" });
          listener({ type: "assistant.usage", data: { inputTokens: 100 } });
          await permission;
        }
      };
    },
    async stop() {
      respond({ action: "allow" });
      return [];
    }
  };
  await assert.rejects(runCopilotSession({ inputTokenLimit: 100 }, {
    client, ask() { return new Promise((resolve) => { respond = resolve; }); }, output() {}
  }), (error) => error.code === "INPUT_TOKEN_LIMIT");
  assert.deepEqual(await permission, { kind: "reject" });
});
