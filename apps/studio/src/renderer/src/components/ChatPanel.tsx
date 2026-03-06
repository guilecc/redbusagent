import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStudioState, type ChatMessage } from '../hooks/useStudioStore';

interface ChatPanelProps {
    onSend: (content: string) => Promise<void>;
    disabled?: boolean;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
    const isUser = msg.role === 'user';
    const textContent = msg.content || (msg.streaming ? '…' : '');

    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${isUser
                    ? 'bg-studio-accent/20 text-slate-100'
                    : 'bg-white/5 text-slate-200'
                    }`}
            >
                {isUser ? (
                    <div className="whitespace-pre-wrap">{textContent}</div>
                ) : (
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                            ul: ({ children }) => <ul className="mb-2 list-inside list-disc last:mb-0">{children}</ul>,
                            ol: ({ children }) => <ol className="mb-2 list-inside list-decimal last:mb-0">{children}</ol>,
                            li: ({ children }) => <li className="mb-1">{children}</li>,
                            strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                            code: ({ node, inline, children, ...props }: any) => {
                                if (inline) {
                                    return (
                                        <code className="rounded bg-black/30 px-1 py-0.5 text-xs text-studio-accent" {...props}>
                                            {children}
                                        </code>
                                    );
                                }
                                return (
                                    <div className="my-2 overflow-x-auto rounded border border-white/10 bg-black/40 p-2 text-xs">
                                        <code {...props}>{children}</code>
                                    </div>
                                );
                            },
                        }}
                    >
                        {textContent}
                    </ReactMarkdown>
                )}
                {msg.streaming && (
                    <span className="ml-1 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-studio-accent" />
                )}
                {msg.tier && !msg.streaming && (
                    <div className="mt-1 text-[10px] text-studio-muted">
                        {msg.model ?? msg.tier}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ChatPanel({ onSend, disabled }: ChatPanelProps): JSX.Element {
    const { chat, session } = useStudioState();
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const isConnected = session.connection === 'connected';
    const inputDisabled = disabled || sending || !isConnected;

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [chat.length, chat[chat.length - 1]?.content]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = input.trim();
        if (!trimmed || inputDisabled) return;
        setInput('');
        setSending(true);
        try {
            await onSend(trimmed);
        } finally {
            setSending(false);
        }
    };

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">Chat</h2>
                <span className="text-xs text-studio-muted">{chat.length} messages</span>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                {chat.length === 0 && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-studio-muted">
                            {isConnected ? 'Send a message to begin.' : 'Connect to start chatting.'}
                        </p>
                    </div>
                )}
                {chat.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                ))}
            </div>

            {/* Composer */}
            <form onSubmit={(e) => void handleSubmit(e)} className="border-t border-white/10 px-4 py-3">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={inputDisabled}
                        placeholder={isConnected ? 'Type a message…' : 'Connect first'}
                        className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-studio-accent/50 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={inputDisabled || !input.trim()}
                        className="rounded-lg bg-studio-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                    >
                        Send
                    </button>
                </div>
            </form>
        </section>
    );
}

