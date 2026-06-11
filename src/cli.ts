#!/usr/bin/env bun

/**
 * Single entrypoint for the lint-tools suite.
 *
 * Runs every dead-code check in sequence and exits 1 if any of them
 * report unused items, so a single `lint-tools` invocation gates CI.
 */

import { findUnusedGraphql } from './find-unused-graphql'
import { findUnusedServiceMethods } from './find-unused-service-methods'

const checks: { name: string; run: () => Promise<number> }[] = [
  { name: 'Unused GraphQL fields', run: findUnusedGraphql },
  { name: 'Unused service methods', run: findUnusedServiceMethods },
]

const main = async () => {
  let exitCode = 0

  for (const { name, run } of checks) {
    console.log(`\n━━━ ${name} ━━━\n`)
    const code = await run()
    if (code !== 0) {
      exitCode = code
    }
  }

  process.exit(exitCode)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
