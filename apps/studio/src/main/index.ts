/**
 * Redbus Studio is scaffolded under apps/studio because it is a deployable
 * desktop application with Electron main/preload/renderer entrypoints.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import {
    DEFAULT_STUDIO_SETTINGS,
    normalizeStudioSettings,
    STUDIO_IPC_COMMAND_CHANNEL,
    STUDIO_IPC_EVENT_CHANNEL,
    STUDIO_IPC_VERSION,
    type StudioCommandResult,
    type StudioMainEvent,
    type StudioRendererCommand,
    type StudioSettings,
} from '@redbusagent/shared/studio';
import { StudioDaemonBridge } from './daemonBridge.js';

let mainWindow: BrowserWindow | null = null;

let studioSettings: StudioSettings = DEFAULT_STUDIO_SETTINGS;

const bridge = new StudioDaemonBridge(emit);

function getSettingsPath(): string {
    return join(app.getPath('userData'), 'studio-settings.json');
}

function loadStudioSettings(): StudioSettings {
    try {
        const settingsPath = getSettingsPath();
        if (!existsSync(settingsPath)) {
            return DEFAULT_STUDIO_SETTINGS;
        }

        const raw = readFileSync(settingsPath, 'utf-8');
        return normalizeStudioSettings(JSON.parse(raw) as Partial<StudioSettings>);
    } catch {
        return DEFAULT_STUDIO_SETTINGS;
    }
}

function persistStudioSettings(settings: StudioSettings): void {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
}

function emit(event: StudioMainEvent): void {
    mainWindow?.webContents.send(STUDIO_IPC_EVENT_CHANNEL, event);
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1200,
        minHeight: 720,
        show: false,
        autoHideMenuBar: true,
        title: 'Redbus Studio',
        webPreferences: {
            preload: join(__dirname, '../preload/index.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.on('ready-to-show', () => {
        mainWindow?.show();
        emit({
            type: 'session/state',
            version: STUDIO_IPC_VERSION,
            payload: bridge.currentSessionState,
        });
    });

    if (process.env['ELECTRON_RENDERER_URL']) {
        void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
        return;
    }

    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

ipcMain.handle(
    STUDIO_IPC_COMMAND_CHANNEL,
    async (_event, command: StudioRendererCommand): Promise<StudioCommandResult> => {
        try {
            switch (command.type) {
                case 'session/connect': {
                    const data = await bridge.connect(command.payload.profileId, command.payload.tunnel);
                    return { ok: true, type: command.type, data };
                }

                case 'session/disconnect': {
                    const data = await bridge.disconnect(command.payload.reason);
                    return { ok: true, type: command.type, data };
                }

                case 'chat/send': {
                    const data = bridge.sendChat(command.payload);
                    return { ok: true, type: command.type, data };
                }

                case 'yield/respond': {
                    const data = bridge.respondToYield(command.payload);
                    return { ok: true, type: command.type, data };
                }

                case 'system/command': {
                    const data = bridge.sendSystemCommand(command.payload);
                    return { ok: true, type: command.type, data };
                }

                case 'settings/load':
                    return { ok: true, type: command.type, data: { settings: studioSettings } };

                case 'settings/save':
                    studioSettings = normalizeStudioSettings(command.payload.settings);
                    persistStudioSettings(studioSettings);
                    return { ok: true, type: command.type, data: { settings: studioSettings } };
            }
        } catch (error) {
            return {
                ok: false,
                type: command.type,
                error: error instanceof Error ? error.message : 'Studio main process command failed.',
            };
        }
    },
);

app.whenReady().then(() => {
    studioSettings = loadStudioSettings();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('before-quit', () => {
    void bridge.shutdown();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});