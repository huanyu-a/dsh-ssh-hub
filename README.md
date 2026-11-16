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

### 本插件新增（8 个工具）

| 工具 | 用途 |
| --- | --- |
| `hub_inspect` | 运行内置巡检项并留存本轮结果 |
| `hub_inspect_catalog` | 列出可用巡检项与阈值 |
| `hub_inspect_diff` | 对比上一轮：值漂移 / 新增超限 / 已恢复 |
| `hub_alerts` | 查看告警状态与最近事件 |
| `hub_alert_rules` | 列出 / 调整告警规则 |
| `hub_alert_test` | 测试通知渠道（区分"规则没触发"与"渠道坏了"） |
| `hub_deploy` | 分批部署 + 健康检查 + 自动回滚 |
| `hub_log_search` | 跨机检索 journald / 日志目录 |

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

---

## 文件布局

```
src/
  index.ts              插件入口：配置、引擎、路由、工具注册、提示词
  engine.ts             SSH 引擎（连接池 / exec / cluster / 隧道 / SFTP）
  store.ts              主机存储（凭据加解密）
  tools.ts              基座 6 个工具（+ 脱敏 + 审计）
  routes.ts             /api/dsh-ssh 路由族
  security/
    known-hosts.ts      known_hosts 解析、指纹、校验策略
    secrets.ts          凭据加密信封
    redact.ts           输出脱敏
  audit/
    audit-log.ts        JSON Lines 审计日志
    recorder.ts         审计记录器
  inspect/
    checks.ts           巡检项定义与判定
    inspection.ts       巡检执行与结果留存
    tools.ts            巡检工具
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
tests/                  148 个测试
```

---

## 测试

```
Test Files  9 passed (9)
     Tests  148 passed (148)
```

---

## 许可证

Apache-2.0。基座 [`@linxin666/dsh-ssh`](https://github.com/zhu1090093659/dsh-web) 同为 Apache-2.0。
