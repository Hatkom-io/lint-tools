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
 * Every API app in the monorepo is scanned: `apps/api` plus any `apps/*-api`
 * (e.g. `portal-api`, `sfs-api`). Each is loaded as its own ts-morph project,
 * so a method is only considered used if it is called inside its own app.
 *
 * A member is reported only when a language-service find-references search
 * finds no reference to it. That search is slow, so one pass over the app's
 * own source first marks every member reached through a property access
 * (`this.service.member`) whose symbol, or one of its root symbols, is the
 * member: find-references reports every such access, so skipping the search
 * for these members cannot change the findings. The pass skips names spelled
 * with Unicode escapes, which find-references' raw-text search cannot see.
 * Every other form of use (element access, destructuring, calls through an
 * interface or base class) is left to the search.
 *
 * Run from the consumer monorepo root via `lint-tools`.
 *
 * Returns 1 if any unused method/property is found.
 */

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ClassDeclaration,
  Identifier,
  MethodDeclaration,
  Project,
  PropertyDeclaration,
  SyntaxKind,
  ts,
} from 'ts-morph'
import { type ApiApp, discoverApiApps } from './discover-apis'
import { loadProject } from './load-project'

const repoRoot = process.cwd()

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

type Candidate = Dead & { nameNode: Identifier }

const collectCandidates = (
  cls: ClassDeclaration,
  file: string,
): Candidate[] => {
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

    return [
      {
        file,
        line: member.getStartLineNumber(),
        className,
        memberName: member.getName(),
        nameNode,
      },
    ]
  })
}

/**
 * Candidates reached through a property access in the app's own source. Uses
 * the language service's program, the one find-references searches, so the
 * symbols match.
 */
const findAccessedCandidates = (
  project: Project,
  candidates: Candidate[],
): Set<Candidate> => {
  const accessed = new Set<Candidate>()
  const program = project.getLanguageService().compilerObject.getProgram()
  if (!program) {
    return accessed
  }
  const checker = program.getTypeChecker()

  const bySymbol = new Map<ts.Symbol, Candidate>()
  for (const candidate of candidates) {
    const symbol = checker.getSymbolAtLocation(candidate.nameNode.compilerNode)
    if (symbol) {
      bySymbol.set(symbol, candidate)
    }
  }
  const names = new Set(candidates.map(({ memberName }) => memberName))

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      sourceFile.fileName.includes('/node_modules/')
    ) {
      continue
    }

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const { name } = node
        if (
          ts.isIdentifier(name) &&
          names.has(name.text) &&
          sourceFile.text.slice(name.getStart(sourceFile), name.end) ===
            name.text
        ) {
          const symbol = checker.getSymbolAtLocation(name)
          for (const root of symbol ? checker.getRootSymbols(symbol) : []) {
            const candidate = bySymbol.get(root)
            if (candidate) {
              accessed.add(candidate)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return accessed
}

const hasNoReferences = ({ nameNode }: Candidate): boolean =>
  nameNode.findReferencesAsNodes().every((ref) => ref === nameNode)

const runForApp = (app: ApiApp): number => {
  if (!existsSync(app.tsConfigFilePath)) {
    console.error(
      `❌ No \`${app.appPath}/tsconfig.json\` found — it is required to load the project.`,
    )
    return 1
  }

  console.log(`Loading TypeScript project for ${app.appPath}…`)
  const project = loadProject(app.tsConfigFilePath)

  const serviceFiles = project
    .getSourceFiles(join(app.srcPath, '**/*.service.ts'))
    .filter((sf) => !sf.getFilePath().includes('/node_modules/'))

  console.log(`Scanning ${serviceFiles.length} service files…\n`)

  const candidates = serviceFiles.flatMap((sf) => {
    const file = relative(repoRoot, sf.getFilePath())
    return sf.getClasses().flatMap((cls) => collectCandidates(cls, file))
  })
  const accessed = findAccessedCandidates(project, candidates)
  const dead: Dead[] = candidates.filter(
    (candidate) => !accessed.has(candidate) && hasNoReferences(candidate),
  )

  if (dead.length === 0) {
    console.log(`✅ All service methods in ${app.appPath} are used!`)
    return 0
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
  return 1
}

export const findUnusedServiceMethods = async (): Promise<number> => {
  const apiApps = discoverApiApps(repoRoot)
  if (apiApps.length === 0) {
    console.error(
      '❌ No API apps found — expected `apps/api` or `apps/*-api` with a `tsconfig.json`.',
    )
    return 1
  }

  let exitCode = 0
  for (const app of apiApps) {
    if (apiApps.length > 1) {
      console.log(`── ${app.appPath} ──\n`)
    }
    const code = runForApp(app)
    if (code !== 0) {
      exitCode = code
    }
  }
  return exitCode
}
