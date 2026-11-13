import type { ReactNode } from "react";
import { artOf } from "trm-ui";

/** Shared character presentation for models and their annotation files. */
export function ModelCard({ id, name, cover, onOpen, disabled = false, children }: {
  id: string;
  name: string;
  cover?: string;
  onOpen?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`group relative min-w-0 rounded-[var(--r)] bg-[var(--group)] p-2.5 ${onOpen ? "cursor-pointer transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--ink)_3%,var(--group))]" : ""}`}
      role={onOpen ? "button" : "group"} tabIndex={onOpen ? 0 : undefined} aria-label={name} aria-disabled={onOpen && disabled || undefined}
      onClick={onOpen ? () => { if (!disabled) onOpen(); } : undefined}
      onKeyDown={onOpen ? event => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (!disabled) onOpen();
        }
      } : undefined}
    >
      <div className="w-full aspect-[4/3] rounded-[calc(var(--r)-4px)] mb-2.5 bg-center bg-cover"
        style={cover ? { backgroundImage: `url("${cover}")` } : { background: artOf(id) }} />
      <div className="text-[13.5px] font-medium leading-tight truncate" title={name}>{name}</div>
      {children}
    </div>
  );
}
