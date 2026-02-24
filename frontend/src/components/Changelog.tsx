
import { changelogData } from '../data/changelog';
import { Terminal } from 'lucide-react';

export function Changelog() {
    return (
        <section id="changelog" className="py-32 border-t-2 border-white/10 bg-black relative z-10 font-mono">
            <div className="max-w-4xl mx-auto px-6">
                <div className="mb-20">
                    <h2 className="text-5xl md:text-6xl font-black tracking-tighter uppercase border-l-8 border-red-600 pl-6 text-white">
                        System Logs
                    </h2>
                    <p className="mt-4 text-white/50 text-xl font-medium tracking-tight">
                        What's been deployed. Raw and unfiltered.
                    </p>
                </div>

                <div className="space-y-12">
                    {changelogData.map((entry, index) => (
                        <div key={index} className="border-2 border-white/10 bg-[#050505] relative group hover:border-red-600 transition-colors duration-300">
                            {/* Version Badge */}
                            <div className="absolute -top-4 -left-4 bg-red-600 text-black px-3 py-1 text-sm font-bold uppercase rotate-[-3deg] shadow-[4px_4px_0px_0px_rgba(255,255,255,0.1)]">
                                {entry.version}
                            </div>

                            {/* Header */}
                            <div className="p-6 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4 mt-2">
                                <div className="flex items-center gap-3">
                                    <Terminal className="text-red-600" size={24} />
                                    <h3 className="text-2xl font-black uppercase text-white tracking-tighter">
                                        {entry.title}
                                    </h3>
                                </div>
                                <div className="text-white/40 text-sm font-bold uppercase bg-white/5 px-3 py-1">
                                    {entry.date}
                                </div>
                            </div>

                            {/* Body */}
                            <div className="p-6">
                                <ul className="space-y-4">
                                    {entry.changes.map((change, idx) => (
                                        <li key={idx} className="flex gap-4 text-white/70 group-hover:text-white/90 transition-colors">
                                            <span className="text-red-500 font-bold shrink-0">{"->"}</span>
                                            <span className="leading-relaxed">{change}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
