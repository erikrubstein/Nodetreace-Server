export function createIdentificationHelpers({
  fs,
  path,
  uploadsDir,
  openAiIdentificationModel,
  listNodeMediaByProjectStmt,
  countNodesUsingIdentificationTemplateStmt,
  toDataUrl,
}) {
  function clampAiDepth(value) {
    return Math.max(0, Math.min(5, Number.parseInt(value, 10) || 0))
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

    for (const node of projectNodes) {
      if (node.parent_id) {
        if (!childrenByParent.has(node.parent_id)) {
          childrenByParent.set(node.parent_id, [])
        }
        childrenByParent.get(node.parent_id).push(node)
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
      pushScopedNode(nodesById.get(nodeId), relation)
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
    const mediaRowsByNodeId = new Map()
    for (const mediaRow of listNodeMediaByProjectStmt.all(node.project_id)) {
      const items = mediaRowsByNodeId.get(mediaRow.node_id) || []
      items.push(mediaRow)
      mediaRowsByNodeId.set(mediaRow.node_id, items)
    }
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
        const primaryMedia =
          (mediaRowsByNodeId.get(scopedNode.id) || []).find((item) => Number(item.is_primary)) ||
          (mediaRowsByNodeId.get(scopedNode.id) || [])[0] ||
          null
        const imagePath = primaryMedia?.preview_path || primaryMedia?.image_path || null
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
        hasImage: Boolean((mediaRowsByNodeId.get(scopedNode.id) || []).length),
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
        model: openAiIdentificationModel,
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

  return {
    clampAiDepth,
    normalizeIdentificationFieldDefinitions,
    normalizeIdentificationFieldValue,
    runOpenAiIdentification,
    serializeIdentificationTemplate,
    buildNodeIdentification,
  }
}
