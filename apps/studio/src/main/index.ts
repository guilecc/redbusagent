/**
 * Redbus Studio is scaffolded under apps/studio because it is a deployable
 * desktop application with Electron main/preload/renderer entrypoints.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import {
    STUDIO_IPC_COMMAND_CHANNEL,
    STUDIO_IPC_EVENT_CHANNEL,
    STUDIO_IPC_VERSION,
    type StudioCommandResult,
    type StudioMainEvent,
    type StudioRendererCommand,
    type StudioSettings,
} from '@redbusagent/shared/studio';

let mainWindow: BrowserWindow | null = null;

let studioSettings: StudioSettings = {
    theme: 'system',
    openDevtoolsOnLaunch: false,
    profiles: [],
};

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
            version: STUDIO_IPC_VERSION,
            type: 'session/state',
            payload: {
                sessionId: 'studio-shell',
                connection: 'disconnected',
                tunnel: 'idle',
                daemon: 'disconnected',
            },
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
        switch (command.type) {
            case 'session/connect':
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'session/state',
                    payload: {
                        sessionId: 'studio-shell',
                        connection: 'connecting',
                        tunnel: 'opening',
                        daemon: 'connecting',
                        activeProfileId: command.payload.profileId,
                    },
                });
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'tunnel/log',
                    payload: {
                        level: 'info',
                        message: `Prepared SSH tunnel scaffold to ${command.payload.tunnel.host}:${command.payload.tunnel.port}`,
                        step: 'ssh/connect',
                        remotePort: command.payload.tunnel.port,
                    },
                });
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'session/state',
                    payload: {
                        sessionId: 'studio-shell',
                        connection: 'connected',
                        tunnel: 'open',
                        daemon: 'connected',
                        activeProfileId: command.payload.profileId,
                    },
                });
                return { ok: true, type: command.type, data: { connected: true } };

            case 'session/disconnect':
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'session/state',
                    payload: {
                        sessionId: 'studio-shell',
                        connection: 'disconnected',
                        tunnel: 'idle',
                        daemon: 'disconnected',
                    },
                });
                return { ok: true, type: command.type, data: { disconnected: true } };

            case 'chat/send':
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/thought',
                    payload: {
                        text: 'Studio shell accepted the chat request. Wave 2 will wire daemon streaming here.',
                        status: 'thinking',
                    },
                });
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/streamChunk',
                    payload: {
                        requestId: command.payload.requestId,
                        delta: 'Studio IPC contract is live. ',
                    },
                });
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/streamDone',
                    payload: {
                        requestId: command.payload.requestId,
                        fullText: `Queued message: ${command.payload.content}`,
                        tier: command.payload.tier ?? 'live',
                        model: 'studio-shell-placeholder',
                    },
                });
                return { ok: true, type: command.type, data: { requestId: command.payload.requestId } };

            case 'yield/respond':
                emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'yield/resolved',
                    payload: {
                        yieldId: command.payload.yieldId,
                        resolution: 'submitted',
                    },
                });
                return { ok: true, type: command.type, data: { yieldId: command.payload.yieldId } };

            case 'settings/load':
                return { ok: true, type: command.type, data: { settings: studioSettings } };

            case 'settings/save':
                studioSettings = command.payload.settings;
                return { ok: true, type: command.type, data: { settings: studioSettings } };
        }
    },
);

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});