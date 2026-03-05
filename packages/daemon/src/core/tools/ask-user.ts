/**
 * @redbusagent/daemon — ask_user_for_input Tool
 *
 * Implements the "Yield & Ask" pattern: when the Worker Engine needs
 * information from the user (credentials, preferences, clarifications),
 * it calls this tool which SUSPENDS execution via a Promise. The daemon
 * broadcasts the question to the TUI/WhatsApp, and when the user responds,
 * the ChatHandler resolves the Promise, resuming the tool chain.
 *
 * Architecture:
 *   1. Worker Engine calls ask_user_for_input({ question: "..." })
 *   2. Tool creates a pending request in UserInputManager (singleton)
 *   3. UserInputManager emits 'question_asked' → ChatHandler relays to TUI
 *   4. Tool execution is suspended (Promise awaiting resolution)
 *   5. User types response in TUI → ChatHandler intercepts → resolves Promise
 *   6. Tool returns the user's response to the Worker Engine
 *   7. Worker Engine continues with the information
 */

import { tool } from 'ai';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { engineBus, type OrchestrationActor, type OrchestrationExecutionMode } from '../engine-message-bus.js';

// ─── User Input Manager (Singleton) ────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

interface PendingRequestOrchestrationContext {
    sessionId: string;
    taskId: string;
    mode: OrchestrationExecutionMode;
    actor: OrchestrationActor;
}

function getPendingRequestContext(): PendingRequestOrchestrationContext | null {
    const session = engineBus.getLatestActiveSession();
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        taskId: session.taskId,
        mode: session.mode,
        actor: session.activeActor,
    };
}

class UserInputManager extends EventEmitter {
    private pendingRequests = new Map<string, {
        resolve: (response: string) => void;
        question: string;
        timer: ReturnType<typeof setTimeout>;
        orchestration: PendingRequestOrchestrationContext | null;
    }>();

    /**
     * Request input from the user. Returns a Promise that resolves
     * with the user's response, or rejects on timeout.
     */
    requestInput(id: string, question: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
        return new Promise((resolve, reject) => {
            const orchestration = getPendingRequestContext();
            const timer = setTimeout(() => {
                const pending = this.pendingRequests.get(id);
                this.pendingRequests.delete(id);
                if (pending?.orchestration) {
                    engineBus.emitOrchestrationEvent({
                        type: 'resumed',
                        sessionId: pending.orchestration.sessionId,
                        taskId: pending.orchestration.taskId,
                        mode: pending.orchestration.mode,
                        actor: pending.orchestration.actor,
                        reason: 'User input request expired before a reply arrived.',
                        timestamp: Date.now(),
                    });
                }
                reject(new Error(`User did not respond within ${Math.round(timeoutMs / 1000)}s. The question was: "${question}". Try again later or rephrase the question.`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, question, timer, orchestration });
            if (orchestration) {
                engineBus.emitOrchestrationEvent({
                    type: 'yield_requested',
                    sessionId: orchestration.sessionId,
                    taskId: orchestration.taskId,
                    mode: orchestration.mode,
                    actor: orchestration.actor,
                    waitFor: 'awaiting_user_reply',
                    reason: question,
                    timestamp: Date.now(),
                });
            }
            this.emit('question_asked', { id, question });
        });
    }

    /**
     * Resolve a pending input request with the user's response.
     * Called by ChatHandler when the user's next message arrives.
     */
    resolveInput(id: string, response: string): boolean {
        const req = this.pendingRequests.get(id);
        if (req) {
            clearTimeout(req.timer);
            req.resolve(response);
            this.pendingRequests.delete(id);
            if (req.orchestration) {
                const timestamp = Date.now();
                engineBus.emitOrchestrationEvent({
                    type: 'user_reply_received',
                    sessionId: req.orchestration.sessionId,
                    taskId: req.orchestration.taskId,
                    mode: req.orchestration.mode,
                    actor: 'user',
                    replyPreview: response.slice(0, 200),
                    timestamp,
                });
                engineBus.emitOrchestrationEvent({
                    type: 'resumed',
                    sessionId: req.orchestration.sessionId,
                    taskId: req.orchestration.taskId,
                    mode: req.orchestration.mode,
                    actor: req.orchestration.actor,
                    reason: 'User reply received. Resume the current execution context.',
                    timestamp: timestamp + 1,
                });
            }
            return true;
        }
        return false;
    }

    /** Check if any questions are awaiting user response */
    hasPendingQuestions(): boolean {
        return this.pendingRequests.size > 0;
    }

    /** Get the first pending question ID */
    getFirstPendingId(): string | undefined {
        return this.pendingRequests.keys().next().value;
    }

    /** Get the question text for a pending request */
    getPendingQuestion(id: string): string | undefined {
        return this.pendingRequests.get(id)?.question;
    }
}

export const userInputManager = new UserInputManager();

// ─── The Tool ──────────────────────────────────────────────────────

export const askUserForInputTool = tool({
    description: `Suspend execution and ask the user a question. Use this when you need information that you cannot determine on your own — such as API keys, credentials, configuration preferences, deployment targets, or clarifications about ambiguous requirements.

WHEN TO USE:
- You need an API key, password, or token that is not in the Vault
- The user's request is ambiguous and you need clarification
- You need to confirm a destructive or irreversible action before proceeding
- You need the user to choose between multiple options

HOW IT WORKS:
1. You call this tool with your question
2. Execution PAUSES — the user sees your question in their terminal or WhatsApp
3. The user types their response
4. Execution RESUMES — you receive their answer as the tool result
5. Continue your work with the information

IMPORTANT: Be specific in your question. Instead of "I need credentials", ask "Please provide the API key for the OpenAI service (format: sk-...)".`,
    inputSchema: z.object({
        question: z.string().describe('The question to ask the user. Be specific and clear about what information you need and why.'),
    }),
    execute: async (args: { question: string }) => {
        const reqId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        console.log(`  ❓ [ask_user] Suspending execution. Question: "${args.question.slice(0, 80)}..."`);

        try {
            const response = await userInputManager.requestInput(reqId, args.question);
            console.log(`  ✅ [ask_user] User responded (${response.length} chars). Resuming execution.`);
            return {
                success: true,
                user_response: response,
            };
        } catch (error: any) {
            console.error(`  ❌ [ask_user] Timeout or error:`, error.message);
            return {
                success: false,
                error: error.message,
            };
        }
    },
});

