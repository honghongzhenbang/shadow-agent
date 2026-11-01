export function initializeUserProfile(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profile_binding (
      id TEXT PRIMARY KEY CHECK(id='primary'),
      owner_entity_id TEXT NOT NULL REFERENCES graph_entities(id),
      source_evidence_id TEXT REFERENCES evidence(id),
      created_at TEXT NOT NULL
    );
  `);
}
