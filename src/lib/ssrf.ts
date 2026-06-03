/**
 * SSRF protection: detect private/internal hostnames and IP ranges.
 * Used to validate webhook URLs before registration.
 */

export function isPrivateHostname(hostname: string): boolean {
  // Strip IPv6 brackets
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // Localhost
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "[::]") return true;

  // IPv6 loopback/link-local/unique-local
  if (h.startsWith("fe80:") || h.startsWith("fc00:") || h.startsWith("fd")) return true;

  // IPv4 ranges
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;               // 127.0.0.0/8
    if (a === 10) return true;                 // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;   // 192.168.0.0/16
    if (a === 169 && b === 254) return true;   // 169.254.0.0/16 (link-local)
    if (a === 0) return true;                  // 0.0.0.0/8
  }

  // Cloud metadata endpoints
  if (h === "metadata.google.internal" || h === "instance-data") return true;

  return false;
}

/**
 * Validate a webhook URL: must be http(s), not point to private addresses.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url must be a valid URL";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "url must use https or http protocol";
  }

  if (isPrivateHostname(parsed.hostname)) {
    return "url must not point to a private or internal address";
  }

  return null;
}
