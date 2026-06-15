export function formatDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
export function statusClass(status) {
  switch (status) {
    case 'done': return 'ok';
    case 'failed': case 'interrupted': case 'cancelled': return 'bad';
    case 'running': return 'busy';
    default: return 'muted';
  }
}
export function daemonText(d) {
  if (d && d.alive) return `Running (pid ${d.pid})`;
  if (d && d.alive === false) return 'Stopped';
  return 'Unknown';
}
// Whole seconds between a task's start time and `nowMs`. Accepts both the
// SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no Z) and ISO-with-Z formats. Negative
// drift is clamped to 0; null/empty/unparseable → null.
export function elapsedSeconds(startedAt, nowMs) {
  if (!startedAt) return null;
  const str = String(startedAt);
  const iso = str.includes('T') || str.endsWith('Z') ? str : str.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}
