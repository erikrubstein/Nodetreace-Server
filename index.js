import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import AdmZip from 'adm-zip'
import { initializeDatabase } from './db/bootstrap.js'
import { registerMediaAuthRoutes } from './routes/mediaAuthRoutes.js'
import { registerNodeRoutes } from './routes/nodeRoutes.js'
import { importRestorePayloadRoutes } from './routes/projectFileRoutes.js'
import { registerProjectRoutes } from './routes/projectRoutes.js'
import { registerSessionRoutes } from './routes/sessionRoutes.js'
import { defaultProjectSettings, defaultUserProjectUi } from './shared/projectDefaults.js'

const app = express()
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const repoRootDir = serverDir
loadEnvFile(path.join(repoRootDir, '.env'))
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'
const dataDir = process.env.NODETRACE_DATA_DIR
  ? path.resolve(process.env.NODETRACE_DATA_DIR)
  : path.join(repoRootDir, 'data')
const uploadsDir = path.join(dataDir, 'uploads')
const tempDir = path.join(dataDir, 'tmp')
const dbPath = path.join(dataDir, 'database.db')
const distDir = process.env.NODETRACE_WEB_DIST
  ? path.resolve(process.env.NODETRACE_WEB_DIST)
  : path.join(repoRootDir, 'dist')
const projectEventClients = new Map()
const activeDesktopSessions = new Map()
const activeMobileConnections = new Map()
const CLIENT_TTL_MS = 45000
const MOBILE_CONNECTION_TTL_MS = 30000
const AUTH_COOKIE = 'session'
const OPENAI_IDENTIFICATION_MODEL = process.env.OPENAI_IDENTIFICATION_MODEL || 'gpt-4.1'
const PROJECT_SECRET_RAW = process.env.NODETRACE_SECRET_KEY || ''
const PROJECT_SECRET_KEY = PROJECT_SECRET_RAW ? crypto.createHash('sha256').update(PROJECT_SECRET_RAW).digest() : null
const PHOTO_UPLOAD_MAX_FILE_SIZE_BYTES = 40 * 1024 * 1024
const PROJECT_ARCHIVE_MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024
const SUBTREE_RESTORE_MAX_FILE_SIZE_BYTES = 16 * 1024 * 1024
const SUBTREE_RESTORE_MAX_FILES = 32

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    if (!key || process.env[key] != null) {
      continue
    }

    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(tempDir, { recursive: true })
fs.mkdirSync(path.join(tempDir, 'imports'), { recursive: true })
fs.mkdirSync(path.join(tempDir, 'restore'), { recursive: true })

const ID_FIRST_CHARS = 'abcdefghijklmnopqrstuvwxyz'
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

const defaultNodeImageEdits = {
  crop: null,
  brightness: 0,
  contrast: 100,
  exposure: 0,
  sharpness: 0,
  denoise: 0,
  invert: false,
  rotationTurns: 0,
}

function normalizeNodeReviewStatus(input) {
  const value = String(input || '').trim().toLowerCase()
  if (value === 'needs_attention' || value === 'reviewed') {
    return value
  }
  return 'new'
}

function nodeHasLegacyMedia(node) {
  return Boolean(node?.image_path || node?.preview_path || node?.original_filename)
}

function generateShortId() {
  let value = ID_FIRST_CHARS[Math.floor(Math.random() * ID_FIRST_CHARS.length)]
  for (let index = 1; index < 5; index += 1) {
    value += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  }
  return value
}

function generateUniqueId(lookup) {
  let attempts = 0
  while (attempts < 200) {
    const candidate = generateShortId()
    if (!lookup(candidate)) {
      return candidate
    }
    attempts += 1
  }

  throw new Error('Unable to generate a unique short id')
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function _maskApiKey(apiKey) {
  const value = String(apiKey || '').trim()
  if (!value) {
    return ''
  }
  const suffix = value.slice(-4)
  return `â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢${suffix}`
}

function encryptProjectSecret(value) {
  if (!PROJECT_SECRET_KEY) {
    const error = new Error('NODETRACE_SECRET_KEY is not configured on the server')
    error.status = 500
    throw error
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', PROJECT_SECRET_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

function decryptProjectSecret(payload) {
  if (!payload) {
    return ''
  }
  if (!PROJECT_SECRET_KEY) {
    const error = new Error('NODETRACE_SECRET_KEY is not configured on the server')
    error.status = 500
    throw error
  }
  const [ivPart, tagPart, encryptedPart] = String(payload).split('.')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    PROJECT_SECRET_KEY,
    Buffer.from(ivPart, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

function getProjectSecretConfigurationError() {
  return 'Project API key storage is not configured on the server'
}

function maskProjectApiKey(apiKey) {
  const value = String(apiKey || '').trim()
  if (!value) {
    return ''
  }
  const suffix = value.slice(-4)
  return `********${suffix}`
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':')
  if (!salt || !hash) {
    return false
  }

  const candidate = crypto.scryptSync(password, salt, 64)
  const actual = Buffer.from(hash, 'hex')
  return actual.length === candidate.length && crypto.timingSafeEqual(actual, candidate)
}

function parseCookies(headerValue) {
  const cookies = {}
  for (const pair of String(headerValue || '').split(';')) {
    const [rawKey, ...rest] = pair.split('=')
    const key = rawKey?.trim()
    if (!key) {
      continue
    }
    cookies[key] = decodeURIComponent(rest.join('=').trim())
  }
  return cookies
}

function setAuthCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
  )
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`)
}

function normalizeUsername(usernameInput) {
  const username = String(usernameInput || '')
    .trim()
    .toLowerCase()
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    const error = new Error('Username must be 3-32 characters using letters, numbers, dot, underscore, or dash')
    error.status = 400
    throw error
  }
  return username
}

function normalizePassword(passwordInput) {
  const password = String(passwordInput || '')
  if (password.length < 8) {
    const error = new Error('Password must be at least 8 characters')
    error.status = 400
    throw error
  }
  return password
}

function getProjectUploadDir(projectId) {
  return path.join(uploadsDir, String(projectId))
}

function readUploadedFileData(file) {
  if (file?.buffer) {
    return file.buffer
  }
  if (file?.path && fs.existsSync(file.path)) {
    return fs.readFileSync(file.path)
  }
  return null
}

function copyStoredUpload(projectId, relativePath, label = 'media') {
  if (!relativePath) {
    return null
  }

  const sourcePath = path.join(uploadsDir, relativePath)
  if (!fs.existsSync(sourcePath)) {
    return null
  }

  const targetDir = getProjectUploadDir(projectId)
  fs.mkdirSync(targetDir, { recursive: true })
  const ext = path.extname(relativePath) || '.jpg'
  const safeBaseName = path
    .basename(relativePath, ext)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  const filename = `${Date.now()}-${label}-${generateUniqueId(() => false)}-${safeBaseName}${ext}`
  const destinationPath = path.join(targetDir, filename)
  fs.copyFileSync(sourcePath, destinationPath)
  return path.relative(uploadsDir, destinationPath).replaceAll('\\', '/')
}

function cloneMediaPayloadToProject(projectId, media, label = 'media') {
  return {
    image_path: copyStoredUpload(projectId, media.image_path, `${label}-image`),
    preview_path: copyStoredUpload(projectId, media.preview_path, `${label}-preview`),
    original_filename: media.original_filename || null,
    image_edits: normalizeNodeImageEdits(JSON.parse(media.image_edits_json || '{}')),
  }
}

const db = initializeDatabase({
  dbPath,
  generateUniqueId,
  normalizeNodeImageEdits,
})

const insertProject = db.prepare(`
  INSERT INTO projects (
    id, name, description, settings_json, is_public, openai_api_key_encrypted, openai_api_key_mask, owner_user_id, created_at, updated_at
  )
  VALUES (
    @id, @name, @description, @settings_json, @is_public, @openai_api_key_encrypted, @openai_api_key_mask, @owner_user_id, @created_at, @updated_at
  )
`)

const insertNode = db.prepare(`
  INSERT INTO nodes (
    id, project_id, owner_user_id, parent_id, variant_of_id, type, name, notes, tags_json, image_path, preview_path,
    review_status, needs_attention, image_edits_json, original_filename, added_at, created_at, updated_at
  ) VALUES (
    @id, @project_id, @owner_user_id, @parent_id, @variant_of_id, @type, @name, @notes, @tags_json, @image_path, @preview_path,
    @review_status, @needs_attention, @image_edits_json, @original_filename, @added_at, @created_at, @updated_at
  )
`)
const getNodeMediaByIdStmt = db.prepare(`SELECT * FROM node_media WHERE id = ?`)
const getNodeMediaByLegacySourceStmt = db.prepare(`
  SELECT *
  FROM node_media
  WHERE legacy_source_node_id = ?
`)
const listNodeMediaByNodeStmt = db.prepare(`
  SELECT *
  FROM node_media
  WHERE node_id = ?
  ORDER BY is_primary DESC, sort_order ASC, created_at ASC, id ASC
`)
const insertNodeMediaMirrorStmt = db.prepare(`
  INSERT INTO node_media (
    id,
    project_id,
    node_id,
    legacy_source_node_id,
    is_primary,
    sort_order,
    image_edits_json,
    image_path,
    preview_path,
    original_filename,
    created_at,
    updated_at
  ) VALUES (
    @id,
    @project_id,
    @node_id,
    @legacy_source_node_id,
    @is_primary,
    @sort_order,
    @image_edits_json,
    @image_path,
    @preview_path,
    @original_filename,
    @created_at,
    @updated_at
  )
`)
const updateNodeMediaMirrorStmt = db.prepare(`
  UPDATE node_media
  SET project_id = @project_id,
      node_id = @node_id,
      is_primary = @is_primary,
      sort_order = @sort_order,
      image_edits_json = @image_edits_json,
      image_path = @image_path,
      preview_path = @preview_path,
      original_filename = @original_filename,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateNodeMediaPlacementStmt = db.prepare(`
  UPDATE node_media
  SET node_id = @node_id,
      legacy_source_node_id = @legacy_source_node_id,
      is_primary = @is_primary,
      sort_order = @sort_order,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateNodeMediaEditsStmt = db.prepare(`
  UPDATE node_media
  SET image_edits_json = @image_edits_json,
      updated_at = @updated_at
  WHERE id = @id
`)
const clearNodeLegacyImageFieldsStmt = db.prepare(`
  UPDATE nodes
  SET image_path = NULL,
      preview_path = NULL,
      original_filename = NULL,
      image_edits_json = @image_edits_json,
      updated_at = @updated_at
  WHERE id = @id
`)
const resetNodeMediaPrimaryFlagsStmt = db.prepare(`
  UPDATE node_media
  SET is_primary = 0,
      updated_at = @updated_at
  WHERE node_id = @node_id
`)
const deleteNodeMediaByLegacySourceStmt = db.prepare(`
  DELETE FROM node_media
  WHERE legacy_source_node_id = ?
`)
const deleteNodeMediaByIdStmt = db.prepare(`
  DELETE FROM node_media
  WHERE id = ?
`)
const deleteNodeMediaByProjectStmt = db.prepare(`
  DELETE FROM node_media
  WHERE project_id = ?
`)

const getProject = db.prepare(`SELECT * FROM projects WHERE id = ?`)
const countUsers = db.prepare(`SELECT COUNT(*) AS count FROM users`)
const getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`)
const getUserByUsername = db.prepare(`SELECT * FROM users WHERE username = ?`)
const updateUsernameStmt = db.prepare(`
  UPDATE users
  SET username = @username,
      updated_at = @updated_at
  WHERE id = @id
`)
const updatePasswordStmt = db.prepare(`
  UPDATE users
  SET password_hash = @password_hash,
      updated_at = @updated_at
  WHERE id = @id
`)
const insertUser = db.prepare(`
  INSERT INTO users (id, username, password_hash, created_at, updated_at)
  VALUES (@id, @username, @password_hash, @created_at, @updated_at)
`)
const getSessionById = db.prepare(`
  SELECT s.*, u.username
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`)
const getSessionByCaptureId = db.prepare(`
  SELECT s.*, u.username
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.capture_session_id = ?
`)
const insertSession = db.prepare(`
  INSERT INTO user_sessions (id, user_id, capture_session_id, created_at, updated_at)
  VALUES (@id, @user_id, @capture_session_id, @created_at, @updated_at)
`)
const updateSessionTimestampStmt = db.prepare(`
  UPDATE user_sessions
  SET updated_at = @updated_at
  WHERE id = @id
`)
const updateSessionCaptureIdStmt = db.prepare(`
  UPDATE user_sessions
  SET capture_session_id = @capture_session_id,
      updated_at = @updated_at
  WHERE id = @id
`)
const deleteSessionStmt = db.prepare(`DELETE FROM user_sessions WHERE id = ?`)
const listSessionsByUserStmt = db.prepare(`SELECT * FROM user_sessions WHERE user_id = ?`)
const deleteSessionsByUserStmt = db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`)
const countOwnedProjectsByUserStmt = db.prepare(`SELECT COUNT(*) AS count FROM projects WHERE owner_user_id = ?`)
const deletePreferencesByUserStmt = db.prepare(`DELETE FROM user_project_preferences WHERE user_id = ?`)
const deleteCollaboratorsByUserStmt = db.prepare(`
  DELETE FROM project_collaborators
  WHERE user_id = ?
     OR added_by_user_id = ?
`)
const deleteUserStmt = db.prepare(`DELETE FROM users WHERE id = ?`)
const claimOwnerlessProjectsStmt = db.prepare(`
  UPDATE projects
  SET owner_user_id = @owner_user_id
  WHERE owner_user_id IS NULL
`)
const listAccessibleProjects = db.prepare(`
  SELECT
    p.*,
    owner.username AS owner_username,
    COUNT(CASE WHEN n.variant_of_id IS NULL THEN 1 END) AS node_count,
    CASE WHEN p.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner
  FROM projects p
  LEFT JOIN nodes n ON n.project_id = p.id
  LEFT JOIN users owner ON owner.id = p.owner_user_id
  WHERE p.owner_user_id = @user_id
     OR p.is_public = 1
     OR EXISTS (
       SELECT 1
       FROM project_collaborators pc
       WHERE pc.project_id = p.id
         AND pc.user_id = @user_id
     )
  GROUP BY p.id
  ORDER BY p.updated_at DESC, p.id DESC
`)
const getAccessibleProjectRow = db.prepare(`
  SELECT
    p.*,
    owner.username AS owner_username,
    COUNT(CASE WHEN n.variant_of_id IS NULL THEN 1 END) AS node_count,
    CASE WHEN p.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner
  FROM projects p
  LEFT JOIN nodes n ON n.project_id = p.id
  LEFT JOIN users owner ON owner.id = p.owner_user_id
  WHERE p.id = @project_id
    AND (
      p.owner_user_id = @user_id
      OR p.is_public = 1
      OR EXISTS (
        SELECT 1
        FROM project_collaborators pc
        WHERE pc.project_id = p.id
          AND pc.user_id = @user_id
      )
    )
  GROUP BY p.id
`)
const listProjectCollaborators = db.prepare(`
  SELECT u.id, u.username
  FROM project_collaborators pc
  JOIN users u ON u.id = pc.user_id
  WHERE pc.project_id = ?
  ORDER BY u.username COLLATE NOCASE ASC
`)
const getProjectCollaborator = db.prepare(`
  SELECT *
  FROM project_collaborators
  WHERE project_id = ?
    AND user_id = ?
`)
const insertProjectCollaborator = db.prepare(`
  INSERT INTO project_collaborators (project_id, user_id, added_by_user_id, created_at)
  VALUES (@project_id, @user_id, @added_by_user_id, @created_at)
`)
const deleteProjectCollaboratorStmt = db.prepare(`
  DELETE FROM project_collaborators
  WHERE project_id = ?
    AND user_id = ?
`)
const deleteProjectCollaboratorsStmt = db.prepare(`DELETE FROM project_collaborators WHERE project_id = ?`)
const getUserProjectPreference = db.prepare(`
  SELECT *
  FROM user_project_preferences
  WHERE user_id = ?
    AND project_id = ?
`)
const deleteUserProjectPreferencesByProjectStmt = db.prepare(`
  DELETE FROM user_project_preferences
  WHERE project_id = ?
`)
const upsertUserProjectPreference = db.prepare(`
  INSERT INTO user_project_preferences (user_id, project_id, settings_json, ui_json, created_at, updated_at)
  VALUES (@user_id, @project_id, @settings_json, @ui_json, @created_at, @updated_at)
  ON CONFLICT(user_id, project_id) DO UPDATE SET
    settings_json = excluded.settings_json,
    ui_json = excluded.ui_json,
    updated_at = excluded.updated_at
`)
const listUserNodeCollapsePrefsByProject = db.prepare(`
  SELECT node_id, collapsed
  FROM user_node_collapse_preferences
  WHERE user_id = ?
    AND project_id = ?
`)
const getUserNodeCollapsePreference = db.prepare(`
  SELECT collapsed
  FROM user_node_collapse_preferences
  WHERE user_id = ?
    AND node_id = ?
`)
const upsertUserNodeCollapsePreference = db.prepare(`
  INSERT INTO user_node_collapse_preferences (user_id, project_id, node_id, collapsed, created_at, updated_at)
  VALUES (@user_id, @project_id, @node_id, @collapsed, @created_at, @updated_at)
  ON CONFLICT(user_id, node_id) DO UPDATE SET
    collapsed = excluded.collapsed,
    updated_at = excluded.updated_at
`)
const deleteNodeCollapsePrefsByNodeStmt = db.prepare(`
  DELETE FROM user_node_collapse_preferences
  WHERE node_id = ?
`)
const deleteNodeCollapsePrefsByProjectStmt = db.prepare(`
  DELETE FROM user_node_collapse_preferences
  WHERE project_id = ?
`)
const deleteNodeCollapsePrefsByUserStmt = db.prepare(`
  DELETE FROM user_node_collapse_preferences
  WHERE user_id = ?
`)
const listIdentificationTemplatesByProject = db.prepare(`
  SELECT *
  FROM identification_templates
  WHERE project_id = ?
  ORDER BY created_at ASC, id ASC
`)
const getIdentificationTemplate = db.prepare(`SELECT * FROM identification_templates WHERE id = ?`)
const insertIdentificationTemplate = db.prepare(`
  INSERT INTO identification_templates (id, project_id, system_key, name, ai_instructions, parent_depth, child_depth, fields_json, created_at, updated_at)
  VALUES (@id, @project_id, @system_key, @name, @ai_instructions, @parent_depth, @child_depth, @fields_json, @created_at, @updated_at)
`)
const updateIdentificationTemplateStmt = db.prepare(`
  UPDATE identification_templates
  SET name = @name,
      ai_instructions = @ai_instructions,
      parent_depth = @parent_depth,
      child_depth = @child_depth,
      fields_json = @fields_json,
      updated_at = @updated_at
  WHERE id = @id
`)
const deleteIdentificationTemplateStmt = db.prepare(`
  DELETE FROM identification_templates
  WHERE id = ?
`)
const deleteIdentificationTemplatesByProjectStmt = db.prepare(`
  DELETE FROM identification_templates
  WHERE project_id = ?
`)
const getNodeIdentification = db.prepare(`
  SELECT *
  FROM node_identifications
  WHERE node_id = ?
`)
const listNodeIdentificationsByProject = db.prepare(`
  SELECT ni.node_id, ni.template_id, ni.created_by_user_id, ni.created_at, ni.updated_at
  FROM node_identifications ni
  JOIN nodes n ON n.id = ni.node_id
  WHERE n.project_id = ?
`)
const upsertNodeIdentification = db.prepare(`
  INSERT INTO node_identifications (node_id, template_id, created_by_user_id, created_at, updated_at)
  VALUES (@node_id, @template_id, @created_by_user_id, @created_at, @updated_at)
  ON CONFLICT(node_id) DO UPDATE SET
    template_id = excluded.template_id,
    created_by_user_id = excluded.created_by_user_id,
    updated_at = excluded.updated_at
`)
const deleteNodeIdentificationStmt = db.prepare(`
  DELETE FROM node_identifications
  WHERE node_id = ?
`)
const deleteNodeIdentificationsByProjectStmt = db.prepare(`
  DELETE FROM node_identifications
  WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)
`)
const listNodeIdentificationFieldValuesByProject = db.prepare(`
  SELECT niv.*
  FROM node_identification_field_values niv
  JOIN nodes n ON n.id = niv.node_id
  WHERE n.project_id = ?
`)
const getNodeIdentificationFieldValue = db.prepare(`
  SELECT *
  FROM node_identification_field_values
  WHERE node_id = ?
    AND field_key = ?
`)
const upsertNodeIdentificationFieldValue = db.prepare(`
  INSERT INTO node_identification_field_values (
    node_id, field_key, value_json, reviewed, reviewed_by_user_id, reviewed_at, source, ai_suggestion_json, updated_at
  ) VALUES (
    @node_id, @field_key, @value_json, @reviewed, @reviewed_by_user_id, @reviewed_at, @source, @ai_suggestion_json, @updated_at
  )
  ON CONFLICT(node_id, field_key) DO UPDATE SET
    value_json = excluded.value_json,
    reviewed = excluded.reviewed,
    reviewed_by_user_id = excluded.reviewed_by_user_id,
    reviewed_at = excluded.reviewed_at,
    source = excluded.source,
    ai_suggestion_json = excluded.ai_suggestion_json,
    updated_at = excluded.updated_at
`)
const deleteNodeIdentificationFieldValuesByNodeStmt = db.prepare(`
  DELETE FROM node_identification_field_values
  WHERE node_id = ?
`)
const deleteNodeIdentificationFieldValuesByProjectStmt = db.prepare(`
  DELETE FROM node_identification_field_values
  WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)
`)
const deleteNodeIdentificationFieldValueStmt = db.prepare(`
  DELETE FROM node_identification_field_values
  WHERE node_id = ?
    AND field_key = ?
`)
const deleteNodeIdentificationFieldValuesByTemplateStmt = db.prepare(`
  DELETE FROM node_identification_field_values
  WHERE node_id IN (
    SELECT node_id
    FROM node_identifications
    WHERE template_id = ?
  )
`)
const deleteNodeIdentificationsByTemplateStmt = db.prepare(`
  DELETE FROM node_identifications
  WHERE template_id = ?
`)
const countNodesUsingIdentificationTemplateStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM node_identifications
  WHERE template_id = ?
`)
const clearNodeIdentificationCreatorByUserStmt = db.prepare(`
  UPDATE node_identifications
  SET created_by_user_id = NULL
  WHERE created_by_user_id = ?
`)
const clearNodeIdentificationReviewerByUserStmt = db.prepare(`
  UPDATE node_identification_field_values
  SET reviewed_by_user_id = NULL
  WHERE reviewed_by_user_id = ?
`)
const reassignNodeOwnersByUserStmt = db.prepare(`
  UPDATE nodes
  SET owner_user_id = (
    SELECT owner_user_id
    FROM projects
    WHERE projects.id = nodes.project_id
  )
  WHERE owner_user_id = ?
`)
const getProjectNodes = db.prepare(`
  SELECT n.*, owner.username AS owner_username
  FROM nodes n
  LEFT JOIN users owner ON owner.id = n.owner_user_id
  WHERE n.project_id = ?
  ORDER BY COALESCE(parent_id, ''), type, name, id
`)
const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`)
const deleteNodesByProjectStmt = db.prepare(`DELETE FROM nodes WHERE project_id = ?`)
const getNode = db.prepare(`
  SELECT n.*, owner.username AS owner_username
  FROM nodes n
  LEFT JOIN users owner ON owner.id = n.owner_user_id
  WHERE n.id = ?
`)
const getNodesByProject = db.prepare(`
  SELECT n.*, owner.username AS owner_username
  FROM nodes n
  LEFT JOIN users owner ON owner.id = n.owner_user_id
  WHERE n.project_id = ?
`)
const listNodeMediaByProjectStmt = db.prepare(`
  SELECT *
  FROM node_media
  WHERE project_id = ?
  ORDER BY node_id ASC, is_primary DESC, sort_order ASC, created_at ASC, id ASC
`)
const hasChildNodeStmt = db.prepare(`
  SELECT 1
  FROM nodes
  WHERE parent_id = ?
  LIMIT 1
`)
const getNodeChildren = db.prepare(`SELECT id FROM nodes WHERE parent_id = ? OR variant_of_id = ?`)
const listCollapsibleNodeIdsByProject = db.prepare(`
  SELECT DISTINCT parent.id
  FROM nodes child
  JOIN nodes parent ON child.parent_id = parent.id
  WHERE parent.project_id = ?
    AND parent.variant_of_id IS NULL
`)
const updateProjectTimestamp = db.prepare(`
  UPDATE projects
  SET updated_at = ?
  WHERE id = ?
`)
const updateProjectSettingsStmt = db.prepare(`
  UPDATE projects
  SET settings_json = @settings_json,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateProjectAccessStmt = db.prepare(`
  UPDATE projects
  SET is_public = @is_public,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateProjectMetaStmt = db.prepare(`
  UPDATE projects
  SET name = @name,
      description = @description,
      settings_json = @settings_json,
      openai_api_key_encrypted = @openai_api_key_encrypted,
      openai_api_key_mask = @openai_api_key_mask,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateProjectOpenAiKeyStmt = db.prepare(`
  UPDATE projects
  SET openai_api_key_encrypted = @openai_api_key_encrypted,
      openai_api_key_mask = @openai_api_key_mask,
      updated_at = @updated_at
  WHERE id = @id
`)
const getProjectRootNodeStmt = db.prepare(`
  SELECT *
  FROM nodes
  WHERE project_id = ?
    AND parent_id IS NULL
  ORDER BY created_at ASC, id ASC
  LIMIT 1
`)
const updateNodeStmt = db.prepare(`
  UPDATE nodes
  SET name = @name,
      notes = @notes,
      tags_json = @tags_json,
      review_status = @review_status,
      needs_attention = @needs_attention,
      image_edits_json = @image_edits_json,
      updated_at = @updated_at
  WHERE id = @id
`)
const updateNodeParentStmt = db.prepare(`
  UPDATE nodes
  SET parent_id = @parent_id,
      variant_of_id = @variant_of_id,
      updated_at = @updated_at
  WHERE id = @id
`)
const deleteNodeStmt = db.prepare(`DELETE FROM nodes WHERE id = ?`)

function resequenceNodeMedia(nodeId) {
  if (!nodeId) {
    return
  }
  const node = getNode.get(nodeId)
  if (!node) {
    return
  }

  const mediaRows = listNodeMediaByNodeStmt.all(nodeId)
  const primaryMediaId =
    mediaRows.find((media) => Number(media.is_primary))?.id ||
    mediaRows.find((media) => media.legacy_source_node_id === nodeId)?.id ||
    mediaRows[0]?.id ||
    null
  let nextVariantSortOrder = 1
  for (const media of mediaRows) {
    const isPrimary = media.id === primaryMediaId ? 1 : 0
    const sortOrder = isPrimary ? 0 : nextVariantSortOrder
    if (!isPrimary) {
      nextVariantSortOrder += 1
    }
    if (
      media.node_id !== nodeId ||
      Number(media.is_primary || 0) !== isPrimary ||
      Number(media.sort_order || 0) !== sortOrder
    ) {
      updateNodeMediaPlacementStmt.run({
        id: media.id,
        node_id: nodeId,
        legacy_source_node_id: media.legacy_source_node_id || null,
        is_primary: isPrimary,
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
      })
    }
  }
}

function syncLegacyNodeMedia(nodeId) {
  // Temporary dual-write mirror while nodes still own legacy image/variant fields.
  const node = getNode.get(nodeId)
  const existing = getNodeMediaByLegacySourceStmt.get(nodeId)
  const previousOwnerNodeId = existing?.node_id || null

  if (!node || !nodeHasLegacyMedia(node)) {
    if (existing) {
      deleteNodeMediaByLegacySourceStmt.run(nodeId)
      resequenceNodeMedia(previousOwnerNodeId)
    }
    return
  }

  const ownerNodeId = node.variant_of_id || node.id
  const now = new Date().toISOString()
  const shouldBePrimary =
    node.variant_of_id == null
      ? 1
      : Number(existing?.is_primary || 0)
  const payload = {
    id: existing?.id || null,
    project_id: node.project_id,
    node_id: ownerNodeId,
    legacy_source_node_id: node.id,
    is_primary: shouldBePrimary,
    sort_order: node.variant_of_id == null ? 0 : Number(existing?.sort_order || 0),
    image_edits_json: JSON.stringify(normalizeNodeImageEdits(JSON.parse(node.image_edits_json || '{}'))),
    image_path: node.image_path || null,
    preview_path: node.preview_path || null,
    original_filename: node.original_filename || null,
    created_at: existing?.created_at || node.added_at || node.created_at || now,
    updated_at: node.updated_at || now,
  }
  if (existing) {
    updateNodeMediaMirrorStmt.run(payload)
  } else {
    payload.id = generateUniqueId((candidate) => Boolean(getNodeMediaByIdStmt.get(candidate)))
    insertNodeMediaMirrorStmt.run(payload)
  }

  if (previousOwnerNodeId && previousOwnerNodeId !== ownerNodeId) {
    resequenceNodeMedia(previousOwnerNodeId)
  }
  resequenceNodeMedia(ownerNodeId)
}

function assertNodeMedia(nodeId, mediaId) {
  const media = listNodeMediaByNodeStmt.all(nodeId).find((item) => item.id === mediaId)
  if (!media) {
    const error = new Error('Media not found')
    error.status = 404
    throw error
  }
  return media
}

const createProjectWithRoot = db.transaction(({ name, description, owner_user_id, is_public = 0 }) => {
  const now = new Date().toISOString()
  const projectId = generateUniqueId((candidate) => Boolean(getProject.get(candidate)))
  insertProject.run({
    id: projectId,
    name,
    description,
    settings_json: JSON.stringify(defaultProjectSettings),
    is_public: is_public ? 1 : 0,
    openai_api_key_encrypted: null,
    openai_api_key_mask: null,
    owner_user_id: owner_user_id || null,
    created_at: now,
    updated_at: now,
  })

  insertNode.run({
    id: generateUniqueId((candidate) => Boolean(getNode.get(candidate))),
    project_id: projectId,
    owner_user_id: owner_user_id || null,
    parent_id: null,
    type: 'folder',
    name,
    notes: '',
    tags_json: '[]',
    review_status: 'new',
    needs_attention: 0,
    image_edits_json: JSON.stringify(defaultNodeImageEdits),
    variant_of_id: null,
    image_path: null,
    preview_path: null,
    original_filename: null,
    added_at: now,
    created_at: now,
    updated_at: now,
  })


  return projectId
})

const updateProjectSettings = db.transaction(({ id, settings }) => {
  const now = new Date().toISOString()
  updateProjectSettingsStmt.run({
    id,
    settings_json: JSON.stringify(settings),
    updated_at: now,
  })
})

const updateProjectAccess = db.transaction(({ id, isPublic }) => {
  assertProject(id)
  const now = new Date().toISOString()
  updateProjectAccessStmt.run({
    id,
    is_public: isPublic ? 1 : 0,
    updated_at: now,
  })
})

const renameProjectAndRoot = db.transaction(({ id, name }) => {
  const now = new Date().toISOString()
  const project = assertProject(id)
  const rootNode = getProjectRootNodeStmt.get(id)

  updateProjectMetaStmt.run({
    id,
    name,
    description: project.description || '',
    settings_json: project.settings_json || JSON.stringify(defaultProjectSettings),
    openai_api_key_encrypted: project.openai_api_key_encrypted || null,
    openai_api_key_mask: project.openai_api_key_mask || null,
    updated_at: now,
  })

  if (rootNode) {
    updateNodeStmt.run({
      id: rootNode.id,
      name,
      notes: rootNode.notes || '',
      tags_json: rootNode.tags_json || '[]',
      image_edits_json: rootNode.image_edits_json || JSON.stringify(defaultNodeImageEdits),
      updated_at: now,
    })
  }
})

const updateProjectOpenAiKey = db.transaction(({ id, encryptedKey, keyMask }) => {
  updateProjectOpenAiKeyStmt.run({
    id,
    openai_api_key_encrypted: encryptedKey || null,
    openai_api_key_mask: keyMask || null,
    updated_at: new Date().toISOString(),
  })
})

const createNode = db.transaction((payload) => {
  const now = new Date().toISOString()
  const nodeId = payload.id || generateUniqueId((candidate) => Boolean(getNode.get(candidate)))
  const project = getProject.get(payload.project_id)
  const resolvedOwnerUserId =
    payload.owner_user_id && getUserById.get(payload.owner_user_id)
      ? payload.owner_user_id
      : project?.owner_user_id ?? null
  insertNode.run({
    id: nodeId,
    ...payload,
    owner_user_id: resolvedOwnerUserId,
    added_at: payload.added_at || now,
    created_at: now,
    updated_at: now,
    tags_json: JSON.stringify(payload.tags),
    review_status: normalizeNodeReviewStatus(payload.review_status),
    needs_attention: normalizeNodeReviewStatus(payload.review_status) === 'needs_attention' ? 1 : 0,
    image_edits_json: JSON.stringify(normalizeNodeImageEdits(payload.image_edits)),
    variant_of_id: payload.variant_of_id ?? null,
  })
  syncLegacyNodeMedia(nodeId)

  updateProjectTimestamp.run(now, payload.project_id)
  return nodeId
})

const updateNode = db.transaction(({ id, project_id, name, notes, tags, review_status, image_edits }) => {
  const now = new Date().toISOString()
  const normalizedReviewStatus = normalizeNodeReviewStatus(review_status)
  updateNodeStmt.run({
    id,
    name,
    notes,
    tags_json: JSON.stringify(tags),
    review_status: normalizedReviewStatus,
    needs_attention: normalizedReviewStatus === 'needs_attention' ? 1 : 0,
    image_edits_json: JSON.stringify(normalizeNodeImageEdits(image_edits)),
    updated_at: now,
  })
  syncLegacyNodeMedia(id)
  updateProjectTimestamp.run(now, project_id)
})

const upsertNodeIdentificationData = db.transaction(({ nodeId, templateId, createdByUserId = null, fields = [] }) => {
  const now = new Date().toISOString()
  upsertNodeIdentification.run({
    node_id: nodeId,
    template_id: templateId,
    created_by_user_id: createdByUserId,
    created_at: now,
    updated_at: now,
  })
  deleteNodeIdentificationFieldValuesByNodeStmt.run(nodeId)
  for (const field of fields) {
    upsertNodeIdentificationFieldValue.run({
      node_id: nodeId,
      field_key: field.key,
      value_json: JSON.stringify(field.value ?? null),
      reviewed: field.reviewed ? 1 : 0,
      reviewed_by_user_id: field.reviewed ? field.reviewed_by_user_id || null : null,
      reviewed_at: field.reviewed ? field.reviewed_at || now : null,
      source: field.source || 'manual',
      ai_suggestion_json: field.ai_suggestion != null ? JSON.stringify(field.ai_suggestion) : null,
      updated_at: now,
    })
  }
})

const updateIdentificationTemplate = db.transaction(({ templateId, name, aiInstructions, parentDepth, childDepth, fields }) => {
  const template = getIdentificationTemplate.get(templateId)
  if (!template) {
    const error = new Error('Identification template not found')
    error.status = 404
    throw error
  }

  const now = new Date().toISOString()
  const normalizedFields = normalizeIdentificationFieldDefinitions(fields)
  updateIdentificationTemplateStmt.run({
    id: templateId,
    name,
    ai_instructions: String(aiInstructions || '').trim(),
    parent_depth: clampAiDepth(parentDepth),
    child_depth: clampAiDepth(childDepth),
    fields_json: JSON.stringify(normalizedFields),
    updated_at: now,
  })

  const allowedKeys = new Set(normalizedFields.map((field) => field.key))
  const assignments = listNodeIdentificationsByProject
    .all(template.project_id)
    .filter((row) => row.template_id === templateId)
  for (const assignment of assignments) {
    const existingRows = db
      .prepare(`SELECT field_key FROM node_identification_field_values WHERE node_id = ?`)
      .all(assignment.node_id)
    for (const row of existingRows) {
      if (!allowedKeys.has(row.field_key)) {
        deleteNodeIdentificationFieldValueStmt.run(assignment.node_id, row.field_key)
      }
    }
  }

  updateProjectTimestamp.run(now, template.project_id)
})

const moveNode = db.transaction(({ id, project_id, parent_id, variant_of_id }) => {
  const now = new Date().toISOString()
  updateNodeParentStmt.run({
    id,
    parent_id,
    variant_of_id,
    updated_at: now,
  })
  syncLegacyNodeMedia(id)
  updateProjectTimestamp.run(now, project_id)
})

const setProjectCollapsedState = db.transaction(({ userId, projectId, collapsed }) => {
  const now = new Date().toISOString()
  const nodeIds = listCollapsibleNodeIdsByProject.all(projectId).map((row) => row.id)
  for (const nodeId of nodeIds) {
    upsertUserNodeCollapsePreference.run({
      user_id: userId,
      project_id: projectId,
      node_id: nodeId,
      collapsed,
      created_at: now,
      updated_at: now,
    })
  }
  return nodeIds
})

const setNodeCollapsedStateRecursive = db.transaction(({ userId, nodeId, projectId, collapsed }) => {
  const now = new Date().toISOString()
  const stack = [nodeId]
  const updatedIds = []

  while (stack.length > 0) {
    const currentId = stack.pop()
    updatedIds.push(currentId)
    upsertUserNodeCollapsePreference.run({
      user_id: userId,
      project_id: projectId,
      node_id: currentId,
      collapsed,
      created_at: now,
      updated_at: now,
    })

    if (!collapsed) {
      continue
    }

    const children = getNodeChildren.all(currentId, currentId)
    for (const child of children) {
      stack.push(child.id)
    }
  }

  return updatedIds
})

const deleteNodeRecursive = db.transaction((nodeId, projectId) => {
  const stack = [{ id: nodeId, visited: false }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current.visited) {
      stack.push({ id: current.id, visited: true })
      const children = getNodeChildren.all(current.id, current.id)
      for (const child of children) {
        stack.push({ id: child.id, visited: false })
      }
      continue
    }

    const node = getNode.get(current.id)
    for (const filePath of [node?.image_path, node?.preview_path]) {
      if (!filePath) {
        continue
      }

      const absolutePath = path.join(uploadsDir, filePath)
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath)
      }
    }

    deleteNodeCollapsePrefsByNodeStmt.run(current.id)
    deleteNodeIdentificationFieldValuesByNodeStmt.run(current.id)
    deleteNodeIdentificationStmt.run(current.id)
    deleteNodeMediaByLegacySourceStmt.run(current.id)
    deleteNodeStmt.run(current.id)
  }

  updateProjectTimestamp.run(new Date().toISOString(), projectId)
})

const updateNodeMediaEdits = db.transaction(({ nodeId, mediaId, imageEdits, projectId }) => {
  const media = assertNodeMedia(nodeId, mediaId)
  const now = new Date().toISOString()
  const imageEditsJson = JSON.stringify(normalizeNodeImageEdits(imageEdits))
  updateNodeMediaEditsStmt.run({
    id: media.id,
    image_edits_json: imageEditsJson,
    updated_at: now,
  })
  if (media.legacy_source_node_id) {
    updateNodeStmt.run({
      id: media.legacy_source_node_id,
      name: assertNode(media.legacy_source_node_id).name,
      notes: assertNode(media.legacy_source_node_id).notes || '',
      tags_json: assertNode(media.legacy_source_node_id).tags_json || '[]',
      review_status: normalizeNodeReviewStatus(assertNode(media.legacy_source_node_id).review_status),
      needs_attention: normalizeNodeReviewStatus(assertNode(media.legacy_source_node_id).review_status) === 'needs_attention' ? 1 : 0,
      image_edits_json: imageEditsJson,
      updated_at: now,
    })
  }
  updateProjectTimestamp.run(now, projectId)
})

const addNodeMedia = db.transaction(({ nodeId, projectId, imagePath, previewPath, originalFilename, imageEdits }) => {
  assertNode(nodeId)
  const now = new Date().toISOString()
  const existingMedia = listNodeMediaByNodeStmt.all(nodeId)
  const mediaId = generateUniqueId((candidate) => Boolean(getNodeMediaByIdStmt.get(candidate)))
  insertNodeMediaMirrorStmt.run({
    id: mediaId,
    project_id: projectId,
    node_id: nodeId,
    legacy_source_node_id: null,
    is_primary: existingMedia.length ? 0 : 1,
    sort_order: existingMedia.length ? existingMedia.length : 0,
    image_edits_json: JSON.stringify(normalizeNodeImageEdits(imageEdits)),
    image_path: imagePath || null,
    preview_path: previewPath || null,
    original_filename: originalFilename || null,
    created_at: now,
    updated_at: now,
  })
  resequenceNodeMedia(nodeId)
  updateProjectTimestamp.run(now, projectId)
  return mediaId
})

const setPrimaryNodeMedia = db.transaction(({ nodeId, mediaId, projectId }) => {
  assertNodeMedia(nodeId, mediaId)
  const now = new Date().toISOString()
  resetNodeMediaPrimaryFlagsStmt.run({
    node_id: nodeId,
    updated_at: now,
  })
  updateNodeMediaPlacementStmt.run({
    id: mediaId,
    node_id: nodeId,
    legacy_source_node_id: null,
    is_primary: 1,
    sort_order: 0,
    updated_at: now,
  })
  resequenceNodeMedia(nodeId)
  updateProjectTimestamp.run(now, projectId)
})

const removeNodeMedia = db.transaction(({ nodeId, mediaId, projectId }) => {
  const media = assertNodeMedia(nodeId, mediaId)
  const now = new Date().toISOString()
  const sourceNodeId = media.legacy_source_node_id || null
  if (sourceNodeId && sourceNodeId !== nodeId) {
    deleteNodeRecursive(sourceNodeId, projectId)
    return
  }

  for (const filePath of [media.image_path, media.preview_path]) {
    if (!filePath) {
      continue
    }
    const absolutePath = path.join(uploadsDir, filePath)
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
    }
  }

  if (sourceNodeId === nodeId) {
    clearNodeLegacyImageFieldsStmt.run({
      id: nodeId,
      image_edits_json: JSON.stringify(defaultNodeImageEdits),
      updated_at: now,
    })
  }
  deleteNodeMediaByIdStmt.run(media.id)
  resequenceNodeMedia(nodeId)
  updateProjectTimestamp.run(now, projectId)
})

const mergeNodeIntoTargetMedia = db.transaction(({ sourceNodeId, targetNodeId, projectId }) => {
  const sourceNode = assertNode(sourceNodeId)
  const targetNode = assertNode(targetNodeId)
  ensureNotRoot(sourceNode)
  ensureNodeBelongsToProject(sourceNode, projectId)
  ensureNodeBelongsToProject(targetNode, projectId)
  ensureCanHaveChildren(targetNode)
  ensureNoChildren(sourceNode)
  if (sourceNode.id === targetNode.id) {
    const error = new Error('A node cannot be merged into itself')
    error.status = 400
    throw error
  }

  const sourceMediaRows = listNodeMediaByNodeStmt.all(sourceNode.id)
  const preservedMedia = sourceMediaRows.find((item) => Number(item.is_primary)) || sourceMediaRows[0] || null
  if (!preservedMedia?.image_path) {
    const error = new Error('Only nodes with a photo can become an additional photo')
    error.status = 400
    throw error
  }

  const copiedMedia = cloneMediaPayloadToProject(projectId, preservedMedia, 'merge')
  const now = new Date().toISOString()
  insertNodeMediaMirrorStmt.run({
    id: generateUniqueId((candidate) => Boolean(getNodeMediaByIdStmt.get(candidate))),
    project_id: projectId,
    node_id: targetNode.id,
    legacy_source_node_id: null,
    is_primary: 0,
    sort_order: listNodeMediaByNodeStmt.all(targetNode.id).length + 1,
    image_edits_json: JSON.stringify(copiedMedia.image_edits),
    image_path: copiedMedia.image_path,
    preview_path: copiedMedia.preview_path,
    original_filename: copiedMedia.original_filename,
    created_at: now,
    updated_at: now,
  })
  resequenceNodeMedia(targetNode.id)
  deleteNodeRecursive(sourceNode.id, projectId)
  updateProjectTimestamp.run(now, projectId)
})

const extractNodeMediaToSibling = db.transaction(({ nodeId, mediaId, projectId, ownerUserId }) => {
  const sourceNode = assertNode(nodeId)
  ensureNodeBelongsToProject(sourceNode, projectId)
  ensureCanHaveChildren(sourceNode)

  const media = assertNodeMedia(nodeId, mediaId)
  if (!media.image_path) {
    const error = new Error('Only saved photos can be converted into their own node')
    error.status = 400
    throw error
  }

  const copiedMedia = cloneMediaPayloadToProject(projectId, media, 'extract')
  const newNodeId = createNode({
    project_id: projectId,
    owner_user_id: ownerUserId || sourceNode.owner_user_id || null,
    parent_id: sourceNode.id,
    variant_of_id: null,
    type: 'photo',
    name: createUntitledName(),
    notes: '',
    tags: [],
    review_status: 'new',
    image_edits: copiedMedia.image_edits,
    image_path: copiedMedia.image_path,
    preview_path: copiedMedia.preview_path,
    original_filename: copiedMedia.original_filename,
  })

  removeNodeMedia({
    nodeId: sourceNode.id,
    mediaId: media.id,
    projectId,
  })

  return newNodeId
})

const deleteProjectRecursive = db.transaction((projectId) => {
  assertProject(projectId)
  const rows = getNodesByProject.all(projectId)

  for (const node of rows) {
    for (const filePath of [node.image_path, node.preview_path]) {
      if (!filePath) {
        continue
      }

      const absolutePath = path.join(uploadsDir, filePath)
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath)
      }
    }
  }

  deleteNodeIdentificationFieldValuesByProjectStmt.run(projectId)
  deleteNodeIdentificationsByProjectStmt.run(projectId)
  deleteNodeCollapsePrefsByProjectStmt.run(projectId)
  deleteNodeMediaByProjectStmt.run(projectId)
  deleteNodesByProjectStmt.run(projectId)
  deleteIdentificationTemplatesByProjectStmt.run(projectId)
  deleteUserProjectPreferencesByProjectStmt.run(projectId)
  deleteProjectCollaboratorsStmt.run(projectId)
  deleteProjectStmt.run(projectId)

  const projectUploadDir = getProjectUploadDir(projectId)
  if (fs.existsSync(projectUploadDir)) {
    fs.rmSync(projectUploadDir, { recursive: true, force: true })
  }
})

const clearProjectContents = db.transaction((projectId) => {
  assertProject(projectId)
  const rows = getNodesByProject.all(projectId)

  for (const node of rows) {
    for (const filePath of [node.image_path, node.preview_path]) {
      if (!filePath) {
        continue
      }

      const absolutePath = path.join(uploadsDir, filePath)
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath)
      }
    }
  }

  deleteNodeIdentificationFieldValuesByProjectStmt.run(projectId)
  deleteNodeIdentificationsByProjectStmt.run(projectId)
  deleteNodeCollapsePrefsByProjectStmt.run(projectId)
  deleteNodeMediaByProjectStmt.run(projectId)
  deleteNodesByProjectStmt.run(projectId)
  deleteIdentificationTemplatesByProjectStmt.run(projectId)

  const projectUploadDir = getProjectUploadDir(projectId)
  if (fs.existsSync(projectUploadDir)) {
    fs.rmSync(projectUploadDir, { recursive: true, force: true })
  }
  fs.mkdirSync(projectUploadDir, { recursive: true })
})

function parseTags(input) {
  if (!input) {
    return []
  }

  const normalizeTag = (tag) => String(tag || '').trim()
  const isReservedTag = (tag) => normalizeTag(tag).toLowerCase() === 'any'

  if (Array.isArray(input)) {
    return input
      .map(normalizeTag)
      .filter((tag) => tag && !isReservedTag(tag))
  }

  return String(input)
    .split(',')
    .map(normalizeTag)
    .filter((tag) => tag && !isReservedTag(tag))
}

function sanitizeUploadName(filename, fallback = 'file.jpg') {
  const safeName = path.basename(String(filename || fallback)).replace(/[^a-zA-Z0-9._ -]/g, '_')
  return safeName || fallback
}

function sanitizeFilesystemName(name, fallback = 'item') {
  const safeName = Array.from(String(name || fallback).trim())
    .map((character) => {
      if ('<>:"/\\|?*'.includes(character)) {
        return '_'
      }
      const code = character.charCodeAt(0)
      return code >= 0 && code <= 31 ? '_' : character
    })
    .join('')
  return safeName || fallback
}

function createUntitledName() {
  return 'Node'
}

function clampAiDepth(value) {
  return Math.max(0, Math.min(5, Number.parseInt(value, 10) || 0))
}

function clampImageEdit(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.max(min, Math.min(max, number))
}

function normalizeNodeImageEdits(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const cropInput = raw.crop && typeof raw.crop === 'object' ? raw.crop : null
  let crop = null
  if (cropInput) {
    const x = clampImageEdit(cropInput.x, 0, 1, 0)
    const y = clampImageEdit(cropInput.y, 0, 1, 0)
    const width = clampImageEdit(cropInput.width, 0, 1, 1)
    const height = clampImageEdit(cropInput.height, 0, 1, 1)
    if (width > 0 && height > 0) {
      crop = {
        x,
        y,
        width: Math.min(width, 1 - x),
        height: Math.min(height, 1 - y),
      }
    }
  }

  return {
    crop,
    brightness: clampImageEdit(raw.brightness, -100, 100, defaultNodeImageEdits.brightness),
    contrast: clampImageEdit(raw.contrast, 0, 200, defaultNodeImageEdits.contrast),
    exposure: clampImageEdit(raw.exposure, -100, 100, defaultNodeImageEdits.exposure),
    sharpness: clampImageEdit(raw.sharpness, 0, 100, defaultNodeImageEdits.sharpness),
    denoise: clampImageEdit(raw.denoise, 0, 100, defaultNodeImageEdits.denoise),
    invert: Boolean(raw.invert),
    rotationTurns: ((Number.parseInt(raw.rotationTurns, 10) || 0) % 4 + 4) % 4,
  }
}

function normalizeUserProjectUi(uiInput) {
  const ui = {
    ...defaultUserProjectUi,
    ...(uiInput || {}),
  }

  ui.theme = ui.theme === 'light' ? 'light' : 'dark'
  ui.showGrid = ui.showGrid !== false
  if (
    ui.canvasTransform &&
    typeof ui.canvasTransform === 'object' &&
    Number.isFinite(Number(ui.canvasTransform.x)) &&
    Number.isFinite(Number(ui.canvasTransform.y)) &&
    Number.isFinite(Number(ui.canvasTransform.scale))
  ) {
    ui.canvasTransform = {
      x: Number(ui.canvasTransform.x),
      y: Number(ui.canvasTransform.y),
      scale: Math.max(0.1, Math.min(10, Number(ui.canvasTransform.scale))),
    }
  } else {
    ui.canvasTransform = null
  }
  if (Array.isArray(ui.selectedNodeIds)) {
    ui.selectedNodeIds = Array.from(new Set(ui.selectedNodeIds.map((value) => String(value || '').trim()).filter(Boolean)))
  } else {
    ui.selectedNodeIds = []
  }
  const panelDock = {
    ...defaultUserProjectUi.panelDock,
  }
  for (const panelId of Object.keys(defaultUserProjectUi.panelDock)) {
    const requestedSide = ui.panelDock?.[panelId]
    panelDock[panelId] = requestedSide === 'right' ? 'right' : defaultUserProjectUi.panelDock[panelId]
  }
  ui.panelDock = panelDock

  const hasLegacyPanelFlags =
    'previewOpen' in ui ||
    'cameraOpen' in ui ||
    'inspectorOpen' in ui ||
    'settingsOpen' in ui ||
    'accountOpen' in ui
  const hasExplicitSidebarState =
    'leftSidebarOpen' in ui ||
    'rightSidebarOpen' in ui ||
    'leftActivePanel' in ui ||
    'rightActivePanel' in ui ||
    'leftSidebarWidth' in ui ||
    'rightSidebarWidth' in ui ||
    'panelDock' in ui

  if (hasLegacyPanelFlags && !hasExplicitSidebarState) {
    const oldLeftPanels = ['camera', 'preview'].filter((panelId) => Boolean(ui[`${panelId}Open`]))
    const oldRightPanels = ['settings', 'templates', 'fields', 'inspector'].filter((panelId) => Boolean(ui[`${panelId}Open`]))
    ui.leftSidebarOpen = oldLeftPanels.length > 0
    ui.rightSidebarOpen = oldRightPanels.length > 0
    ui.leftActivePanel = oldLeftPanels[0] || defaultUserProjectUi.leftActivePanel
    ui.rightActivePanel = oldRightPanels[0] || defaultUserProjectUi.rightActivePanel
    ui.leftSidebarWidth = Math.max(
      220,
      Math.min(
        720,
        Number(ui.previewWidth || ui.cameraWidth || ui.leftSidebarWidth) || defaultUserProjectUi.leftSidebarWidth,
      ),
    )
    ui.rightSidebarWidth = Math.max(
      220,
      Math.min(
        720,
        Number(ui.inspectorWidth || ui.settingsWidth || ui.accountWidth || ui.rightSidebarWidth) ||
          defaultUserProjectUi.rightSidebarWidth,
      ),
    )
  }

  ui.leftSidebarOpen = Boolean(ui.leftSidebarOpen)
  ui.rightSidebarOpen = Boolean(ui.rightSidebarOpen)
  ui.leftSidebarWidth = Math.max(220, Math.min(720, Number(ui.leftSidebarWidth) || defaultUserProjectUi.leftSidebarWidth))
  ui.rightSidebarWidth = Math.max(
    220,
    Math.min(720, Number(ui.rightSidebarWidth) || defaultUserProjectUi.rightSidebarWidth),
  )

  const leftPanels = Object.keys(panelDock).filter((panelId) => panelDock[panelId] === 'left')
  const rightPanels = Object.keys(panelDock).filter((panelId) => panelDock[panelId] === 'right')
  ui.leftActivePanel = leftPanels.includes(ui.leftActivePanel) ? ui.leftActivePanel : leftPanels[0] || null
  ui.rightActivePanel = rightPanels.includes(ui.rightActivePanel) ? ui.rightActivePanel : rightPanels[0] || null

  return ui
}

function normalizeProjectSettings(settingsInput) {
  const settings = {
    ...defaultProjectSettings,
    ...(settingsInput || {}),
  }

  settings.orientation = settings.orientation === 'vertical' ? 'vertical' : 'horizontal'
  settings.imageMode = settings.imageMode === 'square' ? 'square' : 'original'
  settings.layoutMode = settings.layoutMode === 'classic' ? 'classic' : 'compact'
  settings.horizontalGap = Math.max(24, Math.min(220, Number(settings.horizontalGap) || defaultProjectSettings.horizontalGap))
  settings.verticalGap = Math.max(16, Math.min(180, Number(settings.verticalGap) || defaultProjectSettings.verticalGap))

  return settings
}

function normalizeIdentificationFieldDefinitions(fieldsInput) {
  const fields = Array.isArray(fieldsInput) ? fieldsInput : []
  const seen = new Set()
  const normalized = []

  for (const field of fields) {
    const key = String(field?.key || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
    if (!key) {
      const error = new Error('Template field keys cannot be empty')
      error.status = 400
      throw error
    }
    if (seen.has(key)) {
      const error = new Error(`Duplicate template field key: ${key}`)
      error.status = 400
      throw error
    }
    seen.add(key)

    const type = ['text', 'multiline'].includes(field?.type) ? field.type : 'text'
    const mode = field?.mode === 'ai' ? 'ai' : 'manual'
    normalized.push({
      key,
      label: String(field?.label || key)
        .trim()
        .replace(/\s+/g, ' ') || key,
      type,
      mode,
      required: false,
      reviewRequired: true,
    })
  }

  return normalized
}

function normalizeIdentificationFieldValue(field, valueInput) {
  if (field.type === 'list') {
    const items = Array.isArray(valueInput)
      ? valueInput
      : String(valueInput || '')
          .split(',')
          .map((item) => item.trim())
    return items.filter(Boolean)
  }

  return String(valueInput ?? '').trim()
}

function normalizeUnknownString(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function isUnknownLikeValue(value) {
  const normalized = normalizeUnknownString(value)
  return !normalized || normalized === 'unknown' || normalized === 'n/a' || normalized === 'na' || normalized === 'none'
}

function parsePercentString(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{1,3})(?:\.\d+)?%$/)
  if (!match) {
    return null
  }
  return Math.max(0, Math.min(100, Number.parseInt(match[1], 10)))
}

function applyConfidenceGuard(eligibleFields, updates) {
  const confidenceField = eligibleFields.find(
    (field) => field.key === 'confidence' || /confidence/i.test(field.label),
  )
  if (!confidenceField) {
    return updates
  }

  const confidenceUpdate = updates.find((update) => update.key === confidenceField.key)
  if (!confidenceUpdate) {
    return updates
  }

  const identityUpdates = updates.filter(
    (update) =>
      update.key !== confidenceField.key &&
      (/model|part[_ ]?number/i.test(update.key) ||
        /model|part number/i.test(eligibleFields.find((field) => field.key === update.key)?.label || '') ||
        /manufacturer/i.test(update.key) ||
        /manufacturer/i.test(eligibleFields.find((field) => field.key === update.key)?.label || '')),
  )

  if (identityUpdates.length === 0) {
    return updates
  }

  const unresolvedCount = identityUpdates.filter((update) => isUnknownLikeValue(update.value)).length
  if (unresolvedCount === 0) {
    return updates
  }

  const currentPercent = parsePercentString(confidenceUpdate.value)
  if (currentPercent == null) {
    confidenceUpdate.value = unresolvedCount >= 2 ? '25%' : '40%'
    return updates
  }

  const cappedPercent = unresolvedCount >= 2 ? Math.min(currentPercent, 25) : Math.min(currentPercent, 40)
  confidenceUpdate.value = `${cappedPercent}%`
  return updates
}

function identificationFieldHasValue(field, value) {
  return String(value || '').trim().length > 0
}

function guessMimeType(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase()
  if (extension === '.png') {
    return 'image/png'
  }
  if (extension === '.webp') {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function toDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath)
  return `data:${guessMimeType(filePath)};base64,${buffer.toString('base64')}`
}

function buildNodePathNames(nodesById, nodeId) {
  const names = []
  let currentId = nodeId
  while (currentId) {
    const current = nodesById.get(currentId)
    if (!current) {
      break
    }
    names.unshift(current.name)
    currentId = current.parent_id
  }
  return names
}

function collectScopedNodeEntries(projectNodes, selectedNodeId, parentDepth, childDepth) {
  const nodesById = new Map(projectNodes.map((node) => [node.id, node]))
  const childrenByParent = new Map()
  const variantsByAnchor = new Map()

  for (const node of projectNodes) {
    if (node.parent_id) {
      if (!childrenByParent.has(node.parent_id)) {
        childrenByParent.set(node.parent_id, [])
      }
      childrenByParent.get(node.parent_id).push(node)
    }
    if (node.variant_of_id) {
      if (!variantsByAnchor.has(node.variant_of_id)) {
        variantsByAnchor.set(node.variant_of_id, [])
      }
      variantsByAnchor.get(node.variant_of_id).push(node)
    }
  }

  const baseRelations = new Map()
  baseRelations.set(selectedNodeId, 'selected node')

  let currentParentId = nodesById.get(selectedNodeId)?.parent_id || null
  for (let depth = 1; depth <= parentDepth && currentParentId; depth += 1) {
    baseRelations.set(currentParentId, `parent depth ${depth}`)
    currentParentId = nodesById.get(currentParentId)?.parent_id || null
  }

  const queue = [{ id: selectedNodeId, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.depth >= childDepth) {
      continue
    }
    for (const child of childrenByParent.get(current.id) || []) {
      const nextDepth = current.depth + 1
      if (!baseRelations.has(child.id)) {
        baseRelations.set(child.id, `child depth ${nextDepth}`)
      }
      queue.push({ id: child.id, depth: nextDepth })
    }
  }

  const scopedEntries = []
  const seenNodeIds = new Set()

  function pushScopedNode(node, relation) {
    if (!node || seenNodeIds.has(node.id)) {
      return
    }
    seenNodeIds.add(node.id)
    scopedEntries.push({
      nodeId: node.id,
      relation,
      path: buildNodePathNames(nodesById, node.id).join(' > '),
    })
  }

  for (const [nodeId, relation] of baseRelations.entries()) {
    const node = nodesById.get(nodeId)
    pushScopedNode(node, relation)
    for (const variant of variantsByAnchor.get(nodeId) || []) {
      pushScopedNode(variant, `${relation} variant`)
    }
  }

  return scopedEntries
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }
  const texts = []
  for (const outputItem of payload?.output || []) {
    for (const content of outputItem?.content || []) {
      if (typeof content?.text === 'string') {
        texts.push(content.text)
      }
    }
  }
  return texts.join('\n').trim()
}

function parseJsonFromModelText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('AI returned an empty response')
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  return JSON.parse(candidate)
}

async function runOpenAiIdentification({ node, projectNodes, identification, identificationByNodeId, apiKey }) {
  const reviewedFields = identification.fields.filter((field) => field.reviewed)
  const eligibleFields = identification.fields.filter((field) => field.mode === 'ai' && !field.reviewed)
  if (eligibleFields.length === 0) {
    return { updates: [], message: 'No unreviewed AI-assisted fields to fill.' }
  }

  const nodesById = new Map(projectNodes.map((projectNode) => [projectNode.id, projectNode]))
  const fieldScopes = new Map()
  const scopedNodesById = new Map()
  const imageEntries = []
  const imageKeyToId = new Map()
  for (const field of eligibleFields) {
    const scopedEntries = collectScopedNodeEntries(
      projectNodes,
      node.id,
      Number(identification.templateParentDepth || 0),
      Number(identification.templateChildDepth || 0),
    )
    fieldScopes.set(field.key, scopedEntries)
    for (const entry of scopedEntries) {
      if (!scopedNodesById.has(entry.nodeId)) {
        scopedNodesById.set(entry.nodeId, entry)
      }
      const scopedNode = nodesById.get(entry.nodeId)
      if (!scopedNode) {
        continue
      }
      const imagePath = scopedNode.image_path || scopedNode.preview_path
      if (!imagePath) {
        continue
      }
      const absolutePath = path.join(uploadsDir, imagePath)
      if (!fs.existsSync(absolutePath)) {
        continue
      }
      const imageKey = `${scopedNode.id}:${absolutePath}`
      if (imageKeyToId.has(imageKey)) {
        continue
      }
      const imageId = `img_${imageEntries.length + 1}`
      imageKeyToId.set(imageKey, imageId)
      imageEntries.push({
        id: imageId,
        nodeId: scopedNode.id,
        relation: entry.relation,
        path: entry.path,
        absolutePath,
      })
    }
  }

  const scopedNodeText = [...scopedNodesById.values()].map((entry) => {
    const scopedNode = nodesById.get(entry.nodeId)
    const scopedIdentification = identificationByNodeId.get(entry.nodeId) || null
    return {
      id: scopedNode.id,
      relation: entry.relation,
      path: entry.path,
      name: scopedNode.name,
      type: scopedNode.type,
      notes: scopedNode.notes || '',
      hasImage: Boolean(scopedNode.image_path || scopedNode.preview_path),
      identification: scopedIdentification
        ? {
            templateName: scopedIdentification.templateName,
            status: scopedIdentification.status,
            fields: scopedIdentification.fields.map((field) => ({
              key: field.key,
              label: field.label,
              value: field.value,
              reviewed: field.reviewed,
              source: field.source,
            })),
          }
        : null,
    }
  })

  const promptPayload = {
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      path: buildNodePathNames(new Map(projectNodes.map((projectNode) => [projectNode.id, projectNode])), node.id).join(' > '),
    },
    reviewedFields: reviewedFields.map((field) => ({
      key: field.key,
      label: field.label,
      value: field.value,
    })),
    currentFields: identification.fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: field.value,
      reviewed: field.reviewed,
      mode: field.mode,
    })),
    scopedNodes: scopedNodeText,
    tasks: eligibleFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      scopedNodeIds: (fieldScopes.get(field.key) || []).map((entry) => entry.nodeId),
      allowedImageIds: imageEntries
        .filter((entry) => (fieldScopes.get(field.key) || []).some((scopeEntry) => scopeEntry.nodeId === entry.nodeId))
        .map((entry) => entry.id),
      parentDepth: Number(identification.templateParentDepth || 0),
      childDepth: Number(identification.templateChildDepth || 0),
      guidance:
        field.key === 'manufacturer' || /manufacturer/i.test(field.label)
          ? 'Only identify a manufacturer from explicit manufacturer text, a highly recognizable logo, or reviewed context. Do not invent a manufacturer from package style or vague board context.'
          : field.key === 'material_description' || /material/i.test(field.label)
            ? 'If the exact function is uncertain, prefer a conservative physical/package description over a guessed electrical function.'
            : field.key === 'identifiers' || /identifier/i.test(field.label)
              ? 'Only provide identifiers that are directly visible in the allowed scoped images or explicitly present in scoped text context.'
              : field.key === 'confidence' || /confidence/i.test(field.label)
                ? 'Return the field value as a percentage string such as "10%", "50%", or "90%". Do not return low/medium/high for the field value. If the specific model/part number or manufacturer is unknown or blank, confidence must stay low.'
                : '',
    })),
    images: imageEntries.map((entry) => ({
      id: entry.id,
      relation: entry.relation,
      path: entry.path,
    })),
  }

  const content = [
    {
      type: 'input_text',
      text:
        'You are filling hardware identification fields from bounded node context. Return JSON only. ' +
        'Every scoped node is provided as text context, including notes and any existing identification values. ' +
        'Prefer text context first, especially reviewed field values. Only inspect images if the answer cannot be determined reasonably from text alone. ' +
        'Only fill the requested AI-assisted fields. Never change reviewed fields; treat them as trusted facts. ' +
        'Evaluate each field independently. Do not let a guess for one field become evidence for another field unless that information already exists in reviewed scoped text context. ' +
        'For each task, only inspect images from allowedImageIds for that field, even if other images are present. ' +
        `Template-level instructions: ${String(identification.templateAiInstructions || '').trim() || 'None.'} ` +
        'Parent and child depth only define the maximum scope; the template instructions define what to use within that scope. ' +
        'Use this evidence order: reviewed scoped text context first, then other scoped text context, then direct visible image evidence, then broader board context as a weak tie-breaker only. ' +
        'Do not over-infer manufacturer or electrical function from package style, vague logo resemblance, or general board context. ' +
        'If the specific model/part number or manufacturer remains unknown, blank, or only weakly inferred, keep any confidence field low rather than moderate or high. ' +
        'If the exact function is uncertain for a material description, prefer a conservative physical description like package, pin count, or general component class instead of a specific function guess. ' +
        'If you cannot make a reasonable guess, return an empty string. ' +
        'Respond with {"fields":{"field_key":{"value":"...","confidenceBand":"low|medium|high","evidence":"...","rationale":"...","usedImageIds":["img_1"],"usedNodeIds":["node_1"],"sourceStrength":"direct|contextual|speculative"}}}. ' +
        'The value is the actual field value. confidenceBand is only the model-assessed confidence metadata and is separate from any template field named Confidence. ' +
        `Context: ${JSON.stringify(promptPayload)}`,
    },
  ]

  for (const entry of imageEntries) {
    content.push({
      type: 'input_text',
      text: `Image ${entry.id}: ${entry.relation}. Path: ${entry.path}.`,
    })
    content.push({
      type: 'input_image',
      image_url: toDataUrl(entry.absolutePath),
      detail: 'high',
    })
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_IDENTIFICATION_MODEL,
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
    }),
  })

  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'OpenAI request failed')
  }

  const parsed = parseJsonFromModelText(extractResponseText(payload))
  const updates = eligibleFields.map((field) => {
    const suggestion = parsed?.fields?.[field.key] || {}
    return {
      key: field.key,
      value: normalizeIdentificationFieldValue(field, suggestion.value ?? ''),
      confidence: suggestion.confidenceBand || suggestion.confidence || null,
      evidence: suggestion.evidence || '',
      rationale: suggestion.rationale || '',
      usedImageIds: Array.isArray(suggestion.usedImageIds) ? suggestion.usedImageIds.filter(Boolean) : [],
      usedNodeIds: Array.isArray(suggestion.usedNodeIds) ? suggestion.usedNodeIds.filter(Boolean) : [],
      sourceStrength: suggestion.sourceStrength || null,
    }
  })

  applyConfidenceGuard(eligibleFields, updates)

  return { updates, message: `AI filled ${updates.length} field${updates.length === 1 ? '' : 's'}.` }
}

function serializeIdentificationTemplate(row) {
  return {
    id: row.id,
    name: row.name,
    systemKey: row.system_key || null,
    aiInstructions: String(row.ai_instructions || '').trim(),
    parentDepth: clampAiDepth(row.parent_depth),
    childDepth: clampAiDepth(row.child_depth),
    fields: normalizeIdentificationFieldDefinitions(JSON.parse(row.fields_json || '[]')),
    usageCount: Number(countNodesUsingIdentificationTemplateStmt.get(row.id)?.count || 0),
  }
}

function buildNodeIdentification(nodeId, templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId) {
  const assignment = identificationRowsByNodeId.get(nodeId)
  if (!assignment) {
    return null
  }

  const template = templateRowsById.get(assignment.template_id)
  if (!template) {
    return null
  }

  const fieldValues = new Map((fieldRowsByNodeId.get(nodeId) || []).map((row) => [row.field_key, row]))
  const fields = template.fields.map((field) => {
    const row = fieldValues.get(field.key)
    const parsedValue = row
      ? normalizeIdentificationFieldValue(field, JSON.parse(row.value_json || 'null'))
      : field.type === 'list'
        ? []
        : ''
    const reviewed = Boolean(row?.reviewed)
    const hasValue = identificationFieldHasValue(field, parsedValue)
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      mode: field.mode || 'manual',
      required: field.required,
      reviewRequired: field.reviewRequired,
      value: parsedValue,
      hasValue,
      reviewed,
      reviewedByUserId: row?.reviewed_by_user_id || null,
      reviewedAt: row?.reviewed_at || null,
      source: row?.source || 'manual',
      aiSuggestion: row?.ai_suggestion_json ? JSON.parse(row.ai_suggestion_json) : null,
    }
  })

  const reviewedFieldCount = fields.filter((field) => field.reviewed).length
  const totalReviewFieldCount = fields.length
  const missingRequiredCount = Math.max(0, totalReviewFieldCount - reviewedFieldCount)
  const status = totalReviewFieldCount > 0 && reviewedFieldCount === totalReviewFieldCount ? 'reviewed' : 'incomplete'

  return {
    templateId: template.id,
    templateName: template.name,
    templateAiInstructions: template.aiInstructions || '',
    templateParentDepth: Number(template.parentDepth || 0),
    templateChildDepth: Number(template.childDepth || 0),
    status,
    requiredFieldCount: totalReviewFieldCount,
    missingRequiredCount,
    reviewedFieldCount,
    totalReviewFieldCount,
    fields,
  }
}

function getOrCreateProjectPreferences(project, userId) {
  const existing = getUserProjectPreference.get(userId, project.id)
  if (existing) {
    return {
      settings: normalizeProjectSettings(JSON.parse(existing.settings_json || '{}')),
      ui: normalizeUserProjectUi(JSON.parse(existing.ui_json || '{}')),
    }
  }

  const now = new Date().toISOString()
  const preferences = {
    settings: normalizeProjectSettings(JSON.parse(project.settings_json || '{}')),
    ui: normalizeUserProjectUi({}),
  }
  upsertUserProjectPreference.run({
    user_id: userId,
    project_id: project.id,
    settings_json: JSON.stringify(preferences.settings),
    ui_json: JSON.stringify(preferences.ui),
    created_at: now,
    updated_at: now,
  })
  return preferences
}

function serializeProject(row, userId) {
  const templates = listIdentificationTemplatesByProject.all(row.id).map(serializeIdentificationTemplate)
  const preferences = userId ? getOrCreateProjectPreferences(row, userId) : {
    settings: normalizeProjectSettings(JSON.parse(row.settings_json || '{}')),
    ui: normalizeUserProjectUi({}),
  }
  const collaborators = listProjectCollaborators
    .all(row.id)
    .map((collaborator) => ({ id: collaborator.id, username: collaborator.username }))

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    node_count: Math.max(0, Number(row.node_count || 0)),
    ownerUserId: row.owner_user_id || null,
    ownerUsername: row.owner_username || null,
    isPublic: Boolean(row.is_public),
    canManageUsers: Boolean(userId && row.owner_user_id === userId),
    openAiApiKeyConfigured: Boolean(row.openai_api_key_encrypted),
    openAiApiKeyMask: row.openai_api_key_mask || '',
    collaborators,
    identificationTemplates: templates,
    settings: preferences.settings,
    ui: preferences.ui,
  }
}

function buildVersionedUploadUrl(relativePath, versionToken = '') {
  const normalizedPath = String(relativePath || '').trim().replaceAll('\\', '/')
  if (!normalizedPath) {
    return null
  }
  const normalizedVersion = String(versionToken || '').trim()
  if (!normalizedVersion) {
    return `/uploads/${normalizedPath}`
  }
  return `/uploads/${normalizedPath}?v=${encodeURIComponent(normalizedVersion)}`
}

function serializeNodeMedia(row) {
  return {
    id: row.id,
    nodeId: row.node_id,
    legacySourceNodeId: row.legacy_source_node_id || null,
    isPrimary: Boolean(row.is_primary),
    sortOrder: Number(row.sort_order || 0),
    originalFilename: row.original_filename || null,
    imageEdits: normalizeNodeImageEdits(JSON.parse(row.image_edits_json || '{}')),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imageUrl: buildVersionedUploadUrl(row.image_path, row.updated_at || row.created_at || ''),
    previewUrl: buildVersionedUploadUrl(row.preview_path, row.updated_at || row.created_at || ''),
  }
}

function serializeNode(row, _collapsedMap = null, identification = null, mediaRows = []) {
  const media = mediaRows.map(serializeNodeMedia)
  const primaryMedia = media.find((item) => item.isPrimary) || media[0] || null
  return {
    id: row.id,
    ownerUserId: row.owner_user_id || null,
    ownerUsername: row.owner_username || null,
    parent_id: row.parent_id,
    variant_of_id: row.variant_of_id,
    type: row.type,
    name: row.name,
    notes: row.notes,
    original_filename: row.original_filename,
    added_at: row.added_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: JSON.parse(row.tags_json || '[]'),
    reviewStatus: normalizeNodeReviewStatus(row.review_status || (row.needs_attention ? 'needs_attention' : 'new')),
    needsAttention: normalizeNodeReviewStatus(row.review_status || (row.needs_attention ? 'needs_attention' : 'new')) === 'needs_attention',
    imageEdits: normalizeNodeImageEdits(JSON.parse(row.image_edits_json || '{}')),
    collapsed: false,
    isVariant: row.variant_of_id != null,
    identification,
    hasImage: Boolean(primaryMedia?.imageUrl || row.image_path),
    imageUrl: primaryMedia?.imageUrl || buildVersionedUploadUrl(row.image_path, row.updated_at || row.created_at || ''),
    previewUrl: primaryMedia?.previewUrl || buildVersionedUploadUrl(row.preview_path, row.updated_at || row.created_at || ''),
    primaryMediaId: primaryMedia?.id || null,
    mediaCount: media.length,
    media,
  }
}

function serializeNodeForUser(row, userId) {
  if (!row) {
    return null
  }
  const templateRowsById = new Map(
    listIdentificationTemplatesByProject.all(row.project_id)
      .map(serializeIdentificationTemplate)
      .map((template) => [template.id, template]),
  )
  const identificationRowsByNodeId = new Map(
    listNodeIdentificationsByProject.all(row.project_id).map((item) => [item.node_id, item]),
  )
  const fieldRowsByNodeId = new Map()
  for (const fieldRow of listNodeIdentificationFieldValuesByProject.all(row.project_id)) {
    const items = fieldRowsByNodeId.get(fieldRow.node_id) || []
    items.push(fieldRow)
    fieldRowsByNodeId.set(fieldRow.node_id, items)
  }
  const mediaRowsByNodeId = new Map()
  for (const mediaRow of listNodeMediaByProjectStmt.all(row.project_id)) {
    const items = mediaRowsByNodeId.get(mediaRow.node_id) || []
    items.push(mediaRow)
    mediaRowsByNodeId.set(mediaRow.node_id, items)
  }
  const node = serializeNode(
    row,
    null,
    buildNodeIdentification(row.id, templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId),
    mediaRowsByNodeId.get(row.id) || [],
  )
  if (row.variant_of_id != null || !hasChildNodeStmt.get(row.id)) {
    return node
  }
  const preference = userId ? getUserNodeCollapsePreference.get(userId, row.id) : null
  node.collapsed = preference == null ? true : Boolean(preference.collapsed)
  return node
}

function buildTree(project, rows, userId = null) {
  const visibleRows = rows.filter((row) => row.variant_of_id == null)
  const templateRowsById = new Map(
    listIdentificationTemplatesByProject.all(project.id)
      .map(serializeIdentificationTemplate)
      .map((template) => [template.id, template]),
  )
  const identificationRowsByNodeId = new Map(
    listNodeIdentificationsByProject.all(project.id).map((item) => [item.node_id, item]),
  )
  const fieldRowsByNodeId = new Map()
  for (const fieldRow of listNodeIdentificationFieldValuesByProject.all(project.id)) {
    const items = fieldRowsByNodeId.get(fieldRow.node_id) || []
    items.push(fieldRow)
    fieldRowsByNodeId.set(fieldRow.node_id, items)
  }
  const mediaRowsByNodeId = new Map()
  for (const mediaRow of listNodeMediaByProjectStmt.all(project.id)) {
    const items = mediaRowsByNodeId.get(mediaRow.node_id) || []
    items.push(mediaRow)
    mediaRowsByNodeId.set(mediaRow.node_id, items)
  }
  const collapsedMap = userId
    ? new Map(
        listUserNodeCollapsePrefsByProject
          .all(userId, project.id)
          .map((row) => [row.node_id, Boolean(row.collapsed)]),
      )
    : null
  const nodes = visibleRows.map((row) =>
    serializeNode(
      row,
      collapsedMap,
      buildNodeIdentification(row.id, templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId),
      mediaRowsByNodeId.get(row.id) || [],
    ),
  )
  const byId = new Map(nodes.map((node) => [node.id, { ...node, children: [] }]))
  let root = null

  for (const node of byId.values()) {
    if (node.parent_id == null) {
      root = node
      continue
    }

    const parent = byId.get(node.parent_id)
    if (parent) {
      parent.children.push(node)
    }
  }

  for (const node of byId.values()) {
    if ((node.children?.length || 0) === 0) {
      node.collapsed = false
      continue
    }
    const collapsePreference = collapsedMap?.get(node.id)
    node.collapsed = collapsePreference == null ? true : Boolean(collapsePreference)
  }

  return {
    project: serializeProject(project, userId),
    root,
    nodes: Array.from(byId.values()),
  }
}

function assertProject(projectId) {
  const project = getProject.get(String(projectId || '').trim())
  if (!project) {
    const error = new Error('Project not found')
    error.status = 404
    throw error
  }
  return project
}

function getRequestUser(req) {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = String(cookies[AUTH_COOKIE] || '').trim()
  if (!sessionId) {
    return null
  }

  const session = getSessionById.get(sessionId)
  if (!session) {
    return null
  }

  updateSessionTimestampStmt.run({
    id: session.id,
    updated_at: new Date().toISOString(),
  })

  return {
    id: session.user_id,
    username: session.username,
    authSessionId: session.id,
    captureSessionId: session.capture_session_id,
  }
}

function requireAuth(req, res, next) {
  const user = getRequestUser(req)
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  req.user = user
  return next()
}

function assertProjectAccess(projectId, userId) {
  const project = getAccessibleProjectRow.get({
    project_id: String(projectId || '').trim(),
    user_id: userId,
  })
  if (!project) {
    const error = new Error('Project not found')
    error.status = 404
    throw error
  }
  return project
}

function assertProjectOwner(projectId, userId) {
  const project = assertProjectAccess(projectId, userId)
  if (project.owner_user_id !== userId) {
    const error = new Error('Only the project owner can manage collaborators')
    error.status = 403
    throw error
  }
  return project
}

function assertNode(nodeId) {
  const node = getNode.get(String(nodeId || '').trim())
  if (!node) {
    const error = new Error('Node not found')
    error.status = 404
    throw error
  }
  return node
}

function assertNodeAccess(nodeId, userId) {
  const node = assertNode(nodeId)
  assertProjectAccess(node.project_id, userId)
  return node
}

function assertIdentificationTemplateAccess(templateId, projectId) {
  const template = getIdentificationTemplate.get(String(templateId || '').trim())
  if (!template || template.project_id !== projectId) {
    const error = new Error('Identification template not found')
    error.status = 404
    throw error
  }
  return template
}

function ensureNodeBelongsToProject(node, projectId) {
  if (node.project_id !== projectId) {
    const error = new Error('Node does not belong to project')
    error.status = 400
    throw error
  }
}

function ensureNotRoot(node) {
  if (node.parent_id == null && node.variant_of_id == null) {
    const error = new Error('The project root cannot be deleted or moved')
    error.status = 400
    throw error
  }
}

function ensureCanHaveChildren(node) {
  if (node.variant_of_id != null) {
    const error = new Error('Variants cannot have children')
    error.status = 400
    throw error
  }
}

function ensureNoChildren(node) {
  const children = getNodeChildren.all(node.id, node.id)
  if (children.length > 0) {
    const error = new Error('Only leaf nodes can become variants')
    error.status = 400
    throw error
  }
}

function resolveVariantAnchor(node) {
  if (node.variant_of_id == null) {
    return node
  }

  return assertNode(node.variant_of_id)
}

function ensureNoCycle(nodeId, parentId) {
  if (parentId == null) {
    return
  }

  let cursor = getNode.get(parentId)
  while (cursor) {
    if (cursor.id === nodeId) {
      const error = new Error('Cannot move a node into its own descendant')
      error.status = 400
      throw error
    }
    cursor = cursor.parent_id == null ? null : getNode.get(cursor.parent_id)
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      let projectId = null
      if (req.params.id) {
        projectId = req.user ? assertProjectAccess(req.params.id, req.user.id).id : assertProject(req.params.id).id
      } else if (req.params.sessionId) {
        const session = getDesktopSession(String(req.params.sessionId || '').trim().toLowerCase())
        if (!session) {
          throw Object.assign(new Error('Session is not active'), { status: 404 })
        }
        projectId = session.projectId
      }

      if (!projectId) {
        throw Object.assign(new Error('Project not found'), { status: 404 })
      }

      const targetDir = getProjectUploadDir(projectId)
      fs.mkdirSync(targetDir, { recursive: true })
      cb(null, targetDir)
    } catch (error) {
      cb(error)
    }
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${Date.now()}-${file.fieldname}-${safeName}`)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: PHOTO_UPLOAD_MAX_FILE_SIZE_BYTES,
    files: 2,
  },
})
const importUpload = multer({
  dest: path.join(tempDir, 'imports'),
  limits: {
    fileSize: PROJECT_ARCHIVE_MAX_FILE_SIZE_BYTES,
    files: 1,
  },
})
const restoreUpload = multer({
  dest: path.join(tempDir, 'restore'),
  limits: {
    fileSize: SUBTREE_RESTORE_MAX_FILE_SIZE_BYTES,
    files: SUBTREE_RESTORE_MAX_FILES,
  },
})

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(tempDir, `${prefix}-`))
}

function zipDirectory(sourceDir, destinationZip) {
  try {
    const zip = new AdmZip()
    for (const entry of fs.readdirSync(sourceDir)) {
      const absolutePath = path.join(sourceDir, entry)
      const stats = fs.statSync(absolutePath)
      if (stats.isDirectory()) {
        zip.addLocalFolder(absolutePath, entry)
      } else {
        zip.addLocalFile(absolutePath)
      }
    }
    zip.writeZip(destinationZip)
  } catch (error) {
    const wrapped = new Error(error.message || 'Project export failed')
    wrapped.status = 500
    throw wrapped
  }
}

function unzipArchive(sourceZip, destinationDir) {
  try {
    const zip = new AdmZip(sourceZip)
    zip.extractAllTo(destinationDir, true)
  } catch (error) {
    const wrapped = new Error(error.message || 'Project import failed')
    wrapped.status = 500
    throw wrapped
  }
}

function exportProjectArchive(projectId) {
  const project = assertProject(projectId)
  const rows = getProjectNodes.all(projectId)
  const workDir = makeTempDir(`export-${projectId}`)
  writeProjectManifest(project, rows, workDir)
  const archivePath = path.join(tempDir, `project-${projectId}-${Date.now()}.zip`)
  zipDirectory(workDir, archivePath)
  fs.rmSync(workDir, { recursive: true, force: true })
  return archivePath
}

function ensureUniquePath(targetPath, suffix = '') {
  const parsed = path.parse(targetPath)
  let candidate = targetPath
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${suffix || parsed.ext}`)
    index += 1
  }
  return candidate
}

function exportProjectMediaArchive(projectId) {
  const project = assertProject(projectId)
  const rows = getProjectNodes.all(projectId)
  const tree = buildTree(project, rows.filter((row) => row.variant_of_id == null))
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const workDir = makeTempDir(`export-media-${projectId}`)
  const rootDir = path.join(workDir, sanitizeFilesystemName(project.name || `project-${projectId}`))
  fs.mkdirSync(rootDir, { recursive: true })

  function copyMediaFile(media, destinationDir, requestedName) {
    if (!media?.imageUrl) {
      return
    }
    const relativeImagePath = decodeURIComponent(String(media.imageUrl).replace('/uploads/', ''))
    const sourcePath = path.join(uploadsDir, relativeImagePath)
    if (!fs.existsSync(sourcePath)) {
      return
    }

    const ext =
      path.extname(media.originalFilename || '') ||
      path.extname(relativeImagePath || '') ||
      '.jpg'
    const baseName = sanitizeFilesystemName(requestedName || 'photo')
    const initialPath = path.join(destinationDir, `${baseName}${ext}`)
    const destinationPath = ensureUniquePath(initialPath)
    fs.copyFileSync(sourcePath, destinationPath)
  }

  function exportAttachedPhotos(node, destinationDir) {
    if (!node?.media?.length) {
      return
    }
    const [primaryMedia, ...additionalMedia] = node.media
    if (primaryMedia) {
      copyMediaFile(primaryMedia, destinationDir, '_photo')
    }
    if (!additionalMedia.length) {
      return
    }

    const photosDir = path.join(destinationDir, '_photos')
    fs.mkdirSync(photosDir, { recursive: true })
    for (const [index, media] of additionalMedia.entries()) {
      copyMediaFile(
        media,
        photosDir,
        `${String(index + 1).padStart(2, '0')}-${media.originalFilename || 'photo'}`,
      )
    }
  }

  function exportChildren(node, destinationDir) {
    for (const child of node.children || []) {
      exportNode(child, destinationDir)
    }
  }

  function exportNode(node, destinationDir) {
    const safeNodeName = sanitizeFilesystemName(node.name || rowById.get(node.id)?.type || 'node')
    const hasChildren = (node.children?.length || 0) > 0
    const mediaCount = node.media?.length || 0

    if (!hasChildren && mediaCount === 1) {
      copyMediaFile(node.media[0], destinationDir, safeNodeName)
      return
    }

    const nodeDir = ensureUniquePath(path.join(destinationDir, safeNodeName), '')
    fs.mkdirSync(nodeDir, { recursive: true })
    exportAttachedPhotos(node, nodeDir)
    exportChildren(node, nodeDir)
  }

  if (tree.root) {
    exportChildren(tree.root, rootDir)
  }

  const archivePath = path.join(tempDir, `media-${projectId}-${Date.now()}.zip`)
  zipDirectory(workDir, archivePath)
  fs.rmSync(workDir, { recursive: true, force: true })
  return archivePath
}

function buildProjectArchiveData(projectId) {
  const templateRows = listIdentificationTemplatesByProject.all(projectId).map(serializeIdentificationTemplate)
  const identificationsByNodeId = new Map(
    listNodeIdentificationsByProject.all(projectId).map((row) => [row.node_id, row]),
  )
  const fieldValuesByNodeId = new Map()
  for (const row of listNodeIdentificationFieldValuesByProject.all(projectId)) {
    const items = fieldValuesByNodeId.get(row.node_id) || []
    items.push(row)
    fieldValuesByNodeId.set(row.node_id, items)
  }
  const mediaRowsByNodeId = new Map()
  for (const mediaRow of listNodeMediaByProjectStmt.all(projectId)) {
    const items = mediaRowsByNodeId.get(mediaRow.node_id) || []
    items.push(mediaRow)
    mediaRowsByNodeId.set(mediaRow.node_id, items)
  }

  return {
    templateRows,
    identificationsByNodeId,
    fieldValuesByNodeId,
    mediaRowsByNodeId,
  }
}

function serializeArchiveIdentification(nodeId, identificationsByNodeId, fieldValuesByNodeId) {
  const identification = identificationsByNodeId.get(nodeId)
  if (!identification) {
    return null
  }

  return {
    template_id: identification.template_id,
    created_by_user_id: identification.created_by_user_id || null,
    created_at: identification.created_at,
    updated_at: identification.updated_at,
    fields: (fieldValuesByNodeId.get(nodeId) || []).map((fieldRow) => ({
      key: fieldRow.field_key,
      value: JSON.parse(fieldRow.value_json || 'null'),
      reviewed: Boolean(fieldRow.reviewed),
      reviewed_by_user_id: fieldRow.reviewed_by_user_id || null,
      reviewed_at: fieldRow.reviewed_at || null,
      source: fieldRow.source || 'manual',
      ai_suggestion: fieldRow.ai_suggestion_json ? JSON.parse(fieldRow.ai_suggestion_json) : null,
    })),
  }
}

function copyProjectFileIntoArchive(workDir, sourceRelativePath, outputRelativePath) {
  if (!sourceRelativePath) {
    return null
  }
  const sourcePath = path.join(uploadsDir, sourceRelativePath)
  if (!fs.existsSync(sourcePath)) {
    return null
  }
  const targetPath = path.join(workDir, outputRelativePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(sourcePath, targetPath)
  return outputRelativePath.replaceAll('\\', '/')
}

function writeProjectManifest(project, rows, workDir) {
  const filesDir = path.join(workDir, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const { templateRows, identificationsByNodeId, fieldValuesByNodeId, mediaRowsByNodeId } =
    buildProjectArchiveData(project.id)
  const rowsById = new Map(rows.map((row) => [row.id, row]))

  const manifest = {
    version: 3,
    exported_at: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description || '',
      settings: normalizeProjectSettings(JSON.parse(project.settings_json || '{}')),
      identification_templates: templateRows,
    },
    nodes: rows
      .filter((row) => row.variant_of_id == null)
      .map((row) => ({
        id: row.id,
        owner_user_id: row.owner_user_id || null,
        parent_id: row.parent_id,
        name: row.name,
        notes: row.notes || '',
        tags: JSON.parse(row.tags_json || '[]'),
        review_status: normalizeNodeReviewStatus(
          row.review_status || (row.needs_attention ? 'needs_attention' : 'new'),
        ),
        added_at: row.added_at || row.created_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        identification: serializeArchiveIdentification(row.id, identificationsByNodeId, fieldValuesByNodeId),
        media: (mediaRowsByNodeId.get(row.id) || []).map((mediaRow, index) => {
          const imageFile = copyProjectFileIntoArchive(
            workDir,
            mediaRow.image_path,
            `files/${row.id}-media-${String(index + 1).padStart(2, '0')}-${mediaRow.id}-image${
              path.extname(mediaRow.image_path || '') || path.extname(mediaRow.original_filename || '') || '.jpg'
            }`,
          )
          const previewFile = copyProjectFileIntoArchive(
            workDir,
            mediaRow.preview_path,
            `files/${row.id}-media-${String(index + 1).padStart(2, '0')}-${mediaRow.id}-preview${
              path.extname(mediaRow.preview_path || '') || '.jpg'
            }`,
          )
          const legacyNode =
            mediaRow.legacy_source_node_id && mediaRow.legacy_source_node_id !== row.id
              ? rowsById.get(mediaRow.legacy_source_node_id)
              : null

          return {
            id: mediaRow.id,
            is_primary: Boolean(mediaRow.is_primary),
            sort_order: Number(mediaRow.sort_order || 0),
            original_filename: mediaRow.original_filename || null,
            image_edits: normalizeNodeImageEdits(JSON.parse(mediaRow.image_edits_json || '{}')),
            created_at: mediaRow.created_at,
            updated_at: mediaRow.updated_at,
            image_file: imageFile,
            preview_file: previewFile,
            legacy_node: legacyNode
              ? {
                  id: legacyNode.id,
                  owner_user_id: legacyNode.owner_user_id || null,
                  name: legacyNode.name,
                  notes: legacyNode.notes || '',
                  tags: JSON.parse(legacyNode.tags_json || '[]'),
                  review_status: normalizeNodeReviewStatus(
                    legacyNode.review_status || (legacyNode.needs_attention ? 'needs_attention' : 'new'),
                  ),
                  added_at: legacyNode.added_at || legacyNode.created_at,
                  created_at: legacyNode.created_at,
                  updated_at: legacyNode.updated_at,
                  identification: serializeArchiveIdentification(
                    legacyNode.id,
                    identificationsByNodeId,
                    fieldValuesByNodeId,
                  ),
                }
              : null,
          }
        }),
      })),
  }

  fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function sortArchiveMediaEntries(entries = []) {
  return [...entries].sort((left, right) => {
    if (Boolean(left.is_primary) !== Boolean(right.is_primary)) {
      return left.is_primary ? -1 : 1
    }
    const leftSort = Number(left.sort_order ?? Number.MAX_SAFE_INTEGER)
    const rightSort = Number(right.sort_order ?? Number.MAX_SAFE_INTEGER)
    if (leftSort !== rightSort) {
      return leftSort - rightSort
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function copyImportedArchiveFile(extractDir, projectId, relativeFilePath) {
  if (!relativeFilePath) {
    return null
  }
  const importedFilePath = path.join(extractDir, relativeFilePath)
  if (!fs.existsSync(importedFilePath)) {
    return null
  }
  const uniqueToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const relativeUploadPath = path.join(String(projectId), `${uniqueToken}-${path.basename(importedFilePath)}`)
  const absoluteUploadPath = path.join(uploadsDir, relativeUploadPath)
  fs.mkdirSync(path.dirname(absoluteUploadPath), { recursive: true })
  fs.copyFileSync(importedFilePath, absoluteUploadPath)
  return relativeUploadPath
}

function restoreNodeMediaFromArchive({
  projectId,
  nodeId,
  ownerUserId = null,
  extractDir = null,
  uploadedFileMap = null,
  mediaEntries = [],
  templateIdMap = new Map(),
}) {
  for (const entry of sortArchiveMediaEntries(mediaEntries)) {
    const imagePath = extractDir
      ? copyImportedArchiveFile(extractDir, projectId, entry.image_file)
      : entry.image_file_key
        ? (() => {
            const file = uploadedFileMap?.get(entry.image_file_key) || null
            const fileData = readUploadedFileData(file)
            if (!fileData) {
              return null
            }
            const uniqueToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const safeName = sanitizeUploadName(file.originalname, 'image.jpg')
            const relativeUploadPath = path.join(String(projectId), `${uniqueToken}-${safeName}`)
            const absoluteUploadPath = path.join(uploadsDir, relativeUploadPath)
            fs.mkdirSync(path.dirname(absoluteUploadPath), { recursive: true })
            fs.writeFileSync(absoluteUploadPath, fileData)
            return relativeUploadPath
          })()
        : null
    const previewPath = extractDir
      ? copyImportedArchiveFile(extractDir, projectId, entry.preview_file)
      : entry.preview_file_key
        ? (() => {
            const file = uploadedFileMap?.get(entry.preview_file_key) || null
            const fileData = readUploadedFileData(file)
            if (!fileData) {
              return null
            }
            const uniqueToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const safeName = sanitizeUploadName(file.originalname, 'preview.jpg')
            const relativeUploadPath = path.join(String(projectId), `${uniqueToken}-${safeName}`)
            const absoluteUploadPath = path.join(uploadsDir, relativeUploadPath)
            fs.mkdirSync(path.dirname(absoluteUploadPath), { recursive: true })
            fs.writeFileSync(absoluteUploadPath, fileData)
            return relativeUploadPath
          })()
        : null

    const legacyNode = entry.legacy_node || null
    if (legacyNode && !entry.is_primary) {
      const variantNodeId = createNode({
        project_id: projectId,
        owner_user_id: legacyNode.owner_user_id || ownerUserId || null,
        parent_id: null,
        variant_of_id: nodeId,
        type: 'photo',
        name: legacyNode.name || createUntitledName(projectId),
        notes: legacyNode.notes || '',
        tags: Array.isArray(legacyNode.tags) ? legacyNode.tags : [],
        review_status: legacyNode.review_status || 'new',
        image_edits: entry.image_edits,
        image_path: imagePath,
        preview_path: previewPath,
        original_filename: entry.original_filename || null,
        added_at: legacyNode.added_at || legacyNode.created_at || new Date().toISOString(),
      })

      if (legacyNode.identification?.template_id) {
        const mappedTemplateId = templateIdMap.get(String(legacyNode.identification.template_id))
        if (mappedTemplateId) {
          upsertNodeIdentificationData({
            nodeId: variantNodeId,
            templateId: mappedTemplateId,
            createdByUserId: legacyNode.identification.created_by_user_id || null,
            fields: Array.isArray(legacyNode.identification.fields) ? legacyNode.identification.fields : [],
          })
        }
      }
      continue
    }

    addNodeMedia({
      nodeId,
      projectId,
      imagePath,
      previewPath,
      originalFilename: entry.original_filename || null,
      imageEdits: entry.image_edits,
    })
  }
}

function restoreProjectFromArchive(projectId, archivePath) {
  const extractDir = makeTempDir(`restore-${projectId}`)

  try {
    unzipArchive(archivePath, extractDir)
    const manifestPath = path.join(extractDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      const error = new Error('Invalid project archive: manifest.json not found')
      error.status = 400
      throw error
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const importedRows = Array.isArray(manifest.nodes) ? manifest.nodes : []
    const mediaFirstArchive =
      Number(manifest.version || 0) >= 3 || importedRows.some((node) => Array.isArray(node.media))
    const rootRow = mediaFirstArchive
      ? importedRows.find((node) => (node.parent_id ?? node.parent_old_id) == null)
      : importedRows.find(
          (node) =>
            (node.parent_id ?? node.parent_old_id) == null &&
            (node.variant_of_id ?? node.variant_of_old_id) == null,
        )
    if (!rootRow) {
      const error = new Error('Invalid project archive: root node missing')
      error.status = 400
      throw error
    }

    clearProjectContents(projectId)

    const now = new Date().toISOString()
    updateProjectMetaStmt.run({
      id: projectId,
      name: String(manifest.project?.name || 'Restored Project').trim() || 'Restored Project',
      description: String(manifest.project?.description || '').trim(),
      settings_json: JSON.stringify(normalizeProjectSettings(manifest.project?.settings)),
      updated_at: now,
    })
    updateProjectAccess({
      id: projectId,
      isPublic: Boolean(manifest.project?.isPublic ?? manifest.project?.is_public),
    })

    deleteIdentificationTemplatesByProjectStmt.run(projectId)
    const templateIdMap = new Map()
    const importedTemplates = Array.isArray(manifest.project?.identification_templates)
      ? manifest.project.identification_templates
      : []
    for (const template of importedTemplates) {
      const newTemplateId = generateUniqueId((candidate) => Boolean(getIdentificationTemplate.get(candidate)))
      insertIdentificationTemplate.run({
        id: newTemplateId,
        project_id: projectId,
        system_key: template.systemKey || template.system_key || null,
        name: String(template.name || 'Template').trim() || 'Template',
        ai_instructions: String(template.aiInstructions || template.ai_instructions || '').trim(),
        parent_depth: clampAiDepth(template.parentDepth ?? template.parent_depth),
        child_depth: clampAiDepth(template.childDepth ?? template.child_depth),
        fields_json: JSON.stringify(normalizeIdentificationFieldDefinitions(template.fields)),
        created_at: now,
        updated_at: now,
      })
      templateIdMap.set(String(template.id ?? template.old_id ?? newTemplateId), newTemplateId)
    }

    const rootId = generateUniqueId((candidate) => Boolean(getNode.get(candidate)))
    insertNode.run({
      id: rootId,
      project_id: projectId,
      owner_user_id:
        rootRow.owner_user_id && getUserById.get(rootRow.owner_user_id)
          ? rootRow.owner_user_id
          : assertProject(projectId).owner_user_id || null,
      parent_id: null,
      variant_of_id: null,
      type: Array.isArray(rootRow.media) && rootRow.media.length ? 'photo' : 'folder',
      name: rootRow.name || 'Root',
      notes: rootRow.notes || '',
      tags_json: JSON.stringify(Array.isArray(rootRow.tags) ? rootRow.tags : []),
      review_status: normalizeNodeReviewStatus(
        rootRow.review_status || (rootRow.needs_attention ? 'needs_attention' : 'new'),
      ),
      needs_attention:
        normalizeNodeReviewStatus(
          rootRow.review_status || (rootRow.needs_attention ? 'needs_attention' : 'new'),
        ) === 'needs_attention'
          ? 1
          : 0,
      image_edits_json: JSON.stringify(normalizeNodeImageEdits(rootRow.image_edits || {})),
      image_path: null,
      preview_path: null,
      original_filename: null,
      added_at: rootRow.added_at || now,
      created_at: now,
      updated_at: now,
    })

    const rootManifestId = String(rootRow.id ?? rootRow.old_id)
    const oldToNew = new Map([[rootManifestId, rootId]])
    if (Array.isArray(rootRow.media)) {
      restoreNodeMediaFromArchive({
        projectId,
        nodeId: rootId,
        ownerUserId: rootRow.owner_user_id || assertProject(projectId).owner_user_id || null,
        extractDir,
        mediaEntries: rootRow.media,
        templateIdMap,
      })
    }
    if (rootRow.identification?.template_id) {
      const mappedTemplateId = templateIdMap.get(String(rootRow.identification.template_id))
      if (mappedTemplateId) {
        upsertNodeIdentificationData({
          nodeId: rootId,
          templateId: mappedTemplateId,
          createdByUserId: rootRow.identification.created_by_user_id || null,
          fields: Array.isArray(rootRow.identification.fields) ? rootRow.identification.fields : [],
        })
      }
    }
    const pendingRows = importedRows.filter((row) => String(row.id ?? row.old_id) !== rootManifestId)

    while (pendingRows.length > 0) {
      let importedCount = 0

      for (let index = pendingRows.length - 1; index >= 0; index -= 1) {
        const row = pendingRows[index]
        const rowId = String(row.id ?? row.old_id)
        const parentRef = row.parent_id ?? row.parent_old_id ?? null
        const variantRef = mediaFirstArchive ? null : row.variant_of_id ?? row.variant_of_old_id ?? null
        const parentId = parentRef != null ? oldToNew.get(String(parentRef)) : null
        const variantOfId = variantRef != null ? oldToNew.get(String(variantRef)) : null
        if (
          (parentRef != null && !parentId) ||
          (variantRef != null && !variantOfId)
        ) {
          continue
        }

        const relativeImagePath =
          !mediaFirstArchive && row.image_file
            ? copyImportedArchiveFile(extractDir, projectId, row.image_file)
            : null
        const relativePreviewPath =
          !mediaFirstArchive && row.preview_file
            ? copyImportedArchiveFile(extractDir, projectId, row.preview_file)
            : null

        const nodeId = createNode({
          project_id: projectId,
          owner_user_id: row.owner_user_id || assertProject(projectId).owner_user_id || null,
          parent_id: parentId,
          variant_of_id: variantOfId,
          type:
            row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
              ? 'photo'
              : 'folder',
          name:
            row.name ||
            (row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
              ? createUntitledName(projectId)
              : 'Restored Node'),
          notes: row.notes || '',
          tags: Array.isArray(row.tags) ? row.tags : [],
          review_status: row.review_status || (row.needs_attention ? 'needs_attention' : 'new'),
          image_edits: row.image_edits,
          image_path: relativeImagePath,
          preview_path: relativePreviewPath,
          original_filename: row.original_filename || null,
          added_at: row.added_at || row.created_at || now,
        })

        if (Array.isArray(row.media)) {
          restoreNodeMediaFromArchive({
            projectId,
            nodeId,
            ownerUserId: row.owner_user_id || assertProject(projectId).owner_user_id || null,
            extractDir,
            mediaEntries: row.media,
            templateIdMap,
          })
        }

        if (row.identification?.template_id) {
          const mappedTemplateId = templateIdMap.get(String(row.identification.template_id))
          if (mappedTemplateId) {
            upsertNodeIdentificationData({
              nodeId,
              templateId: mappedTemplateId,
              createdByUserId: row.identification.created_by_user_id || null,
              fields: Array.isArray(row.identification.fields) ? row.identification.fields : [],
            })
          }
        }

        oldToNew.set(rowId, nodeId)
        pendingRows.splice(index, 1)
        importedCount += 1
      }

      if (importedCount === 0) {
        const error = new Error('Invalid project archive: unable to resolve parent links during restore')
        error.status = 400
        throw error
      }
    }

    updateProjectTimestamp.run(new Date().toISOString(), projectId)
    return buildTree(assertProject(projectId), getProjectNodes.all(projectId))
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
}

function restoreSubtreeFromPayload(projectId, manifest, uploadedFiles) {
  assertProject(projectId)

  const rows = Array.isArray(manifest?.nodes) ? manifest.nodes : []
  const manifestRootId = String(manifest.root_id)
  const mediaFirstPayload =
    Number(manifest?.version || 0) >= 2 || rows.some((row) => Array.isArray(row.media))
  const rootRow = rows.find((row) => String(row.id ?? row.old_id) === manifestRootId)
  if (!rootRow) {
    const error = new Error('Invalid subtree payload: root node missing')
    error.status = 400
    throw error
  }

  const fileMap = new Map(uploadedFiles.map((file) => [file.fieldname, file]))
  const oldToNew = new Map()

  const pendingRows = [...rows]
  while (pendingRows.length > 0) {
    let importedCount = 0

    for (let index = pendingRows.length - 1; index >= 0; index -= 1) {
      const row = pendingRows[index]
      const rowId = String(row.id ?? row.old_id)
      const isRoot = rowId === manifestRootId
      const parentId = isRoot
        ? manifest.root_parent_id
        : row.parent_id != null || row.parent_old_id != null
          ? oldToNew.get(String(row.parent_id ?? row.parent_old_id))
          : null
      const variantOfId =
        !mediaFirstPayload && isRoot
          ? manifest.root_variant_of_id
          : !mediaFirstPayload &&
              (row.variant_of_id != null || row.variant_of_old_id != null)
            ? oldToNew.get(String(row.variant_of_id ?? row.variant_of_old_id))
            : null

      if (!isRoot && (row.parent_id != null || row.parent_old_id != null) && !parentId) {
        continue
      }
      if (
        !mediaFirstPayload &&
        !isRoot &&
        (row.variant_of_id != null || row.variant_of_old_id != null) &&
        !variantOfId
      ) {
        continue
      }

      const imageFile = !mediaFirstPayload && row.image_file_key ? fileMap.get(row.image_file_key) : null
      const previewFile =
        !mediaFirstPayload && row.preview_file_key ? fileMap.get(row.preview_file_key) : null
      const uniqueToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const safeImageName = imageFile ? sanitizeUploadName(imageFile.originalname, 'image.jpg') : null
      const safePreviewName = previewFile ? sanitizeUploadName(previewFile.originalname, 'preview.jpg') : null
      const relativeImagePath = imageFile
        ? path.join(String(projectId), `${uniqueToken}-${safeImageName}`)
        : null
      const relativePreviewPath = previewFile
        ? path.join(String(projectId), `${uniqueToken}-${safePreviewName}`)
        : null

      const imageFileData = readUploadedFileData(imageFile)
      if (imageFileData) {
        const absoluteImagePath = path.join(uploadsDir, relativeImagePath)
        fs.mkdirSync(path.dirname(absoluteImagePath), { recursive: true })
        fs.writeFileSync(absoluteImagePath, imageFileData)
      }
      const previewFileData = readUploadedFileData(previewFile)
      if (previewFileData) {
        const absolutePreviewPath = path.join(uploadsDir, relativePreviewPath)
        fs.mkdirSync(path.dirname(absolutePreviewPath), { recursive: true })
        fs.writeFileSync(absolutePreviewPath, previewFileData)
      }

      const nodeId = createNode({
        project_id: projectId,
        owner_user_id: row.owner_user_id || assertProject(projectId).owner_user_id || null,
        parent_id: parentId,
        variant_of_id: variantOfId,
        type:
          row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
            ? 'photo'
            : 'folder',
        name:
          row.name ||
          (row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
            ? createUntitledName(projectId)
            : 'Restored Node'),
        notes: row.notes || '',
        tags: Array.isArray(row.tags) ? row.tags : [],
        review_status: row.review_status || (row.needs_attention ? 'needs_attention' : 'new'),
        image_edits: row.image_edits,
        image_path: relativeImagePath,
        preview_path: relativePreviewPath,
        original_filename: row.original_filename || null,
        added_at: row.added_at || row.created_at || new Date().toISOString(),
      })

      if (Array.isArray(row.media)) {
        restoreNodeMediaFromArchive({
          projectId,
          nodeId,
          ownerUserId: row.owner_user_id || assertProject(projectId).owner_user_id || null,
          uploadedFileMap: fileMap,
          mediaEntries: row.media,
        })
      }

      if (row.identification?.template_id) {
        const template = getIdentificationTemplate.get(String(row.identification.template_id))
        if (template && template.project_id === projectId) {
          upsertNodeIdentificationData({
            nodeId,
            templateId: template.id,
            createdByUserId: row.identification.created_by_user_id || null,
            fields: Array.isArray(row.identification.fields) ? row.identification.fields : [],
          })
        }
      }

      oldToNew.set(rowId, nodeId)
      pendingRows.splice(index, 1)
      importedCount += 1
    }

    if (importedCount === 0) {
      const error = new Error('Invalid subtree payload: unable to resolve hierarchy')
      error.status = 400
      throw error
    }
  }

  return serializeNodeForUser(assertNode(oldToNew.get(manifestRootId)), null)
}

function importProjectArchive(archivePath, projectNameOverride = '', ownerUserId = null) {
  const extractDir = makeTempDir('import')
  let projectId = null

  try {
    unzipArchive(archivePath, extractDir)

    const manifestPath = path.join(extractDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      const error = new Error('Invalid project archive: manifest.json not found')
      error.status = 400
      throw error
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const importedRows = Array.isArray(manifest.nodes) ? manifest.nodes : []
    const mediaFirstArchive =
      Number(manifest.version || 0) >= 3 || importedRows.some((node) => Array.isArray(node.media))
    projectId = createProjectWithRoot({
      name:
        String(projectNameOverride || manifest.project?.name || 'Imported Project').trim() ||
        'Imported Project',
      description: String(manifest.project?.description || '').trim(),
      owner_user_id: ownerUserId,
      is_public: Boolean(manifest.project?.isPublic ?? manifest.project?.is_public),
    })

    if (manifest.project?.settings) {
      updateProjectSettings({
        id: projectId,
        settings: normalizeProjectSettings(manifest.project.settings),
      })
    }

    deleteIdentificationTemplatesByProjectStmt.run(projectId)
    const templateIdMap = new Map()
    const importedTemplates = Array.isArray(manifest.project?.identification_templates)
      ? manifest.project.identification_templates
      : []
    const now = new Date().toISOString()
    for (const template of importedTemplates) {
      const newTemplateId = generateUniqueId((candidate) => Boolean(getIdentificationTemplate.get(candidate)))
      insertIdentificationTemplate.run({
        id: newTemplateId,
        project_id: projectId,
        system_key: template.systemKey || template.system_key || null,
        name: String(template.name || 'Template').trim() || 'Template',
        ai_instructions: String(template.aiInstructions || template.ai_instructions || '').trim(),
        parent_depth: clampAiDepth(template.parentDepth ?? template.parent_depth),
        child_depth: clampAiDepth(template.childDepth ?? template.child_depth),
        fields_json: JSON.stringify(normalizeIdentificationFieldDefinitions(template.fields)),
        created_at: now,
        updated_at: now,
      })
      templateIdMap.set(String(template.id ?? template.old_id ?? newTemplateId), newTemplateId)
    }

    const oldToNew = new Map()
    const createdRoot = getProjectNodes.all(projectId).find((node) => node.parent_id == null)
    const rootRow = mediaFirstArchive
      ? importedRows.find((node) => (node.parent_id ?? node.parent_old_id) == null)
      : importedRows.find(
          (node) =>
            (node.parent_id ?? node.parent_old_id) == null &&
            (node.variant_of_id ?? node.variant_of_old_id) == null,
        )

    if (!createdRoot || !rootRow) {
      const error = new Error('Invalid project archive: root node missing')
      error.status = 400
      throw error
    }

    updateNode({
      id: createdRoot.id,
      project_id: projectId,
      name: rootRow.name || createdRoot.name,
      notes: rootRow.notes || '',
      tags: Array.isArray(rootRow.tags) ? rootRow.tags : [],
      review_status: rootRow.review_status || (rootRow.needs_attention ? 'needs_attention' : 'new'),
      image_edits: rootRow.image_edits || {},
    })
    const rootManifestId = String(rootRow.id ?? rootRow.old_id)
    oldToNew.set(rootManifestId, createdRoot.id)
    if (Array.isArray(rootRow.media)) {
      restoreNodeMediaFromArchive({
        projectId,
        nodeId: createdRoot.id,
        ownerUserId: rootRow.owner_user_id || ownerUserId || null,
        extractDir,
        mediaEntries: rootRow.media,
        templateIdMap,
      })
    }
    if (rootRow.identification?.template_id) {
      const mappedTemplateId = templateIdMap.get(String(rootRow.identification.template_id))
      if (mappedTemplateId) {
        upsertNodeIdentificationData({
          nodeId: createdRoot.id,
          templateId: mappedTemplateId,
          createdByUserId: rootRow.identification.created_by_user_id || null,
          fields: Array.isArray(rootRow.identification.fields) ? rootRow.identification.fields : [],
        })
      }
    }

    const projectUploadDir = getProjectUploadDir(projectId)
    fs.mkdirSync(projectUploadDir, { recursive: true })

    const pendingRows = importedRows.filter((row) => String(row.id ?? row.old_id) !== rootManifestId)
    while (pendingRows.length > 0) {
      let importedCount = 0

      for (let index = pendingRows.length - 1; index >= 0; index -= 1) {
        const row = pendingRows[index]
        const parentId =
          row.parent_id != null || row.parent_old_id != null
            ? oldToNew.get(String(row.parent_id ?? row.parent_old_id))
            : null
        const variantOfId =
          !mediaFirstArchive && (row.variant_of_id != null || row.variant_of_old_id != null)
            ? oldToNew.get(String(row.variant_of_id ?? row.variant_of_old_id))
            : null
        if (
          ((row.parent_id != null || row.parent_old_id != null) && !parentId) ||
          (!mediaFirstArchive &&
            (row.variant_of_id != null || row.variant_of_old_id != null) &&
            !variantOfId)
        ) {
          continue
        }

        const relativeImagePath =
          !mediaFirstArchive && row.image_file
            ? copyImportedArchiveFile(extractDir, projectId, row.image_file)
            : null
        const relativePreviewPath =
          !mediaFirstArchive && row.preview_file
            ? copyImportedArchiveFile(extractDir, projectId, row.preview_file)
            : null

        const nodeId = createNode({
          project_id: projectId,
          owner_user_id: row.owner_user_id || ownerUserId || null,
          parent_id: parentId,
          variant_of_id: variantOfId,
          type:
            row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
              ? 'photo'
              : 'folder',
          name:
            row.name ||
            (row.type === 'photo' || (Array.isArray(row.media) && row.media.length)
              ? createUntitledName(projectId)
              : 'Imported Node'),
          notes: row.notes || '',
          tags: Array.isArray(row.tags) ? row.tags : [],
          review_status: row.review_status || (row.needs_attention ? 'needs_attention' : 'new'),
          image_edits: row.image_edits,
          image_path: relativeImagePath,
          preview_path: relativePreviewPath,
          original_filename: row.original_filename || null,
        })

        if (Array.isArray(row.media)) {
          restoreNodeMediaFromArchive({
            projectId,
            nodeId,
            ownerUserId: row.owner_user_id || ownerUserId || null,
            extractDir,
            mediaEntries: row.media,
            templateIdMap,
          })
        }

        if (row.identification?.template_id) {
          const mappedTemplateId = templateIdMap.get(String(row.identification.template_id))
          if (mappedTemplateId) {
            upsertNodeIdentificationData({
              nodeId,
              templateId: mappedTemplateId,
              createdByUserId: row.identification.created_by_user_id || null,
              fields: Array.isArray(row.identification.fields) ? row.identification.fields : [],
            })
          }
        }

        oldToNew.set(String(row.id ?? row.old_id), nodeId)
        pendingRows.splice(index, 1)
        importedCount += 1
      }

      if (importedCount === 0) {
        const unresolvedParents = pendingRows.slice(0, 5).map((row) => ({
          node: row.name || row.id || row.old_id,
          missingParentId: row.parent_id ?? row.parent_old_id,
        }))
        const error = new Error(
          `Invalid project archive: unable to resolve parent links for ${pendingRows.length} node(s)`,
        )
        error.status = 400
        error.details = unresolvedParents
        throw error
      }
    }

    return buildTree(assertProject(projectId), getProjectNodes.all(projectId))
  } catch (error) {
    if (projectId != null) {
      try {
        deleteProjectRecursive(projectId)
      } catch {
        // Ignore cleanup failures and surface the original import error.
      }
    }
    throw error
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
}

function broadcastProjectEvent(projectId, payload = { type: 'project-updated' }) {
  const listeners = projectEventClients.get(projectId)
  if (!listeners || listeners.size === 0) {
    return
  }

  const body = `data: ${JSON.stringify(payload)}\n\n`
  for (const response of listeners) {
    response.write(body)
  }
}

function cleanupDesktopSessions() {
  const cutoff = Date.now() - CLIENT_TTL_MS
  for (const [sessionId, session] of activeDesktopSessions) {
    if (session.updatedAt < cutoff) {
      activeDesktopSessions.delete(sessionId)
    }
  }
}

function listProjectSessions(projectId) {
  cleanupDesktopSessions()
  return Array.from(activeDesktopSessions.values()).filter((session) => session.projectId === projectId)
}

function listProjectPresence(projectId, currentUserId = null) {
  const latestByUserId = new Map()
  for (const session of listProjectSessions(projectId)) {
    if (!session.userId || session.userId === currentUserId) {
      continue
    }
    const current = latestByUserId.get(session.userId)
    if (!current || current.updatedAt < session.updatedAt) {
      latestByUserId.set(session.userId, session)
    }
  }

  return Array.from(latestByUserId.values())
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((session) => ({
      userId: session.userId,
      username: session.username,
      selectedNodeId: session.selectedNodeId || null,
      selectedNodeName: session.selectedNodeName || null,
      updatedAt: session.updatedAt,
    }))
}

function cleanupMobileConnections() {
  const cutoff = Date.now() - MOBILE_CONNECTION_TTL_MS
  for (const [sessionId, connections] of activeMobileConnections) {
    for (const [connectionId, connection] of connections) {
      if (connection.updatedAt < cutoff) {
        connections.delete(connectionId)
      }
    }
    if (connections.size === 0) {
      activeMobileConnections.delete(sessionId)
    }
  }
}

function getMobileConnectionCount(sessionId) {
  cleanupMobileConnections()
  return activeMobileConnections.get(sessionId)?.size || 0
}

function getDesktopSession(sessionId) {
  cleanupDesktopSessions()
  return activeDesktopSessions.get(sessionId) || null
}

app.use(express.json({ limit: '5mb' }))

const serverContext = {
  OPENAI_IDENTIFICATION_MODEL,
  activeDesktopSessions,
  activeMobileConnections,
  assertIdentificationTemplateAccess,
  assertNode,
  assertNodeAccess,
  assertProject,
  assertProjectAccess,
  assertProjectOwner,
  broadcastProjectEvent,
  buildNodeIdentification,
  buildTree,
  clampAiDepth,
  claimOwnerlessProjectsStmt,
  clearAuthCookie,
  clearNodeIdentificationCreatorByUserStmt,
  clearNodeIdentificationReviewerByUserStmt,
  cleanupDesktopSessions,
  cleanupMobileConnections,
  countOwnedProjectsByUserStmt,
  countUsers,
  addNodeMedia,
  createNode,
  createProjectWithRoot,
  createUntitledName,
  db,
  decryptProjectSecret,
  distDir,
  deleteCollaboratorsByUserStmt,
  deleteIdentificationTemplateStmt,
  deleteNodeCollapsePrefsByUserStmt,
  deleteNodeIdentificationFieldValuesByNodeStmt,
  deleteNodeIdentificationFieldValuesByTemplateStmt,
  deleteNodeIdentificationStmt,
  deleteNodeIdentificationsByTemplateStmt,
  deleteNodeRecursive,
  deletePreferencesByUserStmt,
  deleteProjectCollaboratorStmt,
  deleteProjectRecursive,
  deleteSessionStmt,
  deleteSessionsByUserStmt,
  deleteUserStmt,
  encryptProjectSecret,
  ensureCanHaveChildren,
  ensureNoChildren,
  ensureNoCycle,
  ensureNodeBelongsToProject,
  ensureNotRoot,
  extractNodeMediaToSibling,
  exportProjectArchive,
  exportProjectMediaArchive,
  fs,
  generateToken,
  generateUniqueId,
  getDesktopSession,
  getIdentificationTemplate,
  getMobileConnectionCount,
  getNodeIdentification,
  getNodeIdentificationFieldValue,
  getOrCreateProjectPreferences,
  getProjectCollaborator,
  getProjectNodes,
  getProjectSecretConfigurationError,
  getRequestUser,
  getSessionByCaptureId,
  getUserById,
  getUserByUsername,
  hashPassword,
  importProjectArchive,
  importRestorePayloadRoutes,
  importUpload,
  insertIdentificationTemplate,
  insertProjectCollaborator,
  insertSession,
  insertUser,
  listAccessibleProjects,
  listIdentificationTemplatesByProject,
  listNodeIdentificationFieldValuesByProject,
  listNodeIdentificationsByProject,
  listProjectCollaborators,
  listProjectPresence,
  listProjectSessions,
  listSessionsByUserStmt,
  maskProjectApiKey,
  mergeNodeIntoTargetMedia,
  moveNode,
  normalizeIdentificationFieldDefinitions,
  normalizeIdentificationFieldValue,
  normalizePassword,
  normalizeProjectSettings,
  normalizeUserProjectUi,
  normalizeUsername,
  parseTags,
  path,
  projectEventClients,
  reassignNodeOwnersByUserStmt,
  renameProjectAndRoot,
  requireAuth,
  removeNodeMedia,
  resolveVariantAnchor,
  restoreProjectFromArchive,
  restoreSubtreeFromPayload,
  restoreUpload,
  runOpenAiIdentification,
  serializeIdentificationTemplate,
  serializeNodeForUser,
  serializeProject,
  setAuthCookie,
  updateSessionCaptureIdStmt,
  setPrimaryNodeMedia,
  setNodeCollapsedStateRecursive,
  setProjectCollapsedState,
  updateIdentificationTemplate,
  updateNodeMediaEdits,
  updateNode,
  updatePasswordStmt,
  updateProjectOpenAiKey,
  updateProjectAccess,
  updateProjectTimestamp,
  updateUsernameStmt,
  upsertNodeIdentification,
  upsertNodeIdentificationFieldValue,
  upsertUserNodeCollapsePreference,
  upsertUserProjectPreference,
  upload,
  uploadsDir,
  verifyPassword,
}

registerMediaAuthRoutes(app, serverContext)
registerSessionRoutes(app, serverContext)
registerProjectRoutes(app, serverContext)
registerNodeRoutes(app, serverContext)

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
      return next()
    }

    return res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use((error, req, res, _next) => {
  const requestedStatus = Number(error.status)
  const status = requestedStatus >= 100 && requestedStatus < 1000 ? requestedStatus : 500
  if (status >= 500) {
    console.error(error)
  }
  res.status(status).json({ error: error.message || 'Unexpected server error' })
})

app.listen(port, host, () => {
  console.log(`Nodetrace server listening on http://${host}:${port}`)
})
