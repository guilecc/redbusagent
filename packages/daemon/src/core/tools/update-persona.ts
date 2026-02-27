import { tool } from 'ai';
import { z } from 'zod';
import { PersonaManager } from '@redbusagent/shared';

export const updatePersonaTool = tool({
    description: `Updates or merges new behavioral guidelines or identity changes into the agent's core persona. Use this when the user gives direct instructions about how you should behave, what your name is, or provides new personal context.`,
    inputSchema: z.object({
        new_guidelines: z.string().describe('The new instructions or persona updates to be merged into the existing configuration.'),
    }),
    execute: async (params: { new_guidelines: string }) => {
        try {
            // We use the Cloud/Worker Engine inside the tool to merge the guidelines if needed,
            // but for simplicity here we can just update the behavioral_guidelines field 
            // or even better, append to it. 
            // However, the requirement says "Overwrites or merges the new instructions into the persona.json file."

            const current = PersonaManager.read();
            if (current) {
                PersonaManager.write({
                    ...current,
                    behavioral_guidelines: `${current.behavioral_guidelines}\n${params.new_guidelines}`
                });
            } else {
                PersonaManager.write({
                    agent_name: 'Agent',
                    user_context: 'Unknown',
                    behavioral_guidelines: params.new_guidelines
                });
            }

            return { success: true, message: `Persona updated with new guidelines.` };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
