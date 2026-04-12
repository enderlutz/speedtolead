import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ChatbotPublicConfig, type ChatbotMessage } from "@/lib/api";
import { MessageCircle, X, Send, Star, Loader2 } from "lucide-react";

interface Props {
  token: string;
  leadId: string;
}

export default function ChatbotWidget({ token, leadId }: Props) {
  const [config, setConfig] = useState<ChatbotPublicConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatbotMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showPresets, setShowPresets] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load config
  useEffect(() => {
    api.getChatbotConfigPublic()
      .then((cfg) => {
        if (cfg.enabled && cfg.test_only_lead_ids.length > 0) {
          // Test mode — only show for specified leads
          if (!cfg.test_only_lead_ids.includes(leadId)) {
            setConfig(null);
            return;
          }
        }
        if (cfg.enabled) setConfig(cfg);
      })
      .catch(() => {});
  }, [leadId]);

  // Load message history when opened
  useEffect(() => {
    if (!open || loaded) return;
    api.getChatbotMessages(token)
      .then((msgs) => {
        setMessages(msgs);
        if (msgs.length > 0) setShowPresets(false);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [open, loaded, token]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || sending) return;

    // Add user message to UI immediately
    const userMsg: ChatbotMessage = {
      id: `temp-${Date.now()}`,
      direction: "user",
      content: msg,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setShowPresets(false);
    setSending(true);

    try {
      const result = await api.sendChatbotMessage(token, msg);
      // Add assistant response
      const botMsg: ChatbotMessage = {
        id: result.message_id,
        direction: "assistant",
        content: result.response,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          direction: "assistant",
          content: "Sorry, I'm having trouble right now. Please try again in a moment.",
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, token]);

  const handlePresetClick = (question: string) => {
    handleSend(question);
  };

  if (!config) return null;

  const presets = (config.preset_questions || []).filter(
    (p): p is { question: string; answer: string } => p !== null && !!p.question,
  );

  // Stars component
  const Stars = () => (
    <a
      href={config.google_review_link || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 hover:opacity-80 transition-opacity"
    >
      <div className="flex">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={`h-3 w-3 ${i < Math.round(config.google_review_stars) ? "text-amber-400 fill-amber-400" : "text-gray-300"}`}
          />
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">
        {config.google_review_count} reviews
      </span>
    </a>
  );

  return (
    <>
      {/* Chat window */}
      {open && (
        <div className="fixed bottom-20 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] sm:w-[360px] bg-background rounded-2xl shadow-2xl border flex flex-col overflow-hidden"
          style={{ maxHeight: "min(520px, calc(100vh - 120px))" }}>
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-700 to-amber-800 px-4 py-3 flex items-center gap-3">
            {config.has_profile_picture ? (
              <img
                src={api.getChatbotProfilePictureUrl()}
                alt={config.bot_name}
                className="h-10 w-10 rounded-full object-cover border-2 border-white/30"
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-lg">
                {config.bot_name[0]}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm">{config.bot_name}</p>
              <Stars />
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-white/70 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-gray-50/50" style={{ minHeight: 200 }}>
            {/* Welcome message */}
            {messages.length === 0 && !sending && (
              <div className="flex gap-2.5">
                {config.has_profile_picture ? (
                  <img src={api.getChatbotProfilePictureUrl()} alt="" className="h-7 w-7 rounded-full object-cover shrink-0 mt-0.5" />
                ) : (
                  <div className="h-7 w-7 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-amber-700 text-xs font-bold">{config.bot_name[0]}</span>
                  </div>
                )}
                <div className="bg-white rounded-xl rounded-tl-sm px-3 py-2 shadow-sm border text-sm">
                  Hi! I'm {config.bot_name}. How can I help you today?
                </div>
              </div>
            )}

            {/* Preset question bubbles */}
            {showPresets && messages.length === 0 && (
              <div className="space-y-2 mt-2">
                {presets.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => handlePresetClick(p.question)}
                    className="w-full text-left px-3 py-2.5 rounded-xl border bg-white hover:bg-amber-50 hover:border-amber-200 transition-colors text-sm shadow-sm"
                  >
                    {p.question}
                  </button>
                ))}
                <button
                  onClick={() => { setShowPresets(false); }}
                  className="w-full text-left px-3 py-2.5 rounded-xl border border-dashed bg-white hover:bg-gray-50 transition-colors text-sm text-muted-foreground"
                >
                  Have another question in mind?
                </button>
              </div>
            )}

            {/* Message bubbles */}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2.5 ${msg.direction === "user" ? "flex-row-reverse" : ""}`}>
                {msg.direction !== "user" && (
                  config.has_profile_picture ? (
                    <img src={api.getChatbotProfilePictureUrl()} alt="" className="h-7 w-7 rounded-full object-cover shrink-0 mt-0.5" />
                  ) : (
                    <div className="h-7 w-7 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-amber-700 text-xs font-bold">{config.bot_name[0]}</span>
                    </div>
                  )
                )}
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${
                    msg.direction === "user"
                      ? "bg-amber-700 text-white rounded-tr-sm"
                      : "bg-white border rounded-tl-sm"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {sending && (
              <div className="flex gap-2.5">
                <div className="h-7 w-7 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                  <span className="text-amber-700 text-xs font-bold">{config.bot_name[0]}</span>
                </div>
                <div className="bg-white border rounded-xl rounded-tl-sm px-4 py-2.5 shadow-sm">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t bg-white px-3 py-2.5">
            <form
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 px-3 py-2 rounded-full border bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                disabled={sending}
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="h-9 w-9 rounded-full bg-amber-700 text-white flex items-center justify-center hover:bg-amber-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Floating bubble */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-4 right-4 sm:right-6 z-50 h-14 w-14 rounded-full bg-amber-700 text-white shadow-lg hover:bg-amber-800 hover:shadow-xl transition-all flex items-center justify-center"
      >
        {open ? (
          <X className="h-6 w-6" />
        ) : config.has_profile_picture ? (
          <img src={api.getChatbotProfilePictureUrl()} alt="" className="h-14 w-14 rounded-full object-cover" />
        ) : (
          <MessageCircle className="h-6 w-6" />
        )}
      </button>
    </>
  );
}
