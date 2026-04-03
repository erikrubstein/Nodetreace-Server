export function registerMediaAuthRoutes(app, ctx) {
  const {
    distDir,
    fs,
    path,
    uploadsDir,
    assertProjectAccess,
    requireAuth,
    getRequestUser,
    normalizeUsername,
    normalizePassword,
    getUserByUsername,
    getUserById,
    countUsers,
    claimOwnerlessProjectsStmt,
    generateUniqueId,
    generateToken,
    hashPassword,
    verifyPassword,
    getSessionByCaptureId,
    insertUser,
    insertSession,
    setAuthCookie,
    deleteSessionStmt,
    activeDesktopSessions,
    activeMobileConnections,
    clearAuthCookie,
    updateUsernameStmt,
    updatePasswordStmt,
    countOwnedProjectsByUserStmt,
    db,
    listSessionsByUserStmt,
    deletePreferencesByUserStmt,
    deleteNodeCollapsePrefsByUserStmt,
    reassignNodeOwnersByUserStmt,
    clearNodeIdentificationCreatorByUserStmt,
    clearNodeIdentificationReviewerByUserStmt,
    deleteCollaboratorsByUserStmt,
    deleteSessionsByUserStmt,
    deleteUserStmt,
  } = ctx

  app.get(/^\/uploads\/(.+)$/, requireAuth, (req, res, next) => {
    try {
      const relativePath = String(req.params[0] || '')
      const normalized = relativePath.split(/[\\/]+/).filter(Boolean)
      if (normalized.length < 2) {
        return res.status(404).json({ error: 'File not found' })
      }

      const projectId = normalized[0]
      assertProjectAccess(projectId, req.user.id)

      const projectUploadDir = path.resolve(uploadsDir, projectId)
      const absolutePath = path.resolve(projectUploadDir, ...normalized.slice(1))
      const relativeToProjectDir = path.relative(projectUploadDir, absolutePath)
      if (
        relativeToProjectDir.startsWith('..') ||
        path.isAbsolute(relativeToProjectDir)
      ) {
        return res.status(404).json({ error: 'File not found' })
      }

      if (!fs.existsSync(absolutePath)) {
        return res.status(404).json({ error: 'File not found' })
      }

      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.vary('Cookie')
      return res.sendFile(absolutePath)
    } catch (error) {
      return next(error)
    }
  })

  app.get('/capture', (_req, res) => {
    const frontendEntryPath = path.join(distDir, 'index.html')
    if (fs.existsSync(frontendEntryPath)) {
      return res.sendFile(frontendEntryPath)
    }

    return res
      .status(503)
      .json({ error: 'Capture frontend is not built yet. Start the renderer dev server or build the app first.' })
  })

  app.get('/api/auth/me', (req, res) => {
    const user = getRequestUser(req)
    if (!user) {
      return res.json({
        authenticated: false,
        user: null,
      })
    }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        captureSessionId: user.captureSessionId,
      },
    })
  })

  app.post('/api/auth/register', (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username)
      const password = normalizePassword(req.body?.password)
      if (getUserByUsername.get(username)) {
        return res.json({ ok: false, error: 'Username is already taken' })
      }

      const now = new Date().toISOString()
      const userId = generateUniqueId((candidate) => Boolean(getUserById.get(candidate)))
      insertUser.run({
        id: userId,
        username,
        password_hash: hashPassword(password),
        created_at: now,
        updated_at: now,
      })

      if ((countUsers.get()?.count || 0) === 1) {
        claimOwnerlessProjectsStmt.run({ owner_user_id: userId })
      }

      const sessionToken = generateToken()
      const captureSessionId = generateUniqueId((candidate) => Boolean(getSessionByCaptureId.get(candidate)))
      insertSession.run({
        id: sessionToken,
        user_id: userId,
        capture_session_id: captureSessionId,
        created_at: now,
        updated_at: now,
      })
      setAuthCookie(res, sessionToken)
      res.status(201).json({
        ok: true,
        id: userId,
        username,
        captureSessionId,
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/auth/login', (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username)
      const password = String(req.body?.password || '')
      const user = getUserByUsername.get(username)
      if (!user || !verifyPassword(password, user.password_hash)) {
        return res.json({ ok: false, error: 'Invalid username or password' })
      }

      const now = new Date().toISOString()
      const sessionToken = generateToken()
      const captureSessionId = generateUniqueId((candidate) => Boolean(getSessionByCaptureId.get(candidate)))
      insertSession.run({
        id: sessionToken,
        user_id: user.id,
        capture_session_id: captureSessionId,
        created_at: now,
        updated_at: now,
      })
      setAuthCookie(res, sessionToken)
      res.json({
        ok: true,
        id: user.id,
        username: user.username,
        captureSessionId,
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    deleteSessionStmt.run(req.user.authSessionId)
    activeDesktopSessions.delete(req.user.captureSessionId)
    activeMobileConnections.delete(req.user.captureSessionId)
    clearAuthCookie(res)
    res.status(204).send()
  })

  app.patch('/api/account/username', requireAuth, (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username)
      const existing = getUserByUsername.get(username)
      if (existing && existing.id !== req.user.id) {
        return res.json({ ok: false, error: 'Username is already taken' })
      }

      updateUsernameStmt.run({
        id: req.user.id,
        username,
        updated_at: new Date().toISOString(),
      })

      res.json({
        ok: true,
        id: req.user.id,
        username,
        captureSessionId: req.user.captureSessionId,
      })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/account/password', requireAuth, (req, res, next) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '')
      const newPassword = normalizePassword(req.body?.newPassword)
      const user = getUserById.get(req.user.id)
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        return res.json({ ok: false, error: 'Current password is incorrect' })
      }

      updatePasswordStmt.run({
        id: req.user.id,
        password_hash: hashPassword(newPassword),
        updated_at: new Date().toISOString(),
      })

      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/account', requireAuth, (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username)
      if (username !== req.user.username) {
        return res.json({ ok: false, error: 'Username confirmation does not match' })
      }
      const ownedProjectCount = Number(countOwnedProjectsByUserStmt.get(req.user.id)?.count || 0)
      if (ownedProjectCount > 0) {
        return res.json({ ok: false, error: 'Delete or transfer your owned projects before deleting this account' })
      }

      const deleteAccountTx = db.transaction(() => {
        const sessions = listSessionsByUserStmt.all(req.user.id)
        deletePreferencesByUserStmt.run(req.user.id)
        deleteNodeCollapsePrefsByUserStmt.run(req.user.id)
        reassignNodeOwnersByUserStmt.run(req.user.id)
        clearNodeIdentificationCreatorByUserStmt.run(req.user.id)
        clearNodeIdentificationReviewerByUserStmt.run(req.user.id)
        deleteCollaboratorsByUserStmt.run(req.user.id, req.user.id)
        deleteSessionsByUserStmt.run(req.user.id)
        deleteUserStmt.run(req.user.id)
        return sessions
      })

      const sessions = deleteAccountTx()
      for (const session of sessions) {
        activeDesktopSessions.delete(session.capture_session_id)
        activeMobileConnections.delete(session.capture_session_id)
      }

      clearAuthCookie(res)
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  })
}
