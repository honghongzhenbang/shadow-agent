import { publicSourceAdapter, sourceAdapterMetadata } from "./contracts.mjs";
import { codexCanonicalSourceRecord, codexSourceAdapter } from "./providers/codex.mjs";
import { feishuCanonicalSourceRecord, feishuSourceAdapter } from "./providers/feishu.mjs";
import { voiceCanonicalSourceRecord, voiceSourceAdapter } from "./providers/voice.mjs";

const REGISTRY = new Map([
  [codexSourceAdapter.provider, { adapter: codexSourceAdapter, canonicalize: codexCanonicalSourceRecord }],
  [feishuSourceAdapter.provider, { adapter: feishuSourceAdapter, canonicalize: feishuCanonicalSourceRecord }],
  [voiceSourceAdapter.provider, { adapter: voiceSourceAdapter, canonicalize: voiceCanonicalSourceRecord }],
]);

export function getSourceAdapter(provider) {
  const entry = REGISTRY.get(String(provider ?? "").trim());
  if (!entry) throw new Error(`Unknown source adapter: ${provider}`);
  return entry.adapter;
}

export function listSourceAdapters() {
  return [...REGISTRY.values()].map((entry) => publicSourceAdapter(entry.adapter));
}

export function adapterSourceMetadata(provider, metadata = {}) {
  return sourceAdapterMetadata(getSourceAdapter(provider), metadata);
}

function parseMetadata(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function canonicalSourceRecord(context) {
  const sourceMetadata = parseMetadata(context?.source?.metadata_json);
  let provider = sourceMetadata?.sourceAdapter?.provider ?? null;
  if (!provider) {
    provider = [...REGISTRY.values()].find((entry) => entry.adapter.sourceKinds.includes(context?.source?.kind))?.adapter.provider ?? null;
  }
  if (!provider) return null;
  return REGISTRY.get(provider)?.canonicalize(context) ?? null;
}
