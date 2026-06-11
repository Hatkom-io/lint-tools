# @hatkom/lint-tools

Dead-code lint tools for NestJS + GraphQL monorepos. Two Bun CLIs that fail CI
when the codebase carries unused server surface area.

## Expected monorepo structure

> **These tools are convention-based, not configurable.** They assume the
> standard layout below and resolve every path relative to the directory you
> run them from (`process.cwd()`), which **must be the monorepo root**. There
> is no config file — if your repo deviates from this layout, the tools will
> not find the right files.

```
<repo root>/                      ← run the CLIs here
├── apps/
│   ├── api/                      ← the one NestJS GraphQL API
│   │   ├── schema.gql            ← generated SDL (regenerate before linting)
│   │   ├── tsconfig.json         ← used by ts-morph to load the project
│   │   └── src/
│   │       ├── **/*.resolver.ts  ← @Query / @Mutation / @ResolveField scanned
│   │       └── **/*.service.ts   ← @Injectable() services scanned
│   └── <frontend>/               ← any number of frontends
│       ├── graphql-env.ts        ← marks an app as a GraphQL consumer
│       └── src/**/*.{ts,tsx}     ← scanned for selected fields
```

Conventions baked in:

- The API app is always `apps/api`; it is excluded from frontend discovery.
- Frontend apps are auto-discovered: any `apps/*` directory containing a
  `graphql-env.ts` (so adding a new frontend needs no config change).
- GraphQL model class names map to schema types by stripping a trailing
  `Model` suffix (e.g. `ConversationModel` → `Conversation`).

## Tools

A single `lint-tools` binary runs every check below in sequence and exits `1`
if any of them report dead code.

### Unused GraphQL fields

Finds GraphQL surface area no frontend ever selects: root `@Query`/`@Mutation`,
`@ResolveField`, and orphan object types. Since every consumer lives in the
monorepo, anything unselected is dead. Items behind `@ApiKeyAuth` (and the types
reachable from them) are skipped — external API consumers are invisible from
inside the repo.

Reads `apps/api/schema.gql`, runs `graphql-inspector coverage` against the
discovered frontend apps, then cross-references resolver decorators. Exits `1`
on any unused item, or if a resolver entry can't be parsed (so dead fields can't
slip through silently).

> Requires a fresh `apps/api/schema.gql` — generate the schema first.

### Unused service methods

Finds public methods / arrow-function properties on `@Injectable()` NestJS
services with zero call sites (via ts-morph reference analysis). Skips private
members, decorated members (framework-invoked), and NestJS lifecycle hooks.
Annotate an intentional keeper with a leading `// dead-code-ignore-next-line`
comment. Exits `1` on any unused member.

## Usage

```bash
bun add -D @hatkom/lint-tools
```

```jsonc
// package.json
{
  "scripts": {
    "lint:dead-code": "lint-tools"
  }
}
```

Ships with a `#!/usr/bin/env bun` shebang and uses Bun runtime APIs — run it
with Bun.
