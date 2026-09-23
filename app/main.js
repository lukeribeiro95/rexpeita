const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let pendingPick = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Tela',
    backgroundColor: '#1e1e22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        });
        const ownId = mainWindow?.getMediaSourceId();
        const filtered = sources.filter((s) => s.id !== ownId);
        const pick = await requestPick(filtered);
        if (!pick || !pick.id) return callback({});
        const chosen = filtered.find((s) => s.id === pick.id);
        if (!chosen) return callback({});
        const isWindow = chosen.id.startsWith('window:');
        let audio;
        if (process.platform === 'win32') {
          audio = isWindow && pick.captureAudio ? chosen : 'loopback';
        }
        console.log('[tela] sharing source', {
          id: chosen.id,
          name: chosen.name,
          audioMode: audio === 'loopback' ? 'loopback' : audio ? 'per-window' : 'none',
        });
        callback({ video: chosen, audio });
      } catch (e) {
        console.error('display media handler error', e);
        callback({});
      }
    },
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function requestPick(sources) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    if (pendingPick) {
      pendingPick(null);
      pendingPick = null;
    }
    pendingPick = resolve;
    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail?.toDataURL() || null,
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
    mainWindow.webContents.send('tela:pick-source', payload);
  });
}

ipcMain.on('tela:pick-source-response', (_e, payload) => {
  if (pendingPick) {
    pendingPick(payload || null);
    pendingPick = null;
  }
});

ipcMain.handle('tela:save-recording', async (_e, { buffer, defaultName }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { saved: false };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar gravacao',
    defaultPath: defaultName,
    filters: [{ name: 'Video WebM', extensions: ['webm'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.promises.writeFile(result.filePath, Buffer.from(buffer));
  return { saved: true, path: result.filePath };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
