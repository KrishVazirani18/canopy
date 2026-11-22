import * as React from "react"
import { cn } from "@/lib/utils"

/** Keyboard shortcut glyphs (⌘N, ⇧⇥, Esc). Styled by `.kbd` in index.css. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("kbd", className)} {...props} />
}
