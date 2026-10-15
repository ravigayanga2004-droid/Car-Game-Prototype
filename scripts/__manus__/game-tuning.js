// Only injected by the managed preview server, never into published exports.
(() => {
  let adapter
  let connection
  const resourceId = document.querySelector('meta[name="manus-game-preview-resource"]')?.content
  const previewGeneration = document.querySelector('meta[name="manus-game-preview-generation"]')?.content
  if (!/^wdp_[a-z0-9]{16,32}$/.test(resourceId || '') || !/^[a-f0-9]{64}$/.test(previewGeneration || '')) return
  window.__manusRegisterGameTuning = (callback, version) => { if (version === 2 && typeof callback === 'function') adapter = callback }
  window.__manusGameTuningReply = json => {
    if (!connection || typeof json !== 'string' || json.length > 128_000) return
    let result
    try { result = JSON.parse(json) } catch { return }
    window.parent.postMessage({ channel: 'manus-game-tuning', version: 2, nonce: connection.nonce,
      resourceId, previewGeneration, requestId: result.requestId, operation: result.operation, state: result.state, error: result.error }, connection.origin)
  }
  window.addEventListener('message', event => {
    const message = event.data
    if (!adapter || event.source !== window.parent || message?.channel !== 'manus-game-tuning' || message.version !== 2 ||
      message.resourceId !== resourceId || typeof message.nonce !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(message.nonce) ||
      typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(message.requestId) ||
      !['describe', 'connect', 'read', 'heartbeat', 'apply', 'disconnect'].includes(message.operation)) return
    const origin = window.__manusGameParentOrigin?.(event)
    if (!origin) return
    if (message.operation === 'describe') connection = { origin, nonce: message.nonce }
    else if (!connection || connection.nonce !== message.nonce || connection.origin !== origin || message.previewGeneration !== previewGeneration) return
    const request = { operation: message.operation, requestId: message.requestId,
      schemaDigest: message.schemaDigest, patch: message.patch }
    const json = JSON.stringify(request)
    if (json.length > 24_000) return
    adapter(json)
    if (message.operation === 'disconnect') connection = null
  })
  window.addEventListener('pagehide', () => { connection = null })
})()
