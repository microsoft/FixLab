import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_SCREENSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
const azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798";
const imageTypes = new Map([
  ["image/png", new Set([".png"])],
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/webp", new Set([".webp"])]
]);
const imageMimeTypesByExtension = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

function runGit(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function extension(name) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function hasValidSignature(buffer, mimeType) {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (mimeType === "image/jpeg") {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9
    );
  }
  if (mimeType === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("screenshot data must be valid base64");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    throw new Error("screenshot data must be canonical base64");
  }
  return buffer;
}

export function resolveArtifactRoot(repository) {
  const commonGitDirectory = runGit(repository, [
    "rev-parse",
    "--git-common-dir"
  ]);
  if (commonGitDirectory) {
    const gitDirectoryPath = isAbsolute(commonGitDirectory)
      ? commonGitDirectory
      : resolve(repository, commonGitDirectory);
    return join(
      realpathSync.native(gitDirectoryPath),
      "fixlab",
      "dashboard-artifacts"
    );
  }
  const identity = createHash("sha256")
    .update(resolve(repository))
    .digest("hex")
    .slice(0, 20);
  return join(tmpdir(), "fixlab-dashboard-artifacts", identity);
}

export function storeScreenshots({ repository, jobId, screenshots = [] }) {
  if (!Array.isArray(screenshots)) {
    throw new Error("screenshots must be an array");
  }
  if (screenshots.length > MAX_SCREENSHOTS) {
    throw new Error(`at most ${MAX_SCREENSHOTS} screenshots are allowed`);
  }
  if (screenshots.length === 0) {
    return { directory: null, files: [] };
  }

  const prepared = [];
  let totalBytes = 0;
  for (const screenshot of screenshots) {
    if (!screenshot || typeof screenshot !== "object") {
      throw new Error("each screenshot must be an object");
    }
    const name =
      typeof screenshot.name === "string" ? screenshot.name.trim() : "";
    if (
      !name ||
      name !== basename(name) ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..")
    ) {
      throw new Error("screenshot names must not contain paths or traversal");
    }
    const mimeType =
      typeof screenshot.mimeType === "string"
        ? screenshot.mimeType.toLowerCase()
        : "";
    const allowedExtensions = imageTypes.get(mimeType);
    if (!allowedExtensions || !allowedExtensions.has(extension(name))) {
      throw new Error(
        "screenshots must be PNG, JPEG, or WebP with a matching extension"
      );
    }
    const buffer = decodeBase64(screenshot.base64);
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      throw new Error(
        `each screenshot must be at most ${MAX_SCREENSHOT_BYTES} bytes`
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new Error(
        `screenshots must total at most ${MAX_SCREENSHOT_TOTAL_BYTES} bytes`
      );
    }
    if (!hasValidSignature(buffer, mimeType)) {
      throw new Error("screenshot content does not match its declared type");
    }
    prepared.push({ name, mimeType, buffer, extension: extension(name) });
  }

  const artifactRoot = resolveArtifactRoot(repository);
  const directory = join(artifactRoot, jobId);
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  try {
    const files = prepared.map((screenshot, index) => {
      const generatedName = `${String(index + 1).padStart(2, "0")}-${randomBytes(
        8
      ).toString("hex")}${screenshot.extension}`;
      const path = join(directory, generatedName);
      writeFileSync(path, screenshot.buffer, { flag: "wx", mode: 0o600 });
      return {
        name: screenshot.name,
        mimeType: screenshot.mimeType,
        bytes: screenshot.buffer.length,
        path
      };
    });
    return { directory, files };
  } catch (error) {
    removeArtifactDirectory(directory);
    throw error;
  }
}

export function removeArtifactDirectory(directory) {
  if (directory && existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function pruneArtifactDirectories(
  repository,
  maxAgeMilliseconds = 7 * 24 * 60 * 60 * 1000
) {
  const artifactRoot = resolveArtifactRoot(repository);
  if (!existsSync(artifactRoot)) {
    return;
  }
  const cutoff = Date.now() - maxAgeMilliseconds;
  for (const name of readdirSync(artifactRoot)) {
    if (!/^\d{10,}-[a-f0-9]+$/i.test(name)) {
      continue;
    }
    const directory = join(artifactRoot, name);
    try {
      const details = lstatSync(directory);
      if (
        details.isDirectory() &&
        !details.isSymbolicLink() &&
        details.mtimeMs < cutoff
      ) {
        removeArtifactDirectory(directory);
      }
    } catch {
      // A concurrent cleanup may already have removed the directory.
    }
  }
}

export function parseAzureDevOpsWorkItem(value, profile = {}) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) {
    throw new Error("Azure DevOps work item URL or ID is required");
  }

  if (/^\d+$/.test(input)) {
    const organization = profile.azureDevOps?.organization;
    const project = profile.azureDevOps?.project;
    if (
      typeof organization !== "string" ||
      !organization.trim() ||
      typeof project !== "string" ||
      !project.trim()
    ) {
      throw new Error(
        "ID-only lookup requires azureDevOps.organization and azureDevOps.project in the repository profile"
      );
    }
    const id = Number(input);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("work item ID must be a positive safe integer");
    }
    return {
      organization: organization.trim(),
      project: project.trim(),
      id
    };
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("work item must be a numeric ID or full dev.azure.com URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "dev.azure.com") {
    throw new Error("work item URL must use https://dev.azure.com");
  }
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const editIndex = segments.findIndex(
    (segment, index) =>
      segment.toLowerCase() === "_workitems" &&
      segments[index + 1]?.toLowerCase() === "edit"
  );
  const id = editIndex >= 0 ? segments[editIndex + 2] : null;
  if (
    segments.length < 5 ||
    editIndex !== 2 ||
    !/^\d+$/.test(id ?? "")
  ) {
    throw new Error(
      "work item URL must match https://dev.azure.com/{organization}/{project}/_workitems/edit/{id}"
    );
  }
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) {
    throw new Error("work item ID must be a positive safe integer");
  }
  return {
    organization: segments[0],
    project: segments[1],
    id: numericId
  };
}

export function sanitizeAzureDevOpsHtml(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function azureDevOpsCommentFingerprint(text) {
  return createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");
}

export function formatAzureDevOpsComment(text) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return escaped.split("\n\n").map(block => {
    const [heading, ...lines] = block.split("\n");
    if (heading.startsWith("## ") && lines.length && lines.every(line => line.startsWith("- "))) {
      return `<h3>${heading.slice(3)}</h3><ul>${lines.map(line => `<li>${line.slice(2)}</li>`).join("")}</ul>`;
    }
    return block.replaceAll("\n", "<br>");
  }).join("<br><br>");
}

function workItemText(value, maximumLength) {
  return sanitizeAzureDevOpsHtml(value).slice(0, maximumLength);
}

function defaultTokenProvider() {
  const result = spawnSync(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      azureDevOpsResource,
      "--query",
      "accessToken",
      "--output",
      "tsv"
    ],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true
    }
  );
  const token = result.status === 0 ? result.stdout.trim() : "";
  if (!token) {
    throw new Error(
      "Azure CLI authentication is unavailable. Install Azure CLI and run az login with access to the requested Azure DevOps organization."
    );
  }
  return token;
}

function defaultRequestJson(url, token, { method = "GET", body, contentType = "application/json" } = {}) {
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 64 * 1024) {
      reject(new Error("Azure DevOps request exceeded 64 KiB"));
      return;
    }
    const request = httpsRequest(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 2 * 1024 * 1024) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          if (size > 2 * 1024 * 1024) {
            reject(new Error("Azure DevOps response exceeded 2 MiB"));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Azure DevOps returned HTTP ${response.statusCode}. Verify the work item and your access.`
              )
            );
            return;
          }
          try {
            resolveRequest(JSON.parse(text));
          } catch {
            reject(new Error("Azure DevOps returned invalid JSON"));
          }
        });
      }
    );
    request.setTimeout(15000, () => {
      request.destroy(new Error("Azure DevOps request timed out"));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function defaultRequestBuffer(url, token) {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "image/png,image/jpeg,image/webp",
          Authorization: `Bearer ${token}`
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_SCREENSHOT_BYTES) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Azure DevOps image returned HTTP ${response.statusCode}`
              )
            );
            return;
          }
          if (size > MAX_SCREENSHOT_BYTES) {
            reject(
              new Error(
                `Azure DevOps image exceeded ${MAX_SCREENSHOT_BYTES} bytes`
              )
            );
            return;
          }
          resolveRequest({
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers["content-type"] ?? "")
              .split(";")[0]
              .trim()
              .toLowerCase()
          });
        });
      }
    );
    request.setTimeout(15000, () => {
      request.destroy(new Error("Azure DevOps image request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function embeddedImageUrls(values) {
  const urls = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const pattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
    for (const match of value.matchAll(pattern)) {
      const source = (match[1] ?? match[2] ?? "").replace(/&amp;/gi, "&");
      try {
        const url = new URL(source);
        if (
          url.protocol === "https:" &&
          url.hostname.toLowerCase() === "dev.azure.com" &&
          /\/_apis\/wit\/attachments\//i.test(url.pathname)
        ) {
          urls.push(url.toString());
        }
      } catch {
        // Ignore non-URL and relative image sources.
      }
    }
  }
  return urls;
}

function imageCandidates(item, fields, comments) {
  const candidates = [];
  for (const relation of item?.relations ?? []) {
    const name =
      typeof relation?.attributes?.name === "string"
        ? relation.attributes.name
        : "";
    if (
      relation?.rel === "AttachedFile" &&
      typeof relation.url === "string" &&
      imageMimeTypesByExtension.has(extension(name))
    ) {
      candidates.push({ url: relation.url, name });
    }
  }
  for (const url of embeddedImageUrls([
    fields["System.Description"],
    fields["Microsoft.VSTS.TCM.ReproSteps"],
    fields["Microsoft.VSTS.Common.AcceptanceCriteria"],
    ...comments.map((comment) => comment?.text)
  ])) {
    const parsed = new URL(url);
    candidates.push({
      url,
      name: parsed.searchParams.get("fileName") ?? ""
    });
  }
  return [
    ...new Map(
      candidates
        .filter(({ url }) => {
          try {
            const parsed = new URL(url);
            return (
              parsed.protocol === "https:" &&
              parsed.hostname.toLowerCase() === "dev.azure.com"
            );
          } catch {
            return false;
          }
        })
        .map((candidate) => [candidate.url, candidate])
    ).values()
  ];
}

function downloadedImageName(workItemId, candidate, mimeType, index) {
  const candidateName = basename(candidate.name || "");
  const candidateExtension = extension(candidateName);
  if (
    candidateName &&
    imageMimeTypesByExtension.get(candidateExtension) === mimeType
  ) {
    return `${workItemId}-${candidateName}`;
  }
  const generatedExtension = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp"
  }[mimeType];
  return `${workItemId}-azure-image-${index + 1}${generatedExtension}`;
}

export function createAzureDevOpsLoader({
  tokenProvider = defaultTokenProvider,
  requestJson = defaultRequestJson,
  requestBuffer = defaultRequestBuffer
} = {}) {
  async function loadTarget(target, token) {
    const apiUrl =
      `https://dev.azure.com/${encodeURIComponent(target.organization)}/` +
      `${encodeURIComponent(target.project)}/_apis/wit/workitems/` +
      `${target.id}?$expand=all&api-version=7.1`;
    const commentsUrl =
      `https://dev.azure.com/${encodeURIComponent(target.organization)}/` +
      `${encodeURIComponent(target.project)}/_apis/wit/workItems/` +
      `${target.id}/comments?$top=20&order=desc&api-version=7.1-preview.4`;
    const [item, commentResult] = await Promise.all([
      requestJson(apiUrl, token),
      requestJson(commentsUrl, token).then(
        (response) => ({ response, warning: "" }),
        () => ({
          response: { comments: [] },
          warning:
            "Azure DevOps comments could not be loaded. Verify comment access and retry if comments are required."
        })
      )
    ]);
    const commentResponse = commentResult.response;
    const fields = item?.fields ?? {};
    const fallbackWebUrl =
      `https://dev.azure.com/${encodeURIComponent(target.organization)}/` +
      `${encodeURIComponent(target.project)}/_workitems/edit/${target.id}`;
    const linkedWebUrl = item?._links?.html?.href;
    const webUrl =
      typeof linkedWebUrl === "string" &&
      /^https:\/\/dev\.azure\.com\//i.test(linkedWebUrl)
        ? linkedWebUrl
        : fallbackWebUrl;
    return {
      id: Number(fields["System.Id"] ?? item.id ?? target.id),
      revision: Number.isSafeInteger(item.rev) && item.rev > 0 ? item.rev : null,
      title: workItemText(fields["System.Title"], 500),
      description: workItemText(fields["System.Description"], 10000),
      reproduction: workItemText(
        fields["Microsoft.VSTS.TCM.ReproSteps"],
        10000
      ),
      acceptanceCriteria: workItemText(
        fields["Microsoft.VSTS.Common.AcceptanceCriteria"],
        10000
      ),
      state: workItemText(fields["System.State"], 200),
      workItemType: workItemText(fields["System.WorkItemType"], 200),
      project: workItemText(fields["System.TeamProject"], 200),
      areaPath: workItemText(fields["System.AreaPath"], 1000),
      tags: workItemText(fields["System.Tags"], 2000),
      comments: (commentResponse?.comments ?? [])
        .filter((comment) => !comment?.isDeleted)
        .slice(0, 20)
        .map((comment) => ({
          ...(Number.isSafeInteger(comment.id) ? { id: comment.id } : {}),
          author: workItemText(comment?.createdBy?.displayName, 200),
          createdAt:
            typeof comment?.createdDate === "string"
              ? comment.createdDate.slice(0, 100)
              : "",
          text: workItemText(comment?.text, 2000),
          contentFingerprint: azureDevOpsCommentFingerprint(sanitizeAzureDevOpsHtml(comment?.text))
        }))
        .filter((comment) => comment.text),
      commentsWarning: commentResult.warning,
      imageCandidates: imageCandidates(
        item,
        fields,
        commentResponse?.comments ?? []
      ),
      webUrl
    };
  }

  async function loadImages(items, token) {
    let totalBytes = 0;
    let count = 0;
    for (const item of items) {
      item.screenshots = [];
      item.imagesWarning = "";
      for (const candidate of item.imageCandidates) {
        if (count >= MAX_SCREENSHOTS) {
          item.imagesWarning =
            "Additional Azure DevOps images were omitted by the five-image limit.";
          break;
        }
        try {
          const downloaded = await requestBuffer(candidate.url, token);
          const mimeType =
            imageTypes.has(downloaded.contentType)
              ? downloaded.contentType
              : imageMimeTypesByExtension.get(extension(candidate.name));
          if (
            !mimeType ||
            !hasValidSignature(downloaded.buffer, mimeType)
          ) {
            throw new Error("unsupported Azure DevOps image content");
          }
          if (
            totalBytes + downloaded.buffer.length >
            MAX_SCREENSHOT_TOTAL_BYTES
          ) {
            item.imagesWarning =
              "Additional Azure DevOps images were omitted by the total-size limit.";
            break;
          }
          item.screenshots.push({
            name: downloadedImageName(
              item.id,
              candidate,
              mimeType,
              count
            ),
            mimeType,
            base64: downloaded.buffer.toString("base64")
          });
          totalBytes += downloaded.buffer.length;
          count += 1;
        } catch {
          item.imagesWarning =
            "One or more Azure DevOps images could not be loaded.";
        }
      }
      delete item.imageCandidates;
    }
  }

  async function withToken(targets, includeImages = true) {
    let token;
    try {
      token = await tokenProvider();
      const items = await Promise.all(
        targets.map((target) => loadTarget(target, token))
      );
      if (includeImages) {
        await loadImages(items, token);
      } else {
        for (const item of items) {
          delete item.imageCandidates;
        }
      }
      return items;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (token && message.includes(token)) {
        throw new Error(message.split(token).join("[REDACTED]"));
      }
      throw new Error(message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"));
    } finally {
      token = null;
    }
  }

  const loader = async ({ workItem, profile, includeImages = true }) => {
    const [result] = await withToken([
      parseAzureDevOpsWorkItem(workItem, profile)
    ], includeImages);
    return result;
  };
  loader.loadMany = async ({ workItems, profile }) => {
    const targets = workItems.map((workItem) =>
      parseAzureDevOpsWorkItem(workItem, profile)
    );
    return withToken(targets);
  };
  return loader;
}

export function loadRepositoryProfile(repository) {
  return JSON.parse(
    readFileSync(
      join(repository, ".github", "fixlab", "repository-profile.json"),
      "utf8"
    )
  );
}

export function createAzureDevOpsTicketClient({
  profile, tokenProvider = defaultTokenProvider, requestJson = defaultRequestJson
}) {
  const target = parseAzureDevOpsWorkItem("1", profile);
  const base = `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(target.project)}/_apis`;
  const loader = createAzureDevOpsLoader({ tokenProvider, requestJson });
  async function request(path, options) {
    let token;
    try {
      token = await tokenProvider();
      return await requestJson(`${base}/${path}`, token, options);
    } catch (error) {
      const message = String(error?.message ?? error);
      throw new Error((token ? message.split(token).join("[REDACTED]") : message)
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"));
    } finally {
      token = null;
    }
  }
  function workItemId(id) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("work item ID must be a positive safe integer");
    }
    return id;
  }
  async function commentIds(id, marker) {
    if (typeof marker !== "string" || marker.length > 200 ||
        (!marker.startsWith("[FixLab automation ") && !/^[a-f0-9]{64}$/u.test(marker))) {
      throw new Error("An exact feedback fingerprint or legacy automation marker is required.");
    }
    let continuation;
    const matches = [];
    for (let page = 0; page < 10; page += 1) {
      const result = await request(`wit/workItems/${workItemId(id)}/comments?$top=100&order=desc&api-version=7.1-preview.4${continuation ? `&continuationToken=${encodeURIComponent(continuation)}` : ""}`);
      if (!Array.isArray(result?.comments) || result.comments.length > 100) {
        throw new Error("Azure DevOps returned an invalid comment collection.");
      }
      for (const comment of result.comments) {
        const text = sanitizeAzureDevOpsHtml(comment.text);
        if (!comment.isDeleted && (marker.startsWith("[FixLab automation ")
          ? text.startsWith(marker) : azureDevOpsCommentFingerprint(text) === marker)) {
          if (!Number.isSafeInteger(comment.id) || comment.id < 1) {
            throw new Error("Azure DevOps returned an invalid feedback comment ID.");
          }
          matches.push(comment.id);
        }
      }
      continuation = result.continuationToken;
      if (!continuation) { return [...new Set(matches)]; }
      if (typeof continuation !== "string" || continuation.length > 500) {
        throw new Error("Azure DevOps returned an invalid comments continuation token.");
      }
    }
    throw new Error("Existing feedback could not be fully checked; no duplicate comment was posted.");
  }
  return {
    async findTagged(tag, areaPaths) {
      if (typeof tag !== "string" || !tag.trim() || tag.length > 100 || /[\r\n;]/u.test(tag)) {
        throw new Error("Automation requires one bounded work-item tag.");
      }
      if (!Array.isArray(areaPaths) || areaPaths.length === 0 || areaPaths.length > 8 ||
          areaPaths.some(path => typeof path !== "string" || !path.trim() || path.length > 1000 || /[\r\n]/u.test(path))) {
        throw new Error("Automation requires explicitly reviewed Azure DevOps area paths.");
      }
      const quote = value => value.replaceAll("'", "''");
      const result = await request("wit/wiql?$top=21&api-version=7.1", {
        method: "POST",
        body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${quote(target.project)}' AND [System.AssignedTo] = @Me AND (${areaPaths.map(path => `[System.AreaPath] UNDER '${quote(path)}'`).join(" OR ")}) AND [System.Tags] CONTAINS '${quote(tag)}' AND [System.WorkItemType] IN ('Bug', 'User Story', 'Feature', 'Product Backlog Item') AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ORDER BY [System.ChangedDate] DESC` }
      });
      if (!Array.isArray(result?.workItems) || result.workItems.length > 20) {
        throw new Error("Ticket automation requires at most 20 eligible items; narrow the configured tag before continuing.");
      }
      return [...new Set(result.workItems.map(item => workItemId(item.id)))];
    },
    async load(id) {
      const item = await loader({ workItem: String(workItemId(id)), profile, includeImages: false });
      if (item.id !== id || item.project.toLowerCase() !== target.project.toLowerCase()) {
        throw new Error("The returned work item identity or project does not match the requested scope.");
      }
      if (item.commentsWarning) {
        throw new Error(item.commentsWarning);
      }
      const assignment = await request("wit/wiql?$top=2&api-version=7.1", {
        method: "POST",
        body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${target.project.replaceAll("'", "''")}' AND [System.Id] = ${id} AND [System.AssignedTo] = @Me` }
      });
      if (!Array.isArray(assignment?.workItems) || assignment.workItems.length > 1 ||
          assignment.workItems.some(value => value.id !== id)) {
        throw new Error("Azure DevOps did not verify the exact work item's current-user assignment.");
      }
      item.assignedToCurrentUser = assignment.workItems.length === 1;
      delete item.screenshots;
      return item;
    },
    commentIds,
    async hasComment(id, marker) { return (await commentIds(id, marker)).length > 0; },
    async comment(id, text) {
      if (typeof text !== "string" || !text.trim() || text.length > 10000) {
        throw new Error("Ticket feedback requires bounded nonempty text.");
      }
      return request(`wit/workItems/${workItemId(id)}/comments?format=html&api-version=7.1-preview.4`, {
        method: "POST", body: { text: formatAzureDevOpsComment(text) }
      });
    },
    async resolve(id, revision, workItemType) {
      workItemId(id);
      if (!Number.isSafeInteger(revision) || revision < 1 ||
          !["Bug", "User Story", "Feature", "Product Backlog Item"].includes(workItemType)) {
        throw new Error("Resolution requires a fresh work-item revision and supported type.");
      }
      const states = await request(`wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=7.1`);
      if (!Array.isArray(states?.value) || !states.value.some(state => state.name === "Resolved")) {
        throw new Error("This work-item workflow does not support Resolved. Its owner must review the state.");
      }
      const result = await request(`wit/workitems/${id}?api-version=7.1`, {
        method: "PATCH", contentType: "application/json-patch+json",
        body: [
          { op: "test", path: "/rev", value: revision },
          { op: "add", path: "/fields/System.State", value: "Resolved" }
        ]
      });
      if (result?.id !== id || !Number.isSafeInteger(result.rev) || result.rev <= revision ||
          result.fields?.["System.State"] !== "Resolved" ||
          result.fields?.["System.TeamProject"]?.toLowerCase() !== target.project.toLowerCase()) {
        throw new Error("Azure DevOps did not verify the requested Resolved state.");
      }
      return result.rev;
    },
    async loadTitles(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 20) {
        throw new Error("Title lookup requires 1–20 work-item IDs.");
      }
      ids.forEach(workItemId);
      const result = await request(`wit/workitems?ids=${ids.join(",")}&fields=System.Title,System.TeamProject&api-version=7.1`);
      if (!Array.isArray(result?.value) || result.value.length !== ids.length ||
          new Set(result.value.map(item => item.id)).size !== ids.length ||
          result.value.some(item => !ids.includes(item.id) ||
            item.fields?.["System.TeamProject"]?.toLowerCase() !== target.project.toLowerCase() ||
            typeof item.fields?.["System.Title"] !== "string" || !item.fields["System.Title"].trim() ||
            item.fields["System.Title"].length > 1000)) {
        throw new Error("ADO did not return the exact recorded work-item titles in this project.");
      }
      return Object.fromEntries(result.value.map(item => [item.id, item.fields["System.Title"]]));
    },
    async reviewPullRequests(repository, ticketId) {
      workItemId(ticketId);
      if (typeof repository !== "string" || !repository.trim() || repository.length > 200) {
        throw new Error("Recovery requires the configured repository.");
      }
      const item = await request(`wit/workitems/${ticketId}?$expand=relations&api-version=7.1`);
      if (item?.id !== ticketId || item.fields?.["System.TeamProject"]?.toLowerCase() !== target.project.toLowerCase() ||
          (item.relations !== undefined && !Array.isArray(item.relations))) {
        throw new Error("Linked PR recovery requires the exact work-item identity and project.");
      }
      const links = (item.relations ?? []).filter(relation =>
        relation.rel === "ArtifactLink" && typeof relation.url === "string" &&
        relation.url.startsWith("vstfs:///Git/PullRequestId/"));
      if (links.length > 20) { throw new Error("Too many linked PRs for bounded recovery; review the work item first."); }
      const results = [];
      for (const link of links) {
        const parts = decodeURIComponent(link.url.slice("vstfs:///Git/PullRequestId/".length)).split("/");
        if (parts.length !== 3 || !/^[1-9]\d{0,14}$/u.test(parts[2])) {
          throw new Error("A linked PR has an invalid artifact identity; recovery remains blocked.");
        }
        const id = Number(parts[2]);
        const pr = await request(`git/repositories/${encodeURIComponent(repository)}/pullrequests/${id}?api-version=7.1`);
        if (pr?.pullRequestId !== id ||
            !["active", "completed", "abandoned"].includes(pr.status) ||
            ![pr.repository?.id, pr.repository?.name].some(value =>
              typeof value === "string" && value.toLowerCase() === repository.toLowerCase()) ||
            pr.repository?.id?.toLowerCase() !== parts[1].toLowerCase()) {
          throw new Error("A linked PR could not be verified in the reviewed repository; inspect its work-item link.");
        }
        results.push({
          id, status: pr.status, isDraft: pr.isDraft === true,
          webUrl: `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`
        });
      }
      return results;
    },
    async verifyDraft(repository, id, targetBranch, ticketId) {
      const expectedTicketId = workItemId(ticketId);
      if (typeof repository !== "string" || !repository.trim() || repository.length > 200 ||
          !Number.isSafeInteger(id) || id < 1) {
        throw new Error("A configured repository and positive pull-request ID are required.");
      }
      const pr = await request(`git/repositories/${encodeURIComponent(repository)}/pullrequests/${id}?api-version=7.1`);
      if (pr?.isDraft !== true || pr.status !== "active" ||
          pr.targetRefName !== `refs/heads/${targetBranch}` ||
          ![pr.repository?.id, pr.repository?.name].some(value =>
            typeof value === "string" && value.toLowerCase() === repository.toLowerCase())) {
        throw new Error("The provider did not verify an active draft PR in the approved repository and target branch.");
      }
      const links = await request(`git/repositories/${encodeURIComponent(repository)}/pullrequests/${id}/workitems?api-version=7.1`);
      if (!Array.isArray(links?.value) || !links.value.some(item => String(item.id) === String(expectedTicketId))) {
        throw new Error("The draft PR is not linked to the authorized work item.");
      }
      return `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;
    }
  };
}
