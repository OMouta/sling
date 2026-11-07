/**
 * Personalities: named assistants, each with its own instructions, the
 * Sling tools it may use, a color, and an animated glyph. A chat keeps the
 * personality it started with.
 */

/** Groups of Sling's assistant tools a personality can be given. */
export const PERSONALITY_TOOLS = ["commands", "coding", "apps", "deploys", "setup"] as const;
export type PersonalityTool = (typeof PERSONALITY_TOOLS)[number];

export const PERSONALITY_TOOL_INFO: Record<
  PersonalityTool,
  { label: string; description: string }
> = {
  commands: {
    label: "Commands on your machines",
    description: "Runs shell commands on your machines.",
  },
  coding: {
    label: "Coding tasks",
    description: "Hands repo work to Codex or Claude Code.",
  },
  apps: {
    label: "Apps and workflows",
    description: "Calendar, workflows and connectors. Asks before sending.",
  },
  deploys: {
    label: "Deploys",
    description: "Deploys finished fixes. Asks first.",
  },
  setup: {
    label: "Change Sling's setup",
    description: "Deploy targets, apps, workflows, personalities and settings. Asks first.",
  },
};

/** Colors a personality can take. The web app holds the values for each theme. */
export const PERSONALITY_COLORS = [
  "violet",
  "blue",
  "cyan",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "pink",
  "silver",
] as const;
export type PersonalityColor = (typeof PERSONALITY_COLORS)[number];

/** Glyph shapes. Each one moves in its own way. */
export const GLYPH_SHAPES = [
  "bloom",
  "drift",
  "star",
  "facet",
  "ripple",
  "loop",
  "orbit",
  "twist",
] as const;
export type GlyphShape = (typeof GLYPH_SHAPES)[number];

export const PERSONALITY_NAME_MAX = 40;
export const PERSONALITY_DESCRIPTION_MAX = 160;
export const PERSONALITY_INSTRUCTIONS_MAX = 20_000;

export interface PersonalityView {
  id: string;
  name: string;
  /** One line under the name, in the switcher and on the new chat screen. */
  description: string;
  /** Who it is and how it answers. Sling adds its own rules for tools, the mode, and the date. */
  instructions: string;
  tools: PersonalityTool[];
  color: PersonalityColor;
  shape: GlyphShape;
  /** Used where nothing picks a personality, such as chats a workflow starts. */
  isDefault: boolean;
  position: number;
  /** Goes up whenever the name, instructions, or tools change. */
  revision: number;
  /** The template it was added from, if any. */
  templateKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A ready-made personality, added from the Personalities page. */
export interface PersonalityTemplateView {
  key: string;
  /** A heading the gallery groups it under. */
  group: string;
  name: string;
  description: string;
  instructions: string;
  tools: PersonalityTool[];
  color: PersonalityColor;
  shape: GlyphShape;
}

/** Which personality wrote a reply, as it was then. */
export interface ReplyPersonality {
  id: string;
  revision: number;
}
