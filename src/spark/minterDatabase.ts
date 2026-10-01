/** Schema that holds the minter SDK's own tables (created by migration 0005). */
export const MINTER_SCHEMA = "breez_minter";

/**
 * The connection string the minter's Postgres storage uses: the app database
 * with the search path pinned to the minter schema through the `options`
 * parameter, so the SDK's tables never land in `public`. Other parameters
 * (such as `sslmode`) are preserved and an existing `options` value is merged.
 * `override` (SPARK_MINTER_DATABASE_URL) is used as given.
 */
export function deriveMinterDatabaseUrl(databaseUrl: string, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return explicit;

  const url = new URL(databaseUrl);
  const search = `-c search_path=${MINTER_SCHEMA}`;
  const pairs: string[] = [];
  let options: string | null = null;
  for (const [key, value] of url.searchParams) {
    if (key === "options") {
      options = options === null ? value : `${options} ${value}`;
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  pairs.push(`options=${encodeURIComponent(options === null ? search : `${options} ${search}`)}`);
  url.search = pairs.join("&");
  return url.toString();
}
