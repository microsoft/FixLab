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
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  createAzureDevOpsLoader,
  createAzureDevOpsTicketClient,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  parseAzureDevOpsWorkItem,
  removeArtifactDirectory,
  sanitizeAzureDevOpsHtml,
  storeScreenshots
} from "../dashboard/intake.js";
import { executeTicketAgent, readTicketAutomationHistory, ticketAutomationPlan, ticketOutcome, watchTickets } from "../dashboard/ticket-automation.js";
import { createExecutorLease } from "../dashboard/executor-lease.js";
import { PR_TEAM_REVIEW_GUIDANCE } from "../dashboard/workflow-policy.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function ticketFixture() {
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
    id: 42, revision: 1, project: plan.project, areaPath: plan.areaPaths[0], tags: "Other; FixLab", workItemType: "Bug", state: "Active",
    title: "Name validation", description: "Accept plus and reject exclamation.",
    comments: [{ id: 1, text: "Check the create-name flow." }]
  };
  const posted = [];
  const client = {
    findTagged: async () => [item.id],
    load: async () => structuredClone(item),
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
  return {
    repository, profile, plan, item, client, posted,
    run: options => watchTickets({
      repository, plan, client, once: true, confirmed: true, allowAllTools: true,
      onEvent() {}, ...options
    }),
    cleanup: () => rmSync(repository, { recursive: true, force: true })
  };
}

test("ticket automation binds the Git origin, tag, branch, environment and explicit session approval", async () => {
  const fixture = ticketFixture();
  try {
    const { repository, profile, plan } = fixture;
    assert.equal(plan.tag, "FixLab");
    assert.equal(plan.project, "Example Project");
    assert.equal(plan.outcome, "draft-pr-or-discussion");
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
      ["reproduction", `https://user:${synthetic}@example.invalid/`],
      ["acceptanceCriteria", `-----BEGIN PRIVATE KEY-----\n${synthetic}\n-----END PRIVATE KEY-----`],
      ["webUrl", `https://example.invalid/?access_token=${synthetic}`],
      ["webUrl", `https://${synthetic}@example.invalid/`],
      ["comments", [{ id: 2, text: `Bearer ${synthetic}` }]],
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

test("ticket watcher posts verified draft links but reports an unverified PR as blocked", async () => {
  const fixture = ticketFixture();
  try {
    await fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "Scoped fix and focused tests passed. Browser evidence is unavailable.", pullRequestId: 17 }) });
    assert.match(fixture.posted[0].text, /Draft PR: https:\/\/dev\.azure\.com\/.*\/pullrequest\/17/);
    assert.match(readTicketAutomationHistory(fixture.repository).attempts[0].pullRequestUrl, /pullrequest\/17$/);
    fixture.item.description = "Check a second scenario.";
    fixture.client.verifyDraft = async () => { throw new Error("PR is not draft."); };
    await fixture.run({ execute: async () => ({ outcome: "draft-pr", summary: "A result needs verification.", pullRequestId: 18 }) });
    assert.match(fixture.posted[1].text, /Outcome: blocked/);
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
  const client = createAzureDevOpsTicketClient({
    profile: { azureDevOps: { organization: "example-org", project: "Example Project" } },
    tokenProvider: () => "private-test-token",
    async requestJson(url, token, options = {}) {
      assert.equal(token, "private-test-token");
      assert.match(url, /^https:\/\/dev\.azure\.com\/example-org\/Example%20Project\/_apis\//);
      calls.push({ url, options });
      if (url.includes("/wiql?")) {
        assert.match(options.body.query, /Tags.*CONTAINS 'FixLab'/);
        return { workItems: [{ id: 42 }] };
      }
      if (url.includes("/workitems?")) {
        return { value: [{ id: linkedTicketId }] };
      }
      if (url.includes("/pullrequests/")) {
        return { isDraft: draft, status: "active", targetRefName: "refs/heads/develop", repository: { name: "example-repo" } };
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
  assert.equal(await client.hasComment(42, "[FixLab automation 42:abc]"), false);
  await client.comment(42, "Analysis <script>must be text</script>");
  const posted = calls.find(call => call.options.method === "POST" && call.url.includes("/comments?"));
  assert.equal(posted.options.body.text, "Analysis &lt;script&gt;must be text&lt;/script&gt;");
  assert.match(await client.verifyDraft("example-repo", 17, "develop", 42), /pullrequest\/17$/);
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
      text: "Newest & useful"
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
