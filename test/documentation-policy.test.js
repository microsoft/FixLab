import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { checkDocumentation } from "../scripts/ci/check-docs.mjs";

const requiredFiles = [
  "README.md",
  "installation.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/commands.md",
  "docs/getting-started.md",
  "docs/installation.md",
  "docs/releasing.md",
  "docs/repository-onboarding.md",
  "docs/security.md",
  "docs/team-rollout.md"
];

function createDocumentationTree() {
  const root = mkdtempSync(join(tmpdir(), "fixlab-docs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const file of requiredFiles) {
    writeFileSync(
      join(root, file),
      file === "CONTRIBUTING.md"
        ? "Run `npm run validate`.\n"
        : "# Documentation\n"
    );
  }
  return root;
}

test("first installation is linked, packaged and separates prerequisites from setup changes", () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const readme = read("README.md");
  assert.match(readme, /\[installation\.md\]\(installation\.md\)/u);
  for (const instruction of [
    "register its MCP server", "--runtime copilot", "FIXLAB-SETUP.md",
    "otherwise use:", "run Doctor", "Do not start a job or publish changes"
  ]) {
    assert.ok(readme.includes(instruction), instruction);
  }
  const guide = read("installation.md");
  const install = guide.indexOf("npm install --global");
  const onboard = guide.indexOf("fixlab onboard C:\\source\\application --runtime copilot");
  const doctor = guide.indexOf("fixlab doctor C:\\source\\application --runtime copilot");
  const chat = guide.indexOf("fixlab chat C:\\source\\application --runtime copilot");
  assert.ok(install >= 0 && install < onboard && onboard < doctor && doctor < chat,
    "keep the complete manual sequence in installation.md rather than duplicating it in README");
  assert.ok(JSON.parse(read("package.json")).files.includes("installation.md"));
  for (const section of [
    "## 1. Prerequisites: install separately",
    "## 2. Install FixLab",
    "### What this adds to the machine",
    "## 3. Set up an application"
  ]) {
    assert.ok(guide.includes(section), section);
  }
});

test("reviewed setup defaults to Edge and protects private authentication state", () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const file of ["README.md", "installation.md", "docs/installation.md", "docs/FIXLAB-SETUP.md"]) {
    assert.ok(read(file).includes("Microsoft Edge"), file);
  }
  const guide = read("docs/FIXLAB-SETUP.md");
  const pasteOnlyPrompt = guide.match(/## Option 1: paste one prompt[\s\S]*?```text\r?\n([\s\S]*?)```/u)?.[1];
  assert.ok(pasteOnlyPrompt, "the paste-only setup prompt must be available");
  assert.ok(pasteOnlyPrompt.includes("https://github.com/microsoft/FixLab/blob/main/docs/FIXLAB-SETUP.md"),
    "the prompt must locate its guide without an attachment");
  assert.ok(pasteOnlyPrompt.includes("https://github.com/microsoft/FixLab/blob/main/docs/installation.md"),
    "the prompt must include a manual fallback");
  for (const instruction of [
    "Default to Microsoft Edge",
    '"browser": "chromium"',
    '"channel": "msedge"',
    "dotnet restore $BackendProject --interactive",
    "yarn install --frozen-lockfile",
    "launchPersistentContext",
    "public directory",
    "authentication-status",
    "confirm no job was started"
  ]) {
    assert.ok(guide.includes(instruction), instruction);
  }
  const approval = guide.indexOf("Approve scaffolding before first-run onboarding");
  const onboard = guide.indexOf("fixlab onboard $Repo --runtime copilot");
  assert.ok(approval >= 0 && approval < onboard);
});

test("documentation policy accepts complete internal links", () => {
  const root = createDocumentationTree();
  try {
    writeFileSync(
      join(root, "README.md"),
      "# Documentation\n\n[Architecture](docs/architecture.md)\n"
    );
    assert.deepEqual(checkDocumentation(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documentation policy reports broken relative links", () => {
  const root = createDocumentationTree();
  try {
    writeFileSync(
      join(root, "README.md"),
      "# Documentation\n\n[Missing](docs/missing.md)\n"
    );
    assert.match(
      checkDocumentation(root).join("\n"),
      /linked path does not exist/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
