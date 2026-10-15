// The ingress removes referrers across redirects. The Widget's existing private
// URL carries its exact origin; ordinary embeds still use their referrer.
(() => {
  let origin
  try {
    const location = new URL(window.location.href)
    const declaredOrigins = location.searchParams.getAll('__manus_preview_parent_origin')
    let declaredOrigin
    if (declaredOrigins.length) {
      const markers = location.searchParams.getAll('from_webdev')
      if (declaredOrigins.length !== 1 || markers.length !== 1 || markers[0] !== '1') return
      const declared = new URL(declaredOrigins[0])
      if (!['http:', 'https:'].includes(declared.protocol) || declared.origin !== declaredOrigins[0]) return
      declaredOrigin = declared.origin
    }
    const referrer = document.referrer ? new URL(document.referrer) : null
    const versioned = /\/__manus__\/game-preview\/[a-f0-9]{64}\/index\.html$/
    const base = location.pathname.replace(versioned, '/')
    const previousBase = referrer?.pathname.replace(versioned, '/')
    const managedNavigation = referrer && versioned.test(location.pathname) && referrer.origin === location.origin &&
      (previousBase === base || referrer.pathname === base + 'index.html')
    if (referrer && !managedNavigation) {
      if (declaredOrigin && declaredOrigin !== referrer.origin) return
      origin = referrer.origin
    } else if (declaredOrigin) origin = declaredOrigin
    else if (!managedNavigation) return
  } catch { return }
  window.__manusGameParentOrigin = event => {
    if (event.source !== window.parent || !/^https?:\/\//.test(event.origin)) return null
    if (origin && origin !== event.origin) return null
    origin = event.origin
    return origin
  }
})()
