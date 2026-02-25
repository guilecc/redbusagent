import React, { useState } from 'react';
import { Terminal, Copy, CheckCircle2, Globe, Shield, MessageSquare, Database, Skull, Play, Brain, Camera, UserCircle } from 'lucide-react';
import { Changelog } from './components/Changelog';

function App() {
    const [copiedMac, setCopiedMac] = useState(false);
    const [copiedWin, setCopiedWin] = useState(false);

    const baseUrl = import.meta.env.VITE_INSTALL_BASE_URL || 'https://redbus.pages.dev';
    const macCommand = `curl -fsSL ${baseUrl}/install.sh | bash`;
    const winCommand = `irm ${baseUrl}/install.ps1 | iex`;

    const copyToClipboard = async (text: string, isMac: boolean) => {
        try {
            await navigator.clipboard.writeText(text);
            if (isMac) {
                setCopiedMac(true);
                setTimeout(() => setCopiedMac(false), 2000);
            } else {
                setCopiedWin(true);
                setTimeout(() => setCopiedWin(false), 2000);
            }
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    return (
        <div className="min-h-screen bg-black text-white font-sans selection:bg-red-600/40">
            {/* Brutalist Navbar */}
            <nav className="fixed top-0 w-full z-50 border-b-2 border-white/10 bg-black">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-red-600 flex items-center justify-center font-bold text-xl text-black rotate-[-5deg]">
                            R
                        </div>
                        <span className="font-bold text-2xl tracking-tighter uppercase">Redbus</span>
                    </div>
                    <div className="flex items-center space-x-6 text-sm font-bold uppercase text-white/50">
                        <a href="https://github.com/guilecc/redbusagent" target="_blank" rel="noreferrer" className="hover:text-red-500 transition-colors">GitHub</a>
                        <a href="#features" className="hover:text-red-500 transition-colors">Features</a>
                        <a href="#changelog" className="hover:text-red-500 transition-colors">Logs</a>
                    </div>
                </div>
            </nav>

            <main className="relative pt-40 pb-20 overflow-hidden">
                {/* Aggressive Red Splatter Background */}
                <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-red-600/10 rounded-full blur-[150px] pointer-events-none"></div>

                <div className="max-w-5xl mx-auto px-6 text-center space-y-10 relative z-10">
                    <h1 className="text-6xl md:text-8xl font-black tracking-tighter uppercase leading-[0.9]">
                        Yeah, another<br />
                        <span className="text-red-600 line-through decoration-white/30 mr-4">moltbot</span>
                        <span className="text-red-600 line-through decoration-white/30 mr-4">openclaw</span><br />
                        <span className="text-white">fuckingclaw.</span>
                    </h1>
                    <div className="space-y-4">
                        <p className="text-2xl md:text-3xl font-medium tracking-tight text-white/80 max-w-3xl mx-auto">
                            Just the stuff I actually like, powered by a smart heuristic router that balances local and cloud models so you don't burn all your cash.
                        </p>
                        <p className="text-lg md:text-xl font-medium tracking-tight text-white/50 max-w-2xl mx-auto">
                            Yeah, it's an imitation, but I built this shit from absolute scratch.
                        </p>
                    </div>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-6 pt-12">
                        {/* Command Box 1 */}
                        <div className="bg-black border-2 border-white/10 hover:border-red-600 p-6 w-full max-w-lg text-left transition-all duration-300 relative group group-hover:-translate-y-1">
                            <div className="absolute -top-3 -left-3 bg-red-600 text-black text-xs font-bold uppercase px-2 py-1 rotate-[-5deg]">
                                macOS / Linux
                            </div>
                            <div className="flex mt-2 bg-white/5 border border-white/10 p-4 items-center justify-between font-mono text-sm cursor-pointer hover:bg-white/10 transition-colors" onClick={() => copyToClipboard(macCommand, true)}>
                                <code className="text-white mr-2 break-all">$ {macCommand}</code>
                                <button className="text-red-500 hover:text-white flex-shrink-0 transition-colors">
                                    {copiedMac ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                                </button>
                            </div>
                        </div>

                        {/* Command Box 2 */}
                        <div className="bg-black border-2 border-white/10 hover:border-red-600 p-6 w-full max-w-lg text-left transition-all duration-300 relative group group-hover:-translate-y-1">
                            <div className="absolute -top-3 -left-3 bg-white text-black text-xs font-bold uppercase px-2 py-1 rotate-[-5deg]">
                                Windows
                            </div>
                            <div className="flex mt-2 bg-white/5 border border-white/10 p-4 items-center justify-between font-mono text-sm cursor-pointer hover:bg-white/10 transition-colors" onClick={() => copyToClipboard(winCommand, false)}>
                                <code className="text-gray-400 mr-2 break-all">PS&gt; {winCommand}</code>
                                <button className="text-red-500 hover:text-white flex-shrink-0 transition-colors">
                                    {copiedWin ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </main>

            <section id="features" className="py-32 border-t-2 border-white/10 bg-black relative z-10">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="mb-20">
                        <h2 className="text-5xl md:text-6xl font-black tracking-tighter uppercase border-l-8 border-red-600 pl-6">
                            No Bullshit.<br />Just Features.
                        </h2>
                    </div>

                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                        <FeatureCard
                            icon={<Terminal size={28} strokeWidth={2.5} />}
                            title="Full System Shell"
                            desc="Reads, writes, executes. Bash or PowerShell. A built-in security gate intercepts sensitive system commands and explicitly asks your authorization."
                        />
                        <FeatureCard
                            icon={<MessageSquare size={28} strokeWidth={2.5} />}
                            title="WhatsApp Bridge"
                            desc="Control your dev machine from your phone on the shitter. Background daemon keeps the session alive natively."
                        />
                        <FeatureCard
                            icon={<Globe size={28} strokeWidth={2.5} />}
                            title="Browser & MCP"
                            desc="Headless Playwright interaction out of the box, plus full native support for Universal Model Context Protocol (MCP) servers like Scrapling."
                        />
                        <FeatureCard
                            icon={<Database size={28} strokeWidth={2.5} />}
                            title="MemGPT-Style Engine"
                            desc="Integrated LanceDB on-disk vector DB with dynamic core memory management. It actually remembers what the fuck you did yesterday."
                        />
                        <FeatureCard
                            icon={<Shield size={28} strokeWidth={2.5} />}
                            title="AES-256 Vault"
                            desc="Your API keys, encrypted locally. Nothing goes out. Pure paranoia mode."
                        />
                        <FeatureCard
                            icon={<Play size={28} strokeWidth={2.5} />}
                            title="Cognitive Router"
                            desc="Don't burn Anthropic tokens on stupid questions. The heuristic router analyzes complexity in real-time: simple tasks run free on local models, complex coding drops to the Cloud."
                        />
                        <FeatureCard
                            icon={<Brain size={28} strokeWidth={2.5} />}
                            title="Knowledge Distillation"
                            desc="The local Ollama model actively learns from Claude and Gemini. High-value cloud responses are captured and injected as few-shot memory for on-the-fly cognitive upgrades without fine-tuning."
                        />
                        <FeatureCard
                            icon={<Camera size={28} strokeWidth={2.5} />}
                            title="Multimodal Vision"
                            desc="Playwright doesn't just read the DOM anymore. The agent takes full-page Base64 screenshots and sends them to Tier 2 models for visual debugging and true contextual understanding."
                        />
                        <FeatureCard
                            icon={<UserCircle size={28} strokeWidth={2.5} />}
                            title="Dynamic Personas"
                            desc="No hardcoded system prompts. Define the agent's name, context, and operational behavior on the fly during onboarding. The persona lives in the vault and dictates everything."
                        />
                    </div>
                </div>
            </section>

            {/* Changelog Section */}
            <Changelog />

            {/* Footer */}
            <footer className="border-t-2 border-white/10 py-16 text-center bg-black">
                <div className="w-16 h-16 mx-auto mb-6 bg-white text-black flex items-center justify-center font-bold rotate-12">
                    <Skull size={32} />
                </div>
                <p className="text-white/40 font-bold uppercase tracking-widest text-sm mb-2">Deal with it.</p>
                <p className="text-white/20 text-xs">© {new Date().getFullYear()} Redbus Agent.</p>
            </footer>
        </div>
    );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
    return (
        <div className="p-8 border-2 border-white/10 bg-[#050505] hover:bg-[#0a0a0a] hover:border-red-600 transition-all duration-300 group">
            <div className="w-14 h-14 bg-white/5 border border-white/10 flex items-center justify-center text-white mb-6 group-hover:bg-red-600 group-hover:border-red-600 group-hover:text-black transition-all">
                {icon}
            </div>
            <h3 className="text-2xl font-black uppercase mb-3 text-white tracking-tight">{title}</h3>
            <p className="text-white/50 font-medium leading-relaxed">
                {desc}
            </p>
        </div>
    )
}

export default App;
