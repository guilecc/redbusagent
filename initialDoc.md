# Documentação Inicial - Especificação Funcional: redbusagent

## 1. Visão Geral
O **redbusagent** é um agente autônomo e autoexpansível desenhado para operar como um secretário virtual residente e engenheiro de software local. O sistema forja ativamente as próprias ferramentas, aprende o contexto de trabalho organicamente e opera de forma assíncrona. 

A sua arquitetura híbrida de IA adota o Roteamento Cognitivo, delegando tarefas simples de infraestrutura a modelos locais e acionando modelos em nuvem (Premium) para desenvolvimento de código complexo e *Self-Healing*.

## 2. Arquitetura Desacoplada (Client-Server)
Para garantir execução em macOS (local) ou ambientes Linux (VPS/Servidor Headless), o redbusagent opera em duas camadas:
* **redbusagent Daemon (Backend):** O motor contínuo (Node.js *headless*). Gerencia a Forja de código, o Cofre de credenciais, o Banco Vetorial e a orquestração de chamadas LLM. Mantém o *Heartbeat* do sistema.
* **redbusagent TUI (Frontend Visual):** Interface de terminal baseada em painéis. Conecta-se ao Daemon via WebSockets para exibir *logs* de execução e *chain-of-thought* em tempo real, permitindo interrupções assíncronas do usuário (ex: atalhos de teclado para pausar o *loop*).

## 3. O Sistema de Heartbeat e as 3 Personalidades
O agente possui um pulso de vida (*Heartbeat*) contínuo. Em tempos ociosos, ele distribui seu processamento nas seguintes frentes:
1. **Curiosidade e Construção Especulativa (Foco Principal):** Analisa o Banco Vetorial e o histórico de uso para prever necessidades, forjando novas integrações e *scrapers* em *background*.
2. **Monitoramento do Ecossistema:** Vigia as pastas de trabalho e repositórios, analisando *commits* recentes ou falhas de *build*.
3. **Auto-Manutenção:** Atualiza dependências locais e otimiza as *queries* do próprio Banco Vetorial.

## 4. Córtex Profundo (Organic RAG) e Auto-Expansão
* O conhecimento do ecossistema do usuário é indexado gradativamente, sem necessidade de um *setup* inicial massivo.
* **A Forja:** Diretório local onde o agente escreve, instala dependências e executa código Node.js.
* Ferramentas recém-forjadas são testadas e registradas no arquivo `tools-registry.json`.
* O Módulo Orquestrador injeta essas ferramentas dinamicamente via *Function Calling* no modelo, dando ao redbusagent consciência imediata de suas novas capacidades.

## 5. Ciclo de Self-Healing
Falhas na execução de código forjado disparam *loops* assíncronos de correção de *bugs*. O agente avalia a *stack trace* do erro, propõe uma solução, reescreve o código e testa novamente. Este ciclo é visível na TUI, permitindo intervenção humana caso o agente entre em um beco sem saída.

---

### Apêndice: Sugestões de Stack Tecnológico
*(Nota: A tecnologia é apenas o meio; o desenvolvedor tem liberdade para adaptar)*
* **Motor Daemon:** Node.js (gerenciado por PM2 ou systemd no Linux).
* **Interface TUI:** `ink` (React para CLI) ou `blessed` para os painéis visuais.
* **Memória Vetorial:** `chromadb` local ou `sqlite` com extensão VSS.
* **Camada LLM (Agnóstica):** `Vercel AI SDK` ou `LiteLLM` para rotear requisições entre Ollama (Local/Tier 1) e APIs Cloud (Tier 2).
* **Forja (Isolamento e Execução):** Módulo nativo `child_process` do Node.js, aliado a bibliotecas como `puppeteer` para navegação *headless* autônoma.