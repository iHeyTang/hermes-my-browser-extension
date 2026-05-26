import { javascript } from "@codemirror/lang-javascript";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { useEffect, useRef, useState } from "react";

import { Button } from "~components/ui/button";
import { useT } from "~lib/i18n";
import { useDocumentTheme } from "~lib/theme";

interface Props {
  initialSource: string;
  onSave: (source: string) => Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  title?: string;
}

const DEFAULT_TEMPLATE = `// ==UserScript==
// @name         New Userscript
// @namespace    hermes
// @version      0.1.0
// @description  Describe what this script does
// @author       me
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  console.log('Hello from userscript!', GM_info.script.name);
})();
`;

// A theme that hooks the editor up to the surrounding shadcn tokens, so the
// editor's background, gutters and selection follow the active palette.
// Used in light mode; dark mode keeps `oneDark` for its better syntax
// contrast.
const LIGHT_EDITOR_THEME = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "hsl(var(--foreground))",
    },
    ".cm-content": { caretColor: "hsl(var(--foreground))" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "hsl(var(--muted-foreground))",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(var(--accent) / 0.4)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "hsl(var(--accent) / 0.4)",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "hsl(var(--primary) / 0.18)",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "hsl(var(--primary) / 0.25)",
    },
    ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
  },
  { dark: false },
);

function pickEditorTheme(theme: "light" | "dark"): Extension {
  return theme === "dark" ? oneDark : LIGHT_EDITOR_THEME;
}

export function ScriptEditor({
  initialSource,
  onSave,
  onCancel,
  busy,
  title,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment>(new Compartment());
  const [error, setError] = useState<string | null>(null);
  const documentTheme = useDocumentTheme();
  const { t } = useT();

  useEffect(() => {
    if (!ref.current) return;
    const themeCompartment = themeCompartmentRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialSource || DEFAULT_TEMPLATE,
        extensions: [
          lineNumbers(),
          keymap.of(defaultKeymap),
          javascript(),
          themeCompartment.of(pickEditorTheme(documentTheme)),
          EditorView.theme({
            "&": { fontSize: "13px", height: "100%" },
            ".cm-scroller": {
              fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
            },
          }),
        ],
      }),
      parent: ref.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We deliberately initialise the editor once; theme changes are pushed
    // through the compartment in the effect below so we don't lose document
    // state (cursor, undo history) on theme flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        pickEditorTheme(documentTheme),
      ),
    });
  }, [documentTheme]);

  async function save() {
    setError(null);
    const v = viewRef.current;
    if (!v) return;
    const source = v.state.doc.toString();
    try {
      await onSave(source);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          {title || t("options.scripts.editor.editTitle", { name: "" })}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <span className="text-xs text-destructive">{error}</span>
          )}
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
      <div
        ref={ref}
        className="min-h-[480px] flex-1 overflow-hidden rounded-lg border border-border bg-muted/20"
      />
    </div>
  );
}
