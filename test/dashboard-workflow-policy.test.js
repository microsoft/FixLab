import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { API_ONLY_PLAYWRIGHT_GUIDANCE, DEV_WRITE_GUIDANCE, PPE_POST_GUIDANCE, DRAFT_INTEGRATION_GUIDANCE, UNVERIFIED_DRAFT_GUIDANCE, OPTIONAL_INTEGRATION_GUIDANCE, AUTONOMOUS_RECOVERY_GUIDANCE, allowsUnverifiedDraft, UNIT_TEST_ONLY_GUIDANCE, PR_LEARNING_GUIDANCE, READ_ONLY_POST_GUIDANCE, RUNTIME_RECOVERY_GUIDANCE, configuredWorkflow, efficientWorkflowGuidance } from "../dashboard/workflow-policy.js";
import { ValidationSession, selectedValidationGates, validationGates } from "../dashboard/validation-gates.js";
import { buildJobPrompt, FIXLAB_STAGES } from "../dashboard/server.js";

test("verified read-only POST searches use the default browser policy independently of write consent", () => {
  for (const mode of ["fix-and-validate", "validate-only", "playwright-only"]) {
    for (const allowPostRequests of [undefined, false, true]) {
      const testEvidence = {
        enabled: true, source: "non-production-read-only", mutationMode: "intercepted",
        requireScenarioEvidence: true, allowPostRequests
      };
      const prompt = buildJobPrompt({
        request: "Validate a permitted search using genuine returned records.",
        mode, targetEnvironment: "dev", testEvidence
      });
      assert.ok(prompt.includes(READ_ONLY_POST_GUIDANCE));
      for (const phrase of [
        "Verified read-only POST searches:", "exact approved environment, origin and path",
        "genuine returned records", "policy blocker, not backend unavailability",
        "Do not silently substitute synthetic data", "Read-only jobs must not edit configuration",
        "synthetic-only, API-only, unit-only or production policy",
        "fixlab setup-queries REPOSITORY --environment ENV --runtime RUNTIME",
        "separate plan-first setup operation", "Cover the full verified query scope"
      ]) {
        assert.ok(prompt.includes(phrase), `${mode}/${allowPostRequests}: ${phrase}`);
      }
      assert.equal(testEvidence.mutationMode, "intercepted");
    }
  }
  for (const testEvidence of [{ apiOnly: true }, { unitTestsOnly: true }]) {
    assert.ok(!buildJobPrompt({ request: "Keep stricter validation.", mode: "validate-only",
      testEvidence }).includes(READ_ONLY_POST_GUIDANCE));
  }
});

test("verified query guidance stays aligned without expanding interactive CLI arguments", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md", "prompts/fixlab.live-test.prompt.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/`/gu, "").replace(/\s+/gu, " ");
    assert.ok(source.includes(READ_ONLY_POST_GUIDANCE), path);
  }
  const cli = readFileSync(new URL("../bin/fixlab.js", import.meta.url), "utf8");
  assert.match(cli, /request && profile\.validation\?\.liveTestsRequired !== false &&\s+profile\.browserAutomation\?\.mode !== "api" \? \[READ_ONLY_POST_GUIDANCE\]/u);
});

test("DEV write guidance stays native-only and aligned across runtime and initialized agents", () => {
  assert.ok(RUNTIME_RECOVERY_GUIDANCE.includes(DEV_WRITE_GUIDANCE));
  assert.ok(RUNTIME_RECOVERY_GUIDANCE.includes(PPE_POST_GUIDANCE));
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/gu, " ");
    assert.ok(source.includes(DEV_WRITE_GUIDANCE), path);
    assert.ok(source.includes(PPE_POST_GUIDANCE), path);
  }
});

test("DEV portal defaults stay aligned across CLI, packaged and initialized agents", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/`/gu, "").replace(/\s+/gu, " ");
    for (const contract of [
      "browserAutomation.testSynthesis.devReadOnly: true",
      "ppeReadOnly: true",
      "all verified read-only queries",
      "real read-only backend data while intercepting mutations",
      "other environments retain defaultDataSource",
      "policy changes require a fresh reviewed job"
    ]) {
      assert.ok(source.includes(contract), `${path}: ${contract}`);
    }
  }
  const cli = readFileSync(new URL("../bin/fixlab.js", import.meta.url), "utf8");
  assert.match(cli, /configuredTestSynthesis\(profile, "", undefined, selectedEnvironment\)/u);
  assert.match(cli, /testEvidence\.source === "non-production-read-only"/u);
});

test("reusable learning is captured within the authorized PR stage without a new roadmap stage", () => {
  for (const mode of ["efficient", "strict"]) {
    const prompt = buildJobPrompt({
      request: "Fix a repeatable defect.",
      mode: "fix-and-validate",
      workflow: configuredWorkflow({ workflow: { mode } })
    });
    for (const phrase of [
      "Reusable PR learning:", "existing pr stage", ".github/skills/<topic>/SKILL.md",
      "verified, non-obvious, reusable", "update a matching skill",
      "YAML name and description", "when to use", "verified solution",
      "working directories", "validation commands", "pitfalls",
      "same reviewed PR", "no new reusable learning", "no separate roadmap stage",
      "Do not add allowed-tools or broaden permissions",
      "Read-only jobs must not write skills"
    ]) {
      assert.ok(prompt.includes(phrase), `${mode}: ${phrase}`);
    }
  }
  assert.deepEqual(FIXLAB_STAGES, [
    "intake", "diagnosis", "reproduce", "fix", "review", "local-stack", "live-test", "pr"
  ]);
  for (const mode of ["validate-only", "playwright-only"]) {
    const prompt = buildJobPrompt({ request: "Inspect without edits.", mode });
    assert.doesNotMatch(prompt, /Reusable PR learning:|\.github\/skills\/<topic>\/SKILL\.md/);
  }
});

test("PR learning stays aligned across CLI, packaged agents, initialized agents and PR prompts", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md", "prompts/fixlab.pr.prompt.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/`/gu, "").replace(/\s+/gu, " ");
    assert.ok(source.includes(PR_LEARNING_GUIDANCE), `${path} must preserve the complete PR learning contract`);
  }
  const cli = readFileSync(new URL("../bin/fixlab.js", import.meta.url), "utf8");
  assert.match(cli, /!readOnly && request \? \[PR_LEARNING_GUIDANCE\]/);
});

test("production-backed API safety guidance reaches CLI, dashboard and every packaged agent", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const marker of ["productionDatabaseReadOnly", "assertReadOnlyDatabase",
      "production-read-only", "deployed production URLs or writes"]) {
      assert.ok(text.includes(marker), `${path}: ${marker}`);
      assert.ok(API_ONLY_PLAYWRIGHT_GUIDANCE.includes(marker), marker);
    }
  }
  for (const path of ["bin/fixlab.js", "dashboard/server.js"]) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
      /API_ONLY_PLAYWRIGHT_GUIDANCE/u);
  }
});

test("explicit repository unit-only guidance reaches both runtimes without relaxing defaults", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const marker of ["validation.liveTestsRequired", "validation.liveTestsDeferredReason",
      "unit-test-only", "CI/merge policies"]) {
      assert.ok(text.includes(marker), `${path}: ${marker}`);
      assert.ok(UNIT_TEST_ONLY_GUIDANCE.includes(marker), marker);
    }
  }
  for (const path of ["bin/fixlab.js", "dashboard/server.js"]) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), /UNIT_TEST_ONLY_GUIDANCE/u);
  }
});

test("efficient workflow is a product default with saved preferences and strict opt-in", () => {
  assert.deepEqual(configuredWorkflow(), {
    mode: "efficient", unitTestsAfterPr: false, publication: "draft", optionalBuilds: false
  });
  assert.equal(configuredWorkflow({ workflow: { mode: "strict" } }).mode, "strict");
  for (const [publication, expected] of [["draft", true], ["ready", false], [undefined, false]]) {
    const workflow = configuredWorkflow({ workflow: { mode: "strict", publication } });
    assert.equal(workflow.publication, expected ? "draft" : "ready");
    const prompt = buildJobPrompt({ request: "Synthetic", mode: "fix-and-validate", workflow });
    assert.match(prompt, /all applicable configured gates remain required/);
    assert.match(prompt, expected ? /provider isDraft=true/ : /isDraft.*false/);
    if (expected) { assert.doesNotMatch(prompt, /publish the authorized PR by marking it ready/); }
    assert.match(buildJobPrompt({ request: "Synthetic", mode: "validate-only", workflow }),
      /Do not publish a pull request or change its draft status/);
  }
  const gates = validationGates({ validation: { gates: [
    { id: "unit", command: "npm", args: ["test"], workingDirectory: ".", timeoutSeconds: 10 },
    { id: "build", command: "npm", args: ["run", "build"], kind: "builds", stage: "local-stack", workingDirectory: ".", timeoutSeconds: 10 }
  ] } });
  for (const [selection, value, ids] of [
    ["all", undefined, ["unit", "build"]], ["tests", undefined, ["unit"]],
    ["builds", undefined, ["build"]], ["gate", "unit", ["unit"]],
    ["stage", "local-stack", ["build"]]
  ]) {
    assert.deepEqual(selectedValidationGates(gates, selection, value).map((gate) => gate.id), ids);
  }
  for (const [selection, value] of [["unknown"], ["gate", "unknown"], ["stage"]]) {
    assert.throws(() => selectedValidationGates(gates, selection, value), /Select configured|No configured/);
  }
  assert.deepEqual(configuredWorkflow({ workflow: {
    optionalBuilds: true, unitTestsAfterPr: false
  } }), { mode: "efficient", optionalBuilds: true, publication: "draft", unitTestsAfterPr: false });
  for (const workflow of ["efficient", [], { mode: "unknown" }, { publication: "unknown" }, { optionalBuilds: "true" }]) {
    assert.throws(() => configuredWorkflow({ workflow }), /workflow must/);
  }
});

test("efficient prompts publish before broad tests without weakening explicit requirements or read-only mode", () => {
  const workflow = configuredWorkflow();
  const guidance = efficientWorkflowGuidance(workflow);
  assert.match(guidance, /required: true/);
  assert.match(guidance, /DRAFT/);
  assert.match(guidance, /Broader local unit tests are optional/);
  const selected = efficientWorkflowGuidance(configuredWorkflow({
    workflow: { publication: "ready", unitTestsAfterPr: true }
  }));
  assert.match(selected, /READY-FOR-REVIEW/);
  assert.match(selected, /After creating the PR, run the broader local unit-test/);
  assert.match(guidance, /Keep Jest and Playwright discovery separate/);
  assert.match(guidance, /Reduce redundant regression cases, not correctness/);
  assert.match(guidance, /Optional builds are not automatically requested/);
  const prompt = buildJobPrompt({ request: "Fix synthetic regression", mode: "fix-and-validate", workflow });
  assert.match(prompt, /Saved delivery workflow: efficient/);
  assert.doesNotMatch(prompt, /create or update a draft pull request|PR readiness stays blocked/);
  const readOnly = buildJobPrompt({ request: "Check behavior", mode: "validate-only", workflow });
  assert.match(readOnly, /Do not edit files other than job-owned transient Playwright journeys and runner evidence/);
  assert.match(readOnly, /Do not create commits, push branches, create pull requests, or update pull requests/);
  assert.doesNotMatch(readOnly, /Saved efficient delivery policy/);
});

test("browser-only reproduction is existing-application first without claiming deployed results prove a PR", () => {
  const prompt = buildJobPrompt({
    request: "Reproduce the existing application issue without fixing it",
    mode: "playwright-only", targetEnvironment: "dev"
  });
  assert.match(prompt, /Use normal Copilot reasoning and native tools/);
  assert.match(prompt, /Stage markers report work; they are not a recipe/);
  assert.match(prompt, /Existing-application fast path/);
  assert.match(prompt, /Mark unnecessary local-stack work skipped, not passed/);
  assert.match(prompt, /never copy browser state/);
  assert.match(prompt, /does not validate unpublished local changes or a PR/);
  assert.match(prompt, /Do not commit, push, create or update pull requests/);
  assert.match(prompt, /No Save, Submit, Approve, autosave/);
});
test("draft checkpoints separate live prerequisites from required local checks without passing integration", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-draft-checkpoint-"));
  const gate = (id, properties = {}) => ({
    id, command: process.execPath, args: ["-e", "process.exit(0)"],
    workingDirectory: ".", timeoutSeconds: 10, required: true, ...properties
  });
  try {
    const profile = { validation: { gates: [
      gate("frontend-tests"), gate("backend-tests"),
      gate("browser", { stage: "live-test" }),
      gate("backend-health", { stage: "local-stack", requiresLiveIntegration: true })
    ] } };
    const session = new ValidationSession(repository, profile, "fix-and-validate");
    assert.equal(session.summary().draftReady, false);
    session.results.set("frontend-tests", { status: "passed", exitCode: 0 });
    session.results.set("backend-tests", { status: "passed", exitCode: 0 });
    let summary = session.summary();
    assert.equal(summary.draftReady, true);
    assert.equal(summary.status, "pending");
    assert.equal(summary.fullValidationPassed, false);
    assert.equal(summary.gates.find((item) => item.id === "browser").status, "pending");
    session.results.set("browser", { status: "failed", exitCode: 1 });
    summary = session.summary();
    assert.equal(summary.draftReady, true);
    assert.equal(summary.status, "blocked");
    assert.equal(summary.gates.find((item) => item.id === "browser").status, "failed");
    for (const status of ["failed", "stale", "running"]) {
      session.results.set("backend-tests", { status });
      assert.equal(session.summary().draftReady, false, status);
    }
    session.results.set("backend-tests", { status: "passed", exitCode: 0 });
    session.error = "Source/profile verification failed.";
    assert.equal(session.summary().draftReady, false);
    const localBrowser = new ValidationSession(repository, { validation: { gates: [
      gate("local-browser", { stage: "live-test", requiresLiveIntegration: false })
    ] } }, "fix-and-validate");
    assert.equal(localBrowser.summary().draftReady, false, "explicit local browser checks stay mandatory");
    assert.throws(() => validationGates({ validation: { gates: [
      gate("invalid", { requiresLiveIntegration: "yes" })
    ] } }), /Each validation gate/u);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("draft integration guidance permits both code surfaces without changing live-only, ready or explicit checks", () => {
  for (const mode of ["efficient", "strict"]) {
    const workflow = configuredWorkflow({ workflow: { mode, publication: "draft" } });
    for (const request of ["Frontend-only panel fix", "Backend service correction"]) {
      assert.ok(buildJobPrompt({ request, workflow, mode: "fix-and-validate" }).includes(DRAFT_INTEGRATION_GUIDANCE));
    }
    for (const overrides of [
      { mode: "validate-only" }, { mode: "playwright-only" },
      { workflow: { ...workflow, publication: "ready" } },
      { manualLocalhostTest: true }, { runAllUiScenarios: true },
      { testEvidence: { productionDatabaseReadOnly: true } }
    ]) {
      assert.ok(!buildJobPrompt({ request: "Keep mandatory live checks.", workflow,
        mode: "fix-and-validate", ...overrides }).includes(DRAFT_INTEGRATION_GUIDANCE));
    }
  }
});
test("draft integration guidance stays aligned across CLI and packaged agents", () => {
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/gu, " ");
    assert.ok(source.includes(DRAFT_INTEGRATION_GUIDANCE), path);
  }
  const cli = readFileSync(new URL("../bin/fixlab.js", import.meta.url), "utf8");
  assert.match(cli, /request && !choices.deferValidation && allowsDraftIntegrationDeferral\(\{ mode: readOnly \? "validate-only" : "fix-and-validate", workflow \}\)/u);
});

test("explicit unverified drafts defer checks without changing ready, manual or validation-only contracts", () => {
  const job = { request: "Small code change.", mode: "fix-and-validate",
    workflow: { mode: "strict", publication: "draft" }, deferValidation: true,
    skipLiveTests: true, useDeployedBackend: true };
  assert.equal(allowsUnverifiedDraft(job), true);
  const prompt = buildJobPrompt(job);
  assert.ok(prompt.includes(UNVERIFIED_DRAFT_GUIDANCE));
  assert.ok(prompt.includes(OPTIONAL_INTEGRATION_GUIDANCE));
  assert.ok(!prompt.includes(DRAFT_INTEGRATION_GUIDANCE));
  assert.ok(!prompt.includes("run the focused regression checks that cover it"));
  for (const overrides of [
    { deferValidation: false }, { mode: "validate-only" }, { mode: "playwright-only" },
    { workflow: { mode: "strict", publication: "ready" } }, { manualLocalhostTest: true },
    { runAllUiScenarios: true }, { testEvidence: { productionDatabaseReadOnly: true } }
  ]) {
    assert.equal(allowsUnverifiedDraft({ ...job, ...overrides }), false);
  }
  for (const path of [
    "agents/fixlab.md", "com.github.copilot/agents/fixlab.agent.md",
    "templates/fixlab-autofix.agent.md", ".github/agents/fixlab-autofix.agent.md",
    ".github/agents/fixlab.agent.md"
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/gu, " ");
    assert.ok(source.includes(UNVERIFIED_DRAFT_GUIDANCE), path);
    assert.ok(source.includes(OPTIONAL_INTEGRATION_GUIDANCE), path);
    assert.ok(source.includes(AUTONOMOUS_RECOVERY_GUIDANCE), path);
  }
});

test("advisory validation retains actual failures and optional gates stay executable", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-workflow-"));
  const gate = (id, required) => ({
    id, command: process.execPath, args: ["-e", "process.exit(0)"],
    workingDirectory: ".", timeoutSeconds: 10, ...(required === undefined ? {} : { required })
  });
  try {
    const profile = { validation: { gates: [gate("unit-tests"), gate("build")] } };
    const session = new ValidationSession(repository, profile, "fix-and-validate", { advisory: true });
    assert.equal(session.summary().status, "advisory");
    assert.equal(session.summary().fullValidationPassed, false);
    assert.equal(session.required(session.gates[0], "all"), true);
    assert.equal(session.summary().gates[0].required, false);
    session.results.set("unit-tests", { status: "failed", exitCode: 1 });
    assert.equal(session.summary().status, "advisory");
    assert.equal(session.summary().gates[0].status, "failed");
    assert.equal(session.summary().fullValidationPassed, false);
    const strict = new ValidationSession(repository, profile, "fix-and-validate");
    assert.equal(strict.summary().status, "pending");
    assert.equal(strict.summary().gates[0].required, true);
    const enforced = new ValidationSession(repository,
      { ...profile, workflow: { mode: "strict" } }, "fix-and-validate", { advisory: true });
    assert.equal(enforced.summary().gates[0].required, true);
    const required = new ValidationSession(repository, {
      validation: { gates: [gate("required-tests", true), gate("build", false)] }
    }, "fix-and-validate", { advisory: true });
    assert.equal(required.summary().status, "pending");
    required.results.set("required-tests", { status: "failed", exitCode: 1 });
    assert.equal(required.summary().status, "blocked");
    required.results.set("required-tests", { status: "passed", exitCode: 0 });
    assert.equal(required.summary().status, "passed");
    assert.equal(required.summary().fullValidationPassed, false);
    assert.equal(required.summary().gates[1].status, "pending");
    session.results.set("unit-tests", { status: "passed", exitCode: 0 });
    session.results.set("build", { status: "passed", exitCode: 0 });
    assert.equal(session.summary().fullValidationPassed, true);
    session.error = "Could not verify current validation inputs.";
    assert.equal(session.summary().fullValidationPassed, false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
