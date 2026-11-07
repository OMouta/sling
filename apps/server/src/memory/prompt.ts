/** What the prompt tells a personality with the memory tools. */
export function memorySection(): string {
  return [
    "What you remember about the user (remember, recall, forget):",
    "- When the user tells you something that will still be true in later chats, save it with remember: lasting preferences, people and how to reach them, places, routines, and anything they ask you to remember. One fact per call, in a short line.",
    "- Never save a secret such as a password, a key, or a card number, a one-off detail of the task at hand, or anything they asked you to forget. Sling refuses secrets anyway.",
    "- Don't save what you already know about them, or what you saved earlier in this chat.",
    "- The chat shows what you saved, with Undo. Don't ask before saving, and don't repeat it back.",
    "- When they ask you to forget something, find it with recall and delete it with forget.",
    "- When you need something about them you don't already know, such as an older detail, look for it with recall before you ask.",
  ].join("\n");
}
