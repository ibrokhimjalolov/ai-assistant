'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, 'src', 'snapshot-cli.js');

// How to run the snapshot CLI. By default reuse Electron's OWN bundled Node
// (process.execPath in ELECTRON_RUN_AS_NODE mode) so a double-clicked .app
// never depends on a `node` being on the (absent) Finder PATH. Electron's
// Node has node:sqlite behind the --experimental-sqlite flag. Set GUI_NODE_BIN
// to a real `node` binary to use that instead (no flag needed on Node ≥24).
function snapshotCommand() {
  if (process.env.GUI_NODE_BIN) {
    return { bin: process.env.GUI_NODE_BIN, args: [CLI], env: process.env };
  }
  return {
    bin: process.execPath,
    args: ['--experimental-sqlite', CLI],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

function fetchSnapshot() {
  const { bin, args, env } = snapshotCommand();
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ error: 'snapshot subprocess failed', detail: String(stderr || err.message).slice(0, 600), agents: [], daemon: { status: 'unknown' } });
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { resolve({ error: 'invalid snapshot JSON', detail: String(e).slice(0, 300), agents: [], daemon: { status: 'unknown' } }); }
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880, height: 720, title: 'Agent Runtime Monitor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('getSnapshot', () => fetchSnapshot());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
