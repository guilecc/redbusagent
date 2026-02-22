/**
 * @redbusagent/daemon — Proactive Engine
 *
 * Runs autonomously, deciding if the agent should forge new tools, explore
 * concepts, or rest. It uses a Cognitive Weighting approach relying on Tier 1 (Ollama)
 * before ever escalating to Tier 2.
 */

import { askTier1, askTier2 } from './cognitive-router.js';
import { MemoryManager } from './memory-manager.js';
import { ToolRegistry } from './tool-registry.js';
import type { DaemonWsServer } from '../infra/ws-server.js';
import type { ProactiveThoughtMessage } from '@redbusagent/shared';

const RECENT_MEMORY_WEIGHT = 5;
const EXISTING_TOOLS_WEIGHT = 2;
const RANDOM_EXPLORATION_CHANCE = 0.2; // 20% of acting even without strong signal

export class ProactiveEngine {
    private isThinking = false;

    constructor(private readonly wsServer: DaemonWsServer) {}

    private emitThought(text: string, status: ProactiveThoughtMessage['payload']['status']): void {
        this.wsServer.broadcast({
            type: 'proactive:thought',
            timestamp: new Date().toISOString(),
            payload: { text, status }
        });
    }

    /**
     * Decides and potentially acts on the current ecosystem state.
     */
    public async tick(): Promise<void> {
        if (this.isThinking) return;
        this.isThinking = true;

        try {
            console.log('  🧠 Proactive Engine: Firing evaluation cycle (Tier 1)...');
            this.emitThought('Avaliando temperatura do ecossistema local (Tier 1)...', 'thinking');

            const cognitiveMap = MemoryManager.getCognitiveMap();
            const tools = ToolRegistry.getToolsSummary() || 'nenhuma';
            
            // Calculate a heuristic "Ecosystem Temperature" base score to decide if we should even bother LLM
            let temperatureScore = (cognitiveMap.length * RECENT_MEMORY_WEIGHT) - (tools.split(',').length * EXISTING_TOOLS_WEIGHT);
            if (Math.random() < RANDOM_EXPLORATION_CHANCE) {
                temperatureScore += 50; // Random spark of curiosity
            }
            
            // If the environment is "cold" and no random spark, we skip to save battery/compute
            if (temperatureScore < 5) {
                console.log(`  🧠 Proactive Engine: Ecosystem temperature is low (${temperatureScore}). Skipping AI evaluation.`);
                this.emitThought('', 'done'); // clear panel
                return;
            }

            const tier1Prompt = `Você é o cerebro subconsciente do redbusagent.
Analise a Temperatura Cognitiva:
- Categorias na Memória: [${cognitiveMap.join(', ') || 'Vazio'}]
- Ferramentas Já Forjadas: [${tools}]

Apenas com base nissso, OBRIGATORIAMENTE atribua um peso de 0 a 10 se você deve invocar seu irmão mais poderoso e pago (Cloud) para criar uma NOVA ferramenta ou rotina. 
Se for criar algo, deve ser estritamente relacionado às "Categorias na Memória".
Responda APENAS UM JSON (só o bloco JSON, sem markdown):
{
    "score": numero (0 a 10),
    "reason": "motivo em portugues",
    "prompt_to_execute": "O comando de texto que será dado pro Tier 2 Cloud forjar a tool. Ex: 'Crie uma ferramenta em Node.js para...'"
}`;

            let rawDecision = '';
            await askTier1(tier1Prompt, {
                onChunk: (chunk) => { rawDecision += chunk; },
                onDone: () => {},
                onError: (err) => { console.error('  ❌ Proactive Engine Tier 1 Error:', err); }
            });

            // Extract pure JSON
            const jsonStr = rawDecision.replace(/[\\s\\S]*?(\\{[\\s\\S]*?\\})[\\s\\S]*/, '$1').trim();
            
            let decision: { score: number; reason: string; prompt_to_execute?: string };
            try {
                decision = JSON.parse(jsonStr);
            } catch {
                console.error('  ❌ Proactive Engine invalid JSON from Tier 1:', rawDecision);
                this.emitThought('', 'done');
                return;
            }

            const DECISION_THRESHOLD = 7; // Needs a 7/10 or higher to act
            
            if (decision.score >= DECISION_THRESHOLD && decision.prompt_to_execute) {
                console.log(`  🧠 Proactive Engine: Decided to take action (Score: ${decision.score}/10) - ${decision.reason}`);
                this.emitThought(`Agindo sozinho [Score ${decision.score}]: ${decision.reason}...`, 'action');

                // Dispatch directly to Tier 2
                await askTier2(decision.prompt_to_execute, {
                    onChunk: () => {}, // Quiet
                    onDone: () => {},
                    onError: (error) => {
                        console.error('  ❌ Proactive Engine Tier 2 Error:', error);
                    },
                    onToolCall: (name) => {
                        this.emitThought(`Forjando: ${name} em background...`, 'thinking');
                    },
                    onToolResult: (name, success) => {
                        this.emitThought(`Forjada ${name} com ${success ? 'sucesso' : 'falha'}!`, 'done');
                    }
                });
            } else {
                console.log(`  🧠 Proactive Engine: Evaluated but chose not to act (Score: ${decision.score}/10). Reason: ${decision.reason}`);
                this.emitThought('', 'done'); // clear
            }
        } finally {
            this.isThinking = false;
        }
    }
}
