# dsh-ssh-hub · 服务器机群运维中枢（设计方案）

> 目标：在 DeepSeek Harness 里管理 N 台（10–50 台，纯 Linux 云服务器）服务器，覆盖
> **批量巡检 / 监控告警 / 部署发布 / 跨机日志 / 凭据安全与审计** 五个场景。

---

## 1. 选型结论：为什么是「基座 + 二开」而不是别的路线

### 1.1 市场全量调研结论

DSH 插件市场（awesome-dsh-plugin.com，更新至 2026-11-15）共 **11,332** 个插件。
按 ssh / sftp / vps / sshd 核心词筛出 **133** 个 SSH 相关候选，逐个读源码后横向对比，
关键结论：

| 结论 | 依据 |
|---|---|
| **没有一个插件能完整覆盖机群运维全生命周期** | 133 个候选按「巡检/告警/部署/日志/凭据」五维打分，无一满分 |
| `@linxin666/dsh-ssh` 是唯一把「一条命令并发打 N 台」做成一等 Agent 工具的 | `ssh_cluster` 按 aliases/environment/tags 选机，默认并发 8，空筛选硬拒（防误打全量） |
| 它是生态最大、最活跃的（10.4k★，今日仍在发版） | npm `0.4.19` 发布于 2026-11-16 |
| 它**不暴露任何 Service**（无 `ctx.provide`），只能 HTTP + tool + slot 三条路对接 | `src/index.ts` 全仓 grep `ctx.provide` 零命中 |
| 安全面有两个真实缺口 | ① 密码明文存 `~/.dsh/dsh-ssh.json`；② **从不设 `hostVerifier`，主机密钥零校验**（`known_hosts` 全仓 0 命中） |

**功能重叠必须砍掉的部分**（否则主机簿和凭据库要维护两份）：

- `dsh-server-deck` 与 `dsh-server-box` 是**同一份代码**（后者是前者改名 fork）→ 只留前者
- `dsh-tty` / `dsh-ssh-tunnel` / `dsh-ssh-manage` 各自维护主机簿 + 凭据库 → 与基座重复，不装
- `dsh-fleet-monitor` 的监控/告警能力**直接吸收进本项目**（见 §3 P1），不并行安装

### 1.2 路线对比

| 路线 | 结论 |
|---|---|
| **组合现有 + 自研补齐** | 最省事，但 `dsh-ssh` 不暴露 Service，跨插件复用只能靠它的 HTTP 路由，耦合脆 |
| **以最强单品为基座，深度二开** ✅ | **选定**。基座已被 1.1 万下载量验证过；缺口（告警/部署/日志/凭据）都在同一进程内补，无跨插件 IPC 损耗 |
| 完全自研单体 | 要重造终端/SFTP/连接池/跳板机/隧道——轮子已很成熟，浪费 |
| 只装现成的 | 五个痛点里三个（部署/日志/凭据安全）完全无解，缺口靠 agent 现场拼命令，不沉淀 |

### 1.3 基座的取舍

继承 `@linxin666/dsh-ssh` 的能力：主机 CRUD + 分组（environment/tags）、`~/.ssh/config` 导入、
持久 ssh2 连接池、多级 ProxyJump + ProxyCommand、agent forwarding、Web 终端（多标签 / 离屏重连回放）、
SFTP、端口转发、并发集群执行、6 个 agent 工具。

**继承但要修的问题**：

| 问题 | 处置 |
|---|---|
| 密码 / 密钥口令明文存储 | P0-b：加密存储，密钥与配置分离 |
| 主机密钥零校验（MITM 面） | P0-a：接入 `~/.ssh/known_hosts` 强制校验 |
| exec / cluster 输出原样回传，`env` 会把远端密钥带进对话 | P1：输出脱敏层 |
| 每日向 dsh-market.com 打匿名心跳 | P0：移除遥测（否则自研项目等于给第三方报信） |
| 无审计 | P0-b：操作审计日志 |

---

## 2. 架构

### 2.1 分层

```
┌─────────────────────────────── 客户端半区 (lib/client.js) ───────────────────────────────┐
│  侧边栏面板行「服务器」                                                                    │
│    ├─ 主机（继承）    ├─ 终端（继承）   ├─ 传输（继承）   ├─ 隧道（继承）                  │
│    ├─ 集群（继承）    ├─ 巡检 ★新增     ├─ 告警 ★新增      ├─ 部署 ★新增                  │
│    └─ 日志 ★新增      ├─ 审计 ★新增                                                      │
│  右侧栏页签：server-deck 式「服务器」页签（原生 slot，非 iframe）                           │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────── 宿主半区 (lib/index.js) ─────────────────────────────────┐
│  通道层（继承，未改语义）: HostStore · SshEngine(连接池) · cluster · pty · sftp · tunnel     │
│  ──────────────────────────────────────────────────────────────────────────────────────  │
│  新增能力层:                                                                              │
│    ├─ security/known-hosts.ts   主机指纹强制校验（ssh2 hostVerifier 注入点）               │
│    ├─ security/secrets.ts       口令加密信封（scrypt + AES-256-GCM）                       │
│    ├─ audit/audit-log.ts        结构化审计（谁、何时、对哪台、做了什么、结果）              │
│    ├─ inspect/inspection.ts     巡检项定义 + 执行 + 结果留存 + 趋势                          │
│    ├─ metrics/collector.ts      指标采集 + 历史落盘 + 阈值判定                              │
│    ├─ alerting/rules.ts         告警规则引擎（连续轮数 / 冷却 / null 冻结）                 │
│    ├─ alerting/notify.ts        HTTP 模板通知（Bark/TG/飞书/企微预设）                      │
│    ├─ deploy/orchestrator.ts    分批发布 + 健康检查 + 失败回滚                               │
│    ├─ deploy/plans.ts           发布计划定义（制品/目标/命令/健康探针）                       │
│    └─ logs/search.ts            跨机日志检索（grep 模式 + 时间窗）                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

**D1｜复用基座引擎，不重造连接层。**
所有新能力（巡检/告警/部署/日志）都走 `engine.exec()` / `engine.cluster()`，
复用连接池、跳板机、认证、超时、输出截断。新代码零 SSH 协议实现。

**D2｜新能力以「基座之上的一等工具」暴露。**
不塞进 `ssh_exec` 的命令字符串里，而是独立工具（`hub_inspect` / `hub_alerts` / `hub_deploy` …），
每个工具有独立 schema 与独立 render，符合 DSH 的 tool-design 规范
（tool-design.md：描述行为而非实现、参数规则写在参数上、有界输出）。

**D3｜巡检 = 「定义好的检查项」而非「现场拼命令」。**
基座的 `ssh_cluster` 每次都要 agent 即兴拼命令，无留存、无历史、无对比。
巡检层把检查项（磁盘/负载/进程/服务/端口/日志关键字）持久化，定时执行、留存结果、
产出「本次 vs 上次」对比——这是「批量巡检」从一次性动作变成可追溯资产的关键。

**D4｜告警判定用「连续轮数 + 冷却 + null 冻结」。**
沿用 `dsh-fleet-monitor` 已验证的语义（实测在 37 台上跑过）：
- 持续时间换算成连续轮数（`180s ÷ 30s = 6`）
- 离线至少 2 轮（1 次是网络抖动，2 次是机器真死）
- 指标读到 `null` **冻结**状态而不是判定恢复——一次 SSH 超时不该关掉未恢复的告警
- 冷却只挡「重新触发」，恢复一定通知

**D5｜凭据用「加密信封」，密钥与配置分离。**
`dsh-ssh.json` 里的口令/密钥口令用 AES-256-GCM，加密密钥由 scrypt(主密码) 派生，每个密文独立 IV。
**主密码唯一来源：环境变量 `DSH_SSH_HUB_SECRET`**（实现取值）。
没有默认值——默认主密码就是后门；未配置时凭据保持明文（这是运维者自己的选择，不是静默降级）。
主密码丢失 = 数据不可解。

> 实现说明：DSH 的 credentials service 是异步的，而插件 `apply` 是同步的，
> 因此挂载时读不到异步凭据；该路径已移除而不是留一个假装能用的分支。
> 交互式设定主密码需要异步入口（见 §3 的 P3），当前版本明确只支持环境变量。
> `encryptCredentials` 与主密码**两者都具备**才会加密：单有开关无密钥无法加密，
> 单有密钥无开关则不擅自改写运维者没选的存储格式。

**D6｜主机指纹走 `~/.ssh/known_hosts`，不自己造。**
基座的 `buildConnectConfig` 没有设 `hostVerifier`——这是真实 MITM 面。
修法：在 `buildConnectConfig` 注入 ssh2 的 `hostVerifier`，
复用 OpenSSH 的 known_hosts 解析（明文 / bracket / 通配 / hashed / revoked 条目、SHA256 指纹）。
未登记的主机按策略处理：`strict` 拒绝 / `tofu` 首次记录并提示 / `off` 保留旧行为（默认，不破坏存量用户）。
密钥变更或吊销在任何策略下都拒绝。

**D7｜部署编排必须有「回滚」这一等公民。**
分批（batch）+ 健康探针 + 失败自动回滚到上一版本。
**关键约束**：回滚只在本插件自己部署过、且记录了上一版本指纹/路径时可用——
没有上一版就不回滚，如实报告「无法回滚」而不是假装成功。

**D8｜输出脱敏是横切关注点。**
基座的 `exec`/`cluster` 输出原样回传，`env`、`cat /etc/shadow` 会把密钥带进对话记录。
在引擎出口加一层可配脱敏器（默认开启，模式：密钥赋值行 / PEM 块 / 指定环境变量名）。

---

## 3. 迭代路线

每一阶段都是**可独立交付并验证**的增量。

### P0 · 安全与可信基线（先做，因为它是「不敢用」的原因）

| 编号 | 能力 | 交付判据 | 状态 |
|---|---|---|---|
| P0-a | known_hosts 主机指纹强制校验 | 改过的主机密钥被拒并给出期望 vs 实际指纹；`tofu` 模式首连落盘；`off` 保持旧行为 | ✅ 22 测试 |
| P0-b | 凭据加密 + 审计日志 | `dsh-ssh.json` 里不再出现明文口令；审计记录含操作/目标/结果/时间戳；密文文件权限 0600 | ✅ 27 测试 |
| P0-c | 移除第三方遥测 | 构建产物里不再出现 dsh-market.com 端点 | ✅ 构建产物 grep 实测 |
| P0-d | 巡检项 + 执行 + 结果留存 + 对比 | 定义检查项 → 运行 → 留存 JSON Lines → 「本次 vs 上次」diff | ✅ 26+7 测试 |

### P1 · 运维语义（真正的「管理」）

| 编号 | 能力 | 交付判据 | 状态 |
|---|---|---|---|
| P1-a | 巡检项 + 执行 + 结果留存 + 对比 | 见 P0-d | ✅ |
| P1-b | 指标采集 + 历史落盘 | CPU/内存/磁盘/负载趋势按主机留 raw(24h)/1m(30d)/15m(90d)/1h(永久) 四级；滚动聚合幂等；盲探针不进均值 | ✅ 19 测试 |
| P1-c | 告警规则引擎 + 通知 | 规则含方向/阈值/持续轮数/冷却/范围；null 冻结；通知预设可发；恢复必通知 | ✅ 18 测试 |
| P1-d | 输出脱敏 | `env` 类命令的密钥不进对话记录 | ✅ 13 测试 |
| P1-e | 定时监控循环 | `timer` 服务驱动；一轮未结束则跳过下一轮；通知渠道抛错不拖垮循环；`hub_monitor` 报告是否在跑 | ✅ 16 测试 |
| P1-f | 面板「机群」页签 | 监控武装状态 / 上一轮超限与盲探针 / 变化集 / 告警状态与事件 / 磁盘趋势迷你图 / 安全态势 | ✅ 构建通过 |

### P2 · 变更与追溯

| 编号 | 能力 | 交付判据 | 状态 |
|---|---|---|---|
| P2-a | 部署编排 | 分批发布 → 健康检查 → 失败自动回滚；无上一版时如实报告不可回滚 | ✅ 15 测试 |
| P2-b | 跨机日志检索 | 按关键字 + 时间窗跨 N 台 grep，结果按主机聚合 | ✅ 20 测试 |

### P3 · 体验与规模化（剩余部分）

- 主机分组视图 / 一键巡检 / 告警到会话（action card 或 followup）
- 交互式设定主密码（当前支持 `DSH_SSH_HUB_SECRET` 与 `DSH_SSH_HUB_SECRET_FILE`，尚无 GUI 录入）
- 部署记录页签、日志检索结果页签（监控/巡检/告警页签已完成）
- >50 台时的分级采集与背压（10–50 台当前规模下优先级低）

> **已完成**：定时监控循环（`cordis-plugin-timer` 驱动）、指标四级分级落盘、
> 面板「机群」页签、主密码文件来源、手动「立即巡检」。

> **当前版本的已知边界**：
> - 监控循环**默认关闭**（`monitorEnabled: false`）。一个插件刚加载就去探测机群的定时器
>   是个惊喜，不是功能；开启是显式决策。未开启时告警列表为空**不代表机群健康** ——
>   面板与 `hub_monitor` 都会把这一点说出来，因为「安静」和「没问题」看起来一样。
> - 监控循环随插件的 `effect` 卸载而停止，DSH 关闭时不采集，不留孤儿定时器。

---

## 4. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **上游持续演进**（基座 0.4.19 今日仍发版） | 二开与上游分叉，长期跟版成本 | 改动集中在新增目录 `src/{security,audit,inspect,metrics,alerting,deploy,logs}/`，基座目录尽量少动；每次跟版只比对基座目录 |
| 主密码丢失 = 凭据不可解 | 用户无法再连服务器 | 安装时强制设定、UI 明示、提供「导出解密凭据」应急通道（需二次确认 + 审计） |
| known_hosts 校验会打断存量用户 | 老用户升级后连不上 | 默认 `off`（保持旧行为），UI 提供一键切 `tofu`/`strict`；存量主机未登记时 `tofu` 也不拦 |
| 巡检/告警的定时器在 DSH 关闭时停止 | 监控断档 | 面板明确显示「采集中/已停止」；DSH 的 `timer` 服务随插件 effect 卸载，不留孤儿定时器 |
| 部署编排的破坏性操作 | 误伤生产 | 破坏性动作走 DSH 审批（`approval` 服务）；分批 + 健康检查 + 可回滚；生产环境标签需显式确认 |
| 采集命令在远端执行 | 远端负载 | 采集器是只读 POSIX sh 探针；快/慢两档（SFTP 走 `node:sqlite` 或 JSON 分级落盘） |
| **一台主机不可达会拖垮整轮巡检** | 机群里有台机器重启/防火墙挡住时，监控循环整体崩掉，且告警列表看起来"正常" | 已修：`Inspector.run` 对每台主机单独 try/catch，失败记为盲结果（`value: null` + `error`），该台不消失、其余照跑。回归测试 3 例锁定 |
| **`ssh2` 是 CJS，打包后命名导入失效** | `new Client()` 抛 `Client is not a constructor`，所有 SSH 功能全废，且只表现为路由 400 无响应体 | 已修：改用 `createRequire(import.meta.url)('ssh2')` 绕过 ESM 互操作；`scripts/verify-ssh2-import.mjs` 独立证明该形式能在真实 node 进程里构造并连接 |

---

## 5. 与基座的差异清单（改动索引）

| 文件 | 改动 | 理由 |
|---|---|---|
| `src/engine/connection-pool.ts` | `buildConnectConfig` 注入 `hostVerifier` | D6：主机指纹校验 |
| `src/engine.ts` | `ResolvedEngineOptions`（回调保持可选） | 类型：与连接池的 Options 对齐 |
| `src/store.ts` | 口令字段改为引用加密信封 | D5：凭据加密 |
| `src/tools.ts` | 现有 6 工具加脱敏出口 + 审计记录 | D8 + P0-b |
| `src/index.ts` | 挂载新增能力层；`mountOnce` 改用本包 identity | 装配 |
| `src/client/telemetry.ts` | **已删除** | P0-c |
| `src/client/index.ts` | 移除心跳调用 | P0-c |
| `src/security/{known-hosts,secrets,redact}.ts` | 全新 | D5 / D6 / D8 |
| `src/audit/{audit-log,recorder}.ts` | 全新 | P0-b |
| `src/inspect/{checks,inspection,tools}.ts` | 全新 | P0-d |
| `src/monitor/{loop,metrics}.ts` | 全新 | P1-e / P1-b |
| `src/monitor/metrics.ts` | `forget(alias)`：删主机时一并清掉它的指标历史 | 历史只按别名索引，留着会串到同名的新主机 |
| `src/client/panel/FleetTab.tsx` | 全新（第 6 个页签） | P1-f |
| `src/client/panel/{SshPanel.tsx,controller.ts,panel.module.css}` | 加 `fleet` 页签、`badge[data-status]` 的 error/warn/pending 三态 | P1-f |
| `src/routes.ts` | 新增 7 条路由（monitor / monitor-tick / inspection / inspection-diff / alerts / metrics / security） | P1-e / P1-f |
| `src/alerting/{rules,notify,tools}.ts` | 全新 | P1-c |
| `src/deploy/{orchestrator,tools}.ts` | 全新 | P2-a |
| `src/logs/{search,tools}.ts` | 全新 | P2-b |
| `cordis.patch.yml` | 新增 | bundle 行（row id `ssh-hub`） |
| `scripts/package-artifact.mjs`、`scripts/tarball-reader.mjs` | 全新 | 打包产物 SHA 校验 |
| `scripts/verify-monitor.mjs`、`scripts/verify-ssh2-import.mjs` | 全新 | 装好后对**运行中的插件**做端到端验收，并独立证明 CJS 导入形式可用 |

> 面板不再"未改动"：新增第 6 个「机群」页签（P1-f），其余五个页签沿用基座。
> 新能力的路由与页签都只在本机回环地址应答，非回环请求返回 403。

---

## 6. 验证方法

| 层级 | 方法 | 实测结果 |
|---|---|---|
| 单元 | vitest：known_hosts 解析、脱敏规则、告警状态机（null 冻结 / 冷却 / 连续轮数）、部署状态机、日志命令构造与解析、指标分级与滚动聚合、监控循环（重叠保护/幂等启停/上界） | ✅ 202 测试 / 13 文件全绿 |
| 类型 | `tsc --noEmit`（strict）+ `tsc -p tsconfig.build.json` | ✅ 通过 |
| 契约 | 每个工具必须有 `output: { schema, render }`（缺失会让 cordis 回滚整个 entry，症状是「路由全 401」） | ✅ 15 个工具全部注册 |
| 打包 | `npm pack` 后解包逐文件比对 SHA-256 | ✅ 61 个文件与磁盘一致 |
| 运行时 | 装进 desktop profile → `cordis_inspect` 查 Tool 清单 | ✅ 15 个工具在册（含 `hub_monitor`）；7 条新路由全部 200；Config 投影全部字段 |
| 真机 SSH | 内嵌 ssh2 Server（真实密钥交换/口令认证/exec）跑 connect/auth/exec/连接池复用/集群顺序/8 项巡检/指纹三策略 | ✅ 11 测试 |
| CJS 导入 | `scripts/verify-ssh2-import.mjs` 在真实 node 进程里构造 Client、连接、执行 | ✅ 通过（vitest 的 CJS 互操作无法证明这一点，所以单独验证） |
| 端到端 | `scripts/verify-monitor.mjs`：起假 SSH server → 经插件自己的 API 注册主机 → 触发一轮 → 回读巡检/指标/告警/安全态势 | ✅ 通过 |
