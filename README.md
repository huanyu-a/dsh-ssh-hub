# dsh-ssh-hub

面向 **DSH（DeepSeek Harness）** 的服务器车队运维插件。

以 [`@linxin666/dsh-ssh`](https://www.npmjs.com/package/@linxin666/dsh-ssh) 为基座（Apache-2.0，10.4k★），在其之上补齐了运维场景中真正缺失的四块能力：**巡检、告警、部署发布、跨机日志**，同时收紧了安全面。

适用于 **10–50 台纯 Linux 云服务器** 的 agentless 运维：远端不安装任何 agent，全部能力通过 SSH 实现。

---

## 能力

### 继承自基座（6 个工具）

| 工具 | 用途 |
| --- | --- |
| `ssh_list` | 列出主机（按环境 / 标签分组） |
| `ssh_exec` | 在单台远程主机执行命令 |
| `ssh_upload` / `ssh_download` | 与远程主机互传文件 |
| `ssh_tunnel` | 本地端口转发（访问远程内网服务） |
| `ssh_cluster` | 按 aliases / environment / tags 集群并发执行 |

基座还提供：持久连接池（空闲 30 分钟断开）、`~/.ssh/config` 导入、ProxyJump / ProxyCommand 跳板、PTY Web 终端（多标签 / 分离重连 / 2FA）、SFTP。

### 本插件新增（9 个工具）

| 工具 | 用途 |
| --- | --- |
| `hub_inspect` | 运行内置巡检项并留存本轮结果 |
| `hub_inspect_catalog` | 列出可用巡检项与阈值 |
| `hub_inspect_diff` | 对比上一轮：值漂移 / 新增超限 / 已恢复 |
| `hub_monitor` | 报告定时监控是否在跑、间隔、覆盖台数、上一轮与下一轮时间 |
| `hub_alerts` | 查看告警状态与最近事件 |
| `hub_alert_rules` | 列出 / 调整告警规则 |
| `hub_alert_test` | 测试通知渠道（区分"规则没触发"与"渠道坏了"） |
| `hub_deploy` | 分批部署 + 健康检查 + 自动回滚 |
| `hub_log_search` | 跨机检索 journald / 日志目录 |

> `hub_monitor` 存在的原因：监控**未启动**和机群**全部健康**都会表现为"告警列表为空"，
> 而这两件事的含义相反。问一句"有没有东西在看"要先于"有没有问题"。

### 内置巡检项

全部为只读 POSIX 命令，**不在远端安装任何东西**：

| id | 检查 | 触发条件 |
| --- | --- | --- |
| `disk-usage` | 磁盘使用率 | > 85% |
| `disk-inodes` | inode 使用率 | > 85% |
| `memory-used` | 内存使用率 | > 90% |
| `load-average` | 5 分钟负载 | > 4 |
| `uptime` | 运行时长 | < 1 小时（疑似重启循环） |
| `sshd-running` | sshd 运行中 | 停止 |
| `failed-units` | 失败的 systemd 单元 | > 0 |
| `kernel` | 内核版本 | 仅记录 |

---

## 三个关键设计决策

### 1. 告警的 `null` 冻结语义

探针读不到值（SSH 超时、命令失败）时，告警状态被**冻结**——既不算恢复，也不推进计数。

一个瞎掉的探针如果上报"已恢复"，机器宕机会被显示成健康。所以状态冻结时保持原状，恢复通知在黑屏后依然照常发出。

### 2. 冷却只挡重复触发，不挡恢复

告警在冷却期内持续越界时不再重复通知；但**恢复通知永远发送**。运维人员被告知"磁盘满了"却从未被告知"磁盘好了"，页面会一直开着。

### 3. 回滚是一等公民

`hub_deploy` 的每个步骤都可以带 `rollbackCommand`：

- 健康检查失败 → 整批回滚（不是逐台，因为"一半回滚一半没回滚"是最糟的状态）
- 缺少回滚命令 → **如实报告"无法回滚"**，不假装这批没问题
- 部分步骤缺回滚命令 → 拒绝执行部分回滚（半应用状态比不应用更危险）
- 回滚命令按**逆序**执行

被前序失败批次跳过的主机，会明确列为"未部署"，不会被算作已部署。

### 4. 改隧道分两种，因为它们是两件事

面板里每条隧道都能编辑，但两种隧道的编辑是不同的动作：

- **本插件建立的隧道**：可以改名、写备注，也可以改远程主机 / 远程端口 / 本地端口。
  前两者**原地生效**（不会打断已有连接）；后者做不到原地修改——监听器是绑死在旧目标上的，
  所以走「停止 → 按新参数重建」，并在结果里明确回一句「已重建」。
  重建失败时旧隧道已经关闭，报错会直说这一点，而不是抛一个看起来像「连不上」的裸错误。
- **别的进程建立的隧道**：转发参数改不了（`ssh -N -L …` 的命令行在那个进程的整个生命周期里是固定的），
  所以只开放名称与备注。它们按**本地端口**落盘（隧道 id 里带 pid，进程一重启就失效），
  进程重启后备注依然在。两个字段都留空保存 = 删除备注，重新回落到 `~/.ssh/forwards.conf` —
  这个插件从不改写那份配置文件。

面板会给手写的名称打一个「自定义」标记，免得把别人猜出来的名字当成自己起的。

---

## 安全

| 项 | 行为 |
| --- | --- |
| 凭据加密 | 配置 `DSH_SSH_HUB_SECRET` 且 `encryptCredentials=true` 时，凭据以 scrypt + AES-GCM 信封加密落盘。**没有默认密钥**——默认密钥等于后门。旧版明文库可正常加载，并在下次更新时自动重新加密 |
| 主机指纹 | `hostKeyPolicy` = `off` / `tofu` / `strict`，对照 `~/.ssh/known_hosts` 校验。密钥变更或吊销在任何策略下都被拒绝 |
| 输出脱敏 | 命令输出返回前脱敏（密码赋值、私钥块、Bearer token、AWS key、JWT、连接串）。**这是安全网不是保证**——远端可能有本模块不认识的秘密形态 |
| 审计日志 | `$DSH_HOME/dsh-ssh-hub/audit.log`（JSON Lines，0600）。exec / cluster / upload / download / tunnel / deploy 全部记录，actor 区分 user / agent |
| 遥测 | **已移除**。基座每个浏览器每天向 `dsh-market.com` 发一次匿名心跳；一个掌握凭据和服务器清单的工具不该向第三方报告自己的存在 |

---

## 安装

```bash
npm install dsh-ssh-hub
dsh plugin --profile desktop add dsh-ssh-hub
```

本项目为独立开发（非 monorepo），自建构建链：

```bash
npm install --ignore-scripts   # 沙箱下会阻止子进程 spawn，必须加 --ignore-scripts
npm run check                  # typecheck + test + build + pack 校验
```

`npm run build` **不等于**可安装件：安装器复制的是 tgz。`npm run pack:check` 会解包 tgz 并逐文件比对 SHA-256，产物与磁盘不一致即失败。

---

## 发布

**版本号不手写。** 它由 Conventional Commits 推导，由 CI 生成、CI 发布。

流程只有四步，人只参与其中一步：

```
push 到 master
   │
   ├─ release-please 读上一条 tag 以来的提交
   │     feat:  → minor    fix: → patch    feat!: / BREAKING CHANGE → major
   │     维护一个「chore: release X.Y.Z」PR（每次 push 自动更新内容）
   │
   ├─ 你合并那个 PR          ← 唯一的人工决定
   │
   ├─ 同一次运行里：打 tag、建 Release、写 CHANGELOG.md
   │
   └─ 同一次运行里：npm ci → typecheck/test/build/verify/pack → npm publish
```

> **CI 里的门禁少一项**：`verify:contrast` 要读**已安装的** DSH 主题样式表，裸 runner 没有；
> 脚本自己也拒绝在没有测量时说"通过"。所以它留作本地门禁，CI 跑其余全部项目。
>
> **暂时没有 `--provenance`**：npm 的 sigstore 证明要求源仓库是公开的，私有仓库会被
> `E422` 拒绝。可信发布本身不依赖它（OIDC 身份校验照做）。仓库转公开时把那个标志加回去即可，
> 其余不用改。
>
> **失败后重发靠 `workflow_dispatch`**：发版失败时 tag 已经打好了，重跑 push 任务只会
> 再次检出同一个提交。`gh workflow run release.yml -f tag=v0.2.1` 会把那个 tag 拿来发布——
> 必须走同一个 workflow 文件，因为 npm 的可信发布配置是按**文件名** `release.yml` 绑定的。

为什么发布和 release 在**同一个 workflow** 里：release-please 用工作流自己的
`GITHUB_TOKEN` 建 Release，而 `GITHUB_TOKEN` 触发的事件**不会再启动别的 workflow**。
拆成两个文件、用 `on: release: published` 触发发布，看上去完全正确，实际上永远不会跑。

为什么保留「合并 PR」这一步：npm 的版本是**不可变的**，发出去就不能覆盖。
合并按钮是错误还来得及挽回的最后一个时刻，把它去掉换来的是「自动发错版本」。

为什么用 OIDC 而不是 token：`id-token: write` 让 registry 直接校验这次运行的
GitHub 身份（trusted publishing），仓库里不存在任何长期有效的 npm 凭据。
一次 token 过期就让本地发布 401 的坑，在 CI 里不应该重演。

> 首次启用需要在 npmjs.com 的包设置里添加 Trusted Publisher：
> Publisher 选 GitHub Actions，Organization/User `huanyu-a`，Repository `dsh-ssh-hub`，
> Workflow 文件名 `release.yml`。不想配这个就把 npm token 存成仓库 secret `NPM_TOKEN`，
> 并把 `release.yml` 里 `npm publish` 那一步的 `env` 注释打开。

本地依然可以手动发（比如修 CI 的时候），但那样 `package.json` 的版本会被
release-please 的 manifest 覆盖回来——它才是版本号的唯一来源。

> **一处必须存在的 `overrides`**：依赖树里的 `@earendil-works/pi-ai` 把
> `partial-json` 钉在一个**从未发布过**的 `0.1.8`（registry 上最高只有 `0.1.7`），
> 于是干净检出跑 `npm ci` 会以 `E404` 失败。`package.json` 里的 `overrides` 把它落到
> `0.1.7`，只为让 CI 装得起来——它不改变运行时，本插件也不引用这两个包。

---

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `announceToAgent` | `false` | 是否向模型播报本插件存在 |
| `connectTimeoutMs` | `30000` | 连接与认证超时（1–600000） |
| `hostKeyPolicy` | `off` | `off` / `tofu` / `strict` |
| `knownHostsPath` | `""` | 空 = `~/.ssh/known_hosts` |
| `encryptCredentials` | `false` | 是否加密凭据落盘 |
| `auditEnabled` | `true` | 是否写审计日志 |
| `monitorEnabled` | `false` | 是否启动定时监控循环 |
| `monitorIntervalMs` | `60000` | 监控间隔（10000–3600000） |
| `monitorChecks` | `""` | 逗号分隔的巡检项；空 = 全部 |

> **`monitorEnabled` 默认关闭**。一个插件刚加载就自主探测你所有服务器的定时器是个惊喜，
> 不是功能。开启是显式决策。未开启时面板与 `hub_monitor` 都会明说"没有东西在检查"，
> 以免"安静的告警列表"被误读成"机群健康"。

主密钥来自 `DSH_SSH_HUB_SECRET`（环境变量）或 `DSH_SSH_HUB_SECRET_FILE`（文件路径，
读取后去掉一个结尾换行）。**没有默认值**——一个内置的默认主密钥等于没有加密。
加密需要 `encryptCredentials` 与主密钥**同时**具备：只给密钥不改开关，不会悄悄改写
一个操作者没选择加密的存储；只改开关不给密钥，就不能加密。

---

## 监控与面板

定时循环由 DSH 的 `timer` 服务驱动（`inject` 里是**硬依赖**：若允许 `setInterval` 兜底，
插件卸载后探针定时器会泄漏）。

一轮的行为边界：

- 上一轮未结束 → 下一轮跳过，并记录跳过原因（不是静默丢弃）
- 没有需要巡检的主机 → 跳过，原因如实记录
- 某台主机连不上 → 该台记为**盲探针**（`value: null` + `error`），其余照跑；
  一台机器重启不会让整个机群失去监控
- 通知渠道抛错 → 吞掉，循环存活（通知失败不该等于监控停摆）

指标分级落盘：`raw`(24h) → `1m`(30d) → `15m`(90d) → `1h`(永久)。滚动聚合按
`metric|at` 键合并，重复聚合不会产生重复桶；盲探针不进均值，只有盲探针的桶
`value: null` 但样本数照记。删主机时它的指标历史一并清掉——历史只按别名索引，
留着会让后来同名的主机继承别人的数字，而那些数字看起来是真的。

面板新增第 6 个页签「机群」：监控武装状态 → 上一轮超限/盲探针 → 与上一轮的变化集 →
告警状态与事件 → 磁盘趋势迷你图 → 安全态势。页签里**没有**启停监控的按钮：
那是带审计痕迹的配置决策，不该由一个面板按钮代劳。唯一的动作是「立即巡检」，
它走的路径和定时器完全相同。

7 条新路由（均只应答本机回环，非回环 403）：

```
GET  /api/dsh-ssh/monitor            监控状态
POST /api/dsh-ssh/monitor/tick       手动触发一轮（与定时器同一条路径）
GET  /api/dsh-ssh/inspection         最近轮次（limit 1–50，最新在前）
GET  /api/dsh-ssh/inspection/diff    与上一轮的变化
GET  /api/dsh-ssh/alerts             告警状态与最近 50 条事件
GET  /api/dsh-ssh/metrics            某主机的指标序列（需 alias，tier 校验，limit 1–2000）
GET  /api/dsh-ssh/security           加密/指纹策略/审计的当前态势
```

---

## 文件布局

```
src/
  index.ts              插件入口：配置、引擎、路由、工具注册、提示词
  engine.ts             SSH 引擎（连接池 / exec / cluster / 隧道 / SFTP）
  store.ts              主机存储（凭据加解密）
  tools.ts              基座 6 个工具（+ 脱敏 + 审计）
  routes.ts             /api/dsh-ssh 路由族（含监控 7 条）
  security/
    known-hosts.ts      known_hosts 解析、指纹、校验策略
    secrets.ts          凭据加密信封
    redact.ts           输出脱敏
  audit/
    audit-log.ts        JSON Lines 审计日志
    recorder.ts         审计记录器
  inspect/
    checks.ts           巡检项定义与判定
    inspection.ts       巡检执行与结果留存（单台失败不拖垮整轮）
    tools.ts            巡检工具
  monitor/
    loop.ts             定时监控循环（重叠保护 / 幂等启停 / 有界事件流）
    metrics.ts          raw/1m/15m/1h 四级指标落盘与滚动聚合
  alerting/
    rules.ts            告警状态机
    notify.ts           模板化通知（Bark / Telegram / 飞书 / 企微）
    tools.ts            告警工具
  deploy/
    orchestrator.ts     部署编排（分批 / 健康检查 / 回滚）
    tools.ts            部署工具
  logs/
    search.ts           跨机日志检索
    tools.ts            日志工具
  client/panel/
    HostsTab.tsx        主机管理与 SSH 配置导入
    TerminalTab.tsx     Web 终端
    TransferTab.tsx     SFTP 文件传输
    TunnelsTab.tsx      隧道管理（外部隧道探测与 forwards.conf 映射）
    TunnelEditDialog.tsx 隧道编辑（改名 / 备注 / 重定向）
    ClusterTab.tsx      集群并发执行
    DeployTab.tsx       分批部署与回滚
    LogsTab.tsx         跨机日志检索
    FleetTab.tsx        机群状态与巡检监控
scripts/
  verify-monitor.mjs    装好后对运行中的插件做端到端验收
  verify-ssh2-import.mjs 独立证明 ssh2 的 CJS 导入形式在真实 node 里可用
  verify-contrast.mjs   双皮肤色彩对比度合规性检测
  render-preview.mjs    全视图端到端预览渲染与无盲区截图
tests/                  332 个测试（22 个套件）
```

---

## 测试

```
Test Files  22 passed (22)
     Tests  332 passed (332)
```

其中 `tests/ssh-e2e.test.ts` 会起一个**真实的 ssh2 服务端**（自签 RSA 主机密钥、
口令认证、exec 通道），验证连接/认证/执行/连接池复用/集群顺序/完整一轮巡检/
主机指纹三策略。它不是 mock 掉传输层，而是真的过一遍 SSH 握手——
"命令字符串拼对了"和"远程真的收到这条命令"是两件事。

两个脚本是可执行的验收门，不是文档示例：

```
node scripts/verify-ssh2-import.mjs   # 证明 CJS 导入形式在真实 node 进程里能构造并连接
node scripts/verify-monitor.mjs       # 对运行中的插件跑完整监控链路（需 DSH 在跑）
```

`verify-ssh2-import.mjs` 有必要单独存在：vitest 走 Vite 的 CJS 互操作，
所以测试全绿**不能**证明 esbuild 的 ESM 产物里能拿到 `ssh2.Client`。
这个区别是实测踩出来的（见 DESIGN.md 风险表）。

---

## 许可证

Apache-2.0。基座 [`@linxin666/dsh-ssh`](https://github.com/zhu1090093659/dsh-web) 同为 Apache-2.0。
