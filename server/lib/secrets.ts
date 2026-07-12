/** Central redaction helpers for anything persisted or shown to the operator. */

const SECRET_ENV_KEYS = [
  "GITHUB_TOKEN",
  "TWITTER_BEARER_TOKEN",
  "YOUTUBE_API_KEY",
  "G2_TOKEN",
  "OPENAI_API_KEY",
] as const;

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "client_secret",
  "key",
  "secret",
  "token",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove known in-process credentials and common credential-shaped fields. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) out = out.replace(new RegExp(escapeRegExp(secret), "g"), "<redacted>");
  }
  return out
    .replace(
      /([?&](?:access_token|api_?key|apikey|authorization|bearer|client_secret|key|secret|token)=)[^&#\s]*/gi,
      "$1<redacted>"
    )
    .replace(/((?:authorization|bearer|token|secret|api[_ -]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
}

/** Keep a useful request URL for diagnostics without persisting credentials. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "<redacted>");
    }
    return redactSecrets(url.toString());
  } catch {
    return redactSecrets(value);
  }
}

/** Recursively redact strings before event data is persisted or streamed. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
        const sensitive = [...SENSITIVE_QUERY_KEYS].some(
          (candidate) => normalized === candidate.replace(/_/g, "") || normalized.endsWith(candidate.replace(/_/g, ""))
        );
        return [key, sensitive ? "<redacted>" : redactValue(entry)];
      })
    ) as T;
  }
  return value;
}
