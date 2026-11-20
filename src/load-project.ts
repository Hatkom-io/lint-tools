/**
 * Loads each API app's ts-morph project once per process, so every check
 * reuses it instead of parsing the app again.
 */

import { Project } from 'ts-morph'

const projects = new Map<string, Project>()

export const loadProject = (tsConfigFilePath: string): Project => {
  const cached = projects.get(tsConfigFilePath)
  if (cached) {
    return cached
  }
  const project = new Project({ tsConfigFilePath })
  projects.set(tsConfigFilePath, project)
  return project
}
