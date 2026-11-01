import test from "node:test";
import assert from "node:assert/strict";
import { normalizeZentaoReadPaths } from "../scripts/normalize-zentao-openapi.mjs";

test("normalizes read path and declares required argument without changing write routes", () => {
  const source = { paths: { "/executions/:executionID": {
    get: { description: "Read execution" }, put: { description: "Update execution" },
  } } };
  const result = normalizeZentaoReadPaths(source);
  const get = result.schema.paths["/executions/{executionID}"].get;
  assert.equal(get.operationId, "get_executions_:executionID");
  assert.deepEqual(get.parameters, [{ name: "executionID", in: "path", required: true, schema: { type: "string" } }]);
  assert.deepEqual(result.schema.paths["/executions/:executionID"].put, source.paths["/executions/:executionID"].put);
  assert.ok(source.paths["/executions/:executionID"].get);
  assert.equal(result.schema.paths["/executions/{executionID}"].put, undefined);
});

test("keeps explicit tool names, inherited and query parameters; rerunning is idempotent", () => {
  const source = { paths: { "/executions/:executionID/stories": {
    parameters: [{ name: "executionID", in: "path", required: true, schema: { type: "integer" } }],
    get: { operationId: "stories", parameters: [{ name: "pageID", in: "query", schema: { type: "integer" } }] },
  }, "/products": { get: { summary: "Products" } } } };
  const result = normalizeZentaoReadPaths(source);
  const item = result.schema.paths["/executions/{executionID}/stories"];
  assert.equal(item.get.operationId, "stories");
  assert.equal(item.parameters.length, 1);
  assert.equal(item.get.parameters.length, 1);
  assert.deepEqual(normalizeZentaoReadPaths(result.schema), { schema: result.schema, changed: [] });
});

test("refuses to overwrite a preexisting normalized route", () => {
  assert.throws(() => normalizeZentaoReadPaths({ paths: {
    "/stories/:storyID": { get: {} }, "/stories/{storyID}": { get: {} },
  } }), /Conflicting route/);
});

test("text-only relay does not advertise structured output and leaves writes unchanged", () => {
  const response = { "200": { description: "OK", content: { "application/json": {
    schema: { type: "object", properties: { status: { type: "string" } } }, example: { status: "success" },
  } } } };
  const input = { paths: { "/products": { get: { responses: response }, post: { responses: response } } } };
  const result = normalizeZentaoReadPaths(input).schema;
  assert.equal(result.paths["/products"].get.responses["200"].content["application/json"].schema, undefined);
  assert.deepEqual(result.paths["/products"].post, input.paths["/products"].post);
  assert.equal(result.paths["/products"].get.responses["200"].description, "OK");
  assert.deepEqual(result.paths["/products"].get.responses["200"].content["application/json"].example, { status: "success" });
  assert.ok(input.paths["/products"].get.responses["200"].content["application/json"].schema);
});
