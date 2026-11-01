const CAPABILITY_NAMES = Object.freeze([
  "subscribeEvents",
  "readDelta",
  "historyBackfill",
  "readWindow",
  "resolveArtifact",
  "resumeSession",
  "observeTools",
  "sendMessage",
  "sendAsUser",
]);

export const SOURCE_FAMILIES = Object.freeze(["collaboration", "execution"]);
export const SOURCE_ADAPTER_CAPABILITIES = CAPABILITY_NAMES;

function nonEmpty(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

export function defineSourceAdapter(input) {
  const provider = nonEmpty(input?.provider, "provider");
  const family = nonEmpty(input?.family, "family");
  if (!SOURCE_FAMILIES.includes(family)) throw new Error(`Unsupported source family: ${family}`);
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) {
    const value = input?.capabilities?.[name];
    if (typeof value !== "boolean") throw new Error(`Capability ${provider}.${name} must be boolean.`);
    capabilities[name] = value;
  }
  const unknownCapabilities = Object.keys(input?.capabilities ?? {}).filter((name) => !CAPABILITY_NAMES.includes(name));
  if (unknownCapabilities.length) throw new Error(`Unknown source capabilities for ${provider}: ${unknownCapabilities.join(", ")}`);
  const adapter = {
    schemaVersion: 1,
    provider,
    family,
    displayName: nonEmpty(input?.displayName ?? provider, "displayName"),
    accountScope: nonEmpty(input?.accountScope ?? "local-user", "accountScope"),
    capabilities: Object.freeze(capabilities),
    sourceKinds: Object.freeze([...(input?.sourceKinds ?? [])].map(String)),
    evidenceKinds: Object.freeze([...(input?.evidenceKinds ?? [])].map(String)),
  };
  return Object.freeze(adapter);
}

export function sourceAdapterMetadata(adapter, metadata = {}) {
  return {
    ...metadata,
    sourceAdapter: {
      schemaVersion: adapter.schemaVersion,
      provider: adapter.provider,
      family: adapter.family,
      accountScope: adapter.accountScope,
      capabilities: adapter.capabilities,
    },
  };
}

export function requireSourceCapability(adapter, capability) {
  if (!CAPABILITY_NAMES.includes(capability)) throw new Error(`Unknown source capability: ${capability}`);
  if (adapter.capabilities[capability]) return true;
  const error = new Error(`Source adapter ${adapter.provider} does not support ${capability}.`);
  error.code = "SOURCE_CAPABILITY_UNSUPPORTED";
  error.provider = adapter.provider;
  error.capability = capability;
  throw error;
}

export function publicSourceAdapter(adapter) {
  return {
    schemaVersion: adapter.schemaVersion,
    provider: adapter.provider,
    family: adapter.family,
    displayName: adapter.displayName,
    accountScope: adapter.accountScope,
    capabilities: { ...adapter.capabilities },
    sourceKinds: [...adapter.sourceKinds],
    evidenceKinds: [...adapter.evidenceKinds],
  };
}
