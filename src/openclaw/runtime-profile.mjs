export function requiredPluginTools(pluginManifest = {}) {
  return [...new Set((pluginManifest?.contracts?.tools ?? []).map(String).filter(Boolean))];
}

export function applyCorePluginProfile(config) {
  const output = structuredClone(config);
  const plugins = output.plugins ??= {};
  plugins.allow = [...new Set([...(plugins.allow ?? []), "codex", "workboard", "shadow-work"])];
  const entries = plugins.entries ??= {};
  for (const id of ["codex", "workboard", "shadow-work"]) {
    entries[id] = { ...entries[id], enabled: true };
  }
  entries["shadow-work"].hooks = {
    ...entries["shadow-work"].hooks,
    allowConversationAccess: true,
  };
  return output;
}

export function mergeAgentToolPolicy(agentTools = {}, pluginManifests = []) {
  const requiredTools = pluginManifests.flatMap(requiredPluginTools);
  return {
    ...agentTools,
    alsoAllow: [...new Set([...(agentTools.alsoAllow ?? []), ...requiredTools])],
  };
}

export function resolveRuntimeSelection(template, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!["controller", "codingWorker"].includes(key)) throw new Error(`Unknown runtime override: ${key}`);
  }
  const selection = {};
  for (const role of ["controller", "codingWorker"]) {
    for (const key of Object.keys(overrides[role] ?? {})) {
      if (!["model", "runtime"].includes(key)) throw new Error(`Unknown ${role} option: ${key}`);
    }
    const entry = { ...template[role], ...overrides[role] };
    if (typeof entry.model !== "string" || !/^[\w.-]+\/[^\s*]+$/.test(entry.model)) {
      throw new Error(`${role} requires an exact provider/model reference`);
    }
    if (!["openclaw", "codex"].includes(entry.runtime)) throw new Error(`Unsupported ${role} runtime`);
    selection[role] = entry;
  }
  if (selection.controller.model === selection.codingWorker.model
      && selection.controller.runtime !== selection.codingWorker.runtime) {
    throw new Error("One model reference cannot select two runtimes; use distinct provider/model references");
  }
  return selection;
}

// Keep native provider credentials and application extensions in OpenClaw's own config.
export function applyRuntimeSelection(config, template, manifests = [], overrides = {}) {
  const output = structuredClone(config);
  const main = output.agents?.entries?.main;
  if (!main) throw new Error("OpenClaw main agent is missing.");
  const selection = resolveRuntimeSelection(template, overrides);
  const defaults = output.agents.defaults ??= {};
  const modelConfig = typeof defaults.model === "object" ? defaults.model : {};
  defaults.model = { ...modelConfig, primary: selection.controller.model };
  main.model = { ...(typeof main.model === "object" ? main.model : {}), primary: selection.controller.model };
  defaults.subagents = { ...defaults.subagents, ...template.subagents, model: selection.codingWorker.model };
  main.subagents = { ...main.subagents, model: selection.codingWorker.model };
  defaults.models ??= {};
  main.models ??= {};
  for (const { model, runtime } of Object.values(selection)) {
    defaults.models[model] = { ...defaults.models[model], agentRuntime: { id: runtime } };
    main.models[model] = { ...main.models[model], agentRuntime: { id: runtime } };
  }
  main.tools = mergeAgentToolPolicy({
    ...template.agentTools,
    ...main.tools,
    alsoAllow: [...(template.agentTools.alsoAllow ?? []), ...(main.tools?.alsoAllow ?? [])]
      .filter((name) => !name.startsWith("shadow_work_")),
  }, manifests);
  main.skills = [...new Set([...(template.skills ?? []), ...(main.skills ?? [])])];
  main.skillsLimits = { ...main.skillsLimits, ...template.skillsLimits };
  // Workshop, when explicitly used, retains its native publishing safeguards.
  // It is not the mandatory route for local skills or capability development.
  return { config: output, selection };
}

export function inspectRuntimeProfile(openClawConfig = {}, pluginManifest = {}) {
  const mainAgent = openClawConfig?.agents?.entries?.main;
  const allowedTools = mainAgent?.tools?.alsoAllow ?? [];
  const requiredTools = requiredPluginTools(pluginManifest);
  const missingRequiredTools = requiredTools.filter((name) => !allowedTools.includes(name));
  const compaction = openClawConfig?.agents?.defaults?.compaction ?? {};
  const defaults = openClawConfig?.agents?.defaults ?? {};
  const primary = (value) => typeof value === "string" ? value : value?.primary;
  const controllerModel = primary(mainAgent?.model) ?? primary(defaults.model);
  const workerModel = primary(mainAgent?.subagents?.model) ?? primary(defaults.subagents?.model) ?? controllerModel;
  const configuredRuntime = (model) => mainAgent?.models?.[model]?.agentRuntime?.id
    ?? defaults.models?.[model]?.agentRuntime?.id
    ?? openClawConfig.models?.providers?.[model?.split("/")[0]]?.agentRuntime?.id ?? null;
  return {
    configuredSelection: {
      controller: { model: controllerModel, runtime: configuredRuntime(controllerModel) },
      codingWorker: { model: workerModel, runtime: configuredRuntime(workerModel) },
    },
    allowedTools,
    requiredTools,
    missingRequiredTools,
    incrementalToolsReady: requiredTools.length > 0 && missingRequiredTools.length === 0,
    legacyToolsRemoved: !allowedTools.some((name) => name.startsWith("shadow_work_")),
    contextEngineReady: openClawConfig?.plugins?.slots?.contextEngine === "shadow-work"
      && openClawConfig?.agents?.defaults?.contextInjection === "continuation-skip"
      && compaction.mode === "safeguard"
      && Boolean(compaction.midTurnPrecheck?.enabled)
      && Boolean(compaction.maxActiveTranscriptBytes),
  };
}

// Installation-wide local authority. Model selection never grants authority by itself.
export function applySystemAccessProfile(config, template) {
  if (template.tools?.profile !== "full" || template.tools?.exec?.mode !== "full") {
    throw new Error("System access profile must explicitly declare full local access");
  }
  const output = structuredClone(config);
  output.tools = {
    ...output.tools,
    ...template.tools,
    fs: { ...output.tools?.fs, ...template.tools.fs },
    exec: { ...output.tools?.exec, ...template.tools.exec },
    sessions: { ...output.tools?.sessions, visibility: "agent" },
  };
  delete output.tools.allow;
  delete output.tools.exec.security;
  delete output.tools.exec.ask;
  output.agents.defaults.sandbox = { ...output.agents.defaults.sandbox, mode: "off" };
  for (const agent of Object.values(output.agents.entries)) {
    // Remove old per-agent narrowing; extensions and explicit tool denials remain intact.
    const tools = agent.tools ??= {};
    delete tools.profile;
    delete tools.allow;
    if (tools.fs) delete tools.fs.workspaceOnly;
    if (tools.exec) {
      for (const key of ["host", "mode", "security", "ask", "applyPatch"]) delete tools.exec[key];
    }
    if (agent.sandbox) delete agent.sandbox.mode;
  }
  const codex = output.plugins.entries.codex.config.appServer;
  codex.approvalPolicy = "never";
  codex.sandbox = "danger-full-access";
  return output;
}
