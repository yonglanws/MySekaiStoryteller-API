#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# MySekaiStoryteller-API Docker Entrypoint
# =============================================================================
# - Works with zero config.yaml (pure environment variables) or mounted /app/config.yaml
# - Auto-discovers full Playwright Chromium binary (never falls back to headless-shell)
# - Applies MSS_GPU_MODE presets without clobbering explicit MSS_* overrides
# - Logs a clean startup summary without ever printing secrets or API keys
# =============================================================================

discover_full_chromium() {
  local browsers_dir="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
  local candidate=""
  local matches=()

  # Search full Chromium installations first (Playwright <1.56: chrome-linux/chrome,
  # Playwright >=1.56: chrome-linux64/chrome). Never match chromium_headless_shell.
  if [ -d "${browsers_dir}" ]; then
    local prev_nullglob
    prev_nullglob="$(shopt -p nullglob || true)"
    shopt -s nullglob
    for candidate in \
      "${browsers_dir}"/chromium-*/chrome-linux/chrome \
      "${browsers_dir}"/chromium-*/chrome-linux64/chrome; do
      if [ -f "${candidate}" ] && [ -x "${candidate}" ]; then
        matches+=("${candidate}")
      fi
    done
    eval "${prev_nullglob}"
    if [ "${#matches[@]}" -gt 0 ]; then
      if [ "${#matches[@]}" -eq 1 ]; then
        printf '%s\n' "${matches[0]}"
      else
        printf '%s\n' "${matches[@]}" | sort -V | tail -n 1
      fi
      return 0
    fi
  fi

  # Fallback to system full Chrome/Chromium binaries if present
  for candidate in /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -f "${candidate}" ] && [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

# 1. Auto-discover full Chromium if MSS_BROWSER_EXECUTABLE is unset/empty
if [ -z "${MSS_BROWSER_EXECUTABLE:-}" ]; then
  if detected_chrome="$(discover_full_chromium)"; then
    export MSS_BROWSER_EXECUTABLE="${detected_chrome}"
  fi
fi

# 2. Apply GPU mode defaults when MSS_GPU_PROFILE / MSS_GPU_MODE is set
#    (MSS_GPU_PROFILE takes precedence over MSS_GPU_MODE to match src/host/config.ts).
#    Explicit MSS_CHROME_ARGS / MSS_LINUX_GPU_ANGLE / MSS_FFMPEG_ENCODER / MSS_VIDEO_ENCODER always win.
gpu_mode_raw="${MSS_GPU_PROFILE:-${MSS_GPU_MODE:-}}"
gpu_mode="$(printf '%s' "${gpu_mode_raw}" | tr '[:upper:]' '[:lower:]')"

case "${gpu_mode}" in
  intel)
    if [ -z "${MSS_CHROME_ARGS:-}" ]; then
      export MSS_CHROME_ARGS="--use-gl=angle --use-angle=vulkan --enable-features=Vulkan"
    fi
    if [ -z "${MSS_LINUX_GPU_ANGLE+x}" ]; then
      export MSS_LINUX_GPU_ANGLE="false"
    fi
    if [ -z "${MSS_FFMPEG_ENCODER:-}" ] && [ -z "${MSS_VIDEO_ENCODER:-}" ]; then
      export MSS_FFMPEG_ENCODER="intel"
    fi
    ;;
  nvidia)
    if [ -z "${MSS_CHROME_ARGS:-}" ]; then
      export MSS_CHROME_ARGS="--use-angle=vulkan"
    fi
    if [ -z "${MSS_LINUX_GPU_ANGLE+x}" ]; then
      export MSS_LINUX_GPU_ANGLE="false"
    fi
    if [ -z "${MSS_FFMPEG_ENCODER:-}" ] && [ -z "${MSS_VIDEO_ENCODER:-}" ]; then
      export MSS_FFMPEG_ENCODER="nvidia"
    fi
    ;;
  amd)
    if [ -z "${MSS_FFMPEG_ENCODER:-}" ] && [ -z "${MSS_VIDEO_ENCODER:-}" ]; then
      export MSS_FFMPEG_ENCODER="amd"
    fi
    ;;
  cpu)
    if [ -z "${MSS_FFMPEG_ENCODER:-}" ] && [ -z "${MSS_VIDEO_ENCODER:-}" ]; then
      export MSS_FFMPEG_ENCODER="libx264"
    fi
    ;;
  ""|auto)
    ;;
  *)
    echo "[entrypoint] WARN: unrecognized MSS_GPU_PROFILE/MSS_GPU_MODE='${gpu_mode_raw}' (expected: auto|intel|nvidia|amd|cpu); using default GPU settings." >&2
    ;;
esac

# 3. Inspect config.yaml status (pure-env startup works with no config.yaml)
config_path="${MSS_CONFIG_PATH:-/app/config.yaml}"
if [ -f "${config_path}" ]; then
  config_status="mounted (${config_path})"
elif [ -d "${config_path}" ]; then
  config_status="WARNING: ${config_path} is a directory (create config.yaml before mounting!)"
  echo "[entrypoint] WARN: ${config_path} is a directory, not a file. Ignoring it and running in pure-env mode." >&2
else
  config_status="none (pure-env / built-in defaults)"
fi

# 4. Ensure runtime directories exist (non-fatal if read-only)
mkdir -p "${MSS_OUTPUT_DIR:-/app/apifile}" "${MSS_RESOURCE_DIR:-/app/resources}" /app/cache 2>/dev/null || true

# 5. Determine secret presence booleans (NEVER print actual secret values)
llm_key_env_name="${MSS_LLM_API_KEY_ENV:-MSS_LLM_API_KEY}"
if [[ "${llm_key_env_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -n "${!llm_key_env_name:-}" ]; then
  llm_key_status="set (${llm_key_env_name})"
else
  llm_key_status="unset (${llm_key_env_name})"
fi

if [ -n "${MSST_API_KEY:-}" ] || [ -n "${MSS_API_KEY:-}" ]; then
  api_auth_status="enabled"
else
  api_auth_status="disabled"
fi

# 6. Print clean startup summary
cat <<EOF
================================================================================
 MySekaiStoryteller-API (Docker)
--------------------------------------------------------------------------------
 Config file      : ${config_status}
 Listen           : ${MSS_HOST:-0.0.0.0}:${MSS_PORT:-9881} (API auth: ${api_auth_status})
 Browser          : ${MSS_BROWSER_EXECUTABLE:-auto-detect}
 GPU mode         : ${gpu_mode:-auto}
 FFmpeg           : ${MSS_FFMPEG_PATH:-auto} (encoder: ${MSS_FFMPEG_ENCODER:-auto})
 Linux GPU ANGLE  : ${MSS_LINUX_GPU_ANGLE:-default}
 Chrome args      : ${MSS_CHROME_ARGS:-default}
 Video            : ${MSS_VIDEO_WIDTH:-default}x${MSS_VIDEO_HEIGHT:-default} @ ${MSS_VIDEO_FPS:-default}fps (codec: ${MSS_VIDEO_CODEC:-hevc}, rust: ${MSS_USE_RUST_EXPORTER:-true})
 Memory / Workers : profile=${MSS_MEMORY_PROFILE:-standard}, workers=${MSS_WORKERS:-default}
 Cloud / BGM      : cloudOnly=${MSS_ASSETS_CLOUD_ONLY:-default}, cloudCatalog=${MSS_ASSETS_CLOUD_CATALOG:-default}, bgmVolume=${MSS_BGM_VOLUME:-0.35}
 LLM              : enabled=${MSS_LLM_ENABLED:-true}, model=${MSS_LLM_MODEL:-default}, pipeline=${MSS_LLM_PIPELINE:-default}, key=${llm_key_status}
 TTS              : enabled=${MSS_TTS_ENABLED:-default}, provider=${MSS_TTS_PROVIDER:-default}
================================================================================
EOF

exec "$@"
