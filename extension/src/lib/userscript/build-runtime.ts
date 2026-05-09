/**
 * Builds the wrapped MAIN-world source for a userscript:
 *   (function () {
 *     "use strict";
 *     const __channel = "...";
 *     const __scriptId = "...";
 *     const GM_info = {...};
 *     const GM_setValue = ...
 *     const GM_xmlhttpRequest = ...
 *     ... full GM_* / GM.* surface ...
 *     // @require sources prepended verbatim
 *     // user source
 *   })();
 *
 * The runtime communicates back to the ISOLATED bouncer via
 * `window.postMessage({channel, type:"rpc", ...})`. The bouncer answers with
 * `{type:"rpc-result", ...}` and pushes streaming xhr/menu events as
 * `{type:"event", ...}`.
 */

import type { UserScriptMetadata } from "~lib/types";

export interface BuildArgs {
  channelId: string;
  script: {
    id: string;
    name: string;
    source: string;
    meta: UserScriptMetadata;
    requires: string[];
    resources: Array<{ name: string; url: string; dataUrl: string }>;
    runtimeArgs?: unknown;
  };
  valueSnapshot: Record<string, unknown>;
}

export function buildWrappedSource(args: BuildArgs): string {
  const { channelId, script, valueSnapshot } = args;

  const requireBlock = script.requires.map((src, i) => `\n/* @require #${i} */\n${src}\n`).join("\n");
  const headerJson = JSON.stringify({
    scriptId: script.id,
    channel: channelId,
    valueSnapshot,
    resources: script.resources.reduce<Record<string, { url: string; dataUrl: string }>>(
      (acc, r) => {
        acc[r.name] = { url: r.url, dataUrl: r.dataUrl };
        return acc;
      },
      {},
    ),
    grant: script.meta.grant,
    info: {
      script: {
        name: script.meta.name,
        namespace: script.meta.namespace || "",
        description: script.meta.description || "",
        version: script.meta.version || "",
        author: script.meta.author || "",
        match: script.meta.match,
        include: script.meta.include,
        exclude: script.meta.exclude,
        excludeMatches: script.meta.excludeMatch,
        require: script.meta.require,
        resources: script.meta.resource,
        runAt: script.meta.runAt,
        grant: script.meta.grant,
      },
      scriptHandler: "Hermes",
      version: "0.3.0",
      scriptArgs: script.runtimeArgs ?? null,
    },
  });

  // The runtime body is a self-contained string that gets injected into the
  // page. It does NOT import any module — everything inlines here.
  const runtime = String.raw`
(function () {
  "use strict";
  var __header = ${headerJson};
  var __channel = __header.channel;
  var __scriptId = __header.scriptId;
  var __values = Object.assign({}, __header.valueSnapshot || {});
  var __resources = __header.resources || {};
  var __grant = __header.grant || [];
  var GM_info = __header.info;

  // ---- private RPC plumbing -------------------------------------------------
  var __nextRpcId = 1;
  var __pendingRpc = new Map();
  var __xhrCallbacks = new Map();   // rpcId -> { onload, onerror, onprogress, ... }
  var __menuCallbacks = new Map();  // menuId -> handler
  var __valueChangeListeners = new Map(); // listenerId -> { name, handler }
  var __nextValueListenerId = 1;

  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || d.channel !== __channel) return;
    if (d.type === "rpc-result") {
      var p = __pendingRpc.get(d.rpcId);
      if (!p) return;
      __pendingRpc.delete(d.rpcId);
      if (d.ok) p.resolve(d.value);
      else p.reject(new Error(d.error || "rpc failed"));
      return;
    }
    if (d.type === "event" && d.event === "xhr-frame") {
      var pl = d.payload || {};
      var cb = __xhrCallbacks.get(pl.rpcId);
      if (!cb) return;
      var f = pl.frame || {};
      var responseObj = __buildXhrResponse(f, cb.opts);
      if (f.phase === "loadstart" && cb.opts.onloadstart) cb.opts.onloadstart(responseObj);
      else if (f.phase === "progress" && cb.opts.onprogress) cb.opts.onprogress(responseObj);
      else if (f.phase === "load") {
        if (cb.opts.onload) cb.opts.onload(responseObj);
        if (cb.opts.onreadystatechange) cb.opts.onreadystatechange(responseObj);
        __xhrCallbacks.delete(pl.rpcId);
      } else if (f.phase === "error") {
        if (cb.opts.onerror) cb.opts.onerror(responseObj);
        __xhrCallbacks.delete(pl.rpcId);
      } else if (f.phase === "abort") {
        if (cb.opts.onabort) cb.opts.onabort(responseObj);
        __xhrCallbacks.delete(pl.rpcId);
      } else if (f.phase === "timeout") {
        if (cb.opts.ontimeout) cb.opts.ontimeout(responseObj);
        __xhrCallbacks.delete(pl.rpcId);
      }
      return;
    }
    if (d.type === "event" && d.event === "menu-invoke") {
      var h = __menuCallbacks.get((d.payload || {}).id);
      if (typeof h === "function") {
        try { h(); } catch (err) { console.error("[userscript] menu handler threw", err); }
      }
      return;
    }
  });

  function __rpc(call, params) {
    var id = __nextRpcId++;
    return new Promise(function (resolve, reject) {
      __pendingRpc.set(id, { resolve: resolve, reject: reject });
      try {
        window.postMessage(
          { type: "rpc", channel: __channel, scriptId: __scriptId, rpcId: id, call: call, params: params },
          window.location.origin,
        );
      } catch (e) {
        __pendingRpc.delete(id);
        reject(e);
      }
    });
  }

  function __buildXhrResponse(frame, opts) {
    var responseHeaders = frame.responseHeaders || "";
    var status = frame.status == null ? 0 : frame.status;
    var responseText = frame.responseText;
    var resp = null;
    var responseType = (opts && opts.responseType) || "";
    if (responseType === "json") {
      try { resp = responseText != null ? JSON.parse(responseText) : null; } catch (e) { resp = null; }
    } else if (responseType === "arraybuffer") {
      resp = frame.responseBase64 ? __b64ToArrayBuffer(frame.responseBase64) : null;
    } else if (responseType === "blob") {
      if (frame.responseBase64) {
        var ab = __b64ToArrayBuffer(frame.responseBase64);
        resp = new Blob([ab]);
      }
    } else if (responseType === "document") {
      try {
        resp = new DOMParser().parseFromString(responseText || "", "text/html");
      } catch (e) { resp = null; }
    } else {
      resp = responseText;
    }
    return {
      finalUrl: frame.finalUrl,
      readyState: frame.phase === "load" ? 4 : (frame.phase === "progress" ? 3 : 1),
      status: status,
      statusText: frame.statusText || "",
      responseHeaders: responseHeaders,
      response: resp,
      responseText: responseText || "",
      responseXML: null,
      lengthComputable: typeof frame.total === "number",
      loaded: frame.loaded || 0,
      total: frame.total || 0,
      context: opts && opts.context,
    };
  }

  function __b64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function __genRequestId() {
    return "xhr-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  }

  // ---- GM_setValue / GM_getValue --------------------------------------------
  function GM_getValue(name, fallback) {
    if (Object.prototype.hasOwnProperty.call(__values, name)) return __values[name];
    return fallback;
  }
  function GM_setValue(name, value) {
    __values[name] = value;
    __rpc("value.set", { scriptId: __scriptId, name: name, value: value });
  }
  function GM_deleteValue(name) {
    delete __values[name];
    __rpc("value.delete", { scriptId: __scriptId, name: name });
  }
  function GM_listValues() {
    return Object.keys(__values);
  }
  function GM_addValueChangeListener(name, handler) {
    var id = __nextValueListenerId++;
    __valueChangeListeners.set(id, { name: name, handler: handler });
    return id;
  }
  function GM_removeValueChangeListener(id) {
    __valueChangeListeners.delete(id);
  }

  // ---- GM_addStyle / GM_addElement ------------------------------------------
  function GM_addStyle(css) {
    var el = document.createElement("style");
    el.textContent = String(css || "");
    (document.head || document.documentElement).appendChild(el);
    return el;
  }
  function GM_addElement() {
    var args = Array.prototype.slice.call(arguments);
    var parent = document.body || document.documentElement;
    var tagName, attrs;
    if (args.length === 3) {
      parent = args[0];
      tagName = args[1];
      attrs = args[2] || {};
    } else {
      tagName = args[0];
      attrs = args[1] || {};
    }
    var el = document.createElement(tagName);
    var inner = attrs.textContent;
    delete attrs.textContent;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        try { el[k] = attrs[k]; } catch (e) { el.setAttribute(k, attrs[k]); }
      }
    }
    if (inner != null) el.textContent = inner;
    parent.appendChild(el);
    return el;
  }

  // ---- GM_setClipboard / GM_log / GM_notification ---------------------------
  function GM_setClipboard(text) {
    __rpc("setClipboard", { text: String(text == null ? "" : text) });
  }
  function GM_log(msg) {
    console.log("[userscript:" + GM_info.script.name + "]", msg);
    __rpc("log", { msg: String(msg) });
  }
  function GM_notification(opts, ondone) {
    var options = typeof opts === "string" ? { text: opts } : (opts || {});
    __rpc("notify", { scriptId: __scriptId, options: options }).then(function () {
      if (typeof ondone === "function") ondone();
    });
  }

  // ---- GM_openInTab ---------------------------------------------------------
  function GM_openInTab(url, options) {
    var opts = typeof options === "boolean" ? { loadInBackground: options } : (options || {});
    var handle = { closed: false };
    __rpc("openInTab", { url: url, loadInBackground: !!opts.loadInBackground, active: opts.active !== false }).then(function (res) {
      if (res && typeof res === "object") handle.tabId = res.tabId;
    });
    handle.close = function () { handle.closed = true; /* SW closing not implemented */ };
    return handle;
  }

  // ---- GM_download ----------------------------------------------------------
  function GM_download(arg, name) {
    var details = typeof arg === "string" ? { url: arg, name: name } : (arg || {});
    __rpc("download", details);
  }

  // ---- GM_getResourceText / GM_getResourceURL -------------------------------
  function GM_getResourceText(name) {
    var r = __resources[name];
    if (!r) return null;
    // Pre-loaded data URLs only carry the encoded body; fetch via RPC for text.
    return r.dataUrl ? __dataUrlToText(r.dataUrl) : null;
  }
  function GM_getResourceURL(name) {
    var r = __resources[name];
    return r ? r.dataUrl : null;
  }
  function __dataUrlToText(dataUrl) {
    var idx = dataUrl.indexOf(",");
    if (idx < 0) return null;
    var base64 = dataUrl.slice(idx + 1);
    try { return atob(base64); } catch (e) { return null; }
  }

  // ---- GM_registerMenuCommand -----------------------------------------------
  function GM_registerMenuCommand(caption, handler) {
    var idHolder = { id: 0 };
    __rpc("menu.register", { scriptId: __scriptId, caption: caption }).then(function (id) {
      idHolder.id = id;
      __menuCallbacks.set(id, handler);
    });
    // Returns a synchronous handle (the actual id is filled async).
    return idHolder;
  }
  function GM_unregisterMenuCommand(handle) {
    var id = handle && handle.id ? handle.id : handle;
    if (typeof id === "number") {
      __menuCallbacks.delete(id);
      __rpc("menu.unregister", { id: id });
    }
  }

  // ---- GM_xmlhttpRequest ----------------------------------------------------
  function GM_xmlhttpRequest(opts) {
    opts = opts || {};
    var requestId = __genRequestId();
    var rpcId = __nextRpcId++;
    __xhrCallbacks.set(rpcId, { opts: opts });
    var req = {
      type: "gm-xhr",
      requestId: requestId,
      url: opts.url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      data: opts.data == null ? null : (typeof opts.data === "string" ? opts.data : String(opts.data)),
      responseType: opts.responseType || "",
      timeout: opts.timeout || 0,
      user: opts.user || "",
      password: opts.password || "",
      binary: !!opts.binary,
      scriptId: __scriptId,
    };
    // Bridge the rpcId↔requestId: bouncer indexes by requestId, but we look up callbacks by rpcId.
    __xhrCallbacks.set(requestId, __xhrCallbacks.get(rpcId));
    __pendingRpc.set(rpcId, { resolve: function () {}, reject: function () {} });
    window.postMessage(
      { type: "rpc", channel: __channel, scriptId: __scriptId, rpcId: rpcId, call: "xhr", params: req },
      window.location.origin,
    );
    return {
      abort: function () {
        __xhrCallbacks.delete(requestId);
        __xhrCallbacks.delete(rpcId);
        window.postMessage(
          { type: "rpc", channel: __channel, scriptId: __scriptId, rpcId: __nextRpcId++, call: "xhr.abort", params: { requestId: requestId } },
          window.location.origin,
        );
      },
    };
  }

  // ---- unsafeWindow / window.close / window.focus ---------------------------
  var unsafeWindow = window;
  // window.close / focus are already on window; no shim needed in MAIN world.

  // ---- GM.* Promise variants ------------------------------------------------
  var GM = {
    info: GM_info,
    setValue: function (name, value) { GM_setValue(name, value); return Promise.resolve(); },
    getValue: function (name, fallback) { return Promise.resolve(GM_getValue(name, fallback)); },
    deleteValue: function (name) { GM_deleteValue(name); return Promise.resolve(); },
    listValues: function () { return Promise.resolve(GM_listValues()); },
    addStyle: function (css) { return Promise.resolve(GM_addStyle(css)); },
    setClipboard: function (text) { GM_setClipboard(text); return Promise.resolve(); },
    notification: function (opts, ondone) { return new Promise(function (res) { GM_notification(opts, function () { if (ondone) ondone(); res(undefined); }); }); },
    openInTab: function (url, opts) { return Promise.resolve(GM_openInTab(url, opts)); },
    registerMenuCommand: function (caption, handler) { return Promise.resolve(GM_registerMenuCommand(caption, handler)); },
    unregisterMenuCommand: function (handle) { GM_unregisterMenuCommand(handle); return Promise.resolve(); },
    download: function (arg, name) { GM_download(arg, name); return Promise.resolve(); },
    getResourceText: function (name) { return Promise.resolve(GM_getResourceText(name)); },
    getResourceUrl: function (name) { return Promise.resolve(GM_getResourceURL(name)); },
    xmlHttpRequest: GM_xmlhttpRequest,
    log: function (msg) { GM_log(msg); return Promise.resolve(); },
  };

  ${requireBlock}

  try {
    ${script.source}
  } catch (e) {
    console.error("[userscript:" + GM_info.script.name + "] threw:", e);
  }
})();
`;

  return runtime;
}
