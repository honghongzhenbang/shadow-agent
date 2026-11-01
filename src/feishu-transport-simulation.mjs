import { sha256 } from "./utils.mjs";

export const TRANSPORT_FAULTS = [
  "duplicate_delivery",
  "out_of_order_delivery",
  "restart_replay",
  "polling_realtime_overlap",
  "transient_failure_retry",
];

function stableEpisodes(episodes, fault) {
  return [...episodes].sort((left, right) => (
    sha256(`${fault}:${left.episodeId}`).localeCompare(sha256(`${fault}:${right.episodeId}`))
  ));
}

function deliveries(messages, source = "polling") {
  return messages.map((message, index) => ({
    operation: "deliver",
    source,
    messageKey: message.messageKey,
    revision: message.updatedAt ?? message.occurredAt ?? "",
    attempt: 1,
    outcome: "success",
    sequence: index,
  }));
}

function deriveCase(fault, episode) {
  const normal = deliveries(episode.messages);
  const last = normal.at(-1);
  let operations;
  if (fault === "duplicate_delivery") {
    operations = [...normal, { ...last, source: "polling", attempt: 2, sequence: normal.length }];
  } else if (fault === "out_of_order_delivery") {
    operations = [...normal];
    if (operations.length > 1) {
      const end = operations.length - 1;
      [operations[end - 1], operations[end]] = [operations[end], operations[end - 1]];
      operations = operations.map((operation, sequence) => ({ ...operation, sequence }));
    }
  } else if (fault === "restart_replay") {
    operations = [
      ...normal,
      { operation: "restart", sequence: normal.length },
      ...normal.map((operation, index) => ({ ...operation, attempt: 2, sequence: normal.length + 1 + index })),
    ];
  } else if (fault === "polling_realtime_overlap") {
    operations = [
      ...normal,
      { ...last, source: "realtime", attempt: 2, sequence: normal.length },
    ];
  } else if (fault === "transient_failure_retry") {
    operations = [
      ...normal.slice(0, -1),
      { ...last, outcome: "failure", sequence: Math.max(0, normal.length - 1) },
      { ...last, attempt: 2, sequence: normal.length },
    ];
  } else {
    throw new Error(`Unsupported transport fault: ${fault}`);
  }
  return {
    caseId: `transport_${sha256(`${fault}:${episode.episodeId}`).slice(0, 20)}`,
    syntheticTransport: true,
    fault,
    sourceEpisodeId: episode.episodeId,
    sourceSplit: episode.split,
    sourceMessageCount: episode.messages.length,
    operations,
    expected: {
      uniqueMessageKeys: [...new Set(episode.messages.map((message) => message.messageKey))],
      chronologicalMessageKeys: episode.messages.map((message) => message.messageKey),
      noDuplicateEvidence: true,
      noDuplicateSemanticWake: true,
    },
  };
}

export function deriveTransportSimulations(dataset, options = {}) {
  const perFault = Math.max(1, Math.min(20, Number(options.perFault ?? 3)));
  const eligible = (dataset.episodes ?? []).filter((episode) => (
    episode.split !== "holdout" && episode.messages?.length
  ));
  const cases = [];
  for (const fault of TRANSPORT_FAULTS) {
    const requiresPair = fault === "out_of_order_delivery";
    const candidates = stableEpisodes(eligible.filter((episode) => !requiresPair || episode.messages.length > 1), fault);
    for (const episode of candidates.slice(0, perFault)) cases.push(deriveCase(fault, episode));
  }
  return {
    schema: "shadow-agent/feishu-transport-simulations/v2",
    generatedAt: new Date().toISOString(),
    sourceDatasetSchema: dataset.schema,
    holdoutExcluded: true,
    containsBusinessContent: false,
    perFault,
    cases,
  };
}
