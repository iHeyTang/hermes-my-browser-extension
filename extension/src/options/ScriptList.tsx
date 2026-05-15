import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import { Switch } from "~components/ui/switch";
import { useT } from "~lib/i18n";

interface ListItem {
  id: string;
  meta: { name: string; version?: string; match: string[]; runAt: string };
  enabled: boolean;
  updatedAt: number;
  lastError?: string;
}

interface Props {
  scripts: ListItem[];
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}

export function ScriptList({ scripts, onEdit, onRemove, onToggle }: Props) {
  const { t } = useT();
  if (!scripts.length) {
    return (
      <div className="rounded-lg bg-muted/25 p-8 text-center text-sm text-muted-foreground">
        {t("options.scripts.empty")}
      </div>
    );
  }
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-muted/10">
      {scripts.map((s) => (
        <div
          key={s.id}
          className="flex items-start gap-3 bg-muted/10 px-3 py-3 first:rounded-t-lg last:rounded-b-lg"
        >
          <div className="pt-1">
            <Switch
              checked={s.enabled}
              onCheckedChange={(v) => onToggle(s.id, v)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{s.meta.name}</span>
              {s.meta.version && (
                <Badge variant="secondary">v{s.meta.version}</Badge>
              )}
              <Badge variant="secondary" className="font-mono text-[10px]">
                {s.meta.runAt}
              </Badge>
              {s.lastError && (
                <Badge variant="destructive" title={s.lastError}>
                  {t("options.scripts.errorBadge")}
                </Badge>
              )}
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {s.meta.match.length
                ? s.meta.match.join(" • ")
                : t("options.scripts.noMatch")}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onEdit(s.id)}
              title={t("options.scripts.action.edit")}
            >
              <Pencil />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onRemove(s.id)}
              title={t("options.scripts.action.remove")}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
