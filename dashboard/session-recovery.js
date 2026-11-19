import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalExecutionRepository, createExecutorLease } from "./executor-lease.js";
import { createSessionRegistry } from "./sessions.js";

function directoryPresent(path) {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Session recovery cannot inspect an untrusted reservation directory.");
    }
    return true;
  } catch (error) { if (error.code === "ENOENT") { return false; } throw error; }
}

export function sessionRecoveryContext(repository) {
  const root = realpathSync.native(resolve(repository));
  const scope = canonicalExecutionRepository(root);
  const identity = createHash("sha256").update(scope.repository).digest("hex");
  const registry = createSessionRegistry(identity);
  const scopeIds = [...new Set([createSessionRegistry(root).scopeId, registry.scopeId])];
  const testing = createExecutorLease(root, registry.id, { resource: "local-testing" }).scope.directory;
  return { repository: root, registry, scopeIds,
    reservations() {
      const directories = [scope.directory, testing];
      if (scope.directory === join(scope.repository, "fixlab", "executor-lease")) {
        const worktrees = join(scope.repository, "worktrees");
        if (directoryPresent(worktrees)) {
          const entries = readdirSync(worktrees, { withFileTypes: true });
          if (entries.length > 512) { throw new Error("Too many worktree reservation directories to verify."); }
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
              throw new Error("An untrusted worktree reservation directory requires manual inspection.");
            }
            directories.push(join(worktrees, entry.name, "fixlab", "executor-lease"));
            directories.push(join(worktrees, entry.name, "fixlab", "local-testing-lease"));
          }
        }
      }
      return directories.filter(path => directoryPresent(dirname(path)) && directoryPresent(path));
    }
  };
}

export async function reviewSessionRecovery(repository) {
  const context = sessionRecoveryContext(repository);
  const review = await context.registry.reviewRecovery(context.scopeIds);
  return { repository: context.repository, ...review, reservations: context.reservations(),
    confirmation: "Confirm the listed old dashboards and their child executors, tests, frontends and sign-in helpers have stopped. Recovery archives registrations only; it does not stop processes, clear reservations, grant permissions, resume jobs or validate results." };
}

export async function recoverRepositorySessions(repository, { reviewToken, confirmedQuiescent = false, confirmed = false } = {}) {
  if (confirmed !== true || confirmedQuiescent !== true) {
    throw new Error("Session recovery requires explicit approval and confirmation that the old owners' resources stopped.");
  }
  const context = sessionRecoveryContext(repository);
  const result = await context.registry.recoverReviewed(context.scopeIds, reviewToken, confirmedQuiescent, () => {
    if (context.reservations().length) {
      throw new Error("Repository execution/testing reservations remain. Verify their owners and termination; no reservation was cleared.");
    }
  });
  return { repository: context.repository, ...result,
    message: "Only reviewed registrations were archived. Jobs, permissions, reservations and validation outcomes are unchanged. Retry a job separately through its normal recovery controls." };
}

export async function runSessionRecoveryCommand(args) {
  const values = [...args];
  const repository = values[0] && !values[0].startsWith("--") ? values.shift() : ".";
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!["--review-token", "--confirm-quiescent", "--yes"].includes(key) || Object.hasOwn(options, key)) {
      throw new Error("Unsupported or repeated recover-sessions option.");
    }
    options[key] = key === "--review-token" ? values[++index] : true;
    if (options[key] === undefined || (key === "--review-token" && !/^[0-9a-f]{64}$/u.test(options[key]))) {
      throw new Error("recover-sessions requires a valid --review-token value.");
    }
  }
  if (Object.keys(options).length && (!options["--review-token"] || !options["--confirm-quiescent"] || !options["--yes"])) {
    throw new Error("Review first; recovery requires --review-token <value> --confirm-quiescent --yes.");
  }
  const result = options["--yes"]
    ? await recoverRepositorySessions(repository, { reviewToken: options["--review-token"],
      confirmedQuiescent: true, confirmed: true })
    : await reviewSessionRecovery(repository);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
