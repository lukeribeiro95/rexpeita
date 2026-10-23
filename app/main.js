const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let pendingPick = null;
let loopback = null;

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
        let audioMode = 'none';
        if (process.platform === 'win32') {
          if (isWindow && pick.captureAudio) {
            audio = chosen;
            audioMode = 'per-window';
          } else if (await startLoopback()) {
            audioMode = 'system-without-tela';
          } else {
            audio = 'loopback';
            audioMode = 'loopback';
          }
        }
        console.log('[tela] sharing source', { id: chosen.id, name: chosen.name, audioMode });
        callback(audio ? { video: chosen, audio } : { video: chosen });
      } catch (e) {
        console.error('display media handler error', e);
        callback({});
      }
    },
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function loopbackExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tela-loopback.exe')
    : path.join(__dirname, 'native', 'bin', 'tela-loopback.exe');
}

// Captura o audio do sistema inteiro menos o do proprio Tela, pra quem esta
// na chamada nao ouvir a propria voz de volta no audio da tela.
function startLoopback() {
  stopLoopback();
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(loopbackExePath(), [String(process.pid)], { windowsHide: true });
    } catch (e) {
      console.error('[tela] loopback spawn error', e);
      return resolve(false);
    }
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 3000);
    let leftover = Buffer.alloc(0);

    proc.on('error', (e) => {
      console.error('[tela] loopback error', e);
      clearTimeout(timer);
      resolve(false);
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (/^ready$/m.test(text)) {
        clearTimeout(timer);
        loopback = proc;
        resolve(true);
      } else {
        console.error('[tela] loopback:', text);
      }
    });
    proc.stdout.on('data', (chunk) => {
      if (loopback !== proc || !mainWindow || mainWindow.isDestroyed()) return;
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 4);
      leftover = Buffer.from(data.subarray(usable));
      if (usable) mainWindow.webContents.send('tela:loopback-data', Buffer.from(data.subarray(0, usable)));
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (loopback === proc) loopback = null;
      resolve(false);
    });
  });
}

function stopLoopback() {
  if (!loopback) return;
  loopback.kill();
  loopback = null;
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

ipcMain.handle('tela:loopback-active', () => loopback !== null);
ipcMain.on('tela:loopback-stop', stopLoopback);

app.whenReady().then(createWindow);

app.on('before-quit', stopLoopback);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
