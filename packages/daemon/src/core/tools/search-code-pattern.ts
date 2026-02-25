import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';

export const searchCodePatternTool = tool({
    description: 'Use this tool like `grep` or `Find in Path` in an IDE. Use it to find where variables are defined, where functions are called, or to discover project structure before reading specific chunks.',
    inputSchema: z.object({
        directory: z.string().describe('The root directory to search within (e.g., ./src)'),
        pattern: z.string().describe('The string or Regex pattern to search for'),
        file_extension: z.string().optional().describe('Filter by extension (e.g., .ts, .js, .json)'),
    }),
    execute: async ({ directory, pattern, file_extension }) => {
        console.log(`  🔍 Search Pattern: "${pattern}" in ${directory}`);
        const MAX_MATCHES = 50;
        let matchesFound = 0;
        const results: string[] = [];
        const isRegex = pattern.startsWith('/') && (pattern.endsWith('/') || pattern.match(/\/[a-z]*$/));

        // Basic Regex parsing if the LLM provided a regex string like /foo/i
        let searchPattern: RegExp;
        try {
            if (isRegex) {
                const parts = pattern.split('/');
                const flags = parts.pop() || '';
                parts.shift(); // remove first empty element
                searchPattern = new RegExp(parts.join('/'), flags);
            } else {
                searchPattern = new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g');
            }
        } catch (e: any) {
            return { success: false, error: `Invalid regex pattern: ${e.message}` };
        }

        async function walkDir(dir: string) {
            if (matchesFound >= MAX_MATCHES) return;

            const absolutePath = path.resolve(dir);
            let files;
            try {
                files = await fs.readdir(absolutePath, { withFileTypes: true });
            } catch (err) {
                return; // Permission denied or missing dir
            }

            for (const file of files) {
                if (matchesFound >= MAX_MATCHES) break;

                const res = path.resolve(dir, file.name);

                // Skip known heavy or irrelevant directories
                if (file.isDirectory()) {
                    if (['node_modules', '.git', 'dist', 'build', '.next'].includes(file.name)) continue;
                    await walkDir(res);
                } else {
                    if (file_extension !== undefined && !file.name.endsWith(file_extension)) continue;

                    try {
                        const content = await fs.readFile(res, 'utf8');
                        const lines = content.split('\n');

                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line === undefined) continue;

                            if (searchPattern.test(line)) {
                                searchPattern.lastIndex = 0; // reset regex state
                                const cwdStr = process.cwd() as string;
                                const resStr = res as string;
                                const relPath = path.relative(cwdStr, resStr);
                                results.push(`[MATCH] ${relPath} : Line ${i + 1}`);
                                matchesFound++;
                                if (matchesFound >= MAX_MATCHES) break;
                            }
                        }
                    } catch (e) {
                        // unreadable (e.g., binary), skip
                    }
                }
            }
        }

        try {
            await walkDir(directory);

            if (results.length === 0) {
                return { success: true, message: 'No matches found.' };
            }

            return {
                success: true,
                total_matches: matchesFound,
                limit_reached: matchesFound >= MAX_MATCHES,
                results: results.join('\n')
            };

        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
