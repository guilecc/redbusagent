/**
 * @redbusagent/daemon — Memory Manager (Organic RAG)
 *
 * Implements an embedded vector database using LanceDB and zero-config local
 * embeddings via the Ollama Manager. This provides long-term deterministic
 * memory partitioned by category (namespace).
 *
 * Enhanced with:
 * - Metadata per record (id, createdAt, contentHash) for traceability
 * - Content-hash deduplication to prevent redundant storage
 * - Cross-category semantic search (searchAllCategories)
 * - Memory deletion by semantic match (forgetMemory)
 * - Rich Cognitive Map with counts, timestamps, and descriptions
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';
import { Vault } from '@redbusagent/shared';
import { OllamaManager } from './ollama-manager.js';

// ─── Types ────────────────────────────────────────────────────────

export interface CognitiveMapEntry {
    category: string;
    description: string;
    memoryCount: number;
    lastUpdated: string;
}

export interface MemorizeResult {
    stored: boolean;
    duplicate: boolean;
}

export interface CrossCategoryResult {
    category: string;
    content: string;
    distance: number;
}

// ─── Memory Manager ───────────────────────────────────────────────

export class MemoryManager {
    static get memoryDir(): string {
        const dir = join(Vault.dir, 'memory');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    static get cognitiveMapPath(): string {
        return join(Vault.dir, 'cognitive-map.json');
    }

    // ─── Helpers ──────────────────────────────────────────────────

    /** Normalizes a raw category name into a safe table key. */
    private static normalizeCategory(raw: string): string {
        let cat = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        return cat || 'general';
    }

    /** Produces a truncated SHA-256 hash for content deduplication. */
    private static hashContent(content: string): string {
        return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').slice(0, 16);
    }

    /**
     * Vectorizes text into an embedding vector.
     *
     * Waterfall strategy:
     *  1. Try local Ollama (nomic-embed-text) — fast, free, no API costs
     *  2. Fall back to cloud embedding APIs if configured (OpenAI, Google)
     *  3. Throw a clear error if nothing is available
     */
    static async generateEmbedding(text: string): Promise<number[]> {
        // 1. Try Ollama first (may not be running in cloud-only setups)
        try {
            const ollamaResult = await this.generateEmbeddingViaOllama(text);
            return ollamaResult;
        } catch (ollamaErr) {
            console.warn(`  🧠 ⚠️ Ollama embedding failed (${(ollamaErr as Error).message}), trying cloud fallback...`);
        }

        // 2. Cloud fallback: use the configured provider's embedding API
        const config = Vault.read();
        const liveProvider = config?.live_engine?.provider;
        const liveApiKey = config?.live_engine?.apiKey;

        // Try OpenAI embeddings
        if ((liveProvider === 'openai' && liveApiKey) || config?.tier2?.provider === 'openai') {
            const apiKey = liveProvider === 'openai' ? liveApiKey : config?.tier2?.apiKey;
            if (apiKey) {
                try {
                    return await this.generateEmbeddingViaOpenAI(text, apiKey);
                } catch (e) {
                    console.warn(`  🧠 ⚠️ OpenAI embedding failed: ${(e as Error).message}`);
                }
            }
        }

        // Try Google embeddings
        if ((liveProvider === 'google' && liveApiKey) || config?.tier2?.provider === 'google') {
            const apiKey = liveProvider === 'google' ? liveApiKey : config?.tier2?.apiKey;
            if (apiKey) {
                try {
                    return await this.generateEmbeddingViaGoogle(text, apiKey);
                } catch (e) {
                    console.warn(`  🧠 ⚠️ Google embedding failed: ${(e as Error).message}`);
                }
            }
        }

        // Try Anthropic → use Voyage AI embeddings (Anthropic's recommended partner)
        // If no dedicated embedding provider available, try OpenAI with whatever key
        // we can find as a last resort
        if (liveProvider === 'anthropic' && liveApiKey) {
            // Anthropic doesn't have its own embedding API — check if we have
            // any fallback API key (Google from Tier 2, etc.)
            const googleKey = config?.tier2?.provider === 'google' ? config.tier2.apiKey : undefined;
            if (googleKey) {
                try {
                    return await this.generateEmbeddingViaGoogle(text, googleKey);
                } catch (e) {
                    console.warn(`  🧠 ⚠️ Google (fallback for Anthropic) embedding failed: ${(e as Error).message}`);
                }
            }
        }

        throw new Error(
            'No embedding provider available. Either start Ollama locally or configure an OpenAI/Google API key. ' +
            'Run: redbus config'
        );
    }

    /** Ollama local embedding (nomic-embed-text) */
    private static async generateEmbeddingViaOllama(text: string): Promise<number[]> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

        try {
            const res = await fetch(`${OllamaManager.baseUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'nomic-embed-text',
                    prompt: text,
                    keep_alive: '60m',
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                throw new Error(`Ollama returned ${res.status}: ${res.statusText}`);
            }

            const data = await res.json() as { embedding: number[] };
            return data.embedding;
        } finally {
            clearTimeout(timeout);
        }
    }

    /** OpenAI-compatible embedding API */
    private static async generateEmbeddingViaOpenAI(text: string, apiKey: string): Promise<number[]> {
        console.log('  🧠 ☁️ Using OpenAI embedding API...');
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text,
            }),
        });

        if (!res.ok) {
            throw new Error(`OpenAI embedding API returned ${res.status}: ${res.statusText}`);
        }

        const data = await res.json() as { data: Array<{ embedding: number[] }> };
        return data.data[0]!.embedding;
    }

    /** Google Generative AI embedding API */
    private static async generateEmbeddingViaGoogle(text: string, apiKey: string): Promise<number[]> {
        console.log('  🧠 ☁️ Using Google embedding API...');
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: { parts: [{ text }] },
                }),
            },
        );

        if (!res.ok) {
            throw new Error(`Google embedding API returned ${res.status}: ${res.statusText}`);
        }

        const data = await res.json() as { embedding: { values: number[] } };
        return data.embedding.values;
    }

    // ─── Core CRUD ────────────────────────────────────────────────

    /**
     * Stores a new memory vector in the given category.
     * Returns { stored, duplicate } — duplicate is true when an identical
     * content hash already exists, preventing redundant writes.
     */
    static async memorize(rawCategory: string, content: string): Promise<MemorizeResult> {
        const category = this.normalizeCategory(rawCategory);
        const db = await lancedb.connect(this.memoryDir);

        console.log(`  🧠 💾 Memorizing into category "${category}" (from "${rawCategory}")...`);
        const vector = await this.generateEmbedding(content);
        const contentHash = this.hashContent(content);
        const record = [{
            vector,
            content,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            contentHash,
        }];

        const tableNames = await db.tableNames();

        if (tableNames.includes(category)) {
            const table = await db.openTable(category);
            // Dedup check: search for nearest match and compare hash
            const nearest = await table.search(vector).limit(1).toArray();
            if (nearest.length > 0 && (nearest[0] as any).contentHash === contentHash) {
                console.log(`  🧠 ⏭️ Duplicate detected in "${category}", skipping.`);
                return { stored: false, duplicate: true };
            }
            await table.add(record);
        } else {
            await db.createTable(category, record);
        }

        this.registerCognitiveMapCategory(category);
        console.log(`  🧠 ✅ Memorized block in "${category}".`);
        return { stored: true, duplicate: false };
    }

    /**
     * Semantically searches the memory vector timeline for a given query.
     */
    static async searchMemory(rawCategory: string, query: string, limit = 5): Promise<string[]> {
        const category = this.normalizeCategory(rawCategory);
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
     * Searches ALL known memory categories simultaneously.
     * Returns results ranked globally by cosine distance.
     */
    static async searchAllCategories(query: string, limit = 5): Promise<CrossCategoryResult[]> {
        const categories = this.getCognitiveMap();
        if (categories.length === 0) return [];

        const vector = await this.generateEmbedding(query);
        const db = await lancedb.connect(this.memoryDir);
        const tableNames = await db.tableNames();

        const searchPromises = categories
            .filter(cat => tableNames.includes(cat))
            .map(async (cat) => {
                try {
                    const table = await db.openTable(cat);
                    const results = await table.search(vector).limit(limit).toArray();
                    return results.map((r: any) => ({
                        category: cat,
                        content: r.content as string,
                        distance: r._distance as number,
                    }));
                } catch { return []; }
            });

        const allResults = (await Promise.all(searchPromises)).flat();
        return allResults.sort((a, b) => a.distance - b.distance).slice(0, limit);
    }

    /**
     * Deletes memories that semantically match the given content.
     * Uses vector search to find near-exact matches (cosine distance < 0.15),
     * then reconstructs the table without them.
     */
    static async forgetMemory(rawCategory: string, contentMatch: string): Promise<number> {
        const category = this.normalizeCategory(rawCategory);
        const db = await lancedb.connect(this.memoryDir);
        const tableNames = await db.tableNames();
        if (!tableNames.includes(category)) return 0;

        const table = await db.openTable(category);
        const vector = await this.generateEmbedding(contentMatch);
        const matches = await table.search(vector).limit(5).toArray();

        // Filter to high-similarity matches only (cosine distance < 0.15)
        const toDelete = matches.filter((r: any) => r._distance < 0.15);
        if (toDelete.length === 0) return 0;

        const deleteContents = new Set(toDelete.map((r: any) => r.content));
        console.log(`  🧠 🗑️ Forgetting ${toDelete.length} memory(ies) from "${category}"...`);

        // Reconstruct the table without the matched rows
        const allRows = await table.search(vector).limit(100000).toArray();
        const remaining = allRows.filter((r: any) => !deleteContents.has(r.content));

        await db.dropTable(category);
        if (remaining.length > 0) {
            await db.createTable(category, remaining.map((r: any) => ({
                vector: Array.from(r.vector),
                content: r.content,
                id: r.id ?? randomUUID(),
                createdAt: r.createdAt ?? new Date().toISOString(),
                contentHash: r.contentHash ?? this.hashContent(r.content),
            })));
        } else {
            // Category is now empty — remove from cognitive map
            this.removeCognitiveMapCategory(category);
        }

        console.log(`  🧠 ✅ Forgot ${toDelete.length} memory(ies) from "${category}".`);
        return toDelete.length;
    }

    // ─── Cognitive Map ────────────────────────────────────────────

    /**
     * Returns all known memory categories as a flat string array.
     * (Backward-compatible — used by AutoRAG and legacy consumers.)
     */
    static getCognitiveMap(): string[] {
        if (!existsSync(this.cognitiveMapPath)) {
            return [];
        }
        try {
            const data = JSON.parse(readFileSync(this.cognitiveMapPath, 'utf-8'));
            // Handle both legacy (string[]) and rich (CognitiveMapEntry[]) formats
            if (Array.isArray(data)) {
                if (data.length === 0) return [];
                if (typeof data[0] === 'string') return data;
                return data.map((e: CognitiveMapEntry) => e.category);
            }
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Returns the enriched Cognitive Map with metadata per category.
     */
    static getCognitiveMapRich(): CognitiveMapEntry[] {
        if (!existsSync(this.cognitiveMapPath)) return [];
        try {
            const data = JSON.parse(readFileSync(this.cognitiveMapPath, 'utf-8'));
            if (!Array.isArray(data) || data.length === 0) return [];
            // Backward compat: convert legacy string[] → CognitiveMapEntry[]
            if (typeof data[0] === 'string') {
                return data.map((cat: string) => ({
                    category: cat,
                    description: '',
                    memoryCount: 0,
                    lastUpdated: '',
                }));
            }
            return data;
        } catch { return []; }
    }

    /**
     * Registers or updates a category in the Cognitive Map with rich metadata.
     */
    private static registerCognitiveMapCategory(category: string, description?: string): void {
        const map = this.getCognitiveMapRich();
        const existing = map.find(e => e.category === category);
        if (existing) {
            existing.memoryCount++;
            existing.lastUpdated = new Date().toISOString();
            if (description) existing.description = description;
        } else {
            map.push({
                category,
                description: description ?? '',
                memoryCount: 1,
                lastUpdated: new Date().toISOString(),
            });
        }
        writeFileSync(this.cognitiveMapPath, JSON.stringify(map, null, 2), 'utf-8');
    }

    /**
     * Removes a category from the Cognitive Map (used when all memories are deleted).
     */
    private static removeCognitiveMapCategory(category: string): void {
        const map = this.getCognitiveMapRich().filter(e => e.category !== category);
        writeFileSync(this.cognitiveMapPath, JSON.stringify(map, null, 2), 'utf-8');
    }
}
