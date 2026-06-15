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
