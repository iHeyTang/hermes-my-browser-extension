/**
 * Composer quick actions — preset prompt templates the user can fire from
 * a chip strip next to the chat input.
 *
 * Model:
 *   - A small set of *builtins* (translate / summarize / polish / explain)
 *     whose label, tooltip, and template text come from the i18n catalog,
 *     so they pick up the user's UI language automatically.
 *   - A user-managed list of *custom* actions: free-form label + template.
 *   - One persisted record in `chrome.storage.local` glues the two: which
 *     builtins are hidden, what custom actions exist, and the user's
 *     preferred ordering across both groups.
 *
 * Template placeholder: `{input}` is substituted with whatever the user
 * typed in the composer. If a template has no `{input}` token we just
 * append the user's text on a new line.
 */

import { useCallback, useEffect, useState } from "react";

import type { MessageKey, TranslateFn } from "~lib/i18n";

export const QUICK_ACTIONS_STORAGE_KEY = "settings.composer.quickActions";

/** Stable IDs for the builtin actions — used as ordering anchors and storage keys. */
export const BUILTIN_IDS = ["translate", "summarize", "polish", "explain"] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

export interface CustomQuickAction {
  /** Stable id ("c-…"). Reordering and disable lists key off this. */
  id: string;
  label: string;
  /** Optional short tooltip; falls back to the label. */
  tooltip?: string;
  /** Prompt body. `{input}` is replaced with the user's composer text. */
  template: string;
}

interface PersistedConfig {
  /** Builtin ids the user has explicitly hidden. */
  builtinDisabled: BuiltinId[];
  /** User-defined actions. */
  custom: CustomQuickAction[];
  /** Order across builtin ids + custom ids. Items missing here fall back to defaults. */
  order: string[];
}

/** What a chip needs to render — already resolved against i18n. */
export interface ResolvedQuickAction {
  /** Stable key. Builtin ids stay as their string id; custom ids are "c-…". */
  id: string;
  builtin: BuiltinId | null;
  label: string;
  tooltip: string;
  template: string;
}

const EMPTY_CONFIG: PersistedConfig = {
  builtinDisabled: [],
  custom: [],
  order: [],
};

const BUILTIN_LABEL_KEYS: Record<BuiltinId, MessageKey> = {
  translate: "composer.quick.translate.label",
  summarize: "composer.quick.summarize.label",
  polish: "composer.quick.polish.label",
  explain: "composer.quick.explain.label",
};

const BUILTIN_TOOLTIP_KEYS: Record<BuiltinId, MessageKey> = {
  translate: "composer.quick.translate.tooltip",
  summarize: "composer.quick.summarize.tooltip",
  polish: "composer.quick.polish.tooltip",
  explain: "composer.quick.explain.tooltip",
};

const BUILTIN_TEMPLATE_KEYS: Record<BuiltinId, MessageKey> = {
  translate: "composer.quick.translate.template",
  summarize: "composer.quick.summarize.template",
  polish: "composer.quick.polish.template",
  explain: "composer.quick.explain.template",
};

/**
 * Render a template against the user's composer text.
 * If the template has no `{input}` placeholder we just append the user's
 * text on a new line so chips remain useful with hand-edited templates.
 */
export function renderQuickActionPrompt(
  template: string,
  userInput: string,
): string {
  const trimmedInput = userInput.trim();
  if (template.includes("{input}")) {
    return template.replaceAll("{input}", trimmedInput);
  }
  if (!trimmedInput) return template;
  return `${template.trimEnd()}\n\n${trimmedInput}`;
}

function isValidCustom(v: unknown): v is CustomQuickAction {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<CustomQuickAction>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.label === "string" &&
    o.label.length > 0 &&
    typeof o.template === "string" &&
    o.template.length > 0
  );
}

function normaliseConfig(v: unknown): PersistedConfig {
  if (!v || typeof v !== "object") return { ...EMPTY_CONFIG };
  const o = v as Partial<PersistedConfig>;
  const disabled = Array.isArray(o.builtinDisabled)
    ? o.builtinDisabled.filter((x): x is BuiltinId =>
        (BUILTIN_IDS as readonly string[]).includes(x as string),
      )
    : [];
  const custom = Array.isArray(o.custom) ? o.custom.filter(isValidCustom) : [];
  const order = Array.isArray(o.order)
    ? o.order.filter((x): x is string => typeof x === "string")
    : [];
  return { builtinDisabled: disabled, custom, order };
}

async function loadConfig(): Promise<PersistedConfig> {
  try {
    const r = await chrome.storage.local.get([QUICK_ACTIONS_STORAGE_KEY]);
    return normaliseConfig(r[QUICK_ACTIONS_STORAGE_KEY]);
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

async function saveConfig(next: PersistedConfig): Promise<void> {
  await chrome.storage.local.set({ [QUICK_ACTIONS_STORAGE_KEY]: next });
}

/**
 * Resolve the persisted config + active translator into an ordered list of
 * chips the composer can render directly. Hidden builtins are dropped;
 * custom actions are appended in their stored relative order. The combined
 * `config.order` array (if present) decides the cross-group sequence —
 * any id missing from `order` falls back to the natural order (builtins
 * first in declaration order, customs in their array order).
 */
export function resolveQuickActions(
  config: PersistedConfig,
  t: TranslateFn,
): ResolvedQuickAction[] {
  const disabled = new Set(config.builtinDisabled);
  const visibleBuiltins: ResolvedQuickAction[] = BUILTIN_IDS.filter(
    (id) => !disabled.has(id),
  ).map((id) => ({
    id,
    builtin: id,
    label: t(BUILTIN_LABEL_KEYS[id]),
    tooltip: t(BUILTIN_TOOLTIP_KEYS[id]),
    template: t(BUILTIN_TEMPLATE_KEYS[id]),
  }));
  const customs: ResolvedQuickAction[] = config.custom.map((c) => ({
    id: c.id,
    builtin: null,
    label: c.label,
    tooltip: c.tooltip && c.tooltip.length > 0 ? c.tooltip : c.label,
    template: c.template,
  }));
  const byId = new Map<string, ResolvedQuickAction>();
  for (const a of [...visibleBuiltins, ...customs]) byId.set(a.id, a);

  const out: ResolvedQuickAction[] = [];
  const seen = new Set<string>();
  for (const id of config.order) {
    const hit = byId.get(id);
    if (hit && !seen.has(id)) {
      out.push(hit);
      seen.add(id);
    }
  }
  for (const a of visibleBuiltins) {
    if (!seen.has(a.id)) {
      out.push(a);
      seen.add(a.id);
    }
  }
  for (const a of customs) {
    if (!seen.has(a.id)) {
      out.push(a);
      seen.add(a.id);
    }
  }
  return out;
}

export interface QuickActionsController {
  ready: boolean;
  config: PersistedConfig;
  /** Toggle a builtin on/off. */
  setBuiltinEnabled: (id: BuiltinId, enabled: boolean) => Promise<void>;
  addCustom: (
    input: { label: string; tooltip?: string; template: string },
  ) => Promise<void>;
  updateCustom: (
    id: string,
    patch: Partial<Omit<CustomQuickAction, "id">>,
  ) => Promise<void>;
  removeCustom: (id: string) => Promise<void>;
  /** Move the chip at `fromIndex` to `toIndex` in the cross-group order. */
  reorder: (orderedIds: string[]) => Promise<void>;
  resetToDefaults: () => Promise<void>;
}

function nextCustomId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useQuickActionsController(): QuickActionsController {
  const [config, setConfig] = useState<PersistedConfig>(EMPTY_CONFIG);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void loadConfig().then((c) => {
      if (!mounted) return;
      setConfig(c);
      setReady(true);
    });
    const onChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const c = changes[QUICK_ACTIONS_STORAGE_KEY];
      if (!c) return;
      setConfig(normaliseConfig(c.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const mutate = useCallback(
    async (update: (prev: PersistedConfig) => PersistedConfig) => {
      // Read-modify-write against the latest disk state so concurrent edits
      // from another surface (options page open in another tab) don't get
      // clobbered by an in-memory React state that's a few ms behind.
      const fresh = await loadConfig();
      const next = update(fresh);
      await saveConfig(next);
      // onChanged listener will sync local state.
    },
    [],
  );

  const setBuiltinEnabled = useCallback<
    QuickActionsController["setBuiltinEnabled"]
  >(
    async (id, enabled) => {
      await mutate((prev) => {
        const set = new Set(prev.builtinDisabled);
        if (enabled) set.delete(id);
        else set.add(id);
        return { ...prev, builtinDisabled: [...set] };
      });
    },
    [mutate],
  );

  const addCustom = useCallback<QuickActionsController["addCustom"]>(
    async ({ label, tooltip, template }) => {
      const cleanLabel = label.trim();
      const cleanTemplate = template.trim();
      if (!cleanLabel || !cleanTemplate) return;
      await mutate((prev) => {
        const next: CustomQuickAction = {
          id: nextCustomId(),
          label: cleanLabel,
          template: cleanTemplate,
          ...(tooltip && tooltip.trim().length > 0
            ? { tooltip: tooltip.trim() }
            : {}),
        };
        return { ...prev, custom: [...prev.custom, next] };
      });
    },
    [mutate],
  );

  const updateCustom = useCallback<QuickActionsController["updateCustom"]>(
    async (id, patch) => {
      await mutate((prev) => ({
        ...prev,
        custom: prev.custom.map((c) =>
          c.id === id
            ? {
                ...c,
                ...(patch.label !== undefined
                  ? { label: patch.label.trim() }
                  : {}),
                ...(patch.template !== undefined
                  ? { template: patch.template.trim() }
                  : {}),
                ...(patch.tooltip !== undefined
                  ? { tooltip: patch.tooltip.trim() }
                  : {}),
              }
            : c,
        ),
      }));
    },
    [mutate],
  );

  const removeCustom = useCallback<QuickActionsController["removeCustom"]>(
    async (id) => {
      await mutate((prev) => ({
        ...prev,
        custom: prev.custom.filter((c) => c.id !== id),
        order: prev.order.filter((x) => x !== id),
      }));
    },
    [mutate],
  );

  const reorder = useCallback<QuickActionsController["reorder"]>(
    async (orderedIds) => {
      await mutate((prev) => ({ ...prev, order: [...orderedIds] }));
    },
    [mutate],
  );

  const resetToDefaults = useCallback<
    QuickActionsController["resetToDefaults"]
  >(async () => {
    await saveConfig({ ...EMPTY_CONFIG });
  }, []);

  return {
    ready,
    config,
    setBuiltinEnabled,
    addCustom,
    updateCustom,
    removeCustom,
    reorder,
    resetToDefaults,
  };
}

/**
 * Read-only hook for the composer — re-renders when the stored config or
 * locale changes. Returns the ordered, ready-to-render chip list.
 */
export function useQuickActions(t: TranslateFn): {
  ready: boolean;
  actions: ResolvedQuickAction[];
} {
  const [config, setConfig] = useState<PersistedConfig>(EMPTY_CONFIG);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void loadConfig().then((c) => {
      if (!mounted) return;
      setConfig(c);
      setReady(true);
    });
    const onChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const c = changes[QUICK_ACTIONS_STORAGE_KEY];
      if (!c) return;
      setConfig(normaliseConfig(c.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return { ready, actions: resolveQuickActions(config, t) };
}
