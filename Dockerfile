# =============================================================================
# MySekaiStoryteller-API — Production Multi-Stage Dockerfile
# =============================================================================
# Build (default international mirrors):
#   docker build -t mysekai-storyteller-api .
#
# Build (China mirror acceleration — rsproxy.cn + npmmirror.com):
#   docker build --build-arg BUILD_MIRROR=cn -t mysekai-storyteller-api .
# =============================================================================

# Aligned with the resolved playwright version in package-lock.json (1.63.0).
# docker/entrypoint.sh dynamically discovers /ms-playwright/chromium-*/chrome-linux*/chrome
# so minor Playwright image bumps never break or fall back to headless-shell.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
ARG BUILD_MIRROR=global

# -----------------------------------------------------------------------------
# Stage 1: Builder — compile web renderer, Node host, and native Rust exporter
# -----------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS builder

ARG BUILD_MIRROR=global
ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install native C/C++ build toolchain for Rust N-API & workspace crates
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Rust stable toolchain (required for edition = "2024", rust-version = "1.98")
ENV CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH="/root/.cargo/bin:${PATH}"

RUN set -eux; \
    if [ "${BUILD_MIRROR}" = "cn" ]; then \
      export RUSTUP_DIST_SERVER="https://rsproxy.cn"; \
      export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"; \
      curl --proto '=https' --tlsv1.2 -fsSL https://rsproxy.cn/rustup-init.sh \
        | sh -s -- -y --profile minimal --default-toolchain stable; \
      mkdir -p "${CARGO_HOME}"; \
      printf '%s\n' \
        '[source.crates-io]' \
        'replace-with = "rsproxy-sparse"' \
        '[source.rsproxy-sparse]' \
        'registry = "sparse+https://rsproxy.cn/index/"' \
        '[net]' \
        'git-fetch-with-cli = true' \
        > "${CARGO_HOME}/config.toml"; \
    else \
      curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable; \
    fi; \
    rustc --version && cargo --version

# Install Node dependencies (cache-friendly layer)
COPY package.json package-lock.json .npmrc ./

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN set -eux; \
    if [ "${BUILD_MIRROR}" = "cn" ]; then \
      npm config set registry https://registry.npmmirror.com/; \
    else \
      npm config set registry https://registry.npmjs.org/; \
      sed -i 's|https://registry\.npmmirror\.com/|https://registry.npmjs.org/|g' package-lock.json; \
    fi; \
    npm ci --no-audit --no-fund

# Copy project source and build frontend, host, and native Rust N-API + CLI
COPY tsconfig.json tsconfig.node.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY native ./native

RUN npm run build \
    && npm run build:rust \
    && test -f /app/native/mss-export-rs/target/release/mss-export-napi.node \
    && test -x /app/native/mss-export-rs/target/release/mss-export-rs \
    && npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: Runtime — Playwright Chromium + GPU/VAAPI/QSV + FFmpeg + CJK fonts
# -----------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Enable Ubuntu multiverse (for intel-media-va-driver-non-free on amd64) and install
# Mesa Vulkan/EGL/GL, Intel VAAPI/QSV, system FFmpeg, CJK fonts, and healthcheck tools.
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/ubuntu.sources ] && ! grep -q 'multiverse' /etc/apt/sources.list.d/ubuntu.sources; then \
      sed -i 's/^Components: \(.*\)$/Components: \1 multiverse/' /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    apt-get update; \
    ARCH="$(dpkg --print-architecture)"; \
    INTEL_PKGS=""; \
    if [ "${ARCH}" = "amd64" ]; then \
      INTEL_PKGS="libdrm-intel1 intel-media-va-driver-non-free libmfx-gen1.2 libvpl2"; \
    fi; \
    apt-get install -y --no-install-recommends \
      libgl1-mesa-dri \
      libegl1 \
      libgles2 \
      libgbm1 \
      mesa-vulkan-drivers \
      vainfo \
      ${INTEL_PKGS} \
      ffmpeg \
      fonts-noto-cjk \
      curl \
      ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts and production dependencies from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/out ./out
COPY --from=builder /app/out-host ./out-host
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/native/mss-export-rs/target/release/mss-export-napi.node ./native/mss-export-rs/target/release/mss-export-napi.node
COPY --from=builder /app/native/mss-export-rs/target/release/mss-export-rs ./native/mss-export-rs/target/release/mss-export-rs
COPY config.example.yaml ./config.example.yaml
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh /app/native/mss-export-rs/target/release/mss-export-rs \
    && mkdir -p /app/apifile /app/resources /app/cache /app/personas

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MSS_FFMPEG_PATH=/usr/bin/ffmpeg \
    MSS_HOST=0.0.0.0 \
    MSS_PORT=9881 \
    MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=131072

EXPOSE 9881

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9881/api/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "out-host/host/main.js"]
