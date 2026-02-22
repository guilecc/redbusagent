/**
 * @redbusagent/daemon — Memory Manager (Organic RAG)
 *
 * Implements an embedded vector database using LanceDB and zero-config local
 * embeddings via the Ollama Manager. This provides long-term deterministic
 * memory partitioned by category (namespace).
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { Vault } from '@redbusagent/shared';
import { OllamaManager } from './ollama-manager.js';

export class MemoryManager {
    static get memoryDir(): string {
        const dir = join(Vault.dir, 'memory');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    static get cognitiveMapPath(): string {
        return join(Vault.dir, 'cognitive-map.json');
    }

    /**
     * Vectorizes text using the local `nomic-embed-text` model via Ollama.
     */
    static async generateEmbedding(text: string): Promise<number[]> {
        const res = await fetch(`${OllamaManager.baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'nomic-embed-text',
                prompt: text,
            }),
        });

        if (!res.ok) {
            throw new Error(`Failed to generate embedding: ${res.statusText}`);
        }

        const data = await res.json() as { embedding: number[] };
        return data.embedding;
    }

    /**
     * Stores a new memory vector in the given category.
     */
    static async memorize(rawCategory: string, content: string): Promise<void> {
        let category = rawCategory.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (!category) category = 'general';
        const db = await lancedb.connect(this.memoryDir);

        console.log(`  🧠 💾 Memorizing into category "${category}" (from "${rawCategory}")...`);
        const vector = await this.generateEmbedding(content);
        const record = [{ vector, content }];

        const tableNames = await db.tableNames();

        if (tableNames.includes(category)) {
            const table = await db.openTable(category);
            await table.add(record);
        } else {
            await db.createTable(category, record);
            this.registerCognitiveMapCategory(category);
        }

        console.log(`  🧠 ✅ Memorized block in "${category}".`);
    }

    /**
     * Semantically searches the memory vector timeline for a given query.
     */
    static async searchMemory(rawCategory: string, query: string, limit = 5): Promise<string[]> {
        let category = rawCategory.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (!category) category = 'general';
        const db = await lancedb.connect(this.memoryDir);
        const tableNames = await db.tableNames();

        if (!tableNames.includes(category)) {
            return []; // Category does not exist yet
        }

        console.log(`  🧠 🔍 Searching memory in category "${category}" for query...`);
        const vector = await this.generateEmbedding(query);
        const table = await db.openTable(category);

        const results = await table.search(vector).limit(limit).toArray();

        // Return only the text contents
        return results.map((r: any) => r.content as string).filter(Boolean);
    }

    /**
     * Returns all known memory categories.
     */
    static getCognitiveMap(): string[] {
        if (!existsSync(this.cognitiveMapPath)) {
            return [];
        }
        try {
            const data = JSON.parse(readFileSync(this.cognitiveMapPath, 'utf-8'));
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    private static registerCognitiveMapCategory(category: string): void {
        const map = new Set(this.getCognitiveMap());
        if (!map.has(category)) {
            map.add(category);
            writeFileSync(this.cognitiveMapPath, JSON.stringify(Array.from(map), null, 2), 'utf-8');
        }
    }
}
