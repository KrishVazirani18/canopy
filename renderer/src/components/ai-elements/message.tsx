import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown, defaultComponents, defaultRemarkPlugins, type Components, type LinkSafetyModalProps } from "streamdown";
import { RunnableCode, RunnableReplies, SHELL_LANGS } from "@/components/canopy/run-block";
import { plainCommand } from "@/lib/run-report";
import { LinkConfirm, opensTrusted } from "@/components/canopy/link-confirm";
import { ReplySources, splitSources } from "@/components/canopy/reply-sources";
import { normalizeMath } from "@/lib/math-delimiters";
import { openReplyPath } from "@/lib/rich-reply";
import { absoluteReplyPath, remarkVisualizeReferences } from "@/lib/visualize-reference";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-body",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Diagrams draw in Canopy's own type, with labels as SVG text. Mermaid's HTML labels wrap only when a label measures
// exactly its 200px limit, and Canopy's window zoom (1/0.9) makes that 199.997, so long labels never wrapped and were
// cut off. SVG labels wrap by measuring words, which zoom doesn't upset.
const mermaid = createMermaidPlugin({
  config: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', htmlLabels: false, flowchart: { htmlLabels: false } },
});
const streamdownPlugins = { cjk, code, math, mermaid };
// A shell block in a chat's reply gets a Run button (run-block.tsx); every other code block is Streamdown's own.
const DefaultCode = defaultComponents.code as React.ComponentType<Record<string, unknown>>;
function Code(props: Record<string, unknown> & { className?: string; children?: React.ReactNode; node?: { properties?: { metastring?: string } } }) {
  const runnable = useContext(RunnableReplies);
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1] ?? "";
  if (!runnable || !("data-block" in props) || (language && !SHELL_LANGS.has(language))) return <DefaultCode {...props} />;
  const kid = props.children;
  const code = typeof kid === "string" ? kid
    : isValidElement<{ children?: unknown }>(kid) && typeof kid.props.children === "string" ? kid.props.children : "";
  // Commands are drawn as a command block with Run (run-block.tsx): a shell block of a few lines, or a block with no
  // language that reads as commands (lib/run-report.ts plainCommand). A long script stays an ordinary code block.
  const command = language ? (code.replace(/\s+$/, "").split("\n").length <= 12 ? code.replace(/\s+$/, "") : null) : plainCommand(code);
  if (command === null) return <DefaultCode {...props} />;
  const line = /startLine=(\d+)/.exec(props.node?.properties?.metastring ?? "")?.[1];
  return <RunnableCode code={code} command={command} language={language} startLine={line ? Number(line) : undefined} />;
}
const DefaultLink = defaultComponents.a;
function ReplyLink(props: ComponentProps<typeof DefaultLink>) {
  const { children, href } = props;
  if (href && absoluteReplyPath(href)) {
    let path = '';
    try { path = decodeURIComponent(href); } catch { /* Invalid URL escape. */ }
    if (absoluteReplyPath(path)) {
      return <a href={href} title="⌥-click to show in Finder" onClick={(e) => {
        e.preventDefault();
        void openReplyPath(path, e.altKey);
      }} onAuxClick={(e) => e.preventDefault()}>{children}</a>;
    }
  }
  return <DefaultLink {...props} />;
}
const COMPONENTS: Components = { code: Code as Components["code"], a: ReplyLink };
const SOURCE_COMPONENTS: Components = { a: ReplyLink };
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkVisualizeReferences];
// Links ask first in Canopy's own dialog; sites you've chosen to trust open straight away.
const LINK_SAFETY = { enabled: true, onLinkCheck: opensTrusted, renderModal: (p: LinkSafetyModalProps) => <LinkConfirm {...p} /> };

/** Plain text blocks (diagrams, trees) that are wider than the column shrink their type to fit, down to 9px, so
 *  they read whole instead of scrolling sideways. Re-measured whenever the content or the column width changes. */
function useFitFigures(ref: React.RefObject<HTMLDivElement | null>, content: unknown) {
  useLayoutEffect(() => {
    const host = ref.current?.firstElementChild as HTMLElement | null; // the wrapper is display:contents
    if (!host) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      for (const pre of host.querySelectorAll<HTMLElement>('[data-streamdown="code-block"][data-language=""] pre')) {
        const box = pre.closest<HTMLElement>('[data-streamdown="code-block-body"]');
        if (!box) continue;
        pre.style.removeProperty("--fig-size");
        const pad = 32; // the body's 16px padding each side
        const room = box.clientWidth - pad, need = box.scrollWidth - pad;
        if (need > room + 1 && room > 0) pre.style.setProperty("--fig-size", `${Math.max(9, Math.floor(13 * (room / need) * 10) / 10)}px`);
      }
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(fit); };
    fit();
    // Code blocks finish rendering after the text (highlighting loads lazily), and the column can change width.
    const ro = new ResizeObserver(soon);
    ro.observe(host);
    const mo = new MutationObserver(soon);
    mo.observe(host, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame); };
  }, [ref, content]);
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    const ref = useRef<HTMLDivElement>(null);
    useFitFigures(ref, props.children);
    // A closing "Sources:" list folds to its first few links (reply-sources.tsx).
    // \( … \) and \[ … \] become dollar math the plugin can draw (math-delimiters.ts).
    const text = typeof props.children === "string" ? normalizeMath(props.children) : null;
    const split = text !== null ? splitSources(text) : null;
    return (
      <div ref={ref} className="contents">
        <Streamdown
          className={cn(
            "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          plugins={streamdownPlugins}
          remarkPlugins={REMARK_PLUGINS}
          linkSafety={LINK_SAFETY}
          components={COMPONENTS}
          {...props}
          {...(text !== null && { children: split ? split.body : text })}
        />
        {split && (
          <ReplySources
            items={split.items}
            render={(md) => (
              <Streamdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" linkSafety={LINK_SAFETY} components={SOURCE_COMPONENTS}>
                {md}
              </Streamdown>
            )}
          />
        )}
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
