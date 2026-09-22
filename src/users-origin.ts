import { timingSafeEqual } from "node:crypto";

/**
 * Browser callers of POST /users must come from travelsats.ar.
 * A missing Origin is the server registration proxy, which must present
 * X-Travelsats-Registration instead.
 */
export function isAllowedUsersOrigin(origin: string | null | undefined): boolean {
  if (origin == null) return false;
  const trimmed = origin.trim();
  if (trimmed === "") return false;

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

export function registrationCredentialMatches(
  presented: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (presented == null || secret == null) return false;
  if (presented.trim() === "" || secret.trim() === "") return false;
  const presentedBytes = new TextEncoder().encode(presented);
  const secretBytes = new TextEncoder().encode(secret);
  if (presentedBytes.length !== secretBytes.length) return false;
  return timingSafeEqual(presentedBytes, secretBytes);
}

export function usersRequestAllowed(input: {
  origin: string | null | undefined;
  registrationHeader: string | null | undefined;
  registrationSecret: string | null | undefined;
}): boolean {
  const origin = input.origin?.trim() ?? "";
  if (origin !== "") return isAllowedUsersOrigin(origin);
  return registrationCredentialMatches(input.registrationHeader, input.registrationSecret);
}
