const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

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
        const chosenId = await requestPick(sources);
        if (!chosenId) return callback({});
        const chosen = sources.find((s) => s.id === chosenId);
        if (!chosen) return callback({});
        const audio = process.platform === 'win32' ? 'loopback' : undefined;
        callback({ video: chosen, audio });
      } catch (e) {
        console.error('display media handler error', e);
        callback({});
      }
    },
    { useSystemPicker: true },
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

ipcMain.on('tela:pick-source-response', (_e, sourceId) => {
  if (pendingPick) {
    pendingPick(sourceId || null);
    pendingPick = null;
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
