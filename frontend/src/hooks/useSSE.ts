import { useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.VITE_API_URL || "";

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

type Handler = (event: SSEEvent) => void;

// Module-level: single shared EventSource + subscriber list
let _source: EventSource | null = null;
let _handlers: Set<Handler> = new Set();
let _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

function _connect() {
  if (_source && _source.readyState !== EventSource.CLOSED) return;

  _source = new EventSource(`${BASE}/events`);

  _source.onmessage = (e) => {
    try {
      const parsed: SSEEvent = JSON.parse(e.data);
      _handlers.forEach((h) => h(parsed));
    } catch {
      // ignore parse errors
    }
  };

  _source.onerror = () => {
    _source?.close();
    _source = null;
    // Reconnect after 3 seconds
    if (_reconnectTimeout) clearTimeout(_reconnectTimeout);
    _reconnectTimeout = setTimeout(_connect, 3000);
  };
}

function _disconnect() {
  if (_handlers.size > 0) return; // still has subscribers
  _source?.close();
  _source = null;
  if (_reconnectTimeout) {
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }
}

/**
 * Subscribe to real-time server events.
 * @param onEvent - called for every SSE event (new_lead, estimate_sent, customer_reply)
 */
export function useSSE(onEvent: Handler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const stableHandler = useCallback((e: SSEEvent) => handlerRef.current(e), []);

  useEffect(() => {
    _handlers.add(stableHandler);
    _connect();

    return () => {
      _handlers.delete(stableHandler);
      _disconnect();
    };
  }, [stableHandler]);
}
