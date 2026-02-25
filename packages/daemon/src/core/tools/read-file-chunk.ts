import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';

export const readFileChunkTool = tool({
    description: 'Use this tool to read a specific chunk of lines from a file. It returns the file content with line numbers prepended. ALWAYS read files in chunks to avoid overwhelming your context window.',
    inputSchema: z.object({
        filepath: z.string().describe('The absolute or relative path to the file to read.'),
        start_line: z.number().describe('The line number to start reading from (1-indexed).'),
        end_line: z.number().describe('The line number to stop reading at (inclusive).')
    }),
    execute: async ({ filepath, start_line, end_line }) => {
        console.log(`  📄 Read File Chunk: ${filepath} [${start_line}-${end_line}]`);
        try {
            const absolutePath = path.resolve(filepath);
            const content = await fs.readFile(absolutePath, 'utf8');
            const lines = content.split('\n');

            // Handle invalid ranges gracefully while mapping to 0-indexed array
            const actualStart = Math.max(1, start_line);
            const actualEnd = Math.min(lines.length, end_line);

            if (actualStart > actualEnd || actualStart > lines.length) {
                return { success: false, error: `Invalid line range: [${start_line}-${end_line}]. File has ${lines.length} lines.` };
            }

            const chunk = lines.slice(actualStart - 1, actualEnd);

            const numberedChunk = chunk.map((line, index) => {
                const lineNumber = actualStart + index;
                return `${lineNumber}: ${line}`;
            }).join('\n');

            return {
                success: true,
                total_lines: lines.length,
                displayed_range: `[${actualStart}-${actualEnd}]`,
                content: numberedChunk
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
