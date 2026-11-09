/** Share a shutdown invocation across repeated signals and callers. */
export function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(action));
}

/** A deadline whose timer is always removed, including when work rejects. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
