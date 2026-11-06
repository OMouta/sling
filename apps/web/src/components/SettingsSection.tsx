import type { ReactNode } from "react";
import { Card } from "./ui.tsx";

/** One section of the Settings page: a heading, a line about it, and a card. */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <div>
        <h2 id={`${id}-title`} className="text-sm font-medium">
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-xs leading-[18px] text-muted">{description}</p>
        )}
      </div>
      <Card className="p-5">{children}</Card>
    </section>
  );
}
