export function registerProjectRoutes(app, ctx) {
  const {
    requireAuth,
    listAccessibleProjects,
    serializeProject,
    createProjectWithRoot,
    assertProjectAccess,
    assertProjectOwner,
    buildTree,
    getProjectNodes,
    renameProjectAndRoot,
    getOrCreateProjectPreferences,
    normalizeProjectSettings,
    normalizeUserProjectUi,
    upsertUserProjectPreference,
    broadcastProjectEvent,
    updateProjectOpenAiKey,
    encryptProjectSecret,
    maskProjectApiKey,
    getProjectSecretConfigurationError,
    clampAiDepth,
    normalizeIdentificationFieldDefinitions,
    insertIdentificationTemplate,
    generateUniqueId,
    getIdentificationTemplate,
    updateProjectTimestamp,
    updateIdentificationTemplate,
    assertIdentificationTemplateAccess,
    deleteNodeIdentificationFieldValuesByTemplateStmt,
    deleteNodeIdentificationsByTemplateStmt,
    deleteIdentificationTemplateStmt,
    listProjectCollaborators,
    getUserByUsername,
    normalizeUsername,
    getProjectCollaborator,
    insertProjectCollaborator,
    deleteProjectCollaboratorStmt,
    updateProjectAccess,
    setProjectCollapsedState,
    activeDesktopSessions,
    activeMobileConnections,
    deleteProjectRecursive,
    importRestorePayloadRoutes,
  } = ctx

  app.get('/api/projects', requireAuth, (req, res) => {
    const projects = listAccessibleProjects
      .all({ user_id: req.user.id })
      .map((project) => serializeProject(project, req.user.id))
    res.json(projects)
  })

  app.post('/api/projects', requireAuth, (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim()
      const description = String(req.body.description || '').trim()

      if (!name) {
        return res.status(400).json({ error: 'Project name is required' })
      }

      const projectId = createProjectWithRoot({ name, description, owner_user_id: req.user.id })
      const project = assertProjectAccess(projectId, req.user.id)
      const tree = buildTree(project, getProjectNodes.all(projectId), req.user.id)
      res.status(201).json(tree)
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const name = String(req.body?.name || '').trim()

      if (!name) {
        return res.json({ ok: false, error: 'Project name is required' })
      }

      renameProjectAndRoot({
        id: project.id,
        name,
      })

      const updatedProject = assertProjectAccess(project.id, req.user.id)
      res.json(buildTree(updatedProject, getProjectNodes.all(project.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/projects/:id/tree', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      const tree = buildTree(project, getProjectNodes.all(projectId), req.user.id)
      res.json(tree)
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id/settings', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      const currentPreferences = getOrCreateProjectPreferences(project, req.user.id)
      const nextSettings = normalizeProjectSettings({
        ...currentPreferences.settings,
        ...(req.body || {}),
      })
      upsertUserProjectPreference.run({
        user_id: req.user.id,
        project_id: projectId,
        settings_json: JSON.stringify(nextSettings),
        ui_json: JSON.stringify(currentPreferences.ui),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      broadcastProjectEvent(projectId)
      res.json(serializeProject(assertProjectAccess(projectId, req.user.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id/preferences', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      const currentPreferences = getOrCreateProjectPreferences(project, req.user.id)
      const nextUi = normalizeUserProjectUi({
        ...currentPreferences.ui,
        ...(req.body || {}),
      })

      upsertUserProjectPreference.run({
        user_id: req.user.id,
        project_id: projectId,
        settings_json: JSON.stringify(currentPreferences.settings),
        ui_json: JSON.stringify(nextUi),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      res.json(serializeProject(assertProjectAccess(projectId, req.user.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id/openai-key', requireAuth, (req, res) => {
    try {
      const project = assertProjectOwner(req.params.id, req.user.id)
      const apiKey = String(req.body?.apiKey || '').trim()
      if (!apiKey) {
        return res.json({ ok: false, error: 'API key is required' })
      }

      updateProjectOpenAiKey({
        id: project.id,
        encryptedKey: encryptProjectSecret(apiKey),
        keyMask: maskProjectApiKey(apiKey),
      })

      broadcastProjectEvent(project.id)
      res.json(serializeProject(assertProjectAccess(project.id, req.user.id), req.user.id))
    } catch (error) {
      return res.json({
        ok: false,
        error:
          error.message === 'NODETRACE_SECRET_KEY is not configured on the server'
            ? getProjectSecretConfigurationError()
            : error.message || 'Unable to save API key',
      })
    }
  })

  app.delete('/api/projects/:id/openai-key', requireAuth, (req, res) => {
    try {
      const project = assertProjectOwner(req.params.id, req.user.id)
      updateProjectOpenAiKey({
        id: project.id,
        encryptedKey: null,
        keyMask: null,
      })

      broadcastProjectEvent(project.id)
      res.json(serializeProject(assertProjectAccess(project.id, req.user.id), req.user.id))
    } catch (error) {
      return res.json({
        ok: false,
        error:
          error.message === 'NODETRACE_SECRET_KEY is not configured on the server'
            ? getProjectSecretConfigurationError()
            : error.message || 'Unable to clear API key',
      })
    }
  })

  app.post('/api/projects/:id/templates', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const name = String(req.body?.name || '').trim()
      const aiInstructions = String(req.body?.aiInstructions || '').trim()
      const parentDepth = clampAiDepth(req.body?.parentDepth)
      const childDepth = clampAiDepth(req.body?.childDepth)
      const fields = normalizeIdentificationFieldDefinitions(req.body?.fields)
      if (!name) {
        return res.json({ ok: false, error: 'Template name is required' })
      }

      const now = new Date().toISOString()
      insertIdentificationTemplate.run({
        id: generateUniqueId((candidate) => Boolean(getIdentificationTemplate.get(candidate))),
        project_id: project.id,
        system_key: null,
        name,
        ai_instructions: aiInstructions,
        parent_depth: parentDepth,
        child_depth: childDepth,
        fields_json: JSON.stringify(fields),
        created_at: now,
        updated_at: now,
      })
      updateProjectTimestamp.run(now, project.id)
      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(assertProjectAccess(project.id, req.user.id), getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      if (error?.status && error.status < 500) {
        return res.json({ ok: false, error: error.message })
      }
      next(error)
    }
  })

  app.patch('/api/projects/:id/templates/:templateId', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const template = assertIdentificationTemplateAccess(req.params.templateId, project.id)
      const name = String(req.body?.name || '').trim()
      const aiInstructions = String(req.body?.aiInstructions || '').trim()
      const parentDepth = clampAiDepth(req.body?.parentDepth)
      const childDepth = clampAiDepth(req.body?.childDepth)
      const fields = normalizeIdentificationFieldDefinitions(req.body?.fields)
      if (!name) {
        return res.json({ ok: false, error: 'Template name is required' })
      }

      updateIdentificationTemplate({
        templateId: template.id,
        name,
        aiInstructions,
        parentDepth,
        childDepth,
        fields,
      })
      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(assertProjectAccess(project.id, req.user.id), getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      if (error?.status && error.status < 500) {
        return res.json({ ok: false, error: error.message })
      }
      next(error)
    }
  })

  app.delete('/api/projects/:id/templates/:templateId', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const template = assertIdentificationTemplateAccess(req.params.templateId, project.id)

      deleteNodeIdentificationFieldValuesByTemplateStmt.run(template.id)
      deleteNodeIdentificationsByTemplateStmt.run(template.id)
      deleteIdentificationTemplateStmt.run(template.id)
      updateProjectTimestamp.run(new Date().toISOString(), project.id)
      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(assertProjectAccess(project.id, req.user.id), getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/projects/:id/collaborators', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      res.json({
        owner: project.owner_user_id ? { id: project.owner_user_id, username: project.owner_username } : null,
        isPublic: Boolean(project.is_public),
        collaborators: listProjectCollaborators.all(project.id),
        canManageUsers: project.owner_user_id === req.user.id,
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/collaborators', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectOwner(req.params.id, req.user.id)
      if (project.is_public) {
        return res.json({ ok: false, error: 'Public projects do not use collaborators' })
      }
      const username = normalizeUsername(req.body?.username)
      const collaborator = getUserByUsername.get(username)
      if (!collaborator) {
        return res.json({ ok: false, error: 'User not found' })
      }
      if (collaborator.id === req.user.id) {
        return res.json({ ok: false, error: 'Project owner is already included' })
      }
      if (!getProjectCollaborator.get(project.id, collaborator.id)) {
        insertProjectCollaborator.run({
          project_id: project.id,
          user_id: collaborator.id,
          added_by_user_id: req.user.id,
          created_at: new Date().toISOString(),
        })
      }
      res.status(201).json({
        ok: true,
        owner: project.owner_user_id ? { id: project.owner_user_id, username: project.owner_username } : null,
        isPublic: false,
        collaborators: listProjectCollaborators.all(project.id),
        canManageUsers: true,
      })
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/projects/:id/collaborators/:userId', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectOwner(req.params.id, req.user.id)
      if (project.is_public) {
        return res.json({ ok: false, error: 'Public projects do not use collaborators' })
      }
      deleteProjectCollaboratorStmt.run(project.id, String(req.params.userId || '').trim())
      res.json({
        owner: project.owner_user_id ? { id: project.owner_user_id, username: project.owner_username } : null,
        isPublic: false,
        collaborators: listProjectCollaborators.all(project.id),
        canManageUsers: true,
      })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id/access', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectOwner(req.params.id, req.user.id)
      updateProjectAccess({
        id: project.id,
        isPublic: Boolean(req.body?.isPublic),
      })
      broadcastProjectEvent(project.id)
      res.json(serializeProject(assertProjectAccess(project.id, req.user.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/collapse-all', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      const collapsed = Boolean(req.body?.collapsed)
      const updatedIds = setProjectCollapsedState({ userId: req.user.id, projectId, collapsed: collapsed ? 1 : 0 })
      broadcastProjectEvent(projectId)
      res.json({ updatedIds, collapsed })
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/projects/:id', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id
      broadcastProjectEvent(projectId, { type: 'project-deleted' })
      for (const [sessionId, session] of activeDesktopSessions) {
        if (session.projectId === projectId) {
          activeDesktopSessions.delete(sessionId)
          activeMobileConnections.delete(sessionId)
        }
      }
      deleteProjectRecursive(projectId)
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  importRestorePayloadRoutes(app, ctx)
}
