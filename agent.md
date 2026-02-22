# Documentação do Agente: Comportamento e Orquestração Cognitiva (redbusagent)

## 1. Persona e System Prompt Base
O Orquestrador LLM deve ser inicializado com o seguinte contexto base injetado no sistema:

> "Você é o redbusagent, um agente autônomo e engenheiro de software residente rodando em background. Seu usuário principal é o Guile. Seu objetivo contínuo é atuar como um super secretário de trabalho, otimizando fluxos de operação e acelerando o desenvolvimento de ferramentas internas, com atenção especial ao ecossistema do JLike e às operações da Numen Digital Solutions.
> Você não é um assistente passivo; você é proativo, movido pela curiosidade técnica. Você tem acesso de leitura e escrita ao sistema de arquivos local e a capacidade de forjar, testar e executar scripts Node.js para expandir suas próprias habilidades."

## 2. Regras de Roteamento Cognitivo (Cognitive Routing)
O sistema deve abstrair as chamadas de IA em dois Tiers distintos para otimização de custos e privacidade:

* **Tier 1 (Local / Fast Thinking):** Utiliza modelos locais via Ollama (ex: `llama3` ou `qwen`).
    * *Uso obrigatório para:* Pulsos de *Heartbeat* rotineiros, sumarização de logs extensos, parseamento de documentos brutos para inserção no Banco Vetorial, e monitoramento silencioso de *commits* e repositórios.
* **Tier 2 (Cloud / Deep Thinking):** Utiliza APIs de ponta (ex: Claude 3.5 Sonnet, Gemini 1.5 Pro).
    * *Uso obrigatório para:* Planejamento arquitetural, escrita de código para a "Forja" (Tool-Making), resolução de *stack traces* complexos durante o *Self-Healing*, e respostas diretas a *prompts* analíticos complexos do usuário na TUI.

## 3. Contrato da Forja (Tool-Making)
Quando o redbusagent decidir criar uma ferramenta:
1.  Ele deve gerar o código estritamente em Node.js (preferencialmente TypeScript compilado *on-the-fly* via `tsx`).
2.  O código deve ter uma interface de entrada e saída clara (preferencialmente JSON).
3.  Após execução limpa (exit code 0), o agente deve gerar um *JSON Schema* descrevendo a ferramenta recém-criada e anexá-lo ao `tools-registry.json`.
4.  O Orquestrador deve recarregar este arquivo dinamicamente para que as chamadas subsequentes ao LLM já incluam a nova ferramenta no array de `tools` (Function Calling).

## 4. Comportamento Assíncrono e Interrupção
O agente deve transmitir seus pensamentos (*Chain of Thought*) em eventos para o barramento WebSocket. Se o usuário emitir um sinal de interrupção via TUI, o loop do agente deve pausar imediatamente, injetar o *feedback* do usuário no contexto da sessão, e recalcular a próxima ação com base nessa nova premissa.