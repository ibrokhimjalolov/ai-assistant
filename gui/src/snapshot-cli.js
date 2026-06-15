'use strict';
const { getSnapshot } = require('./datasource.js');
const { appDataRoot } = require('./paths.js');

// GUI_APPDATA_ROOT lets tests (and overrides) point at a fixture root.
const root = process.env.GUI_APPDATA_ROOT || appDataRoot();
try {
  const snap = getSnapshot({ root });
  process.stdout.write(JSON.stringify(snap));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message, agents: [], daemon: { status: 'unknown' } }));
}
