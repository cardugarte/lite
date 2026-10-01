import { logger } from "./logger.ts";

export type CapturedLog = { level: string; message: string; args?: Record<string, unknown> };

/** Runs `fn` with the logger at DEBUG and returns the structured entries it wrote. Tests only. */
export async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; entries: CapturedLog[]; raw: string }> {
  const writable = logger as unknown as { levelName: string; handlers: Array<{ levelName: string }> };
  const previousLevel = writable.levelName;
  const previousHandlers = writable.handlers.map((handler) => handler.levelName);
  writable.levelName = "DEBUG";
  for (const handler of writable.handlers) handler.levelName = "DEBUG";
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  try {
    const result = await fn();
    const entries: CapturedLog[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Not a structured entry.
      }
    }
    return { result, entries, raw: lines.join("\n") };
  } finally {
    console.log = original;
    writable.levelName = previousLevel;
    writable.handlers.forEach((handler, index) => {
      handler.levelName = previousHandlers[index];
    });
  }
}

/** Entries whose structured `event` field equals `event`. */
export const entriesFor = (entries: CapturedLog[], event: string): CapturedLog[] =>
  entries.filter((entry) => entry.args?.event === event);
