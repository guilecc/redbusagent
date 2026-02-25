import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';

export const editFileBlocksTool = tool({
    description: 'Use this tool to perform surgical code edits on an existing file by exactly replacing a block of code with a new block. DO NOT recreate entire files if you just need to edit them. ALWAYS provide the strictly exact current lines in `search_block`.',
    inputSchema: z.object({
        filepath: z.string().describe('The absolute or relative path to the file to edit.'),
        search_block: z.string().describe('The EXACT existing multiline string of code that needs to be replaced. MUST match indentation and line endings perfectly.'),
        replace_block: z.string().describe('The new multiline string of code that will replace the search_block.')
    }),
    execute: async ({ filepath, search_block, replace_block }) => {
        console.log(`  🛠️ Surgical Edit: ${filepath}`);

        try {
            const absolutePath = path.resolve(filepath);
            let content = await fs.readFile(absolutePath, 'utf8');

            if (!content.includes(search_block)) {
                return {
                    success: false,
                    error: "Error: The search_block was not found exactly as provided. Please use the read_file_chunk tool to check the exact current indentation and content, then try again."
                };
            }

            content = content.replace(search_block, replace_block);

            await fs.writeFile(absolutePath, content, 'utf8');

            return {
                success: true,
                message: "File successfully updated."
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
