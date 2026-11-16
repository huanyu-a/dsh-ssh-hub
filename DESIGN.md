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

### P3 · 体验与规模化

| 编号 | 能力 | 交付判据 | 状态 |
|---|---|---|---|
| P3-a | 主机分组视图 | 按 environment / tags 分组，`groupHosts` 与页签下拉；空组不渲染 | ✅ 已交付 |
| P3-b | 交互式设定主密码 | 面板「机群 → 主密钥」录入或一键生成；设置后**已存明文凭据当场重新加密**；轮换先验证再提交新密钥、失败回滚旧密钥；有密文时拒绝删密钥 | ✅ 29 测试 + 14 项端到端断言 |
| P3-c | 部署记录页签 | 计划录入（回滚命令必填）→ 分批执行 → 逐台展开；运行记录落 NDJSON，重开面板仍在 | ✅ 已交付 |
| P3-d | 跨机日志检索页签 | 关键字 + journal/files + 时间窗；结果按检索→主机聚合；检索记录落盘 | ✅ 已交付 |
| P3-e | 告警到会话 | 告警摘要进系统提示词：几台在报警、哪条规则、什么值；**循环未启动时明说「这个『无』不代表健康」** | ✅ 11 测试 |
| P3-f | >50 台背压 | 巡检按固定 8 worker 池跨主机并发（原来是串行，50 台 × N 项会跑过自己的监控间隔）；结果按「目标序 → 检查项序」重排，避免完成顺序污染 diff | ✅ 7 测试 |
| P3-g | 面板视觉与版式 | 见下节「界面设计」；主机表 8 列压到 6 列，工具栏四个控件统一 30px 高，破坏性操作与主操作分层 | ✅ 4 项客户端产物断言 |

> **当前版本的已知边界**：
> - 监控循环**默认关闭**（`monitorEnabled: false`）。一个插件刚加载就去探测机群的定时器
>   是个惊喜，不是功能；开启是显式决策。未开启时告警列表为空**不代表机群健康** ——
>   面板、`hub_monitor` 与系统提示词都会把这一点说出来，因为「安静」和「没问题」看起来一样。
> - 监控循环随插件的 `effect` 卸载而停止，DSH 关闭时不采集，不留孤儿定时器。
> - **加密有两条生效路径**：`encryptCredentials` + 环境变量/文件密钥（原有），
>   或面板自己写的密钥文件（面板的录入动作本身就是知情同意）。一个孤儿环境变量
>   不会顺手改写凭据库，因为它仍需显式开关。
> - **protector 按调用实时取密钥**，不在挂载时捕获，且 `rotateSecrets` **不得**给 store 换一个自带密钥的
>   protector。捕获式的写法有两个方向的错：轮换后继续用旧密钥加密（密钥文件已换 → 凭据再也解不开），
>   以及把 `open` 变成恒返回 `undefined`（同进程内读不出已有凭据）。改为「读旧密钥 → 提交新密钥 →
>   一次重封 → 失败回滚旧密钥」后，两个方向都不会发生。`verify-secret-liveness.mjs` 在运行中的
>   插件上验证这三个转换点。
> - **密文但无密钥时必须诚实失败**：`decryptEntry` 会丢弃打不开的信封而不是把它当口令交给 ssh2，
>   连接层则报「no password stored … encrypted and the master key is not available」。
>   原来的表现是 ssh2 的 "All configured authentication methods failed"，让人去查服务器而不是查密钥。

### 3.1 界面设计（P3-g · 第二版「机架仪表台」）

**方向：运维控制台，不是网页。** 使用者是常驻终端的单人运维，面板唯一任务是
「一眼看清这些机器，并对某一台动手」。第一版（下划线页签 + 状态点徽章 + 浅色表面）
功能正确但视觉接近通用后台；第二版把它重做成**机架仪表台**，结构与交互完全不变。

**签名元素：连续主机台账。** 主机表是一条连续台账 —— 行首 3px 状态轨、雕刻感大写列表头、
等宽机器数据、固定操作列；视觉重心在「机器」上，而不是在容器装饰上。

**已被否决的方案：深色「设备机箱」页头。** 曾经把标题区 + 页签条做成固定的石墨色孤岛
（`#1b2530` + `#e6edf3` 前景），想让面板一眼区别于通用后台。实测在宿主页面里它读起来像
**另一个应用被塞进了页面**，与周围明暗主题脱节。因此页头回到主题令牌
（`--ssh-chrome = bg-layer-1` + `border-l1`）。**只有终端保留深色**（`#0b0e14`），因为终端本来就该是深色；
终端内的占位层也随之改成深色半透明，避免浅色皮肤下闪一块白。
`verify-client.mjs` 反向断言禁止 `--ssh-rack-*` / `color-scheme: dark` 回归。

**校准过的文字色（P3-j）。** 放弃机箱孤岛后仍有一批令牌不合 WCAG —— 问题不在骨架，而在
「把为圆点和填充块设计的令牌拿去当文字用」。实测（`scripts/audit-text-contrast.mjs`，双皮肤）：

| 令牌 | 浅色下作为文字 | 结论 |
|---|---|---|
| `state-success` = `rgb(34,197,94)` | 2.28:1 | 约 4.5 门槛的一半 |
| `state-warn` = `rgb(245,158,11)` | 2.15:1 | 同上 |
| `label-tertiary` | 3.71:1 | 不到正文门槛 |
| `state-business` | 4.23:1 | 差一点 |
| 白字压 `button-info-fill` `rgb(65,118,230)` | 4.23:1 | 基座按钮本身差 0.27 |

做法不是逐个调色，而是**在 `.panel` 上建立一组校准后的文字令牌**：把每个色相往
`label-primary` 混合。这一招在两套皮肤同时成立 —— `label-primary` 在浅色下近黑（压暗字形）、
在深色下近白（提亮字形）。混合比例由实测反推，不是估计：

- `--ssh-ink-muted` = `label-tertiary` 50% 混 `label-secondary`（muted 文字、列表头、占位符）。
  **注意锚点是 secondary 而不是 primary**：往 primary 混会让 muted 在浅色下比 secondary 更深、
  在深色下比它更浅，两套皮肤都变得「比次要文字更抢眼」，层级倒置。50% 实测 4.58:1（浅）/ 8.84:1（深），
  既过 4.5 门槛又弱于 secondary 的 5.80 / 10.42。审计额外断言 `muted < secondary < primary`。
- `--ssh-ok-text` / `--ssh-warn-text` / `--ssh-error-text` / `--ssh-info-text`
- `--ssh-fill-primary` / `--ssh-fill-primary-hover` = 官方按钮色压暗 10%（白字从 4.23 → 5.06:1）

同时修掉一个真实缺陷：浅色皮肤下 `bg-base`、`bg-layer-1`、`bg-layer-2` **全部是纯白**，
所以「用 `bg-layer-2` 填充选中页签」等于白上填白，选中态只剩字体粗细。页签填充改为
`label-primary` 的 5% / 10% 混合，在白底和近黑底上都产生可见层次。

**空列自动隐藏（P3-k）。** 渲染出真实界面后才看见：四台主机的 Environment / Tags /
Description 三列**全空**，却占掉约 40% 宽度，把「主机」和「操作」挤到两端。改成
`visibleColumns` 单一来源——某列只要没有任何主机填过值就不渲染，表头与每一行的单元格
都读同一份判断，保证列数永远一致、表格不会错位。分组视图也复用它，各分组列宽统一。

**从「算得出」到「看得见」（P3-k）。** GUI 在鉴权后面，前三轮所有视觉结论都只来自令牌算术。
`scripts/render-preview.mjs` 补上这一环，且不碰任何凭据：它从构建产物里取出**真实编译后 CSS**、
从已安装的 app.asar 取出**真实主题**、从运行中的插件取出**真实主机与隧道数据**，用无头 Chrome
在两套皮肤下渲染并截图到 `artifacts/preview/`。缺任一前提就报 SKIP 退出 2。

它证明的是浏览器**实际计算**出来的结果——`var()` 链已解析、`color-mix` 已求值、皮肤已切换、
列可见性已生效——而不是样式表看上去写了什么。`npm run preview` 单独运行，不进 `check`，
因为 `check` 不该依赖浏览器和运行态。

**这一环抓到的三个「看着对、其实错」：**
1. 表格三列全空仍占 40% 宽度（上面已修）。
2. 我一度根据图像描述断定外部转发竖条「在两套皮肤里变色相」——用 CDP 读 `getComputedStyle`
   和逐像素采样后推翻：两套皮肤都是灰色（浅 `rgb(158,162,166)` / 深 `rgb(135,139,142)`），
   六条完全一致。**截图描述会误读，像素和计算样式不会。**
3. 同样被像素否掉的还有「每台主机都有绿色状态轨」：实测只有测过的 `tencent` 有绿轨，
   其余三行 `border-left` 是全透明 `rgba(0,0,0,0)`——「未检测」与「可达」确实被区分开了。

**纪律：颜色写进样式表前必须先被算过。** 两个审计脚本已进 `npm run check`：
`verify-contrast.mjs` 查我手工指定的关键配对，`audit-text-contrast.mjs` 扫**全部** 70 条含
`color:` 的规则（308 次测量，深浅两套皮肤 × 全部可能落点）。任一低于门槛即非零退出。
它们自己从 `app.asar` 解出官方主题，读不到就报 SKIP 并退出 2 —— 绝不假装验证过。

**改了什么：**

| 面 | 第一版 | 第二版 |
|---|---|---|
| 标题 + 页签 | 下划线页签 | 与面板同底色的页头 + 品牌色下划线选中态 + `label-primary` 混合填充（不做深色孤岛） |
| 主机表 | 圆角卡片、状态点 | 连续台账、3px 状态轨、大写列表头、行高 60px |
| 徽章 | 状态点 + 文字 | 矩形读数（侧条 + 文字）；**认证方式归为中性元数据**，password 不再像警告、agent 不再像健康；`warn/pending/timeout` 仍是琥珀色，不掩盖真实告警 |
| 按钮 | 圆角 7px、品牌实心 | 圆角 5px、32px 统一高 |
| 表单/弹窗/卡片 | 浮起卡片 | 平面分区，以分隔线代替卡片阴影 |
| 字体 | 系统字体 + 等宽数据 | 标题 14px/650、标签 11px 大写 + 字距、机器数据 Cascadia/等宽 12px |
| 动效 | 120ms | 140ms，仅承载反馈；reduced-motion 覆盖 spinner/progress |

**边界与可访问性**：
- 状态轨、固定操作列、60px 行高**只**挂在 `.hostsTable`；其它页签的结果表保持内容驱动行高。
- 发布/日志返回独立 `.panel` 子页，用 `.panelContent > .panel { overflow-y:auto }` 保证长内容可滚，
  主机页固定工具栏 + 内部滚动表的行为不变。
- 全部状态**同时**用文字表达（测试延迟、成功/失败、告警词），不依赖颜色。
- `:focus-visible` 统一焦点环、`prefers-reduced-motion` 关闭过渡/脉冲/spinner/progress。
- 窄屏（≤720px）收紧 padding，操作列 `position:sticky; right:0` 保证主操作始终可达。

**验证**：`verify-client.mjs` 断言页头走主题令牌，并**反向**禁止 `--ssh-rack-*` 与
`color-scheme: dark` 回归；`verify-contrast.mjs` + `audit-text-contrast.mjs` 在两套皮肤下
实测全部文字配对达标（当前 308 次测量全绿）。

### 3.2 与本地 OpenSSH 的一致性（P3-h）

面板的价值取决于「`ssh <alias>` 能做的事这里也能做」。有两类配置曾被静默读错，
表现都是「插件根本读不到我的本地 ssh」：

| 配置写法 | 曾经的错误处理 | 后果 | 现在 |
|---|---|---|---|
| 多个 `IdentityFile` | 解析器「后值覆盖前值」，只留最后一个 | 试错钥匙 → `All configured authentication methods failed`，而 `ssh <alias>` 正常 | `repeated.identityfile` 保留全部候选；`keyPaths` 存全量、`keyPath` 存首个；连接层按 config 顺序逐个试（`authHandler` 传 `PublicKeyAuthMethod[]`） |
| `PreferredAuthentications none` | 无 IdentityFile 无 agent → 判定为 `password` 且密码为空 | 直接拒连（"no password stored"），而该主机本就不需要凭据 | 新增 `SshAuthKind = 'none'`：不预置凭据，用 `authHandler: ['none']` 让 ssh2 发 none 请求 |

**导入不再只增不改。** 旧的「别名已存在就跳过」会把上面两种坏记录永久固化。
现在对已存在主机做**最小修复**：只补缺失的候选密钥、只把「password 且无密码」改成 `none`，
不覆盖用户手改过的其它字段；`ImportResult.updated` 单独计数，UI 文案报「修正 N 台」。

**本地配置可见化。** 新增 `GET /hosts/local-config`：列出 `~/.ssh/config` 里尚未导入的主机
（含通配符等不可导入项及原因），主机页顶部以 info banner 明示「有 N 台尚未导入」，
导入按钮不再是唯一线索。

### 3.3 机器上已在运行的转发（P3-i）

隧道页原先只列**本插件自己创建**的隧道（存在于进程内存）。运维机器上通常还有手工
或别的工具起的 `ssh -N -L …`，它们在面板里完全不存在，于是「明明在转发」和「显示没有隧道」同时成立。

`src/engine/tunnel-discovery.ts` 读取进程表（Windows `Get-CimInstance Win32_Process`，
POSIX `ps -eo pid=,args=`），解析 `-L/-R/-D`（支持粘连写法、`[bind:]port:host:port`、
IPv6 方括号），并对每个本地端口做 TCP 探测。外部条目以 `source:'external'` + `pid` +
`live` 呈现：**可看不可停**（不是本插件的进程），`live:false` 明确写成「端口未监听」而不是隐藏。
进程扫描按 6s 缓存，避免 5s 轮询每次都起进程。面板与 `ssh_tunnel` 工具走同一份结果。

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
| `src/alerting/prompt-summary.ts` | 全新：把告警状态渲染进系统提示词 | P3-e |
| `src/security/master-secret.ts` | 全新：密钥读写/来源判定/明文巡检/轮换 | P3-b |
| `src/activity/history.ts` | 全新：部署与日志检索的 NDJSON 记录（上限 100 条，坏行跳过） | P3-c / P3-d |
| `src/store.ts` | 加 `resealAll`；`decryptEntry` 丢弃打不开的信封 | P3-b：轮换需要「整个文件换密钥」的一次写入；逐条 `update` 用同一个 protector 重封等于什么都没换 |
| `src/engine/connection-pool.ts` | 口令为空/不可解时报明确错误 | 把「密钥缺失」和「认证方式不对」区分开 |
| `src/inspect/inspection.ts` | 串行 → 固定 8 worker 池 + 结果定序 | P3-f |
| `src/deploy/{orchestrator,tools}.ts` | 全新 | P2-a |
| `src/logs/{search,tools}.ts` | 全新 | P2-b |
| `src/client/panel/{DeployTab,LogsTab}.tsx` | 全新（第 7、8 个页签） | P3-c / P3-d |
| `src/client/panel/tabs.ts` | 全新：页签表唯一来源，`satisfies` 保证与 `SshTab` 联合类型穷尽一致 | 防止「组件写了但没人渲染」这类漏接 |
| `src/client/panel/SshPanel.tsx` | 页签渲染改为 `Record<SshTab, () => ReactNode>` | 同上：漏一个页签变成编译错误，而不是一个点开空白的页签 |
| `src/client/panel/FleetTab.tsx` | 加主密钥卡片（录入/生成/轮换/删除 + 明文主机清单） | P3-b |
| `cordis.patch.yml` | 新增 | bundle 行（row id `ssh-hub`） |
| `scripts/package-artifact.mjs`、`scripts/tarball-reader.mjs` | 全新 | 打包产物 SHA 校验 |
| `scripts/verify-monitor.mjs`、`scripts/verify-ssh2-import.mjs` | 全新 | 装好后对**运行中的插件**做端到端验收，并独立证明 CJS 导入形式可用 |
| `scripts/verify-routes.mjs` | 全新：发布 / 日志检索 / 主密钥三条链路的端到端验收，含「加密后凭据不再明文」「轮换后仍可认证」「无回滚命令被拒」 | P2-a / P2-b / P3-b |
| `scripts/audit-store.mjs` | 全新：审计凭据库的密文/明文/孤儿密文分布 | P3-b 数据安全检查 |
| `scripts/verify-client.mjs` | 加「8 个页签标签键都在产物里」的断言；再加 4 组界面契约断言（类名映射+规则、修饰类、焦点环与 reduced-motion、短版文案） | 客户端漏构建；CSS Modules 类名打错不会让构建失败 |
| `src/client/panel/HostsTab.tsx` | 主机行改为「机器身份块」：别名 + `user@host:port` 两行；列从 8 压到 6；标签逐个成 chip；行首按测试结果给 `data-state`；操作区拆成「主按钮 + 弱化链接」 | P3-g |
| `src/client/panel/panel.module.css` | 框架 padding 归位到 `panelContent`；页签改下划线段落；工具栏控件统一 30px；徽章去边框改状态点；新增 `.hostIdentity` / `.hostsTable` / `.tag` / `.connectButton` / `.actionLink`；焦点环 + reduced-motion | P3-g |
| `src/client/locales.ts` | 加三个短版行内文案（`hosts.testOkShort` / `testFailShort` / `testingShort`），长句保留给 tooltip | P3-g |

> 面板不再"未改动"：在原五个页签之后新增「机群 / 发布 / 日志」三个页签（P1-f、P3-c、P3-d）。
> 新能力的路由与页签都只在本机回环地址应答，非回环请求返回 403。

---

## 6. 验证方法

| 层级 | 方法 | 实测结果 |
|---|---|---|
| 单元 | vitest：known_hosts 解析、脱敏规则、告警状态机、部署状态机、日志命令构造与解析、指标分级与滚动聚合、监控循环、主密钥读写/轮换/回滚/明文巡检、活动记录保留与坏行容忍、巡检背压与定序、页签表完整性 | ✅ 270 测试 / 18 文件全绿 |
| 类型 | `tsc --noEmit`（strict）+ `tsc -p tsconfig.build.json` | ✅ 通过 |
| 契约 | 每个工具必须有 `output: { schema, render }`（缺失会让 cordis 回滚整个 entry，症状是「路由全 401」） | ✅ 15 个工具全部注册 |
| 打包 | `npm pack` 后解包逐文件比对 SHA-256，并断言 `exports`/`main`/`types` 声明的每个路径都在 tarball 里 | ✅ 65 个文件与磁盘一致 |
| 运行时 | 装进 desktop profile → `cordis_inspect` 查 Tool 清单与 Slot 树 | ✅ 15 个工具在册；`sidebar.panellist` 有 `ssh` 且 `main` 有同 key 页（两席一致才不空白）；11 条新路由全部 200 |
| 真机 SSH | 内嵌 ssh2 Server（真实密钥交换/口令认证/exec）跑 connect/auth/exec/连接池复用/集群顺序/8 项巡检/指纹三策略 | ✅ 11 测试 |
| CJS 导入 | `scripts/verify-ssh2-import.mjs` 在真实 node 进程里构造 Client、连接、执行 | ✅ 通过（vitest 的 CJS 互操作无法证明这一点，所以单独验证） |
| 端到端（监控） | `scripts/verify-monitor.mjs`：起假 SSH server → 经插件自己的 API 注册主机 → 触发一轮 → 回读巡检/指标/告警/安全态势 | ✅ 通过 |
| 端到端（变更/密钥） | `scripts/verify-routes.mjs`：假 SSH server → 发布两步 + 健康检查 → 读回历史 → 无回滚命令的计划被拒 → 日志检索 + 读回历史 → 设主密码 → **直接读 store 文件确认口令已非明文** → 轮换后重新认证仍成功 → 有密文时删密钥被拒 → 复原安全态势 | ✅ 14 项断言全过 |
| 客户端产物 | `scripts/verify-client.mjs`：在 `node:vm` 里用桩页面加载真实 `lib/client.js`，断言注册 id、`inject` 只用运行时确实提供的服务、两个 Slot 都注册、两席 id 一致、8 个页签标签键、10 个界面类名既被映射又有规则、主机表带修饰类、焦点环与 reduced-motion 仍在、短版行内文案键在产物里、`apply` 的 effect 可干净释放 | ✅ 11 项断言 |
| 界面版式 | 用真实源样式（非产物）搭明/暗两套静态预览，逐项核对计算样式：控件高度与顶边、状态轨颜色、徽章边框、单元格对齐、窄面板下主操作可达性、纯 `.table` 不继承主机表专属规则 | ✅ 四控件同为 30px/顶边 105；轨色 ok/fail/testing/none 正确；760px 下别名与「连接」同时可见 |
| 数据安全 | `scripts/audit-store.mjs`：列出每台主机的凭据形态（明文/密文/缺失），密文但无密钥时以非零退出码报「孤儿密文」；`scripts/verify-secret-liveness.mjs`：在运行中的插件上验证「无密钥→明文 / 有密钥→密文 / 密钥消失→回到明文」三个转换点 | ✅ 无孤儿密文；三个转换点全部符合预期 |
