/** Default account and new schedule timezone, including Sydney daylight-saving changes. */
export const DEFAULT_TIME_ZONE = "Australia/Sydney";

/** Validate and canonicalize an IANA timezone; fixed numeric offsets are not accepted. */
export function normalizeTimeZone(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /^[+-]/.test(value.trim())) {
    throw new Error("Choose a valid IANA timezone.");
  }
  try { return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone; }
  catch { throw new Error("Choose a valid IANA timezone."); }
}

/** Searchable timezone choices supported by this runtime, including UTC and the saved selection. */
export function timeZoneChoices(selected = DEFAULT_TIME_ZONE): string[] {
  return [...new Set([DEFAULT_TIME_ZONE, "UTC", normalizeTimeZone(selected), ...Intl.supportedValuesOf("timeZone")])].toSorted();
}
