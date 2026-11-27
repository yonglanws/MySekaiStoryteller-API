# 贡献指南 / Contributing Guide

感谢你关注 **MySekaiStoryteller-API**！欢迎提交 Issue、Bug 修复、性能优化、测试补充与文档改进。

## 开发环境准备

- **Node.js**：`>= 20`（推荐 22 LTS）
- **浏览器**：Chrome / Edge / Chromium（本地没有时运行 `npx playwright install chromium`）
- **Rust 工具链（可选）**：仅在修改 `native/mss-export-rs/` 时需要安装 `cargo` / `rustc`（stable）

克隆并安装依赖：

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API
npm ci
npm run build
```

## 常用验证命令

提交 PR 前，请确保以下命令全部通过：

```bash
# 1. TypeScript 类型检查（host + web）
npm run typecheck

# 2. ESLint 代码检查与 Prettier 格式检查
npm run lint
npm run format:check        # 可运行 npm run format 自动格式化

# 3. 构建前端渲染页与 Node 宿主
npm run build

# 4. 全量离线单元测试（scripts/run-tests.mjs 自动发现）
npm run test:all

# 5. 官方基线、内置人设与 AI 剧本测试（无外部语料时自动跳过语料用例）
npm run test:stories

# 6. 如果改动了 native/mss-export-rs/，运行 Rust 单元测试与编译验证
npm run test:rust
npm run build:rust
```

> Windows PowerShell 环境下请使用 `npm.cmd` / `npx.cmd`（且在 PowerShell 5.1 中用 `;` 替代 `&&`）。

## 代码规范与目录约定

- **架构与模块边界**：修改代码前建议先阅读 [系统架构指南](doc/architecture.md) 与 [开发与验证](doc/development.md)，避免将大型逻辑重新堆回单一文件（例如路由放在 `src/host/servers/routes/`，桥接安全与生命周期放在 `src/host/bridge/`，AI 分阶段逻辑放在 `src/host/ai/staged/` 与 `src/host/ai/agent/`）。
- **代码风格**：遵循 `.editorconfig`、`.prettierrc.yaml` 与 `eslint.config.mjs`（统一 UTF-8 + LF 行尾，不引入未使用的依赖或死代码）。
- **测试自动发现**：将新增单元测试放在 `scripts/<module>/<name>.test.mjs`，`npm run test:all` 会通过 `scripts/run-tests.mjs` 自动发现并执行，无需手动修改 `package.json`。
- **隐私与可移植性**：**切勿**在代码、文档或测试中硬编码个人绝对路径（如 `C:\Users\...`、`D:/Users/...`、`/vol2/...`）、内网 IP、密钥或未入库的本地私有文件；可选的外部数据集路径一律通过环境变量传入并在缺失时优雅跳过。
- **版权与素材**：本仓库不收录、不分发光盘/游戏提取素材（Live2D `.moc3`/贴图、音频、背景图等）或私有配置文件（`config.yaml`、`.env`）。

## 提交 Pull Request 清单

- [ ] 改动范围清晰聚焦，已在本地通过 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run test:all`（若涉及 Rust 则含 `npm run test:rust`）。
- [ ] 新增功能或修复的 Bug 均配有对应的离线单元测试。
- [ ] 如变更了配置项、环境变量、HTTP 接口或架构行为，已同步更新 `README.md`、`config.example.yaml`、`.env.example` 与 `doc/` 下对应文档。
- [ ] Commit 信息清晰明了（推荐使用 Conventional Commits 风格，如 `feat(...)`、`fix(...)`、`docs(...)`、`refactor(...)`）。

## 开源协议

提交到本仓库的贡献将遵循项目现有的 **[GNU GPL v3](LICENSE)** 协议发布。
