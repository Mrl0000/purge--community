# 自己维护手册（MAINTAINING.md）

面向「自己改、自己发版」的维护者。所有数字都是 **2026-10-22 在本机实测得到的**，不是抄文档。

- 插件版本：`1.6.43`（`dsh-purge-community`，MIT）
- 宿主目标：`dshTarget: 0.2.1-rc.1`（已验证 rc.1 / rc.2，其它版本只会被标「未验证」）
- 源码规模：331 个文件 / `lib` 85 个模块 / `test` 56 个测试文件
- 原作者文档：`AGENTS.md`（面向 agent，最长最细）、`docs/MAINTENANCE.md`（面向人）

---

## 0. 本机基线（先记住这几个数）

| 指标 | 实测值 |
| --- | --- |
| `npm test` | **317 tests / 294 pass / 0 fail / 23 skipped**，约 44 秒 |
| `npm run check:docs` | PASS（`✓ 文档版本一致：1.6.43`） |
| `npm run check:client` | PASS（`PASS: checked-in bundle matches source`） |
| 23 个 skip | 全部是平台条件测试（Linux 安装器、macOS 换包、真实 Electron、符号链接/只读宿主），Windows 上属**预期跳过**，不是失败 |
| 补丁对象数 | `lib/core.js` 内 72 组 + `lib/steering.js` 1 组 = **73** |
| 面板产物 | 根目录 `client.js` = 630,324 B，由 `packages/purge-panel` 用 esbuild 打包生成（改面板源码后数字会变，只要 `check:client` PASS 即可） |

**判断标准：`0 fail` 才算干净。** 出现 fail 先看是不是环境问题（见 §5），不要先怀疑代码。

> 实测提醒：首次全量跑出现过 **1 次 fail**（`test/asar-swap-fallback.test.mjs` 清理阶段 `EPERM ... rm`），单独跑 3 次全过 → 判定为清理竞态，已在本次维护中修掉（见 §8 第 7 条），修完连跑 2 次全量均为 `294 pass / 0 fail`。

---

## 1. 环境搭建（本机有两个坑，都实测过）

本机实测：Node `v24.20.0`、npm `11.19.0`、git `2.56.0.windows.2`。

### 坑 1：PowerShell 执行策略为 Restricted

表现：`npm test` 里 `test/asar-swap-fallback.test.mjs` 的 4 个用例失败，报

```
handoff.ps1 cannot be loaded because running scripts is disabled on this system
```

同样原因，直接敲 `npm` 会命中最先被解析的 `npm.ps1` 而报 `UnauthorizedAccess`。

三种解法（任选，效果等价）：

```powershell
# A. 只对当前进程生效，最不改动系统
$env:PSExecutionPolicyPreference='Bypass'

# B. 对当前用户长期生效（推荐，开发机常态）
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# C. 规避 npm.ps1，改用 npm.cmd
& "C:\Program Files\nodejs\npm.cmd" test
```

验证过：A 之后 `test/asar-swap-fallback.test.mjs` 从 4 fail 变 **7/7 pass**，全量变 **294 pass / 0 fail**。

### 坑 2：github.com 时通时断，且 zip 会丢执行位

本机实测（2026-10-22）：同一分钟内 `curl https://github.com` 先 `200`、紧接着连续 `000`（exit 28）；`git fetch` 报 `Failed to connect to github.com:443 after 21094 ms`。**但重试就通**：循环 `git fetch` 第三次成功，之后 `git ls-remote`、`git push --dry-run` 都正常。四个域名是独立通路：

- `github.com:443` → 时断，重试可通
- `codeload.github.com` / `api.github.com` → 可用
- `registry.npmjs.org` → 可用（所以 `npm install` 不受影响）
- `127.0.0.1:7890`（FlClash）有进程监听，但对 github.com 握手失败（`000`）——**不要**给 git 设 `http.proxy` 走它；本机 `git config --list` 里保持没有任何 proxy 项

拿源码就用 `git clone` / `git fetch`，失败时重试：

```powershell
foreach ($i in 1..10) { git fetch origin; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 10 }
```

**不要拿 codeload zip 当工作副本**：zip 没有 `.git`（无历史、不能 merge），并且解包后 `bin/dsh-purge.js`、`bin/community.js`、`scripts/install.sh` 的 `100755` 会变成 `100644`。核对命令 `git ls-files -s`，这三个必须是 `100755`，否则 Linux/macOS 安装器 `Permission denied`。已经丢了就用 `git update-index --chmod=+x <file>` 修回来再提交。

### 从零跑通（按顺序，已全部验证）

```powershell
$env:PSExecutionPolicyPreference='Bypass'
cd <repo>
& "C:\Program Files\nodejs\npm.cmd" install --no-audit --no-fund        # 4 个包，约 1 秒
cd packages\purge-panel
& "C:\Program Files\nodejs\npm.cmd" install --no-audit --no-fund        # 15 个包，约 9 秒（esbuild/react）
cd ..\..
& "C:\Program Files\nodejs\npm.cmd" test                                # 317 项
& "C:\Program Files\nodejs\npm.cmd" run check:client
& "C:\Program Files\nodejs\npm.cmd" run check:docs
```

**`packages/purge-panel` 的依赖必须单独装。** 不装的话 `check:client` / `build:client` 会直接 `ERR_MODULE_NOT_FOUND: esbuild`——根目录的 `devDependencies` 里没有 esbuild，它在子包的 `devDependencies`。

---

## 2. 五条命令各自管什么

| 命令 | 管什么 | 什么时候必须跑 |
| --- | --- | --- |
| `npm test` | 317 项单测 + 契约测试，`node --test`，纯 Node，不碰宿主 | 每次改动 |
| `npm run check:client` | 根 `client.js` 与 `packages/purge-panel/src` 是否同步（esbuild `--check`） | 改了面板源码后 |
| `npm run check:docs` | 版本号与文档一致性（见 §6 精确清单） | 每次发版 |
| `npm run smoke` | `npm pack --ignore-scripts` + 校验发行包内容 | 发版前 |
| `npm run test:electron` | 真实 Electron 跑自检/诊断/换包（临时目录，不动安装） | 改了宿主补丁或换包逻辑 |

另有：`build:client`（重建 client.js）、`embed-prompt`（重嵌提示词）、`test:ui`（面板渲染测试）、`test:linux`（只跑 Linux 安装器测试）。

**包名不止一个**：仓库发布的包是 `dsh-purge-community`，但 `lib/community.js:16` 的 `PURGE_PACKAGES = ["dsh-purge", "dsh-purge-panel", PACKAGE]` 还带着两个旧名，安装、校验、回滚都按这三个名字扫描——排查「装上了但没生效」时要三个都看。

---

## 3. 改哪个文件 → 跑哪些测试

下表是从 56 个测试文件里实测出的 `import` 关系反推的，不是猜的。

### 高频触达模块

| 改这个 | 必跑 |
| --- | --- |
| `lib/core.js`（宿主补丁表 + 注入核心，352 KB） | `test/patch-anchors.test.mjs`、`bypass-contract`、`anchors`、`host-layout`、`host-backup`、`selfcheck`、`instance`、`steer-*`、`ask-user-wait`、`settings-api`、`presets`、`preset-injection`、`community`、`issue40-followup` |
| `lib/index.js`（插件入口） | `test/plugin-lifecycle.test.mjs`、`prompt-sections`、`preset-injection`、`inject-split` |
| `lib/rules.js`（提示词规则） | **无直接单测**，只被 `index.js`/`core.js` 间接覆盖 → 必须手动验证 |
| `lib/boost.js`（尾部强化段） | `test/boost.test.mjs`、`inject-contract`、`prompt-sections` |
| `lib/tuning.js`（开关状态） | `test/boost`、`prompt-sections`、`preset-injection`、`review-integrity` |
| `lib/identity.js` | `test/cwd-compat.mjs`、`inject-split`、`review-integrity` |
| `lib/probe.js` | `test/probe.test.mjs`、`preset-injection` |
| `lib/refusal-retry.js` | `test/refusal-retry.test.mjs`、`review-integrity` |
| `lib/steering.js` | `test/steering-files`、`steering-runtime`、`steer-migration` |
| `lib/anchors.js` | `test/anchors.test.mjs` |
| `lib/asset-table.js`（提示词密文表） | **无直接单测**，由 `embed-prompt` 生成 → 见 §4-C |

### 宿主与换包

| 改这个 | 必跑 |
| --- | --- |
| `lib/extract-asar.js` | `test/host-backup`、`host-layout`、`atomic-files`、`instance` |
| `lib/windows-asar-handoff.js` | `test/asar-swap-fallback`、`windows-electron-handoff` |
| `lib/macos-asar-handoff.js` | `test/macos-handoff`（Windows 上 skip，等于没护栏） |
| `lib/host-layout.js` | `test/host-layout.test.mjs` |
| `lib/runtime-layout.js` | `test/runtime-layout`、`atomic-files` |
| `lib/instance.js` | `test/instance`、`issue40-followup` |
| `lib/surface.js` | `test/issue40-followup` |
| `lib/atomic-files.js` | `test/atomic-files`、`audit-regressions` |
| `lib/desktop.js`（63 KB） | 只被 `atomic-files` 间接覆盖 |

### 更新、自检、CLI

| 改这个 | 必跑 |
| --- | --- |
| `lib/update.js`（51 KB） | `test/update-http`、`update-policy`、`update-recovery`、`update-status` |
| `lib/update-policy.js` / `update-state.js` / `update-integrity.js` | `update-policy`、`update-state`、`update-integrity`、`audit-regressions` |
| `lib/update-install.js` | `test/update-integrity`、`community`、`audit-regressions` |
| `lib/update-http.js` / `update-net.js` / `update-download.js` | `update-http`、`update-source`、`update-proxy-runtime`、`update-download` |
| `lib/selfcheck.js` | `test/selfcheck`、`audit-regressions`、`instance`、`issue40-followup` |
| `lib/community.js`（CLI 实现） | `test/community`、`install-registry`、`update-*` 全套 |
| `lib/audit.js` | `test/audit`、`review-integrity`、`audit-regressions` |
| `lib/permission-state.js` / `command-registration.js` / `web.js` / `uninstall.js` | 同名测试文件 |

### 面板

改 `packages/purge-panel/src/**` → `npm run build:client` 重建根 `client.js` → `check:client` → `npm run test:ui`。**根目录 `client.js` 是产物，不要手改**。

---

## 4. 无测试护栏的模块（改之前先想清楚）

85 个 `lib` 模块里，**41 个没有被任何测试直接 import**。按风险排序：

| 模块 | 大小 | 说明 |
| --- | --- | --- |
| `lib/rules.js` | 17 KB | 提示词规则解析，影响每次注入 |
| `lib/skills.js` | 28 KB | 技能落盘 |
| `lib/net-scope.js` | 25 KB | 网络范围判定 |
| `lib/hide-console.js` | 12 KB | 宿主控制台处理 |
| `lib/rewind.js` | 21 KB | 回退 |
| `lib/continue-retry.js` | 12 KB | 自动继续/重试 |
| `lib/hooks-deny.js` | 8 KB | 钩子放行策略 |
| `lib/zip-extract.js` / `restart-desktop.js` / `official-update.js` / `settle-policy.js` / `drill-grant.js` / `capability-protocol.js` / `table-key.js` / `table-read.js` | 0.5–14 KB | 工具类 |
| `lib/redteam/**`（**16 个模块，合计约 1.0 MB**） | 最大 340 KB | `store-core.js` 340 KB、`client.js` 278 KB、`tools.js` 125 KB、`score-rules.js` 59 KB 全部无直接单测 |

改这些模块时，`npm test` 全绿**不代表没坏**，必须真机走一遍对应功能。

---

## 5. 三类改动的标准流程

### A. 改宿主补丁（新增/修复一条 patch）

1. 定位 `lib/core.js` 的 `PATCHES`(≈2527) / `CODE_PATCHES`(≈2788) / `ENGINE_PATCHES`(≈2829) / `NEW_TOOL_PATCHES`(≈3101)，合并口径是 `ALL_PATCHES`(≈5725)。
2. 每条结构：`{id, name, layer, file, replacements:[{pattern, replace}], markers, optional?}`；`pattern` 是宿主源码里的**精确片段**。
3. `replace` 里留 `[dsh-purge]` 标记，并把同一标记写进 `markers`（判断「已应用」靠它）。
4. 在 `test/patch-anchors.test.mjs` 钉一段真实宿主片段做回归——这条最容易忘，忘了下次升级就静默失配。
5. 新增目标文件要登记到 `targetFiles()`；第三方插件目标用 `optional: true`，不在场时显示「不适用」而不是失败。
6. 宿主升级后锚点漂移：`node bin/community.js diagnose` 给出文件/行号/候选落点；确认后用 `reanchor apply <id> --lines A-B`（先看 dry-run，再加 `--yes`），覆盖存 `anchor-overrides.json`，`reanchor clear <id>` 撤销。
7. 跑 `npm test`（至少 `patch-anchors` + `anchors` + `selfcheck`）。

### B. 改面板 UI

`packages/purge-panel/src/components/*.js` 改完 → `npm run build:client` → `check:client` → `test:ui`。面板是独立 npm 包（`dsh-purge-panel@1.1.2`），有自己的版本号和 `files`，发版时和主包版本**不要求同步**，但 `repository.directory` 指向 `packages/purge-panel`。

### C. 改注入提示词 / 规则

注意一个反直觉的点：**明文提示词不在仓库里。**

- `lib/default-prompt-inject.md` 被 `.gitignore` 忽略（也在 `files` 里被排除），且 `package.json` 的 `files` 明确排除了它 → 新克隆**没有这个文件**。
- `scripts/embed-default-prompt.mjs` 要求它必须存在，否则 `throw new Error("missing local source")`。
- 它的密文形态在 `lib/asset-table.js`（`SLOT`/`MASK`/`TAG`/`IV`，由 `lib/table-key.js` 的 `sealSlot()` 生成）。

所以流程是：**先有本地明文 → 改 → `npm run embed-prompt` 覆盖 `lib/asset-table.js`**。没有明文源时，只能改已嵌好的 `asset-table.js`（不推荐，无校验）。

改完必跑：`inject-contract`、`bypass-contract`、`review-integrity`、`prompt-sections`——这四个是**契约测试**，逐条校验注入正文里的关键句，改文本会同时打红，属于预期行为，要同步改期望值。

---

## 6. 发版：`check:docs` 的精确校验项

`scripts/check-docs.mjs`（50 行）逐条校验下面每一项，少一条直接 exit 1：

| 文件 | 必须满足 |
| --- | --- |
| `package.json` | `version` 是唯一真源 |
| `README.zh-CN.md` | **必须与 `README.md` 逐字节相同** |
| `README.md` | 含 `**<version>**`；含 `适配 **DSH Desktop x.y.z**`；含 `scripts/install.ps1`、`issue #7`、`插件加载前`、`不修改全局 npm 源`；含 `raw.githubusercontent.com/Mrl0000/dsh-purge/master/scripts/install.sh`（换仓库时这里要跟 `check-docs.mjs:30` 一起改） |
| `release-notes.md` | 首行必须是 `# <version>` |
| `docs/README.en.md` | 含 `Current version <version>` |
| `docs/MAINTENANCE.md`、`docs/INSTALLATION.md` | 含 `当前版本 **<version>**` |
| `AGENTS.md` | 含 `当前版本：**<version>**`；含 `` `dsh-purge-community` <version> ``；含 `scripts/install.ps1`、`minimumReleaseAge=0`、`不要安装后自动 apply/restart` |

**改版本号 = 改上面 7 个文件。** 别只改 `package.json`。

发版动作：`npm run smoke`（打 tgz）→ 命名 `dsh-purge-community-<version>.tgz` → 挂 Release → 出 SHA256 清单（`lib/update-integrity.js` 会校验）。

### 更新源：已经改指向 `Mrl0000/dsh-purge`（2026-10-22 改完并验证）

这份拷贝的自我更新入口原本全部指向社区仓库 `kingcharleslzy-ai/dsh-purge`。**已整体换到你自己的仓库**，改过的位置与改后取值：

| 位置 | 改后 |
| --- | --- |
| `lib/update-net.js:10-11` | `SOURCE_REPO = "Mrl0000/dsh-purge"`；`UPSTREAM_REPO = SOURCE_REPO` |
| `lib/community.js:14` | `REPOSITORY = "Mrl0000/dsh-purge"` |
| `package.json:75,77,79` | `repository` / `homepage` / `bugs` 三项 |
| `package.json:98-99` | `dsh.install.tarball` = `https://github.com/Mrl0000/dsh-purge/releases/latest/download/dsh-purge-community-<version>.tgz`；`dsh.install.git` |
| `scripts/bootstrap-install.mjs:10`、`scripts/build-market.mjs:6` | `const repo = "Mrl0000/dsh-purge"` |
| `scripts/install.ps1:50`、`scripts/install.sh:55` | bootstrap raw URL 指向本仓库 `master` |
| `scripts/check-docs.mjs:30` | 硬校验 README 含 `raw.githubusercontent.com/Mrl0000/dsh-purge/master/scripts/install.sh` |
| `test/update-source.test.mjs:8,15` | 断言 `SOURCE_REPO` 与 `archiveZipUrl()` 都指向 `Mrl0000/dsh-purge` |
| `.github/workflows/release.yml:13`、`market.yml:18` | 发布门禁 `github.repository == 'Mrl0000/dsh-purge'` |
| `packages/purge-panel/src/entry.js:51`、`src/components/maintenance.js:486` | 面板里的仓库/Releases 链接；**改完必须 `npm run build:client`** 重生成根目录 `client.js` |
| `market/README.md:3`、`market/validate.mjs:3` | 市场索引地址 `https://mrl0000.github.io/dsh-purge/index.json` |

**故意没改的（别跟着改）**：

- `package.json:140` 的 `author`、README 里的作者头像、`CONTRIBUTORS.md`、`release-notes.md`、`docs/releases/**`、`docs/upstream/**`、`NOTICE.md` —— 这些是**署名与历史记录**；指向社区仓库的 PR/issue 链接仍然有效。
- `README.md:33` 的 `dsh-qwen-studio` 链接 —— 同作者的另一个项目，不在本仓库范围。
- `.github/workflows/community.yml:138` 的 `--repo kingcharleslzy-ai/dsh-purge --pattern dsh-purge-community-1.6.36.tgz` —— 它拉的是**历史基线包**做回归，只存在于社区仓库；改到自己仓库会 404。

**地址与校验是联动的**：只改地址、不改 `check-docs.mjs:30` 和 `test/update-source.test.mjs`，会同时打红 `check:docs` 和 `npm test`。本次改完实测三项全绿：`npm test` 317 项 / 294 pass / 0 fail、`check:docs` PASS、`check:client` PASS。

发版真正要做的只有两件：

1. 给 Release 挂上 `dsh-purge-community-<version>.tgz` 和 `SHA256SUMS.txt`（`lib/update-integrity.js` 用它校验）；
2. 面板维护页保持**自动检查开、自动安装关**。

> 一个事实：`lib/update-integrity.js` 从 GitHub 拉源码 ZIP 时会按 commit SHA + 每个文件的 Git blob 摘要校验，所以任何时候都别手工改 Release 附件或跳过校验。
---

## 7. 两个 remote 与上游同步

本地是**真实 git 历史**（HEAD = `26bea56 Release 1.6.43`，社区仓库 389 个提交 + 本地提交），不是 zip 快照：

| remote | URL | 说明 |
| --- | --- | --- |
| `origin` | https://github.com/Mrl0000/dsh-purge.git | **你自己的仓库**。本机 GitHub 凭证身份 = `Mrl0000`，`git push --dry-run` 已验证可写 |
| `upstream` | https://github.com/kingcharleslzy-ai/dsh-purge.git | 这份代码的实际来源（community fork） |
| （历史） | https://github.com/YuJunZhiXue/dsh-purge.git | 原作者 小杨 / YuJunZhiXue（`NOTICE.md:3-4`） |

**别 force push 覆盖你仓库的 `master`**：你的 `master` 还停在 v1.1.71（YuJunZhiXue 那条线），和这份 1.6.43 不是同一段历史（实测双向差异：本地领先 289、对方领先 131）。先推独立分支：

```powershell
git push origin HEAD:refs/heads/community-1.6.43
```

要让它当主开发线，之后在 GitHub 网页上把该分支设为 default，或长期在 `community` 分支上开发。

同步社区仓库的新提交（上游推送很频繁，建议每 1–2 周合一次）：

```bash
git fetch upstream && git merge upstream/master
```

- **冲突高发文件**：`lib/core.js`（单文件 352 KB、73 组补丁全挤在这里）、`client.js`（产物，冲突了直接 `build:client` 重生成而不是手改）、`README.zh-CN.md`（必须与 `README.md` 逐字节一致，冲突时以 README.md 为准整体覆盖）、`package.json`（版本 + `dsh.install` 地址 + `Mrl0000` 身份）、`bin/community.js`（CLI 入口，改动集中）。
- 自己的改动放独立分支，别堆在 `master` 上；`git push.default` 已设为 `current`，推同名分支不会误推别的。
- **每次 `npm install` 都会改写 `package-lock.json` 和 `packages/purge-panel/package-lock.json`**（版本行、可选依赖），提交前用 `git checkout -- package-lock.json packages/purge-panel/package-lock.json` 丢掉，除非你本来就想升依赖。
---

## 8. 本机特有的坑（复述一遍，省得到处翻）

1. **PowerShell Restricted** → 4 个测试假失败；`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 或 `$env:PSExecutionPolicyPreference='Bypass'`。
2. **npm 要用 `npm.cmd`**（`npm.ps1` 被策略拦，报 `UnauthorizedAccess`）。
3. **`packages/purge-panel` 必须单独 `npm install`**，否则 `check:client` 报 `ERR_MODULE_NOT_FOUND: esbuild`。
4. **github.com 时通时断**：重试即可通（`foreach ($i in 1..10) { git fetch origin; ... }`），`ls-remote` / `push --dry-run` 都验证过；别用 codeload zip 当工作副本——没有 `.git`，还会把 `bin/dsh-purge.js`、`bin/community.js`、`scripts/install.sh` 的 `100755` 变成 `100644`（`git ls-files -s` 核对，`git update-index --chmod=+x` 修）。
5. **执行策略会被重置回 Undefined**：`Get-ExecutionPolicy -List` 显示 `CurrentUser = Undefined` 时，`asar-swap-fallback` 的 4 个用例会假失败（`handoff timeout` / `Cannot read properties of null`）。重跑 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 即恢复。
6. **`~/.ssh/config` ACL 坏掉会让 ssh 直接拒用**：报 `Bad owner or permissions on C:\Users\Admin/.ssh/config`，且 ACL 里有一个解析不了的旧机器 SID（`S-1-5-21-...-1001`）、owner 是 `BUILTIN\Administrators`。HTTPS 走 Git Credential Manager 不受影响（本机身份 = `Mrl0000`），改 SSH 前先修 ACL。
7. **`npm install` 会改写两个 `package-lock.json`**，`git status` 里出现它们不是你的改动：`git checkout -- package-lock.json packages/purge-panel/package-lock.json`。
8. **PowerShell 读 UTF-8 中文要显式 `-Encoding utf8`**，否则 `package.json` 里的中文描述会乱码，`ConvertFrom-Json` 直接报错（实测踩过）。
9. **`npm test` 里的 23 个 skip 是平台条件**，Windows 上不会跑（Linux 安装器、macOS 换包、真实 Electron、符号链接），别当失败也别当已覆盖。
10. **`asar-swap-fallback` 的清理竞态（已修）**：该测试把 `holder.exe` 起来又杀掉，然后 200ms 后 `fs.rmSync` 整个临时目录；Windows 在进程真正退出前仍持有 exe/目录句柄，全量并行跑时偶发 `EPERM: rm`。修法是加一个重试删除的 `rmrf()`（50 × 100ms）替掉裸 `rmSync`。**这类「清理失败被算成测试失败」的假红以后还会遇到，先单独跑一遍判定，别急着改被测代码。**

---

## 9. 一句话原则

**先跑基线，再动手；改完 `npm test` 必须 0 fail；碰了面板就重建，碰了版本就查文档，碰了宿主补丁就钉锚点。** 任何一项没做，下次宿主升级都会以「静默失配」的形式还回来。
