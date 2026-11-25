import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { safeRuntimeText } from "./runtime-requests.js";

const hash = value => createHash("sha256").update(value).digest("hex");
function requireValue(condition) {
  if (!condition) { throw new Error("Error-message preview requires fresh, exact, single-record approval."); }
}

export function errorPreviewTimestampKey(value) {
  const match = typeof value === "string" && value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?Z$/u);
  if (!match || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 19) !== match[1]) { return null; }
  return `${match[1]}.${(match[2] ?? "").padEnd(7, "0")}Z`;
}

export function readErrorPreviewApproval(path) {
  requireValue(typeof path === "string" && isAbsolute(path) && !path.startsWith("\\\\"));
  const file = resolve(path);
  const same = value => process.platform === "win32" ? value.toLowerCase() : value;
  requireValue(same(realpathSync(file)) === same(file));
  const info = lstatSync(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8192);
  const bytes = readFileSync(file);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Error-message preview approval is not valid JSON."); }
  return { file, value, fingerprint: hash(bytes) };
}

export function validateErrorPreviewApproval(approval, plan, profile) {
  requireValue(approval && typeof approval === "object" && !Array.isArray(approval) &&
    Object.keys(approval).length === 9 &&
    ["version", "workItemId", "source", "planHash", "policyRevision", "profileHash",
      "timestamp", "expiresAt", "maxCharacters"].every(key => Object.hasOwn(approval, key)));
  const now = Date.now();
  const expires = Date.parse(approval.expiresAt);
  const timestamp = errorPreviewTimestampKey(approval.timestamp);
  requireValue(approval.version === 1 && approval.workItemId === plan.workItemId &&
    approval.source === plan.source && approval.planHash === hash(JSON.stringify(plan)) &&
    approval.policyRevision === plan.policyRevision && approval.profileHash === hash(JSON.stringify(profile)) &&
    approval.maxCharacters === 200 && timestamp !== null &&
    timestamp >= errorPreviewTimestampKey(plan.start) && timestamp <= errorPreviewTimestampKey(plan.end) &&
    typeof approval.expiresAt === "string" && Number.isFinite(expires) &&
    new Date(expires).toISOString() === approval.expiresAt && expires > now && expires - now <= 30 * 60000 &&
    plan.table === "traces" && plan.limit === 1 &&
    plan.filter && Object.keys(plan.filter).length === 3 &&
    plan.filter.field === "operation_Id" && plan.filter.op === "eq" &&
    typeof plan.filter.value === "string" && /^[A-Za-z0-9_.:|+/=-]{1,160}$/u.test(plan.filter.value));
  return { timestamp: approval.timestamp, maxCharacters: 200, expiresAt: approval.expiresAt };
}

export function claimErrorPreviewApproval(record) {
  const current = readErrorPreviewApproval(record.file);
  requireValue(current.fingerprint === record.fingerprint);
  writeFileSync(`${record.file}.used`, JSON.stringify({
    approvalHash: record.fingerprint, claimedAt: new Date().toISOString()
  }) + "\n", { flag: "wx", mode: 0o600 });
}

function redactQuotedValues(value) {
  let result = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (escaped) { escaped = false; }
      else if (character === "\\") { escaped = true; }
      else if (character === quote) { quote = ""; result += "(value omitted)"; }
    } else if (["\"", "'", "`"].includes(character) &&
        !(character === "'" && /[A-Za-z]/u.test(value[index - 1] ?? "") && /[A-Za-z]/u.test(value[index + 1] ?? ""))) {
      quote = character;
    } else { result += character; }
  }
  return quote ? null : result;
}

export function sanitizeErrorPreview(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 16384 ||
      /[^\x09\x0a\x0d\x20-\x7e]/u.test(value)) {
    return { message: null, reason: "unsafe-or-payload" };
  }
  const withoutUrls = value.replace(/https?:\/\/[^\s)]+/giu, "");
  if (/[{}[\]<>]|(?:^|\n)\s*at\s+\S+/iu.test(value) ||
      /(?:payload|request\s*body|response\s*body|authorization|cookie|password|secret|token|connectionstring|accountkey|api[-_ ]?key)\s*[:=]/iu.test(withoutUrls) ||
      /-----BEGIN|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(value)) {
    return { message: null, reason: "unsafe-or-payload" };
  }
  const firstLine = value.split(/\r?\n/u)[0].trim();
  const quoted = redactQuotedValues(firstLine);
  if (quoted === null) { return { message: null, reason: "unsafe-quoted-value" }; }
  let message = quoted
    .replace(/https?:\/\/[^\s)]+/giu, "(URL omitted)")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "(identity omitted)")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|local|internal|corp)\b/giu, "(host omitted)")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;]+|(?:\/[A-Za-z0-9._-]+){2,}/gu, "(path omitted)")
    .replace(/\b(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{24,})\b/giu, "(ID omitted)")
    .replace(/\b(?:user(?:name)?|account|customer|owner|locked by|requested by)\s*[:=]?\s+\S+(?:\s+[A-Z][a-z]+)?/giu, "(identity omitted)")
    .replace(/\b[A-Z][a-z]+(?:[ -][A-Z][a-z]+)+\b/gu, phrase =>
      ["Bad Request", "Internal Server Error", "Not Found", "Service Unavailable", "Access Denied", "Object Reference"].includes(phrase)
        ? phrase : "(identity omitted)")
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{4,}\b/gu, "(ID omitted)")
    .replace(/\b\d+\b/gu, (number, offset, input) =>
      /^[45]\d\d$/u.test(number) && /(?:HTTP\s*|status(?:\s+code)?\s*[:=]?\s*)$/iu.test(input.slice(0, offset))
        ? number : "(number omitted)")
    .replace(/[A-Za-z0-9_+/=-]{40,}/gu, "(value omitted)")
    .replace(/\s+/gu, " ").trim();
  if (!message || !safeRuntimeText(message, 16384) || /[?&]\S+=|bearer\s|basic\s/iu.test(message)) {
    return { message: null, reason: "unsafe-remnant" };
  }
  const truncated = message.length > 200;
  if (truncated) { message = `${message.slice(0, 197).replace(/\s+\S*$/u, "")}...`; }
  return { message, redacted: message !== value.trim(), truncated };
}
