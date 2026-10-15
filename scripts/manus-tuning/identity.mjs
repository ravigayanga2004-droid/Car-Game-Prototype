import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// Public projection v1 is intentionally independent of private Host binding schemas.
// Unknown additive fields are ignored. This is preview routing, not authorization.
export async function previewResourceId(projectDir) {
  try {
    const root = await realpath(projectDir)
    const directory = path.join(root, '.manus-webdev')
    if (await realpath(directory) !== directory) return null
    const file = path.join(directory, 'preview-identity.json')
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 4096) return null
    const value = JSON.parse(await readFile(file, 'utf8'))
    return value?.version === 1 && value.projectDir === root &&
      typeof value.resourceId === 'string' && /^wdp_[a-f0-9]{24}$/.test(value.resourceId)
      ? value.resourceId : null
  } catch { return null }
}
