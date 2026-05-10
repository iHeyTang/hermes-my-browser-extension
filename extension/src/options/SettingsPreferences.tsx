import { Label } from "~components/ui/label";
import { cn } from "~lib/utils";
import {
  type ThemePreference,
  useStoredThemePreference,
} from "~lib/theme";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "跟随浏览器",
    description: "使用浏览器 / 系统的浅色或深色偏好（prefers-color-scheme）。",
  },
  {
    value: "light",
    label: "浅色",
    description: "始终使用浅色界面。",
  },
  {
    value: "dark",
    label: "深色",
    description: "始终使用深色界面。",
  },
];

/** Extension UI preferences (theme, etc.) — not gateway or Hermes CLI. */
export function SettingsPreferences() {
  const [themePref, setThemePref] = useStoredThemePreference();
  const themeDescription = THEME_OPTIONS.find((o) => o.value === themePref)
    ?.description;

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label className="shrink-0">Theme</Label>
          <div
            className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-md bg-muted/40 p-1"
            role="radiogroup"
            aria-label="Theme"
          >
            {THEME_OPTIONS.map((opt) => {
              const active = themePref === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void setThemePref(opt.value)}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {themeDescription && (
            <p className="text-xs text-muted-foreground">{themeDescription}</p>
          )}
        </div>
      </section>
    </div>
  );
}
