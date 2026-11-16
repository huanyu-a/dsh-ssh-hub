/**
 * Output redaction for remote command results.
 *
 * The base plugin returns exec and cluster output verbatim. That output is
 * the model's context AND, in DSH, part of the session log — so a command
 * like `env` or `cat /etc/redis.conf` writes the remote secrets into a
 * transcript that outlives the session and lands in every backup of it.
 *
 * This module redacts the shapes a secret actually takes in command
 * output. It is a safety net, not a guarantee: the tool cannot know every
 * secret on the remote host. The tool description says so, so the model
 * does not treat the redacted output as safe to reason about freely.
 *
 * Redaction is deliberately conservative about what it hides — a false
 * positive costs a little context, a false negative costs a credential.
 */

/** One redaction rule. */
interface RedactionRule {
  /** The rule name (used in the report). */
  id: string
  /** The pattern to match. */
  pattern: RegExp
  /** The replacement; `$1` style groups are preserved. */
  replacement: string
}

/**
 * The rules, in order.
 *
 * The `g` flag is required on each: without it only the first match in a
 * line would be redacted, and `env` prints one secret per line.
 */
const RULES: readonly RedactionRule[] = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED PRIVATE KEY]',
  },
  {
    id: 'authorization-header',
    pattern: /(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token)\s+\S+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    id: 'aws-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED AWS KEY ID]',
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replacement: 'Bearer [REDACTED]',
  },
  {
    id: 'password-assignment',
    // `PASSWORD=secret`, `password: secret`, `api_key=secret` ...
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("?)([^\s"']+)\3/gi,
    replacement: '$1$2[REDACTED]',
  },
  {
    id: 'connection-string',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replacement: '$1$2:[REDACTED]@',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED JWT]',
  },
]

/**
 * Redact secrets from command output.
 *
 * @param text - the output to redact.
 * @returns the redacted text.
 */
export function redactOutput(text: string): string {
  if (text === '') return text
  let result = text
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/**
 * Redact a command line before it is logged or displayed.
 *
 * A command may itself carry a secret as an argument (`mysql -p hunter2`,
 * `curl -H 'Authorization: Bearer ...'`), which the output rules would
 * never see.
 *
 * @param command - the command line.
 * @returns the redacted command.
 */
export function redactCommand(command: string): string {
  let result = command
  // `mysql -p secret` / `psql --password secret`
  result = result.replace(/(\s-p\s+)(\S+)/g, '$1[REDACTED]')
  result = result.replace(/(--password[= ])(\S+)/g, '$1[REDACTED]')
  // An inline `--header 'Authorization: Bearer ...'`
  result = result.replace(/(Authorization:\s*)(Bearer\s+)?\S+/gi, '$1[REDACTED]')
  return result
}

/**
 * Which rules matched an output.
 *
 * Useful for the audit log: the operator can see that a result was
 * redacted without seeing what was hidden.
 *
 * @param text - the original text.
 * @returns the ids of the rules that matched.
 */
export function matchedRules(text: string): string[] {
  return RULES.filter(rule => rule.pattern.test(text)).map(rule => rule.id)
}
