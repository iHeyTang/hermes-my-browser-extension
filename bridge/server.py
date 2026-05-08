"""
WebSocket hub server for hermes-my-browser-extension.

Runs a lightweight WebSocket server on port 9393. Both the Hermes plugin
and the Chrome Extension connect to it. Messages from one side are
forwarded to the other.

Protocol:
  Hermes Plugin → Bridge:
    {"id": "req_001", "method": "Target.getTargets", "params": {}}

  Bridge → Chrome Extension:
    (same, forwarded verbatim)

  Chrome Extension → Bridge:
    {"id": "req_001", "result": {...}}  or  {"id": "req_001", "error": {...}}

  Bridge → Hermes Plugin:
    (response forwarded verbatim)

Usage:
  python -m bridge.server              # start on default :9393
  python -m bridge.server --port 9393  # custom port
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any, Dict, Set

try:
    import websockets
    from websockets.asyncio.server import ServerConnection, serve
except ImportError:
    sys.exit("bridge requires `websockets`. Install: pip install websockets")

logger = logging.getLogger("my-browser-bridge")

# ---------------------------------------------------------------------------
# Hub
# ---------------------------------------------------------------------------


class Hub:
    """Bidirectional message relay between two peers.

    Expects exactly two connected clients:
      - Agent side  (Hermes plugin) — sends CDP commands
      - Agent side  (Hermes plugin) — may also be the same connection
      - UI side     (Chrome Extension) — executes CDP and returns results

    When the second client connects, the hub starts relaying.
    """

    def __init__(self) -> None:
        self._peers: Dict[str, Set[ServerConnection]] = {
            "agent": set(),
            "ui": set(),
        }
        self._ready = asyncio.Event()

    async def _identify(self, ws: ServerConnection) -> str | None:
        """Wait for the first message to determine peer identity."""
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=30)
        except asyncio.TimeoutError:
            return None

        data = json.loads(msg)
        role = data.get("role", "")
        if role == "agent":
            self._peers["agent"].add(ws)
            return "agent"
        elif role == "ui":
            self._peers["ui"].add(ws)
            return "ui"

        # Unknown — treat as agent by default
        self._peers["agent"].add(ws)
        return "agent"

    async def handle(self, ws: ServerConnection) -> None:
        """Handle one WebSocket client connection."""
        role = await self._identify(ws)
        if role is None:
            logger.warning("Peer failed to identify within timeout — dropping")
            await ws.close(4000, "identity timeout")
            return

        logger.info("Peer connected: %s (%s)", ws.remote_address, role)

        if len(self._peers["agent"]) >= 1 and len(self._peers["ui"]) >= 1:
            self._ready.set()

        try:
            async for raw in ws:
                try:
                    await self._relay(role, raw)
                except Exception as exc:
                    logger.error("Relay error: %s", exc)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._peers[role].discard(ws)
            logger.info("Peer disconnected: %s (%s)", ws.remote_address, role)

    async def _relay(self, sender_role: str, raw: str) -> None:
        """Forward a message from *sender_role* to the other side."""
        # Heartbeat frames are local to the sender↔bridge link (used by the
        # extension to keep its MV3 service worker alive). They must not be
        # surfaced to the Hermes plugin, which would otherwise see noise it
        # can't correlate to any request id.
        if _is_heartbeat(raw):
            return

        target_role = "agent" if sender_role == "ui" else "ui"
        targets = list(self._peers[target_role])
        if not targets:
            logger.debug("No %s peer to relay to — dropping message", target_role)
            return

        coros = [t.send(raw) for t in targets]
        await asyncio.gather(*coros, return_exceptions=True)


def _is_heartbeat(raw: str) -> bool:
    """Return True for `{"type": "ping"}` / `{"type": "pong"}` envelopes."""
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return isinstance(data, dict) and data.get("type") in ("ping", "pong")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def _main(port: int) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    hub = Hub()

    async with serve(hub.handle, "127.0.0.1", port):
        logger.info("my-browser-bridge listening on ws://127.0.0.1:%d", port)
        await asyncio.Future()  # run forever


def main() -> None:
    parser = argparse.ArgumentParser(description="my-browser-bridge WebSocket hub")
    parser.add_argument("--port", type=int, default=9393, help="Listen port")
    args = parser.parse_args()
    asyncio.run(_main(args.port))


if __name__ == "__main__":
    main()
