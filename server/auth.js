import crypto from 'node:crypto'

export function loadEnvFile(fs, filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    if (!key || process.env[key] != null) {
      continue
    }

    let value = trimmed.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

export function createAuthHelpers({ authCookie, projectSecretRaw = '' }) {
  const projectSecretKey = projectSecretRaw
    ? crypto.createHash('sha256').update(projectSecretRaw).digest()
    : null

  const idFirstChars = 'abcdefghijklmnopqrstuvwxyz'
  const idChars = 'abcdefghijklmnopqrstuvwxyz0123456789'

  function generateShortId() {
    let value = idFirstChars[Math.floor(Math.random() * idFirstChars.length)]
    for (let index = 1; index < 5; index += 1) {
      value += idChars[Math.floor(Math.random() * idChars.length)]
    }
    return value
  }

  function generateUniqueId(lookup) {
    let attempts = 0
    while (attempts < 200) {
      const candidate = generateShortId()
      if (!lookup(candidate)) {
        return candidate
      }
      attempts += 1
    }

    throw new Error('Unable to generate a unique short id')
  }

  function generateToken() {
    return crypto.randomBytes(32).toString('hex')
  }

  function encryptProjectSecret(value) {
    if (!projectSecretKey) {
      const error = new Error('NODETRACE_SECRET_KEY is not configured on the server')
      error.status = 500
      throw error
    }
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', projectSecretKey, iv)
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
  }

  function decryptProjectSecret(payload) {
    if (!payload) {
      return ''
    }
    if (!projectSecretKey) {
      const error = new Error('NODETRACE_SECRET_KEY is not configured on the server')
      error.status = 500
      throw error
    }
    const [ivPart, tagPart, encryptedPart] = String(payload).split('.')
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      projectSecretKey,
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
      `${authCookie}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    )
  }

  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', `${authCookie}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`)
  }

  function normalizeUsername(usernameInput) {
    const username = String(usernameInput || '')
      .trim()
      .toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      const error = new Error(
        'Username must be 3-32 characters using letters, numbers, dot, underscore, or dash',
      )
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

  return {
    generateUniqueId,
    generateToken,
    encryptProjectSecret,
    decryptProjectSecret,
    getProjectSecretConfigurationError,
    maskProjectApiKey,
    hashPassword,
    verifyPassword,
    parseCookies,
    setAuthCookie,
    clearAuthCookie,
    normalizeUsername,
    normalizePassword,
  }
}
