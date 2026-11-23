import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import {
  executeStructuredCommand,
  resolveWindowsAzureCommand,
  parseStructuredCommandArguments
} from "../bin/structured-command.js";

test("Windows Azure launcher uses only the canonical CLI2 Python and preserves argv without a shell", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fixlab-azure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, "CLI2");
  const wbin = join(cli, "wbin");
  mkdirSync(wbin, { recursive: true });
  const wrapper = join(wbin, "az.cmd");
  const python = join(cli, "python.exe");
  writeFileSync(wrapper, "@echo off\n");
  writeFileSync(python, "synthetic fixture, never executed");
  const args = ["repos", "pr", "show", "--id", "1", "--query", "title | length(@)", "--output", "json"];
  assert.deepEqual(resolveWindowsAzureCommand("az", args, "win32", wbin),
    { command: python, args: ["-m", "azure.cli", ...args] });
  assert.deepEqual(resolveWindowsAzureCommand(wrapper, args, "win32", ""),
    { command: python, args: ["-m", "azure.cli", ...args] });
  for (const [command, platform, path] of [
    ["az", "linux", wbin], ["other", "win32", wbin],
    [join("relative", "az.cmd"), "win32", wbin], ["az", "win32", directory]
  ]) {
    assert.equal(resolveWindowsAzureCommand(command, args, platform, path), null);
  }
  rmSync(python);
  assert.equal(resolveWindowsAzureCommand("az", args, "win32", wbin), null);
});

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
}

let repositoryTemplate;
after(() => {
  if (repositoryTemplate) {
    rmSync(repositoryTemplate, { recursive: true, force: true });
  }
});

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-structured-"));
  if (!repositoryTemplate) {
    repositoryTemplate = mkdtempSync(join(tmpdir(), "fixlab-structured-template-"));
    git(repositoryTemplate, ["init", "--quiet"]);
    writeFileSync(join(repositoryTemplate, "tracked.txt"), "initial\n");
    git(repositoryTemplate, ["add", "tracked.txt"]);
    git(repositoryTemplate, ["-c", "user.name=FixLab Test", "-c",
      "user.email=fixlab@example.test", "commit", "--quiet", "-m", "initial"]);
  }
  cpSync(repositoryTemplate, repository, { recursive: true });
  return repository;
}

function capture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      }
    },
    text() {
      return value;
    }
  };
}

test("owned structured commands inherit the selected DEV browser configuration context", async () => {
  const repository = createRepository();
  const output = capture();
  try {
    const status = await executeStructuredCommand({
      repository, cwd: repository, stage: "validation", reuse: false,
      timeoutSeconds: 30, command: process.execPath,
      commandArgs: ["-e", "if(process.env.FIXLAB_DEV_API_ENVIRONMENT!=='dev'||process.env.FIXLAB_DEV_API_MUTATION_MODE!=='none'||process.env.FIXLAB_DEV_API_SELECTED_MUTATION_MODE!=='none'||process.env.FIXLAB_REPOSITORY!==process.cwd()||process.env.FIXLAB_HELPER_ROOT!=='fixture-helper-root')process.exit(3);"]
    }, { stdout: output.stream, stderr: output.stream, environment: {
      FIXLAB_REPOSITORY: repository, FIXLAB_HELPER_ROOT: "fixture-helper-root",
      FIXLAB_DEV_API_ENVIRONMENT: "dev", FIXLAB_DEV_API_MUTATION_MODE: "none",
      FIXLAB_DEV_API_SELECTED_MUTATION_MODE: "none"
    } });
    assert.equal(status, 0, output.text());
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("structured execution keeps compact diagnostics and redacted evidence", async () => {
  const repository = createRepository();
  const output = capture();
  const errors = capture();

  try {
    const status = await executeStructuredCommand(
      {
        repository,
        cwd: repository,
        stage: "validation",
        reuse: false,
        timeoutSeconds: 0,
        command: process.execPath,
        commandArgs: [
          "-e",
          [
            "for(let i=0;i<200;i++) console.log('warning repeated warning');",
            "console.log('token=super-secret-value');",
            "console.log('Authorization: Bearer bearer-secret-value');",
            "console.log(JSON.stringify({token:'json-secret-value'}));",
            "console.log('# tests 116');",
            "console.log('# pass 114');",
            "console.log('# fail 1');",
            "console.log('# cancelled 1');",
            "console.log('# skipped 0');",
            "console.error('error TS1234: expected value');",
            "process.exitCode=2;"
          ].join("")
        ]
      },
      { stdout: output.stream, stderr: errors.stream }
    );

    assert.equal(status, 2);
    assert.equal(output.text(), "");
    assert.match(errors.text(), /FAIL fixlab exec/);
    assert.match(errors.text(), /error TS1234/);
    assert.match(errors.text(), /Unique warnings retained: 1/);
    assert.match(
      errors.text(),
      /Tests: 114 passed, 1 failed, 1 cancelled, 0 skipped, 116 total/
    );
    assert.match(
      errors.text(),
      /Context: \d+ raw lines \/ \d+ bytes \(~\d+ tokens\) -> \d+ summary lines \/ \d+ bytes \(~\d+ tokens\), \d+\.\d% reduction; \d+ lines omitted/
    );
    assert.doesNotMatch(errors.text(), /super-secret-value/);
    assert.doesNotMatch(errors.text(), /bearer-secret-value|json-secret-value/);
    assert.doesNotMatch(errors.text(), /warning repeated warning.*warning repeated warning/su);

    const evidenceMatch = errors.text().match(/^Evidence: (.+)$/mu);
    assert.ok(evidenceMatch);
    const evidenceDirectory = evidenceMatch[1];
    assert.equal(existsSync(join(evidenceDirectory, "result.json")), true);
    const result = JSON.parse(
      readFileSync(join(evidenceDirectory, "result.json"), "utf8")
    );
    assert.equal(result.version, 2);
    assert.equal(result.tool, "Node.js");
    assert.deepEqual(result.stdout.tests, {
      failed: 1,
      passed: 114,
      skipped: 0,
      cancelled: 1,
      total: 116,
      suites: null,
      durationMs: null
    });

    assert.equal(result.context.rawLines > result.context.structuredLines, true);
    assert.equal(result.context.reductionPercent > 80, true);
    assert.equal(
      Buffer.byteLength(errors.text()),
      result.context.structuredBytes
    );
    assert.equal(
      result.context.estimatedRawTokens >
        result.context.estimatedStructuredTokens,
      true
    );
    const stdoutEvidence = readFileSync(
      join(evidenceDirectory, "stdout.log"),
      "utf8"
    );
    assert.doesNotMatch(
      stdoutEvidence,
      /super-secret-value|bearer-secret-value|json-secret-value/
    );
    assert.match(stdoutEvidence, /token=\[REDACTED\]/);
    assert.match(stdoutEvidence, /Authorization: \[REDACTED\]/);
    assert.match(stdoutEvidence, /"token":\[REDACTED\]/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("oversized lines remain bounded and never expose partial credentials", async () => {
  const repository = createRepository();
  const output = capture();
  try {
    const status = await executeStructuredCommand({
      repository,
      cwd: repository,
      stage: "validation",
      reuse: false,
      timeoutSeconds: 5,
      command: process.execPath,
      commandArgs: ["-e", "process.stdout.write('token='+ 'x'.repeat(300000));console.log('\\n# tests 1\\n# pass 1')"]
    }, { stdout: output.stream, stderr: output.stream });
    assert.equal(status, 0);
    assert.match(output.text(), /Oversized output lines omitted: 1/);
    assert.ok(Buffer.byteLength(output.text()) < 2000);
    const evidenceDirectory = output.text().match(/^Evidence: (.+)$/mu)[1];
    const evidence = readFileSync(join(evidenceDirectory, "stdout.log"), "utf8");
    assert.doesNotMatch(evidence, /token=|xxxxxxxx/);
    assert.ok(Buffer.byteLength(evidence) < 1000);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("external worktree validation reuses only identical state and valid owned metadata", async () => {
  const primary = createRepository();
  const external = mkdtempSync(join(tmpdir(), "fixlab-external-worktree-"));
  const repository = join(external, "checkout");
  git(primary, ["worktree", "add", "--quiet", "--detach", repository, "HEAD"]);
  let executions = 0;
  const spawn = () => {
    executions += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("tests 1\npass 1\nfail 0\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };

  const options = {
    repository,
    cwd: repository,
    stage: "validation",
    reuse: true,
    timeoutSeconds: 30,
    command: process.execPath,
    commandArgs: ["--test", "tracked.test.js"]
  };

  try {
    const firstOutput = capture();
    const firstErrors = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: firstOutput.stream,
        stderr: firstErrors.stream,
        spawn
      }),
      0,
      firstErrors.text()
    );
    assert.match(firstOutput.text(), /^PASS fixlab exec/mu);
    assert.match(firstOutput.text(), /Tool: Node\.js test/mu);
    assert.match(
      firstOutput.text(),
      /Tests: 1 passed, 0 failed, 0 cancelled, 0 skipped, 1 total/mu
    );
    assert.equal(executions, 1);

    const secondOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: secondOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(secondOutput.text(), /^REUSED fixlab exec/mu);
    assert.equal(executions, 1);
    const evidenceRoot = join(primary, ".git", "worktrees", "checkout", "fixlab", "command-evidence");
    assert.equal(existsSync(evidenceRoot), true, "evidence belongs to the real external worktree Git directory");
    assert.equal(existsSync(join(repository, ".git", "fixlab")), false);
    const cachePath = join(evidenceRoot, "cache", readdirSync(join(evidenceRoot, "cache"))[0]);
    for (const malformed of ["{", JSON.stringify({ status: 0, evidenceDirectory: primary })]) {
      writeFileSync(cachePath, malformed);
      const malformedErrors = capture();
      assert.equal(await executeStructuredCommand(options, {
        stdout: capture().stream, stderr: malformedErrors.stream, spawn
      }), 0);
      assert.match(malformedErrors.text(), /Ignored (?:malformed|invalid)/);
    }
    assert.equal(executions, 3);

    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const changedOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: changedOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(changedOutput.text(), /^PASS fixlab exec/mu);
    assert.equal(executions, 4);

    writeFileSync(join(repository, "tracked.txt"), "changed again\n");
    const changedAgainOutput = capture();
    assert.equal(
      await executeStructuredCommand(options, {
        stdout: changedAgainOutput.stream,
        stderr: capture().stream,
        spawn
      }),
      0
    );
    assert.match(changedAgainOutput.text(), /^PASS fixlab exec/mu);
    assert.equal(executions, 5);
    for (const [environment, count] of [["dev", 6], ["sit", 7], ["dev", 7]]) {
      assert.equal(await executeStructuredCommand(options, {
        stdout: capture().stream, stderr: capture().stream, spawn,
        environment: { FIXLAB_DEV_API_ENVIRONMENT: environment }
      }), 0);
      assert.equal(executions, count, "Cached validation must not cross selected API environments.");
    }
    for (const [mutationMode, count] of [
      ["none", 8], ["intercepted", 9], ["none", 9], ["approved-write", 10]
    ]) {
      assert.equal(await executeStructuredCommand(options, {
        stdout: capture().stream, stderr: capture().stream, spawn,
        environment: { FIXLAB_DEV_API_ENVIRONMENT: "dev", FIXLAB_DEV_API_MUTATION_MODE: mutationMode }
      }), 0);
      assert.equal(executions, count, "Cached validation must not cross per-run mutation scopes.");
    }
    assert.equal(await executeStructuredCommand(options, {
      stdout: capture().stream, stderr: capture().stream, spawn,
      environment: { FIXLAB_DEV_API_ENVIRONMENT: "dev", FIXLAB_DEV_API_MUTATION_MODE: "approved-write",
        FIXLAB_DEV_API_SELECTED_MUTATION_MODE: "none" }
    }), 0);
    assert.equal(executions, 11, "An explicit restriction must not reuse persistent DEV write evidence.");
  } finally {
    rmSync(external, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
});

test("structured command fingerprints repositories containing a nested Git repository", async () => {
  const repository = createRepository();
  const nested = join(repository, ".nested-clone");
  mkdirSync(nested);
  git(nested, ["init", "--quiet"]);
  writeFileSync(join(nested, "file.txt"), "nested\n");
  git(nested, ["add", "file.txt"]);
  git(nested, [
    "-c",
    "user.name=FixLab Test",
    "-c",
    "user.email=fixlab@example.test",
    "commit",
    "--quiet",
    "-m",
    "nested"
  ]);
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("tests 1\npass 1\nfail 0\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const errors = capture();
  const output = capture();
  try {
    assert.equal(
      await executeStructuredCommand(
        {
          repository,
          cwd: repository,
          stage: "validation",
          reuse: true,
          timeoutSeconds: 30,
          command: process.execPath,
          commandArgs: ["--test", "tracked.test.js"]
        },
        { stdout: output.stream, stderr: errors.stream, spawn }
      ),
      0,
      errors.text()
    );
    assert.match(output.text(), /^PASS fixlab exec/mu);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("structured command arguments enforce repository containment", () => {
  const repository = createRepository();
  try {
    const parsed = parseStructuredCommandArguments(
      [repository, "--stage", "test", "--", process.execPath, "--version"],
      repository
    );
    assert.equal(parsed.command, process.execPath);
    assert.deepEqual(parsed.commandArgs, ["--version"]);
    assert.equal(parsed.stage, "test");
    assert.throws(
      () =>
        parseStructuredCommandArguments(
          [repository, "--cwd", "..", "--", process.execPath, "--version"],
          repository
        ),
      /--cwd must stay within the repository/
    );
    assert.throws(
      () => parseStructuredCommandArguments([repository, process.execPath]),
      /usage: fixlab exec[\s\S]*quoted/u
    );
    assert.throws(
      () => parseStructuredCommandArguments([repository, process.execPath]),
      /do not wrap the command in cmd \/c/u
    );
    assert.throws(
      () =>
        parseStructuredCommandArguments(
          [
            repository,
            "--timeout-seconds",
            "2147484",
            "--",
            process.execPath
          ],
          repository
        ),
      /integer from 1 to 2147483/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("unsupported commands are never reused", async () => {
  const repository = createRepository();
  let executions = 0;
  const spawn = () => {
    executions += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("done\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const options = {
    repository,
    cwd: repository,
    stage: "validation",
    reuse: true,
    timeoutSeconds: 0,
    command: process.execPath,
    commandArgs: ["-e", "console.log('done')"]
  };

  try {
    const first = capture();
    const firstErrors = capture();
    const second = capture();
    await executeStructuredCommand(options, {
      stdout: first.stream,
      stderr: firstErrors.stream,
      spawn
    });
    await executeStructuredCommand(options, {
      stdout: second.stream,
      stderr: capture().stream,
      spawn
    });
    assert.equal(executions, 2);
    assert.match(firstErrors.text(), /Reuse ignored/);
    assert.doesNotMatch(second.text(), /^REUSED/mu);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("tool labels redact secret-shaped executable names", async () => {
  const repository = createRepository();
  const output = capture();
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end("done\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };

  try {
    assert.equal(
      await executeStructuredCommand(
        {
          repository,
          cwd: repository,
          stage: "validation",
          reuse: false,
          timeoutSeconds: 0,
          command: "token=tool-secret",
          commandArgs: []
        },
        { stdout: output.stream, stderr: capture().stream, spawn }
      ),
      0
    );
    assert.match(output.text(), /Tool: token=\[REDACTED\]/u);
    assert.doesNotMatch(output.text(), /tool-secret/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("timed out commands return exit code 124", async () => {
  const repository = createRepository();
  const errors = capture();
  let spawnedAt;
  let result;
  const spawn = () => {
    spawnedAt = Date.now();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  };

  try {
    const status = await executeStructuredCommand(
      {
        repository,
        cwd: repository,
        stage: "test",
        reuse: false,
        timeoutSeconds: 1,
        command: process.execPath,
        commandArgs: ["-e", "setTimeout(() => {}, 10000)"]
      },
      {
        stdout: capture().stream,
        stderr: errors.stream,
        spawn,
        onResult(value) { result = value; },
        terminationGraceMs: 10
      }
    );
    assert.equal(status, 124);
    assert.equal(result.terminationVerified, false);
    assert.equal(Date.now() - spawnedAt < 2000, true);
    assert.match(errors.text(), /exceeded.*requesting owned-tree termination/is);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("owned Windows settlement failures never report success", { skip: process.platform !== "win32" }, async () => {
  const repository = createRepository();
  try {
    for (const failure of ["proof", "descendants", "terminate", "post-spawn", "missing-close"]) {
      const errors = capture();
      const controller = new AbortController();
      let result;
      let stops = 0;
      const status = await executeStructuredCommand({
        repository, cwd: repository, stage: "test", reuse: false,
        timeoutSeconds: 0, command: process.execPath, commandArgs: ["--version"]
      }, {
        ownProcessTree: true, signal: controller.signal, terminationGraceMs: 5,
        stdout: capture().stream, stderr: errors.stream,
        onResult(value) { result = value; },
        spawnWindowsExecutor() {
          const child = new EventEmitter();
          child.pid = 12345; // Synthetic PID; only the injected containment handles it.
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          queueMicrotask(() => {
            if (["terminate", "missing-close"].includes(failure)) {
              controller.abort();
            } else if (failure === "post-spawn") {
              child.emit("error", new Error("Synthetic post-spawn failure"));
            }
            if (failure !== "missing-close") { child.emit("close", 0, null); }
          });
          return {
            child,
            terminate() {
              stops++;
              if (failure === "terminate") { throw new Error("Synthetic stop failure"); }
            },
            hasStopped() {
              if (failure === "proof") { throw new Error("Synthetic invalid proof"); }
              return failure !== "descendants";
            }
          };
        }
      });
      assert.notEqual(status, 0, failure);
      assert.equal(result.terminationVerified, ["terminate", "post-spawn", "missing-close"].includes(failure), failure);
      assert.match(errors.text(), /lease must remain held|command failure retained/);
      if (result.terminationVerified) {
        assert.match(result.stderr.tail.join("\n"), /stopped proof verified/);
      }
      assert.equal(stops, ["terminate", "post-spawn", "missing-close"].includes(failure) ? 1 : 0);
    }
    for (const failure of ["false", "throw"]) {
      const controller = new AbortController();
      let result;
      const status = await executeStructuredCommand({
        repository, cwd: repository, stage: "test", reuse: false,
        timeoutSeconds: 0, command: process.execPath, commandArgs: ["--version"]
      }, {
        signal: controller.signal, terminationGraceMs: 5,
        stdout: capture().stream, stderr: capture().stream,
        onResult(value) { result = value; },
        spawn() {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => {
            if (failure === "throw") { throw new Error("Synthetic signal failure"); }
            return false;
          };
          queueMicrotask(() => { controller.abort(); child.emit("close", 0, null); });
          return child;
        }
      });
      assert.equal(status, 130);
      assert.equal(result.terminationVerified, false);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test(
  "Windows command wrappers preserve safe arguments and reject metacharacters",
  { skip: process.platform !== "win32" },
  async () => {
    const repository = createRepository();
    const wrapperDirectory = join(repository, "wrapper folder");
    const wrapper = join(wrapperDirectory, "echo-argument.cmd");
    const output = capture();
    const errors = capture();
    try {
      mkdirSync(wrapperDirectory);
      writeFileSync(wrapper, "@echo off\r\necho %~1\r\n");
      const status = await executeStructuredCommand(
        {
          repository,
          cwd: repository,
          stage: "test",
          reuse: false,
          timeoutSeconds: 10,
          command: wrapper,
          commandArgs: ["value-with-marks"]
        },
        { stdout: output.stream, stderr: errors.stream }
      );
      assert.equal(status, 0, errors.text());
      const evidenceDirectory = output
        .text()
        .match(/^Evidence: (.+)$/mu)?.[1];
      assert.match(
        readFileSync(join(evidenceDirectory, "stdout.log"), "utf8"),
        /value-with-marks/
      );
      await assert.rejects(
        executeStructuredCommand(
          {
            repository,
            cwd: repository,
            stage: "test",
            reuse: false,
            timeoutSeconds: 10,
            command: wrapper,
            commandArgs: ["value&unsafe"]
          },
          { stdout: capture().stream, stderr: capture().stream }
        ),
        /cannot contain shell metacharacters/
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
);
