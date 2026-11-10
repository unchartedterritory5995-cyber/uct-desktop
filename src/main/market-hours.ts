// US equity market hours, used by crash recovery (never auto-reload in market hours) and the updater
// (never interrupt in market hours). One definition, so the two can never disagree.
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})

/** 9:30-16:00 Eastern, Monday to Friday (D19). Holidays are not modelled: the safe error is "true". */
export function isMarketHours(epochMs: number): boolean {
  const parts = Object.fromEntries(ET.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}
