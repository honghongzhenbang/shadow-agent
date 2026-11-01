import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditEvaluationDataset, buildEvaluationDataset } from "../src/feishu-evaluation-dataset.mjs";
import { ensureDirectory } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const result = {
    capture: null,
    output: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "dataset.private.json"),
    metrics: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", "dataset.metrics.private.json"),
    hardGapHours: null,
    p2pGapHours: 4,
    groupGapHours: 2,
    maxMessages: 30,
    maxBytes: 12_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--capture") result.capture = path.resolve(argv[++index]);
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else if (argument === "--metrics") result.metrics = path.resolve(argv[++index]);
    else if (argument === "--hard-gap-hours") result.hardGapHours = Number(argv[++index]);
    else if (argument === "--p2p-gap-hours") result.p2pGapHours = Number(argv[++index]);
    else if (argument === "--group-gap-hours") result.groupGapHours = Number(argv[++index]);
    else if (argument === "--max-messages") result.maxMessages = Number(argv[++index]);
    else if (argument === "--max-bytes") result.maxBytes = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.capture) throw new Error("--capture is required.");
  return result;
}

const args = argumentsFrom(process.argv.slice(2));
const capture = JSON.parse(fs.readFileSync(args.capture, "utf8").replace(/^\uFEFF/, ""));
if (capture.schema !== "shadow-agent/feishu-evaluation-capture/v2") {
  throw new Error(`Unsupported capture schema: ${capture.schema}`);
}
const captureLimit = Number(capture?.limits?.maxMessagesPerChat ?? 0);
const conversations = (capture.conversations ?? []).map((conversation) => ({
  ...conversation,
  captureLikelyCapped: captureLimit > 0 && conversation.messages.length >= captureLimit,
}));
const dataset = buildEvaluationDataset(conversations, {
  hardGapHours: args.hardGapHours,
  p2pGapHours: args.p2pGapHours,
  groupGapHours: args.groupGapHours,
  maxMessages: args.maxMessages,
  maxBytes: args.maxBytes,
});
const audit = auditEvaluationDataset(dataset);
const metrics = {
  schema: "shadow-agent/feishu-evaluation-dataset-metrics/v2",
  generatedAt: new Date().toISOString(),
  capture: {
    capturedAt: capture.capturedAt,
    window: capture.window,
    conversations: capture.conversations?.length ?? 0,
    messages: (capture.conversations ?? []).reduce((sum, item) => sum + item.messages.length, 0),
    failures: capture.failures?.length ?? 0,
  },
  audit,
};
ensureDirectory(path.dirname(args.output));
ensureDirectory(path.dirname(args.metrics));
fs.writeFileSync(args.output, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
fs.writeFileSync(args.metrics, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: args.output, metrics: args.metrics, ...audit }, null, 2)}\n`);
