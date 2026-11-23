import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { mock } from "node:test";
import {
  createAzureDevOpsLoader,
  createAzureDevOpsTicketClient,
  azureDevOpsCommentFingerprint,
  formatAzureDevOpsComment,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  parseAzureDevOpsWorkItem,
  removeArtifactDirectory,
  sanitizeAzureDevOpsHtml,
  storeScreenshots
} from "../dashboard/intake.js";
import { executeTicketAgent, executeVersionedTicketAgent, prepareTicketSnapshot, readTicketAutomationHistory, reviewTicketHandoff, reviewInterruptedTicket, reconcileInterruptedTicket, ticketAutomationPlan, ticketOutcome, watchTickets } from "../dashboard/ticket-automation.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { PR_TEAM_REVIEW_GUIDANCE } from "../dashboard/workflow-policy.js";
import { ANALYSIS_EVIDENCE_GUIDANCE, analysisEvidenceContext, configuredAnalysisEvidence } from "../dashboard/analysis-evidence.js";
import { issuePlanConfiguration } from "../dashboard/issue-plans.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function ticketFixture({ readable = false } = {}) {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-ticket-"));
  for (const args of [
    ["init", repository],
    ["-C", repository, "remote", "add", "origin", "https://example-org.visualstudio.com/Example%20Project/_git/example-repo"]
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const profile = {
    environments: ["dev"],
    ticketAutomation: { areaPaths: ["Example Project\\Application"] },
    pullRequests: { defaultTargetBranch: "develop", requireConfirmation: true }
  };
  mkdirSync(join(repository, ".github", "fixlab"), { recursive: true });
  writeFileSync(join(repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  const plan = ticketAutomationPlan(repository, profile, { environment: "dev" });
  const item = {
    id: 42, revision: 1, assignedToCurrentUser: true, project: plan.project, areaPath: plan.areaPaths[0], tags: "Other; FixLab", workItemType: "Bug", state: "Active",
    title: "Name validation", description: "Accept plus and reject exclamation.",
    comments: [{ id: 1, text: "Check the create-name flow." }]
  };
  const posted = [];
  const client = {
    findTagged: async () => [item.id],
    load: async () => structuredClone(item),
    reviewPullRequests: async () => [],
    hasComment: async (_id, marker) => item.comments.some(comment => comment.text.startsWith(marker)),
    async comment(id, text) {
      posted.push({ id, text });
      item.comments.unshift({ id: 100 + posted.length, text });
      item.revision += 1;
    },
    async resolve(id, revision, type) {
      assert.equal(id, item.id);
      assert.equal(revision, item.revision);
      assert.equal(type, item.workItemType);
      item.state = "Resolved";
      item.revision += 1;
      return item.revision;
    },
    verifyDraft: async (repository, id, branch) => {
      assert.equal(repository, "example-repo");
      assert.equal(branch, "develop");
      return `https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/${id}`;
    }
  };
  if (readable) {
    client.commentIds = async (_id, fingerprint) =>
      item.comments.filter(comment => comment.contentFingerprint === fingerprint).map(comment => comment.id);
    const comment = client.comment;
    client.comment = async (id, text) => {
      await comment(id, text);
      const plain = sanitizeAzureDevOpsHtml(formatAzureDevOpsComment(text));
      item.comments[0].text = plain.slice(0, 2000);
      item.comments[0].contentFingerprint = azureDevOpsCommentFingerprint(plain);
    };
  }
  return {
    repository, profile, plan, item, client, posted,
    run: options => watchTickets({
      repository, plan, client, once: true, confirmed: true, allowAllTools: true,
      prepareSnapshot: async ({ snapshot, onBaseline }) => {
        const commit = snapshot.commit ?? "1".repeat(40);
        onBaseline(commit);
        return { repository, baseCommit: commit, jobId: snapshot.jobId };
      },
      onEvent() {}, ...options
    }),
    cleanup: () => rmSync(repository, { recursive: true, force: true })
  };
}

function snapshotFixture() {
  const f = ticketFixture();
  const publisher = join(f.repository, "publisher");
  const workspaceRoot = join(dirname(f.repository), `${basename(f.repository)}.fixlab-worktrees`);
  const git = (repository, ...args) => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  writeFileSync(join(f.repository, ".gitignore"), "/.github/fixlab/\n/.auth/\n/publisher/\n");
  writeFileSync(join(f.repository, "baseline.txt"), "startup");
  git(f.repository, "add", ".gitignore", "baseline.txt");
  git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "-m", "startup");
  const startup = git(f.repository, "rev-parse", "HEAD");
  git(f.repository, "worktree", "add", "--quiet", "-b", "develop", publisher);
  const advance = value => {
    writeFileSync(join(publisher, "baseline.txt"), value);
    git(publisher, "add", "baseline.txt");
    git(publisher, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "-m", value);
    return git(publisher, "rev-parse", "HEAD");
  };
  const target = advance("target-one");
  const runGit = (command, args, options) => {
    const result = spawnSync(command,
      args[0] === "fetch" ? args.map(value => value === "origin" ? f.repository : value) : args, options);
    if (args[0] === "fetch") { assert.equal(result.status, 0, result.stderr); }
    return result;
  };
  const cleanup = f.cleanup;
  return { ...f, startup, target, git, advance, runGit,
    prepare: options => prepareTicketSnapshot({ ...options, runGit }),
    cleanup() {
      rmSync(workspaceRoot, { recursive: true, force: true });
      cleanup();
    }
  };
}

test("new watcher tickets fetch newer target commits without changing an active snapshot or private state", async () => {
  const f = snapshotFixture();
  const workspaces = [];
  let next;
  try {
    mkdirSync(join(f.repository, ".auth"));
    writeFileSync(join(f.repository, ".auth", "state.json"), "private synthetic fixture");
    writeFileSync(join(f.repository, "watcher-notes.txt"), "preserve user work");
    const profile = readFileSync(join(f.repository, ".github", "fixlab", "repository-profile.json"));
    await f.run({ prepareSnapshot: f.prepare, execute: async ({ workspace, request, onComparison }) => {
      workspaces.push(workspace);
      assert.equal(workspace.baseCommit, f.target);
      assert.equal(readFileSync(join(workspace.repository, "baseline.txt"), "utf8"), "target-one");
      next = f.advance("target-two");
      assert.equal(readFileSync(join(workspace.repository, "baseline.txt"), "utf8"), "target-one");
      return executeVersionedTicketAgent({ workspace, prompt: request, onComparison,
        execute: async () => ({ outcome: "analysis", summary: "The approved deployed revision predates the existing fix.",
          versionComparison: { latestCommit: f.target, deployedCommit: f.startup,
            deployedEvidence: "Approved incident-time deployment manifest.",
            finding: "already-fixed", evidence: "Compared the pinned target change with the deployed source." } }) });
    } });
    f.item.id = 43;
    f.item.comments = [];
    await f.run({ prepareSnapshot: f.prepare, execute: async ({ workspace, request, onComparison }) => {
      workspaces.push(workspace);
      assert.equal(workspace.baseCommit, next);
      assert.equal(readFileSync(join(workspace.repository, "baseline.txt"), "utf8"), "target-two");
      return executeVersionedTicketAgent({ workspace, prompt: request, onComparison,
        execute: async () => ({ outcome: "analysis", summary: "Next ticket uses the newer target.",
          versionComparison: { latestCommit: next, finding: "unknown", evidence: "No approved deployment metadata was available." } }) });
    } });
    assert.equal(f.git(f.repository, "rev-parse", "HEAD"), f.startup);
    assert.equal(readFileSync(join(workspaces[0].repository, "baseline.txt"), "utf8"), "target-one");
    for (const workspace of workspaces) {
      assert.deepEqual(readFileSync(join(workspace.repository, ".github", "fixlab", "repository-profile.json")), profile);
      assert.equal(existsSync(join(workspace.repository, ".auth")), false);
    }
    assert.equal(readFileSync(join(f.repository, ".auth", "state.json"), "utf8"), "private synthetic fixture");
    assert.equal(readFileSync(join(f.repository, "watcher-notes.txt"), "utf8"), "preserve user work");
    const history = readTicketAutomationHistory(f.repository);
    assert.deepEqual(history.attempts.map(entry => entry.latestCommit).sort(), [f.target, next].sort());
    assert.match(f.posted[0].text, /Deployment gap identified/u);
    assert.ok(f.posted[0].text.includes(f.startup) && f.posted[0].text.includes(f.target));
    assert.match(f.posted[1].text, /Deployed version unknown/u);
    assert.ok(history.attempts.some(entry => entry.versionComparison?.deployedCommit === f.startup));
  } finally { f.cleanup(); }
});

test("a failed ticket fetch never falls back to an old ref and remains retryable before execution", async () => {
  const f = snapshotFixture();
  let executions = 0;
  let jobId;
  try {
    await assert.rejects(f.run({
      prepareSnapshot: options => {
        jobId = options.snapshot.jobId;
        f.git(f.repository, "update-ref", `refs/fixlab/ticket-baselines/${jobId}`, f.startup);
        return prepareTicketSnapshot({ ...options, runGit: (command, args, settings) =>
          args[0] === "fetch" ? { status: 128, stdout: "", stderr: "Synthetic network failure" }
            : f.runGit(command, args, settings) });
      },
      execute: async () => { executions++; return { outcome: "analysis", summary: "Must not run." }; }
    }), /fetch failed.*no stale checkout/u);
    const blocked = readTicketAutomationHistory(f.repository);
    assert.equal(blocked.attempts[0].status, "snapshot-pending");
    assert.equal(blocked.attempts[0].latestCommit, null);
    assert.equal(executions, 0);
    const review = await reviewInterruptedTicket(f.repository, { workItemId: f.item.id, client: f.client });
    assert.equal(review.canAccept, false);
    assert.equal(review.canRetry, true);
    assert.equal(review.attempt.status, "snapshot-pending");
    await f.run({ prepareSnapshot: f.prepare, execute: async ({ workspace }) => {
      executions++;
      assert.equal(workspace.jobId, jobId);
      assert.equal(workspace.baseCommit, f.target);
      return { outcome: "analysis", summary: "Recovered with the fetched target, not stale code." };
    } });
    assert.equal(executions, 1);
    assert.equal(readTicketAutomationHistory(f.repository).attempts.length, 1);
    assert.equal(f.git(f.repository, "rev-parse", "HEAD"), f.startup);
  } finally { f.cleanup(); }
});

test("version review reports existing fixes or unknown deployments without entering the PR phase", async () => {
  for (const finding of ["already-fixed", "unknown"]) {
    let calls = 0;
    const result = await executeVersionedTicketAgent({
      workspace: { baseCommit: "b".repeat(40) }, prompt: "Bounded synthetic ticket request.",
      execute: async options => {
        calls++;
        assert.equal(options.mode, "validate-only");
        assert.match(options.prompt, /Do not pull.*create\/update a PR/u);
        options.onSession(options.sessionId);
        return { outcome: "analysis", summary: "Compared incident evidence with the pinned source.",
          versionComparison: { latestCommit: "b".repeat(40), finding, evidence: "Reviewed source and incident behavior.",
            ...(finding === "already-fixed" ? {
              deployedCommit: "a".repeat(40), deployedEvidence: "Approved incident-time deployment metadata."
            } : {}) } };
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.outcome, "analysis");
    assert.equal(result.pullRequestId, undefined);
    assert.match(result.summary, finding === "already-fixed" ? /Deployment gap/ : /Deployed version unknown/);
  }
  await assert.rejects(executeVersionedTicketAgent({
    workspace: { baseCommit: "b".repeat(40) }, prompt: "Synthetic scope.",
    execute: async () => ({ outcome: "draft-pr", summary: "Premature publication.", pullRequestId: 9 })
  }), /no fix or PR phase/u);
  assert.throws(() => ticketOutcome({ outcome: "draft-pr", summary: "Duplicate fix.", pullRequestId: 9,
    versionComparison: { latestCommit: "b".repeat(40), finding: "already-fixed", evidence: "Existing fix." }
  }), /valid bounded ticket outcome/u);
  for (const versionComparison of [
    { latestCommit: "a".repeat(40), finding: "unknown", evidence: "Wrong baseline." },
    { latestCommit: "b".repeat(40), deployedCommit: "a".repeat(40),
      finding: "already-fixed", evidence: "Missing deployment provenance." }
  ]) {
    let enteredFix = false;
    await assert.rejects(executeVersionedTicketAgent({
      workspace: { baseCommit: "b".repeat(40) }, prompt: "Synthetic scope.",
      onPhase() { enteredFix = true; },
      execute: async () => ({ outcome: "analysis", summary: "Unverified comparison.", versionComparison })
    }), /pinned target commit|deployment\/comparison evidence/u);
    assert.equal(enteredFix, false);
  }
});

test("a fetched snapshot cannot substitute a different incident helper for the reviewed revision", async () => {
  const f = snapshotFixture();
  let executions = 0;
  try {
    const helper = "read-evidence.mjs";
    const approved = 'throw new Error("Reviewed helper must not execute during preparation.");';
    writeFileSync(join(f.repository, helper), approved);
    writeFileSync(join(f.repository, "publisher", helper), 'throw new Error("Unreviewed target helper.");');
    f.git(join(f.repository, "publisher"), "add", helper);
    f.git(join(f.repository, "publisher"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "-m", "change helper");
    const profile = { ...f.profile, analysis: { evidenceSources: [
      { id: "incident-records", kind: "cosmos", environment: "dev", helper }
    ] } };
    writeFileSync(join(f.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
    const plan = ticketAutomationPlan(f.repository, profile, { environment: "dev" });
    await assert.rejects(f.run({ plan, prepareSnapshot: f.prepare,
      execute: async () => { executions++; return { outcome: "analysis", summary: "Must not run." }; }
    }), /snapshot does not retain the reviewed helper revisions/u);
    assert.equal(executions, 0);
    assert.equal(readFileSync(join(f.repository, helper), "utf8"), approved);
    assert.equal(f.git(f.repository, "rev-parse", "HEAD"), f.startup);
    assert.equal(readTicketAutomationHistory(f.repository).attempts[0].status, "snapshot-pending");
  } finally { f.cleanup(); }
});

test("version evidence retention prunes old completed details but preserves paused fix sessions", async () => {
  const f = ticketFixture();
  try {
    await f.run({ execute: async () => ({ outcome: "analysis", summary: "Synthetic retained investigation." }) });
    const path = join(f.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    const original = state.entries[0];
    state.entries = Array.from({ length: 22 }, (_, index) => ({
      ...structuredClone(original), id: index === 21 ? original.id : 500 + index,
      snapshot: { jobId: randomUUID(), commit: "1".repeat(40) },
      versionComparison: { latestCommit: "1".repeat(40), finding: "unknown",
        evidence: "No approved deployment metadata." }
    }));
    const paused = state.entries[0];
    paused.status = "authentication-pending";
    paused.phase = "fix";
    paused.sessionId = randomUUID();
    paused.authenticationRequired = { provider: "azure-cli", reason: "Approved session expired." };
    paused.versionComparison.finding = "needs-fix";
    writeFileSync(path, JSON.stringify(state));
    await f.run({ execute: async () => { assert.fail("Reading and pruning must not resume a job."); } });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.entries[0], paused);
    assert.equal(saved.entries[1].versionComparison, undefined);
    assert.equal(saved.entries[1].details, undefined);
    assert.equal(saved.entries[1].snapshot.commit, "1".repeat(40));
    assert.ok(saved.entries.slice(2).every(entry => entry.versionComparison && entry.details));
  } finally { f.cleanup(); }
});

test("fix execution follows the completed pinned version review and retains its session across authentication", async () => {
  const calls = [];
  let phase;
  let comparison;
  const sessionId = randomUUID();
  const execute = async options => {
    calls.push(options);
    options.onSession(options.sessionId);
    if (calls.length === 1) {
      return { outcome: "analysis", summary: "Latest source still contains the defect.",
        versionComparison: { latestCommit: "b".repeat(40), finding: "needs-fix", evidence: "Focused source analysis." } };
    }
    return calls.length === 2
      ? { outcome: "blocked", summary: "An approved read requires sign-in.",
        authenticationRequired: { provider: "azure-cli", reason: "Approved CLI session expired." } }
      : { outcome: "draft-pr", summary: "Focused fix verified and published as draft.", pullRequestId: 9 };
  };
  const options = { workspace: { baseCommit: "b".repeat(40) }, prompt: "Synthetic scope.", sessionId, execute,
    onPhase(value) { phase = value; }, onComparison(value) { comparison = value; } };
  const blocked = await executeVersionedTicketAgent(options);
  assert.equal(phase, "fix");
  assert.equal(blocked.outcome, "blocked");
  const result = await executeVersionedTicketAgent({ ...options, phase, versionComparison: comparison, resume: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.mode), ["validate-only", "fix-and-validate", "fix-and-validate"]);
  assert.ok(calls.every(call => call.sessionId === sessionId));
  assert.equal(calls[1].resume, true);
  assert.equal(calls[2].resume, true);
  assert.equal(result.pullRequestId, 9);
  assert.match(result.summary, /Deployed version unknown/u);
});

test("incident evidence discovers environment-bound source helpers without executing or granting access", () => {
  const fixture = ticketFixture();
  try {
    const helper = join(fixture.repository, "read-evidence.mjs");
    writeFileSync(helper, 'throw new Error("Discovery must not execute a helper.");');
    const source = { id: "incident-records", kind: "cosmos", environment: "dev", helper: "read-evidence.mjs" };
    const profile = { ...fixture.profile, environments: ["dev", "sit"],
      analysis: { evidenceSources: [source] } };
    const sources = configuredAnalysisEvidence(fixture.repository, profile, "dev");
    assert.equal(sources.length, 1);
    assert.equal(sources[0].helper, source.helper);
    assert.deepEqual(configuredAnalysisEvidence(fixture.repository, profile, "sit"), []);
    assert.match(analysisEvidenceContext(sources), /Discovery grants no tool or data access/);
    writeFileSync(helper, 'throw new Error("Changed helper, still not executed.");');
    assert.notEqual(configuredAnalysisEvidence(fixture.repository, profile, "dev")[0].revision,
      sources[0].revision);
    for (const invalid of [
      { ...source, helper: "..\\outside.mjs" }, { ...source, helper: ".env" },
      { ...source, environment: "production" }, { ...source, environment: "unknown" }
    ]) {
      assert.throws(() => configuredAnalysisEvidence(fixture.repository, {
        ...profile, analysis: { evidenceSources: [invalid] }
      }, "dev"));
    }
    assert.throws(() => configuredAnalysisEvidence(fixture.repository, {
      ...profile, analysis: { evidenceSources: [source, source] }
    }, "dev"), /unique/);
    assert.throws(() => configuredAnalysisEvidence(fixture.repository, {
      ...profile, environments: ["dev", "live"],
      analysis: { evidenceSources: [{ ...source, environment: " live " }] }
    }, "live"), /non-production/);
    for (const path of [
      "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
      "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
      ".github/agents/fixlab.agent.md"
    ]) {
      assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
        .replace(/\s+/gu, " ").includes(ANALYSIS_EVIDENCE_GUIDANCE), path);
    }
  } finally { fixture.cleanup(); }
});

function productionEvidence(fixture) {
  const helper = "read-production-evidence.mjs";
  const source = 'throw new Error("Discovery must not execute production readers.");';
  writeFileSync(join(fixture.repository, helper), source);
  return {
    id: "incident-records", kind: "cosmos", environment: "production",
    workItemId: 42, correlationId: "CR-123", readOnly: true, helper,
    helperSha256: createHash("sha256").update(source).digest("hex")
  };
}

test("repository-scoped Cosmos evidence follows the current ticket only after explicit production approval", async () => {
  const fixture = ticketFixture();
  try {
    const fixed = productionEvidence(fixture);
    const policy = "cosmos-policy.json";
    const bytes = JSON.stringify({ version: 1, sources: [{ id: "reviewed-requests" }] });
    writeFileSync(join(fixture.repository, policy), bytes);
    const source = {
      id: fixed.id, kind: "cosmos", environment: "production", readOnly: true,
      scope: "repository", helper: fixed.helper, helperSha256: fixed.helperSha256,
      policy, policySha256: createHash("sha256").update(bytes).digest("hex")
    };
    fixture.profile.analysis = { productionReadOnlyEvidence: [source] };
    const saveProfile = () => writeFileSync(join(fixture.repository, ".github", "fixlab",
      "repository-profile.json"), JSON.stringify(fixture.profile));
    const planFor = approved => ticketAutomationPlan(fixture.repository, fixture.profile, {
      environment: "dev", allowProductionEvidence: approved
    });
    saveProfile();
    await fixture.run({ plan: planFor(false), execute: async ({ request }) => {
      assert.doesNotMatch(request, /cosmos-policy.json/);
      return { outcome: "analysis", summary: "Production evidence was not approved." };
    } });
    for (const id of [42, 43]) {
      fixture.item.id = id;
      await fixture.run({ plan: planFor(true), execute: async ({ request }) => {
        assert.match(request, /cosmos-policy.json/);
        assert.match(request, new RegExp(`"workItemId":${id}`));
        assert.match(request, /--policy <policy> --plan <plan>/);
        assert.doesNotMatch(request, /CR-123/);
        return { outcome: "analysis", summary: "Only reviewed read-only policy sources were exposed." };
      } });
    }
    await fixture.run({ plan: planFor(true), execute() {
      assert.fail("Unchanged approved incidents must not be replayed.");
    } });
    for (const invalid of [
      { ...source, scope: "all" }, { ...source, workItemId: 42 },
      { ...source, correlationId: "CR-123" }, { ...source, kind: "traces" },
      { ...source, policy: "..\\outside.json" }, { ...source, policy: ".auth\\state.json" },
      { ...source, policySha256: "0".repeat(64) }
    ]) {
      assert.throws(() => ticketAutomationPlan(fixture.repository, {
        ...fixture.profile, analysis: { productionReadOnlyEvidence: [invalid] }
      }, { environment: "dev", allowProductionEvidence: true }));
    }
    writeFileSync(join(fixture.repository, policy), '{"version":2}');
    assert.throws(() => planFor(true), /policy.*changed/i);
    source.policySha256 = createHash("sha256").update('{"version":2}').digest("hex");
    saveProfile();
    await fixture.run({ plan: planFor(true), execute: async ({ request }) => {
      assert.ok(request.includes(source.policySha256));
      return { outcome: "analysis", summary: "The updated policy was reviewed explicitly." };
    } });
    writeFileSync(join(fixture.repository, policy), "{invalid}");
    source.policySha256 = createHash("sha256").update("{invalid}").digest("hex");
    assert.throws(() => planFor(true), /not valid JSON/);
  } finally { fixture.cleanup(); }
});

test("production watcher evidence requires reviewed source hashes and bounded explicit scope", () => {
  const fixture = ticketFixture();
  try {
    const source = productionEvidence(fixture);
    const planFor = sources => ticketAutomationPlan(fixture.repository, {
      ...fixture.profile, analysis: { productionReadOnlyEvidence: sources }
    }, { environment: "dev" });
    const plan = planFor([source]);
    assert.equal(plan.allowProductionEvidence, false);
    assert.equal(plan.productionEvidence.length, 1);
    assert.equal(plan.productionEvidence[0].revision, source.helperSha256);
    assert.equal(plan.environment, "dev");
    for (const invalid of [
      { ...source, readOnly: false }, { ...source, workItemId: 0 },
      { ...source, correlationId: "*" }, { ...source, correlationId: "https://example.test" },
      { ...source, environment: "dev" }, { ...source, kind: "configuration" },
      { ...source, helperSha256: "0".repeat(64) }, { ...source, helper: "..\\outside.mjs" },
      { ...source, helper: ".env" }
    ]) {
      assert.throws(() => planFor([invalid]));
    }
    assert.throws(() => planFor([source, source]), /unique/);
    assert.throws(() => planFor(null), /reviewed readers/);
    writeFileSync(join(fixture.repository, source.helper), "export const changed = true;");
    assert.throws(() => planFor([source]), /revision|hash/i);
  } finally { fixture.cleanup(); }
});

test("watcher production approval re-evaluates only its bound ticket once without inheriting or retaining access", async () => {
  for (const runtime of ["agency", "copilot"]) {
    const fixture = ticketFixture();
    try {
      const source = productionEvidence(fixture);
      fixture.profile.analysis = { productionReadOnlyEvidence: [source] };
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
      const planFor = approved => ticketAutomationPlan(fixture.repository, fixture.profile, {
        environment: "dev", runtime, allowProductionEvidence: approved
      });
      const noProduction = async ({ request }) => {
        assert.doesNotMatch(request, /Reviewed production incident readers/);
        assert.doesNotMatch(request, /CR-123/);
        return { outcome: "analysis", summary: "Source analysis only; incident evidence is unavailable." };
      };
      await fixture.run({ plan: planFor(false), execute: noProduction });
      const history = () => readTicketAutomationHistory(fixture.repository).attempts;
      assert.equal(history().length, 1);
      await fixture.run({ plan: planFor(true), execute: async ({ request }) => {
        assert.match(request, /Reviewed production incident readers/);
        assert.match(request, /CR-123/);
        assert.match(request, /read-production-evidence.mjs/);
        assert.match(request, /No production application testing or business-data writes/);
        assert.match(request, /continue.*other.*reader/i);
        return { outcome: "analysis", summary: "Bounded incident reads completed; interaction remains unconfirmed." };
      } });
      assert.equal(history().length, 2);
      await fixture.run({ plan: planFor(true), execute() { assert.fail("Unchanged approved work must stay deduplicated."); } });
      writeFileSync(join(fixture.repository, source.helper), "export const revised = true;");
      source.helperSha256 = createHash("sha256").update(readFileSync(join(fixture.repository, source.helper))).digest("hex");
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
      await fixture.run({ plan: planFor(true), execute: async ({ request }) => {
        assert.ok(request.includes(source.helperSha256));
        return { outcome: "analysis", summary: "The changed reader was separately reviewed." };
      } });
      assert.equal(history().length, 3);
      fixture.item.comments.unshift({ id: 1000, text: "Review the same incident evidence." });
      await fixture.run({ plan: planFor(false), execute: noProduction });
      assert.equal(history().length, 4);
      fixture.item.id = 43;
      fixture.item.comments = [{ id: 2000, text: "An unrelated incident." }];
      await fixture.run({ plan: planFor(true), execute: noProduction });
      assert.equal(history().length, 5);
    } finally { fixture.cleanup(); }
  }
});

test("changing a reviewed production reader during execution retains findings and blocks feedback", async () => {
  const fixture = ticketFixture();
  try {
    const source = productionEvidence(fixture);
    fixture.profile.analysis = { productionReadOnlyEvidence: [source] };
    writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
    const plan = ticketAutomationPlan(fixture.repository, fixture.profile, {
      environment: "dev", allowProductionEvidence: true
    });
    await assert.rejects(fixture.run({ plan, execute: async () => {
      writeFileSync(join(fixture.repository, source.helper), "export const changed = true;");
      return { outcome: "analysis", summary: "Retain the completed findings for review." };
    } }), /revision|hash|configuration/i);
    assert.equal(fixture.posted.length, 0);
    const state = JSON.parse(readFileSync(join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json")));
    assert.equal(state.entries[0].result.summary, "Retain the completed findings for review.");
  } finally { fixture.cleanup(); }
});

test("watcher ignores unassigned or other-user items even if discovery returns their IDs", async () => {
  for (const assigned of [false, undefined]) {
    const fixture = ticketFixture();
    try {
      fixture.item.assignedToCurrentUser = assigned;
      await fixture.run({ execute() { assert.fail("Only current-user assignments may execute."); } });
      assert.equal(fixture.posted.length, 0);
      assert.equal(readTicketAutomationHistory(fixture.repository).attempts.length, 0);
    } finally { fixture.cleanup(); }
  }
});

test("watcher reassignment during execution retains findings without posting feedback", async () => {
  const fixture = ticketFixture();
  try {
    await assert.rejects(fixture.run({ execute: async () => {
      fixture.item.assignedToCurrentUser = false;
      return { outcome: "analysis", summary: "Retain the investigation for its owner to review." };
    } }), /changed during execution/);
    assert.equal(fixture.posted.length, 0);
    const attempt = readTicketAutomationHistory(fixture.repository).attempts[0];
    assert.equal(attempt.status, "running");
    assert.match(attempt.summary, /Retain the investigation/);
  } finally { fixture.cleanup(); }
});

test("completed watcher handoff refreshes scoped evidence without mutating or executing the watcher", async () => {
  const fixture = ticketFixture();
  try {
    await fixture.run({ execute: async () => ({
      outcome: "analysis", summary: "Implement the agreed hierarchy search with the API team."
    }) });
    const journal = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const before = readFileSync(journal, "utf8");
    const attemptId = readTicketAutomationHistory(fixture.repository).attempts[0].id;
    const review = () => reviewTicketHandoff(fixture.repository, { attemptId, client: fixture.client });
    const initial = await review();
    assert.equal(initial.environment, "dev");
    assert.equal(initial.jobInput.workItems[0].id, fixture.item.id);
    assert.equal(initial.jobInput.workItems[0].comments.length, 1, "Do not copy FixLab's own feedback back into intake.");
    assert.match(initial.jobInput.request, /another team's repository requires its own reviewed job/);
    assert.match(initial.jobInput.request, /permissions do not transfer/);
    fixture.item.revision += 1;
    fixture.item.acceptanceCriteria = "Include exact-name filtering.";
    assert.notEqual((await review()).reviewToken, initial.reviewToken);
    fixture.item.workItemType = "User Story";
    assert.equal((await review()).jobInput.requestType, "feature");
    fixture.item.assignedToCurrentUser = false;
    await assert.rejects(review(), /current-user assignment/);
    fixture.item.assignedToCurrentUser = true;
    fixture.item.areaPath = "Example Project\\Another Team";
    await assert.rejects(review(), /outside the recorded/);
    fixture.item.areaPath = fixture.plan.areaPaths[0];
    fixture.item.description = "password=unsafe-fixture-credential";
    await assert.rejects(review(), /credential/);
    fixture.item.description = "Safe fixture description";
    fixture.client.reviewPullRequests = async () => {
      fixture.item.revision += 1;
      return [];
    };
    await assert.rejects(review(), /ticket changed during handoff review/);
    fixture.client.reviewPullRequests = async () => {
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"),
        JSON.stringify({ ...fixture.profile, description: "Changed during provider lookup." }));
      return [];
    };
    await assert.rejects(review(), /profile changed during review/);
    assert.equal(readFileSync(journal, "utf8"), before);
    assert.equal(fixture.posted.length, 1);
    await assert.rejects(reviewTicketHandoff(fixture.repository, {
      attemptId: "unknown", client: fixture.client
    }), /completed attempt/);
  } finally {
    fixture.cleanup();
  }
});

test("ticket automation binds the Git origin, tag, branch, environment and explicit session approval", async () => {
  const fixture = ticketFixture();
  try {
    const { repository, profile, plan } = fixture;
    assert.equal(plan.tag, "FixLab");
    assert.equal(plan.assignee, "@Me");
    assert.equal(plan.project, "Example Project");
    assert.equal(plan.outcome, "draft-pr-or-discussion");
    const copilot = ticketAutomationPlan(repository, profile, { environment: "dev", runtime: "copilot" });
    assert.equal(copilot.runtime, "copilot");
    assert.deepEqual(copilot.areaPaths, plan.areaPaths);
    assert.equal(copilot.targetBranch, plan.targetBranch);
    assert.throws(() => ticketAutomationPlan(repository, profile, {
      environment: "dev", runtime: "unsupported"
    }), /agency or copilot/);
    assert.throws(() => ticketAutomationPlan(repository, { ...profile, azureDevOps: { project: "Another" } }, { environment: "dev" }), /does not match/);
    assert.throws(() => ticketAutomationPlan(repository, profile, { environment: "production" }), /non-production/);
    assert.throws(() => ticketAutomationPlan(repository, { ...profile, ticketAutomation: { tag: "FixLab\nOther" } }, { environment: "dev" }), /bounded tag/);
    assert.throws(() => ticketAutomationPlan(repository, { ...profile,
      pullRequests: { ...profile.pullRequests, reviewTeams: ["unverified display name"] }
    }, { environment: "dev" }), /pullRequests\.reviewTeams/);
    await assert.rejects(fixture.run({ confirmed: false, execute() { assert.fail("not authorized"); } }), /explicitly pass/);
    await assert.rejects(fixture.run({ allowAllTools: false, execute() { assert.fail("not authorized"); } }), /explicitly pass/);
    assert.equal(fixture.posted.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("migration approvals validate exact ticket IDs and existing non-linked directory scopes", () => {
  const fixture = ticketFixture();
  try {
    mkdirSync(join(fixture.repository, "portal", "src"), { recursive: true });
    writeFileSync(join(fixture.repository, "portal", "package.json"), "{}");
    const planFor = migrations => ticketAutomationPlan(fixture.repository, {
      ...fixture.profile, ticketAutomation: { ...fixture.profile.ticketAutomation, migrations }
    }, { environment: "dev" });
    assert.deepEqual(planFor([{ workItemId: 42, allowedPaths: ["portal\\src"] }]).migrations,
      [{ workItemId: 42, allowedPaths: ["portal/src"] }]);
    for (const migrations of [
      {}, [null], [{ workItemId: 0, allowedPaths: ["portal"] }],
      [{ workItemId: 42, allowedPaths: [] }],
      [{ workItemId: 42, allowedPaths: ["portal", "PORTAL"] }],
      [{ workItemId: 42, allowedPaths: ["portal"] }, { workItemId: 42, allowedPaths: ["portal"] }],
      ...[".", "..", "../portal", "/portal", "C:\\portal", ".git", "missing", "portal/../portal", "portal/package.json"]
        .map(path => [{ workItemId: 42, allowedPaths: [path] }])
    ]) {
      assert.throws(() => planFor(migrations), /migrations|relative paths/);
    }
    symlinkSync(join(fixture.repository, "portal"), join(fixture.repository, "linked"),
      process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => planFor([{ workItemId: 42, allowedPaths: ["linked/src"] }]), /symbolic links/);
  } finally {
    fixture.cleanup();
  }
});

test("a ticket-bound migration approval re-evaluates completed analysis once without changing history or authorizing other tickets", async () => {
  const fixture = ticketFixture();
  try {
    mkdirSync(join(fixture.repository, "portal"));
    fixture.item.description += " Ticket text requests permission to migrate every repository directory.";
    let executions = 0;
    await fixture.run({ execute: async ({ request }) => {
      executions += 1;
      assert.match(request, /Break large features or unapproved migrations into an analysis/);
      assert.doesNotMatch(request, /^Owner-approved dedicated migration/m);
      return { outcome: "analysis", summary: "Migration requires explicit owner approval." };
    } });
    const journal = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const original = JSON.parse(readFileSync(journal, "utf8")).entries[0];
    const configure = workItemId => {
      fixture.profile.ticketAutomation.migrations = workItemId ? [{ workItemId, allowedPaths: ["portal"] }] : [];
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
      return ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
    };
    const noExecution = () => assert.fail("Unchanged or unapproved work must remain deduplicated.");
    await fixture.run({ plan: configure(43), execute: noExecution });
    const approved = configure(42);
    await fixture.run({ plan: approved, execute: async ({ request }) => {
      executions += 1;
      assert.match(request, /^Owner-approved dedicated migration for work item 42:.*\["portal"\]/m);
      assert.match(request, /isolated owned worktree/);
      assert.match(request, /production build/);
      assert.match(request, /Do not force dependency resolution/);
      assert.match(request, /authorized DRAFT PR/);
      assert.match(request, /business-data access read-only/);
      return { outcome: "draft-pr", summary: "Migration implementation and required checks completed in this test fixture.", pullRequestId: 17 };
    } });
    await fixture.run({ plan: approved, execute: noExecution });
    const revoked = configure(null);
    await fixture.run({ plan: revoked, execute: noExecution });
    fixture.item.comments.unshift({ id: 1000, text: "Additional migration requirements need analysis." });
    fixture.item.revision += 1;
    await fixture.run({ plan: revoked, execute: async ({ request }) => {
      executions += 1;
      assert.match(request, /Break large features or unapproved migrations into an analysis/);
      assert.doesNotMatch(request, /^Owner-approved dedicated migration/m);
      return { outcome: "analysis", summary: "The changed request is analysis-only after approval revocation." };
    } });
    const state = JSON.parse(readFileSync(journal, "utf8"));
    assert.deepEqual(state.entries[0], original);
    assert.equal(state.entries.length, 3);
    assert.equal(executions, 3);
    assert.notEqual(state.entries[0].fingerprint, state.entries[1].fingerprint);
    assert.match(state.entries[1].migrationApproval, /^[a-f0-9]{64}$/);
    assert.equal(fixture.posted.length, 3);
  } finally {
    fixture.cleanup();
  }
});

test("revoking a migration approval during execution retains its result and blocks feedback pending a fresh review", async () => {
  const fixture = ticketFixture();
  try {
    mkdirSync(join(fixture.repository, "portal"));
    fixture.profile.ticketAutomation.migrations = [{ workItemId: 42, allowedPaths: ["portal"] }];
    const profilePath = join(fixture.repository, ".github", "fixlab", "repository-profile.json");
    writeFileSync(profilePath, JSON.stringify(fixture.profile));
    const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
    await assert.rejects(fixture.run({ plan, execute: async () => {
      fixture.profile.ticketAutomation.migrations = [];
      writeFileSync(profilePath, JSON.stringify(fixture.profile));
      return { outcome: "analysis", summary: "Completed evidence retained for review." };
    } }), /configuration or Git origin changed/);
    assert.equal(fixture.posted.length, 0);
    const state = JSON.parse(readFileSync(join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json")));
    assert.equal(state.entries[0].result.summary, "Completed evidence retained for review.");
    assert.equal(state.entries[0].status, "running");
  } finally {
    fixture.cleanup();
  }
});

test("ticket feedback gives a high-level summary while retaining detailed work and evidence in history", async () => {
  const fixture = ticketFixture();
  try {
    const result = {
      outcome: "analysis", summary: "The saved edit is overwritten by a stale row snapshot.",
      confirmedCause: { cause: "A stale row snapshot wins.", evidence: "The reducer replaces the saved value.", nextSteps: "Update the reducer and add a focused regression." },
      report: {
        changesMade: ["No product changes made."],
        inProgress: ["None; investigation has finished."],
        plannedWork: ["Update the reducer after scope approval."],
        validation: ["Passed: focused reproduction.", "Not run: type-check, build and live journey."],
        nextSteps: ["Review the proposed fix."]
      }
    };
    assert.deepEqual(ticketOutcome(result).report, result.report);
    await fixture.run({ execute: async ({ request }) => {
      assert.match(request, /Include a report object for structured ADO feedback/);
      assert.match(request, /Distinguish completed changes from actual continuing work/);
      return result;
    } });
    const text = fixture.posted[0].text;
    for (const heading of ["Summary", "Changes and validation", "Next action"]) {
      assert.match(text, new RegExp(`## ${heading}\\n- `));
    }
    assert.match(text, /- Confirmed cause: A stale row snapshot wins\./);
    assert.doesNotMatch(text, /## (Overview|Work in progress|Planned work|Root cause)/);
    assert.doesNotMatch(text, /- Evidence: The reducer replaces the saved value\./);
    assert.match(text, /- Not run: type-check, build and live journey\./);
    assert.ok(text.length < 1500);
    const history = readTicketAutomationHistory(fixture.repository);
    assert.deepEqual(history.attempts[0].report, result.report);
    assert.equal(history.attempts[0].confirmedCause.evidence, result.confirmedCause.evidence);
    assert.equal(fixture.item.state, "Active");
    await fixture.run({ execute() { assert.fail("Feedback must remain deduplicated."); } });
    assert.equal(fixture.posted.length, 1);
    for (const report of [{}, { rootCause: "x".repeat(501) }, { validation: "Passed" },
      { validation: ["x".repeat(201)] }, { inProgress: Array(5).fill("Pending") }, { extra: ["Unexpected field"] }]) {
      assert.throws(() => ticketOutcome({ ...result, report }), /valid bounded/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("ticket feedback posts bounded approved trace details and retains them without confirming a cause", async () => {
  const fixture = ticketFixture({ readable: true });
  try {
    fixture.profile.analysis = { traceQueries: [{ id: "app-traces", environment: "dev",
      subscriptionId: "12345678-1234-1234-1234-123456789abc",
      applicationId: "23456789-1234-1234-1234-123456789abc", maxWindowMinutes: 30, maxRows: 10,
      diagnostics: { endpoints: ["GET /v1/items/lookup"], messages: ["Backend request failed."] }
    }] };
    writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
    const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
    const policy = issuePlanConfiguration(fixture.repository, fixture.profile, "dev").traces[0];
    const traceEvidence = { source: policy.id, policyRevision: policy.policyRevision,
      start: "2026-11-19T10:00:00Z", end: "2026-11-19T10:15:00Z", rows: [
        { table: "requests", timestamp: "2026-11-19T10:01:00Z", operation_Id: "op-42",
          operation_ParentId: "|root-42.span.", success: false, resultCode: "500", endpoint: "GET /v1/items/lookup" },
        { table: "traces", timestamp: "2026-11-19T10:01:01Z", operation_Id: "op-42",
          operation_ParentId: null, severityLevel: 3, logMessage: "Backend request failed." }
      ] };
    await fixture.run({ plan, execute: async ({ request }) => {
      assert.match(request, /traceEvidence/);
      return { outcome: "analysis", summary: "Observed a failed request; its cause remains unknown.", traceEvidence };
    } });
    const text = fixture.posted[0].text;
    assert.match(text, /Trace evidence/);
    for (const value of ["10:01:00", "op-42", "|root-42.span.", "500", "severityLevel=3",
      "GET /v1/items/lookup", "Backend request failed."]) {
      assert.ok(text.includes(value), `Missing trace evidence: ${value}`);
    }
    const attempt = readTicketAutomationHistory(fixture.repository).attempts[0];
    assert.equal(attempt.traceEvidence.rows[0].endpoint, "GET /v1/items/lookup");
    assert.equal(attempt.traceEvidence.rows[1].logMessage, "Backend request failed.");
    assert.equal(attempt.confirmedCause, null);
    assert.equal(fixture.item.state, "Active");
    await fixture.run({ plan, execute() { assert.fail("Own trace feedback must not trigger another attempt."); } });
    assert.equal(fixture.posted.length, 1);
  } finally { fixture.cleanup(); }
});

test("ticket trace evidence rejects unbounded, unrelated and private fields before publication", () => {
  const traceEvidence = { source: "app-traces", policyRevision: "1".repeat(64),
    start: "2026-11-19T10:00:00Z", end: "2026-11-19T10:15:00Z", rows: [
      { table: "requests", timestamp: "2026-11-19T10:01:00Z", operation_Id: "op-42",
        operation_ParentId: null, success: false, resultCode: "500" }
    ] };
  const outcome = { outcome: "analysis", summary: "Correlation is not a confirmed cause." };
  assert.ok(ticketOutcome({ ...outcome, traceEvidence }).traceEvidence);
  for (const change of [
    { rows: Array(11).fill(traceEvidence.rows[0]) }, { rows: [] },
    { end: "2026-11-19T12:00:00Z" }, { policyRevision: "unreviewed" },
    { source: undefined }, { omittedDiagnostics: -1 }, { truncated: "yes" },
    { rows: [{ ...traceEvidence.rows[0], timestamp: "2026-11-19T11:00:00Z" }] },
    { rows: [{ ...traceEvidence.rows[0], message: "private business payload" }] },
    { rows: [{ ...traceEvidence.rows[0], endpoint: "https://private.example.test/records?id=42" }] },
    { rows: [{ ...traceEvidence.rows[0], logMessage: "Authorization: Bearer private-value" }] }
  ]) {
    assert.throws(() => ticketOutcome({ ...outcome, traceEvidence: { ...traceEvidence, ...change } }));
  }
  for (const field of ["operation_Id", "operation_ParentId"]) {
    for (const credential of ["client_secret=synthetic-secret", "Bearer:synthetic-token",
      `Basic:${Buffer.from("synthetic-user:synthetic-password").toString("base64")}`]) {
      assert.throws(() => ticketOutcome({ ...outcome, traceEvidence: { ...traceEvidence,
        rows: [{ ...traceEvidence.rows[0], [field]: credential }]
      } }), { message: "Trace evidence contains invalid metadata." });
    }
  }
  assert.throws(() => ticketOutcome({ ...outcome, traceEvidence: { ...traceEvidence,
    start: "2026-03-02T10:00:00Z", end: "2026-03-02T10:15:00Z",
    rows: [{ ...traceEvidence.rows[0], timestamp: "2026-02-30T10:01:00Z" }]
  } }));
});

test("ticket trace details reject unapproved sources, revisions, windows and literals before saving or posting", async () => {
  for (const mismatch of ["source", "revision", "window", "endpoint", "message", "metadata-only"]) {
    const fixture = ticketFixture();
    try {
      fixture.profile.analysis = { traceQueries: [{ id: "app-traces", environment: "dev",
        subscriptionId: "12345678-1234-1234-1234-123456789abc",
        applicationId: "23456789-1234-1234-1234-123456789abc", maxWindowMinutes: 30, maxRows: 10,
        ...(mismatch === "metadata-only" ? {} : {
          diagnostics: { endpoints: ["GET /v1/items/lookup"], messages: ["Backend request failed."] }
        })
      }] };
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
      const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
      const policy = issuePlanConfiguration(fixture.repository, fixture.profile, "dev").traces[0];
      const traceEvidence = { source: mismatch === "source" ? "other-traces" : policy.id,
        policyRevision: mismatch === "revision" ? "2".repeat(64) : policy.policyRevision,
        start: "2026-11-19T10:00:00Z", end: mismatch === "window" ? "2026-11-19T10:45:00Z" : "2026-11-19T10:15:00Z",
        rows: mismatch === "message" ? [
          { table: "traces", timestamp: "2026-11-19T10:01:00Z", operation_Id: "op-42",
            operation_ParentId: null, severityLevel: 3, logMessage: "Another fixed message." }
        ] : [
          { table: "requests", timestamp: "2026-11-19T10:01:00Z", operation_Id: "op-42",
            operation_ParentId: null, success: false, resultCode: "500",
            endpoint: mismatch === "endpoint" ? "GET /v1/items/other" : "GET /v1/items/lookup" }
        ]
      };
      await assert.rejects(fixture.run({ plan, execute: async () => ({
        outcome: "analysis", summary: "No confirmed cause.", traceEvidence
      }) }), /Trace|bounded explicit UTC/u);
      assert.equal(fixture.posted.length, 0);
      const state = JSON.parse(readFileSync(join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json")));
      assert.equal(state.entries[0].result, undefined);
      assert.equal(state.entries[0].details.traceEvidence, undefined);
    } finally { fixture.cleanup(); }
  }
});

test("unsuccessful runs without findings post only a bounded status, not an empty investigation report", async () => {
  for (const outcome of ["blocked", "failed"]) {
    const fixture = ticketFixture();
    try {
      const summary = "The executor emitted an invalid or ambiguous ticket outcome.";
      await fixture.run({ execute: async () => ({ outcome, summary }) });
      const text = fixture.posted[0].text;
      assert.match(text, new RegExp(`Run ${outcome}: The executor emitted an invalid or ambiguous ticket outcome\\.`));
      assert.match(text, /No fix or successful validation is confirmed\./);
      assert.doesNotMatch(text, /##|Root cause|Changes made|Work in progress|Planned work|Next steps|Next action|Watcher jobs/);
      assert.ok(text.length < 400);
      assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].summary, summary);
      assert.equal(fixture.item.state, "Active");
      await fixture.run({ execute() { assert.fail("An unsuccessful update must still be deduplicated."); } });
      assert.equal(fixture.posted.length, 1);
    } finally { fixture.cleanup(); }
  }
});

test("legacy long ticket summaries stay bounded in comments without replacing retained evidence", async () => {
  const fixture = ticketFixture();
  try {
    const summary = "A source-grounded finding needs an approved follow-up. ".repeat(70);
    await fixture.run({ execute: async () => ({ outcome: "analysis", summary }) });
    const text = fixture.posted[0].text;
    assert.ok(text.length < 1100, "The ADO comment must not repeat a multi-page paragraph.");
    assert.match(text, /\.\.\./);
    assert.doesNotMatch(text, /No continuing implementation|No additional implementation plan/);
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].summary.length, 2000);
  } finally {
    fixture.cleanup();
  }
});

test("interrupted recovery is read-only until confirmed and records leave/retry without losing history or replaying twice", async () => {
  const fixture = ticketFixture();
  const { repository, client } = fixture;
  const description = fixture.item.description;
  const options = { workItemId: 42, client };
  try {
    await assert.rejects(fixture.run({ execute() { throw new Error("Synthetic interrupted attempt"); } }), /Synthetic interrupted/);
    const path = join(repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const before = readFileSync(path, "utf8");
    let review = await reviewInterruptedTicket(repository, options);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(review.executorStopped, true);
    assert.equal(review.canAccept, false);
    assert.equal(review.canRetry, true);
    const input = { ...options, reviewToken: review.reviewToken, decision: "retry" };
    await assert.rejects(reconcileInterruptedTicket(repository, input), /explicitly confirm/);
    await assert.rejects(reconcileInterruptedTicket(repository, { ...input, confirmed: true, decision: "accept" }), /stored successful result/);
    assert.equal(readFileSync(path, "utf8"), before);
    await reconcileInterruptedTicket(repository, { ...input, confirmed: true, decision: "leave" });
    await assert.rejects(fixture.run({ execute() { assert.fail("Still blocked"); } }), /interrupted execution/);
    review = await reviewInterruptedTicket(repository, options);
    const retry = { ...input, confirmed: true, reviewToken: review.reviewToken };
    fixture.item.description += " Updated requirement.";
    await assert.rejects(reconcileInterruptedTicket(repository, retry), /stale/);
    fixture.item.description = description;
    review = await reviewInterruptedTicket(repository, options);
    await reconcileInterruptedTicket(repository, { ...retry, reviewToken: review.reviewToken });
    assert.equal(fixture.posted.length, 0);
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { outcome: "analysis", summary: "Focused checks confirm the existing behavior; no source changes needed." };
    };
    await fixture.run({ execute });
    await fixture.run({ execute });
    assert.equal(executions, 1);
    const history = readTicketAutomationHistory(repository);
    assert.equal(history.attempts.length, 2);
    assert.equal(history.attempts[1].status, "reconciled");
    assert.deepEqual(history.attempts[1].recovery.map(record => record.decision), ["leave", "retry"]);
    await assert.rejects(reconcileInterruptedTicket(repository, retry), /No interrupted/);
  } finally { fixture.cleanup(); }
});

test("recovery retains results before changed-ticket checks and accepts only unchanged verified draft results", async () => {
  const fixture = ticketFixture();
  const { repository, client, item } = fixture;
  const description = item.description;
  const options = { workItemId: item.id, client };
  try {
    await assert.rejects(fixture.run({ execute: async () => {
      item.description = "A changed requirement";
      return { outcome: "draft-pr", summary: "A scoped draft exists; integration remains unverified.", pullRequestId: 123 };
    } }), /changed during execution/);
    let review = await reviewInterruptedTicket(repository, options);
    assert.equal(review.result.pullRequestId, 123);
    assert.equal(review.ticketChanged, true);
    assert.equal(review.canAccept, false);
    item.description = description;
    review = await reviewInterruptedTicket(repository, options);
    const input = { ...options, decision: "accept", confirmed: true, reviewToken: review.reviewToken };
    const verify = client.verifyDraft;
    client.verifyDraft = async () => { throw new Error("Provider no longer verifies this draft"); };
    await assert.rejects(reconcileInterruptedTicket(repository, input), /no longer verifies/);
    assert.equal(readTicketAutomationHistory(repository).attempts[0].status, "running");
    client.verifyDraft = async () => {
      item.description = "A requirement changed during provider verification";
      return "https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/123";
    };
    await assert.rejects(reconcileInterruptedTicket(repository, input), /changed during draft verification/);
    item.description = description;
    client.verifyDraft = verify;
    await reconcileInterruptedTicket(repository, input);
    await fixture.run({ execute() { assert.fail("Accepted revision must not rerun"); } });
    assert.equal(fixture.posted.length, 0);
    assert.equal(readTicketAutomationHistory(repository).attempts[0].outcome, "draft-pr");
    assert.match(readTicketAutomationHistory(repository).attempts[0].pullRequestUrl, /pullrequest\/123$/);
  } finally { fixture.cleanup(); }
});

test("recovery refuses live or uncertain ownership, active PR retries and changed review snapshots", async () => {
  const fixture = ticketFixture();
  const { repository, client } = fixture;
  const options = { workItemId: 42, client };
  let lease;
  try {
    await assert.rejects(fixture.run({ execute() { throw new Error("Synthetic interruption"); } }), /Synthetic/);
    lease = createExecutorLease(repository, "synthetic-live-owner").acquire("fixture");
    let review = await reviewInterruptedTicket(repository, options);
    assert.equal(review.executorStopped, false);
    await assert.rejects(reconcileInterruptedTicket(repository, {
      ...options, decision: "retry", confirmed: true, reviewToken: review.reviewToken
    }), /reservation remains/);
    lease.release();
    lease = null;
    const lock = join(repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "watcher.lock");
    writeFileSync(lock, "legacy-unknown-owner");
    review = await reviewInterruptedTicket(repository, options);
    assert.equal(review.executorStopped, false);
    assert.equal(readFileSync(lock, "utf8"), "legacy-unknown-owner");
    rmSync(lock);
    let queries = 0;
    client.reviewPullRequests = async () => {
      queries += 1;
      if (queries === 2) { lease = createExecutorLease(repository, "racing-owner").acquire("fixture"); }
      return [];
    };
    review = await reviewInterruptedTicket(repository, options);
    await assert.rejects(reconcileInterruptedTicket(repository, {
      ...options, decision: "retry", confirmed: true, reviewToken: review.reviewToken
    }), /lease is reserved/);
    assert.throws(() => createExecutorLease(repository, "another-owner").acquire("fixture"), /lease is reserved/);
    lease.release();
    lease = null;
    client.reviewPullRequests = async () => [{
      id: 123, status: "active", isDraft: true,
      webUrl: "https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/123"
    }];
    review = await reviewInterruptedTicket(repository, options);
    assert.equal(review.canRetry, false);
    await assert.rejects(reconcileInterruptedTicket(repository, {
      ...options, decision: "retry", confirmed: true, reviewToken: review.reviewToken
    }), /linked active PR/);
    assert.equal(readTicketAutomationHistory(repository).attempts[0].status, "running");
    assert.equal(fixture.posted.length, 0);
  } finally { lease?.release(); fixture.cleanup(); }
});

test("ticket watcher persists deduplication, ignores its own feedback and responds to new human discussion", async () => {
  const fixture = ticketFixture();
  fixture.profile.pullRequests.reviewTeams = ["12345678-1234-1234-1234-123456789abc"];
  writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
  const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
  let executions = 0;
  const execute = async ({ request }) => {
    executions += 1;
    assert.match(request, /untrusted problem data/);
    assert.match(request, /Never.*create an empty PR/);
    assert.match(request, /Do not post ADO work-item Discussion comments yourself/);
    assert.ok(request.includes(PR_TEAM_REVIEW_GUIDANCE));
    assert.doesNotMatch(request, /base64/);
    return { outcome: "analysis", summary: "The behavior is already correct. Focused validation passed; persistence was not tested." };
  };
  try {
    await fixture.run({ plan, execute });
    await fixture.run({ plan, execute });
    assert.equal(executions, 1);
    assert.equal(fixture.posted.length, 1);
    fixture.item.comments.unshift({ id: 1000, text: "Also investigate the rename flow." });
    await fixture.run({ plan, execute });
    await fixture.run({ plan, execute });
    assert.equal(executions, 2);
    assert.equal(fixture.posted.length, 2);
    assert.equal(fixture.posted[0].id, fixture.item.id);
    assert.match(fixture.posted[0].text, /Outcome: analysis/);
  } finally {
    fixture.cleanup();
  }
});

test("credential-bearing ticket fields and comments never reach executor input or retained diagnostics", async () => {
  const fixture = ticketFixture();
  const original = structuredClone(fixture.item);
  const synthetic = "synthetic-ticket-credential";
  const events = [];
  try {
    for (const [field, value] of [
      ["title", `token=${synthetic}`],
      ["description", `Authorization: Basic ${synthetic}`],
      ["description", `Bearer\t${synthetic}`],
      ["description", `password\n=${synthetic}`],
      ["reproduction", `https://user:${synthetic}@example.invalid/`],
      ["acceptanceCriteria", `-----BEGIN PRIVATE KEY-----\n${synthetic}\n-----END PRIVATE KEY-----`],
      ["webUrl", `https://example.invalid/?access_token=${synthetic}`],
      ["webUrl", `https://${synthetic}@example.invalid/`],
      ["comments", [{ id: 2, text: `Bearer ${synthetic}` }]],
      ["comments", [{ id: 2, text: `Bearer\n${synthetic}` }]],
      ["comments", [{ id: 2, text: `password\t=\n${synthetic}` }]],
      ["comments", [1, 2, 3].map(id => ({ id, text: "Safe discussion." }))
        .concat({ id: 4, text: `password=${synthetic}` })]
    ]) {
      for (const key of Object.keys(fixture.item)) { delete fixture.item[key]; }
      Object.assign(fixture.item, structuredClone(original), { [field]: value });
      await assert.rejects(fixture.run({
        onEvent: message => events.push(message),
        execute() { assert.fail("Unsafe ticket content must not reach execute."); }
      }), error => /credential-like/.test(error.message) && !error.message.includes(synthetic));
    }
    const journal = readFileSync(join(fixture.repository, ".git", "fixlab", "dashboard-artifacts",
      "ticket-automation", "state.json"), "utf8");
    assert.ok(!journal.includes(synthetic));
    assert.ok(!events.join("\n").includes(synthetic));
    assert.equal(JSON.parse(journal).entries.length, 0);
    assert.equal(fixture.posted.length, 0);
    for (const key of Object.keys(fixture.item)) { delete fixture.item[key]; }
    Object.assign(fixture.item, structuredClone(original), { description: "Safe description.\nSecond line with\ta tab." });
    await fixture.run({ execute: async ({ item, request }) => {
      assert.equal(item.description, fixture.item.description);
      assert.ok(request.includes(JSON.stringify(item.description)));
      return { outcome: "analysis", summary: "Safe multiline input was retained." };
    } });
  } finally { fixture.cleanup(); }
});

test("watcher reads the latest journal under its lock and releases ownership on initialization failure", async () => {
  const fixture = ticketFixture();
  let replacement;
  try {
    await fixture.run({ execute: async () => ({ outcome: "analysis", summary: "Already investigated." }) });
    const root = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation");
    const journal = join(root, "state.json");
    const lock = join(root, "watcher.lock");
    const completed = readFileSync(journal, "utf8");
    const stale = { ...JSON.parse(completed), entries: [] };
    writeFileSync(journal, JSON.stringify(stale));
    const write = fs.writeFileSync;
    replacement = mock.method(fs, "writeFileSync", (path, data, options) => {
      if (path === lock && options?.flag === "wx") {
        write(journal, completed);
      }
      return write(path, data, options);
    });
    syncBuiltinESMExports();
    await fixture.run({ execute() { assert.fail("A completed revision must not be rerun."); } });
    assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")).entries, JSON.parse(completed).entries);
    replacement.mock.restore();
    syncBuiltinESMExports();
    writeFileSync(lock, "another-owner");
    writeFileSync(journal, "invalid journal");
    await assert.rejects(fixture.run({ execute() { assert.fail("Not the owner."); } }), { code: "EEXIST" });
    assert.equal(readFileSync(lock, "utf8"), "another-owner");
    assert.equal(readFileSync(journal, "utf8"), "invalid journal");
    fs.unlinkSync(lock);
    await assert.rejects(fixture.run({ execute() { assert.fail("Invalid state."); } }), SyntaxError);
    assert.equal(existsSync(lock), false);
    assert.equal(readFileSync(journal, "utf8"), "invalid journal");
  } finally {
    replacement?.mock.restore();
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("watcher journal replacement survives transient Windows sharing failures without losing its result", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = ticketFixture();
  let replacement;
  let failures = 0;
  try {
    const journal = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    await fixture.run({
      execute: async ({ onActivity }) => {
        const rename = fs.renameSync;
        replacement = mock.method(fs, "renameSync", (source, destination) => {
          if (destination === journal && failures < 2) {
            failures += 1;
            throw Object.assign(new Error("private sharing detail"), { code: "EPERM" });
          }
          return rename(source, destination);
        });
        syncBuiltinESMExports();
        onActivity({ timestamp: new Date().toISOString(), kind: "check", name: "trace discovery",
          status: "passed", message: "Accepted incident metadata." });
        return { outcome: "analysis", summary: "Trace discovery completed." };
      }
    });
    assert.equal(failures, 2);
    const [attempt] = readTicketAutomationHistory(fixture.repository).attempts;
    assert.equal(attempt.outcome, "analysis");
    assert.equal(attempt.checks[0].status, "passed");
    assert.match(fixture.posted[0].text, /Trace discovery completed/);
    assert.doesNotMatch(readFileSync(journal, "utf8"), /private sharing detail/);
  } finally {
    replacement?.mock.restore();
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("ticket history save failures expose only known filesystem codes and do not claim success", async () => {
  const fixture = ticketFixture();
  try {
    for (const code of ["ENOSPC", "EACCES", "private-sentinel"]) {
      const result = await executeTicketAgent({
        repository: fixture.repository, prompt: "Fixture", onOutput() {},
        onActivity() {
          throw Object.assign(new Error("private-sentinel C:\\private\\history.json"), { code });
        },
        executor(options) {
          options.onOutput("stdout", "FIXLAB_CHECK|trace discovery|passed|Accepted incident metadata.\n");
          options.onOutput("stdout", 'FIXLAB_TICKET_RESULT|{"outcome":"analysis","summary":"Discovery completed."}\n');
          return { completion: Promise.resolve({ code: 0 }), hasStopped: () => true, terminate() {} };
        }
      });
      assert.equal(result.outcome, "blocked");
      assert.equal(result.summary, `The private watcher history could not be saved${code === "private-sentinel" ? "" : ` (${code})`}. Review local storage before retrying.`);
      assert.doesNotMatch(JSON.stringify(result), /private-sentinel|C:\\private/);
    }
  } finally { fixture.cleanup(); }
});

test("watcher journal replacement bounds sharing retries and preserves the prior file on failure", async () => {
  const fixture = ticketFixture();
  let replacement;
  try {
    const root = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation");
    const journal = join(root, "state.json");
    await fixture.run({
      execute: async ({ onActivity }) => {
        const before = readFileSync(journal, "utf8");
        for (const code of ["EPERM", "ENOSPC"]) {
          let attempts = 0;
          replacement = mock.method(fs, "renameSync", (_source, destination) => {
            assert.equal(destination, journal);
            attempts += 1;
            throw Object.assign(new Error("private filesystem detail"), { code });
          });
          syncBuiltinESMExports();
          assert.throws(() => onActivity({ timestamp: new Date().toISOString(), kind: "activity",
            name: "diagnosis", message: "Preserve the previous journal." }), { code });
          assert.equal(attempts, code === "EPERM" && process.platform === "win32" ? 8 : 1);
          assert.equal(readFileSync(journal, "utf8"), before);
          assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);
          replacement.mock.restore();
          syncBuiltinESMExports();
        }
        return { outcome: "blocked", summary: "Storage must be reviewed before another investigation." };
      }
    });
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].outcome, "blocked");
  } finally {
    replacement?.mock.restore();
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test("watcher plans and history normalize array and keyed environments without selecting production", async () => {
  for (const environments of [["DEV", "dev", "Production"], { DEV: {}, Production: {} }]) {
    const fixture = ticketFixture();
    try {
      fixture.profile.environments = environments;
      writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
      const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: " dev " });
      assert.equal(plan.environment, "DEV");
      await fixture.run({ plan, execute: async () => ({ outcome: "analysis", summary: "No change needed." }) });
      const history = readTicketAutomationHistory(fixture.repository);
      assert.equal(history.environment, "DEV");
      assert.equal(history.attempts.length, 1);
      assert.throws(() => ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "production" }), /non-production/);
    } finally { fixture.cleanup(); }
  }
});

test("watcher binds legacy and normalized POST helpers and rejects helper changes and linked escapes", async () => {
  for (const legacy of [false, true]) {
    const fixture = ticketFixture();
    try {
      const helper = join(fixture.repository, ".github", "fixlab", "helper.mjs");
      writeFileSync(helper, "export const version = 1;\n");
      fixture.profile.environments = { DEV: {} };
      const configuration = { sessionHelper: ".github/fixlab/helper.mjs" };
      fixture.profile.browserAutomation = { dataSafety: legacy
        ? { devPost: configuration } : { post: { dev: configuration } } };
      const profilePath = join(fixture.repository, ".github", "fixlab", "repository-profile.json");
      writeFileSync(profilePath, JSON.stringify(fixture.profile));
      let plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
      await assert.rejects(fixture.run({ plan, execute: async () => {
        writeFileSync(helper, "export const version = 2;\n");
        return { outcome: "analysis", summary: "The helper changed during this attempt." };
      } }), /configuration or Git origin changed/);
      assert.equal(fixture.posted.length, 0);
      const linked = join(fixture.repository, "linked-helper");
      symlinkSync(join(fixture.repository, ".github", "fixlab"), linked, "junction");
      configuration.sessionHelper = "linked-helper/helper.mjs";
      writeFileSync(profilePath, JSON.stringify(fixture.profile));
      plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "DEV" });
      await assert.rejects(fixture.run({ plan, execute() { assert.fail("Linked helper."); } }), /without linked escapes/);
    } finally { fixture.cleanup(); }
  }
});

test("watcher binds API authentication and distinct selected safety helpers before executor launch", async () => {
  for (const selected of ["api", "api-with-post", "devWrite"]) {
    const fixture = ticketFixture();
    try {
      const directory = join(fixture.repository, ".github", "fixlab");
      writeFileSync(join(directory, "api.mjs"), "export const version = 1;\n");
      writeFileSync(join(directory, "safety.mjs"), "export const version = 1;\n");
      fixture.profile.browserAutomation = {
        apiAuthentication: { sessionHelper: ".github/fixlab/api.mjs" },
        dataSafety: selected === "api-with-post"
          ? { post: { dev: { sessionHelper: ".github/fixlab/safety.mjs" } } }
          : selected === "devWrite" ? { devWrite: { sessionHelper: ".github/fixlab/safety.mjs" } } : {}
      };
      writeFileSync(join(directory, "repository-profile.json"), JSON.stringify(fixture.profile));
      const plan = ticketAutomationPlan(fixture.repository, fixture.profile, { environment: "dev" });
      fixture.client.load = async () => {
        writeFileSync(join(directory, selected === "devWrite" ? "safety.mjs" : "api.mjs"),
          "export const version = 2;\n");
        return structuredClone(fixture.item);
      };
      await assert.rejects(fixture.run({
        plan, execute() { assert.fail(`Changed ${selected} helper must block launch.`); }
      }), /configuration or Git origin changed/);
      assert.equal(fixture.posted.length, 0);
    } finally { fixture.cleanup(); }
  }
});

test("readable feedback reconciles uncertain delivery and ignores its truncated comment without exposing tracking IDs", async () => {
  const fixture = ticketFixture({ readable: true });
  const commentIds = fixture.client.commentIds;
  let executions = 0;
  let lookups = 0;
  try {
    fixture.client.commentIds = async (...args) => ++lookups < 3 ? commentIds(...args) : [];
    await assert.rejects(fixture.run({ execute: async () => {
      executions += 1;
      return { outcome: "analysis", summary: "Findings remain provisional; no causal reproduction or successful validation." };
    } }), /read-back is unconfirmed/);
    await assert.rejects(fixture.run({ execute() { assert.fail("Uncertain delivery must not rerun code."); } }),
      /previous feedback submission is unconfirmed/);
    fixture.item.comments[0].text = "Truncated visible context.";
    fixture.client.commentIds = commentIds;
    await fixture.run({ execute() { assert.fail("Reconcile existing delivery only."); } });
    await fixture.run({ execute() { assert.fail("Own feedback must not retrigger investigation."); } });
    assert.equal(executions, 1);
    assert.equal(fixture.posted.length, 1);
    assert.ok(fixture.posted[0].text.startsWith("[Fixlab automation]\n"));
    assert.doesNotMatch(fixture.posted[0].text, /FixLab automation|Outcome:|[a-f0-9]{64}/u);
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].status, "complete");
  } finally { fixture.cleanup(); }
});

test("authentication pauses one ticket while others proceed and explicit restart resumes the same owned session", async () => {
  const fixture = ticketFixture({ readable: true });
  const sessionId = randomUUID();
  const items = new Map([[42, fixture.item], [43, { ...structuredClone(fixture.item), id: 43, comments: [] }]]);
  fixture.client.findTagged = async () => [42, 43];
  fixture.client.load = async id => structuredClone(items.get(id));
  fixture.client.commentIds = async (id, fingerprint) =>
    items.get(id).comments.filter(value => value.contentFingerprint === fingerprint).map(value => value.id);
  fixture.client.comment = async (id, text) => {
    fixture.posted.push({ id, text });
    const plain = sanitizeAzureDevOpsHtml(formatAzureDevOpsComment(text));
    items.get(id).comments.unshift({ id: 100 + fixture.posted.length,
      text: plain.slice(0, 2000), contentFingerprint: azureDevOpsCommentFingerprint(plain) });
  };
  try {
    await fixture.run({ execute: async ({ request, onSession }) => {
      assert.match(request, /missing or expired sign-in/);
      assert.match(request, /403\/missing role is authorization/);
      onSession(sessionId);
      return { outcome: "blocked", summary: "Source analysis completed; the approved read needs sign-in.",
        authenticationRequired: { provider: "azure-cli", reason: "The approved Azure session expired." } };
    } });
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].status, "authentication-pending");
    assert.match(fixture.posted[0].text, /--resume-ticket 42/);
    assert.ok(fixture.posted[0].text.startsWith("[Fixlab automation]\n"));
    assert.doesNotMatch(fixture.posted[0].text, /FixLab automation|Outcome:|[a-f0-9]{64}/u);
    await fixture.run({ execute: async ({ item }) => {
      assert.equal(item.id, 43);
      return { outcome: "analysis", summary: "Independent source analysis completed." };
    } });
    await fixture.run({ resumeWorkItemId: 42, execute: async options => {
      assert.equal(options.item.id, 42);
      assert.equal(options.sessionId, sessionId);
      assert.equal(options.resume, true);
      options.onSession(sessionId);
      return { outcome: "analysis", summary: "The approved read completed after human sign-in; reproduction remains pending." };
    } });
    await fixture.run({ execute() { assert.fail("Neither job should repeat."); } });
    const history = readTicketAutomationHistory(fixture.repository);
    assert.equal(history.attempts.length, 2);
    assert.equal(history.attempts.find(entry => entry.workItemId === 42).status, "complete");
    assert.equal(fixture.posted.length, 3);
  } finally { fixture.cleanup(); }
});

test("untagged pending feedback from older builds reconciles without changing its fingerprint or reposting", async () => {
  const fixture = ticketFixture({ readable: true });
  const commentIds = fixture.client.commentIds;
  let lookups = 0;
  try {
    fixture.client.commentIds = async (...args) => ++lookups < 3 ? commentIds(...args) : [];
    await assert.rejects(fixture.run({ execute: async () =>
      ({ outcome: "analysis", summary: "The earlier investigation remains provisional." })
    }), /read-back is unconfirmed/);
    const legacyText = fixture.posted[0].text.replace(/^\[Fixlab automation\]\n/u, "");
    const plain = sanitizeAzureDevOpsHtml(formatAzureDevOpsComment(legacyText));
    const fingerprint = azureDevOpsCommentFingerprint(plain);
    fixture.item.comments[0].text = plain;
    fixture.item.comments[0].contentFingerprint = fingerprint;
    const path = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.entries[0].feedback.fingerprint = fingerprint;
    writeFileSync(path, JSON.stringify(journal));
    fixture.client.commentIds = commentIds;
    await fixture.run({ execute() { assert.fail("An older pending result must not rerun the investigation."); } });
    assert.equal(fixture.posted.length, 1);
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].status, "complete");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).entries[0].feedback.fingerprint, fingerprint);
  } finally { fixture.cleanup(); }
});

test("authentication recovery retains pending feedback and refuses changed ticket or runtime scope", async () => {
  for (const change of ["none", "ticket", "runtime"]) {
    const fixture = ticketFixture({ readable: true });
    const load = fixture.client.load;
    let unavailable = false;
    fixture.client.load = async (...args) => {
      if (unavailable) { throw new Error("ADO sign-in unavailable."); }
      return load(...args);
    };
    try {
      await assert.rejects(fixture.run({ execute: async ({ onSession }) => {
        onSession(randomUUID());
        unavailable = true;
        return { outcome: "blocked", summary: "Independent analysis completed before sign-in expired.",
          authenticationRequired: { provider: "azure-cli", reason: "Azure session expired." } };
      } }), /ADO sign-in unavailable/);
      assert.equal(fixture.posted.length, 0);
      unavailable = false;
      if (change === "ticket") { fixture.item.description = "A changed scenario requires review."; }
      const plan = ticketAutomationPlan(fixture.repository, fixture.profile, {
        environment: "dev", runtime: change === "runtime" ? "copilot" : "agency"
      });
      const resume = fixture.run({ plan, resumeWorkItemId: 42, execute: async ({ resume }) => {
        assert.equal(change, "none", "Changed scope must never resume.");
        assert.equal(resume, true);
        return { outcome: "analysis", summary: "Approved read completed after human sign-in." };
      } });
      if (change === "none") {
        await resume;
        assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].status, "complete");
        assert.equal(fixture.posted.length, 2);
      } else {
        await assert.rejects(resume, change === "ticket" ? /changed before feedback/ : /paused ticket changed/);
        assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].status,
          change === "ticket" ? "feedback-pending" : "authentication-pending");
      }
    } finally { fixture.cleanup(); }
  }
});

test("ticket watcher posts verified draft links but reports an unverified PR as blocked", async () => {
  const fixture = ticketFixture();
  try {
    await fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "Scoped fix and focused tests passed. Browser evidence is unavailable.", pullRequestId: 17 }) });
    assert.match(fixture.posted[0].text, /Draft PR: https:\/\/dev\.azure\.com\/.*\/pullrequest\/17/);
    assert.match(readTicketAutomationHistory(fixture.repository).attempts[0].pullRequestUrl, /pullrequest\/17$/);
    fixture.item.description = "Check a second scenario.";
    fixture.client.verifyDraft = async () => { throw new Error("PR is not draft."); };
    await fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "A result needs verification.", pullRequestId: 18 }) });
    assert.match(fixture.posted[1].text, /Run blocked:/);
    assert.match(fixture.posted[1].text, /Publication is unconfirmed/);
    assert.doesNotMatch(fixture.posted[1].text, /Draft PR:/);
    assert.equal(readTicketAutomationHistory(fixture.repository).attempts[0].pullRequestUrl, null);
  } finally {
    fixture.cleanup();
  }
});

test("watcher history persists bounded safe activity and check results without starting another execution", async () => {
  const fixture = ticketFixture();
  try {
    await fixture.run({
      execute: async ({ onActivity }) => executeTicketAgent({
        repository: fixture.repository, prompt: "Fixture", onOutput() {}, onActivity,
        executor(options) {
          options.onOutput("stdout", "Raw console private-sentinel must not be persisted.\n");
          for (let index = 0; index < 25; index += 1) {
            options.onOutput("stdout", `FIXLAB_ACTIVITY|diagnosis|Recorded update ${index}.\n`);
          }
          options.onOutput("stdout", "FIXLAB_CHECK|focused regression|failed|One assertion failed.\n");
          options.onOutput("stdout", "FIXLAB_ACTIVITY|diagnosis|password=private-sentinel\n");
          options.onOutput("stdout", "FIXLAB_ACTIVITY|diagnosis|See https://private.example.test/path and user@example.test.\n");
          options.onOutput("stdout", 'FIXLAB_TICKET_RESULT|{"outcome":"blocked","summary":"A regression still fails; live testing did not run."}\n');
          return { completion: Promise.resolve({ code: 0 }), hasStopped: () => true, terminate() {} };
        }
      })
    });
    const history = readTicketAutomationHistory(fixture.repository);
    assert.equal(history.status, "stopped");
    const [attempt] = history.attempts;
    assert.equal(attempt.status, "complete");
    assert.equal(attempt.outcome, "blocked");
    assert.equal(attempt.activity.length, 20);
    assert.ok(attempt.omittedActivity > 0);
    assert.equal(attempt.checks[0].status, "failed");
    assert.ok(attempt.startedAt && attempt.finishedAt);
    assert.doesNotMatch(JSON.stringify(history), /private-sentinel|private\.example|user@example/);
    const journal = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    assert.doesNotMatch(readFileSync(journal, "utf8"), /private-sentinel|private\.example|user@example/);
    const original = JSON.parse(readFileSync(journal, "utf8"));
    delete original.entries[0].details;
    delete original.watcher;
    writeFileSync(journal, JSON.stringify(original));
    const legacy = readTicketAutomationHistory(fixture.repository);
    assert.equal(legacy.status, "unknown");
    assert.equal(legacy.attempts[0].historyAvailable, false);
    assert.deepEqual(legacy.attempts[0].checks, []);
    fixture.profile.ticketAutomation.tag = "AnotherTag";
    writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
    assert.throws(() => readTicketAutomationHistory(fixture.repository), /does not match/);
    fixture.profile.ticketAutomation.tag = "FixLab";
    writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify(fixture.profile));
    const root = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation");
    const moved = join(fixture.repository, "moved-history");
    renameSync(root, moved);
    symlinkSync(moved, root, "junction");
    assert.throws(() => readTicketAutomationHistory(fixture.repository), /linked directories/);
  } finally { fixture.cleanup(); }
});

test("automatic resolution requires an opted-in verified draft or a complete confirmed cause", async () => {
  const cause = { cause: "The mapping configuration is missing.", evidence: "The reviewed source requires that mapping.", nextSteps: "The configuration owner must add it and validate the flow." };
  for (const [result, optedIn, expected] of [
    [{ outcome: "draft-pr", summary: "Focused checks passed; live testing is pending.", pullRequestId: 17 }, true, true],
    [{ outcome: "analysis", summary: "The configuration cause is confirmed.", confirmedCause: cause }, true, true],
    [{ outcome: "analysis", summary: "More information is needed." }, true, false],
    [{ outcome: "blocked", summary: "Access is unavailable." }, true, false],
    [{ outcome: "draft-pr", summary: "A draft is available.", pullRequestId: 17 }, false, false]
  ]) {
    const fixture = ticketFixture();
    fixture.plan.resolveOnCompletion = optedIn;
    let executions = 0;
    try {
      const execute = async () => { executions += 1; return result; };
      await fixture.run({ execute });
      await fixture.run({ execute });
      assert.equal(fixture.item.state === "Resolved", expected);
      assert.equal(executions, 1, "own feedback/state must not repeat the investigation");
      const attempt = readTicketAutomationHistory(fixture.repository).attempts[0];
      assert.equal(attempt.resolution?.status === "resolved", expected);
      if (result.confirmedCause) { assert.deepEqual(attempt.confirmedCause, cause); }
      if (expected) { assert.match(fixture.posted[0].text, /not that a fix is merged, deployed or fully live-tested/); }
    } finally { fixture.cleanup(); }
  }
  assert.throws(() => ticketOutcome({ outcome: "analysis", summary: "Unproven.", confirmedCause: { cause: "An assumption." } }), /valid bounded/);
  assert.throws(() => ticketOutcome({ outcome: "blocked", summary: "Blocked.", confirmedCause: cause }), /valid bounded/);
});

test("completed stories resolve only with evidenced findings and the existing opt-in", async () => {
  const completedStory = {
    finding: "The supported search behavior matches the documented requirement.",
    evidence: "The reviewed implementation and successful focused check agree.",
    reason: "The acceptance criterion is answered; no implementation work remains."
  };
  for (const [type, optedIn, expected] of [
    ["User Story", true, true],
    ["Product Backlog Item", true, true],
    ["Feature", true, true],
    ["User Story", false, false],
    ["Bug", true, false]
  ]) {
    const fixture = ticketFixture({ readable: true });
    fixture.item.workItemType = type;
    fixture.plan.resolveOnCompletion = optedIn;
    try {
      await fixture.run({ execute: async ({ request }) => {
        assert.match(request, /completedStory:\{finding,evidence,reason\}/);
        return { outcome: "analysis", summary: "The requested behavior is verified.", completedStory };
      } });
      assert.equal(fixture.item.state === "Resolved", expected);
      assert.ok(fixture.posted[0].text.startsWith("[Fixlab automation]\n"));
      assert.match(fixture.posted[0].text, /Finding: The supported search behavior/);
      assert.match(fixture.posted[0].text, /Evidence: The reviewed implementation/);
      assert.deepEqual(readTicketAutomationHistory(fixture.repository).attempts[0].completedStory, completedStory);
      await fixture.run({ execute() { assert.fail("Tagged feedback must not retrigger completed work."); } });
      assert.equal(fixture.posted.length, 1);
    } finally { fixture.cleanup(); }
  }
  for (const result of [
    { outcome: "analysis", completedStory: { finding: "Unproven." } },
    { outcome: "blocked", completedStory },
    { outcome: "analysis", completedStory, report: { plannedWork: ["Implement the requested change."] } },
    { outcome: "analysis", completedStory, report: { inProgress: ["Required verification is running."] } }
  ]) {
    assert.throws(() => ticketOutcome({ summary: "Not complete.", ...result }), /valid bounded/);
  }
});

test("pending resolution is read back after restart even when new state changes are disabled", async () => {
  const fixture = ticketFixture();
  fixture.plan.resolveOnCompletion = true;
  const load = fixture.client.load;
  let unavailable = false;
  let patches = 0;
  fixture.client.load = async (...args) => {
    if (unavailable) { unavailable = false; throw new Error("Read-back is temporarily unavailable."); }
    return load(...args);
  };
  fixture.client.resolve = async () => {
    patches += 1;
    fixture.item.state = "Resolved";
    fixture.item.revision += 1;
    unavailable = true;
    throw new Error("State submission acknowledgement was lost.");
  };
  try {
    await assert.rejects(fixture.run({
      execute: async () => ({ outcome: "draft-pr", summary: "Draft ready for review.", pullRequestId: 17 })
    }), /Read-back is temporarily/);
    fixture.plan.resolveOnCompletion = false;
    await fixture.run({ execute() { assert.fail("An uncertain acknowledgement must not rerun the agent."); } });
    const [attempt] = readTicketAutomationHistory(fixture.repository).attempts;
    assert.equal(attempt.status, "complete");
    assert.equal(attempt.resolution.status, "resolved");
    assert.equal(patches, 1);
    assert.equal(fixture.posted.length, 1);
  } finally { fixture.cleanup(); }
});

test("uncertain resolution recovery never patches a human's newer reopened revision", async () => {
  const fixture = ticketFixture();
  fixture.plan.resolveOnCompletion = true;
  const load = fixture.client.load;
  let unavailable = false;
  let patches = 0;
  let submittedRevision;
  fixture.client.load = async (...args) => {
    if (unavailable) { unavailable = false; throw new Error("Read-back unavailable."); }
    return load(...args);
  };
  fixture.client.resolve = async (_id, revision) => {
    patches += 1;
    submittedRevision = revision;
    const path = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const [entry] = JSON.parse(readFileSync(path, "utf8")).entries;
    assert.equal(entry.resolution.submittedRevision, revision);
    assert.equal(entry.resolution.attemptedState, "Resolved");
    assert.equal(entry.resolution.status, "pending");
    fixture.item.state = "Resolved";
    fixture.item.revision += 1;
    unavailable = true;
    throw new Error("PATCH acknowledgement lost.");
  };
  try {
    await assert.rejects(fixture.run({
      execute: async () => ({ outcome: "draft-pr", summary: "Focused checks passed; draft needs review.", pullRequestId: 17 })
    }), /Read-back unavailable/);
    fixture.item.state = "Active";
    fixture.item.revision += 1;
    await fixture.run({ execute() { assert.fail("Do not rerun an uncertain investigation."); } });
    assert.equal(patches, 1);
    assert.equal(fixture.item.state, "Active");
    const path = join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "state.json");
    const [entry] = JSON.parse(readFileSync(path, "utf8")).entries;
    assert.equal(entry.status, "complete");
    assert.equal(entry.resolution.status, "blocked");
    assert.equal(entry.resolution.submittedRevision, submittedRevision);
    assert.match(fixture.posted[1].text, /No PATCH was repeated/);
  } finally { fixture.cleanup(); }
});

test("reopening an automatically resolved story starts one new attempt without losing deduplication", async () => {
  const fixture = ticketFixture();
  fixture.plan.resolveOnCompletion = true;
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { outcome: "draft-pr", summary: "Draft ready for review; live testing remains pending.", pullRequestId: 17 };
  };
  try {
    await fixture.run({ execute });
    await fixture.run({ execute });
    assert.equal(executions, 1);
    fixture.item.state = "Active";
    fixture.item.revision += 1;
    await fixture.run({ execute });
    await fixture.run({ execute });
    assert.equal(executions, 2);
    assert.equal(fixture.posted.length, 2);
    const history = readTicketAutomationHistory(fixture.repository);
    assert.equal(history.attempts.length, 2);
    assert.notEqual(history.attempts[0].id, history.attempts[1].id);
    assert.equal(fixture.item.state, "Resolved");
  } finally { fixture.cleanup(); }
});

test("resolution handles unsupported workflows and lost acknowledgements without a blind second patch", async () => {
  for (const changed of [false, true]) {
    const fixture = ticketFixture();
    fixture.plan.resolveOnCompletion = true;
    let patches = 0;
    fixture.client.resolve = async () => {
      patches += 1;
      if (changed) { fixture.item.state = "Resolved"; fixture.item.revision += 1; }
      throw new Error(changed ? "Connection ended after submission." : "This workflow does not support Resolved.");
    };
    try {
      await fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "Draft ready; live testing pending.", pullRequestId: 17 }) });
      assert.equal(patches, 1);
      const attempt = readTicketAutomationHistory(fixture.repository).attempts[0];
      assert.equal(attempt.resolution.status, changed ? "resolved" : "blocked");
      assert.equal(fixture.posted.length, changed ? 1 : 2);
      if (!changed) { assert.match(fixture.posted[1].text, /automatic resolution could not finish/); }
    } finally { fixture.cleanup(); }
  }
});

test("unverified drafts and changed or out-of-scope work items cannot be automatically resolved", async () => {
  for (const mode of ["unverified", "edited", "out-of-scope"]) {
    const fixture = ticketFixture();
    fixture.plan.resolveOnCompletion = true;
    let resolutions = 0;
    fixture.client.resolve = async () => { resolutions += 1; };
    if (mode === "unverified") { fixture.client.verifyDraft = async () => { throw new Error("Not draft."); }; }
    const comment = fixture.client.comment;
    fixture.client.comment = async (...args) => {
      await comment(...args);
      if (mode === "edited") { fixture.item.description = "A different scenario now needs review."; }
      if (mode === "out-of-scope") { fixture.item.tags = ""; }
    };
    try {
      const execution = fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "Draft proposed.", pullRequestId: 17 }) });
      if (mode === "out-of-scope") { await assert.rejects(execution, /left the reviewed scope/); }
      else { await execution; }
      assert.equal(resolutions, 0);
      assert.notEqual(fixture.item.state, "Resolved");
    } finally { fixture.cleanup(); }
  }
});

test("ticket feedback survives a lost acknowledgement without rerunning the job or double posting", async () => {
  const fixture = ticketFixture();
  let executions = 0;
  const execute = async () => { executions += 1; return { outcome: "analysis", summary: "No code change is needed; update the configuration through its owner." }; };
  const comment = fixture.client.comment;
  try {
    fixture.client.comment = async (...args) => {
      await comment(...args);
      throw new Error("Connection ended after submission.");
    };
    await assert.rejects(fixture.run({ execute }), /after submission/);
    fixture.client.comment = comment;
    await fixture.run({ execute });
    await fixture.run({ execute });
    assert.equal(executions, 1);
    assert.equal(fixture.posted.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("ticket watcher skips ineligible items and stops when the reviewed configuration changes", async () => {
  const fixture = ticketFixture();
  try {
    fixture.item.tags = "FixLabExtra";
    await fixture.run({ execute() { assert.fail("not explicitly tagged"); } });
    fixture.item.tags = "FixLab";
    fixture.item.areaPath = "Example Project\\Another application";
    await fixture.run({ execute() { assert.fail("not in a reviewed application area"); } });
    fixture.item.areaPath = fixture.plan.areaPaths[0];
    await assert.rejects(fixture.run({
      execute: async () => {
        writeFileSync(join(fixture.repository, ".github", "fixlab", "repository-profile.json"), JSON.stringify({
          ...fixture.profile, pullRequests: { defaultTargetBranch: "main" }
        }));
        return { outcome: "analysis", summary: "The scope changed." };
      }
    }), /configuration or Git origin changed/);
    assert.equal(fixture.posted.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("an interrupted investigation blocks every launch even after edits, reordering or loss of its tag", async () => {
  const fixture = ticketFixture();
  let executions = 0;
  const execute = async () => { executions += 1; throw new Error("Runtime disconnected."); };
  try {
    await assert.rejects(fixture.run({ execute }), /Runtime disconnected/);
    fixture.item.description = "A human edited the ticket after the interruption.";
    await assert.rejects(fixture.run({ execute }), /interrupted execution/);
    fixture.item.tags = "Other";
    fixture.client.load = async id => ({ ...structuredClone(fixture.item), id,
      tags: id === 43 ? "FixLab" : fixture.item.tags });
    for (const ids of [[43, 42], [43], []]) {
      fixture.client.findTagged = async () => ids;
      await assert.rejects(fixture.run({ execute }), /interrupted execution/);
    }
    assert.equal(executions, 1);
    assert.equal(fixture.posted.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("ticket executor requires a successful exit and one bounded structured outcome", async () => {
  const fixture = ticketFixture();
  try {
  for (const [output, code, expected] of [
    ['FIXLAB_TICKET_RESULT|{"outcome":"analysis","summary":"Already fixed; focused checks passed."}\n', 0, "analysis"],
    ["No structured result.\n", 0, "blocked"],
    ['FIXLAB_TICKET_RESULT|{"outcome":"analysis","summary":"Unverified claim."}\n', 1, "blocked"],
    ['FIXLAB_TICKET_RESULT|{"outcome":"analysis","summary":"Bearer secret-token"}\n', 0, "blocked"]
  ]) {
    const result = await executeTicketAgent({
      repository: fixture.repository, prompt: "An authorized bounded ticket.",
      onOutput() {},
      executor(options) {
        options.onOutput("stdout", output.slice(0, 20));
        options.onOutput("stdout", output.slice(20));
        return { completion: Promise.resolve({ code }), hasStopped: () => true, terminate() {} };
      }
    });
    assert.equal(result.outcome, expected);
  }
  assert.throws(() => ticketOutcome({ outcome: "draft-pr", summary: "Missing ID." }), /valid bounded/);
  await assert.rejects(executeTicketAgent({
    idleTimeoutMs: Number.NaN, executor() { assert.fail("invalid timer"); }
  }), /idleTimeoutMs/);
  await assert.rejects(executeTicketAgent({
    repository: fixture.repository,
    executor() {
      return { completion: Promise.resolve({ code: 0 }), hasStopped: () => false, terminate() {} };
    }
  }), error => error.ownedExecutorRunning === true);
  } finally { fixture.cleanup(); }
});

test("ticket output is redacted before forwarding, including split credentials and final stderr fragments", async () => {
  const fixture = ticketFixture();
  try {
    for (const invalidResult of [false, true]) {
      const displayed = [];
      const result = await executeTicketAgent({
        repository: fixture.repository, prompt: "Fixture",
        onOutput(stream, text) {
          displayed.push({ stream, text });
          assert.doesNotMatch(JSON.stringify(displayed), /stdout-private|stdout-basic-private|stderr-private|private-key-body|result-private/);
        },
        executor(options) {
          options.onOutput("stdout", "Safe progress.\nAuthor");
          options.onOutput("stderr", "pass");
          options.onOutput("stdout", "ization: Bearer stdout-private\n");
          options.onOutput("stdout", "Ba");
          options.onOutput("stdout", "sic stdout-basic-private\n");
          options.onOutput("stderr", "word=stderr-private");
          options.onOutput("stdout", "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\n");
          options.onOutput("stdout", `FIXLAB_TICKET_RESULT|${JSON.stringify({
            outcome: "analysis", summary: invalidResult ? "Basic result-private" : "Focused checks passed."
          })}\n`);
          return { completion: Promise.resolve({ code: 0 }), hasStopped: () => true, terminate() {} };
        }
      });
      assert.equal(result.outcome, invalidResult ? "blocked" : "analysis");
      assert.match(displayed.map(value => value.text).join(""), /Safe progress|Sensitive detail omitted/);
      assert.ok(displayed.some(value => value.stream === "stderr" && value.text.includes("omitted")));
    }
  } finally { fixture.cleanup(); }
});

test("ticket executors share dashboard leases across worktrees and release only after verified termination", async () => {
  const fixture = ticketFixture();
  try {
    const worktree = join(fixture.repository, "linked-checkout");
    for (const args of [
      ["-c", "user.name=FixLab test", "-c", "user.email=fixlab@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Fixture"],
      ["worktree", "add", "--quiet", "-b", "fixture-linked", worktree]
    ]) {
      const result = spawnSync("git", args, { cwd: fixture.repository, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const dashboard = createExecutorLease(fixture.repository, "dashboard-test");
    const held = dashboard.acquire("dashboard-job");
    await assert.rejects(executeTicketAgent({
      repository: worktree, executor() { assert.fail("Dashboard owns the repository."); }
    }), /lease is reserved/);
    held.release();
    const metadata = join(dashboard.scope.directory, "owner.json");
    await executeTicketAgent({
      repository: worktree, onOutput() {},
      executor(options) {
        const owner = JSON.parse(readFileSync(metadata, "utf8"));
        assert.equal(owner.jobId, options.sessionId);
        assert.equal(owner.ownerPid, process.pid);
        assert.throws(() => dashboard.acquire("concurrent-job"), /lease is reserved/);
        options.onOutput("stdout", 'FIXLAB_TICKET_RESULT|{"outcome":"analysis","summary":"No change needed."}\n');
        return {
          pid: 12345, hasStopped: () => true, terminate() {},
          completion: Promise.resolve().then(() => {
            assert.equal(JSON.parse(readFileSync(metadata, "utf8")).executorPid, 12345);
            assert.equal(JSON.parse(readFileSync(metadata, "utf8")).state, "running");
            return { code: 0 };
          })
        };
      }
    });
    const next = dashboard.acquire("after-termination");
    next.release();
    await assert.rejects(fixture.run({
      execute: () => executeTicketAgent({
        repository: worktree, onOutput() {},
        executor() {
          return { pid: 12345, completion: Promise.resolve({ code: 0 }), hasStopped: () => false, terminate() {} };
        }
      })
    }), error => error.ownedExecutorRunning === true);
    assert.equal(JSON.parse(readFileSync(metadata, "utf8")).state, "termination-unverified");
    assert.throws(() => dashboard.acquire("unsafe-restart"), /lease is reserved/);
    assert.ok(existsSync(join(fixture.repository, ".git", "fixlab", "dashboard-artifacts", "ticket-automation", "watcher.lock")));
  } finally { fixture.cleanup(); }
});

test("executor launch failures release a lease only when launch is explicitly known not to have started", async () => {
  for (const notStarted of [false, true]) {
    const fixture = ticketFixture();
    try {
      await assert.rejects(executeTicketAgent({
        repository: fixture.repository,
        executor() { throw Object.assign(new Error("Launch failed."), { executorNotStarted: notStarted }); }
      }), error => error.message === "Launch failed." && Boolean(error.ownedExecutorRunning) === !notStarted);
      const owner = createExecutorLease(fixture.repository, "next-owner");
      if (notStarted) {
        const next = owner.acquire("safe-retry");
        next.release();
      } else {
        assert.throws(() => owner.acquire("unknown-launch"), /lease is reserved/);
      }
    } finally { fixture.cleanup(); }
  }
});

test("ADO automation client confines reads and feedback to the configured project and verifies draft state", async () => {
  const calls = [];
  let draft = true;
  let linkedTicketId = "42";
  let linkedRepository = "repo-id";
  let assignedItems = [{ id: 42 }];
  const client = createAzureDevOpsTicketClient({
    profile: { azureDevOps: { organization: "example-org", project: "Example Project" } },
    tokenProvider: () => "private-test-token",
    async requestJson(url, token, options = {}) {
      assert.equal(token, "private-test-token");
      assert.match(url, /^https:\/\/dev\.azure\.com\/example-org\/Example%20Project\/_apis\//);
      calls.push({ url, options });
      if (url.includes("/wit/workitems?ids=")) {
        return { value: [{ id: 42, fields: {
          "System.Title": "Synthetic title", "System.TeamProject": "Example Project"
        } }] };
      }
      if (url.includes("$expand=relations")) {
        return { id: 42, fields: { "System.TeamProject": "Example Project" }, relations: [{
          rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/project-id%2Frepo-id%2F17"
        }] };
      }
      if (url.includes("/wiql?")) {
        assert.match(options.body.query, /\[System\.AssignedTo\] = @Me/);
        if (options.body.query.includes("[System.Id] = 42")) {
          return { workItems: assignedItems };
        }
        assert.match(options.body.query, /Tags.*CONTAINS 'FixLab'/);
        return { workItems: [{ id: 42 }] };
      }
      if (url.includes("/workitems?")) {
        return { value: [{ id: linkedTicketId }] };
      }
      if (url.includes("/pullrequests/")) {
        return { pullRequestId: 17, isDraft: draft, status: "active",
          targetRefName: "refs/heads/develop", repository: { id: linkedRepository, name: "example-repo" } };
      }
      if (url.includes("/comments?")) {
        return { comments: [] };
      }
      return { id: 42, fields: {
        "System.TeamProject": "Example Project", "System.Tags": "FixLab", "System.WorkItemType": "Feature"
      } };
    }
  });
  assert.deepEqual(await client.findTagged("FixLab", ["Example Project\\Application"]), [42]);
  assert.equal((await client.load(42)).workItemType, "Feature");
  assert.equal((await client.load(42)).assignedToCurrentUser, true);
  assignedItems = [];
  assert.equal((await client.load(42)).assignedToCurrentUser, false);
  assignedItems = [{ id: 43 }];
  await assert.rejects(client.load(42), /exact work item's current-user assignment/);
  assignedItems = [{ id: 42 }];
  assert.deepEqual(await client.loadTitles([42]), { 42: "Synthetic title" });
  await assert.rejects(client.loadTitles([43]), /exact recorded/);
  assert.equal(await client.hasComment(42, "[FixLab automation 42:abc]"), false);
  await client.comment(42, "Analysis <script>must be text</script>");
  const posted = calls.find(call => call.options.method === "POST" && call.url.includes("/comments?"));
  assert.equal(posted.options.body.text, "Analysis &lt;script&gt;must be text&lt;/script&gt;");
  await client.comment(42, "[FixLab automation 42:abc]\nOutcome: analysis\n\n## Root cause\n- A <script> must remain text & escaped.\n- Evidence: the scoped source.\n\n## Planned work\n- No changes are in progress.");
  const formatted = calls.filter(call => call.options.method === "POST" && call.url.includes("/comments?")).at(-1);
  assert.equal(new URL(formatted.url).searchParams.get("format"), "html");
  assert.equal(formatted.options.body.text, "[FixLab automation 42:abc]<br>Outcome: analysis<br><br><h3>Root cause</h3><ul><li>A &lt;script&gt; must remain text &amp; escaped.</li><li>Evidence: the scoped source.</li></ul><br><br><h3>Planned work</h3><ul><li>No changes are in progress.</li></ul>");
  assert.match(await client.verifyDraft("example-repo", 17, "develop", 42), /pullrequest\/17$/);
  const reviewed = await client.reviewPullRequests("example-repo", 42);
  assert.equal(reviewed[0].id, 17);
  assert.equal(reviewed[0].isDraft, true);
  assert.equal(reviewed[0].status, "active");
  assert.match(reviewed[0].webUrl, /example-repo\/pullrequest\/17$/);
  linkedRepository = "other-repository";
  await assert.rejects(client.reviewPullRequests("example-repo", 42), /could not be verified/);
  linkedRepository = "repo-id";
  draft = false;
  await assert.rejects(client.verifyDraft("example-repo", 17, "develop", 42), /did not verify/);
  draft = true;
  linkedTicketId = "43";
  await assert.rejects(client.verifyDraft("example-repo", 17, "develop", 42), /not linked/);
  await assert.rejects(client.comment(-1, "Not authorized."), /positive safe integer/);
});

test("ADO resolution checks workflow support, uses a revision test and verifies the returned state", async () => {
  const calls = [];
  let supported = true;
  let project = "Example Project";
  const client = createAzureDevOpsTicketClient({
    profile: { azureDevOps: { organization: "example-org", project } },
    tokenProvider: () => "private-test-token",
    async requestJson(url, _token, options = {}) {
      assert.match(url, /^https:\/\/dev\.azure\.com\/example-org\/Example%20Project\/_apis\//);
      calls.push({ url, options });
      if (url.includes("/states?")) { return { value: supported ? [{ name: "Resolved" }] : [{ name: "Done" }] }; }
      assert.equal(options.method, "PATCH");
      assert.equal(options.contentType, "application/json-patch+json");
      assert.deepEqual(options.body, [
        { op: "test", path: "/rev", value: 7 },
        { op: "add", path: "/fields/System.State", value: "Resolved" }
      ]);
      return { id: 42, rev: 8, fields: { "System.State": "Resolved", "System.TeamProject": project } };
    }
  });
  await assert.rejects(client.resolve(42, null, "Bug"), /fresh work-item revision/);
  assert.equal(calls.length, 0);
  await client.resolve(42, 7, "User Story");
  assert.match(calls[0].url, /User%20Story\/states/);
  supported = false;
  const before = calls.length;
  await assert.rejects(client.resolve(42, 7, "User Story"), /does not support/);
  assert.equal(calls.length, before + 1, "unsupported workflows must not receive a patch");
  supported = true;
  project = "Another Project";
  await assert.rejects(client.resolve(42, 7, "Bug"), /did not verify/);
});

function screenshot(overrides = {}) {
  return {
    name: "evidence.png",
    mimeType: "image/png",
    base64: png.toString("base64"),
    ...overrides
  };
}

test("parses Azure DevOps URL and ID profile fallback", () => {
  assert.deepEqual(
    parseAzureDevOpsWorkItem(
      "https://dev.azure.com/example-org/Example%20Project/_workitems/edit/123"
    ),
    {
      organization: "example-org",
      project: "Example Project",
      id: 123
    }
  );
  assert.deepEqual(
    parseAzureDevOpsWorkItem("456", {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }),
    {
      organization: "profile-org",
      project: "Profile Project",
      id: 456
    }
  );
  assert.throws(
    () => parseAzureDevOpsWorkItem("456", {}),
    /azureDevOps\.organization/
  );
  assert.throws(
    () => parseAzureDevOpsWorkItem("https://example.com/item/1"),
    /dev\.azure\.com/
  );
});

test("sanitizes Azure DevOps HTML into readable text", () => {
  const result = sanitizeAzureDevOpsHtml(
    "<p>First &amp; second</p><ul><li>Step &#49;</li></ul><script>bad()</script>"
  );

  assert.equal(result, "First & second\n- Step 1");
});

test("Azure DevOps loader returns safe fields without exposing tokens", async () => {
  const token = "sensitive-access-token";
  let authorizationToken;
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => token,
    requestJson: async (url, suppliedToken) => {
      authorizationToken = suppliedToken;
      assert.match(url, /profile-org\/Profile%20Project/);
      if (url.includes("/comments?")) {
        return {
          comments: [
            {
              createdBy: { displayName: "<b>Reviewer</b>" },
              createdDate: "2026-03-09T10:00:00Z",
              text: "<p>Newest &amp; useful</p>"
            },
            {
              isDeleted: true,
              createdBy: { displayName: "Deleted" },
              text: "Do not include"
            }
          ]
        };
      }
      return {
        id: 42,
        fields: {
          "System.Id": 42,
          "System.Title": "<b>Broken save</b>",
          "System.Description": "<p>Save &amp; continue fails.</p>",
          "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>Open</li></ol>",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Save succeeds.</p>",
          "System.State": "Active",
          "System.WorkItemType": "Bug"
        },
        _links: {
          html: {
            href: "https://dev.azure.com/profile-org/Profile%20Project/_workitems/edit/42"
          }
        }
      };
    }
  });

  const item = await loader({
    workItem: "42",
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(authorizationToken, token);
  assert.equal(item.title, "Broken save");
  assert.equal(item.description, "Save & continue fails.");
  assert.equal(item.reproduction, "- Open");
  assert.equal(item.acceptanceCriteria, "Save succeeds.");
  assert.deepEqual(item.comments, [
    {
      author: "Reviewer",
      createdAt: "2026-03-09T10:00:00Z",
      text: "Newest & useful",
      contentFingerprint: azureDevOpsCommentFingerprint("Newest & useful")
    }
  ]);
  assert.equal(item.commentsWarning, "");

  const failingLoader = createAzureDevOpsLoader({
    tokenProvider: () => token,
    requestJson: async () => {
      throw new Error(`request failed with Bearer ${token}`);
    }
  });
  await assert.rejects(
    failingLoader({
      workItem: "42",
      profile: {
        azureDevOps: {
          organization: "profile-org",
          project: "Profile Project"
        }
      }
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("Azure DevOps batch loader authenticates once and preserves mixed work-item types and acceptance criteria", async () => {
  let tokenCalls = 0;
  const requestedUrls = [];
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => {
      tokenCalls += 1;
      return "batch-token";
    },
    requestJson: async (url) => {
      const id = Number(url.match(/workitems\/(\d+)/i)?.[1]);
      requestedUrls.push(url);
      if (url.includes("/comments?")) {
        return { comments: [] };
      }
      return {
        id,
        fields: {
          "System.Id": id,
          "System.Title": `Work item ${id}`,
          "Microsoft.VSTS.Common.AcceptanceCriteria": `<p>Acceptance for ${id}</p>`,
          "System.State": "Active",
          "System.WorkItemType": { 101: "Bug", 202: "User Story", 303: "Task", 404: "Feature" }[id]
        }
      };
    }
  });

  const workItems = await loader.loadMany({
    workItems: ["101", "202", "303", "404"],
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(tokenCalls, 1);
  assert.equal(requestedUrls.length, 8);
  assert.deepEqual(
    requestedUrls
      .map((url) => Number(url.match(/workitems\/(\d+)/i)?.[1]))
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort((left, right) => left - right),
    [
    101,
    202,
    303,
    404
    ]
  );
  assert.deepEqual(
    workItems.map((item) => item.title),
    ["Work item 101", "Work item 202", "Work item 303", "Work item 404"]
  );
  assert.deepEqual(workItems.map((item) => item.workItemType), ["Bug", "User Story", "Task", "Feature"]);
  assert.deepEqual(workItems.map((item) => item.acceptanceCriteria),
    ["Acceptance for 101", "Acceptance for 202", "Acceptance for 303", "Acceptance for 404"]);
});

test("Azure DevOps loader bounds comments and reports comment-only failures", async () => {
  const comments = Array.from({ length: 25 }, (_, index) => ({
    createdBy: { displayName: `Author ${index}` },
    createdDate: `2026-03-09T10:${String(index).padStart(2, "0")}:00Z`,
    text: `<p>${"x".repeat(2100)} ${index}</p>`
  }));
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => "comment-token",
    requestJson: async (url, token) => {
      assert.equal(token, "comment-token");
      if (url.includes("/comments?")) {
        return { comments };
      }
      return {
        id: 91,
        fields: {
          "System.Id": 91,
          "System.Title": "Commented bug"
        }
      };
    }
  });
  const profile = {
    azureDevOps: {
      organization: "profile-org",
      project: "Profile Project"
    }
  };
  const item = await loader({ workItem: "91", profile });
  assert.equal(item.comments.length, 20);
  assert.equal(item.comments[0].text.length, 2000);

  const warningLoader = createAzureDevOpsLoader({
    tokenProvider: () => "secret-comment-token",
    requestJson: async (url) => {
      if (url.includes("/comments?")) {
        throw new Error("failed with secret-comment-token");
      }
      return {
        id: 92,
        fields: {
          "System.Id": 92,
          "System.Title": "Accessible bug"
        }
      };
    }
  });
  const warningItem = await warningLoader({
    workItem: "92",
    profile
  });
  assert.deepEqual(warningItem.comments, []);
  assert.match(warningItem.commentsWarning, /could not be loaded/);
  assert.doesNotMatch(
    warningItem.commentsWarning,
    /secret-comment-token/
  );
});

test("Azure DevOps loader includes bounded attached and embedded images", async () => {
  const requestedImages = [];
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => "image-token",
    requestJson: async (url) => {
      if (url.includes("/comments?")) {
        return {
          comments: [
            {
              text:
                '<p>Inline</p><img src="https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/inline?fileName=inline.png&amp;download=true">'
            }
          ]
        };
      }
      return {
        id: 93,
        fields: {
          "System.Id": 93,
          "System.Title": "Bug with images"
        },
        relations: [
          {
            rel: "AttachedFile",
            url:
              "https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/attached",
            attributes: { name: "evidence.png" }
          },
          {
            rel: "AttachedFile",
            url:
              "https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/ignored",
            attributes: { name: "notes.txt" }
          }
        ]
      };
    },
    requestBuffer: async (url, token) => {
      assert.equal(token, "image-token");
      requestedImages.push(url);
      return { buffer: png, contentType: "image/png" };
    }
  });

  const item = await loader({
    workItem: "93",
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(requestedImages.length, 2);
  assert.deepEqual(
    item.screenshots.map(({ name, mimeType, base64 }) => ({
      name,
      mimeType,
      bytes: Buffer.from(base64, "base64").length
    })),
    [
      { name: "93-evidence.png", mimeType: "image/png", bytes: 8 },
      { name: "93-inline.png", mimeType: "image/png", bytes: 8 }
    ]
  );
  assert.equal(item.imagesWarning, "");
});

test("stores generated screenshot files and rejects unsafe uploads", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-artifacts-"));
  let stored;

  try {
    stored = storeScreenshots({
      repository,
      jobId: "1234567890123-abcdef",
      screenshots: [screenshot()]
    });
    assert.equal(stored.files.length, 1);
    assert.equal(stored.files[0].name, "evidence.png");
    assert.equal(existsSync(stored.files[0].path), true);
    assert.doesNotMatch(stored.files[0].path, /evidence\.png$/);

    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890124-abcdef",
          screenshots: [screenshot({ name: "..\\secret.png" })]
        }),
      /paths or traversal/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890125-abcdef",
          screenshots: [screenshot({ mimeType: "text/plain" })]
        }),
      /PNG, JPEG, or WebP/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890126-abcdef",
          screenshots: [screenshot({ base64: "not base64!" })]
        }),
      /valid base64/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890127-abcdef",
          screenshots: [screenshot({ base64: Buffer.from("fake").toString("base64") })]
        }),
      /does not match/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890128-abcdef",
          screenshots: Array.from(
            { length: MAX_SCREENSHOTS + 1 },
            () => screenshot()
          )
        }),
      /at most/
    );
    const oversized = Buffer.concat([
      png,
      Buffer.alloc(MAX_SCREENSHOT_BYTES - png.length + 1)
    ]);
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890129-abcdef",
          screenshots: [
            screenshot({ base64: oversized.toString("base64") })
          ]
        }),
      /at most/
    );
    const totalChunk = Buffer.concat([
      png,
      Buffer.alloc(Math.floor(MAX_SCREENSHOT_TOTAL_BYTES / 5) - png.length + 1)
    ]);
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890130-abcdef",
          screenshots: Array.from({ length: 5 }, (_, index) =>
            screenshot({
              name: `evidence-${index}.png`,
              base64: totalChunk.toString("base64")
            })
          )
        }),
      /total at most/
    );
  } finally {
    removeArtifactDirectory(stored?.directory);
    rmSync(repository, { recursive: true, force: true });
  }
});
