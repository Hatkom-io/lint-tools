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
 *   - Unused @Field properties on @ObjectType models (partial-type dead fields)
 *   - Unused @Field properties on @InputType inputs (best-effort — see note)
 *   - Fields selected nowhere but read in resolvers/services → @HideField()
 *
 * Items decorated with @ApiKeyAuth are skipped — external API consumers
 * are not visible from inside the monorepo. Types transitively reachable
 * from @ApiKeyAuth queries/mutations/resolve fields (return types, field
 * args, and input types) are also skipped from the orphan-type and
 * unused-field checks.
 *
 * Note on inputs: graphql-inspector's coverage only tracks property hits on
 * object types (response shapes), not on input types. The @InputType report
 * section is wired but currently produces no findings; detecting unused input
 * fields would require additionally walking each operation's variables and
 * recursing through schema input definitions.
 *
 * DTO classes (.model.ts / .input.ts) and backend property accesses are
 * parsed with ts-morph against `apps/api/tsconfig.json`. Resolver decorators
 * are still parsed line-by-line — the @Parent()/@Query/@ResolveField shapes
 * are stable enough that the regex heuristics report (rather than silently
 * skip) anything they cannot read.
 *
 * Run from the consumer monorepo root via `lint-tools`.
 *
 * Returns 1 if any unused internal item is found, or if any resolver entry
 * could not be parsed (so unused fields cannot silently slip through).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Glob } from 'bun'
import {
  buildSchema,
  getNamedType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from 'graphql'
import { ClassDeclaration, Project, SyntaxKind } from 'ts-morph'

const repoRoot = process.cwd()
const schemaPath = join(repoRoot, 'apps/api/schema.gql')
const tsConfigFilePath = join(repoRoot, 'apps/api/tsconfig.json')
const apiSrc = join(repoRoot, 'apps/api/src')
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

type ParentDestructure = {
  fields: Set<string>
  spreadAll: boolean
}

type Unparseable = {
  file: string
  line: number
  decoratorKind: Kind
  reason: string
}

type DtoCategory = 'model' | 'input'

type DtoInfo = {
  schemaTypeName: string
  className: string
  category: DtoCategory
  file: string
  line: number
  directFields: Set<string>
}

type DeadFields = { dto: DtoInfo; fields: string[] }

type PairedHitParams = {
  set: Set<string>
  typeName: string
  dto: DtoInfo
  fieldName: string
}

type BaseEligibilityParams = {
  fieldName: string
  field: { hits: number }
  typeName: string
  dto: DtoInfo
}

const isKind = (value: string): value is Kind =>
  value === 'Query' || value === 'Mutation' || value === 'ResolveField'

const stripModelSuffix = (name: string): string => name.replace(/Model$/, '')

const reservedFieldNames = new Set(['id', '_id', '__typename'])

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
    // @Parent() is auto-injected by @hatkom/nestjs-graphql-plugin, so it may be
    // absent from source. Prefer an explicit @Parent() annotation; otherwise the
    // parent is always the resolver's first parameter — read its type.
    const [, explicitParentType] =
      /@Parent\(\)[^:]*:\s*([A-Z][A-Za-z0-9_]*)/.exec(signature) ?? []
    const [, firstParamType] =
      /\(\s*(?:@\w+\([^)]*\)\s*)?(?:\{[^}]*\}|\w+)\s*:\s*([A-Z][A-Za-z0-9_]*)/.exec(
        signature,
      ) ?? []
    const parentTypeName = explicitParentType ?? firstParamType
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

const parseParentDestructure = (
  signature: string,
): ParentDestructure | null => {
  // The parent is either an explicit @Parent()-decorated param or, since the
  // plugin auto-injects @Parent(), the resolver's first parameter.
  const [, explicitParent] =
    /@Parent\(\)\s*(\{[^}]*\}|\w+)/.exec(signature) ?? []
  const [, firstParam] =
    /\(\s*(?:@\w+\([^)]*\)\s*)?(\{[^}]*\}|\w+)\s*:/.exec(signature) ?? []
  const parentParam = explicitParent ?? firstParam
  if (!parentParam) {
    return null
  }
  if (!parentParam.startsWith('{')) {
    // Non-destructured parent: Type — treat whole parent as used
    return { fields: new Set(), spreadAll: true }
  }
  const [, body] = /\{\s*([^}]*)\s*\}/.exec(parentParam) ?? []
  if (!body) {
    return { fields: new Set(), spreadAll: true }
  }
  return body.split(',').reduce<ParentDestructure>(
    (acc, part) => {
      const trimmed = part.trim()
      if (!trimmed) {
        return acc
      }
      if (trimmed.startsWith('...')) {
        return { ...acc, spreadAll: true }
      }
      const colonIdx = trimmed.indexOf(':')
      const fieldName =
        colonIdx > 0 ? trimmed.slice(0, colonIdx).trim() : trimmed
      if (fieldName) {
        acc.fields.add(fieldName)
      }
      return acc
    },
    { fields: new Set(), spreadAll: false },
  )
}

const extractEntries = async (): Promise<{
  entries: Entry[]
  parentNeeds: Map<string, ParentDestructure>
  unparseable: Unparseable[]
}> => {
  const entries: Entry[] = []
  const parentNeeds = new Map<string, ParentDestructure>()
  const unparseable: Unparseable[] = []
  const glob = new Glob('**/*.resolver.ts')

  for await (const file of glob.scan(apiSrc)) {
    const content = await Bun.file(join(apiSrc, file)).text()
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

      if (decoratorKind === 'ResolveField') {
        const parentDestructure = parseParentDestructure(signature)
        if (parentDestructure) {
          const existing = parentNeeds.get(parsed.parentType) ?? {
            fields: new Set<string>(),
            spreadAll: false,
          }
          for (const f of parentDestructure.fields) {
            existing.fields.add(f)
          }
          if (parentDestructure.spreadAll) {
            existing.spreadAll = true
          }
          parentNeeds.set(parsed.parentType, existing)
        }
      }
    }
  }

  return { entries, parentNeeds, unparseable }
}

/**
 * Reads the literal string passed as the first decorator argument, if any —
 * `@ObjectType('Foo')` → `Foo`. Returns null for options-object or bare forms.
 */
const decoratorNameArg = (
  cls: ClassDeclaration,
  decorator: string,
): string | null => {
  const arg = cls.getDecorator(decorator)?.getArguments()[0]
  const literal = arg?.asKind(SyntaxKind.StringLiteral)
  return literal ? literal.getLiteralValue() : null
}

const extractDtos = (
  project: Project,
): { dtoBySchemaName: Map<string, DtoInfo>; hiddenFieldPairs: Set<string> } => {
  const dtoBySchemaName = new Map<string, DtoInfo>()
  const hiddenFieldPairs = new Set<string>()

  const dtoFiles = project
    .getSourceFiles(join(apiSrc, '**/*.{model,input}.ts'))
    .filter((sf) => !sf.getFilePath().includes('/node_modules/'))

  for (const sf of dtoFiles) {
    const file = relative(repoRoot, sf.getFilePath())
    const isInputFile = sf.getFilePath().endsWith('.input.ts')

    for (const cls of sf.getClasses()) {
      const className = cls.getName()
      if (!className) {
        continue
      }

      const hasObject = cls.getDecorator('ObjectType') !== undefined
      const hasInput = cls.getDecorator('InputType') !== undefined

      // Implicit @InputType: a class ending in `Input` inside a .input.ts file.
      // The decorator is injected by the compiler plugin and absent from source.
      const implicitInput =
        !hasObject && !hasInput && isInputFile && className.endsWith('Input')

      if (!hasObject && !hasInput && !implicitInput) {
        continue
      }

      const category: DtoCategory = hasObject ? 'model' : 'input'
      const schemaTypeName =
        decoratorNameArg(cls, hasObject ? 'ObjectType' : 'InputType') ??
        className

      const directFields = new Set<string>()
      for (const prop of cls.getProperties()) {
        const name = prop.getName()
        directFields.add(name)
        if (prop.getDecorator('HideField')) {
          hiddenFieldPairs.add(`${schemaTypeName}.${name}`)
        }
      }

      dtoBySchemaName.set(schemaTypeName, {
        schemaTypeName,
        className,
        category,
        file,
        line: cls.getStartLineNumber(),
        directFields,
      })
    }
  }

  return { dtoBySchemaName, hiddenFieldPairs }
}

/**
 * Every property name read anywhere in the API source (outside DTO/generated
 * files) — `this.foo.bar` contributes `bar`. A field read here but never
 * selected by a frontend is alive (it feeds internal logic), so it belongs in
 * the @HideField() bucket rather than the delete bucket.
 */
const extractBackendAccesses = (project: Project): Set<string> => {
  const accessed = new Set<string>()

  const files = project.getSourceFiles(join(apiSrc, '**/*.ts')).filter((sf) => {
    const path = sf.getFilePath()
    return (
      !path.includes('/node_modules/') &&
      !path.includes('/@generated/') &&
      !/\.(model|input|args)\.ts$/.test(path)
    )
  })

  for (const sf of files) {
    for (const access of sf.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression,
    )) {
      accessed.add(access.getName())
    }
  }

  return accessed
}

export const findUnusedGraphql = async (): Promise<number> => {
  const frontendApps = discoverFrontendApps()
  if (frontendApps.length === 0) {
    console.error(
      '❌ No frontend apps with a `graphql-env.ts` were found under `apps/`.',
    )
    return 1
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

  console.log('Scanning resolvers and DTOs…\n')
  const project = new Project({ tsConfigFilePath })
  const { entries, parentNeeds, unparseable } = await extractEntries()
  const { dtoBySchemaName, hiddenFieldPairs } = extractDtos(project)
  const backendAccesses = extractBackendAccesses(project)

  const knownSchemaTypes = new Set(Object.keys(coverage.types))
  const resolveSchemaType = (rawType: string): string | null => {
    if (knownSchemaTypes.has(rawType)) {
      return rawType
    }
    const stripped = stripModelSuffix(rawType)
    if (knownSchemaTypes.has(stripped)) {
      return stripped
    }
    return null
  }

  const resolveEntrySchemaType = (entry: Entry): string | null =>
    entry.kind === 'ResolveField'
      ? resolveSchemaType(entry.parentType)
      : entry.parentType

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
    const parentSchemaType = resolveEntrySchemaType(entry)
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
    const schemaType = resolveEntrySchemaType(entry)
    if (!schemaType) {
      unresolved.push(entry)
      return false
    }
    if (externalTypes.has(schemaType)) {
      return false
    }
    return unusedPairs.has(`${schemaType}.${entry.fieldName}`)
  })

  const apiKeyAuthFieldPairs = new Set<string>()
  for (const entry of entries) {
    if (entry.hasApiKeyAuth && entry.kind === 'ResolveField') {
      apiKeyAuthFieldPairs.add(`${entry.parentType}.${entry.fieldName}`)
    }
  }

  const isPairedHit = ({
    set,
    typeName,
    dto,
    fieldName,
  }: PairedHitParams): boolean =>
    set.has(`${typeName}.${fieldName}`) ||
    set.has(`${dto.className}.${fieldName}`)

  const isBaseEligible = ({
    fieldName,
    field,
    typeName,
    dto,
  }: BaseEligibilityParams): boolean =>
    field.hits === 0 &&
    dto.directFields.has(fieldName) &&
    !reservedFieldNames.has(fieldName) &&
    !isPairedHit({ set: apiKeyAuthFieldPairs, typeName, dto, fieldName }) &&
    !isPairedHit({ set: hiddenFieldPairs, typeName, dto, fieldName })

  const modelDeadFields: DeadFields[] = []
  const inputDeadFields: DeadFields[] = []
  const shouldHideFields: DeadFields[] = []
  const skippedExternalModels: DeadFields[] = []

  for (const [typeName, type] of Object.entries(coverage.types)) {
    if (type.hits === 0) {
      continue
    }
    const dto = dtoBySchemaName.get(typeName)
    if (!dto) {
      continue
    }
    const parentNeed =
      parentNeeds.get(typeName) ??
      parentNeeds.get(stripModelSuffix(typeName)) ??
      parentNeeds.get(dto.className) ??
      parentNeeds.get(stripModelSuffix(dto.className))

    if (dto.category === 'model' && !parentNeed?.spreadAll) {
      const hideCandidates = Object.entries(type.children).flatMap(
        ([fieldName, field]) =>
          isBaseEligible({ fieldName, field, typeName, dto }) &&
          (parentNeed?.fields.has(fieldName) || backendAccesses.has(fieldName))
            ? fieldName
            : [],
      )
      if (hideCandidates.length > 0) {
        shouldHideFields.push({ dto, fields: hideCandidates })
      }
    }

    if (parentNeed?.spreadAll) {
      continue
    }

    const deadChildren = Object.entries(type.children).flatMap(
      ([fieldName, field]) =>
        isBaseEligible({ fieldName, field, typeName, dto }) &&
        !parentNeed?.fields.has(fieldName) &&
        !backendAccesses.has(fieldName)
          ? fieldName
          : [],
    )
    if (deadChildren.length === 0) {
      continue
    }
    if (dto.category === 'model' && externalTypes.has(typeName)) {
      skippedExternalModels.push({ dto, fields: deadChildren })
      continue
    }
    if (dto.category === 'input') {
      inputDeadFields.push({ dto, fields: deadChildren })
      continue
    }
    modelDeadFields.push({ dto, fields: deadChildren })
  }

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
    modelDeadFields.length === 0 &&
    inputDeadFields.length === 0 &&
    shouldHideFields.length === 0 &&
    unresolved.length === 0 &&
    unparseable.length === 0
  ) {
    console.log('✅ All GraphQL fields are used!')
    return 0
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

  const totalFields = (items: DeadFields[]): number =>
    items.reduce((sum, { fields }) => sum + fields.length, 0)

  const printDtoReport = (header: string, items: DeadFields[]) => {
    if (items.length === 0) {
      return
    }
    console.log(header)
    for (const { dto, fields } of items) {
      console.log(`📁 ${dto.file}:${dto.line}`)
      console.log(`   ${dto.schemaTypeName} (class ${dto.className})`)
      for (const field of fields) {
        console.log(`      - ${field}`)
      }
    }
    console.log()
  }

  printDtoReport(
    `Dead @ObjectType fields (${totalFields(modelDeadFields)} across ${modelDeadFields.length} types):`,
    modelDeadFields,
  )
  printDtoReport(
    `Dead @InputType fields (${totalFields(inputDeadFields)} across ${inputDeadFields.length} types) — review before deleting (external API consumers may send these):`,
    inputDeadFields,
  )
  printDtoReport(
    `Fields that should be @HideField() (${totalFields(shouldHideFields)} across ${shouldHideFields.length} types) — used internally in resolvers or services but never selected by any frontend:`,
    shouldHideFields,
  )
  printDtoReport(
    `⚠️  ${skippedExternalModels.length} model(s) with unused fields are skipped because they are externally visible (add @ApiKeyAuth to hide them):`,
    skippedExternalModels,
  )

  console.log(
    'Note: Items with @ApiKeyAuth are skipped (external API consumers).',
  )
  console.log('Remove unused items, or add @ApiKeyAuth if used externally.\n')

  return 1
}
