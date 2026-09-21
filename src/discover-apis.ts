/**
 * Discovers the NestJS API apps in the consumer monorepo.
 *
 * A monorepo may host several backends. An app under `apps/` counts as an API
 * if it is named `api` or ends in `-api` (e.g. `portal-api`, `sfs-api`).
 *
 * A match is returned even when the files a check needs are missing — each
 * check reports the missing file and fails, rather than silently skipping a
 * whole API (which would let its dead code slip through unnoticed).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ApiApp = {
  /** Directory name under `apps/`, e.g. `api` or `portal-api`. */
  name: string
  /** Path prefix relative to the repo root, e.g. `apps/portal-api`. */
  appPath: string
  /** Absolute path to the app's `tsconfig.json`. */
  tsConfigFilePath: string
  /** Absolute path to the app's `src` directory. */
  srcPath: string
  /** Absolute path to the app's generated SDL — may not exist. */
  schemaPath: string
}

export const isApiAppName = (name: string): boolean =>
  name === 'api' || name.endsWith('-api')

export const discoverApiApps = (repoRoot: string): ApiApp[] => {
  const appsDir = join(repoRoot, 'apps')
  if (!existsSync(appsDir)) {
    return []
  }

  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isApiAppName(entry.name))
    .map((entry) => {
      const appDir = join(appsDir, entry.name)
      return {
        name: entry.name,
        appPath: `apps/${entry.name}`,
        tsConfigFilePath: join(appDir, 'tsconfig.json'),
        srcPath: join(appDir, 'src'),
        schemaPath: join(appDir, 'schema.gql'),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
