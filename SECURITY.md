# 安全策略与自托管加固指南 / Security Policy

## 漏洞报告 / Reporting a Vulnerability

如果你发现了安全漏洞（例如路径穿越、未授权访问、命令注入、密钥泄漏或 SSRF），**请勿**直接在公开 Issue 中披露利用细节。

请通过以下任一方式私下联系维护者：

- 使用 GitHub 仓库的 **Security Advisories（Private vulnerability reporting）** 功能提交私密报告；
- 或在提交公开 Issue 仅说明“发现潜在安全问题，需要私下沟通渠道”，避免附带 PoC 或敏感信息。

我们会在确认问题后尽快修复并致谢（如你愿意署名）。

---

## 自托管部署安全加固清单

MySekaiStoryteller-API 默认面向本机或受控内网快速启动（监听 `0.0.0.0:9881` 且未配置密钥时不启用鉴权）。如果你需要将服务暴露给局域网、机器人平台或公网，**请务必完成以下加固步骤**：

### 1. 启用 API Bearer 鉴权

- 在 `.env` 或运行环境中设置高强度随机密钥 `MSS_API_KEY`（或 `MSST_API_KEY`），或在 `config.yaml` 中设置 `server.apiKey`：
  ```bash
  openssl rand -hex 32
  ```
- 开启后，除 `GET /api/v1/health` 与 `OPTIONS` 预检外，所有 `/api/v1/*` 与 `/apifile/*` 请求必须携带 `Authorization: Bearer <KEY>`。
- 未携带合法令牌访问 `GET /api/v1/health` 时，宿主会自动隐藏上游 URL（`tts.apiBaseUrl`、`llm.baseUrl`、`assets.indexBase`、`assets.libraryBase`）以及本机绝对路径（`rustExporter.binaryPath`、`rustExporter.napiPath`）。

### 2. 严格隔离内部 `/bridge/*` 与 Rust 二进制 WebSocket

- `/bridge/*` 路由和本地 Rust 二进制 WebSocket（`/bridge/rs-stream`）**仅供同机 Playwright 渲染 worker 通过回环地址调用**，内置了回环 Origin 校验、一次性桥接令牌与 `realpath` 防越界检查。
- **严禁将 `/bridge/*` 或宿主原始端口直接暴露到公网**。推荐做法：
  1. 将 `server.host` 设为 `127.0.0.1`（或仅在 Docker 内部网络暴露）；
  2. 使用 Nginx / Caddy / Traefik 提供 HTTPS 反向代理，并且**只转发 `/api/v1/` 路径**（明确拒绝 `/bridge/` 与未使用的路径）。

Nginx 反向代理示例片段：

```nginx
location /api/v1/ {
    proxy_pass http://127.0.0.1:9881/api/v1/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 50m;
    proxy_read_timeout 660s;
}

location /bridge/ {
    return 403;
}
```

### 3. 收紧 CORS 白名单

- 如果仅由服务端/机器人插件调用，保持 `server.corsOrigins` 为空（默认仅允许本机回环地址），或显式设置 `server.cors: false`（`MSS_SERVER_CORS=false`）。
- 如果确有浏览器前端跨域访问，通过 `server.corsOrigins` 或 `MSS_CORS_ORIGINS` 明确指定受信任的 Origin 列表，避免使用通配符。

### 4. 保护 `.env` 与 `config.yaml` 权限

- 密钥（`MSS_LLM_API_KEY`、`MSS_API_KEY` 等）应仅存放在 `.env` 或容器/systemd 密钥管理中，**不要写入 `config.yaml` 或提交到 Git**。
- 在 Linux / macOS 上将 `.env` 与 `config.yaml` 权限收紧为仅属主可读（`npm run init` 已默认对 `.env` 应用 `0600`）：
  ```bash
  chmod 600 .env config.yaml
  ```

### 5. 限流、资源隔离与停机保护

- 导出与 AI 生成接口（`/api/v1/export`、`/api/v1/script/generate`、`/api/v1/generate`）内置按客户端 IP 的滑动限流（每 60 秒 10 次，超限返回 `429`）；经反向代理部署时请确保正确转发客户端来源或叠加网关层限流。
- 生产环境建议以非 root 专用系统用户运行服务（或使用 Docker 容器隔离），并合理设置 `render.maxConcurrentExports` 与 `render.minFreeMemoryMb` 防止资源耗尽。
- 避免将宿主机敏感目录挂载进容器，TTS 参考音频与 LoRA 路径应限制在 TTS 服务端专用的只读模型目录内。
