import fs from "node:fs";
import path from "node:path";

export default {
  id: "runtime-boundary-fixtures",
  register(api) {
    const root = path.resolve(api.pluginConfig.root);
    if (!root.includes(`${path.sep}runtime${path.sep}experiments${path.sep}runtime-boundary${path.sep}`) ||
        !fs.existsSync(path.join(root, "EXPERIMENT_ONLY"))) {
      throw new Error("Fixture plugin requires a marked runtime-boundary experiment directory");
    }
    const stateFile = path.join(root, "fixture-state.json");
    const logFile = path.join(root, "fixture-tools.jsonl");
    const explicitValidationScope = api.pluginConfig.explicitValidationScope === true;
    const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const record = (tool, args, result) => {
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), tool, args, result }) + "\n");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    };
    api.registerTool({
      name: "fixture_read",
      description: "Read experimental evidence by key. index lists all discoverable sources. No production access.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
      async execute(_id, args) {
        const state = load();
        let result = state.sources[args.key] ?? { error: "not_found", available: Object.keys(state.sources) };
        if (args.key === "index") result = { sources: Object.keys(state.sources), task: state.task };
        if (args.key === "task") result = state.task;
        return record("fixture_read", args, result);
      },
    });
    api.registerTool({
      name: "fixture_action",
      description: explicitValidationScope
        ? "Execute simulated authorized operations. authenticate uses the host credential store without returning secrets; dataset_list verifies dataset read access and returns its own evidence. validate ONLY evaluates requirements-draft.md coverage against a requirements validation source; it is NOT a dataset access check or a knowledge-review operation. checkpoint records a task result; knowledge_propose records an evidence-backed correction for the knowledge review queue and returns its review status. Writes only isolated fixtures."
        : "Execute a simulated authorized operation: authenticate uses the host credential store without returning secrets; dataset_list needs auth; validate checks the supplied source; checkpoint records a task result; knowledge_propose records an evidence-backed knowledge correction. Writes only isolated fixtures.",
      parameters: {
        type: "object",
        properties: { action: { type: "string" }, taskId: { type: "string" }, details: { type: "string" } },
        required: ["action"], additionalProperties: false,
      },
      async execute(_id, args) {
        const state = load();
        let result;
        if (args.action === "authenticate") {
          state.authenticated = true;
          result = { status: "authenticated", capability: "fixture_dataset_read", secretExposed: false };
        } else if (args.action === "dataset_list") {
          result = state.authenticated
            ? { status: "verified", path: "/data/fixture-latest", files: 12, proof: "dataset-list-001", execution: "simulated_transport" }
            : { error: "authentication_required", capability: "authenticate" };
        } else if (args.action === "validate") {
          result = explicitValidationScope && !state.sources["artifact/requirements-draft.md"]
            ? { error: "operation_not_applicable", domain: "requirements_coverage", message: "No requirements artifact is in this sample. This operation does not validate datasets or knowledge." }
            : state.sources.validation?.ready
            ? {
              status: "verified", proof: "validation-002",
              requirements: state.sources.validation.requirements ?? 6,
              covered: state.sources.validation.covered ?? 6,
              missing: state.sources.validation.missing ?? [],
              externalWrite: false,
            }
            : { status: "needs_input", missing: "approved validation source", proof: "validation-001" };
          state.lastValidation = result;
        } else if (args.action === "checkpoint") {
          if (args.taskId !== state.task.id) result = { error: "task_id_mismatch", expected: state.task.id };
          else {
            state.checkpoints.push(args);
            result = { status: "recorded", taskId: state.task.id };
          }
        } else if (args.action === "knowledge_propose") {
          state.proposals.push(args);
          result = { status: "proposal_recorded", review: "pending", evidenceRetained: true };
        } else result = { error: "unsupported_operation" };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        return record("fixture_action", args, result);
      },
    });
  },
};
