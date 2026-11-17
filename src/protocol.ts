/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/**
 * Authentication flavors a host entry may carry.
 *
 * `none` is a real OpenSSH method (`PreferredAuthentications none`): some
 * sandboxes authenticate by username alone and reject any credential. Refusing
 * to connect without a stored secret would make such a host permanently
 * unreachable even though plain `ssh <alias>` works.
 */
export type SshAuthKind = 'key' | 'password' | 'agent' | 'none'

/** One stored host entry (the $DSH_HOME/dsh-ssh.json store shape). */
export interface SshHostEntry {
  /** Stable, user-chosen identifier used by every operation. */
  alias: string
  /** Hostname or IP of the target. */
  host: string
  /** SSH port (default 22). */
  port: number
  /** Login user. */
  user: string
  /** Authentication. */
  auth: {
    kind: SshAuthKind
    /** Absolute path to the private key for 'key' auth. */
    keyPath?: string
    /**
     * Every candidate key, in ssh_config order. OpenSSH tries each
     * `IdentityFile` until one authenticates, so a host configured with two
     * keys must not be reduced to the last one — that turns a working
     * `ssh <alias>` into "All configured authentication methods failed".
     * `keyPath` stays the primary (first) candidate for older readers.
     */
    keyPaths?: string[]
    /** Passphrase for an encrypted key. */
    passphrase?: string
    /** Password for 'password' auth. */
    password?: string
    /**
     * ssh-agent endpoint for 'agent' auth. A socket path, the special value
     * 'pageant' (PuTTY Pageant on Windows), or undefined for auto-detect
     * (SSH_AUTH_SOCK, then the native OpenSSH named pipe on Windows).
     */
    agentPath?: string
  }
  /** Jump chain: local aliases connected through in order (ProxyJump). */
  proxyJump: string[]
  /**
   * OpenSSH-compatible ProxyCommand: a shell command whose stdio becomes the
   * connection transport. Tokens %h (host) / %p (port) / %r (user) / %n (alias)
   * expand before exec and %% is a literal percent; an empty value or 'none'
   * means "no proxy command". Mutually exclusive with a non-empty proxyJump.
   */
  proxyCommand?: string
  /** Free-form note. */
  description?: string
  /** Deployment environment label (development / production / ...). */
  environment?: string
  /** Free-form tags. */
  tags: string[]
  /** Physical location note. */
  location?: string
  /**
   * Opt-in ssh-agent forwarding (OpenSSH ForwardAgent / ssh -A): the host's
   * sessions request agent forwarding so the remote can sign with this
   * machine's agent. Default off; stored only when enabled.
   */
  forwardAgent?: boolean
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface SshHostSummary {
  alias: string
  host: string
  port: number
  user: string
  auth: SshAuthKind
  /** Whether the key path exists on the host machine (key auth only). */
  keyReady: boolean
  proxyJump: string[]
  /** Configured ProxyCommand, echoed to the browser so the form can edit it. */
  proxyCommand?: string
  description?: string
  environment?: string
  tags: string[]
  location?: string
  /**
   * Whether agent forwarding is enabled. Always projected as a definite
   * boolean: the browser and the tool bridge need a value even for entries
   * stored before the feature existed.
   */
  forwardAgent: boolean
  createdAt: number
  updatedAt: number
}

/** Result of one non-interactive command execution. */
export interface ExecResult {
  success: boolean
  /** Remote exit code, or null when the channel died without one. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Wall-clock duration of the round trip in ms. */
  durationMs: number
  /** Connection error message when the command never ran. */
  error?: string
}

/** One server entry in a cluster run. */
export interface ClusterResult {
  alias: string
  ok: boolean
  exitCode?: number | null
  timedOut?: boolean
  stdout?: string
  stderr?: string
  durationMs?: number
  error?: string
}

/** SFTP transfer progress frame (upload stream). */
export interface TransferProgress {
  phase: 'connecting' | 'transferring' | 'done' | 'error'
  file: string
  transferred: number
  total: number
  percent: number
  speedBps?: number
  error?: string
}

/**
 * One active local port-forward.
 *
 * `source` distinguishes a forward this plugin owns from one that already
 * exists on the machine (`ssh -N -L …` started by hand or by another tool).
 * Listing only our own forwards made a running tunnel look absent; the
 * external row is read-only because the process is not ours to kill.
 */
export interface TunnelInfo {
  id: string
  alias: string
  localPort: number
  remoteHost: string
  remotePort: number
  state: 'forwarding' | 'connecting' | 'failed'
  error?: string
  startedAt: number
  /** Who owns the listener. Absent means 'plugin' (older shape). */
  source?: 'plugin' | 'external'
  /** Owning OS process for an external forward. */
  pid?: number
  /** True when the local port actually accepts connections right now. */
  live?: boolean
  /** The ssh option that created it ('-L', '-R' or '-D'), external forwards only. */
  kind?: 'local' | 'remote' | 'dynamic'
  /** Project or service name (e.g. from forwards.conf or user remark). */
  name?: string
  /** Remarks / note about what project or service this tunnel serves. */
  description?: string
  /**
   * True when the displayed name came from `~/.ssh/forwards.conf` rather than
   * from the tunnel record itself. The editor needs the difference: saving an
   * untouched inherited name back as an explicit one would freeze a field the
   * config file still owns.
   */
  nameInherited?: boolean
  /** Same as {@link nameInherited}, for the description. */
  descriptionInherited?: boolean
  /**
   * True when the name/description came from a stored user remark rather than
   * `~/.ssh/forwards.conf`. The panel marks these so a stale automatic name is
   * not mistaken for one the operator typed.
   */
  customRemark?: boolean
}

/**
 * One ssh_config host that the store does not contain yet.
 *
 * The panel shows these so "import" is a decision about visible hosts rather
 * than a button whose only feedback is a count.
 */
export interface LocalConfigHost {
  alias: string
  host: string
  port: number
  user: string
  /** What the store would use if this host were imported. */
  auth: SshAuthKind
  /** True when the block cannot be imported as-is (wildcard / Match). */
  skippedReason?: ImportSkipReason
  /** Host description (e.g. from comments preceding the Host block). */
  description?: string
}

/** One directory listing entry (remote file browser). */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  mode?: number
}

/** Test-connection outcome. */
export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** Host edit payload (create/update); 'alias' comes from the URL for updates. */
export interface HostPayload {
  alias?: string
  host: string
  port?: number
  user: string
  /**
   * Authentication. Required on create; on update an omitted auth keeps the
   * stored secrets (the browser never receives them back).
   */
  auth?: SshHostEntry['auth']
  proxyJump?: string[]
  /**
   * ProxyCommand to store. An empty string or 'none' clears a stored value;
   * omitting the key leaves it untouched (PATCH semantics).
   */
  proxyCommand?: string
  description?: string
  environment?: string
  tags?: string[]
  location?: string
  /**
   * Agent forwarding for this host. Omitted on update keeps the stored value;
   * false clears it (PATCH semantics).
   */
  forwardAgent?: boolean
}

/** Why one ssh_config Host block was not imported. */
export type ImportSkipReason = 'wildcard' | 'existing' | 'match' | 'invalid'

/** One skipped ssh_config block and the reason it could not be imported. */
export interface ImportSkipBlock {
  /** Host pattern (or '`Match …`' label) that was skipped. */
  name: string
  reason: ImportSkipReason
}

/** Import outcome from ~/.ssh/config. */
export interface ImportResult {
  parsed: number
  added: number
  /**
   * Existing hosts whose stored shape was corrected from the config — a host
   * that gained a second candidate key, or one switched to `none` auth. An
   * "add-only" import cannot repair those, and reporting them as merely
   * "existing" is what makes a broken host look already imported.
   */
  updated: number
  skipped: number
  /** Every skipped block with its reason, in scan order and deduplicated by name. */
  skippedBlocks: ImportSkipBlock[]
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}

/** WebSocket terminal protocol frames (host -> client and client -> host). */
export type TerminalServerFrame =
  /** The shell is up; `sessionId` reattaches to it after a view detach. */
  | { type: 'ready'; alias: string; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null; error?: string }
  | {
      type: 'auth_prompt'
      name: string
      instructions: string
      prompts: Array<{ prompt: string; echo: boolean }>
    }

export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'auth_response'; responses: string[] }
  /** Leave the socket while the host keeps the shell alive for a reattach. */
  | { type: 'detach' }
  /** End the session outright (the view's disconnect control). */
  | { type: 'close' }

// ---------------------------------------------------------- monitoring faces
//
// These mirror the shapes the monitoring routes return. They are declared
// here rather than in the client so the host's route handlers and the
// panel's readers agree on one definition — a display change that renames a
// field would otherwise silently blank a column instead of failing the build.

/** One check result as the panel reads it. */
export interface CheckResultRow {
  checkId: string
  alias: string
  value: number | boolean | string | null
  breached: boolean
  raw: string
  error?: string
}

/** One retained inspection round. */
export interface InspectionRound {
  startedAt: number
  durationMs: number
  targets: string[]
  results: CheckResultRow[]
}

/** One host's change between the two most recent rounds. */
export interface HostChange {
  alias: string
  checkId: string
  title: string
  before?: string
  after: string
  stateChange?: 'new-breach' | 'recovered'
}

/** The monitoring loop's health. */
export interface MonitorStatus {
  enabled: boolean
  running: boolean
  intervalMs?: number
  hosts?: number
  lastRoundAt?: number
  nextTickAt?: number
  lastTick?: MonitorTickResult
  reason?: string
}

/** One round's outcome as the loop recorded it. */
export interface MonitorTickResult {
  at: number
  ran: boolean
  hosts: number
  breaches: number
  blind: number
  skippedBecause?: string
}

/** One alert state row. */
export interface AlertStateRow {
  ruleId: string
  alias: string
  state: 'ok' | 'pending' | 'firing' | 'frozen'
  consecutiveBreaches?: number
  lastValue?: string
  lastFiredAt?: number
}

/** One alert event. */
export interface AlertEventRow {
  ruleId: string
  alias: string
  kind: 'trigger' | 'recover'
  value: string
  at: number
}

/** One aggregated metric bucket. */
export interface MetricBucketRow {
  at: number
  metric: string
  value: number | null
  samples: number
}

/** The live security posture. */
export interface SecurityStatus {
  encryptConfigured: boolean
  secret: { available: boolean; source: 'env' | 'file' | 'none' }
  hostKeyPolicy?: string
  auditEnabled?: boolean
  /** Entries whose stored credentials are still readable without the key. */
  plaintextAliases?: string[]
  /** The key file the panel manages (shown so the operator can back it up). */
  keyPath?: string
}

/** One deployment step as the panel submits it. */
export interface DeployStepPayload {
  name: string
  command: string
  /** Undo command. Required: a step without one cannot be rolled back. */
  rollbackCommand: string
}

/** A deployment plan as the panel submits it. */
export interface DeployPlanPayload {
  id: string
  description?: string
  steps: DeployStepPayload[]
  batchSize?: number
  timeoutMs?: number
  stopOnFailure?: boolean
  healthCheck?: { command: string; expectExitCode?: number; settleMs?: number }
}

/** A log-search request as the panel submits it. */
export interface LogSearchPayload {
  pattern: string
  source?: 'journal' | 'files'
  directory?: string
  unit?: string
  sinceSeconds?: number
  maxLinesPerHost?: number
}

/** One host's outcome inside a recorded deployment. */
export interface DeployHostRow {
  alias: string
  ok: boolean
  /** Names of the steps that ran, in order (the orchestrator does not report them). */
  steps: string[]
  /** Health-check verdict, when the plan declared one. */
  healthy?: boolean
  /** Whether a rollback was attempted for this host. */
  rolledBack?: boolean
  /** The exit code of the last step. */
  exitCode?: number | null
  error?: string
}

/** One recorded deployment run, as the deploy tab reads it. */
export interface DeployRunRow {
  id: string
  planId: string
  at: number
  finishedAt?: number
  /** The plan's batch size, so the UI can group hosts the way they ran. */
  batchSize: number
  hostCount: number
  ok: boolean
  hosts: DeployHostRow[]
}

/** One host's slice of a cross-host log search. */
export interface LogHostRow {
  alias: string
  ok: boolean
  lines: string[]
  total: number
  truncated: boolean
  error?: string
  durationMs?: number
}

/** One cross-host log search result, as the logs tab reads it. */
export interface LogSearchRow {
  at: number
  pattern: string
  source: string
  /** 'all' or the selected aliases. */
  targets: string[]
  hosts: LogHostRow[]
}

/** Set or clear the master secret from the panel (interactive setup). */
export interface MasterSecretPayload {
  /** New master secret. An empty string clears nothing; use action 'clear'. */
  secret?: string
  /** 'set' stores/rotates the secret, 'clear' removes it. */
  action: 'set' | 'clear'
  /** For 'clear': re-encrypt existing plaintext first (refused when false). */
  confirmPlaintext?: boolean
}

/** Outcome of a master-secret change. */
export interface MasterSecretResult {
  ok: boolean
  /** Where the secret now comes from. */
  source: 'env' | 'file' | 'none'
  /** Entries re-encrypted by this call. */
  rotated: number
  /** Set when the change was refused or failed. */
  error?: string
}

/** Route paths the client calls (shared literals). */
export const SSH_API_BASE = '/api/dsh-ssh' as const

export const SSH_API = {
  hosts: SSH_API_BASE + '/hosts',
  importSshConfig: SSH_API_BASE + '/hosts/import-ssh-config',
  /** ssh_config hosts the store does not contain yet (read-only preview). */
  localConfig: SSH_API_BASE + '/hosts/local-config',
  test: SSH_API_BASE + '/test',
  exec: SSH_API_BASE + '/exec',
  cluster: SSH_API_BASE + '/cluster',
  upload: SSH_API_BASE + '/upload',
  download: SSH_API_BASE + '/download',
  ls: SSH_API_BASE + '/ls',
  tunnel: SSH_API_BASE + '/tunnel',
  terminal: SSH_API_BASE + '/terminal',
  /** The monitoring loop's health readout. */
  monitor: SSH_API_BASE + '/monitor',
  /** Manual round trigger, the same path the timer takes. */
  monitorTick: SSH_API_BASE + '/monitor/tick',
  /** Retained inspection rounds. */
  inspection: SSH_API_BASE + '/inspection',
  /** The change set between the two most recent rounds. */
  inspectionDiff: SSH_API_BASE + '/inspection/diff',
  /** Alert states and the recent event feed. */
  alerts: SSH_API_BASE + '/alerts',
  /** Metric series for one host and tier. */
  metrics: SSH_API_BASE + '/metrics',
  /** The live security posture. */
  security: SSH_API_BASE + '/security',
  /** Recorded deployment runs, newest first. */
  deployHistory: SSH_API_BASE + '/deploy/history',
  /** Run a deployment plan recorded into the history. */
  deploy: SSH_API_BASE + '/deploy',
  /** Cross-host log search, recorded into the history. */
  logs: SSH_API_BASE + '/logs',
  /** Recent log-search results, newest first. */
  logsHistory: SSH_API_BASE + '/logs/history',
  /** Store or clear the master secret from the panel. */
  setSecret: SSH_API_BASE + '/security/secret',
} as const

/** NDJSON transfer stream line shapes (upload). */
export type TransferStreamLine =
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'result'; ok: boolean; transferredBytes?: number; error?: string }
