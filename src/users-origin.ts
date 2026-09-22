/**
 * Browser callers of POST /users must come from travelsats.ar.
 * A missing Origin is allowed: the Vercel registration proxy does not send one.
 */
export function isAllowedUsersOrigin(origin: string | null | undefined): boolean {
  if (origin == null) return true;
  const trimmed = origin.trim();
  if (trimmed === "") return true;

  let host: string;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  return host === "travelsats.ar" || host.endsWith(".travelsats.ar");
}
