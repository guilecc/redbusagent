/**
 * @redbusagent/daemon — Heuristic Complexity Engine
 * 
 * Synchronous scoring engine to calculate the complexity of a prompt
 * to determine whether to route to Live Engine or Worker Engine (Cloud).
 */

export type TaskIntent = 'INTENT_FORGE' | 'INTENT_EXECUTE';

export function classifyTaskIntent(prompt: string): TaskIntent {
    const lowerPrompt = prompt.toLowerCase();

    const forgeRegex = /\b(create a(?:n)? (?:tool|script|routine|automation|app|application|integration)|write a(?:n)? (?:script|code|tool)|code|forge|refactor|build a(?:n)? (?:integration|tool|routine|app|script)|write code|modify architecture|edit_file_blocks|edit file|change line|automate|automaton|crie uma rotina|cria uma rotina|criar uma rotina|crie um script|criar um script|cria um script|crie uma automação|criar uma automação|cria uma automação|faça um script|fazer um script|fazer uma rotina|faça uma rotina|desenvolva|desenvolver|programe|programar|crie um código|cria um código|criar um código|construa|construir|worker|delegue|elaborar|elabore|gerar|gere|implementar|implemente|agende|agendar|schedule|diariamente|todo dia|every day|daily|cron|tarefa agendada|background task)\b/i;

    if (forgeRegex.test(lowerPrompt)) {
        return 'INTENT_FORGE';
    }

    return 'INTENT_EXECUTE';
}

export function calculateComplexityScore(prompt: string, recentHistory: any[] = []): number {
    let score = 0;
    const lowerPrompt = prompt.toLowerCase();

    // Length Factor (+0 to +15)
    const lengthScore = Math.min(15, Math.floor((lowerPrompt.length / 300) * 15));
    score += lengthScore;

    const codingRegex = /\b(edit|change line|replace|modify|code|script|function|api|regex|docker|bash|shell|schedule|cron|bug|error|refactor|deploy|compile|database|sql|query|optimize|git|commit|merge|architecture|endpoint|json|yaml|forge|build|fix|server|infrastructure|terminal|command|automate|integrate|integration|task|tasks|timer|alarm|alert|remind|remember|register|minutes|hours|edite|editar|modifique|modificar|código|função|automatize|automatizar|integração|servidor|banco de dados|alarme|alerta|lembre|lembrar|minutos|horas|agende|agendar|agendamento|marque|marcar|rode|rodar|execute|executar|diário|diariamente|semanal|semanalmente|mensal|mensalmente)\b/i;
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

    // Infrastructure & Subsystem Keywords (+40)
    // Catches MCP, memory ops, visual inspection, background processes — all require Worker Engine reasoning
    const infraRegex = /\b(mcp|plugin|install server|install plugin|background|monitor|visual|screenshot|inspect|layout|look at|memorize|remember|forget|archival|core.?memory|approval|protocol|memória|lembrar|esqueça|fundo|segundo plano)\b/i;
    if (infraRegex.test(lowerPrompt)) {
        score += 40;
    }

    // Analytical & Reasoning Keywords (+20)
    const analyticalRegex = /\b(analyze|summarize|compare|why|calculate|explain|evaluate|review|investigate|debug|troubleshoot|plan|design|architecture|logic|analise|resuma|compare|por|porque|que|calcule|explique|avalie|revise|investigue|depure|planeje|desenhe|arquitetura|lógica)\b/i;
    if (analyticalRegex.test(lowerPrompt)) {
        score += 20;
    }

    return Math.min(100, score);
}
