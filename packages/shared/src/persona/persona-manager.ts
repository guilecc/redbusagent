/**
 * @redbusagent/shared — Persona Manager
 *
 * Manages the agent's identity and behavioral guidelines
 * stored in ~/.redbusagent/persona.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Persona {
    agent_name: string;
    user_context: string;
    behavioral_guidelines: string;
}

const PERSONA_FILE = join(homedir(), '.redbusagent', 'persona.json');

export class PersonaManager {
    static exists(): boolean {
        return existsSync(PERSONA_FILE);
    }

    static read(): Persona | null {
        if (!this.exists()) return null;
        try {
            const raw = readFileSync(PERSONA_FILE, 'utf-8');
            return JSON.parse(raw) as Persona;
        } catch {
            return null;
        }
    }

    static write(persona: Persona): void {
        writeFileSync(PERSONA_FILE, JSON.stringify(persona, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
        });
    }

    static update(updates: Partial<Persona>): void {
        const current = this.read() || {
            agent_name: 'Agent',
            user_context: 'Unknown',
            behavioral_guidelines: 'Professional and helpful',
        };
        this.write({ ...current, ...updates });
    }
}
