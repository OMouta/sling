import {
  Activity,
  Box,
  Brain,
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
    | "/memory"
    | "/tasks"
    | "/approvals"
    | "/workflows"
    | "/connectors"
    | "/extensions"
    | "/machines"
    | "/sandboxes"
    | "/checks"
    | "/settings";
  label: string;
  icon: LucideIcon;
  section: "main" | "automation" | "infrastructure" | "footer";
}

/** Every top-level page, in sidebar order. */
export const NAV: NavItem[] = [
  { to: "/personalities", label: "Personalities", icon: Drama, section: "main" },
  { to: "/memory", label: "Memory", icon: Brain, section: "main" },
  { to: "/tasks", label: "Tasks", icon: ListChecks, section: "main" },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck, section: "main" },
  { to: "/workflows", label: "Workflows", icon: Workflow, section: "automation" },
  { to: "/connectors", label: "Connectors", icon: Plug, section: "automation" },
  { to: "/extensions", label: "Extensions", icon: Puzzle, section: "automation" },
  { to: "/machines", label: "Machines", icon: Laptop, section: "infrastructure" },
  { to: "/sandboxes", label: "Sandboxes", icon: Box, section: "infrastructure" },
  { to: "/checks", label: "Checks", icon: Activity, section: "infrastructure" },
  { to: "/settings", label: "Settings", icon: Settings, section: "footer" },
];
