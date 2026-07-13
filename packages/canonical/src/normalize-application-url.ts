const trackingParameters = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "yclid", "_gl", "source", "ref", "referrer",
]);

export function normalizeApplicationUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameters.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return url.toString();
}

