import { openDatabase } from "../../../src/db.mjs";

export function openV4TestDatabase(databasePath) {
  const store = openDatabase(databasePath);
  store.setSetting("contextGraph:version", "epistemic-context-v4");
  return store;
}
