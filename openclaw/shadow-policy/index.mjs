import { buildPolicyPrompt, loadPolicy } from "./policy.mjs";
import { createTaskAccessHook } from "./task-access.mjs";
import { DatabaseSync } from "node:sqlite";
import { profileTurnContext } from "../../src/user-profile-view.mjs";

export function currentUserContext(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    return profileTurnContext(database);
  } finally { database.close(); }
}

export default {
  id: "shadow-policy",
  name: "Shadow Agent Policy",
  register(api) {
    loadPolicy(api.pluginConfig);
    api.on("before_prompt_build", (_event, ctx) => ({
      systemPrompt: buildPolicyPrompt(api.pluginConfig, ctx),
      prependContext: currentUserContext(api.pluginConfig.databasePath),
    }), { priority: 1000 });
    api.on("before_tool_call", createTaskAccessHook(api.pluginConfig), { priority: 1000 });
  },
};
