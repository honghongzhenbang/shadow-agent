import path from "node:path";

export const DEFAULT_CODEX_THREAD_TITLE_CHARS = 160;
export const DEFAULT_CODEX_DIGEST_TITLE_CHARS = 200;

function sliceChars(value, maxChars) {
  const chars = Array.from(String(value ?? ""));
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd()}…`;
}

function compactTitleText(value) {
  return String(value ?? "")
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, " ")
    .replace(/\\+n/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function currentRequestText(value) {
  const source = String(value ?? "");
  const marker = "Current user request:";
  const index = source.lastIndexOf(marker);
  if (index < 0) return "";
  return source.slice(index + marker.length).trim();
}

function textAfterMarker(value, marker, options = {}) {
  const source = String(value ?? "");
  const index = options.first ? source.indexOf(marker) : source.lastIndexOf(marker);
  if (index < 0 || (options.maxMarkerOffset && index > options.maxMarkerOffset)) return "";
  const remainder = source.slice(index + marker.length);
  return remainder.split(/\r?\n|\\+n\s*-\s*\[[0-9a-f]+\s*@/i)[0].trim();
}

function firstMeaningfulLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => compactTitleText(line))
    .find((line) => line && !/^[-#*]+$/.test(line)) ?? "";
}

export function normalizeCodexThreadTitle(row, maxChars = DEFAULT_CODEX_THREAD_TITLE_CHARS) {
  const configuredMax = Math.max(40, Number(maxChars) || DEFAULT_CODEX_THREAD_TITLE_CHARS);
  const existingName = compactTitleText(row?.name);
  if (existingName && Array.from(existingName).length <= configuredMax) return existingName;

  const rawTitle = String(row?.title ?? row?.firstUserMessage ?? "");
  const request = currentRequestText(rawTitle) || currentRequestText(row?.firstUserMessage);
  let candidate = firstMeaningfulLine(request);

  if (!candidate) {
    candidate = compactTitleText(textAfterMarker(rawTitle, "任务：", { first: true, maxMarkerOffset: 4000 })
      || textAfterMarker(rawTitle, "任务:", { first: true, maxMarkerOffset: 4000 }));
  }
  if (!candidate) candidate = compactTitleText(textAfterMarker(rawTitle, "## My request for Codex:"));

  if (!candidate && /^你是一个持续工作的个人影子 Agent[。.]?/u.test(rawTitle)) {
    candidate = "Shadow Agent 主动巡检";
  }
  if (!candidate) candidate = firstMeaningfulLine(rawTitle);
  if (!candidate || /^OpenClaw assembled context for this turn:?$/i.test(candidate)) {
    candidate = `Shadow Agent 任务 ${String(row?.id ?? "unknown").slice(0, 8)}`;
  }
  return sliceChars(candidate, configuredMax);
}

export function codexDigestTitle(threadTitle, chunkIndex, maxChars = DEFAULT_CODEX_DIGEST_TITLE_CHARS) {
  const suffix = ` · 摘要 ${Number(chunkIndex) + 1}`;
  const configuredMax = Math.max(suffix.length + 24, Number(maxChars) || DEFAULT_CODEX_DIGEST_TITLE_CHARS);
  const base = normalizeCodexThreadTitle({ title: threadTitle }, configuredMax - Array.from(suffix).length);
  return sliceChars(`${base}${suffix}`, configuredMax);
}

function normalizedPath(value) {
  return path.resolve(String(value ?? "").replace(/^\\\\\?\\/, "")).toLowerCase();
}

export function isAgentGeneratedCodexThread(row, agentCwdRoots = []) {
  const title = String(row?.title ?? "");
  if (title.includes("Current user request:") || title.startsWith("OpenClaw assembled context for this turn:")) {
    return true;
  }
  const cwd = normalizedPath(row?.cwd);
  return agentCwdRoots.some((root) => {
    const normalizedRoot = normalizedPath(root);
    return cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}${path.sep}`);
  });
}
