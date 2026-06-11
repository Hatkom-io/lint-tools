#!/usr/bin/env bun

/**
 * Finds unused public methods/properties on NestJS service classes.
 *
 * NestJS services are injected and called as `this.someService.method(args)`.
 * If a public method has zero call sites across the codebase, it's dead.
 *
 * Detects:
 *   - Public method declarations (`findOne(args) { ... }`)
 *   - Public arrow-function properties (`findFirst = (args) => ...`)
 *
 * Skips:
 *   - Private members
 *   - Constructors
 *   - Decorated members (assumed framework-invoked, e.g. @Cron, @OnEvent)
 *   - NestJS lifecycle hooks
 *
 * Run from the consumer monorepo root: `find-unused-service-methods`
 *
 * Exits 1 if any unused method/property is found.
 */

import { join, relative } from 'node:path'
import {
  ClassDeclaration,
  MethodDeclaration,
  Project,
  PropertyDeclaration,
  SyntaxKind,
} from 'ts-morph'

const repoRoot = process.cwd()
const tsConfigFilePath = join(repoRoot, 'apps/api/tsconfig.json')
const serviceGlob = join(repoRoot, 'apps/api/src/**/*.service.ts')

const lifecycleHooks = new Set([
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
])

type Dead = {
  file: string
  line: number
  className: string
  memberName: string
}

const ignoreMarker = 'dead-code-ignore-next-line'

const hasIgnoreComment = (
  member: MethodDeclaration | PropertyDeclaration,
): boolean =>
  member
    .getLeadingCommentRanges()
    .some((range) => range.getText().includes(ignoreMarker))

const isCandidate = (
  member: MethodDeclaration | PropertyDeclaration,
): boolean => {
  if (member.hasModifier(SyntaxKind.PrivateKeyword)) {
    return false
  }
  if (member.getDecorators().length > 0) {
    return false
  }
  if (lifecycleHooks.has(member.getName())) {
    return false
  }
  if (hasIgnoreComment(member)) {
    return false
  }

  if (member.isKind(SyntaxKind.PropertyDeclaration)) {
    const initializer = member.getInitializer()
    if (!initializer) {
      return false
    }
    const kind = initializer.getKind()
    if (
      kind !== SyntaxKind.ArrowFunction &&
      kind !== SyntaxKind.FunctionExpression
    ) {
      return false
    }
  }

  return true
}

const collectDead = (cls: ClassDeclaration, file: string): Dead[] => {
  const isInjectable = cls
    .getDecorators()
    .some((decorator) => decorator.getName() === 'Injectable')

  if (!isInjectable) {
    return []
  }

  const className = cls.getName() ?? '<anonymous>'
  const members: (MethodDeclaration | PropertyDeclaration)[] = [
    ...cls.getMethods(),
    ...cls.getProperties(),
  ]

  return members.flatMap((member) => {
    if (!isCandidate(member)) {
      return []
    }

    const nameNode = member.getNameNode()
    if (!nameNode.isKind(SyntaxKind.Identifier)) {
      return []
    }

    const references = nameNode.findReferencesAsNodes()
    const external = references.filter((ref) => ref !== nameNode)

    if (external.length > 0) {
      return []
    }

    return [
      {
        file,
        line: member.getStartLineNumber(),
        className,
        memberName: member.getName(),
      },
    ]
  })
}

const main = async () => {
  console.log('Loading TypeScript project…')
  const project = new Project({ tsConfigFilePath })

  const serviceFiles = project
    .getSourceFiles(serviceGlob)
    .filter((sf) => !sf.getFilePath().includes('/node_modules/'))

  console.log(`Scanning ${serviceFiles.length} service files…\n`)

  const dead: Dead[] = serviceFiles.flatMap((sf) => {
    const file = relative(repoRoot, sf.getFilePath())
    return sf.getClasses().flatMap((cls) => collectDead(cls, file))
  })

  if (dead.length === 0) {
    console.log('✅ All service methods are used!')
    process.exit(0)
  }

  console.log(`⚠️  Found ${dead.length} unused service members:\n`)

  const byFile = new Map<string, Dead[]>()
  for (const entry of dead) {
    const list = byFile.get(entry.file) ?? []
    list.push(entry)
    byFile.set(entry.file, list)
  }

  for (const [file, entries] of byFile) {
    console.log(`📁 ${file}`)
    for (const { className, memberName, line } of entries) {
      console.log(`   🪦 ${className}.${memberName} (line ${line})`)
    }
    console.log()
  }

  console.log('Remove unused members, or @Inject into another consumer.\n')
  process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
