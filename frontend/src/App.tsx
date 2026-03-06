import React, { useState } from 'react';
import { Terminal, Copy, CheckCircle2, Shield, MessageSquare, Database, Brain, Eye, Server, Zap, MonitorSmartphone } from 'lucide-react';

function App() {
    const [copiedMac, setCopiedMac] = useState(false);
    const [copiedWin, setCopiedWin] = useState(false);

    const baseUrl = import.meta.env.VITE_INSTALL_BASE_URL || 'https://redbus.pages.dev';
    const linuxCommand = `curl -fsSL ${baseUrl}/install.sh | bash`;
    const docCommand = `npm run start:daemon`;

    const copyToClipboard = async (text: string, isLinux: boolean) => {
        try {
            await navigator.clipboard.writeText(text);
            if (isLinux) {
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
        <div className="min-h-screen bg-[#050000] text-gray-100 font-sans selection:bg-brand-500/40">
            {/* Header / Navbar */}
            <nav className="fixed top-0 w-full z-50 bg-[#0a0000]/90 backdrop-blur-md border-b border-brand-500/20 shadow-[0_4px_30px_rgba(220,38,38,0.1)]">
                <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <img src="/icon.png" alt="Redbus Logo" className="w-12 h-12 rounded-xl shadow-lg shadow-brand-500/40 object-cover border border-brand-500/30" />
                        <span className="font-bold text-2xl tracking-tight text-white uppercase">Redbus</span>
                    </div>
                    <div className="flex items-center space-x-6 text-sm font-semibold text-gray-300 uppercase tracking-wider">
                        <a href="#how-it-works" className="hover:text-brand-400 transition-colors">How it Works</a>
                        <a href="#features" className="hover:text-brand-400 transition-colors">Features</a>
                        <a href="https://github.com/guilecc/redbusagent" target="_blank" rel="noreferrer" className="hover:text-brand-400 transition-colors">GitHub</a>
                    </div>
                </div>
            </nav>

            <main className="relative pt-36 pb-20 overflow-hidden">
                {/* Intense Red Background Glow */}
                <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[900px] h-[700px] bg-brand-600/20 rounded-full blur-[150px] pointer-events-none"></div>

                <div className="max-w-5xl mx-auto px-6 text-center space-y-8 relative z-10">
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-950/60 border border-brand-500/30 text-brand-400 text-sm font-bold uppercase tracking-widest shadow-[0_0_15px_rgba(220,38,38,0.2)] mb-4">
                        <Server size={16} />
                        <span>Built for GPU Cloud Instances</span>
                    </div>

                    <h1 className="text-5xl md:text-7xl font-black tracking-tight text-white leading-[1.1] uppercase">
                        An AI agent engineered for <br className="hidden md:block" />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 via-red-500 to-rose-600 drop-shadow-[0_0_20px_rgba(220,38,38,0.3)]">powerful cloud infra</span>.
                    </h1>

                    <div className="space-y-4">
                        <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto font-medium">
                            Deploy Redbus on your GPU VPS. Powered by <strong className="text-blue-500 font-black drop-shadow-[0_0_12px_rgba(59,130,246,0.8)]">Gemma 3</strong>, it manages long-running automation tasks, navigates the web autonomously, and can be fully controlled over WhatsApp or SSH while your heavy models crush data in the background.
                        </p>
                    </div>

                    {/* Installation / Call to Action */}
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-6 pt-12">
                        {/* Command Box 1 */}
                        <div className="bg-[#0f0202] backdrop-blur-sm border border-brand-500/20 hover:border-brand-500/60 rounded-2xl p-6 w-full max-w-lg text-left shadow-[0_10px_30px_rgba(220,38,38,0.05)] hover:shadow-[0_10px_40px_rgba(220,38,38,0.15)] transition-all duration-300">
                            <div className="flex items-center gap-2 mb-3">
                                <Terminal size={18} className="text-brand-400" />
                                <span className="text-sm font-bold text-gray-200 uppercase tracking-wide">Install on Debian / Ubuntu</span>
                            </div>
                            <div className="flex bg-black border border-white/5 rounded-xl p-3 items-center justify-between font-mono text-sm cursor-pointer hover:bg-[#1a0505] transition-colors" onClick={() => copyToClipboard(linuxCommand, true)}>
                                <code className="text-brand-100 mr-2 break-all">{linuxCommand}</code>
                                <button className="text-brand-500 hover:text-white flex-shrink-0 transition-colors" title="Copy command">
                                    {copiedMac ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                                </button>
                            </div>
                        </div>

                        {/* Command Box 2 */}
                        <div className="bg-[#0f0202] backdrop-blur-sm border border-brand-500/20 hover:border-brand-500/60 rounded-2xl p-6 w-full max-w-lg text-left shadow-[0_10px_30px_rgba(220,38,38,0.05)] hover:shadow-[0_10px_40px_rgba(220,38,38,0.15)] transition-all duration-300">
                            <div className="flex items-center gap-2 mb-3">
                                <Zap size={18} className="text-brand-400" />
                                <span className="text-sm font-bold text-gray-200 uppercase tracking-wide">Start the Headless Engine</span>
                            </div>
                            <div className="flex bg-black border border-white/5 rounded-xl p-3 items-center justify-between font-mono text-sm cursor-pointer hover:bg-[#1a0505] transition-colors" onClick={() => copyToClipboard(docCommand, false)}>
                                <code className="text-brand-100 mr-2 break-all">{docCommand}</code>
                                <button className="text-brand-500 hover:text-white flex-shrink-0 transition-colors" title="Copy command">
                                    {copiedWin ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                                </button>
                            </div>
                        </div>
                    </div>
                    <p className="text-sm text-gray-400 pt-6 font-medium">SSH into your instance, paste the deployment script, and watch it boot up.</p>
                </div>
            </main>

            <section id="how-it-works" className="py-24 border-t border-brand-500/10 bg-black relative z-10">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-16">
                        <h2 className="text-4xl md:text-5xl font-black tracking-tight text-white mb-4 uppercase">
                            Intelligence that scales with hardware
                        </h2>
                        <p className="text-lg text-gray-400 max-w-2xl mx-auto font-medium">
                            Unlike rigid CLI tools, Redbus acts as an autonomous background daemon that takes full advantage of your cloud instance's resources to execute complex reasoning workflows, fueled by Google's Gemma 3.
                        </p>
                    </div>

                    {/* Dual-Cloud Architecture Hero Card */}
                    <div className="mb-16 p-8 md:p-12 rounded-3xl border border-brand-500/30 bg-gradient-to-br from-[#1a0505] to-[#0a0000] shadow-[0_20px_50px_rgba(220,38,38,0.1)] relative overflow-hidden group">
                        <div className="absolute top-0 right-0 w-80 h-80 bg-brand-500/10 rounded-full blur-[100px]"></div>
                        <div className="flex flex-col md:flex-row gap-10 items-center relative z-10">
                            <div className="flex-1 space-y-6">
                                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30 text-xs font-black uppercase tracking-widest shadow-[0_0_10px_rgba(220,38,38,0.2)]">
                                    Redbus Core Architecture
                                </div>
                                <h3 className="text-3xl font-black text-white leading-snug uppercase">
                                    Dual-Engine Routing for maximum efficiency.
                                </h3>
                                <p className="text-gray-300 text-lg leading-relaxed font-medium">
                                    Redbus operates using a concurrent multi-model system. The <strong className="text-brand-400">Live Engine</strong> ensures lightning-fast responses on your chat interfaces via lightweight APIs. Meanwhile, the <strong className="text-brand-400">Worker Engine</strong> heavily leverages your VPS's memory and GPUs running <strong className="text-blue-500 font-black drop-shadow-[0_0_12px_rgba(59,130,246,0.8)]">Gemma 3</strong> in the background for continuous data crunching, visual parsing, and memory distillation.
                                </p>
                            </div>
                            <div className="flex flex-col gap-4 min-w-[280px] w-full md:w-auto">
                                <div className="flex items-center gap-4 p-4 rounded-xl border border-brand-500/40 bg-[#1a0505]/80 backdrop-blur-sm shadow-[0_4px_20px_rgba(220,38,38,0.1)]">
                                    <div className="p-3 bg-brand-500/20 rounded-lg text-brand-400"><Zap size={24} /></div>
                                    <div>
                                        <div className="text-sm font-bold text-white uppercase tracking-wider">Live Engine</div>
                                        <div className="text-xs text-gray-400 font-medium">Low-latency daily interactions</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4 p-4 rounded-xl border border-rose-500/40 bg-[#1a0505]/80 backdrop-blur-sm shadow-[0_4px_20px_rgba(225,29,72,0.1)]">
                                    <div className="p-3 bg-rose-500/20 rounded-lg text-rose-400"><Brain size={24} /></div>
                                    <div>
                                        <div className="text-sm font-bold text-white uppercase tracking-wider">Worker Engine</div>
                                        <div className="text-xs text-gray-400 font-medium">Deep, async GPU reasoning</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div id="features" className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <FeatureCard
                            icon={<MonitorSmartphone size={32} strokeWidth={2.5} />}
                            title="Redbus Studio Desktop"
                            desc="Don't want to live in the terminal? Run Redbus Studio on your mac/PC to connect securely to your VPS over SSH and monitor the daemon visually."
                        />
                        <FeatureCard
                            icon={<MessageSquare size={32} strokeWidth={2.5} />}
                            title="WhatsApp Command Center"
                            desc="Bridge your agent to your phone. Deploy scripts, ask questions, or approve critical shell executions directly from your WhatsApp."
                        />
                        <FeatureCard
                            icon={<Eye size={32} strokeWidth={2.5} />}
                            title="Headless Web Vision"
                            desc="Uses automated Playwright instances combined with vision models to literally 'read' external web pages and bypass strict bot protections."
                        />
                        <FeatureCard
                            icon={<Database size={32} strokeWidth={2.5} />}
                            title="Continuous Vector Storage"
                            desc="Backed by lanceDB natively. The memory runs locally on your VPS, meaning your context window is effectively infinite over time."
                        />
                        <FeatureCard
                            icon={<Shield size={32} strokeWidth={2.5} />}
                            title="Secure Credential Vault"
                            desc="Never paste API keys in a config file again. Keys are encrypted with AES-256 on the VPS disk layer. Only the agent can decrypt them."
                        />
                        <FeatureCard
                            icon={<Server size={32} strokeWidth={2.5} />}
                            title="Unattended Automation"
                            desc="Instruct the Worker Engine to monitor a website, scrape data over several hours, and report back to your Studio or WhatsApp when it's done."
                        />
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="border-t border-brand-500/20 py-16 text-center bg-[#050000]">
                <div className="flex items-center justify-center gap-3 mb-6">
                    <img src="/icon.png" alt="Redbus Logo" className="w-8 h-8 rounded-lg border border-brand-500/30" />
                    <span className="font-bold text-xl text-white uppercase tracking-wider">Redbus</span>
                </div>
                <p className="text-brand-500/60 font-bold tracking-widest uppercase text-xs mb-2 shadow-brand-500 text-shadow">Unstoppable Infrastructure</p>
                <p className="text-gray-500 text-sm font-medium">© {new Date().getFullYear()} Redbus. Agentic workflows powered by Gemma 3.</p>
            </footer>
        </div>
    );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
    return (
        <div className="p-8 rounded-2xl border border-white/5 hover:border-brand-500/40 bg-[#0a0000] hover:bg-[#1a0505] transition-all duration-300 group shadow-[0_4px_20px_rgba(0,0,0,0.5)] hover:shadow-[0_10px_30px_rgba(220,38,38,0.15)]">
            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-brand-950 to-[#0a0000] border border-brand-500/20 flex items-center justify-center text-brand-500 mb-6 group-hover:bg-brand-600 group-hover:text-white group-hover:border-brand-400 transition-all shadow-md overflow-hidden relative">
                <div className="absolute inset-0 bg-brand-500/20 blur group-hover:blur-md transition-all"></div>
                <div className="relative z-10">{icon}</div>
            </div>
            <h3 className="text-xl font-bold mb-3 text-white tracking-tight uppercase">{title}</h3>
            <p className="text-gray-400 font-medium leading-relaxed">
                {desc}
            </p>
        </div>
    )
}

export default App;
