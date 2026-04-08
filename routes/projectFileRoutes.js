export function importRestorePayloadRoutes(app, ctx) {
  const {
    fs,
    path,
    uploadsDir,
    requireAuth,
    assertProject,
    assertProjectAccess,
    buildTree,
    getProjectNodes,
    exportProjectArchive,
    exportProjectMediaArchive,
    importUpload,
    importProjectArchive,
    restoreProjectFromArchive,
    restoreUpload,
    restoreSubtreeFromPayload,
    broadcastProjectEvent,
    getDesktopSession,
    assertNode,
    ensureNodeBelongsToProject,
    ensureCanHaveChildren,
    createNode,
    addNodeMedia,
    parseTags,
    createUntitledName,
    serializeNodeForUser,
    upsertNodeIdentification,
    upsertUserNodeCollapsePreference,
    assertIdentificationTemplateAccess,
  } = ctx

  function cleanupUploadedFiles(files = []) {
    for (const file of files) {
      if (!file?.path || !fs.existsSync(file.path)) {
        continue
      }
      try {
        fs.unlinkSync(file.path)
      } catch {
        // Ignore temp cleanup failures after request completion.
      }
    }
  }

  function resolvePhotoUploadIntent(body) {
    const uploadMode = String(body.uploadMode || body.mode || '').trim().toLowerCase()
    const additionalPhotoRequested =
      uploadMode === 'additional_photo' ||
      String(body.additionalPhoto || '').trim() === 'true'
    const additionalPhotoOfId =
      body.additionalPhotoOfId != null
        ? String(body.additionalPhotoOfId).trim()
        : null

    return { additionalPhotoRequested, additionalPhotoOfId }
  }

  function handleCreateNode(req, res, next) {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      const clientId = String(req.body.clientId || '').trim()
      let parentId = String(req.body.parentId || '').trim() || null
      if (!parentId && clientId) {
        if (clientId !== req.user.captureSessionId) {
          return res.status(403).json({ error: 'Session mismatch' })
        }
        const controllingClient = getDesktopSession(clientId)
        if (!controllingClient) {
          return res.status(400).json({ error: 'Selected client is not active' })
        }
        if (controllingClient.projectId !== projectId) {
          return res.status(400).json({ error: 'Selected client is controlling a different project' })
        }
        parentId = controllingClient.selectedNodeId
      }

      const parentNode = assertNode(parentId)
      ensureNodeBelongsToProject(parentNode, projectId)
      ensureCanHaveChildren(parentNode)

      const name = String(req.body.name || '').trim()
      if (!name) {
        return res.status(400).json({ error: 'Node name is required' })
      }

      const nodeId = createNode({
        project_id: projectId,
        owner_user_id: req.user.id,
        parent_id: parentNode.id,
        type: 'folder',
        name,
        notes: String(req.body.notes || '').trim(),
        tags: parseTags(req.body.tags),
        image_path: null,
        preview_path: null,
        original_filename: null,
      })
      const now = new Date().toISOString()
      upsertUserNodeCollapsePreference.run({
        user_id: req.user.id,
        project_id: projectId,
        node_id: nodeId,
        collapsed: 0,
        created_at: now,
        updated_at: now,
      })

      broadcastProjectEvent(projectId)
      res.status(201).json(serializeNodeForUser(assertNode(nodeId), req.user.id))
    } catch (error) {
      next(error)
    }
  }

  app.get('/api/projects/:id/export', requireAuth, (req, res, next) => {
    let archivePath = null

    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      archivePath = exportProjectArchive(projectId)
      const safeName = project.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `project-${projectId}`
      res.download(archivePath, `${safeName}.zip`, (downloadError) => {
        if (archivePath && fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath)
        }
        if (downloadError && downloadError.code !== 'ECONNABORTED') {
          next(downloadError)
        }
      })
    } catch (error) {
      if (archivePath && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath)
      }
      next(error)
    }
  })

  app.get('/api/projects/:id/export-media', requireAuth, (req, res, next) => {
    let archivePath = null

    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      archivePath = exportProjectMediaArchive(projectId)
      const safeName = project.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `project-${projectId}`
      res.download(archivePath, `${safeName}-media.zip`, (downloadError) => {
        if (archivePath && fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath)
        }
        if (downloadError && downloadError.code !== 'ECONNABORTED') {
          next(downloadError)
        }
      })
    } catch (error) {
      if (archivePath && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath)
      }
      next(error)
    }
  })

  app.get('/api/projects/:id/snapshot', requireAuth, (req, res, next) => {
    let archivePath = null

    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      archivePath = exportProjectArchive(projectId)
      res.type('application/zip')
      res.sendFile(archivePath, (sendError) => {
        if (archivePath && fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath)
        }
        if (sendError && sendError.code !== 'ECONNABORTED') {
          next(sendError)
        }
      })
    } catch (error) {
      if (archivePath && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath)
      }
      next(error)
    }
  })

  app.post('/api/projects/import', requireAuth, importUpload.single('archive'), (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Project archive is required' })
      }

      const archivePath = `${req.file.path}${path.extname(req.file.originalname || '') || '.zip'}`
      fs.renameSync(req.file.path, archivePath)
      const importedTree = importProjectArchive(archivePath, String(req.body.projectName || '').trim(), req.user.id)
      fs.unlinkSync(archivePath)
      res.status(201).json(buildTree(assertProjectAccess(importedTree.project.id, req.user.id), getProjectNodes.all(importedTree.project.id), req.user.id))
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path)
      }
      const archivePath = req.file?.path
        ? `${req.file.path}${path.extname(req.file.originalname || '') || '.zip'}`
        : null
      if (archivePath && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath)
      }
      next(error)
    }
  })

  app.post('/api/projects/:id/restore', requireAuth, importUpload.single('archive'), (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      if (!req.file) {
        return res.status(400).json({ error: 'Project archive is required' })
      }

      const archivePath = `${req.file.path}${path.extname(req.file.originalname || '') || '.zip'}`
      fs.renameSync(req.file.path, archivePath)
      restoreProjectFromArchive(projectId, archivePath)
      fs.unlinkSync(archivePath)
      broadcastProjectEvent(projectId)
      res.json(buildTree(assertProjectAccess(projectId, req.user.id), getProjectNodes.all(projectId), req.user.id))
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path)
      }
      const archivePath = req.file?.path
        ? `${req.file.path}${path.extname(req.file.originalname || '') || '.zip'}`
        : null
      if (archivePath && fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath)
      }
      next(error)
    }
  })

  app.post('/api/projects/:id/folders', requireAuth, handleCreateNode)
  app.post('/api/projects/:id/nodes', requireAuth, handleCreateNode)

  app.post('/api/projects/:id/photos', requireAuth, ctx.upload.fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]), (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      const clientId = String(req.body.clientId || '').trim()
      const { additionalPhotoRequested, additionalPhotoOfId } = resolvePhotoUploadIntent(req.body)
      let parentId = String(req.body.parentId || '').trim() || null
      let additionalPhotoNodeId = additionalPhotoOfId
      if (!parentId && clientId) {
        if (clientId !== req.user.captureSessionId) {
          return res.status(403).json({ error: 'Session mismatch' })
        }
        const controllingClient = getDesktopSession(clientId)
        if (!controllingClient) {
          return res.status(400).json({ error: 'Selected client is not active' })
        }
        if (controllingClient.projectId !== projectId) {
          return res.status(400).json({ error: 'Selected client is controlling a different project' })
        }
        if (additionalPhotoRequested) {
          additionalPhotoNodeId = controllingClient.selectedNodeId
        } else {
          parentId = controllingClient.selectedNodeId
        }
      }

      if (additionalPhotoRequested || additionalPhotoNodeId) {
        const targetNode = assertNode(additionalPhotoNodeId)
        ensureNodeBelongsToProject(targetNode, projectId)
        additionalPhotoNodeId = targetNode.id
      }

      const parentNode = parentId != null ? assertNode(parentId) : null
      if (parentNode) {
        ensureNodeBelongsToProject(parentNode, projectId)
        if (!additionalPhotoNodeId) {
          ensureCanHaveChildren(parentNode)
        }
      }

      const originalFile = req.files?.file?.[0]
      const previewFile = req.files?.preview?.[0] || null
      const templateId = String(req.body.templateId || '').trim() || null
      let imageEdits = null

      if (!originalFile) {
        return res.status(400).json({ error: 'Photo file is required' })
      }

      if (req.body.imageEdits) {
        try {
          imageEdits = JSON.parse(String(req.body.imageEdits))
        } catch {
          return res.status(400).json({ error: 'Invalid image edits payload' })
        }
      }

      const template = templateId ? assertIdentificationTemplateAccess(templateId, projectId) : null

      if (additionalPhotoRequested || additionalPhotoNodeId) {
        const mediaId = addNodeMedia({
          nodeId: additionalPhotoNodeId,
          projectId,
          imagePath: path.relative(uploadsDir, originalFile.path),
          previewPath: previewFile ? path.relative(uploadsDir, previewFile.path) : null,
          originalFilename: originalFile.originalname,
          imageEdits,
        })

        broadcastProjectEvent(projectId)
        return res.status(201).json({
          mode: 'additional_photo',
          mediaId,
          node: serializeNodeForUser(assertNode(additionalPhotoNodeId), req.user.id),
        })
      }

      const requestedName = String(req.body.name || '').trim()
      const resolvedName =
        requestedName && requestedName !== '<untitled>' ? requestedName : createUntitledName(projectId)
      const nodeId = createNode({
        project_id: projectId,
        owner_user_id: req.user.id,
        parent_id: parentNode?.id ?? null,
        type: 'photo',
        name: resolvedName,
        notes: String(req.body.notes || '').trim(),
        tags: parseTags(req.body.tags),
        image_edits: null,
      })
      addNodeMedia({
        nodeId,
        projectId,
        imagePath: path.relative(uploadsDir, originalFile.path),
        previewPath: previewFile ? path.relative(uploadsDir, previewFile.path) : null,
        originalFilename: originalFile.originalname,
        imageEdits,
      })
      const collapseTimestamp = new Date().toISOString()
      upsertUserNodeCollapsePreference.run({
        user_id: req.user.id,
        project_id: projectId,
        node_id: nodeId,
        collapsed: 0,
        created_at: collapseTimestamp,
        updated_at: collapseTimestamp,
      })

      if (template) {
        const now = new Date().toISOString()
        upsertNodeIdentification.run({
          node_id: nodeId,
          template_id: template.id,
          created_by_user_id: req.user.id,
          created_at: now,
          updated_at: now,
        })
      }

      broadcastProjectEvent(projectId)
      res.status(201).json({
        mode: 'photo_node',
        createdNodeId: nodeId,
        node: serializeNodeForUser(assertNode(nodeId), req.user.id),
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/sessions/:sessionId/photos', ctx.upload.fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]), (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      const session = getDesktopSession(sessionId)
      if (!session) {
        return res.status(404).json({ error: 'Session is not active' })
      }

      const project = assertProject(session.projectId)
      const projectId = project.id
      const { additionalPhotoRequested } = resolvePhotoUploadIntent(req.body)
      let parentId = session.selectedNodeId
      let additionalPhotoNodeId = null

      if (additionalPhotoRequested) {
        const targetNode = assertNode(session.selectedNodeId)
        ensureNodeBelongsToProject(targetNode, projectId)
        additionalPhotoNodeId = targetNode.id
      }

      const parentNode = parentId != null ? assertNode(parentId) : null
      if (parentNode) {
        ensureNodeBelongsToProject(parentNode, projectId)
        if (!additionalPhotoNodeId) {
          ensureCanHaveChildren(parentNode)
        }
      }

      const originalFile = req.files?.file?.[0]
      const previewFile = req.files?.preview?.[0] || null
      const templateId = String(req.body.templateId || '').trim() || null
      let imageEdits = null
      if (!originalFile) {
        return res.status(400).json({ error: 'Photo file is required' })
      }

      if (req.body.imageEdits) {
        try {
          imageEdits = JSON.parse(String(req.body.imageEdits))
        } catch {
          return res.status(400).json({ error: 'Invalid image edits payload' })
        }
      }

      const template = templateId ? assertIdentificationTemplateAccess(templateId, projectId) : null

      if (additionalPhotoRequested) {
        const mediaId = addNodeMedia({
          nodeId: additionalPhotoNodeId,
          projectId,
          imagePath: path.relative(uploadsDir, originalFile.path),
          previewPath: previewFile ? path.relative(uploadsDir, previewFile.path) : null,
          originalFilename: originalFile.originalname,
          imageEdits,
        })

        broadcastProjectEvent(projectId)
        return res.status(201).json({
          mode: 'additional_photo',
          mediaId,
          node: serializeNodeForUser(assertNode(additionalPhotoNodeId), null),
        })
      }

      const requestedName = String(req.body.name || '').trim()
      const resolvedName =
        requestedName && requestedName !== '<untitled>' ? requestedName : createUntitledName(projectId)
      const nodeId = createNode({
        project_id: projectId,
        owner_user_id: session.userId || project.owner_user_id || null,
        parent_id: parentNode?.id ?? null,
        type: 'photo',
        name: resolvedName,
        notes: String(req.body.notes || '').trim(),
        tags: parseTags(req.body.tags),
        image_edits: null,
      })
      addNodeMedia({
        nodeId,
        projectId,
        imagePath: path.relative(uploadsDir, originalFile.path),
        previewPath: previewFile ? path.relative(uploadsDir, previewFile.path) : null,
        originalFilename: originalFile.originalname,
        imageEdits,
      })
      const collapseTimestamp = new Date().toISOString()
      if (session.userId) {
        upsertUserNodeCollapsePreference.run({
          user_id: session.userId,
          project_id: projectId,
          node_id: nodeId,
          collapsed: 0,
          created_at: collapseTimestamp,
          updated_at: collapseTimestamp,
        })
      }

      if (template) {
        const now = new Date().toISOString()
        upsertNodeIdentification.run({
          node_id: nodeId,
          template_id: template.id,
          created_by_user_id: session.userId || project.owner_user_id || null,
          created_at: now,
          updated_at: now,
        })
      }

      broadcastProjectEvent(projectId)
      res.status(201).json({
        mode: 'photo_node',
        createdNodeId: nodeId,
        node: serializeNodeForUser(assertNode(nodeId), null),
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/subtree-restore', requireAuth, restoreUpload.any(), (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      const manifest = JSON.parse(String(req.body.manifest || '{}'))
      const restoredRoot = restoreSubtreeFromPayload(projectId, manifest, req.files || [])
      broadcastProjectEvent(projectId)
      res.status(201).json(restoredRoot)
    } catch (error) {
      next(error)
    } finally {
      cleanupUploadedFiles(req.files || [])
    }
  })
}
