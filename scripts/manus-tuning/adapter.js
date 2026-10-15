// No parameter copies: every read/apply goes to the game's existing manager.
export async function registerGameTuning(store, scope = window) {
  if (typeof scope.__manusRegisterGameTuning !== 'function' || !scope.crypto?.subtle) return () => {}
  const controls = store.controls
  const bytes = new TextEncoder().encode(JSON.stringify(controls))
  const digest = await scope.crypto.subtle.digest('SHA-256', bytes)
  const schemaDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  let disposed = false
  const state = () => ({ schemaDigest, controls, ...store.read() })
  const callback = json => {
    if (disposed) return
    let request
    try { request = JSON.parse(json) } catch { return }
    const { requestId, operation } = request
    if (!['describe', 'connect', 'heartbeat', 'read', 'apply', 'disconnect'].includes(operation)) return
    let error = ''
    if (operation === 'apply') {
      if (request.schemaDigest !== schemaDigest) error = 'schema_changed'
      else {
        try { store.apply(request.patch) } catch { error = 'invalid' }
      }
    }
    scope.__manusGameTuningReply(JSON.stringify({ requestId, operation, error,
      ...(['describe', 'read', 'apply'].includes(operation) ? { state: state() } : {}),
    }))
  }
  scope.__manusRegisterGameTuning(callback, 2)
  const dispose = () => { disposed = true; scope.removeEventListener('pagehide', dispose) }
  scope.addEventListener('pagehide', dispose)
  return dispose
}
