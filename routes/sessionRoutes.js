export function registerSessionRoutes(app, ctx) {
  const {
    requireAuth,
    assertProjectAccess,
    listProjectSessions,
    assertNode,
    ensureNodeBelongsToProject,
    activeDesktopSessions,
    cleanupDesktopSessions,
    getDesktopSession,
    getMobileConnectionCount,
    activeMobileConnections,
    projectEventClients,
    listProjectPresence,
  } = ctx

  app.get('/api/projects/:id/clients', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      const clients = listProjectSessions(projectId).sort((a, b) => a.id.localeCompare(b.id))
      res.json(
        clients.map((client) => ({
          id: client.id,
          name: `Session ${client.id}`,
          selectedNodeId: client.selectedNodeId,
          selectedNodeName: client.selectedNodeName,
        })),
      )
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/projects/:id/clients/:clientId', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      const clientId = String(req.params.clientId || '').trim()
      if (clientId !== req.user.captureSessionId) {
        return res.status(403).json({ error: 'Session mismatch' })
      }
      const name = String(req.body.name || '').trim()
      const selectedNodeId = String(req.body.selectedNodeId || '').trim()
      const selectedNode = assertNode(selectedNodeId)
      ensureNodeBelongsToProject(selectedNode, projectId)

      activeDesktopSessions.set(clientId, {
        id: clientId,
        name: name || `Session ${clientId}`,
        userId: req.user.id,
        username: req.user.username,
        projectId,
        projectName: project.name,
        selectedNodeId,
        selectedNodeName: selectedNode.name,
        updatedAt: Date.now(),
      })

      cleanupDesktopSessions()
      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/sessions/:sessionId', (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      const session = getDesktopSession(sessionId)
      if (!session) {
        return res.json({ ok: false, error: 'Session is not active', connectionCount: 0 })
      }

      res.json({
        ok: true,
        id: session.id,
        projectId: session.projectId,
        projectName: session.projectName,
        selectedNodeId: session.selectedNodeId,
        selectedNodeName: session.selectedNodeName,
        connectionCount: getMobileConnectionCount(session.id),
      })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/sessions/:sessionId', requireAuth, (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      if (sessionId !== req.user.captureSessionId) {
        return res.status(403).json({ error: 'Session mismatch' })
      }
      const project = assertProjectAccess(req.body.projectId, req.user.id)
      const projectId = project.id
      const selectedNodeId = String(req.body.selectedNodeId || '').trim()
      const selectedNode = assertNode(selectedNodeId)
      ensureNodeBelongsToProject(selectedNode, projectId)

      activeDesktopSessions.set(sessionId, {
        id: sessionId,
        name: `Session ${sessionId}`,
        userId: req.user.id,
        username: req.user.username,
        projectId,
        projectName: project.name,
        selectedNodeId,
        selectedNodeName: selectedNode.name,
        updatedAt: Date.now(),
      })

      cleanupDesktopSessions()
      res.json({
        ok: true,
        id: sessionId,
        projectId,
        projectName: project.name,
        selectedNodeId,
        selectedNodeName: selectedNode.name,
        connectionCount: getMobileConnectionCount(sessionId),
      })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/sessions/:sessionId/connections/:connectionId', (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      const connectionId = String(req.params.connectionId || '').trim().toLowerCase()
      const session = getDesktopSession(sessionId)
      if (!session) {
        return res.status(404).json({ error: 'Session is not active' })
      }

      let connections = activeMobileConnections.get(sessionId)
      if (!connections) {
        connections = new Map()
        activeMobileConnections.set(sessionId, connections)
      }
      connections.set(connectionId, {
        id: connectionId,
        updatedAt: Date.now(),
      })

      res.json({
        ok: true,
        connectionCount: getMobileConnectionCount(sessionId),
      })
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/sessions/:sessionId/connections/:connectionId', (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      const connectionId = String(req.params.connectionId || '').trim().toLowerCase()
      const connections = activeMobileConnections.get(sessionId)
      if (connections) {
        connections.delete(connectionId)
        if (connections.size === 0) {
          activeMobileConnections.delete(sessionId)
        }
      }
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/sessions/:sessionId/connections/:connectionId/release', (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '').trim().toLowerCase()
      const connectionId = String(req.params.connectionId || '').trim().toLowerCase()
      const connections = activeMobileConnections.get(sessionId)
      if (connections) {
        connections.delete(connectionId)
        if (connections.size === 0) {
          activeMobileConnections.delete(sessionId)
        }
      }
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/projects/:id/events', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const projectId = project.id

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

      let listeners = projectEventClients.get(projectId)
      if (!listeners) {
        listeners = new Set()
        projectEventClients.set(projectId, listeners)
      }
      listeners.add(res)

      const heartbeat = setInterval(() => {
        res.write(': keep-alive\n\n')
      }, 20000)

      req.on('close', () => {
        clearInterval(heartbeat)
        listeners.delete(res)
        if (listeners.size === 0) {
          projectEventClients.delete(projectId)
        }
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/projects/:id/presence', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      res.json({
        users: listProjectPresence(project.id, req.user.id),
      })
    } catch (error) {
      next(error)
    }
  })
}
