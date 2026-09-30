import {
  registerChangeCommit,
  hasChangeCommit,
  cancelChangeCommit,
  attachCommitCleanup
} from './agent/change-commit-ipc'
import { registerChangePreview } from './agent/change-preview-ipc'
import {
  registerChangePreparation,
  hasChangePreparation,
  cleanupChangePreparation
} from './agent/change-preparation-ipc'
import {
  hasProjectSelection,
  hasProjectSnapshot,
  hasWorkspaceSelection
} from './agent/project-access'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createConversationStore } from './storage/conversation-store'
import { registerWindowControls, observeWindowState } from './window/window-controls'
import { registerCloseGuard, attachCloseGuard } from './window/close-guard'
import { registerLocalTerminal, attachTerminalCleanup } from './terminal/local-terminal'
import { abortProjectJob, hasAgentJob, registerAgentRequest } from './agent/agent-ipc'
import {
  cancelConversationTitleJob,
  registerConversationTitleRequest
} from './agent/conversation-title-ipc'
import { attachProjectAccessCleanup, registerProjectAccess } from './agent/project-access'
import {
  cleanupCommandPreparation,
  registerCommandPreparation
} from './agent/command-preparation-ipc'
import {
  cleanupCommandExecution,
  hasCommandExecution,
  registerCommandExecution
} from './agent/command-execution-ipc'
import { decideCommandPermission } from '../shared/permission-policy'
import {
  cleanupTaskWindow,
  cleanupTasksForSnapshot,
  discardTaskWindow,
  registerTaskLifecycle
} from './agent/task-registry'

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
      ? url.href
      : null
  } catch {
    return null
  }
}

async function openExternalUrl(value: unknown): Promise<boolean> {
  const url = safeExternalUrl(value)
  if (!url) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
}

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
  mainWindow.webContents.on('did-start-loading', () => {
    cancelConversationTitleJob(mainWindow.id)
    cleanupTaskWindow(mainWindow.id)
    cleanupCommandExecution(mainWindow.id)
    cleanupCommandPreparation(mainWindow.id)
  })
  mainWindow.on('closed', () => {
    cancelConversationTitleJob(mainWindow.id)
    discardTaskWindow(mainWindow.id)
    cleanupCommandExecution(mainWindow.id)
    cleanupCommandPreparation(mainWindow.id)
  })
  attachCommitCleanup(mainWindow)
  // 注册窗口控件
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
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

  // 注册窗口控件
  registerWindowControls()
  registerTaskLifecycle()
  // 注册关闭确认处理器
  registerCloseGuard(hasChangeCommit)
  // 注册本地终端接口
  registerLocalTerminal()
  // 注册真实 Agent 请求接口
  registerAgentRequest(
    (id) =>
      hasChangePreparation(id) ||
      hasChangeCommit(id) ||
      hasCommandExecution(id) ||
      hasWorkspaceSelection(id)
  )
  registerConversationTitleRequest()
  registerCommandPreparation((windowId, source) => {
    const snapshotId = hasProjectSnapshot(windowId, source.snapshotId) ? source.snapshotId : ''
    return decideCommandPermission(
      { template: source.template, reason: '已通过提案解析' },
      { kind: 'project', snapshotId }
    ).allowed
  })
  registerCommandExecution((windowId, source) => {
    const snapshotId = hasProjectSnapshot(windowId, source.snapshotId) ? source.snapshotId : ''
    return decideCommandPermission(
      { template: source.template, reason: '已通过提案解析' },
      { kind: 'project', snapshotId }
    ).allowed
  })
  // 注册项目文件选择与撤销接口
  registerProjectAccess({
    isAgentJobActive: (id) =>
      hasAgentJob(id) || hasChangePreparation(id) || hasChangeCommit(id) || hasCommandExecution(id),
    abortProjectJob,
    onAccessChanged: (id, snapshotId) => {
      cleanupChangePreparation(id)
      cleanupCommandPreparation(id)
      cleanupCommandExecution(id)
      cancelChangeCommit(id)
      if (snapshotId) cleanupTasksForSnapshot(id, snapshotId)
    }
  })
  registerChangePreview(hasChangeCommit)
  registerChangePreparation(
    (id) =>
      hasAgentJob(id) ||
      hasProjectSelection(id) ||
      hasWorkspaceSelection(id) ||
      hasChangeCommit(id) ||
      hasCommandExecution(id)
  )
  registerChangeCommit(
    (id) =>
      hasAgentJob(id) ||
      hasProjectSelection(id) ||
      hasWorkspaceSelection(id) ||
      hasChangePreparation(id) ||
      hasCommandExecution(id)
  )

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
  ipcMain.handle('external:open', (event, url: unknown) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('不支持的打开来源')
    }
    return openExternalUrl(url)
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
