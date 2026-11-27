#!/usr/bin/env node
/**
 * Cross-platform auto-discovery test runner for MySekaiStoryteller-API.
 *
 * Usage:
 *   node scripts/run-tests.mjs                    # all unit tests (excludes scripts/stories/)
 *   node scripts/run-tests.mjs --stories          # story quality & baseline tests (scripts/stories/)
 *   node scripts/run-tests.mjs --group <name>     # subgroup: api, config, export, renderer, audio, assets, ai, rag, cloud, pool
 *   node scripts/run-tests.mjs --list             # print matched test files without running
 *   node scripts/run-tests.mjs -- <node --test args>
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts')

function walkTests(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTests(full, acc)
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      acc.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'))
    }
  }
  return acc
}

function parseArgs(argv) {
  let stories = false
  let listOnly = false
  const groups = []
  const extra = []
  let passthrough = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (passthrough) {
      extra.push(arg)
      continue
    }
    if (arg === '--') {
      passthrough = true
      continue
    }
    if (arg === '--stories') {
      stories = true
      continue
    }
    if (arg === '--list') {
      listOnly = true
      continue
    }
    if (arg === '--group') {
      const next = argv[i + 1]
      if (!next) {
        throw new Error('Missing value for --group')
      }
      i += 1
      for (const part of next.split(',')) {
        const trimmed = part.trim().toLowerCase()
        if (trimmed) groups.push(trimmed)
      }
      continue
    }
    if (arg.startsWith('--group=')) {
      const val = arg.slice('--group='.length)
      for (const part of val.split(',')) {
        const trimmed = part.trim().toLowerCase()
        if (trimmed) groups.push(trimmed)
      }
      continue
    }
    extra.push(arg)
  }

  return { stories, listOnly, groups, extra }
}

function matchesGroup(relPath, group) {
  if (group === 'stories') {
    return relPath.startsWith('scripts/stories/')
  }
  if (group === 'pool') {
    return relPath === 'scripts/render-pool.test.mjs'
  }
  if (group === 'cloud') {
    return !relPath.startsWith('scripts/stories/') && /cloud/i.test(path.basename(relPath))
  }
  return relPath.startsWith(`scripts/${group}/`)
}

function selectTests({ stories, groups }) {
  const all = walkTests(SCRIPTS_DIR).sort()

  if (stories && groups.length === 0) {
    return all.filter((f) => f.startsWith('scripts/stories/'))
  }

  if (groups.length > 0) {
    return all.filter((f) => {
      if (!stories && f.startsWith('scripts/stories/') && !groups.includes('stories')) {
        return false
      }
      return groups.some((g) => matchesGroup(f, g))
    })
  }

  return all.filter((f) => !f.startsWith('scripts/stories/'))
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[run-tests] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }

  const files = selectTests(opts)
  if (files.length === 0) {
    process.stderr.write(
      `[run-tests] No test files matched (stories=${opts.stories}, groups=${opts.groups.join(',') || 'all'})\n`
    )
    process.exit(1)
  }

  if (opts.listOnly) {
    for (const file of files) {
      process.stdout.write(`${file}\n`)
    }
    return
  }

  const label = opts.stories
    ? 'stories'
    : opts.groups.length > 0
      ? `group:${opts.groups.join(',')}`
      : 'all'
  process.stdout.write(`[run-tests] Running ${files.length} test file(s) (${label})...\n`)

  const res = spawnSync(process.execPath, ['--test', ...opts.extra, ...files], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })

  if (res.error) {
    process.stderr.write(`[run-tests] Failed to spawn node --test: ${res.error.message}\n`)
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}

main()
