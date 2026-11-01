import { logger } from "../logger.mjs";
import { buildDigests } from "../digests.mjs";
import { materializeContextGraph } from "../context-graph.mjs";
import { collectCodex } from "./codex.mjs";
import { collectFeishu } from "./feishu.mjs";
import { collectImports } from "./imports.mjs";
import { collectProjects } from "./projects.mjs";
import { listSourceAdapters } from "../source-adapters/index.mjs";

export async function collectAll(store, config, options = {}) {
  const result = { sourceAdapters: listSourceAdapters() };
  const startedAt = new Date().toISOString();
  logger.info("Collection started", { options });

  result.codex = await collectCodex(store, config, options);
  if (!options.skipProjects) result.projects = await collectProjects(store, config, options);
  result.imports = await collectImports(store, config);
  if (!options.localOnly) result.feishu = await collectFeishu(store, config);
  result.digests = buildDigests(store, config);
  result.contextGraph = materializeContextGraph(store, config, options.graphOptions ?? {
    refreshStructural: options.incremental !== true,
    runMaintenance: options.incremental !== true,
  });

  const completedAt = new Date().toISOString();
  if (!options.skipProjects) store.setSetting("collection:lastFullProjectScanAt", completedAt);
  logger.info("Collection completed", { startedAt, completedAt, result });
  return { startedAt, completedAt, ...result };
}
