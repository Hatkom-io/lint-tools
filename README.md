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
│   ├── api/                      ← a NestJS GraphQL API (`api` or `*-api`)
│   │   ├── schema.gql            ← generated SDL (regenerate before linting)
│   │   ├── tsconfig.json         ← used by ts-morph to load the project
│   │   └── src/
│   │       ├── **/*.resolver.ts  ← @Query / @Mutation / @ResolveField scanned
│   │       └── **/*.service.ts   ← @Injectable() services scanned
│   ├── portal-api/               ← any number of further APIs, same layout
│   └── <frontend>/               ← any number of frontends
│       ├── graphql-env.ts        ← marks an app as a GraphQL consumer
│       └── src/**/*.{ts,tsx}     ← scanned for selected fields
```

Conventions baked in:

- API apps are auto-discovered: any `apps/*` directory named `api` or ending in
  `-api` (e.g. `portal-api`, `sfs-api`). Each is checked separately and excluded
  from frontend discovery. A missing `tsconfig.json` or `schema.gql` fails that
  API's check (exit `1`) instead of skipping it, so an API cannot drop out of
  linting unnoticed; the other APIs are still checked.
- Frontend apps are auto-discovered: any `apps/*` directory containing a
  `graphql-env.ts` (so adding a new frontend needs no config change). A
  frontend is matched to an API by the gql.tada `schema` path in its
  `tsconfig.json`, so each API is only checked against its own consumers.
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

Reads each API's `schema.gql`, runs `graphql-inspector coverage` against the
frontend apps bound to that schema, then cross-references resolver decorators.
Exits `1` on any unused item, or if a resolver entry can't be parsed (so dead
fields can't slip through silently).

> Requires a fresh `schema.gql` in every API app — generate the schemas first.

### Unused service methods

Finds public methods / arrow-function properties on `@Injectable()` NestJS
services with zero call sites, per API app (via ts-morph reference analysis —
each API is its own project, so cross-app calls don't count). Skips private
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
