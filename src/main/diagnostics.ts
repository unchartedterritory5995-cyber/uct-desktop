// Text a member can paste into a support message. Everything passes through scrub() first.

const RULES: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [removed]'],
  // Authorization: <scheme> <credentials> (Basic, Digest, Token...) or a bare value.
  [/\b((?:proxy-)?authorization)(["']?)\s*[:=]\s*["']?(?:(?:Basic|Digest|Bearer|Token|Negotiate)\s+)?[^\s"',;]+/gi, '$1: [removed]'],
  // Cookie headers: name=value pairs separated by semicolons.
  [/\b((?:set-)?cookie)(["']?)\s*[:=]\s*["']?[^\s;="']+=[^\s;"']*(?:;\s*[^\s;="']+=[^\s;"']*)*/gi, '$1: [removed]'],
  // key=value, key: value and JSON "key":"value" for secret-looking keys.
  [/(["']?)\b([A-Za-z_-]*(?:token|secret|password|passwd|pwd|apikey|api_key|key|session|sid|cookie)[A-Za-z_-]*)\1\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&,;"']+)/gi, '$2=[removed]'],
  [/\b(?:sk|pk|rk|whsec)_[A-Za-z0-9_]{8,}/g, '[removed-key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[removed-email]'],
  [/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[removed-long-value]'],
]

export function scrub(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text)
}

export interface ProcessMetric {
  type: string
  pid: number
  memoryKb: number
  cpuPercent: number
  note?: string
}

export interface DiagnosticsInput {
  appVersion: string
  versions: { electron: string; chrome: string; node: string }
  platform: string
  metrics: ProcessMetric[]
  /** Size of the persist:uct HTTP cache, from session.getCacheSize(). */
  cacheBytes: number
}

export function buildDiagnostics(d: DiagnosticsInput): string {
  const lines = [
    `UCT Intelligence ${d.appVersion}`,
    `Electron ${d.versions.electron}, Chrome ${d.versions.chrome}, Node ${d.versions.node}`,
    `Platform ${d.platform}`,
    `Partition cache bytes: ${d.cacheBytes}`,
    'Processes:',
    ...d.metrics.map((m) => `  ${m.type} pid=${m.pid} memoryKb=${m.memoryKb} cpu=${m.cpuPercent}${m.note ? ` ${m.note}` : ''}`),
  ]
  return scrub(lines.join('\n'))
}
