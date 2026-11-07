import type { ReactNode } from "react";
import { Card } from "./ui.tsx";

/** One section of the Settings page: a heading and a card. */
export function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <h2 id={`${id}-title`} className="text-sm font-medium">
        {title}
      </h2>
      <Card className="p-5">{children}</Card>
    </section>
  );
}
