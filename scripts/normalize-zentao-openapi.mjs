import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

// Older relay builds only substitute OpenAPI {parameters}, not :parameters.
export function normalizeZentaoReadPaths(input) {
  const output = structuredClone(input);
  const changed = [];
  for (const [route, item] of Object.entries(input.paths ?? {})) {
    if (item.get) output.paths[route].get = structuredClone(item.get);
    // Relay 1.0.1 returns text content only; do not advertise structured output it never emits.
    for (const response of Object.values(output.paths[route].get?.responses ?? {})) {
      for (const media of Object.values(response.content ?? {})) delete media.schema;
    }
    const parameters = [...route.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    if (!item.get || !parameters.length) continue;
    const normalized = route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
    if (output.paths[normalized]) throw new Error(`Conflicting route: ${normalized}`);
    const get = structuredClone(output.paths[route].get);
    get.operationId ??= `get${route.replaceAll("/", "_")}`;
    const declared = [...(item.parameters ?? []), ...(get.parameters ?? [])];
    get.parameters = [
      ...(get.parameters ?? []),
      ...parameters.filter((name) => !declared.some((p) => p.name === name && p.in === "path"))
        .map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
    ];
    const shared = Object.fromEntries(Object.entries(item).filter(([key]) => !methods.includes(key)));
    output.paths[normalized] = { ...structuredClone(shared), get };
    delete output.paths[route].get;
    if (!methods.some((method) => output.paths[route][method])) delete output.paths[route];
    changed.push({ route, normalized, tool: get.operationId, parameters });
  }
  return { schema: output, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || path.resolve(source) === path.resolve(destination)) {
    throw new Error("Usage: normalize-zentao-openapi.mjs SOURCE DIFFERENT_OUTPUT");
  }
  const { schema, changed } = normalizeZentaoReadPaths(JSON.parse(fs.readFileSync(source, "utf8")));
  fs.writeFileSync(destination, `${JSON.stringify(schema, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ output: path.resolve(destination), changedReadRoutes: changed.length }));
}
