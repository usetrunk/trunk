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
  if (h.startsWith("fe80:") || h.startsWith("fc00:")) return true;
  // fd00::/8 unique-local — require hex digit after "fd" to avoid matching DNS names like "fdisk.example.com"
  if (/^fd[0-9a-f]{2}:/.test(h)) return true;

  // IPv4-mapped IPv6 — dotted form (::ffff:a.b.c.d)
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    return isPrivateIPv4(mappedDotted[1]);
  }
  // IPv4-mapped IPv6 — hex form (::ffff:XXYY:ZZWW) as normalized by URL parser
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isPrivateIPv4(dotted);
  }

  // IPv4 ranges
  if (isPrivateIPv4(h)) return true;

  // Cloud metadata endpoints
  if (h === "metadata.google.internal" || h === "instance-data") return true;

  return false;
}

function isPrivateIPv4(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  if (a === 127) return true;               // 127.0.0.0/8
  if (a === 10) return true;                 // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;   // 192.168.0.0/16
  if (a === 169 && b === 254) return true;   // 169.254.0.0/16 (link-local / IMDS)
  if (a === 0) return true;                  // 0.0.0.0/8
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
