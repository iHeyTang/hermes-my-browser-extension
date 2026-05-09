/**
 * GM_xmlhttpRequest proxy executed in the background SW.
 *
 * The runtime in the page can't issue cross-origin requests (CORS) the way
 * Tampermonkey scripts expect; we proxy through SW `fetch`, which inherits
 * the extension's `<all_urls>` host_permissions.
 *
 * Lifecycle frames sent back to the requester:
 *   loadstart → progress* → load|error|abort|timeout
 */

import type { GmXhrRequest, GmXhrResponse } from "~lib/types";

const ABORT_CONTROLLERS = new Map<string, AbortController>();

export async function handleGmXhr(
  req: GmXhrRequest,
  send: (frame: GmXhrResponse) => void,
): Promise<void> {
  const controller = new AbortController();
  ABORT_CONTROLLERS.set(req.requestId, controller);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (req.timeout && req.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      send({
        type: "gm-xhr-response",
        requestId: req.requestId,
        phase: "timeout",
        error: `timeout after ${req.timeout}ms`,
      });
      controller.abort();
    }, req.timeout);
  }

  try {
    send({
      type: "gm-xhr-response",
      requestId: req.requestId,
      phase: "loadstart",
    });

    const headers: HeadersInit = { ...(req.headers || {}) };
    let body: BodyInit | null = null;
    if (req.data != null && req.method.toUpperCase() !== "GET") {
      body = req.data;
    }

    const init: RequestInit = {
      method: req.method || "GET",
      headers,
      body,
      signal: controller.signal,
      credentials: "include",
      redirect: "follow",
    };

    if (req.user || req.password) {
      // Basic auth — userscripts sometimes pass these. Synthesize the header.
      const u = req.user || "";
      const p = req.password || "";
      (headers as Record<string, string>).Authorization =
        "Basic " + btoa(`${u}:${p}`);
    }

    const res = await fetch(req.url, init);
    const buf = await res.arrayBuffer();
    const responseHeaders = headerString(res.headers);
    const finalUrl = res.url;
    const wantsBinary =
      req.responseType === "arraybuffer" ||
      req.responseType === "blob" ||
      req.binary === true;

    let responseText: string | undefined;
    let responseBase64: string | undefined;
    if (wantsBinary) {
      responseBase64 = arrayBufferToBase64(buf);
    } else {
      responseText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }

    send({
      type: "gm-xhr-response",
      requestId: req.requestId,
      phase: "progress",
      loaded: buf.byteLength,
      total: buf.byteLength,
    });

    send({
      type: "gm-xhr-response",
      requestId: req.requestId,
      phase: "load",
      status: res.status,
      statusText: res.statusText,
      responseHeaders,
      finalUrl,
      responseText,
      responseBase64,
      loaded: buf.byteLength,
      total: buf.byteLength,
    });
  } catch (e) {
    const err = e as Error;
    if (err?.name === "AbortError") {
      // The dispatcher already sent abort/timeout above when we triggered it.
      // For caller-initiated aborts, surface "abort".
      send({
        type: "gm-xhr-response",
        requestId: req.requestId,
        phase: "abort",
        error: err.message,
      });
    } else {
      send({
        type: "gm-xhr-response",
        requestId: req.requestId,
        phase: "error",
        error: String(err?.message || err),
      });
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    ABORT_CONTROLLERS.delete(req.requestId);
  }
}

export function abortGmXhr(requestId: string): void {
  const c = ABORT_CONTROLLERS.get(requestId);
  if (c) c.abort();
  ABORT_CONTROLLERS.delete(requestId);
}

function headerString(h: Headers): string {
  const parts: string[] = [];
  h.forEach((value, key) => {
    parts.push(`${key}: ${value}`);
  });
  return parts.join("\r\n");
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
