import Database from 'better-sqlite3'

function createCoreSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      settings_json TEXT DEFAULT '{}',
      is_public INTEGER NOT NULL DEFAULT 0,
      openai_api_key_encrypted TEXT,
      openai_api_key_mask TEXT,
      owner_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_user_id TEXT,
      parent_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('folder', 'photo')),
      name TEXT NOT NULL,
      notes TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      review_status TEXT NOT NULL DEFAULT 'new',
      needs_attention INTEGER NOT NULL DEFAULT 0,
      image_edits_json TEXT DEFAULT '{}',
      added_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(owner_user_id) REFERENCES users(id),
      FOREIGN KEY(parent_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS node_media (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      image_edits_json TEXT DEFAULT '{}',
      image_path TEXT,
      preview_path TEXT,
      original_filename TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS node_media_primary_per_node
    ON node_media(node_id)
    WHERE is_primary = 1;

    CREATE INDEX IF NOT EXISTS node_media_by_node_sort
    ON node_media(node_id, sort_order, created_at, id);
  `)
}

function ensureProjectSchema(db) {
  const columns = db.prepare(`PRAGMA table_info(projects)`).all()
  if (!columns.some((column) => column.name === 'description')) {
    db.exec(`ALTER TABLE projects ADD COLUMN description TEXT DEFAULT ''`)
  }
  if (!columns.some((column) => column.name === 'settings_json')) {
    db.exec(`ALTER TABLE projects ADD COLUMN settings_json TEXT DEFAULT '{}'`)
  }
  if (!columns.some((column) => column.name === 'is_public')) {
    db.exec(`ALTER TABLE projects ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some((column) => column.name === 'openai_api_key_encrypted')) {
    db.exec(`ALTER TABLE projects ADD COLUMN openai_api_key_encrypted TEXT`)
  }
  if (!columns.some((column) => column.name === 'openai_api_key_mask')) {
    db.exec(`ALTER TABLE projects ADD COLUMN openai_api_key_mask TEXT`)
  }
  if (!columns.some((column) => column.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE projects ADD COLUMN owner_user_id TEXT`)
  }
}

function ensureNodeSchema(db) {
  const columns = db.prepare(`PRAGMA table_info(nodes)`).all()
  if (!columns.some((column) => column.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN owner_user_id TEXT`)
  }
  if (!columns.some((column) => column.name === 'notes')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN notes TEXT DEFAULT ''`)
  }
  if (!columns.some((column) => column.name === 'tags_json')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN tags_json TEXT DEFAULT '[]'`)
  }
  if (!columns.some((column) => column.name === 'review_status')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN review_status TEXT NOT NULL DEFAULT 'new'`)
  }
  if (!columns.some((column) => column.name === 'needs_attention')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some((column) => column.name === 'image_edits_json')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN image_edits_json TEXT DEFAULT '{}'`)
  }
  if (!columns.some((column) => column.name === 'added_at')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN added_at TEXT`)
    db.prepare(`UPDATE nodes SET added_at = COALESCE(created_at, ?) WHERE added_at IS NULL OR TRIM(added_at) = ''`).run(
      new Date().toISOString(),
    )
  }
  db.exec(`
    UPDATE nodes
    SET review_status = CASE
      WHEN COALESCE(review_status, '') <> '' THEN review_status
      WHEN COALESCE(needs_attention, 0) = 1 THEN 'needs_attention'
      ELSE 'new'
    END
    WHERE review_status IS NULL OR TRIM(review_status) = ''
  `)
}

function ensureNodeMediaSchema(db) {
  const columns = db.prepare(`PRAGMA table_info(node_media)`).all()
  if (!columns.some((column) => column.name === 'is_primary')) {
    db.exec(`ALTER TABLE node_media ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some((column) => column.name === 'sort_order')) {
    db.exec(`ALTER TABLE node_media ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.some((column) => column.name === 'image_edits_json')) {
    db.exec(`ALTER TABLE node_media ADD COLUMN image_edits_json TEXT DEFAULT '{}'`)
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS node_media_primary_per_node
    ON node_media(node_id)
    WHERE is_primary = 1;

    CREATE INDEX IF NOT EXISTS node_media_by_node_sort
    ON node_media(node_id, sort_order, created_at, id);
  `)
}

function ensureAuthSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      capture_session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS project_collaborators (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(added_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_project_preferences (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      settings_json TEXT DEFAULT '{}',
      ui_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS user_node_collapse_preferences (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      collapsed INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, node_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );
  `)
}

function ensureNodeOwnerSchema(db) {
  const nodeColumns = db.prepare(`PRAGMA table_info(nodes)`).all()
  if (!nodeColumns.some((column) => column.name === 'owner_user_id')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN owner_user_id TEXT`)
  }

  db.exec(`
    UPDATE nodes
    SET owner_user_id = (
      SELECT owner_user_id
      FROM projects
      WHERE projects.id = nodes.project_id
    )
    WHERE owner_user_id IS NULL
  `)
}

function ensureIdentificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identification_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      system_key TEXT,
      name TEXT NOT NULL,
      ai_instructions TEXT NOT NULL DEFAULT '',
      parent_depth INTEGER NOT NULL DEFAULT 0,
      child_depth INTEGER NOT NULL DEFAULT 0,
      fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS identification_templates_project_system_key
    ON identification_templates(project_id, system_key)
    WHERE system_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS node_identifications (
      node_id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(node_id) REFERENCES nodes(id),
      FOREIGN KEY(template_id) REFERENCES identification_templates(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS node_identification_field_values (
      node_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      value_json TEXT DEFAULT 'null',
      reviewed INTEGER NOT NULL DEFAULT 0,
      reviewed_by_user_id TEXT,
      reviewed_at TEXT,
      source TEXT DEFAULT 'manual',
      ai_suggestion_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (node_id, field_key),
      FOREIGN KEY(node_id) REFERENCES nodes(id),
      FOREIGN KEY(reviewed_by_user_id) REFERENCES users(id)
    );
  `)

  const templateColumns = db.prepare(`PRAGMA table_info(identification_templates)`).all()
  if (!templateColumns.some((column) => column.name === 'ai_instructions')) {
    db.exec(`ALTER TABLE identification_templates ADD COLUMN ai_instructions TEXT NOT NULL DEFAULT ''`)
  }
  if (!templateColumns.some((column) => column.name === 'parent_depth')) {
    db.exec(`ALTER TABLE identification_templates ADD COLUMN parent_depth INTEGER NOT NULL DEFAULT 0`)
  }
  if (!templateColumns.some((column) => column.name === 'child_depth')) {
    db.exec(`ALTER TABLE identification_templates ADD COLUMN child_depth INTEGER NOT NULL DEFAULT 0`)
  }
}

export function initializeDatabase({ dbPath }) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  createCoreSchema(db)
  ensureProjectSchema(db)
  ensureNodeSchema(db)
  ensureNodeMediaSchema(db)
  ensureAuthSchema(db)
  ensureNodeOwnerSchema(db)
  ensureIdentificationSchema(db)

  return db
}
