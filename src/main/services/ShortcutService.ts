import { Shortcut } from '@types'
import { BrowserWindow, globalShortcut } from 'electron'
import Logger from 'electron-log'

import { configManager } from './ConfigManager'
import { windowService } from './WindowService'

let showAppAccelerator: string | null = null
let showMiniWindowAccelerator: string | null = null

// store the focus and blur handlers for each window to unregister them later
const windowOnHandlers = new Map<BrowserWindow, { onFocusHandler: () => void; onBlurHandler: () => void }>()

function getShortcutHandler(shortcut: Shortcut) {
  switch (shortcut.key) {
    case 'zoom_in':
      return (window: BrowserWindow) => handleZoom(0.1)(window)
    case 'zoom_out':
      return (window: BrowserWindow) => handleZoom(-0.1)(window)
    case 'zoom_reset':
      return (window: BrowserWindow) => {
        window.webContents.setZoomFactor(1)
        configManager.setZoomFactor(1)
      }
    case 'show_app':
      return () => {
        windowService.toggleMainWindow()
      }
    case 'mini_window':
      return () => {
        windowService.toggleMiniWindow()
      }
    default:
      return null
  }
}

function formatShortcutKey(shortcut: string[]): string {
  return shortcut.join('+')
}

function handleZoom(delta: number) {
  return (window: BrowserWindow) => {
    const currentZoom = configManager.getZoomFactor()
    const newZoom = Number((currentZoom + delta).toFixed(1))
    if (newZoom >= 0.1 && newZoom <= 5.0) {
      window.webContents.setZoomFactor(newZoom)
      configManager.setZoomFactor(newZoom)
    }
  }
}

const convertShortcutRecordedByKeyboardEventKeyValueToElectronGlobalShortcutFormat = (
  shortcut: string | string[]
): string => {
  const accelerator = (() => {
    if (Array.isArray(shortcut)) {
      return shortcut
    } else {
      return shortcut.split('+').map((key) => key.trim())
    }
  })()

  return accelerator
    .map((key) => {
      switch (key) {
        case 'Command':
          return 'CommandOrControl'
        case 'Control':
          return 'Control'
        case 'Ctrl':
          return 'Control'
        case 'ArrowUp':
          return 'Up'
        case 'ArrowDown':
          return 'Down'
        case 'ArrowLeft':
          return 'Left'
        case 'ArrowRight':
          return 'Right'
        case 'AltGraph':
          return 'Alt'
        case 'Slash':
          return '/'
        case 'Semicolon':
          return ';'
        case 'BracketLeft':
          return '['
        case 'BracketRight':
          return ']'
        case 'Backslash':
          return '\\'
        case 'Quote':
          return "'"
        case 'Comma':
          return ','
        case 'Minus':
          return '-'
        case 'Equal':
          return '='
        default:
          return key
      }
    })
    .join('+')
}

export function registerShortcuts(window: BrowserWindow) {
  window.once('ready-to-show', () => {
    if (configManager.getLaunchToTray()) {
      registerOnlyUniversalShortcuts()
    }
  })

  //only for clearer code
  const registerOnlyUniversalShortcuts = () => {
    register(true)
  }

  //onlyUniversalShortcuts is used to register shortcuts that are not window specific, like show_app & mini_window
  //onlyUniversalShortcuts is needed when we launch to tray
  const register = (onlyUniversalShortcuts: boolean = false) => {
    if (window.isDestroyed()) return

    const shortcuts = configManager.getShortcuts()
    if (!shortcuts) return

    shortcuts.forEach((shortcut) => {
      try {
        if (shortcut.shortcut.length === 0) {
          return
        }

        //if not enabled, exit early from the process.
        if (!shortcut.enabled) {
          return
        }

        // only register universal shortcuts when needed
        if (onlyUniversalShortcuts && !['show_app', 'mini_window'].includes(shortcut.key)) {
          return
        }

        const handler = getShortcutHandler(shortcut)
        if (!handler) {
          return
        }

        switch (shortcut.key) {
          case 'show_app':
            showAppAccelerator = formatShortcutKey(shortcut.shortcut)
            break

          case 'mini_window':
            //available only when QuickAssistant enabled
            if (!configManager.getEnableQuickAssistant()) {
              return
            }
            showMiniWindowAccelerator = formatShortcutKey(shortcut.shortcut)
            break

          //the following ZOOMs will register shortcuts seperately, so will return
          case 'zoom_in':
            globalShortcut.register('CommandOrControl+=', () => handler(window))
            globalShortcut.register('CommandOrControl+numadd', () => handler(window))
            return

          case 'zoom_out':
            globalShortcut.register('CommandOrControl+-', () => handler(window))
            globalShortcut.register('CommandOrControl+numsub', () => handler(window))
            return

          case 'zoom_reset':
            globalShortcut.register('CommandOrControl+0', () => handler(window))
            return
        }

        const accelerator = convertShortcutRecordedByKeyboardEventKeyValueToElectronGlobalShortcutFormat(
          shortcut.shortcut
        )

        globalShortcut.register(accelerator, () => handler(window))
      } catch (error) {
        Logger.error(`[ShortcutService] Failed to register shortcut ${shortcut.key}`)
      }
    })
  }

  const unregister = () => {
    if (window.isDestroyed()) return

    try {
      globalShortcut.unregisterAll()

      if (showAppAccelerator) {
        const handler = getShortcutHandler({ key: 'show_app' } as Shortcut)
        const accelerator =
          convertShortcutRecordedByKeyboardEventKeyValueToElectronGlobalShortcutFormat(showAppAccelerator)
        handler && globalShortcut.register(accelerator, () => handler(window))
      }

      if (showMiniWindowAccelerator) {
        const handler = getShortcutHandler({ key: 'mini_window' } as Shortcut)
        const accelerator =
          convertShortcutRecordedByKeyboardEventKeyValueToElectronGlobalShortcutFormat(showMiniWindowAccelerator)
        handler && globalShortcut.register(accelerator, () => handler(window))
      }
    } catch (error) {
      Logger.error('[ShortcutService] Failed to unregister shortcuts')
    }
  }

  // only register the event handlers once
  if (undefined === windowOnHandlers.get(window)) {
    // pass register() directly to listener, the func will receive Event as argument, it's not expected
    const registerHandler = () => {
      register()
    }
    window.on('focus', registerHandler)
    window.on('blur', unregister)
    windowOnHandlers.set(window, { onFocusHandler: registerHandler, onBlurHandler: unregister })
  }

  if (!window.isDestroyed() && window.isFocused()) {
    register()
  }
}

export function unregisterAllShortcuts() {
  try {
    showAppAccelerator = null
    showMiniWindowAccelerator = null
    windowOnHandlers.forEach((handlers, window) => {
      window.off('focus', handlers.onFocusHandler)
      window.off('blur', handlers.onBlurHandler)
    })
    windowOnHandlers.clear()
    globalShortcut.unregisterAll()
  } catch (error) {
    Logger.error('[ShortcutService] Failed to unregister all shortcuts')
  }
}
