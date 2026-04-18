import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ChatbotPublicConfig, type ChatbotMessage } from "@/lib/api";
import { MessageCircle, X, Send, Star, Loader2 } from "lucide-react";
import { playChatbotResponseSound } from "@/hooks/useNotificationSound";

interface Props {
  token: string;
  leadId: string;
}

export default function ChatbotWidget({ token, leadId }: Props) {
  const [config, setConfig] = useState<ChatbotPublicConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [messages, setMessages] = useState<ChatbotMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showPresets, setShowPresets] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [peeked, setPeeked] = useState(false);
  const [userInteracted, setUserInteracted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load config
  useEffect(() => {
    api.getChatbotConfigPublic()
      .then((cfg) => {
        if (cfg.enabled && cfg.test_only_lead_ids.length > 0) {
          if (!cfg.test_only_lead_ids.includes(leadId)) {
            setConfig(null);
            return;
          }
        }
        if (cfg.enabled) setConfig(cfg);
      })
      .catch(() => {});
  }, [leadId]);

  // Auto-peek: open immediately, close after 3s if no interaction
  useEffect(() => {
    if (!config || peeked) return;
    const openTimer = setTimeout(() => {
      setOpen(true);
      setPeeked(true);
    }, 300);
    return () => clearTimeout(openTimer);
  }, [config, peeked]);

  useEffect(() => {
    if (!peeked || !open || userInteracted) return;
    const closeTimer = setTimeout(() => {
      handleClose();
    }, 3000);
    return () => clearTimeout(closeTimer);
  }, [peeked, open, userInteracted]);

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

  // Heartbeat — tells backend customer is on the page
  useEffect(() => {
    if (!config) return;
    const sendHeartbeat = () => api.chatbotHeartbeat(token).catch(() => {});
    sendHeartbeat(); // Initial
    const interval = setInterval(sendHeartbeat, 20000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") sendHeartbeat();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [config, token]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Close with animation
  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 250);
  }, []);

  const handleSend = useCallback(async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || sending) return;
    setUserInteracted(true);

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
      const botMsg: ChatbotMessage = {
        id: result.message_id,
        direction: "assistant",
        content: result.response,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
      playChatbotResponseSound();
    } catch (err: unknown) {
      const is429 = err instanceof Error && err.message.includes("429");
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          direction: "assistant",
          content: is429
            ? "You've reached the message limit for now. Please try again in a bit!"
            : "Sorry, I'm having trouble right now. Please try again in a moment.",
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, token]);

  const handlePresetClick = (question: string) => {
    setUserInteracted(true);
    handleSend(question);
  };

  const handleBubbleClick = () => {
    setUserInteracted(true);
    setPeeked(true);
    if (open) {
      handleClose();
    } else {
      setOpen(true);
    }
  };

  // Any click/tap inside the chat window cancels auto-close
  const handleWindowInteraction = () => {
    if (!userInteracted) setUserInteracted(true);
  };

  if (!config) return null;

  const presets = (config.preset_questions || []).filter(
    (p): p is { question: string; answer: string } => p !== null && !!p.question,
  );

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
      <span className="text-[10px] text-white/60">
        {config.google_review_count} reviews
      </span>
    </a>
  );

  const ProfilePic = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
    const sizeClass = size === "lg" ? "h-10 w-10" : size === "md" ? "h-8 w-8" : "h-6 w-6";
    const textClass = size === "lg" ? "text-lg" : size === "md" ? "text-sm" : "text-[10px]";
    if (config.has_profile_picture) {
      return <img src={api.getChatbotProfilePictureUrl()} alt={config.bot_name} className={`${sizeClass} rounded-full object-cover border-2 border-white/30 shrink-0`} />;
    }
    return (
      <div className={`${sizeClass} rounded-full bg-white/20 flex items-center justify-center shrink-0`}>
        <span className={`text-white font-bold ${textClass}`}>{config.bot_name[0]}</span>
      </div>
    );
  };

  // Animation styles for scale-from-corner
  const windowStyle: React.CSSProperties = {
    maxHeight: "min(500px, calc(100vh - 120px))",
    transformOrigin: "bottom right",
    transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
    transform: closing ? "scale(0.4)" : "scale(1)",
    opacity: closing ? 0 : 1,
  };

  return (
    <>
      {/* Chat window */}
      {open && (
        <div
          className="fixed bottom-20 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] sm:w-[360px] bg-background rounded-2xl shadow-2xl border flex flex-col overflow-hidden"
          style={windowStyle}
          onClick={handleWindowInteraction}
          onTouchStart={handleWindowInteraction}
        >
          {/* Header */}
          <div className="bg-gradient-to-r from-green-800 to-green-700 px-3.5 py-3 flex items-center gap-2.5">
            <ProfilePic size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm">{config.bot_name}</p>
              <Stars />
            </div>
            <button
              onClick={handleClose}
              className="text-white/70 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3 bg-gray-50/50" style={{ minHeight: 180 }}>
            {/* Welcome message */}
            {messages.length === 0 && !sending && (
              <div className="flex gap-2">
                <ProfilePic size="sm" />
                <div className="bg-white rounded-xl rounded-tl-sm px-3 py-2 shadow-sm border text-sm leading-relaxed">
                  Hi! I'm {config.bot_name} from A&T Fence Restoration. How can I help you today?
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
                    className="w-full text-left px-3 py-2.5 rounded-xl border bg-white hover:bg-green-50 hover:border-green-300 transition-colors text-sm shadow-sm"
                  >
                    {p.question}
                  </button>
                ))}
                <button
                  onClick={() => { setUserInteracted(true); setShowPresets(false); }}
                  className="w-full text-left px-3 py-2.5 rounded-xl border border-dashed bg-white hover:bg-gray-50 transition-colors text-sm text-muted-foreground"
                >
                  Have another question in mind?
                </button>
              </div>
            )}

            {/* Message bubbles */}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2 ${msg.direction === "user" ? "flex-row-reverse" : ""}`}>
                {msg.direction !== "user" && <ProfilePic size="sm" />}
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm leading-relaxed ${
                    msg.direction === "user"
                      ? "bg-green-700 text-white rounded-tr-sm"
                      : "bg-white border rounded-tl-sm"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {sending && (
              <div className="flex gap-2">
                <ProfilePic size="sm" />
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
                onChange={(e) => { setUserInteracted(true); setInput(e.target.value); }}
                placeholder="Type a message..."
                maxLength={500}
                className="flex-1 px-3 py-2 rounded-full border bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500"
                disabled={sending}
                onFocus={() => setUserInteracted(true)}
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="h-9 w-9 rounded-full bg-green-700 text-white flex items-center justify-center hover:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
            {input.length > 400 && (
              <p className={`text-[10px] text-right mt-0.5 pr-1 ${input.length >= 490 ? "text-red-500" : "text-muted-foreground"}`}>
                {input.length}/500
              </p>
            )}
          </div>
        </div>
      )}

      {/* Floating bubble */}
      <button
        onClick={handleBubbleClick}
        className="fixed bottom-4 right-4 sm:right-6 z-50 group"
      >
        <div className={`h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center ${
          open ? "bg-green-800 scale-90" : "bg-green-700 hover:bg-green-800 hover:scale-105"
        }`}>
          {open ? (
            <X className="h-6 w-6 text-white" />
          ) : config.has_profile_picture ? (
            <img src={api.getChatbotProfilePictureUrl()} alt="" className="h-14 w-14 rounded-full object-cover ring-2 ring-green-700" />
          ) : (
            <MessageCircle className="h-6 w-6 text-white" />
          )}
        </div>
        {/* Pulse ring when not open */}
        {!open && !closing && (
          <span className="absolute inset-0 rounded-full bg-green-600/30 animate-ping pointer-events-none" />
        )}
      </button>
    </>
  );
}
