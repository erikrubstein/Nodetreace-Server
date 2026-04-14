import AdmZip from 'adm-zip'

export function createArchiveHelpers(ctx) {
  const {
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
  } = ctx

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
    const tree = buildTree(project, rows)
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
      const safeNodeName = sanitizeFilesystemName(node.name || node.type || 'node')
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
    fs.mkdirSync(path.join(workDir, 'files'), { recursive: true })
    const { templateRows, identificationsByNodeId, fieldValuesByNodeId, mediaRowsByNodeId } =
      buildProjectArchiveData(project.id)

    const manifest = {
      version: 4,
      exported_at: new Date().toISOString(),
      project: {
        name: project.name,
        description: project.description || '',
        settings: normalizeProjectSettings(JSON.parse(project.settings_json || '{}')),
        identification_templates: templateRows,
      },
      nodes: rows.map((row) => ({
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
    extractDir = null,
    uploadedFileMap = null,
    mediaEntries = [],
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
      const mediaFirstArchive = importedRows.every((node) => Array.isArray(node.media))
      if (!mediaFirstArchive) {
        const error = new Error('Legacy project archives are no longer supported')
        error.status = 400
        throw error
      }
      const rootRow = importedRows.find((node) => (node.parent_id ?? node.parent_old_id) == null)
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
          extractDir,
          mediaEntries: rootRow.media,
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
          const parentId = parentRef != null ? oldToNew.get(String(parentRef)) : null
          if (parentRef != null && !parentId) {
            continue
          }

          const nodeId = createNode({
            project_id: projectId,
            owner_user_id: row.owner_user_id || assertProject(projectId).owner_user_id || null,
            parent_id: parentId,
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
            added_at: row.added_at || row.created_at || now,
          })

          if (Array.isArray(row.media)) {
            restoreNodeMediaFromArchive({
              projectId,
              nodeId,
              extractDir,
              mediaEntries: row.media,
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
    const mediaFirstPayload = rows.every((row) => Array.isArray(row.media))
    if (!mediaFirstPayload) {
      const error = new Error('Legacy subtree payloads are no longer supported')
      error.status = 400
      throw error
    }
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
        if (!isRoot && (row.parent_id != null || row.parent_old_id != null) && !parentId) {
          continue
        }

        const nodeId = createNode({
          project_id: projectId,
          owner_user_id: row.owner_user_id || assertProject(projectId).owner_user_id || null,
          parent_id: parentId,
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
          added_at: row.added_at || row.created_at || new Date().toISOString(),
        })

        if (Array.isArray(row.media)) {
          restoreNodeMediaFromArchive({
            projectId,
            nodeId,
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
      const mediaFirstArchive = importedRows.every((node) => Array.isArray(node.media))
      if (!mediaFirstArchive) {
        const error = new Error('Legacy project archives are no longer supported')
        error.status = 400
        throw error
      }
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
      const rootRow = importedRows.find((node) => (node.parent_id ?? node.parent_old_id) == null)
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
          extractDir,
          mediaEntries: rootRow.media,
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
          if ((row.parent_id != null || row.parent_old_id != null) && !parentId) {
            continue
          }

          const nodeId = createNode({
            project_id: projectId,
            owner_user_id: row.owner_user_id || ownerUserId || null,
            parent_id: parentId,
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
          })

          if (Array.isArray(row.media)) {
            restoreNodeMediaFromArchive({
              projectId,
              nodeId,
              extractDir,
              mediaEntries: row.media,
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

  return {
    exportProjectArchive,
    exportProjectMediaArchive,
    restoreNodeMediaFromArchive,
    restoreProjectFromArchive,
    restoreSubtreeFromPayload,
    importProjectArchive,
  }
}
