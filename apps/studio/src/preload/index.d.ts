import type { StudioBridgeApi } from '@redbusagent/shared/studio';

declare global {
    interface Window {
        redbusStudio: StudioBridgeApi;
    }
}

export {};