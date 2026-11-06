import {
  Box,
  Drama,
  Laptop,
  ListChecks,
  type LucideIcon,
  Plug,
  Puzzle,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";

export interface NavItem {
  to:
    | "/personalities"
    | "/tasks"
    | "/approvals"
    | "/workflows"
    | "/connectors"
    | "/extensions"
    | "/machines"
    | "/sandboxes"
    | "/settings";
  label: string;
  icon: LucideIcon;
  section: "main" | "automation" | "infrastructure" | "footer";
}

/** Every top-level page, in sidebar order. */
export const NAV: NavItem[] = [
  { to: "/personalities", label: "Personalities", icon: Drama, section: "main" },
  { to: "/tasks", label: "Tasks", icon: ListChecks, section: "main" },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck, section: "main" },
  { to: "/workflows", label: "Workflows", icon: Workflow, section: "automation" },
  { to: "/connectors", label: "Connectors", icon: Plug, section: "automation" },
  { to: "/extensions", label: "Extensions", icon: Puzzle, section: "automation" },
  { to: "/machines", label: "Machines", icon: Laptop, section: "infrastructure" },
  { to: "/sandboxes", label: "Sandboxes", icon: Box, section: "infrastructure" },
  { to: "/settings", label: "Settings", icon: Settings, section: "footer" },
];
