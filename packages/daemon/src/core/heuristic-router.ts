/**
 * @redbusagent/daemon — Heuristic Complexity Engine
 * 
 * Synchronous scoring engine to calculate the complexity of a prompt
 * to determine whether to route to Tier 1 (Local) or Tier 2 (Cloud).
 */

export function calculateComplexityScore(prompt: string, recentHistory: any[] = []): number {
    let score = 0;
    const lowerPrompt = prompt.toLowerCase();

    // Length Factor (+0 to +15)
    const lengthScore = Math.min(15, Math.floor((lowerPrompt.length / 300) * 15));
    score += lengthScore;

    // Coding & Infrastructure Keywords (+40)
    const codingRegex = /\b(edit|change line|replace|modify|editar|modificar|trocar|substituir|code|script|function|api|regex|docker|bash|shell|schedule|cron|bug|error|refactor|deploy|compile|database|sql|query|optimize|git|commit|merge|architecture|endpoint|json|yaml|forge|build|fix|crie|código|codar|função|erro|banco de dados|refatore|refatorar|otimizar|compilar|servidor|infraestrutura|terminal|comando|agendar|automatizar|conserte|integrar|integração|task|tasks|timer|alarme|aviso|lembrar|lembre|registre|minutos|horas)\b/i;
    if (codingRegex.test(lowerPrompt)) {
        score += 40;
    }

    // Contextual Dependency (+20): Code blocks or tool execution outputs in last 3 messages
    let recentContextScore = 0;
    const last3 = recentHistory.slice(-3);
    for (const msg of last3) {
        if (msg.role === 'assistant' || msg.role === 'user' || msg.role === 'system') {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg);
            if (content.includes('```') || content.includes('[System Tool Execution Result]')) {
                recentContextScore = 20;
                break;
            }
        }
    }
    score += recentContextScore;

    // Analytical & Reasoning Keywords (+20)
    const analyticalRegex = /\b(analyze|summarize|compare|why|calculate|explain|evaluate|review|investigate|debug|troubleshoot|plan|design|analise|analisar|resuma|resumir|compare|comparar|por que|porque|calcule|calcular|explique|explicar|avalie|avaliar|revise|revisar|mudar|arquitetura|lógica)\b/i;
    if (analyticalRegex.test(lowerPrompt)) {
        score += 20;
    }

    return Math.min(100, score);
}
