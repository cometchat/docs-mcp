// The icon on the sign-in page for the app that is connecting.
//
// 1. A known app, matched by where the sign-in returns to (never by the name,
//    which anyone can choose): our own bundled icon.
// 2. Otherwise, for an app that isn't unverified, the logo_uri it registered,
//    fetched by this server (https only, public addresses only, images only,
//    size-capped) and shown as a data: URI, so the user's browser never
//    contacts the logo's host and the page's CSP stays as strict.
// 3. Otherwise the first letter of its name.
//
// Brand icons: Simple Icons 16.37.0 (CC0-1.0, https://simpleicons.org). The
// marks belong to their owners and are shown only to identify the app.
import https from "node:https";
import { Resolver as DnsResolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ClientIcon =
  | { kind: "app"; app: string; svg: string }
  | { kind: "logo"; src: string }
  | { kind: "initial"; letter: string };

const svg = (d: string, fill: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="${fill}"><path d="${d}"/></svg>`;

const CLAUDE = svg("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", "#D97757");
const CURSOR = svg("M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", "currentColor");
const WINDSURF = svg("M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z", "currentColor");
const ZED = svg("M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z", "#084CCF");

const CLAUDE_CALLBACK_HOSTS = new Set(["claude.ai", "claude.com"]);

/** Known apps, by the return address that only that app can receive the sign-in on. */
const KNOWN_APPS: Array<{ app: string; svg: string; matches: (u: URL) => boolean }> = [
  { app: "Claude", svg: CLAUDE, matches: (u) => (u.protocol === "https:" && CLAUDE_CALLBACK_HOSTS.has(u.hostname) && !u.port && u.pathname === "/api/mcp/auth_callback") || u.protocol === "claude:" },
  { app: "Cursor", svg: CURSOR, matches: (u) => u.protocol === "cursor:" },
  { app: "Windsurf", svg: WINDSURF, matches: (u) => u.protocol === "windsurf:" },
  { app: "Zed", svg: ZED, matches: (u) => u.protocol === "zed:" },
];

/** Our icon for the app this sign-in returns to, if it's one we know. Call only for a "known" redirect. */
export function knownAppIcon(redirectUri: string): Extract<ClientIcon, { kind: "app" }> | undefined {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const hit = KNOWN_APPS.find((k) => k.matches(u));
  return hit ? { kind: "app", app: hit.app, svg: hit.svg } : undefined;
}

export function initialIcon(name: string): Extract<ClientIcon, { kind: "initial" }> {
  return { kind: "initial", letter: name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?" };
}

// ── logo_uri ────────────────────────────────────────────────────────────────

const LOGO_MAX_BYTES = 64 * 1024;
const LOGO_TIMEOUT_MS = 2500;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]);

/** Addresses a logo may never be fetched from: private, loopback, link-local, reserved and the like. */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  // ::/96 covers ::, ::1 and the deprecated IPv4-compatible form; ::ffff:0:0:0/96
  // the IPv4-translated form; fec0::/10 the deprecated site-local range.
  // IPv4-mapped (::ffff:a.b.c.d) needs no entry: BlockList checks those against
  // the IPv4 rules (and a dotted one is checked as IPv4 below). Adding
  // ::ffff:0:0/96 here would block every IPv4 address.
  ["::", 96], ["::ffff:0:0:0", 96], ["fec0::", 10], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** True for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return !BLOCKED.check(address, "ipv4");
  if (v !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return !BLOCKED.check(address, "ipv6");
}

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
/**
 * DNS over c-ares (resolve4/resolve6), not dns.lookup: lookup runs on libuv's
 * small shared thread pool, so slow answers from a hostile DNS server would
 * stall file and crypto work too. One try, short timeout; /etc/hosts is not read.
 */
const dns = new DnsResolver({ timeout: 1500, tries: 1 });
const defaultResolver: Resolver = async (host) => {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  return [
    ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
};

/** The bytes look like the image type the server claimed (SVG is shown only inside <img>, where scripts don't run). */
function looksLike(type: string, b: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  switch (type) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp": return starts(0x52, 0x49, 0x46, 0x46) && b.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/x-icon":
    case "image/vnd.microsoft.icon": return starts(0x00, 0x00, 0x01, 0x00);
    case "image/svg+xml": return /<svg[\s>]/i.test(b.subarray(0, 1024).toString("utf8"));
    default: return false;
  }
}

export interface LogoFetchOptions {
  resolve?: Resolver;
  /** Test hook: replaces https.get. */
  get?: typeof https.get;
  /** Test hook: the overall time limit (DNS + request), default 2.5 s. */
  timeoutMs?: number;
}

/** Resolves to `fallback` once `ms` has passed, unless `p` settles first. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((r) => (t = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(t));
}

/**
 * Fetches an app's logo_uri and returns it as a data: URI, or undefined if it
 * isn't a small image on a public https address. Never throws.
 */
export async function fetchClientLogo(uri: string, opts: LogoFetchOptions = {}): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return undefined;
  }
  if (uri.length > 2000 || u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // One deadline for the whole fetch, DNS included.
  const deadline = Date.now() + (opts.timeoutMs ?? LOGO_TIMEOUT_MS);
  let target: { address: string; family: number };
  try {
    const found = isIP(host) ? [{ address: host, family: isIP(host) }] : await within((opts.resolve ?? defaultResolver)(host), Math.max(0, deadline - Date.now()), []);
    // Every address must be public, and the request goes to the one checked
    // (pinned below), so a DNS answer can't change between check and connect.
    if (found.length === 0 || !found.every((a) => isPublicAddress(a.address))) return undefined;
    target = found[0]!;
  } catch {
    return undefined;
  }
  return new Promise((done) => {
    let settled = false;
    const finish = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      done(v);
    };
    const left = deadline - Date.now();
    if (left <= 0) return done(undefined);
    const timer = setTimeout(() => finish(undefined), left);
    const req = (opts.get ?? https.get)(
      u,
      {
        servername: isIP(host) ? undefined : host,
        lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          o?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)) as never,
        headers: { accept: [...LOGO_TYPES].join(", "), "user-agent": "cometchat-mcp (client logo)" },
      },
      (res) => {
        const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        // No redirects: a redirect could point anywhere, including a private address.
        if (res.statusCode !== 200 || !LOGO_TYPES.has(type) || Number(res.headers["content-length"] ?? 0) > LOGO_MAX_BYTES) return finish(undefined);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > LOGO_MAX_BYTES) return finish(undefined);
          chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          finish(body.length > 0 && looksLike(type, body) ? `data:${type};base64,${body.toString("base64")}` : undefined);
        });
        res.on("error", () => finish(undefined));
      },
    );
    req.on("error", () => finish(undefined));
  });
}

// Fetched logos, by URL: a good one for 6 hours, a failure for 10 minutes.
// At most 200 kept (64 KB each, so a few MB at worst).
const logoCache = new Map<string, { src: string | undefined; until: number }>();
const LOGO_CACHE_MAX = 200;
// Fetches in progress, shared by sign-in pages asking for the same logo.
const inflight = new Map<string, Promise<string | undefined>>();
/** Most logo fetches running at once; beyond it a page just shows the initial. */
export const MAX_LOGO_FETCHES = 8;

export async function cachedClientLogo(uri: string, fetcher: (uri: string) => Promise<string | undefined> = fetchClientLogo): Promise<string | undefined> {
  const hit = logoCache.get(uri);
  if (hit && hit.until > Date.now()) return hit.src;
  const running = inflight.get(uri);
  if (running) return running;
  if (inflight.size >= MAX_LOGO_FETCHES) return undefined;
  const p = fetcher(uri)
    .catch(() => undefined)
    .then((src) => {
      logoCache.delete(uri);
      logoCache.set(uri, { src, until: Date.now() + (src ? 6 * 60 * 60_000 : 10 * 60_000) });
      while (logoCache.size > LOGO_CACHE_MAX) logoCache.delete(logoCache.keys().next().value!);
      return src;
    })
    .finally(() => inflight.delete(uri));
  inflight.set(uri, p);
  return p;
}

export function clearClientLogoCache(): void {
  logoCache.clear();
  inflight.clear();
}
