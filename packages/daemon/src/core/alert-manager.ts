/**
 * @redbusagent/daemon — Alert Manager
 *
 * Persists and triggers scheduled notifications/alerts intelligently created
 * by the Proactive Engine or explicitly requested by the user.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Vault } from '@redbusagent/shared';

export interface Alert {
    id: string;
    message: string;
    scheduledFor: string; // ISO String
    triggered: boolean;
    createdAt: string;
}

export class AlertManager {
    static get storagePath(): string {
        return join(Vault.dir, 'alerts.json');
    }

    static getAlerts(): Alert[] {
        if (!existsSync(this.storagePath)) return [];
        try {
            return JSON.parse(readFileSync(this.storagePath, 'utf-8'));
        } catch {
            return [];
        }
    }

    private static saveAlerts(alerts: Alert[]): void {
        writeFileSync(this.storagePath, JSON.stringify(alerts, null, 2), 'utf-8');
    }

    static addAlert(message: string, scheduledDateIso: string): Alert {
        const alerts = this.getAlerts();
        const alert: Alert = {
            id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            message,
            scheduledFor: scheduledDateIso,
            triggered: false,
            createdAt: new Date().toISOString()
        };
        alerts.push(alert);
        this.saveAlerts(alerts);
        return alert;
    }

    /**
     * Finds alerts that are past their scheduled date and haven't triggered yet.
     * Marks them as triggered.
     */
    static popDueAlerts(): Alert[] {
        const alerts = this.getAlerts();
        const now = new Date();
        const dueAlerts: Alert[] = [];
        let changed = false;

        for (const alert of alerts) {
            if (!alert.triggered && new Date(alert.scheduledFor) <= now) {
                alert.triggered = true;
                dueAlerts.push(alert);
                changed = true;
            }
        }

        // Cleanup: remove alerts older than 7 days to avoid infinite growth
        const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
        const filteredAlerts = alerts.filter(a => {
            if (!a.triggered) return true; // keep all pending
            return new Date(a.scheduledFor).getTime() > sevenDaysAgo;
        });

        if (changed || filteredAlerts.length !== alerts.length) {
            this.saveAlerts(filteredAlerts);
        }

        return dueAlerts;
    }
}
