import { formatDuration, statusClass, daemonText } from './format.mjs';

const $ = (id) => document.getElementById(id);

function daemonClass(d) {
  if (d && d.alive) return 'ok';
  if (d && d.alive === false) return 'bad';
  return 'muted';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderAgent(a) {
  const card = el('div', 'card');
  if (a.error) {
    card.appendChild(el('h2', null, a.name));
    card.appendChild(el('div', 'unavailable', `DB unavailable — ${a.detail || a.error}`));
    return card;
  }
  const h2 = el('h2', null, a.name);
  h2.appendChild(el('span', `pill ${a.busy ? 'busy' : 'idle'}`, a.busy ? 'Working' : 'Idle'));
  card.appendChild(h2);

  const countStr = Object.entries(a.counts || {}).map(([k, v]) => `${k}: ${v}`).join('   ') || 'no tasks';
  card.appendChild(el('div', 'meta', `Last activity: ${a.lastActivityAt || '—'}    •    ${countStr}`));

  if (a.busy && a.currentTask) {
    card.appendChild(el('div', 'section-title', 'Current task'));
    card.appendChild(el('div', null, `#${a.currentTask.id} (${a.currentTask.source}) — ${a.currentTask.prompt}`));
  }

  card.appendChild(el('div', 'section-title', 'Sessions'));
  if ((a.sessions || []).length === 0) card.appendChild(el('div', 'meta', 'none'));
  for (const s of a.sessions || []) {
    card.appendChild(el('div', 'meta', `user ${s.userId} · ${String(s.sessionId).slice(0, 8)}… · ${s.taskCount} tasks · since ${s.createdAt}`));
  }

  card.appendChild(el('div', 'section-title', 'Recent tasks'));
  const table = el('table');
  for (const t of a.recentTasks || []) {
    const tr = el('tr');
    tr.appendChild(el('td', `badge ${statusClass(t.status)}`, t.status));
    tr.appendChild(el('td', null, t.source));
    tr.appendChild(el('td', null, t.prompt));
    tr.appendChild(el('td', null, formatDuration(t.durationSec)));
    table.appendChild(tr);
  }
  card.appendChild(table);

  if ((a.schedules || []).length) {
    card.appendChild(el('div', 'section-title', 'Schedules'));
    for (const sc of a.schedules) {
      const when = sc.cronExpr ? `cron ${sc.cronExpr}` : `at ${sc.runAt}`;
      card.appendChild(el('div', 'meta', `#${sc.id} ${when} · ${sc.enabled ? 'enabled' : 'disabled'} · last ${sc.lastRunAt || '—'} · ${sc.prompt}`));
    }
  }
  return card;
}

function paint(snap) {
  const d = $('daemon');
  d.textContent = daemonText(snap.daemon || {});
  d.className = `daemon ${daemonClass(snap.daemon || {})}`;
  $('generated').textContent = snap.generatedAt ? `updated ${new Date(snap.generatedAt).toLocaleTimeString()}` : '';

  const err = $('error');
  if (snap.error) { err.hidden = false; err.textContent = `Error: ${snap.error}${snap.detail ? ' — ' + snap.detail : ''}`; }
  else { err.hidden = true; }

  const main = $('agents');
  main.replaceChildren(...(snap.agents || []).map(renderAgent));
}

async function tick() {
  try { paint(await window.api.getSnapshot()); }
  catch (e) { $('error').hidden = false; $('error').textContent = `Refresh failed: ${e}`; }
}

tick();
setInterval(tick, 3000);
