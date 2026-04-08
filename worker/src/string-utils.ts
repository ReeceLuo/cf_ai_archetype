/** Workers AI and JSON bodies may return non-string values; normalize before .trim(). */
export function asTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}
