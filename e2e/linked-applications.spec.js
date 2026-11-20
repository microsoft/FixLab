import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = process.env.FIXLAB_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const { createDashboardServer } = await import(pathToFileURL(join(packageRoot, "dashboard", "server.js")).href);
const { compileIssuePlan, executeBrowserPlan, issuePlanConfiguration } = await import(pathToFileURL(join(packageRoot, "dashboard", "issue-plans.js")).href);

test("issue plans execute a real browser repro before and after the local fixture is fixed", async () => {
  test.setTimeout(90000);
  const parent = join(packageRoot, "test-results");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "issue-plan-browser-"));
  const relativeDirectory = directory.slice(packageRoot.length).replaceAll("\\", "/").replace(/^\/+/u, "");
  let fixed = false;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<label>Name<input aria-label="Name"></label><button onclick="document.querySelector('input').value='${fixed ? "New name" : "Lost name"}'">Apply</button>`);
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(directory, "fixture.mjs"), 'export { test, expect } from "@playwright/test";\n');
    writeFileSync(join(directory, "config.mjs"), `export default { timeout: 15000, use: { headless: true${process.platform === "win32" ? ', channel: "msedge"' : ""} } };\n`);
    const profile = { environments: ["dev"], applications: { frontend: { healthUrl: origin } },
      browserAutomation: { workingDirectory: ".", testSynthesis: { enabled: true, issuePlans: {
        fixture: `${relativeDirectory}/fixture.mjs`, config: `${relativeDirectory}/config.mjs`,
        directory: `${relativeDirectory}/journeys`
      } } } };
    const plan = { version: 1, kind: "playwright", workItemId: 42, environment: "dev",
      policyRevision: issuePlanConfiguration(packageRoot, profile, "dev").browser.policyRevision,
      title: "Issue 42 retains the updated name",
      steps: [{ action: "goto", path: "/" },
        { action: "fill", target: { by: "label", value: "Name" }, value: "New name" },
        { action: "click", target: { by: "role", role: "button", name: "Apply" } },
        { action: "assertValue", target: { by: "label", value: "Name" }, value: "New name" }] };
    const compiled = compileIssuePlan(packageRoot, profile, plan, { environment: "dev" });
    const before = await executeBrowserPlan(packageRoot, compiled);
    expect(before.status).toBe("failed");
    expect(before.failedStep).toBe(4);
    fixed = true;
    expect((await executeBrowserPlan(packageRoot, compiled)).status).toBe("passed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("linked frontend opening confirms its separate owner, rejects stale review and starts no job", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-linked-browser-"));
  const source = join(directory, "api");
  const target = join(directory, "web");
  let dashboard;
  let executions = 0;
  const save = (root, profile) => writeFileSync(join(root, ".github", "fixlab", "repository-profile.json"), JSON.stringify(profile));
  try {
    for (const root of [source, target]) {
      mkdirSync(join(root, ".github", "fixlab"), { recursive: true });
      const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
      expect(initialized.status, initialized.stderr).toBe(0);
    }
    const browserAutomation = {
      workingDirectory: ".", package: "@playwright/test", testCommand: "npm run test:e2e",
      testSynthesis: { enabled: true, defaultDataSource: "non-production-read-only", mutationMode: "none", requireScenarioEvidence: true },
      authentication: { required: false, command: "", statusPaths: [] },
      dataSafety: { policy: "Synthetic read-only fixture; no business data.", productionAllowed: false,
        allowedOrigins: ["https://localhost:5088"], allowedMethods: ["GET"] }
    };
    const sourceProfile = {
      name: "API owner", environments: ["local"],
      applications: { backend: { workingDirectory: ".", command: "dotnet run", port: 5087, healthUrl: "https://localhost:5088/health" } },
      browserAutomation: { ...browserAutomation, mode: "api" },
      linkedApplications: [{ id: "web-client", repository: target, application: "frontend", url: "http://localhost:43001", environment: "local" }]
    };
    save(source, sourceProfile);
    save(target, {
      name: "Frontend owner", environments: ["local"],
      applications: { frontend: { workingDirectory: ".", command: "npm start", port: 43001, healthUrl: "http://localhost:43001/health" } },
      browserAutomation: { ...browserAutomation, browser: "chromium" }
    });
    dashboard = createDashboardServer({
      repository: source, packageRoot,
      executor() { executions++; throw new Error("Opening a link must not execute a job."); },
      browserOpener() {}
    });
    const { url } = await dashboard.listen({ port: 0 });
    await page.goto(url);
    await page.locator('.workspace-navigation [data-open="connections-group"]').click();
    await page.locator("#linked-applications-load").click();
    const button = page.getByRole("button", { name: "Open web-client workspace", exact: true });
    await expect(button).toBeVisible();
    await expect(page.locator("#linked-applications-list")).toContainText(target);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(target);
      await dialog.dismiss();
    });
    await button.click();
    await expect(page).toHaveURL(url);
    sourceProfile.customContract = "Changed after browser review";
    save(source, sourceProfile);
    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    await expect(page.locator("#linked-applications-message")).toContainText("changed");
    await expect(page).toHaveURL(url);
    await page.locator("#linked-applications-load").click();
    page.once("dialog", (dialog) => dialog.accept());
    await button.click();
    await expect(page).not.toHaveURL(url);
    const owner = await (await page.request.get(new URL("/api/session", page.url()).href)).json();
    expect(owner.repository).toBe(realpathSync.native(target));
    const state = await (await page.request.get(new URL("/api/status", page.url()).href)).json();
    expect(state.job).toBeNull();
    expect(executions).toBe(0);
    const sourceState = await (await page.request.get(new URL("/api/status", url).href)).json();
    expect(sourceState.job).toBeNull();
  } finally {
    if (dashboard) { await dashboard.close(); }
    rmSync(directory, { recursive: true, force: true });
  }
});
