import { defaultProjectSettings, defaultUserProjectUi } from '../shared/projectDefaults.js'

export const defaultNodeImageEdits = {
  crop: null,
  brightness: 0,
  contrast: 100,
  exposure: 0,
  sharpness: 0,
  denoise: 0,
  invert: false,
  rotationTurns: 0,
}

export function createProjectNormalizationHelpers() {
  function normalizeNodeReviewStatus(input) {
    const value = String(input || '').trim().toLowerCase()
    if (value === 'needs_attention' || value === 'reviewed') {
      return value
    }
    return 'new'
  }

  function parseTags(input) {
    if (!input) {
      return []
    }

    const normalizeTag = (tag) => String(tag || '').trim()
    const isReservedTag = (tag) => normalizeTag(tag).toLowerCase() === 'any'

    if (Array.isArray(input)) {
      return input.map(normalizeTag).filter((tag) => tag && !isReservedTag(tag))
    }

    return String(input)
      .split(',')
      .map(normalizeTag)
      .filter((tag) => tag && !isReservedTag(tag))
  }

  function createUntitledName() {
    return 'Node'
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

  return {
    defaultNodeImageEdits,
    parseTags,
    createUntitledName,
    normalizeNodeReviewStatus,
    normalizeNodeImageEdits,
    normalizeUserProjectUi,
    normalizeProjectSettings,
  }
}

export function createProjectModelHelpers({
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
}) {
  function normalizeNodeReviewStatus(input) {
    const value = String(input || '').trim().toLowerCase()
    if (value === 'needs_attention' || value === 'reviewed') {
      return value
    }
    return 'new'
  }

  function parseTags(input) {
    if (!input) {
      return []
    }

    const normalizeTag = (tag) => String(tag || '').trim()
    const isReservedTag = (tag) => normalizeTag(tag).toLowerCase() === 'any'

    if (Array.isArray(input)) {
      return input.map(normalizeTag).filter((tag) => tag && !isReservedTag(tag))
    }

    return String(input)
      .split(',')
      .map(normalizeTag)
      .filter((tag) => tag && !isReservedTag(tag))
  }

  function createUntitledName() {
    return 'Node'
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

  function serializeNode(row, identification = null, mediaRows = []) {
    const media = mediaRows.map(serializeNodeMedia)
    const primaryMedia = media.find((item) => item.isPrimary) || media[0] || null
    const normalizedReviewStatus = normalizeNodeReviewStatus(
      row.review_status || (row.needs_attention ? 'needs_attention' : 'new'),
    )

    return {
      id: row.id,
      ownerUserId: row.owner_user_id || null,
      ownerUsername: row.owner_username || null,
      parent_id: row.parent_id,
      type: row.type,
      name: row.name,
      notes: row.notes,
      added_at: row.added_at || row.created_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      tags: JSON.parse(row.tags_json || '[]'),
      reviewStatus: normalizedReviewStatus,
      needsAttention: normalizedReviewStatus === 'needs_attention',
      imageEdits: primaryMedia?.imageEdits || normalizeNodeImageEdits(JSON.parse(row.image_edits_json || '{}')),
      collapsed: false,
      identification,
      hasImage: Boolean(primaryMedia?.imageUrl),
      imageUrl: primaryMedia?.imageUrl || null,
      previewUrl: primaryMedia?.previewUrl || null,
      primaryMediaId: primaryMedia?.id || null,
      mediaCount: media.length,
      media,
    }
  }

  function serializeProject(row, userId) {
    const templates = listIdentificationTemplatesByProject.all(row.id).map(serializeIdentificationTemplate)
    const preferences = userId
      ? getOrCreateProjectPreferences(row, userId)
      : {
          settings: normalizeProjectSettings(JSON.parse(row.settings_json || '{}')),
          ui: normalizeUserProjectUi({}),
        }
    const collaborators = listProjectCollaborators.all(row.id).map((collaborator) => ({
      id: collaborator.id,
      username: collaborator.username,
    }))

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

  function buildIdentificationMaps(projectId) {
    const templateRowsById = new Map(
      listIdentificationTemplatesByProject
        .all(projectId)
        .map(serializeIdentificationTemplate)
        .map((template) => [template.id, template]),
    )
    const identificationRowsByNodeId = new Map(
      listNodeIdentificationsByProject.all(projectId).map((item) => [item.node_id, item]),
    )
    const fieldRowsByNodeId = new Map()
    for (const fieldRow of listNodeIdentificationFieldValuesByProject.all(projectId)) {
      const items = fieldRowsByNodeId.get(fieldRow.node_id) || []
      items.push(fieldRow)
      fieldRowsByNodeId.set(fieldRow.node_id, items)
    }
    const mediaRowsByNodeId = new Map()
    for (const mediaRow of listNodeMediaByProjectStmt.all(projectId)) {
      const items = mediaRowsByNodeId.get(mediaRow.node_id) || []
      items.push(mediaRow)
      mediaRowsByNodeId.set(mediaRow.node_id, items)
    }
    return { templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId, mediaRowsByNodeId }
  }

  function serializeNodeForUser(row, userId) {
    if (!row) {
      return null
    }
    const { templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId, mediaRowsByNodeId } =
      buildIdentificationMaps(row.project_id)
    const node = serializeNode(
      row,
      buildNodeIdentification(row.id, templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId),
      mediaRowsByNodeId.get(row.id) || [],
    )
    if (!hasChildNodeStmt.get(row.id)) {
      return node
    }
    const preference = userId ? getUserNodeCollapsePreference.get(userId, row.id) : null
    node.collapsed = preference == null ? true : Boolean(preference.collapsed)
    return node
  }

  function buildTree(project, rows, userId = null) {
    const { templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId, mediaRowsByNodeId } =
      buildIdentificationMaps(project.id)
    const collapsedMap = userId
      ? new Map(listUserNodeCollapsePrefsByProject.all(userId, project.id).map((row) => [row.node_id, Boolean(row.collapsed)]))
      : null

    const nodes = rows.map((row) =>
      serializeNode(
        row,
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

  return {
    defaultNodeImageEdits,
    parseTags,
    createUntitledName,
    normalizeNodeReviewStatus,
    normalizeNodeImageEdits,
    normalizeUserProjectUi,
    normalizeProjectSettings,
    getOrCreateProjectPreferences,
    serializeProject,
    serializeNodeForUser,
    buildTree,
  }
}
