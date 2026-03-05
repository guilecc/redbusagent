import { contextBridge, ipcRenderer } from 'electron';
import {
    STUDIO_IPC_COMMAND_CHANNEL,
    STUDIO_IPC_EVENT_CHANNEL,
    type StudioBridgeApi,
    type StudioMainEvent,
} from '@redbusagent/shared/studio';

const redbusStudio: StudioBridgeApi = {
    invoke: (command) => ipcRenderer.invoke(STUDIO_IPC_COMMAND_CHANNEL, command),
    subscribe: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: StudioMainEvent) => {
            listener(payload);
        };

        ipcRenderer.on(STUDIO_IPC_EVENT_CHANNEL, wrapped);
        return () => {
            ipcRenderer.removeListener(STUDIO_IPC_EVENT_CHANNEL, wrapped);
        };
    },
};

if (process.contextIsolated) {
    contextBridge.exposeInMainWorld('redbusStudio', redbusStudio);
} else {
    Object.assign(globalThis as typeof globalThis & { redbusStudio: StudioBridgeApi }, { redbusStudio });
}