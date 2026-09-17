import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { askModel } from './model/model'
import { registerModelStream } from './model/model-stream'
import { createConversationStore } from './storage/conversation-store'
import { registerWindowControls, observeWindowState } from './window/window-controls'
import { registerCloseGuard, attachCloseGuard } from './window/close-guard'
import { registerLocalTerminal, attachTerminalCleanup } from './terminal/local-terminal'
import { abortProjectJob, hasAgentJob, registerAgentPractice } from './agent/agent-ipc'
import { attachProjectAccessCleanup, registerProjectAccess } from './agent/project-access'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// 创建/删除 Windows 快捷方式
function createWindow(): void {
  // Create the browser window.
  // 创建浏览器窗口
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 680,
    minHeight: 560,
    title: 'ZoneCodex',
    titleBarStyle: 'hidden',
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  // 观察窗口状态变化
  observeWindowState(mainWindow)
  // 注册关闭确认处理器
  attachCloseGuard(mainWindow)
  // 注册终端清理处理器
  attachTerminalCleanup(mainWindow)
  // 注册项目快照授权清理处理器
  attachProjectAccessCleanup(mainWindow)
  // 注册窗口控件
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  // 注册非流式模型请求（保留早期课程接口）
  ipcMain.handle('chat:ask', async (event, history: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('不支持的模型请求来源')
    }
    return askModel(history)
  })
  // 注册窗口控件
  registerWindowControls()
  // 注册关闭确认处理器
  registerCloseGuard()
  // 注册真实流处理函数
  registerModelStream()
  // 注册本地终端接口
  registerLocalTerminal()
  // 注册练习工具接口
  registerAgentPractice()
  // 注册项目文件选择与撤销接口
  registerProjectAccess({ isAgentJobActive: hasAgentJob, abortProjectJob })

  // 创建会话存储器
  const conversationStore = createConversationStore(app.getPath('userData'))
  // 注册会话存储接口
  ipcMain.handle('conversation:load', (event) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('不支持的读取来源')
    return conversationStore.load()
  })
  // 注册会话存储接口
  ipcMain.handle('conversation:save', (event, snapshot: unknown) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('不支持的保存来源')
    return conversationStore.save(snapshot)
  })

  // Create the application window when the app is ready.
  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
