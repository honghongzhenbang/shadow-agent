import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((child) => stableJson(child === undefined ? null : child)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function truncateText(value, maxChars = 16000) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export function truncateUtf8(value, maxBytes = 16000) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const suffix = `\n...[truncated ${text.length - middle} chars]`;
    if (Buffer.byteLength(text.slice(0, middle) + suffix, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const omitted = text.length - low;
  return `${text.slice(0, low)}\n...[truncated ${omitted} chars]`;
}

export function redactSecrets(value) {
  let text = String(value ?? "");
  const patterns = [
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
    [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_OPENAI_KEY]"],
    [/(app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key)([\"'\s:=]+)([^\s,}\"]+)/gi, "$1$2[REDACTED]"],
    [/([?&](?:token|access_token|refresh_token|code|signature|secret|api_key|password|authorization)=)[^&#\s]+/gi, "$1[REDACTED]"],
  ];
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
  return text;
}

export function safeEvidenceText(value, maxChars = 16000) {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncateText(redactSecrets(raw), maxChars);
}

export function safeTraceText(value, maxChars = 2600) {
  const raw = redactSecrets(typeof value === "string" ? value : JSON.stringify(value, null, 2))
    .replace(/\u0000/g, "")
    .trim();
  if (raw.length <= maxChars) return raw;
  const tailChars = Math.max(400, Math.floor(maxChars * 0.3));
  const headChars = Math.max(400, maxChars - tailChars);
  return `${raw.slice(0, headChars)}\n...[middle omitted; ${raw.length - maxChars} chars available at source locator]...\n${raw.slice(-tailChars)}`;
}

export function splitTextChunks(value, maxChars = 14000, overlapChars = 600) {
  const text = String(value ?? "").replace(/\u0000/g, "");
  if (!text) return [];
  if (text.length <= maxChars) return [{ index: 0, start: 0, end: text.length, text }];
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      const boundary = Math.max(paragraph, line);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    chunks.push({ index, start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
    index += 1;
  }
  return chunks;
}

export function isWithin(targetPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isBlockedPath(targetPath, blockedPaths) {
  const resolved = path.resolve(targetPath);
  return blockedPaths.some((blocked) => isWithin(resolved, blocked));
}

export function parseJsonLoose(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // Continue to object extraction.
      }
    }
    const first = source.indexOf("{");
    const last = source.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(source.slice(first, last + 1));
    throw new Error("Codex response did not contain valid JSON");
  }
}

export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

export function entrySearchSummary(entity) {
  let metadata;
  try { metadata = JSON.parse(entity.metadata_json || "{}"); } catch { metadata = {}; }
  const route = metadata.knowledgeEntry?.searchText;
  return route && route !== entity.summary ? `${entity.summary}\n${route}` : entity.summary;
}
