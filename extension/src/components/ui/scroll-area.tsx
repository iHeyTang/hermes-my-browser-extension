import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "~lib/utils";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

/**
 * The rail sits flush against the panel's right/bottom edge — Radix's
 * default — so the chat surface (whose sticky question strip extends
 * edge-to-edge via `-mx-3`) doesn't peek out as a visible gutter past
 * the rail. We previously inset the rail by a few pixels to suggest a
 * dedicated gutter, but that left the sticky `bg-background` mask
 * showing in the gap and read as right-side overflow.
 *
 * Stacking-wise, the rail must sit *above* any sticky content inside the
 * Viewport (e.g. the pinned user-question strip on the chat surface,
 * which uses `z-20` plus a `bg-background` mask that extends edge-to-edge
 * via `-mx-3`). The Radix Root has `position: relative` without
 * `z-index`, so it doesn't establish its own stacking context — the
 * scrollbar and the sticky element compete in the same context, and
 * without an explicit z-index here the sticky strip would paint over the
 * thumb. `z-30` keeps the rail visible regardless of inner sticky
 * tricks.
 */

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "z-30 flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
