import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function checkDestination(repository, destination) {
  let current = repository;
  for (const part of relative(repository, destination).split(/[/\\]/u)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("Notification extension paths must not contain symbolic links or junctions.");
    }
  }
}

export function installNotifications(repository, packageRoot, yes = false) {
  let root = realpathSync(repository);
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root, encoding: "utf8", windowsHide: true
  });
  if (git.status === 0) {
    root = realpathSync(git.stdout.trim());
  } else {
    throw new Error("Install the Copilot notification extension from a Git repository.");
  }
  const directory = join(root, ".github", "extensions", "fixlab-notifications");
  const destination = join(directory, "extension.mjs");
  const entry = pathToFileURL(resolve(packageRoot, "mcp", "notification-extension.js")).href;
  const content = [
    'import { joinSession } from "@microsoft/copilot-sdk/extension";',
    `import { attachNotifications } from ${JSON.stringify(entry)};`,
    "await attachNotifications(joinSession);",
    ""
  ].join("\n");
  checkDestination(root, destination);
  if (existsSync(destination)) {
    if (readFileSync(destination, "utf8") !== content) {
      throw new Error("A different fixlab-notifications extension already exists. Review it before replacing it; nothing was overwritten.");
    }
    return { status: "already-installed", destination };
  }
  if (!yes) {
    return {
      status: "planned",
      destination,
      message: "Rerun with --yes to install trusted local extension code. Reload Copilot extensions afterward. Installation does not start a watcher; explicit consent is required before event-triggered model turns."
    };
  }
  mkdirSync(directory, { recursive: true });
  checkDestination(root, destination);
  writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
  return {
    status: "installed",
    destination,
    message: "Reload Copilot extensions, read dashboard status, then explicitly start notifications for its current instance/job. Keep this machine-specific loader untracked; it references this FixLab installation."
  };
}
