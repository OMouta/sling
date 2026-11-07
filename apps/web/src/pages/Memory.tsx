import { Brain } from "lucide-react";
import { Page } from "../components/Page.tsx";
import { Empty } from "../components/ui.tsx";

export function MemoryPage() {
  return (
    <Page title="Memory">
      <Empty fill icon={Brain} title="Nothing remembered yet" />
    </Page>
  );
}
