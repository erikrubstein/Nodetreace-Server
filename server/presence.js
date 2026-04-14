export function createPresenceHelpers({
  projectEventClients,
  activeDesktopSessions,
  activeMobileConnections,
  clientTtlMs,
  mobileConnectionTtlMs,
}) {
  function broadcastProjectEvent(projectId, payload = { type: 'project-updated' }) {
    const listeners = projectEventClients.get(projectId)
    if (!listeners || listeners.size === 0) {
      return
    }

    const body = `data: ${JSON.stringify(payload)}\n\n`
    for (const response of listeners) {
      response.write(body)
    }
  }

  function cleanupDesktopSessions() {
    const cutoff = Date.now() - clientTtlMs
    for (const [sessionId, session] of activeDesktopSessions) {
      if (session.updatedAt < cutoff) {
        activeDesktopSessions.delete(sessionId)
      }
    }
  }

  function listProjectSessions(projectId) {
    cleanupDesktopSessions()
    return Array.from(activeDesktopSessions.values()).filter((session) => session.projectId === projectId)
  }

  function listProjectPresence(projectId, currentUserId = null) {
    const latestByUserId = new Map()
    for (const session of listProjectSessions(projectId)) {
      if (!session.userId || session.userId === currentUserId) {
        continue
      }
      const current = latestByUserId.get(session.userId)
      if (!current || current.updatedAt < session.updatedAt) {
        latestByUserId.set(session.userId, session)
      }
    }

    return Array.from(latestByUserId.values())
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((session) => ({
        userId: session.userId,
        username: session.username,
        selectedNodeId: session.selectedNodeId || null,
        selectedNodeName: session.selectedNodeName || null,
        updatedAt: session.updatedAt,
      }))
  }

  function cleanupMobileConnections() {
    const cutoff = Date.now() - mobileConnectionTtlMs
    for (const [sessionId, connections] of activeMobileConnections) {
      for (const [connectionId, connection] of connections) {
        if (connection.updatedAt < cutoff) {
          connections.delete(connectionId)
        }
      }
      if (connections.size === 0) {
        activeMobileConnections.delete(sessionId)
      }
    }
  }

  function getMobileConnectionCount(sessionId) {
    cleanupMobileConnections()
    return activeMobileConnections.get(sessionId)?.size || 0
  }

  function getDesktopSession(sessionId) {
    cleanupDesktopSessions()
    return activeDesktopSessions.get(sessionId) || null
  }

  return {
    broadcastProjectEvent,
    cleanupDesktopSessions,
    listProjectSessions,
    listProjectPresence,
    cleanupMobileConnections,
    getMobileConnectionCount,
    getDesktopSession,
  }
}
