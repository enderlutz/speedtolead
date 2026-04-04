"""
In-process event bus for Server-Sent Events (SSE).
Thread-safe: webhook handlers push events, SSE endpoint streams them.
"""
from __future__ import annotations
import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

_subscribers: list[asyncio.Queue] = []
_lock = threading.Lock()


def publish(event_type: str, data: dict):
    """Push an event to all connected SSE subscribers. Thread-safe, called from sync code."""
    payload = json.dumps({"type": event_type, "data": data, "ts": datetime.now(timezone.utc).isoformat()})
    with _lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)


async def subscribe() -> AsyncGenerator[str, None]:
    """Yield SSE-formatted events. Sends keepalive every 30s to prevent connection drop."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    with _lock:
        _subscribers.append(q)
    try:
        yield ": connected\n\n"
        while True:
            try:
                payload = await asyncio.wait_for(q.get(), timeout=30)
                yield f"data: {payload}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        with _lock:
            if q in _subscribers:
                _subscribers.remove(q)
