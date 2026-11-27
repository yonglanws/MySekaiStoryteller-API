import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const crateDir = path.join(rootDir, 'native', 'mss-export-rs')
const manifestPath = path.join(crateDir, 'Cargo.toml')
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

function copyNapiAddon(profileDir) {
  const libFile =
    process.platform === 'win32'
      ? 'mss_export_napi.dll'
      : process.platform === 'darwin'
        ? 'libmss_export_napi.dylib'
        : 'libmss_export_napi.so'
  const srcPath = path.join(crateDir, 'target', profileDir, libFile)
  if (!fs.existsSync(srcPath)) {
    return false
  }
  const dstPath = path.join(crateDir, 'target', profileDir, 'mss-export-napi.node')
  fs.copyFileSync(srcPath, dstPath)
  return true
}

const subArgs =
  mode === 'test'
    ? ['test', '--workspace', '--manifest-path', manifestPath]
    : ['build', '--release', '--workspace', '--manifest-path', manifestPath]

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
let ok = false
if (probe.status === 0) {
  ok = tryCargo(subArgs)
} else {
  const toolchain = findRustupToolchain()
  if (!toolchain) {
    console.error('[build-rust-exporter] No usable Rust toolchain found (cargo/rustup unavailable)')
    process.exit(1)
  }
  ok = tryCargo([`+${toolchain}`, ...subArgs])
}

if (!ok) process.exit(1)

if (mode === 'build') {
  if (!copyNapiAddon('release')) {
    console.error('[build-rust-exporter] Failed to stage mss-export-napi.node in target/release')
    process.exit(1)
  }
}
