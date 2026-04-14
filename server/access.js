export function createAccessHelpers({
  authCookie,
  parseCookies,
  getProject,
  getSessionById,
  updateSessionTimestampStmt,
  getAccessibleProjectRow,
  getNode,
  getIdentificationTemplate,
  getNodeChildren,
}) {
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
    const sessionId = String(cookies[authCookie] || '').trim()
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
    if (node.parent_id == null) {
      const error = new Error('The project root cannot be deleted or moved')
      error.status = 400
      throw error
    }
  }

  function ensureCanHaveChildren(_node) {}

  function ensureNoChildren(node) {
    const children = getNodeChildren.all(node.id)
    if (children.length > 0) {
      const error = new Error('Only leaf nodes can be converted into a photo on their parent')
      error.status = 400
      throw error
    }
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

  return {
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
  }
}
