import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "// shadow-required-policy-v1";

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error("Unsupported runtime prompt boundary; refusing partial policy installation");
  return source.replace(from, to);
}

export function patchPolicyBoundary(source, kind, policyUrl) {
  const guard = {
    codex: "assertPolicyApplied(params.config, hookContext, shadowPromptResult.developerInstructions);",
    embedded: "assertPolicyApplied(params.config, params.hookCtx, promptBuildResult?.systemPrompt);",
  }[kind];
  if (!guard) throw new Error("Unknown prompt boundary");
  const importLine = `import { assertPolicyApplied } from ${JSON.stringify(policyUrl)};`;
  if (source.startsWith(marker)) {
    const lines = source.split("\n");
    if (!lines[1].startsWith("import { assertPolicyApplied } from ") || source.split(guard).length !== 2) {
      throw new Error("Invalid managed policy guard");
    }
    lines[1] = importLine;
    return lines.join("\n");
  }
  let result = source.replaceAll("\r\n", "\n");
  if (kind === "codex") {
    result = replaceOnce(result,
      "const buildPromptFromCurrentInputs = async () => {\n\t\treturn await resolveAgentHarnessBeforePromptBuildResult({",
      "const buildPromptFromCurrentInputs = async () => {\n\t\tconst shadowPromptResult = await resolveAgentHarnessBeforePromptBuildResult({");
    result = replaceOnce(result,
      "\t\t});\n\t};\n\tconst resolveShiftedPromptInputRange",
      "\t\t});\n\t\tassertPolicyApplied(params.config, hookContext, shadowPromptResult.developerInstructions);\n\t\treturn shadowPromptResult;\n\t};\n\tconst resolveShiftedPromptInputRange");
  } else if (kind === "embedded") {
    result = replaceOnce(result,
      "\treturn {\n\t\tsystemPrompt: promptBuildResult?.systemPrompt,",
      "\tassertPolicyApplied(params.config, params.hookCtx, promptBuildResult?.systemPrompt);\n\treturn {\n\t\tsystemPrompt: promptBuildResult?.systemPrompt,");
  } else throw new Error("Unknown prompt boundary");
  return `${marker}\n${importLine}\n${result}`;
}

export function applyShadowPolicyBoundary(root) {
  const dist = path.join(root, "tools/openclaw-runtime/node_modules/openclaw/dist");
  const version = JSON.parse(fs.readFileSync(path.join(dist, "../package.json"), "utf8")).version;
  if (version !== "2026.8.1") throw new Error("Shadow policy boundary requires revalidation for this OpenClaw version");
  const policyUrl = pathToFileURL(path.join(root, "openclaw/shadow-policy/policy.mjs")).href;
  const names = fs.readdirSync(dist);
  const edits = [
    { pattern: /^run-attempt-.*\.js$/, kind: "codex", anchor: "const buildPromptFromCurrentInputs = async () =>" },
    { pattern: /^attempt-prompt-helpers-.*\.js$/, kind: "embedded", anchor: "async function resolvePromptBuildHookResult(params)" },
  ].map(({ pattern, kind, anchor }) => {
    const matches = names.filter(name => pattern.test(name))
      .map(name => ({ file: path.join(dist, name), source: fs.readFileSync(path.join(dist, name), "utf8") }))
      .filter(item => item.source.includes(anchor));
    if (matches.length !== 1) throw new Error("Runtime policy boundary layout changed");
    const item = matches[0];
    const backup = `${item.file}.shadow-policy-original`;
    if (!item.source.startsWith(marker) && fs.existsSync(backup)
      && fs.readFileSync(backup, "utf8") !== item.source) {
      throw new Error("Pristine runtime backup does not match; revalidate the installed runtime before patching");
    }
    return { ...item, backup, patched: patchPolicyBoundary(item.source, kind, policyUrl) };
  });
  // Validate every target before changing any, then preserve one pristine runtime copy.
  for (const { file, source, patched, backup } of edits) {
    if (source === patched) continue;
    if (!source.startsWith(marker) && !fs.existsSync(backup)) fs.writeFileSync(backup, source, { flag: "wx" });
    fs.writeFileSync(file, patched, "utf8");
  }
  return { version, boundary: marker.slice(3), files: edits.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(applyShadowPolicyBoundary(path.resolve(process.argv[2] ?? "."))));
}
