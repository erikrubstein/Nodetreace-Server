export function createFileHelpers({
  fs,
  path,
  uploadsDir,
  generateUniqueId,
  normalizeNodeImageEdits,
}) {
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

  return {
    getProjectUploadDir,
    readUploadedFileData,
    copyStoredUpload,
    cloneMediaPayloadToProject,
    sanitizeUploadName,
    sanitizeFilesystemName,
    guessMimeType,
    toDataUrl,
  }
}
