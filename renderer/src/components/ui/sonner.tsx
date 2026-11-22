import { useEffect, useState } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** Follows Canopy's own theme (html.dark), not the OS appearance. Onboarding is always dark (html[data-onboarding]),
 *  so while it is up the toasts are dark as well: the `dark` class on the toaster gives them the dark colours. */
const isDark = () => document.documentElement.classList.contains("dark") || "onboarding" in document.documentElement.dataset
const Toaster = ({ toastOptions, style, className, ...props }: ToasterProps) => {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const o = new MutationObserver(() => setDark(isDark()))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-onboarding"] })
    return () => o.disconnect()
  }, [])

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className={["toaster group", dark && "dark", className].filter(Boolean).join(" ")}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          fontFamily: "inherit",
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          title: "text-ui font-medium",
          description: "text-small text-muted-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
