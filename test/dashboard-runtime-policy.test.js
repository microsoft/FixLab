import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCopilotSession } from "../dashboard/copilot-session.js";
import { createRuntimePermissionPolicy, validateJobFileAccess } from "../dashboard/runtime-permission-policy.js";
import { MAX_RUNTIME_FRAME_BYTES, runtimePermissionPrompt } from "../dashboard/runtime-requests.js";
import { createPublicationPermissions, publicationCommand, publicationDestination } from "../dashboard/publication-permissions.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-runtime-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(realpathSync.native(directory), "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(repository, "package.json"), '{"scripts":{"test":"node --test"}}');
  const read = (path = join(repository, "src", "index.ts")) => ({ kind: "read", path });
  const command = (fullCommandText = "npm test") => ({
    kind: "shell", fullCommandText, canOfferSessionApproval: true,
    possiblePaths: [], possibleUrls: [], resolvedWorkingDirectory: repository
  });
  const policy = createRuntimePermissionPolicy(repository);
  const allows = (request) => policy.allows(request, runtimePermissionPrompt(request));
  const scope = (request) => policy.scopeFor(request, runtimePermissionPrompt(request));
  const grant = (request, selected) => {
    const prompt = runtimePermissionPrompt(request);
    policy.grant(request, prompt, selected, policy.review(request, prompt));
  };
  return { directory, repository, read, command, policy, allows, scope, grant };
}

test("publication consent binds Azure/GitHub checkpoint transitions and leaves unsupported or stale scope manual", async (t) => {
  const state = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: state.repository, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const command of [
    "npm test", "git commit --amend -m revised", "git push --force origin HEAD",
    "gh pr merge 1", "az repos pr create --auto-complete true"
  ]) {
    assert.equal(publicationCommand(command), null);
    assert.equal(createPublicationPermissions("missing").review(state.command(command), { ready: true }), null);
  }
  for (const url of ["git@github.com:example/repo.git", "https://other.invalid/repo",
    "https://github.com/example/repo?x=1", "https://dev.azure.com/example/project%20name/_git/repo"]) {
    assert.equal(publicationDestination(url), null);
  }
  git("init", "--quiet");
  git("config", "user.name", "FixLab Test");
  git("config", "user.email", "fixlab@example.test");
  git("checkout", "-b", "users/test/checkpoint");
  mkdirSync(join(state.repository, ".github", "fixlab"), { recursive: true });
  writeFileSync(join(state.repository, ".github", "fixlab", "repository-profile.json"), '{"version":1}');
  const deletedTest = "prodhierarchy-naming-parity.auth.spec.ts";
  writeFileSync(join(state.repository, deletedTest), "export const removed = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Initial fixture");
  rmSync(join(state.repository, deletedTest));
  writeFileSync(join(state.repository, "src", "index.ts"), "export const value = 2;\n");
  git("add", "--", deletedTest, "src/index.ts");
  writeFileSync(join(state.repository, "preserved-scratch.txt"), "Preserved, never staged or read by publication scope.\n");
  const contexts = [
    ["https://dev.azure.com/example/project/_git/repo",
      'az repos pr create --organization https://dev.azure.com/example --project project --repository repo --source-branch users/test/checkpoint --target-branch main --title "Scoped fix" --description "Synthetic evidence" --draft true --detect false --output json'],
    ["https://github.com/example/repo.git",
      'gh pr create --repo https://github.com/example/repo --head users/test/checkpoint --base main --title "Scoped fix" --body "Synthetic evidence" --draft']
  ];
  git("remote", "add", "origin", contexts[0][0]);
  const readiness = { ready: true, source: "users/test/checkpoint", target: "main", publication: "draft", revision: "fresh" };
  const alias = join(state.directory, "checkout-alias");
  symlinkSync(state.repository, alias, process.platform === "win32" ? "junction" : "dir");
  const canonicalRequest = state.command('git commit -m "Scoped fix"');
  assert.equal(canonicalRequest.resolvedWorkingDirectory, state.repository);
  assert.deepEqual(canonicalRequest.possiblePaths, []);
  assert.ok(createPublicationPermissions(state.repository).review(canonicalRequest, readiness));
  for (const protectedPaths of [[], [join(state.repository, "src")]]) {
    assert.equal(createPublicationPermissions(alias, protectedPaths).review(canonicalRequest, readiness), null,
      "an alias cannot qualify through canonical cwd metadata or miss canonical protected paths");
  }
  const protectedPolicy = createPublicationPermissions(state.repository, [join(state.repository, "src")]);
  assert.equal(protectedPolicy.review(state.command('git commit -m "Scoped fix"'), readiness), null);
  const linked = join(state.repository, "linked-copy.ts");
  linkSync(join(state.repository, "src", "index.ts"), linked);
  assert.equal(createPublicationPermissions(state.repository).review(state.command('git commit -m "Scoped fix"'), readiness), null);
  rmSync(linked);
  assert.equal(createPublicationPermissions(state.repository).allows(
    state.command("git push origin HEAD:refs/heads/users/test/checkpoint"), readiness), false);
  const policies = contexts.map(([destination]) => {
    git("remote", "set-url", "origin", destination);
    const policy = createPublicationPermissions(state.repository);
    const request = state.command('git commit -m "Scoped fix"');
    assert.equal(policy.review(request, { ...readiness, ready: false }), null);
    const reviewed = policy.review(request, readiness);
    assert.ok(reviewed);
    policy.grant(reviewed);
    assert.equal(policy.allows({ ...request, managedApprovalRequired: true }, readiness), false);
    assert.equal(policy.allows(request, { ...readiness, revision: "stale" }), false);
    assert.equal(policy.allows(request, readiness), true);
    return policy;
  });
  git("remote", "set-url", "origin", contexts[0][0]);
  let requests = 0;
  await runCopilotSession({ repository: state.repository, prompt: "Synthetic Azure checkpoint." }, {
    publicationContext: async () => readiness,
    async ask(prompt) {
      requests++;
      if (requests === 1) {
        assert.equal(prompt.grantScope, "publication-batch");
        return { action: "allow", scope: "publication-batch" };
      }
      return { action: "deny" };
    },
    output() {},
    client: {
      async start() {},
      async createSession(options) {
        return {
          rpc: { managedSettings: { async get() { return { failClosed: false }; } } },
          on() {},
          async sendAndWait() {
            const commit = state.command('git commit -m "Scoped fix"');
            assert.equal((await options.onPermissionRequest(commit)).kind, "approve-once");
            git("commit", "--quiet", "-m", "Scoped fix");
            for (const command of ["git push origin HEAD:refs/heads/users/test/checkpoint", contexts[0][1]]) {
              assert.equal((await options.onPermissionRequest(state.command(command))).kind, "approve-once");
            }
            assert.equal((await options.onPermissionRequest({ ...commit, managedApprovalRequired: true })).kind, "reject");
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.equal(requests, 2, "one consent covers commit, push and Azure PR; managed review stays manual");
  for (const [index, [destination, create]] of contexts.entries()) {
    const policy = policies[index];
    git("remote", "set-url", "origin", destination);
    const push = state.command("git push origin HEAD:refs/heads/users/test/checkpoint");
    assert.equal(policy.allows(push, readiness), true);
    assert.equal(policy.allows(state.command(create), readiness), true);
    assert.equal(policy.allows(state.command(create.replace("--target-branch main", "--target-branch other")
      .replace("--base main", "--base other")), readiness), false);
    assert.equal(policy.allows({ ...push, managedApprovalRequired: true }, readiness), false);
    git("config", "remote.origin.pushurl", "https://github.com/other/repo");
    assert.equal(policy.allows(push, readiness), false);
    git("config", "--unset", "remote.origin.pushurl");
    writeFileSync(join(state.repository, "src", "index.ts"), "export const value = 3;\n");
    assert.equal(policy.allows(push, readiness), false);
    writeFileSync(join(state.repository, "src", "index.ts"), "export const value = 2;\n");
    policy.clear();
    assert.equal(policy.allows(push, readiness), false);
  }
});

test("native filename discovery is automatic only in canonical non-sensitive repository directories", (t) => {
  const state = fixture(t);
  const discovery = (path = state.repository) => ({
    ...state.read(path), intention: `Search for files matching pattern in: ${path}`
  });
  const automatic = (request) => state.policy.automaticApproval(request, runtimePermissionPrompt(request));
  for (const path of [state.repository, join(state.repository, "src")]) {
    assert.equal(automatic(discovery(path)), "repository filename discovery (no file contents)");
    assert.equal(state.allows(state.read(path)), false, "no directory-content grant is created");
  }
  for (const path of [".auth", ".git", "node_modules", "src/authentication", "test-results"]) {
    const directory = join(state.repository, path);
    mkdirSync(directory, { recursive: true });
    assert.equal(automatic(discovery(directory)), null);
  }
  symlinkSync(state.directory, join(state.repository, "linked"), "junction");
  for (const request of [
    state.read(state.repository), { ...discovery(), intention: `Search in directory: ${state.repository}` },
    { ...discovery(), intention: "Search for files matching pattern in: somewhere else" },
    discovery(state.directory), discovery(join(state.repository, "linked")),
    discovery(join(state.repository, "src", "index.ts")),
    discovery(join(state.repository, "missing")),
    { ...discovery(), resolvedPath: state.directory }
  ]) {
    assert.equal(automatic(request), null, JSON.stringify(request));
  }
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [join(state.repository, "src")]);
  const protectedRequest = discovery(join(state.repository, "src"));
  assert.equal(protectedPolicy.automaticApproval(protectedRequest, runtimePermissionPrompt(protectedRequest)), null);
  const search = { ...state.read(join(state.repository, "src")),
    intention: `Search in directory: ${join(state.repository, "src")}` };
  const start = (paths, extra = {}, id = "search") => state.policy.observeToolEvent({
    type: "tool.execution_start", data: { toolCallId: id, toolName: "rg",
      arguments: { paths, pattern: "value", glob: "*.{js,ts}", output_mode: "content", head_limit: 25, ...extra } }
  });
  for (const paths of ["src", ["src"]]) {
    start(paths);
    assert.equal(automatic(search), "bounded live native source search");
  }
  for (const [paths, extra] of [
    [["src", "elsewhere"], {}], [state.directory, {}],
    ["linked", {}], ["src", { glob: "*" }], ["src", { head_limit: 1000 }],
    ["src", { follow: true }]
  ]) {
    start(paths, extra);
    assert.equal(automatic(search), null);
  }
  start("src");
  start(["src"], {}, "ambiguous");
  assert.equal(automatic(search), null);
  state.policy.observeToolEvent({ type: "tool.execution_complete", data: { toolCallId: "ambiguous" } });
  assert.equal(automatic({ ...search, managedApprovalRequired: true }), null);
  state.policy.observeToolEvent({ type: "tool.execution_complete", data: { toolCallId: "search" } });
  assert.equal(automatic(search), null);
});

test("only this runtime's exact installed CLI help command is automatic", (t) => {
  const state = fixture(t);
  const helper = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
  const automatic = (request) => state.policy.automaticApproval(request, runtimePermissionPrompt(request));
  for (const path of [`'${helper}'`, `"${helper}"`, ...(!helper.includes(" ") ? [helper] : [])]) {
    assert.equal(automatic(state.command(`node ${path} --help`)), "installed FixLab CLI --help");
  }
  const command = state.command(`node '${helper}' --help`);
  assert.equal(automatic({ ...command, possiblePaths: [helper] }), "installed FixLab CLI --help");
  const otherHelper = join(state.repository, "fixlab.js");
  writeFileSync(otherHelper, "throw new Error('Must never execute');\n");
  for (const request of [
    state.command(`node '${otherHelper}' --help`),
    state.command(`node '${helper}' dashboard`),
    state.command(`node '${helper}' --help --eval x`),
    state.command(`node '${helper}' --help; whoami`),
    state.command(`node '${helper}' --help > output.txt`),
    state.command(`node --require preload.js '${helper}' --help`),
    { ...command, possiblePaths: [otherHelper] },
    { ...command, possiblePaths: undefined },
    { ...command, possibleUrls: ["https://example.invalid"] },
    { ...command, resolvedPaths: { [helper]: otherHelper } }
  ]) {
    assert.equal(automatic(request), null, JSON.stringify(request));
  }
  const discovery = {
    ...state.read(state.repository),
    intention: `Search for files matching pattern in: ${state.repository}`
  };
  for (const change of [
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { requestSandboxPermissive: true }, { sandboxPathGrant: {} },
    { warning: "Review this risk" }, { hasWriteFileRedirection: true }
  ]) {
    for (const request of [command, discovery]) {
      assert.equal(automatic({ ...request, ...change }), null);
    }
  }
});

test("SDK handles routine discovery and its own CLI help without prompting or granting broader access", async (t) => {
  const state = fixture(t);
  const helper = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
  let options;
  let observe;
  let asked = 0;
  const discovery = {
    ...state.read(state.repository),
    intention: `Search for files matching pattern in: ${state.repository}`
  };
  const help = state.command(`node '${helper}' --help`);
  const client = {
    async start() {},
    async createSession(value) {
      options = value;
      return {
        rpc: { managedSettings: { async get() { return { failClosed: false }; } } },
        on(callback) { observe = callback; },
        async sendAndWait() {
          observe({ type: "tool.execution_start", data: {
            toolCallId: "native-search", toolName: "rg",
            arguments: { paths: ["src"], pattern: "value", glob: "*.ts", output_mode: "content", head_limit: 25 }
          } });
          const search = { ...state.read(join(state.repository, "src")),
            intention: `Search in directory: ${join(state.repository, "src")}` };
          assert.deepEqual(await options.onPermissionRequest(search), {
            kind: "approve-once", approvedInteractively: false
          });
          observe({ type: "tool.execution_complete", data: { toolCallId: "native-search" } });
          for (const request of [discovery, help]) {
            assert.deepEqual(await options.onPermissionRequest(request), {
              kind: "approve-once", approvedInteractively: false
            });
          }
          for (const request of [
            state.read(), state.read(state.repository), state.command("npm run build"),
            { ...discovery, managedApprovalRequired: true },
            { ...help, requestSandboxBypass: true }
          ]) {
            assert.deepEqual(await options.onPermissionRequest(request), { kind: "reject" });
          }
        }
      };
    },
    async stop() { return []; }
  };
  await runCopilotSession({ repository: state.repository, prompt: "Synthetic routine permissions." }, {
    client, async ask() { asked++; return { action: "deny" }; }, output() {}
  });
  assert.equal(asked, 5);
});

test("repository-file grants are opt-in, canonical and limited to non-sensitive regular files", (t) => {
  const state = fixture(t);
  const write = { kind: "write", fileName: join(state.repository, "src", "index.ts") };
  assert.equal(state.policy.isSourceFile(write.fileName), true);
  assert.equal(state.policy.scopeFor(write, { canApprove: true }), null);
  assert.equal(state.policy.allows(write, { canApprove: true }), false);
  assert.equal(state.allows(state.read()), false);
  assert.equal(state.scope(state.read()), "repository-reads");
  state.grant(state.read(), "repository-reads");
  assert.equal(state.allows(state.read()), true);
  assert.equal(state.allows(state.read(join(state.repository, "package.json"))), true);
  for (const name of [
    ".auth/state.json", ".env", ".npmrc", ".git/config", "secrets.ts", "auth.ts",
    "storageState.ts", "state.json", "private.pem", "node_modules/library/index.js",
    "test-results/evidence.ts"
  ]) {
    const path = join(state.repository, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "Synthetic protected fixture.\n");
    assert.equal(state.scope(state.read(path)), null, name);
    assert.equal(state.allows(state.read(path)), false, name);
    assert.equal(state.policy.isSourceFile(path), false, name);
  }
  const outside = join(state.directory, "outside.ts");
  writeFileSync(outside, "Synthetic outside fixture.\n");
  for (const path of [state.repository, join(state.repository, "src"), outside, "src/*.ts", "src/missing.ts"]) {
    assert.equal(state.allows(state.read(path)), false, path);
  }
  symlinkSync(state.directory, join(state.repository, "src", "linked"), "junction");
  assert.equal(state.allows(state.read(join(state.repository, "src", "linked", "outside.ts"))), false);
  assert.equal(state.allows({ ...state.read(), resolvedPath: outside }), false);
  assert.equal(createRuntimePermissionPolicy(state.repository).allows(state.read(), runtimePermissionPrompt(state.read())), false);
});

test("reviewed trust distinguishes auth test source from browser state and sensitive paths", (t) => {
  const state = fixture(t);
  const jobId = randomUUID();
  const fileAccess = validateJobFileAccess({
    mode: "source-read-write", repository: state.repository, jobId
  }, state.repository, jobId, "fix-and-validate");
  const policy = createRuntimePermissionPolicy(state.repository, [], fileAccess);
  const readOnly = createRuntimePermissionPolicy(state.repository, [], { ...fileAccess, mode: "source-read" });
  const allows = (request, selected = policy) => selected.allows(request, runtimePermissionPrompt(request));
  const source = [
    "rename-target-duplicates.auth.spec.ts", "auth.spec.ts", "sign-in.auth.test.ts",
    "AUTH.SPEC.TSX", "scenario-auth.test.mjs", "scenario_auth.spec.cts"
  ];
  mkdirSync(join(state.repository, "e2e"));
  for (const name of source) {
    const path = join(state.repository, "e2e", name);
    writeFileSync(path, "export const synthetic = true;\n");
    const read = { ...state.read(path), intention: `Read file: ${path}` };
    const write = { kind: "write", fileName: path, diff: "Synthetic test-source change." };
    assert.equal(allows(read), true, name);
    assert.equal(allows(write), true, name);
    assert.equal(allows(read, readOnly), true, name);
    assert.equal(allows(write, readOnly), false, name);
    assert.equal(state.allows(read), false, "authentication tests do not bypass opt-in trust");
  }
  const create = { kind: "write", fileName: join(state.repository, "e2e", "new.auth.spec.ts"), diff: "Synthetic new test." };
  assert.equal(allows(create), true);
  for (const name of [
    ".auth/user.json", ".auth/scenario.auth.spec.ts", ".edge-profile/scenario.auth.spec.ts",
    "auth/scenario.auth.spec.ts", ".auth.spec.ts", "auth.fixture.ts", "auth.setup.ts",
    "auth.config.ts", "scenario.auth.spec.ts.json", "auth.spec.ts.bak",
    "credentials.auth.spec.ts", "secret.auth.spec.ts", "token.auth.spec.ts",
    "private.auth.spec.ts", "storageState.auth.spec.ts",
    "node_modules/scenario.auth.spec.ts", "test-results/scenario.auth.spec.ts"
  ]) {
    const path = join(state.repository, "e2e", ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "Synthetic protected fixture.\n");
    assert.equal(allows(state.read(path)), false, name);
    assert.equal(allows({ kind: "write", fileName: path, diff: "Synthetic denied change." }), false, name);
  }
  const path = join(state.repository, "e2e", source[0]);
  const read = state.read(path);
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [path], fileAccess);
  assert.equal(allows(read, protectedPolicy), false, "configured authentication paths stay protected");
  for (const change of [
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { requestSandboxPermissive: true }, { warning: "Review risk" }
  ]) {
    assert.equal(allows({ ...read, ...change }), false);
  }
  const outside = join(state.directory, "outside.auth.spec.ts");
  writeFileSync(outside, "Synthetic outside fixture.\n");
  symlinkSync(state.directory, join(state.repository, "e2e", "linked"), "junction");
  linkSync(outside, join(state.repository, "e2e", "hard-linked.auth.spec.ts"));
  for (const file of [
    outside, join(state.repository, "e2e", "linked", "outside.auth.spec.ts"),
    join(state.repository, "e2e", "hard-linked.auth.spec.ts")
  ]) {
    assert.equal(allows(state.read(file)), false);
    assert.equal(allows({ kind: "write", fileName: file, diff: "Synthetic denied link." }), false);
  }
});

test("reviewed source-write trust is independent of display size but keeps bounded full-content checks", (t) => {
  const state = fixture(t);
  const fileAccess = { mode: "source-read-write", repository: state.repository, jobId: randomUUID() };
  const policy = createRuntimePermissionPolicy(state.repository, [], fileAccess);
  const write = {
    kind: "write", fileName: join(state.repository, "src", "index.ts"),
    intention: "Synthetic source edit. ".repeat(35), diff: "+".repeat(7909)
  };
  const allows = (request, selected = policy) => selected.allows(request, runtimePermissionPrompt(request));
  assert.equal(runtimePermissionPrompt(write).canApprove, false, "manual display review remains bounded");
  assert.equal(allows(write), true);
  assert.equal(state.allows(write), false, "manual default cannot approve undisplayed edits");
  const readOnly = createRuntimePermissionPolicy(state.repository, [], { ...fileAccess, mode: "source-read" });
  assert.equal(allows(write, readOnly), false);
  assert.equal(allows({ ...write, diff: "+".repeat(MAX_RUNTIME_FRAME_BYTES - 10000) }), true);
  for (const change of [
    { diff: "+".repeat(MAX_RUNTIME_FRAME_BYTES) },
    { diff: "\u00e9".repeat(MAX_RUNTIME_FRAME_BYTES / 2) },
    { diff: `${"+".repeat(8200)}\nAuthorization: [redacted]` },
    { diff: `${"+".repeat(8200)}\nBearer synthetic-placeholder` },
    { diff: `${"+".repeat(8200)}\npassword: synthetic-placeholder` },
    { diff: `${"+".repeat(8200)}\n\u0000` },
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { requestSandboxPermissive: true }, { warning: "Review risk" },
    { fileName: join(state.repository, ".env") },
    { fileName: join(state.repository, "src", "auth.ts") },
    { fileName: join(state.repository, "src", "settings.ts") },
    { fileName: join(state.repository, "playwright.config.ts") },
    { fileName: join(state.directory, "outside.ts") },
    { fileName: undefined }, { diff: undefined }
  ]) {
    assert.equal(allows({ ...write, ...change }), false, JSON.stringify(Object.keys(change)));
  }
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [write.fileName], fileAccess);
  assert.equal(allows(write, protectedPolicy), false);
  assert.equal(allows(write, createRuntimePermissionPolicy(state.repository, [], {
    ...fileAccess, repository: state.directory
  })), false);
});

test("exact test grants bind command, canonical cwd, reported paths and manifests", (t) => {
  const state = fixture(t);
  const command = state.command();
  assert.equal(state.allows(command), false);
  assert.equal(state.scope(command), "exact-test-command");
  state.grant(command, "exact-test-command");
  assert.equal(state.allows(command), true);
  mkdirSync(join(state.repository, "other"));
  for (const request of [
    state.command("npm test -- --runInBand"),
    { ...command, resolvedWorkingDirectory: join(state.repository, "other") },
    { ...command, possiblePaths: [join(state.repository, "src", "index.ts")] },
    { ...command, commandSegments: [{ fullCommandText: "npm test" }] }
  ]) {
    assert.equal(state.allows(request), false);
  }
  writeFileSync(join(state.repository, "package.json"), '{"scripts":{"test":"node changed-test.js"}}');
  assert.equal(state.allows(command), false);
  assert.equal(state.scope(command), "exact-test-command", "changed command context requires a new review");
  state.grant(command, "exact-test-command");
  assert.equal(state.allows(command), true);
});

test("reviewed file trust covers source reads and edits across hosts, never other jobs or safety boundaries", async (t) => {
  const state = fixture(t);
  const authTest = join(state.repository, "e2e", "rename-target-duplicates.auth.spec.ts");
  mkdirSync(join(state.repository, "e2e"));
  writeFileSync(authTest, "export const synthetic = true;\n");
  const jobId = randomUUID();
  const fileAccess = validateJobFileAccess({
    mode: "source-read-write", repository: state.repository, jobId
  }, state.repository, jobId, "fix-and-validate");
  const policy = createRuntimePermissionPolicy(state.repository, [], fileAccess);
  const write = (path = join(state.repository, "src", "index.ts")) => ({
    kind: "write", fileName: path, diff: "Synthetic non-sensitive source edit."
  });
  const allows = (request) => policy.allows(request, runtimePermissionPrompt(request));
  assert.equal(allows(state.read()), true);
  assert.equal(allows(state.read(join(state.repository, "src", "not-created.ts"))), true);
  for (const name of ["missing-parent/not-created.ts", "src/private.ts"]) {
    const request = state.read(join(state.repository, ...name.split("/")));
    assert.equal(allows(request), false, name);
  }
  assert.equal(allows(write()), true);
  assert.equal(allows(write(join(state.repository, "src", "pfam.renameValidation.test.ts"))), true);
  assert.equal(policy.scopeFor(write(), runtimePermissionPrompt(write())), null);
  assert.equal(state.allows(write()), false, "manual default still asks");
  assert.equal(allows(state.command()), false, "file trust never approves commands");
  const readOnly = createRuntimePermissionPolicy(state.repository, [], { ...fileAccess, mode: "source-read" });
  assert.equal(readOnly.allows(state.read(), runtimePermissionPrompt(state.read())), true);
  assert.equal(readOnly.allows(write(), runtimePermissionPrompt(write())), false);
  for (const name of [
    ".github/instructions/rules.md", ".github/fixlab/repository-profile.json",
    "AGENTS.md", "playwright.config.ts", "project.csproj", "build.ps1",
    "src/private.ts", "src/auth.ts", "src/settings.ts", "node_modules/library/index.js"
  ]) {
    const path = join(state.repository, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "Synthetic protected fixture.\n");
    assert.equal(allows(write(path)), false, name);
  }
  const outside = join(state.directory, "outside.ts");
  writeFileSync(outside, "Synthetic outside fixture.\n");
  symlinkSync(state.directory, join(state.repository, "linked"), "junction");
  linkSync(outside, join(state.repository, "src", "hard-linked.ts"));
  for (const path of [
    outside, join(state.repository, "linked", "outside.ts"),
    join(state.repository, "src", "hard-linked.ts"),
    join(state.repository, "missing-parent", "new.ts"), state.repository
  ]) {assert.equal(allows(write(path)), false, path);}
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [join(state.repository, "src")], fileAccess);
  assert.equal(protectedPolicy.allows(write(), runtimePermissionPrompt(write())), false);
  for (const change of [
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { requestSandboxPermissive: true }, { warning: "Review risk" }
  ]) {for (const request of [state.read(), write()]) {
    assert.equal(allows({ ...request, ...change }), false);
  }}
  for (const changed of [
    { ...fileAccess, jobId: randomUUID() }, { ...fileAccess, repository: state.directory },
    { ...fileAccess, mode: "all" }
  ]) {assert.throws(() => validateJobFileAccess(changed, state.repository, jobId, "fix-and-validate"), /exact job/);}
  assert.throws(() => validateJobFileAccess(fileAccess, state.repository, jobId, "validate-only"), /edits require/);
  for (const resume of [false, true]) {
    const createSession = async (options) => ({
      rpc: {
        managedSettings: { async get() { return { failClosed: false }; } },
        model: { async getCurrent() { return { modelId: "synthetic-model" }; } },
        metadata: { async recomputeContextTokens() { return { messagesTokenCount: 1 }; } }
      },
      on() {},
      async sendAndWait() {
        for (const request of [
          state.read(), write(), state.read(authTest), write(authTest),
          { ...write(), diff: "using Microsoft.AspNetCore.Authorization;\n[Authorize]\npublic class FeatureFlagsController {}" },
          { ...write(), diff: "+".repeat(8500) }
        ]) {
          assert.deepEqual(await options.onPermissionRequest(request), {
            kind: "approve-once", approvedInteractively: false
          });
        }
      }
    });
    await runCopilotSession({
      repository: state.repository, sessionId: jobId, mode: "fix-and-validate",
      fileAccess, resume, prompt: "Synthetic reviewed file trust."
    }, {
      client: { async start() {}, createSession, resumeSession: (_id, options) => createSession(options), async stop() { return []; } },
      async ask() { assert.fail("Reviewed source reads and edits must not prompt again after resume"); },
      output() {}
    });
  }
});

test("oversized source edits offer a fresh review only after complete eligibility checks, never a grant", async (t) => {
  const state = fixture(t);
  const request = { kind: "write", fileName: join(state.repository, "src", "index.ts"), diff: "+".repeat(9000) };
  const prompt = runtimePermissionPrompt(request);
  const review = state.policy.reviewSourceEdit(request, prompt);
  assert.equal(review.fileName, join("src", "index.ts"));
  assert.ok(review.reviewCharacters > 8192);
  assert.equal(state.policy.allows(request, prompt), false);
  for (const change of [
    { diff: "Small edit" }, { diff: `${request.diff}\nconst token = "synthetic-value";` },
    { diff: "+".repeat(MAX_RUNTIME_FRAME_BYTES) }, { managedApprovalRequired: true },
    { requestSandboxBypass: true }, { warning: "Manual review required" },
    { fileName: join(state.directory, "outside.ts") },
    { fileName: join(state.repository, "src", "settings.ts") }
  ]) {
    const changed = { ...request, ...change };
    assert.equal(state.policy.reviewSourceEdit(changed, runtimePermissionPrompt(changed)), null);
  }
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [join(state.repository, "src")]);
  assert.equal(protectedPolicy.reviewSourceEdit(request, prompt), null);
  const longDirectory = join(state.repository, "src", "a".repeat(200), "b".repeat(200));
  mkdirSync(longDirectory, { recursive: true });
  const longRequest = { ...request, fileName: join(longDirectory, "index.ts") };
  assert.equal(state.policy.isSourceFile(longRequest.fileName), true);
  assert.equal(state.policy.reviewSourceEdit(longRequest, runtimePermissionPrompt(longRequest)), null,
    "unrepresentable hint metadata keeps the normal denial rather than breaking the permission bridge");
  let decisions = 0;
  await runCopilotSession({
    repository: state.repository, sessionId: randomUUID(), mode: "fix-and-validate",
    prompt: "Review the oversized source edit."
  }, {
    output() {},
    async ask(value) {
      decisions++;
      assert.deepEqual(value.sourceEditReview, review);
      assert.equal(value.automaticRecoveryAttempted, undefined);
      return { action: "deny" };
    },
    client: {
      async start() {},
      async createSession(options) {
        return {
          rpc: {
            managedSettings: { async get() { return { failClosed: false }; } },
            model: { async getCurrent() { return { modelId: "synthetic-model" }; } },
            metadata: { async recomputeContextTokens() { return { messagesTokenCount: 1 }; } }
          },
          on() {},
          async sendAndWait() {
            assert.deepEqual(await options.onPermissionRequest(request), { kind: "reject" });
          }
        };
      },
      async stop() { return []; }
    }
  });
  assert.equal(decisions, 1, "an offered source-edit review must not be automatically denied");
});

test("only the current session's regular checkpoint Markdown is automatically readable", (t) => {
  const state = fixture(t);
  const id = randomUUID();
  const home = join(state.directory, "copilot-home");
  const checkpoints = join(home, "session-state", id, "checkpoints");
  mkdirSync(checkpoints, { recursive: true });
  const file = join(checkpoints, "002-proposed-regression.md");
  writeFileSync(file, "Synthetic current-job checkpoint.");
  const policy = createRuntimePermissionPolicy(state.repository, [], null, null, id, home);
  const read = { kind: "read", path: file };
  const automatic = (request) => policy.automaticApproval(request, runtimePermissionPrompt(request));
  assert.ok(automatic(read));
  assert.equal(state.policy.automaticApproval(read, runtimePermissionPrompt(read)), null);
  const otherSession = createRuntimePermissionPolicy(state.repository, [], null, null, randomUUID(), home);
  assert.equal(otherSession.automaticApproval(read, runtimePermissionPrompt(read)), null);
  for (const request of [
    { kind: "write", fileName: file, diff: "Changed checkpoint" },
    { ...read, path: checkpoints }, { ...read, path: join(home, "config.json") },
    { ...read, managedApprovalRequired: true }, { ...read, requestSandboxBypass: true },
    { ...read, resolvedPath: join(state.repository, "src", "index.ts") }
  ]) { assert.equal(automatic(request), null); }
  const link = join(checkpoints, "linked.md");
  linkSync(file, link);
  assert.equal(automatic(read), null);
  rmSync(link);
  symlinkSync(join(state.repository, "src"), link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(automatic({ ...read, path: link }), null);
  rmSync(link);
  writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  assert.equal(automatic(read), null);
});

test("the exact safe repository profile is readable under reviewed trust but never writable", (t) => {
  const state = fixture(t);
  const path = join(state.repository, ".github", "fixlab", "repository-profile.json");
  mkdirSync(join(path, ".."), { recursive: true });
  const policy = createRuntimePermissionPolicy(state.repository, [], {
    mode: "source-read-write", repository: state.repository, jobId: randomUUID()
  });
  const read = state.read(path);
  const allows = () => policy.allows(read, runtimePermissionPrompt(read));
  const profile = { version: 1, name: "Synthetic profile", browserAutomation: { authentication: { required: true, statusPaths: ["e2e/.auth/user.json"] } } };
  writeFileSync(path, JSON.stringify(profile));
  assert.equal(allows(), true);
  assert.equal(state.scope(read), "repository-reads", "executor-local read grants include the exact safe profile too");
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [path], {
    mode: "source-read-write", repository: state.repository
  });
  assert.equal(protectedPolicy.allows(read, runtimePermissionPrompt(read)), false);
  for (const text of [
    "invalid JSON", "[]", "{}", JSON.stringify({ ...profile, cookies: [] }),
    JSON.stringify({ ...profile, password: "synthetic-placeholder" }),
    JSON.stringify({ ...profile, description: "x".repeat(256 * 1024) })
  ]) {
    writeFileSync(path, text);
    assert.equal(allows(), false);
  }
  writeFileSync(path, JSON.stringify(profile));
  const write = { kind: "write", fileName: path, diff: "Synthetic profile edit." };
  assert.equal(policy.allows(write, runtimePermissionPrompt(write)), false);
  const arbitrary = join(state.repository, ".github", "fixlab", "other.json");
  writeFileSync(arbitrary, JSON.stringify(profile));
  assert.equal(policy.allows(state.read(arbitrary), runtimePermissionPrompt(state.read(arbitrary))), false);
});

test("reviewed trust reads only bounded non-sensitive command logs with this job's ownership receipt", (t) => {
  const state = fixture(t);
  const jobId = randomUUID();
  const fileAccess = { mode: "source-read-write", repository: state.repository, jobId };
  const policy = createRuntimePermissionPolicy(state.repository, [], fileAccess);
  const directory = join(state.repository, ".git", "fixlab", "command-evidence", `20261020T191939-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const log = join(directory, "stdout.log");
  const marker = join(directory, "job.json");
  const request = state.read(log);
  const allows = () => policy.allows(request, runtimePermissionPrompt(request));
  writeFileSync(log, "Synthetic failed assertion: expected true, received false.\n");
  assert.equal(allows(), false, "older logs without an ownership receipt remain manual");
  const owner = { jobId, repository: state.repository, gateId: "frontend-tests" };
  writeFileSync(marker, JSON.stringify(owner));
  assert.equal(allows(), true);
  writeFileSync(log, "\u001b[32mSynthetic passed assertion\u001b[0m\n");
  assert.equal(allows(), true, "recognized SGR formatting is scanned as plain text");
  for (const content of ["\u001b[2JSynthetic output", "\u001b[31mAuthor\u001b[0mization: synthetic", "\u001b]8;;https://example.invalid\u0007link"]) {
    writeFileSync(log, content);
    assert.equal(allows(), false, "controls and secrets split by formatting remain manual");
  }
  writeFileSync(log, "Synthetic safe test output.\n");
  for (const changed of [null, {}, { ...owner, jobId: randomUUID() }, { ...owner, repository: state.directory }]) {
    writeFileSync(marker, JSON.stringify(changed));
    assert.equal(allows(), false);
  }
  writeFileSync(marker, JSON.stringify(owner));
  for (const content of ["password=synthetic-placeholder", "x".repeat(1024 * 1024 + 1)]) {
    writeFileSync(log, content);
    assert.equal(allows(), false);
  }
  writeFileSync(log, "Synthetic safe test output.\n");
  const write = { kind: "write", fileName: log, diff: "Synthetic output tampering." };
  assert.equal(policy.allows(write, runtimePermissionPrompt(write)), false);
  assert.equal(policy.allows(state.read(marker), runtimePermissionPrompt(state.read(marker))), false);
  const protectedPolicy = createRuntimePermissionPolicy(state.repository, [log], fileAccess);
  assert.equal(protectedPolicy.allows(request, runtimePermissionPrompt(request)), false);
});

test("reviewed dashboard gate trust binds helper, job, port and checkout without granting arbitrary commands", (t) => {
  const state = fixture(t);
  const helper = fileURLToPath(new URL("../bin/fixlab.js", import.meta.url));
  const jobId = randomUUID();
  const fileAccess = { mode: "source-read-write", repository: state.repository, jobId, allowValidationGates: true };
  const policy = createRuntimePermissionPolicy(state.repository, [], fileAccess, 4317);
  const text = `node '${helper}' gate --port 4317 --job ${jobId} --gate frontend-tests --repository '${state.repository}'`;
  const command = (fullCommandText = text) => ({ kind: "shell", fullCommandText, possiblePaths: [], possibleUrls: [] });
  const allows = (request) => policy.allows(request, runtimePermissionPrompt(request));
  assert.equal(allows(command()), true);
  assert.equal(allows(command(`node '${helper}' gate --repository '${state.repository}' --gate frontend-tests --job ${jobId} --port 4317`)), true);
  assert.equal(createRuntimePermissionPolicy(state.repository, [], { ...fileAccess, allowValidationGates: false }, 4317)
    .allows(command(), runtimePermissionPrompt(command())), false);
  for (const changed of [
    text.replace("--port 4317", "--port 4320"),
    text.replace(jobId, randomUUID()), text.replace(state.repository, state.directory),
    text.replace("--gate frontend-tests", "--gate frontend-tests --yes"),
    `${text}; whoami`, text.replace(" gate ", " exec "),
    "npm test", `node '${join(state.repository, "fake.js")}' gate --port 4317 --job ${jobId} --gate frontend-tests --repository '${state.repository}'`
  ]) {assert.equal(allows(command(changed)), false, changed);}
  for (const change of [
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { warning: "Review risk" }, { possibleUrls: ["https://example.invalid"] }
  ]) {assert.equal(allows({ ...command(), ...change }), false);}
});

test("configured authentication paths are protected even when their names resemble source files", (t) => {
  const state = fixture(t);
  const file = join(state.repository, "src", "session.js");
  writeFileSync(file, "Synthetic authentication-state fixture; not real credentials.\n");
  const policy = createRuntimePermissionPolicy(state.repository, [file]);
  const prompt = runtimePermissionPrompt(state.read());
  policy.grant(state.read(), prompt, "repository-reads", policy.review(state.read(), prompt));
  const request = state.read(file);
  assert.equal(policy.scopeFor(request, runtimePermissionPrompt(request)), null);
  assert.equal(policy.allows(request, runtimePermissionPrompt(request)), false);
  const directoryPolicy = createRuntimePermissionPolicy(state.repository, [join(state.repository, "src")]);
  assert.equal(directoryPolicy.scopeFor(state.read(), runtimePermissionPrompt(state.read())), null);
  assert.throws(() => createRuntimePermissionPolicy(state.repository, ["relative"]), /absolute/);
});
test("unknown, external, ambiguous, managed and escalated commands cannot receive scoped grants", (t) => {
  const state = fixture(t);
  state.grant(state.read(), "repository-reads");
  state.grant(state.command(), "exact-test-command");
  for (const change of [
    { managedApprovalRequired: true }, { requestSandboxBypass: true },
    { requestSandboxPermissive: true }, { sandboxPathGrant: {} },
    { warning: "Review this risk" }, { hasWriteFileRedirection: true }
  ]) {
    for (const request of [state.read(), state.command()]) {
      assert.equal(state.allows({ ...request, ...change }), false);
      assert.equal(state.scope({ ...request, ...change }), null);
    }
  }
  for (const request of [
    state.command("npm run build"), state.command("npm test && npm run publish"),
    state.command("npm test; whoami"), state.command("npm test > output.txt"),
    state.command("npm test $(whoami)"), state.command("npm test -- --config=../outside.ts"),
    state.command("dotnet test .."), state.command("npm test -- /outside.ts"),
    { ...state.command(), canOfferSessionApproval: false },
    { ...state.command(), resolvedWorkingDirectory: undefined },
    { ...state.command(), resolvedWorkingDirectory: state.directory },
    { ...state.command(), possibleUrls: [{ url: "https://example.invalid" }] },
    { ...state.command(), possiblePaths: undefined },
    { kind: "url", url: "https://example.invalid" },
    { kind: "write", fileName: join(state.repository, "src", "index.ts"), diff: "Synthetic change" },
    { kind: "mcp", serverName: "test", toolName: "read" }
  ]) {
    assert.equal(state.scope(request), null, JSON.stringify(request));
    assert.equal(state.allows(request), false);
    assert.throws(() => state.grant(request, "exact-test-command"), /cannot receive/);
  }
});

test("a command context changed while its grant dialog is pending cannot be authorized", (t) => {
  const state = fixture(t);
  const request = state.command();
  const prompt = runtimePermissionPrompt(request);
  const reviewed = state.policy.review(request, prompt);
  writeFileSync(join(state.repository, "package.json"), '{"scripts":{"test":"node changed.js"}}');
  assert.throws(() => state.policy.grant(request, prompt, "exact-test-command", reviewed), /cannot receive/);
  assert.equal(state.allows(request), false);
});
test("SDK grants skip only explicitly reviewed matching requests and expire with the executor", async (t) => {
  const state = fixture(t);
  for (const grantScope of ["repository-reads", "exact-test-command"]) {
    const request = grantScope === "repository-reads" ? state.read() : state.command();
    for (const grant of [true, false]) {
      let options;
      let asked = 0;
      const client = {
        async start() {},
        async createSession(value) {
          options = value;
          return {
            rpc: { managedSettings: { async get() { return { failClosed: false }; } } },
            on() {},
            async sendAndWait() {
              assert.deepEqual(await options.onPermissionRequest(request), {
                kind: "approve-once", approvedInteractively: true
              });
              assert.deepEqual(await options.onPermissionRequest(request), {
                kind: "approve-once", approvedInteractively: !grant
              });
              assert.deepEqual(await options.onPermissionRequest({
                ...request, managedApprovalRequired: true
              }), { kind: "approve-once", approvedInteractively: true });
            }
          };
        },
        async stop() { return []; }
      };
      await runCopilotSession({ repository: state.repository, prompt: "Synthetic scope test." }, {
        client,
        async ask(prompt) {
          asked++;
          if (asked === 1) {
            assert.equal(prompt.grantScope, grantScope);
            assert.equal(JSON.parse(prompt.details).jobGrant.repository, state.repository);
            return { action: "allow", ...(grant ? { scope: grantScope } : {}) };
          }
          return { action: "allow" };
        },
        output() {}
      });
      assert.equal(asked, grant ? 2 : 3);
    }
  }
});
