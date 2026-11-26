import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(rootDir, 'native', 'mss-export-rs', 'Cargo.toml')
const mode = process.argv.includes('--test') ? 'test' : 'build'

function tryCargo(args) {
  const res = spawnSync('cargo', args, { stdio: 'inherit', cwd: rootDir })
  return res.status === 0
}

function findRustupToolchain() {
  const res = spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8', cwd: rootDir })
  if (res.status !== 0 || !res.stdout) return null
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean)
  const preferred = lines.find((t) => t.startsWith('1.98')) ?? lines[0]
  return preferred ?? null
}

const subArgs =
  mode === 'test'
    ? ['test', '--manifest-path', manifestPath]
    : ['build', '--release', '--manifest-path', manifestPath]

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
if (probe.status === 0) {
  if (!tryCargo(subArgs)) process.exit(1)
  process.exit(0)
}

const toolchain = findRustupToolchain()
if (toolchain) {
  if (!tryCargo([`+${toolchain}`, ...subArgs])) process.exit(1)
  process.exit(0)
}

console.error('[build-rust-exporter] No usable Rust toolchain found (cargo/rustup unavailable)')
process.exit(1)
