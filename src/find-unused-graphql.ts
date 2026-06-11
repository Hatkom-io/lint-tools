#!/usr/bin/env bun

/**
 * Finds unused GraphQL fields in the API.
 *
 * Since all GraphQL consumers live in this monorepo, any field not selected
 * by frontend code is unused. The set of frontend apps is discovered at
 * runtime by scanning `apps/*` for a `graphql-env.ts` file.
 *
 * Detects:
 *   - Root @Query / @Mutation never selected by any frontend
 *   - @ResolveField never selected by any frontend
 *   - Object types whose fields are never selected at all (orphan types)
 *
 * Items decorated with @ApiKeyAuth are skipped — external API consumers
 * are not visible from inside the monorepo. Types transitively reachable
 * from @ApiKeyAuth queries/mutations/resolve fields (return types, field
 * args, and input types) are also skipped from the orphan-type and
 * unused-field checks.
 *
 * Run from the consumer monorepo root: `find-unused-graphql`
 *
 * Exits 1 if any unused internal item is found, or if any resolver entry
 * could not be parsed (so unused fields cannot silently slip through).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Glob } from 'bun'
import {
  buildSchema,
  getNamedType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from 'graphql'

const repoRoot = process.cwd()
const schemaPath = join(repoRoot, 'apps/api/schema.gql')
const coveragePath = join(tmpdir(), 'graphql-coverage.json')

const discoverFrontendApps = (): string[] => {
  const appsDir = join(repoRoot, 'apps')
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'api')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(appsDir, name, 'graphql-env.ts')))
    .sort()
}

const buildDocumentsGlob = (apps: string[]): string => {
  if (apps.length === 1) {
    return `apps/${apps[0]}/src/**/*.{ts,tsx}`
  }
  return `apps/{${apps.join(',')}}/src/**/*.{ts,tsx}`
}

type Kind = 'Query' | 'Mutation' | 'ResolveField'

type Coverage = {
  types: Record<
    string,
    { hits: number; children: Record<string, { hits: number }> }
  >
}

type Entry = {
  kind: Kind
  parentType: string
  fieldName: string
  returnType: string | null
  file: string
  line: number
  hasApiKeyAuth: boolean
}

const isKind = (value: string): value is Kind =>
  value === 'Query' || value === 'Mutation' || value === 'ResolveField'

const findMethodLine = (lines: string[], decoratorIndex: number): number => {
  for (
    let j = decoratorIndex + 1;
    j < lines.length && j < decoratorIndex + 10;
    j++
  ) {
    const candidate = lines[j]?.trim()
    if (!candidate) {
      continue
    }
    if (candidate.startsWith('@')) {
      continue
    }
    return j
  }
  return -1
}

const parseField = (
  kind: Kind,
  signature: string,
): { fieldName: string; parentType: string } | null => {
  if (kind === 'ResolveField') {
    const [, methodName] = /^\s*(?:async\s+)?(\w+)\s*\(/.exec(signature) ?? []
    const [, parentTypeName] =
      /@Parent\(\)[^:]*:\s*([A-Z][A-Za-z0-9_]*)/.exec(signature) ?? []
    if (!methodName || !parentTypeName) {
      return null
    }
    return { fieldName: methodName, parentType: parentTypeName }
  }
  const [, methodName] = /^\s*(?:async\s+)?(\w+)\s*[(<]/.exec(signature) ?? []
  if (!methodName) {
    return null
  }
  return { fieldName: methodName, parentType: kind }
}

const hasApiKeyAuth = (lines: string[], from: number, to: number): boolean => {
  for (let k = Math.max(0, from); k <= to; k++) {
    if (lines[k]?.includes('@ApiKeyAuth')) {
      return true
    }
  }
  return false
}

const parseReturnType = (decoratorBlock: string): string | null => {
  const [, returnType] =
    /@(?:Query|Mutation|ResolveField)\(\s*\(\)\s*=>\s*\[?\s*(\w+)/.exec(
      decoratorBlock,
    ) ?? []
  return returnType ?? null
}

type Unparseable = {
  file: string
  line: number
  decoratorKind: Kind
  reason: string
}

const extractEntries = async (): Promise<{
  entries: Entry[]
  unparseable: Unparseable[]
}> => {
  const entries: Entry[] = []
  const unparseable: Unparseable[] = []
  const glob = new Glob('**/*.resolver.ts')
  const resolverBase = join(repoRoot, 'apps/api/src')

  for await (const file of glob.scan(resolverBase)) {
    const content = await Bun.file(join(resolverBase, file)).text()
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const decoratorLine = lines[i]
      if (!decoratorLine) {
        continue
      }

      const [, decoratorKind] =
        /@(Query|Mutation|ResolveField)\s*\(/.exec(decoratorLine) ?? []
      if (!decoratorKind || !isKind(decoratorKind)) {
        continue
      }

      const methodLineIndex = findMethodLine(lines, i)
      if (methodLineIndex === -1) {
        unparseable.push({
          file: `apps/api/src/${file}`,
          line: i + 1,
          decoratorKind,
          reason: 'no method signature found within 10 lines after decorator',
        })
        continue
      }

      const signature = lines
        .slice(methodLineIndex, methodLineIndex + 5)
        .join(' ')
      const parsed = parseField(decoratorKind, signature)
      if (!parsed) {
        unparseable.push({
          file: `apps/api/src/${file}`,
          line: methodLineIndex + 1,
          decoratorKind,
          reason:
            decoratorKind === 'ResolveField'
              ? 'could not extract method name and @Parent() type from signature'
              : 'could not extract method name from signature',
        })
        continue
      }

      const decoratorBlock = lines.slice(i, methodLineIndex).join(' ')

      entries.push({
        kind: decoratorKind,
        parentType: parsed.parentType,
        fieldName: parsed.fieldName,
        returnType: parseReturnType(decoratorBlock),
        file: `apps/api/src/${file}`,
        line: methodLineIndex + 1,
        hasApiKeyAuth: hasApiKeyAuth(lines, i - 5, methodLineIndex - 1),
      })
    }
  }

  return { entries, unparseable }
}

const main = async () => {
  const frontendApps = discoverFrontendApps()
  if (frontendApps.length === 0) {
    console.error(
      '❌ No frontend apps with a `graphql-env.ts` were found under `apps/`.',
    )
    process.exit(1)
  }
  const documentsGlob = buildDocumentsGlob(frontendApps)

  console.log(
    `Running graphql-inspector coverage against: ${frontendApps.join(', ')}`,
  )
  execFileSync(
    'bunx',
    [
      'graphql-inspector',
      'coverage',
      documentsGlob,
      schemaPath,
      '--silent',
      '--write',
      coveragePath,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  )

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
  const coverage: Coverage = JSON.parse(readFileSync(coveragePath, 'utf-8'))

  const unusedPairs = new Set<string>()
  for (const [typeName, type] of Object.entries(coverage.types)) {
    for (const [fieldName, field] of Object.entries(type.children)) {
      if (field.hits === 0) {
        unusedPairs.add(`${typeName}.${fieldName}`)
      }
    }
  }

  const orphanTypeCandidates = Object.entries(coverage.types)
    .filter(
      ([typeName, type]) =>
        typeName !== 'Query' &&
        typeName !== 'Mutation' &&
        type.hits === 0 &&
        Object.keys(type.children).length > 0,
    )
    .map(([typeName]) => typeName)

  console.log('Scanning resolvers…\n')
  const { entries, unparseable } = await extractEntries()

  const knownSchemaTypes = new Set(Object.keys(coverage.types))
  const resolveSchemaType = (rawType: string): string | null => {
    if (knownSchemaTypes.has(rawType)) {
      return rawType
    }
    const stripped = rawType.replace(/Model$/, '')
    if (knownSchemaTypes.has(stripped)) {
      return stripped
    }
    return null
  }

  const schema = buildSchema(readFileSync(schemaPath, 'utf-8'))

  const externalTypes = new Set<string>()
  const visitExternal = (typeName: string): void => {
    if (externalTypes.has(typeName)) {
      return
    }
    externalTypes.add(typeName)
    const type = schema.getType(typeName)
    if (!type) {
      return
    }
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        visitExternal(getNamedType(field.type).name)
        for (const arg of field.args) {
          visitExternal(getNamedType(arg.type).name)
        }
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        visitExternal(getNamedType(field.type).name)
      }
    } else if (isUnionType(type)) {
      for (const member of type.getTypes()) {
        visitExternal(member.name)
      }
    }
  }

  const visitExternalField = (parentTypeName: string, fieldName: string) => {
    const parent = schema.getType(parentTypeName)
    if (!parent || !(isObjectType(parent) || isInterfaceType(parent))) {
      return
    }
    const field = parent.getFields()[fieldName]
    if (!field) {
      return
    }
    visitExternal(getNamedType(field.type).name)
    for (const arg of field.args) {
      visitExternal(getNamedType(arg.type).name)
    }
  }

  for (const entry of entries) {
    if (!entry.hasApiKeyAuth) {
      continue
    }
    const parentSchemaType =
      entry.kind === 'ResolveField'
        ? resolveSchemaType(entry.parentType)
        : entry.parentType
    if (parentSchemaType) {
      visitExternalField(parentSchemaType, entry.fieldName)
    }
    if (entry.returnType) {
      const resolved = resolveSchemaType(entry.returnType)
      if (resolved) {
        visitExternal(resolved)
      }
    }
  }

  const orphanTypes = orphanTypeCandidates.filter(
    (typeName) => !externalTypes.has(typeName),
  )

  const unresolved: Entry[] = []
  const dead = entries.filter((entry) => {
    if (entry.hasApiKeyAuth) {
      return false
    }
    const schemaType =
      entry.kind === 'ResolveField'
        ? resolveSchemaType(entry.parentType)
        : entry.parentType
    if (!schemaType) {
      unresolved.push(entry)
      return false
    }
    if (externalTypes.has(schemaType)) {
      return false
    }
    return unusedPairs.has(`${schemaType}.${entry.fieldName}`)
  })

  if (unresolved.length > 0) {
    console.error(
      `❌ Could not resolve parent type for ${unresolved.length} ResolveField(s) — fix the heuristic in resolveSchemaType or rename the parent type so it can be matched:`,
    )
    for (const entry of unresolved) {
      console.error(
        `   ${entry.file}:${entry.line} — parent type "${entry.parentType}"`,
      )
    }
    console.error()
  }

  if (unparseable.length > 0) {
    console.error(
      `❌ Could not parse ${unparseable.length} resolver entry/entries — the heuristics in findMethodLine/parseField need to be updated (unparseable entries would otherwise be silently skipped, hiding genuinely unused fields):`,
    )
    for (const entry of unparseable) {
      console.error(
        `   ${entry.file}:${entry.line} — @${entry.decoratorKind}: ${entry.reason}`,
      )
    }
    console.error()
  }

  if (
    dead.length === 0 &&
    orphanTypes.length === 0 &&
    unresolved.length === 0 &&
    unparseable.length === 0
  ) {
    console.log('✅ All GraphQL fields are used!')
    process.exit(0)
  }

  console.log(
    `⚠️  Found ${dead.length} unused fields and ${orphanTypes.length} orphan types:\n`,
  )

  const byFile = new Map<string, Entry[]>()
  for (const entry of dead) {
    const list = byFile.get(entry.file) ?? []
    list.push(entry)
    byFile.set(entry.file, list)
  }

  const emoji: Record<Kind, string> = {
    Query: '🔍',
    Mutation: '✏️',
    ResolveField: '🔗',
  }

  for (const [file, fileEntries] of byFile) {
    console.log(`📁 ${file}`)
    for (const { kind, parentType, fieldName, line } of fileEntries) {
      const label =
        kind === 'ResolveField' ? `${parentType}.${fieldName}` : fieldName
      console.log(`   ${emoji[kind]} ${label} (line ${line})`)
    }
    console.log()
  }

  if (orphanTypes.length > 0) {
    console.log('🗑️  Orphan types (no fields ever selected):')
    for (const typeName of orphanTypes) {
      console.log(`   ${typeName}`)
    }
    console.log()
  }

  console.log(
    'Note: Items with @ApiKeyAuth are skipped (external API consumers).',
  )
  console.log('Remove unused items, or add @ApiKeyAuth if used externally.\n')

  process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
