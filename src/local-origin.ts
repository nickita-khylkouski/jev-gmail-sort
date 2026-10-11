// Accept this loopback service and extension requests, never arbitrary websites or rebound hosts.
export function localOrigin(req: Request) {
  const url = new URL(req.url), origin = req.headers.get("Origin");
  const extension = !!origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  return ["localhost", "127.0.0.1"].includes(url.hostname) && (extension || req.headers.get("Sec-Fetch-Site") !== "cross-site") &&
    (!origin || origin === url.origin || extension);
}
