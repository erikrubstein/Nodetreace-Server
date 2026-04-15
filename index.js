import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import multer from 'multer'
import { initializeDatabase } from './db/bootstrap.js'
import { registerMediaAuthRoutes } from './routes/mediaAuthRoutes.js'
import { registerNodeRoutes } from './routes/nodeRoutes.js'
import { importRestorePayloadRoutes } from './routes/projectFileRoutes.js'
import { registerProjectRoutes } from './routes/projectRoutes.js'
import { registerSessionRoutes } from './routes/sessionRoutes.js'
import { defaultProjectSettings } from './shared/projectDefaults.js'
import { loadEnvFile, createAuthHelpers } from './server/auth.js'
import { createFileHelpers } from './server/files.js'
import { createIdentificationHelpers } from './server/identification.js'
import { createProjectNormalizationHelpers, createProjectModelHelpers } from './server/projectModel.js'
import { createAccessHelpers } from './server/access.js'
import { createArchiveHelpers } from './server/archive.js'
import { createPresenceHelpers } from './server/presence.js'

const app = express()
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const repoRootDir = serverDir
loadEnvFile(fs, path.join(repoRootDir, '.env'))
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

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(tempDir, { recursive: true })
fs.mkdirSync(path.join(tempDir, 'imports'), { recursive: true })
fs.mkdirSync(path.join(tempDir, 'restore'), { recursive: true })

const { generateUniqueId, generateToken } = createAuthHelpers({
  authCookie: AUTH_COOKIE,
  projectSecretRaw: PROJECT_SECRET_RAW,
})

const {
  defaultNodeImageEdits,
  parseTags,
  createUntitledName,
  normalizeNodeReviewStatus,
  normalizeNodeImageEdits,
  normalizeUserProjectUi,
  normalizeProjectSettings,
} = createProjectNormalizationHelpers()

const {
  sanitizeUploadName,
  sanitizeFilesystemName,
  toDataUrl,
} = createFileHelpers({
  fs,
  path,
  uploadsDir,
  generateUniqueId,
  normalizeNodeImageEdits,
})


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
    id, project_id, owner_user_id, parent_id, type, name, notes, tags_json,
    review_status, needs_attention, image_edits_json, added_at, created_at, updated_at
  ) VALUES (
    @id, @project_id, @owner_user_id, @parent_id, @type, @name, @notes, @tags_json,
    @review_status, @needs_attention, @image_edits_json, @added_at, @created_at, @updated_at
  )
`)
const getNodeMediaByIdStmt = db.prepare(`SELECT * FROM node_media WHERE id = ?`)
const listNodeMediaByNodeStmt = db.prepare(`
  SELECT *
  FROM node_media
  WHERE node_id = ?
  ORDER BY is_primary DESC, sort_order ASC, created_at ASC, id ASC
`)
const insertNodeMediaStmt = db.prepare(`
  INSERT INTO node_media (
    id,
    project_id,
    node_id,
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
const updateNodeMediaPlacementStmt = db.prepare(`
  UPDATE node_media
  SET node_id = @node_id,
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
const resetNodeMediaPrimaryFlagsStmt = db.prepare(`
  UPDATE node_media
  SET is_primary = 0,
      updated_at = @updated_at
  WHERE node_id = @node_id
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
    COUNT(n.id) AS node_count,
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
    COUNT(n.id) AS node_count,
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
const getNodeChildren = db.prepare(`SELECT id FROM nodes WHERE parent_id = ?`)
const listCollapsibleNodeIdsByProject = db.prepare(`
  SELECT DISTINCT parent.id
  FROM nodes child
  JOIN nodes parent ON child.parent_id = parent.id
  WHERE parent.project_id = ?
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
  const primaryMediaId = mediaRows.find((media) => Number(media.is_primary))?.id || mediaRows[0]?.id || null
  for (const media of mediaRows) {
    const isPrimary = media.id === primaryMediaId ? 1 : 0
    const sortOrder = media.id === primaryMediaId ? 0 : mediaRows.indexOf(media)
    if (
      media.node_id !== nodeId ||
      Number(media.is_primary || 0) !== isPrimary ||
      Number(media.sort_order || 0) !== sortOrder
    ) {
      updateNodeMediaPlacementStmt.run({
        id: media.id,
        node_id: nodeId,
        is_primary: isPrimary,
        sort_order: sortOrder,
        updated_at: new Date().toISOString(),
      })
    }
  }
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
      review_status: rootNode.review_status || 'new',
      needs_attention: rootNode.review_status === 'needs_attention' ? 1 : Number(rootNode.needs_attention || 0),
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
  })

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

const moveNode = db.transaction(({ id, project_id, parent_id }) => {
  const now = new Date().toISOString()
  updateNodeParentStmt.run({
    id,
    parent_id,
    updated_at: now,
  })
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

    const children = getNodeChildren.all(currentId)
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
    const children = getNodeChildren.all(current.id)
      for (const child of children) {
        stack.push({ id: child.id, visited: false })
      }
      continue
    }

    const mediaRows = listNodeMediaByNodeStmt.all(current.id)
    for (const filePath of mediaRows.flatMap((media) => [media.image_path, media.preview_path])) {
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
    for (const mediaRow of mediaRows) {
      deleteNodeMediaByIdStmt.run(mediaRow.id)
    }
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
  updateProjectTimestamp.run(now, projectId)
})

const addNodeMedia = db.transaction(({ nodeId, projectId, imagePath, previewPath, originalFilename, imageEdits }) => {
  assertNode(nodeId)
  const now = new Date().toISOString()
  const existingMedia = listNodeMediaByNodeStmt.all(nodeId)
  const mediaId = generateUniqueId((candidate) => Boolean(getNodeMediaByIdStmt.get(candidate)))
  insertNodeMediaStmt.run({
    id: mediaId,
    project_id: projectId,
    node_id: nodeId,
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
    is_primary: 1,
    sort_order: 0,
    updated_at: now,
  })
  resequenceNodeMedia(nodeId)
  updateProjectTimestamp.run(now, projectId)
})

const removeNodeMedia = db.transaction(({ nodeId, mediaId, projectId }) => {
  const media = assertNodeMedia(nodeId, mediaId)

  for (const filePath of [media.image_path, media.preview_path]) {
    if (!filePath) {
      continue
    }
    const absolutePath = path.join(uploadsDir, filePath)
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
    }
  }

  deleteNodeMediaByIdStmt.run(media.id)
  resequenceNodeMedia(nodeId)
  updateProjectTimestamp.run(new Date().toISOString(), projectId)
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
  insertNodeMediaStmt.run({
    id: generateUniqueId((candidate) => Boolean(getNodeMediaByIdStmt.get(candidate))),
    project_id: projectId,
    node_id: targetNode.id,
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

const extractNodeMediaToChild = db.transaction(({ nodeId, mediaId, projectId, ownerUserId }) => {
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
    type: 'photo',
    name: createUntitledName(),
    notes: '',
    tags: [],
    review_status: 'new',
    image_edits: defaultNodeImageEdits,
  })
  addNodeMedia({
    nodeId: newNodeId,
    projectId,
    imagePath: copiedMedia.image_path,
    previewPath: copiedMedia.preview_path,
    originalFilename: copiedMedia.original_filename,
    imageEdits: copiedMedia.image_edits,
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
  for (const mediaRow of listNodeMediaByProjectStmt.all(projectId)) {
    for (const filePath of [mediaRow.image_path, mediaRow.preview_path]) {
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
  for (const mediaRow of listNodeMediaByProjectStmt.all(projectId)) {
    for (const filePath of [mediaRow.image_path, mediaRow.preview_path]) {
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

const {
  clampAiDepth,
  normalizeIdentificationFieldDefinitions,
  normalizeIdentificationFieldValue,
  runOpenAiIdentification,
  serializeIdentificationTemplate,
  buildNodeIdentification,
} = createIdentificationHelpers({
  fs,
  path,
  uploadsDir,
  openAiIdentificationModel: OPENAI_IDENTIFICATION_MODEL,
  listNodeMediaByProjectStmt,
  countNodesUsingIdentificationTemplateStmt,
  toDataUrl,
})

const {
  getOrCreateProjectPreferences,
  serializeProject,
  serializeNodeForUser,
  buildTree,
} = createProjectModelHelpers({
  listIdentificationTemplatesByProject,
  listNodeIdentificationsByProject,
  listNodeIdentificationFieldValuesByProject,
  listNodeMediaByProjectStmt,
  listProjectCollaborators,
  getUserProjectPreference,
  upsertUserProjectPreference,
  hasChildNodeStmt,
  getUserNodeCollapsePreference,
  listUserNodeCollapsePrefsByProject,
  serializeIdentificationTemplate,
  buildNodeIdentification,
})

const {
  assertProject,
  getRequestUser,
  requireAuth,
  assertProjectAccess,
  assertProjectOwner,
  assertNode,
  assertNodeAccess,
  assertIdentificationTemplateAccess,
  ensureNodeBelongsToProject,
  ensureNotRoot,
  ensureCanHaveChildren,
  ensureNoChildren,
  ensureNoCycle,
} = createAccessHelpers({
  authCookie: AUTH_COOKIE,
  parseCookies,
  getProject,
  getSessionById,
  updateSessionTimestampStmt,
  getAccessibleProjectRow,
  getNode,
  getIdentificationTemplate,
  getNodeChildren,
})

const {
  exportProjectArchive,
  exportProjectMediaArchive,
  restoreProjectFromArchive,
  restoreSubtreeFromPayload,
  importProjectArchive,
} = createArchiveHelpers({
  fs,
  path,
  tempDir,
  uploadsDir,
  assertProject,
  buildTree,
  getProjectNodes,
  listIdentificationTemplatesByProject,
  serializeIdentificationTemplate,
  listNodeIdentificationsByProject,
  listNodeIdentificationFieldValuesByProject,
  listNodeMediaByProjectStmt,
  normalizeProjectSettings,
  normalizeNodeReviewStatus,
  normalizeNodeImageEdits,
  clampAiDepth,
  normalizeIdentificationFieldDefinitions,
  getProjectUploadDir,
  readUploadedFileData,
  sanitizeFilesystemName,
  sanitizeUploadName,
  addNodeMedia,
  createNode,
  updateProjectAccess,
  generateUniqueId,
  getIdentificationTemplate,
  insertIdentificationTemplate,
  upsertNodeIdentificationData,
  createProjectWithRoot,
  updateProjectSettings,
  updateNode,
  updateProjectMetaStmt,
  clearProjectContents,
  deleteProjectRecursive,
  insertNode,
  getNode,
  getUserById,
  updateProjectTimestamp,
  deleteIdentificationTemplatesByProjectStmt,
  createUntitledName,
  serializeNodeForUser,
  assertNode,
})

const {
  broadcastProjectEvent,
  cleanupDesktopSessions,
  listProjectSessions,
  listProjectPresence,
  cleanupMobileConnections,
  getMobileConnectionCount,
  getDesktopSession,
} = createPresenceHelpers({
  projectEventClients,
  activeDesktopSessions,
  activeMobileConnections,
  clientTtlMs: CLIENT_TTL_MS,
  mobileConnectionTtlMs: MOBILE_CONNECTION_TTL_MS,
})

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
  extractNodeMediaToChild,
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
