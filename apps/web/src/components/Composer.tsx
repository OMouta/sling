import { ArrowUp, FlaskConical, Paperclip, Plus } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
} from "react";
import type { Dictation } from "../lib/dictation.ts";
import { sendsOnEnter } from "../lib/keys.ts";
import { MicButton } from "./MicButton.tsx";
import { Button, cx, ErrorText, Menu, MenuItem } from "./ui.tsx";

/**
 * The message box on the new chat screen and in a chat. The pages own what's
 * typed and what it's sent with; the composer lays it out and passes on
 * files that are pasted or dropped on it.
 */
export function Composer({
  text,
  setText,
  onSubmit,
  inputRef,
  dictation,
  placeholder,
  variant,
  busy,
  disabled,
  canSend,
  error,
  controls,
  above,
  overlay,
  plus,
  onKeyDown,
  onFiles,
}: {
  text: string;
  setText: (text: string) => void;
  onSubmit: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  dictation: Dictation;
  placeholder: string;
  /** `start` is the new chat screen's taller box with a Start button, `reply` a chat's. */
  variant: "start" | "reply";
  busy: boolean;
  /** Nothing can be typed or sent, such as before Sling can chat. */
  disabled?: boolean;
  /** Whether Send is on. Text alone is enough when this isn't given. */
  canSend?: boolean;
  error?: unknown;
  /** The model and mode pickers. */
  controls: ReactNode;
  /** Between the box's top edge and the text: file chips and the Deep research chip. */
  above?: ReactNode;
  /** Floats above the box, such as the list of personalities to @mention. */
  overlay?: ReactNode;
  /** What the + menu offers. Without either, there's no + button. */
  plus?: ComposerPlus;
  /** Runs before the composer's own keys. Return true when it used the key. */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Files pasted or dropped on the composer. */
  onFiles?: (files: File[]) => void;
}) {
  const start = variant === "start";
  const sendable = canSend ?? Boolean(text.trim());

  // A chat's box grows with its text, up to a limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure when the text changes.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || start) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text, start]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sendable || busy || disabled) return;
    onSubmit();
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!onFiles || files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = [...e.dataTransfer.files];
    if (!onFiles || files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  };

  const send = start ? (
    <Button
      type="submit"
      variant="primary"
      icon={ArrowUp}
      busy={busy}
      disabled={disabled || !sendable}
    >
      Start
    </Button>
  ) : (
    <Button
      type="submit"
      variant="primary"
      iconOnly
      icon={ArrowUp}
      aria-label="Send"
      busy={busy}
      disabled={disabled || !sendable}
    />
  );

  return (
    <form onSubmit={submit}>
      <div className="relative">
        {overlay}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut; Add files in the + menu does the same from the keyboard. */}
        <div
          onDragOver={onFiles ? (e) => e.preventDefault() : undefined}
          onDrop={onFiles ? onDrop : undefined}
          className={cx(
            "rounded-2xl bg-surface shadow-card transition-shadow duration-150 has-[textarea:focus]:shadow-focus",
            start && disabled && "opacity-60",
          )}
        >
          {above}
          <textarea
            ref={inputRef}
            rows={start ? 3 : 1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (onKeyDown?.(e)) return;
              if (sendsOnEnter(e)) submit(e);
            }}
            aria-label="Message"
            placeholder={dictation.listening ? "Listening…" : placeholder}
            className={cx(
              "block w-full resize-none bg-transparent px-4 text-sm outline-none placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed",
              start ? "pt-3.5 pb-1 leading-6" : "min-h-[44px] pt-3 pb-1 leading-5",
            )}
            disabled={disabled}
          />
          <div className={cx("flex items-center gap-2 px-2 pb-2", start && "pt-1")}>
            {plus && <PlusMenu plus={plus} disabled={disabled} />}
            <div className="min-w-0 flex-1">{controls}</div>
            <div className="flex shrink-0 items-center gap-2">
              {start && <ErrorText error={error} />}
              <MicButton dictation={dictation} disabled={disabled} />
              {send}
            </div>
          </div>
        </div>
      </div>
      {!start && (
        <div className="mt-1.5 px-1">
          <ErrorText error={error} />
        </div>
      )}
    </form>
  );
}

export interface ComposerPlus {
  /** Opens the file picker. */
  onAddFiles?: () => void;
  /** Deep research for the next message, where the personality and model can search. */
  research?: { on: boolean; toggle: () => void };
}

function PlusMenu({ plus, disabled }: { plus: ComposerPlus; disabled?: boolean | undefined }) {
  if (!plus.onAddFiles && !plus.research) return null;
  return (
    <Menu
      label="Add to your message"
      align="start"
      side="top"
      trigger={({ open, toggle }) => (
        <Button
          variant="ghost"
          iconOnly
          icon={Plus}
          aria-label="Add to your message"
          aria-expanded={open}
          onClick={toggle}
          disabled={disabled}
        />
      )}
    >
      {plus.onAddFiles && (
        <MenuItem icon={Paperclip} onSelect={plus.onAddFiles}>
          Add files
        </MenuItem>
      )}
      {plus.research && (
        <MenuItem
          icon={FlaskConical}
          onSelect={plus.research.toggle}
          trailing={plus.research.on ? "On" : undefined}
        >
          Deep research
        </MenuItem>
      )}
    </Menu>
  );
}
