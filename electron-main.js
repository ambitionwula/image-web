import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.NODE_ENV = 'production'
let mainWindow
let localServer

async function createWindow() {
  process.env.IMAGE_STUDIO_DATA_DIR = app.getPath('userData')
  const { startServer } = await import('./server.js')
  try {
    localServer = startServer(0)
  } catch (error) {
    console.error('Failed to start local server:', error)
    app.quit()
    return
  }

  await new Promise((resolve, reject) => {
    if (localServer.listening) return resolve()
    localServer.once('listening', resolve)
    localServer.once('error', reject)
  })
  const port = localServer.address().port

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f3f0e9',
    title: '造像所',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(createWindow)

ipcMain.handle('select-save-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片自动保存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

app.on('window-all-closed', () => {
  localServer?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => localServer?.close())
