'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, 'src', 'snapshot-cli.js');
// Use system `node` (verified to expose node:sqlite unflagged). Override with GUI_NODE_BIN.
const NODE_BIN = process.env.GUI_NODE_BIN || 'node';

function fetchSnapshot() {
  return new Promise((resolve) => {
    execFile(NODE_BIN, [CLI], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
