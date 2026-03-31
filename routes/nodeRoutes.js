export function registerNodeRoutes(app, ctx) {
  const {
    requireAuth,
    assertNodeAccess,
    parseTags,
    updateNode,
    broadcastProjectEvent,
    serializeNodeForUser,
    assertNode,
    assertIdentificationTemplateAccess,
    getNodeIdentification,
    deleteNodeIdentificationFieldValuesByNodeStmt,
    upsertNodeIdentification,
    updateProjectTimestamp,
    deleteNodeIdentificationStmt,
    getNodeIdentificationFieldValue,
    serializeIdentificationTemplate,
    normalizeIdentificationFieldValue,
    upsertNodeIdentificationFieldValue,
    assertProjectAccess,
    decryptProjectSecret,
    getProjectSecretConfigurationError,
    listIdentificationTemplatesByProject,
    listNodeIdentificationsByProject,
    listNodeIdentificationFieldValuesByProject,
    buildNodeIdentification,
    getProjectNodes,
    runOpenAiIdentification,
    OPENAI_IDENTIFICATION_MODEL,
    setNodeCollapsedStateRecursive,
    ensureNotRoot,
    ensureNoChildren,
    ensureNodeBelongsToProject,
    resolveVariantAnchor,
    mergeNodeIntoTargetMedia,
    moveNode,
    ensureCanHaveChildren,
    ensureNoCycle,
    deleteNodeRecursive,
    updateNodeMediaEdits,
    removeNodeMedia,
    setPrimaryNodeMedia,
    extractNodeMediaToSibling,
    buildTree,
  } = ctx

  app.patch('/api/nodes/:id', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name')
      const hasNotes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')
      const hasTags = Object.prototype.hasOwnProperty.call(req.body || {}, 'tags')
      const hasReviewStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'reviewStatus')
      const hasNeedsAttention = Object.prototype.hasOwnProperty.call(req.body || {}, 'needsAttention')
      const hasImageEdits = Object.prototype.hasOwnProperty.call(req.body || {}, 'imageEdits')
      const requestedName = hasName ? String(req.body.name || '').trim() : node.name

      if (node.parent_id == null && requestedName && requestedName !== node.name) {
        return res.json({ ok: false, error: 'Rename the project to rename the root node' })
      }

      updateNode({
        id: node.id,
        project_id: node.project_id,
        name: requestedName || node.name,
        notes: hasNotes ? String(req.body.notes || '').trim() : (node.notes || ''),
        tags: hasTags ? parseTags(req.body.tags) : JSON.parse(node.tags_json || '[]'),
        review_status: hasReviewStatus
          ? req.body.reviewStatus
          : hasNeedsAttention
            ? (req.body.needsAttention ? 'needs_attention' : 'new')
            : node.review_status,
        image_edits: hasImageEdits ? req.body.imageEdits : JSON.parse(node.image_edits_json || '{}'),
      })

      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/identification', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const template = assertIdentificationTemplateAccess(req.body?.templateId, node.project_id)
      const now = new Date().toISOString()
      const existing = getNodeIdentification.get(node.id)

      if (!existing || existing.template_id !== template.id) {
        deleteNodeIdentificationFieldValuesByNodeStmt.run(node.id)
      }

      upsertNodeIdentification.run({
        node_id: node.id,
        template_id: template.id,
        created_by_user_id: existing?.created_by_user_id || req.user.id,
        created_at: existing?.created_at || now,
        updated_at: now,
      })

      updateProjectTimestamp.run(now, node.project_id)
      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/nodes/:id/identification', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      deleteNodeIdentificationFieldValuesByNodeStmt.run(node.id)
      deleteNodeIdentificationStmt.run(node.id)
      updateProjectTimestamp.run(new Date().toISOString(), node.project_id)
      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/identification/apply-bulk', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const template = assertIdentificationTemplateAccess(req.body?.templateId, project.id)
      const requestedNodeIds = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : []
      const targetNodes = Array.from(
        new Map(
          requestedNodeIds
            .map((nodeId) => assertNodeAccess(String(nodeId || '').trim(), req.user.id))
            .filter((node) => node.project_id === project.id)
            .map((node) => [node.id, node]),
        ).values(),
      )

      if (!targetNodes.length) {
        return res.status(400).json({ error: 'Select at least one node' })
      }

      const now = new Date().toISOString()
      for (const node of targetNodes) {
        const existing = getNodeIdentification.get(node.id)
        if (!existing || existing.template_id !== template.id) {
          deleteNodeIdentificationFieldValuesByNodeStmt.run(node.id)
        }

        upsertNodeIdentification.run({
          node_id: node.id,
          template_id: template.id,
          created_by_user_id: existing?.created_by_user_id || req.user.id,
          created_at: existing?.created_at || now,
          updated_at: now,
        })
      }

      updateProjectTimestamp.run(now, project.id)
      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(project, getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/identification/remove-bulk', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const requestedNodeIds = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : []
      const targetNodes = Array.from(
        new Map(
          requestedNodeIds
            .map((nodeId) => assertNodeAccess(String(nodeId || '').trim(), req.user.id))
            .filter((node) => node.project_id === project.id)
            .map((node) => [node.id, node]),
        ).values(),
      )

      if (!targetNodes.length) {
        return res.status(400).json({ error: 'Select at least one node' })
      }

      const now = new Date().toISOString()
      for (const node of targetNodes) {
        deleteNodeIdentificationFieldValuesByNodeStmt.run(node.id)
        deleteNodeIdentificationStmt.run(node.id)
      }

      updateProjectTimestamp.run(now, project.id)
      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(project, getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/nodes/:id/identification/fields/:fieldKey', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const assignment = getNodeIdentification.get(node.id)
      if (!assignment) {
        return res.json({ ok: false, error: 'Apply a template before editing identification fields' })
      }

      const template = assertIdentificationTemplateAccess(assignment.template_id, node.project_id)
      const templateFields = serializeIdentificationTemplate(template).fields
      const fieldKey = String(req.params.fieldKey || '').trim()
      const field = templateFields.find((item) => item.key === fieldKey)
      if (!field) {
        return res.json({ ok: false, error: 'Identification field not found' })
      }

      const existing = getNodeIdentificationFieldValue.get(node.id, field.key)
      const currentValue = existing
        ? normalizeIdentificationFieldValue(field, JSON.parse(existing.value_json || 'null'))
        : field.type === 'list'
          ? []
          : ''
      const hasIncomingValue = Object.prototype.hasOwnProperty.call(req.body || {}, 'value')
      const nextValue = hasIncomingValue
        ? normalizeIdentificationFieldValue(field, req.body.value)
        : currentValue
      const valueChanged = JSON.stringify(nextValue) !== JSON.stringify(currentValue)
      const wantsReviewed = Object.prototype.hasOwnProperty.call(req.body || {}, 'reviewed')
        ? Boolean(req.body.reviewed)
        : Boolean(existing?.reviewed)

      upsertNodeIdentificationFieldValue.run({
        node_id: node.id,
        field_key: field.key,
        value_json: JSON.stringify(nextValue),
        reviewed: valueChanged ? 0 : wantsReviewed ? 1 : 0,
        reviewed_by_user_id:
          valueChanged || !wantsReviewed
            ? null
            : req.user.id,
        reviewed_at:
          valueChanged || !wantsReviewed
            ? null
            : new Date().toISOString(),
        source: hasIncomingValue ? String(req.body.source || 'manual') : existing?.source || 'manual',
        ai_suggestion_json: existing?.ai_suggestion_json || null,
        updated_at: new Date().toISOString(),
      })

      updateProjectTimestamp.run(new Date().toISOString(), node.project_id)
      broadcastProjectEvent(node.project_id)
      res.json({ ok: true, node: serializeNodeForUser(assertNode(node.id), req.user.id) })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/identification/ai-fill', requireAuth, async (req, res) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const project = assertProjectAccess(node.project_id, req.user.id)
      if (!project.openai_api_key_encrypted) {
        return res.json({ ok: false, error: 'No project OpenAI API key is configured' })
      }

      const apiKey = decryptProjectSecret(project.openai_api_key_encrypted)
      const assignment = getNodeIdentification.get(node.id)
      if (!assignment) {
        return res.json({ ok: false, error: 'Apply a template before using AI fill' })
      }

      const template = assertIdentificationTemplateAccess(assignment.template_id, node.project_id)
      const templateRowsById = new Map([[template.id, serializeIdentificationTemplate(template)]])
      const projectTemplatesById = new Map(
        listIdentificationTemplatesByProject.all(node.project_id)
          .map(serializeIdentificationTemplate)
          .map((templateRow) => [templateRow.id, templateRow]),
      )
      const identificationRowsByNodeId = new Map(
        listNodeIdentificationsByProject.all(node.project_id).map((item) => [item.node_id, item]),
      )
      const fieldRowsByNodeId = new Map()
      for (const fieldRow of listNodeIdentificationFieldValuesByProject.all(node.project_id)) {
        const items = fieldRowsByNodeId.get(fieldRow.node_id) || []
        items.push(fieldRow)
        fieldRowsByNodeId.set(fieldRow.node_id, items)
      }
      const identification = buildNodeIdentification(node.id, templateRowsById, identificationRowsByNodeId, fieldRowsByNodeId)
      if (!identification) {
        return res.json({ ok: false, error: 'Unable to build identification context for this node' })
      }

      const projectNodes = getProjectNodes.all(node.project_id)
      const identificationByNodeId = new Map(
        projectNodes.map((projectNode) => [
          projectNode.id,
          buildNodeIdentification(projectNode.id, projectTemplatesById, identificationRowsByNodeId, fieldRowsByNodeId),
        ]),
      )
      const { updates, message } = await runOpenAiIdentification({
        node,
        projectNodes,
        identification,
        identificationByNodeId,
        apiKey,
      })

      if (updates.length === 0) {
        return res.json({ ok: true, node: serializeNodeForUser(assertNode(node.id), req.user.id), message })
      }

      const now = new Date().toISOString()
      const templateFields = serializeIdentificationTemplate(template).fields
      for (const update of updates) {
        const field = templateFields.find((item) => item.key === update.key)
        if (!field) {
          continue
        }
        const existing = getNodeIdentificationFieldValue.get(node.id, field.key)
        if (existing?.reviewed) {
          continue
        }
        upsertNodeIdentificationFieldValue.run({
          node_id: node.id,
          field_key: field.key,
          value_json: JSON.stringify(normalizeIdentificationFieldValue(field, update.value)),
          reviewed: 0,
          reviewed_by_user_id: null,
          reviewed_at: null,
          source: 'ai',
          ai_suggestion_json: JSON.stringify({
            value: normalizeIdentificationFieldValue(field, update.value),
            confidence: update.confidence,
            evidence: update.evidence,
            rationale: update.rationale,
            usedImageIds: update.usedImageIds,
            usedNodeIds: update.usedNodeIds,
            sourceStrength: update.sourceStrength,
            model: OPENAI_IDENTIFICATION_MODEL,
            createdAt: now,
          }),
          updated_at: now,
        })
      }

      updateProjectTimestamp.run(now, node.project_id)
      broadcastProjectEvent(node.project_id)
      res.json({ ok: true, node: serializeNodeForUser(assertNode(node.id), req.user.id), message })
    } catch (error) {
      return res.json({
        ok: false,
        error:
          error.message === 'NODETRACE_SECRET_KEY is not configured on the server'
            ? getProjectSecretConfigurationError()
            : error.message || 'Unable to run AI fill',
      })
    }
  })

  app.post('/api/nodes/:id/collapse', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const collapsed = req.body.collapsed ? 1 : 0
      const updatedIds = setNodeCollapsedStateRecursive({
        userId: req.user.id,
        nodeId: node.id,
        projectId: node.project_id,
        collapsed,
      })

      broadcastProjectEvent(node.project_id)
      res.json({ node: serializeNodeForUser(assertNode(node.id), req.user.id), updatedIds })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/move', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      ensureNotRoot(node)
      const variantOfId =
        req.body.additionalPhotoOfId != null
          ? String(req.body.additionalPhotoOfId).trim()
          : req.body.variantOfId != null
            ? String(req.body.variantOfId).trim()
            : null
      let parentId = req.body.parentId != null ? String(req.body.parentId).trim() : null

      if (variantOfId) {
        ensureNoChildren(node)
        const requestedAnchor = assertNode(variantOfId)
        ensureNodeBelongsToProject(requestedAnchor, node.project_id)
        const anchorNode = resolveVariantAnchor(requestedAnchor)
        if (anchorNode.id === node.id) {
          return res.status(400).json({ error: 'A node cannot become an additional photo of itself' })
        }
        parentId = anchorNode.parent_id
        moveNode({
          id: node.id,
          project_id: node.project_id,
          parent_id: parentId,
          variant_of_id: anchorNode.id,
        })
      } else {
        if (!parentId) {
          return res.status(400).json({ error: 'Parent node is required' })
        }
        const targetParent = assertNode(parentId)
        ensureNodeBelongsToProject(targetParent, node.project_id)
        ensureCanHaveChildren(targetParent)
        ensureNoCycle(node.id, targetParent.id)

        moveNode({
          id: node.id,
          project_id: node.project_id,
          parent_id: targetParent.id,
          variant_of_id: null,
        })
      }

      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/nodes/:id', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      ensureNotRoot(node)
      deleteNodeRecursive(node.id, node.project_id)
      broadcastProjectEvent(node.project_id)
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/projects/:id/nodes/delete-bulk', requireAuth, (req, res, next) => {
    try {
      const project = assertProjectAccess(req.params.id, req.user.id)
      const requestedNodeIds = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : []
      const targetNodes = Array.from(
        new Map(
          requestedNodeIds
            .map((nodeId) => assertNodeAccess(String(nodeId || '').trim(), req.user.id))
            .filter((node) => node.project_id === project.id)
            .map((node) => [node.id, node]),
        ).values(),
      )

      if (!targetNodes.length) {
        return res.status(400).json({ error: 'Select at least one node' })
      }

      for (const node of targetNodes) {
        ensureNotRoot(node)
      }

      for (const node of targetNodes) {
        deleteNodeRecursive(node.id, project.id)
      }

      broadcastProjectEvent(project.id)
      res.json({ ok: true, tree: buildTree(project, getProjectNodes.all(project.id), req.user.id) })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/nodes/:id/media/:mediaId', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      updateNodeMediaEdits({
        nodeId: node.id,
        mediaId: String(req.params.mediaId || '').trim(),
        imageEdits: req.body?.imageEdits,
        projectId: node.project_id,
      })
      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/media/:mediaId/primary', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      setPrimaryNodeMedia({
        nodeId: node.id,
        mediaId: String(req.params.mediaId || '').trim(),
        projectId: node.project_id,
      })
      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/nodes/:id/media/:mediaId', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      removeNodeMedia({
        nodeId: node.id,
        mediaId: String(req.params.mediaId || '').trim(),
        projectId: node.project_id,
      })
      broadcastProjectEvent(node.project_id)
      res.json(serializeNodeForUser(assertNode(node.id), req.user.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/merge-into-photo', requireAuth, (req, res, next) => {
    try {
      const sourceNode = assertNodeAccess(req.params.id, req.user.id)
      const targetNodeId = String(req.body?.targetNodeId || '').trim()
      if (!targetNodeId) {
        return res.status(400).json({ error: 'Target node is required' })
      }

      const targetNode = assertNodeAccess(targetNodeId, req.user.id)
      mergeNodeIntoTargetMedia({
        sourceNodeId: sourceNode.id,
        targetNodeId: targetNode.id,
        projectId: sourceNode.project_id,
      })
      broadcastProjectEvent(sourceNode.project_id)
      const project = assertProjectAccess(sourceNode.project_id, req.user.id)
      res.json({
        ok: true,
        targetNodeId: targetNode.id,
        tree: buildTree(project, getProjectNodes.all(project.id), req.user.id),
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/nodes/:id/media/:mediaId/extract', requireAuth, (req, res, next) => {
    try {
      const node = assertNodeAccess(req.params.id, req.user.id)
      const newNodeId = extractNodeMediaToSibling({
        nodeId: node.id,
        mediaId: String(req.params.mediaId || '').trim(),
        projectId: node.project_id,
        ownerUserId: req.user.id,
      })
      broadcastProjectEvent(node.project_id)
      const project = assertProjectAccess(node.project_id, req.user.id)
      res.json({
        ok: true,
        newNodeId,
        tree: buildTree(project, getProjectNodes.all(project.id), req.user.id),
      })
    } catch (error) {
      next(error)
    }
  })
}
