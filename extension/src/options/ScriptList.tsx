import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "~components/ui/badge";
import { Button } from "~components/ui/button";
import { Card, CardContent } from "~components/ui/card";
import { Switch } from "~components/ui/switch";

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
  if (!scripts.length) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No userscripts installed yet. Use the buttons above to create or
        import one.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {scripts.map((s) => (
        <Card key={s.id}>
          <CardContent className="flex items-start gap-3 p-3">
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
                  <Badge variant="outline">v{s.meta.version}</Badge>
                )}
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {s.meta.runAt}
                </Badge>
                {s.lastError && (
                  <Badge variant="destructive" title={s.lastError}>
                    error
                  </Badge>
                )}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {s.meta.match.length
                  ? s.meta.match.join(" • ")
                  : "(no @match)"}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onEdit(s.id)}
                title="Edit"
              >
                <Pencil />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onRemove(s.id)}
                title="Remove"
              >
                <Trash2 />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
