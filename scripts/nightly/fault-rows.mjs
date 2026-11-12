// The proofs report one `PASS|FAIL <id>: <detail>` line per row; the weekly fault check collects them.
export function parseRows(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.match(/^(PASS|FAIL) ([\w-]+): (.*)$/)).filter(Boolean)
    .map((m) => ({ id: m[2], pass: m[1] === 'PASS', detail: m[3].trim().slice(0, 300) }))
}
