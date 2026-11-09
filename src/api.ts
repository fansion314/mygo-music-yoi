// NetEase protocol adapted from the preserved mygo-cloudmusic implementation.
// The EAPI key is a public protocol constant, not an account credential.
import { fail, t } from "./model";
import type { Raw } from "./types";

const SITE = "https://music.163.com";
const EAPI_SITE = "https://interfacepc.music.163.com";
const EAPI_KEY = "e82ckenh8dichen8";
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
// The desktop endpoint must see the same client in its HTTP User-Agent,
// encrypted payload and Cookie header. Keep these values together so updating
// the client version cannot leave an unrelated mobile identity behind.
const DESKTOP_CLIENT = {
  os: "pc",
  appver: "3.1.17.204416",
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  channel: "netease",
  versioncode: "140",
} as const;
const EAPI_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/91.0.4472.164 Safari/537.36 NeteaseMusicDesktop/${DESKTOP_CLIENT.appver}`;
const COOKIE_NAMES = new Set(["MUSIC_U", "__csrf", "NMTID", "MUSIC_A"]);
const REQUEST_TIMEOUT = 20_000;
type Cookie = { name: string; value: string; expires?: number };
let epoch = 0;
const listeners = new Set<() => void>();

export const sessionEpoch = (): number => epoch;
export function onSessionChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
function notify(): void {
  for (const callback of listeners) callback();
}
export function clearSession(): void {
  epoch++;
  host.storage.remove("session");
  notify();
}
function readCookies(): Cookie[] {
  const stored = host.storage.get("session");
  if (stored?.version !== 1 || !Array.isArray(stored.cookies)) return [];
  const valid = (cookie: Cookie): boolean =>
    !!cookie &&
    COOKIE_NAMES.has(cookie.name) &&
    typeof cookie.value === "string" &&
    !/[\r\n;]/.test(cookie.value);
  const all = stored.cookies.filter(valid) as Cookie[];
  const live = all.filter(
    (cookie) =>
      cookie.expires === undefined ||
      (Number.isFinite(cookie.expires) && cookie.expires > Date.now()),
  );
  if (
    all.some((cookie) => cookie.name === "MUSIC_U") &&
    !live.some((cookie) => cookie.name === "MUSIC_U")
  ) {
    clearSession();
    return [];
  }
  return live;
}
export const hasSession = (): boolean =>
  readCookies().some((cookie) => cookie.name === "MUSIC_U" && cookie.value !== "");

function setCookieLines(headers: Headers): string[] {
  // moejs and current Node both expose getSetCookie. The fallback handles
  // combined headers without treating the comma in an Expires date as a split.
  const native = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (native) return native.call(headers);
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}
function mergeCookies(headers: Headers, started: number): void {
  if (started !== epoch) return;
  const cookies = new Map(readCookies().map((cookie) => [cookie.name, cookie]));
  if (started !== epoch) return;
  const before = cookies.get("MUSIC_U")?.value;
  let changed = false;
  for (const line of setCookieLines(headers)) {
    const parts = line.split(";");
    const pair = parts.shift() || "";
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!COOKIE_NAMES.has(name) || /[\r\n;]/.test(value)) continue;
    let expires: number | undefined;
    let maxAge: number | undefined;
    let domain: string | undefined;
    for (const part of parts) {
      const eq = part.indexOf("=");
      const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
      const attribute = eq < 0 ? "" : part.slice(eq + 1).trim();
      if (key === "max-age" && /^-?\d+$/.test(attribute)) maxAge = Number(attribute);
      if (key === "expires") {
        const date = Date.parse(attribute);
        if (Number.isFinite(date)) expires = date;
      }
      if (key === "domain") domain = attribute.toLowerCase().replace(/^\./, "");
    }
    // Like the old client's shared API jar, the site and desktop endpoint
    // share account cookies, but unrelated domains can never provide them.
    if (
      domain &&
      domain !== "music.163.com" &&
      domain !== "163.com" &&
      domain !== "interfacepc.music.163.com"
    )
      continue;
    if (maxAge !== undefined) expires = Date.now() + maxAge * 1000;
    if (!value || (expires !== undefined && expires <= Date.now())) cookies.delete(name);
    else cookies.set(name, { name, value, ...(expires === undefined ? {} : { expires }) });
    changed = true;
  }
  if (!changed) return;
  if (before && !cookies.get("MUSIC_U")?.value) {
    clearSession();
    return;
  }
  host.storage.set("session", { version: 1, cookies: [...cookies.values()] });
  if (before !== cookies.get("MUSIC_U")?.value) notify();
}

function pathOf(path: string): string {
  if (!/^\/api\/[A-Za-z0-9_/-]+$/.test(path)) throw new Error("Invalid NetEase API path");
  return path;
}
function formOf(data: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params;
}

// JSON.parse would round long service IDs before callers could stringify them.
// Scan tokens outside strings and quote only unsafe integer number literals.
export function parseJSON(text: string): Raw {
  let output = "",
    at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      const start = at++;
      while (at < text.length) {
        if (text[at] === "\\") {
          at += 2;
          continue;
        }
        if (text[at++] === '"') break;
      }
      output += text.slice(start, at);
    } else if (char === "-" || /[0-9]/.test(char)) {
      const start = at++;
      while (at < text.length && /[0-9.eE+-]/.test(text[at])) at++;
      const token = text.slice(start, at);
      output +=
        /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))
          ? JSON.stringify(token)
          : token;
    } else {
      output += char;
      at++;
    }
  }
  const result = JSON.parse(output);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid NetEase API response");
  return result;
}

export class NetEaseError extends Error {
  readonly apiCode: number;
  constructor(path: string, code: number, message: string) {
    super(`${t("NetEase request failed")}: ${path}: ${code}${message ? ` ${message}` : ""}`);
    this.name = "NetEaseError";
    this.apiCode = code;
  }
}

async function request(
  url: string,
  init: RequestInit,
  acceptedCodes: number[],
  started: number,
): Promise<Raw> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    // No redirects: neither a session Cookie nor an encrypted request body
    // should be forwarded by the runtime to a different host.
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (started !== epoch) throw fail("sessionChanged", "Your account changed. Try again.");
    if (!response.ok) {
      if (response.status === 401) {
        clearSession();
        throw fail("signIn", "Your NetEase session has ended. Sign in again.");
      }
      throw Object.assign(new Error(`${t("NetEase request failed")}: HTTP ${response.status}`), {
        status: response.status,
      });
    }
    let body: Raw;
    try {
      body = parseJSON(await response.text());
    } catch {
      throw new Error(t("NetEase returned an invalid response. Try again."));
    }
    if (started !== epoch) throw fail("sessionChanged", "Your account changed. Try again.");
    const code = Number(body.code);
    if (!acceptedCodes.includes(code)) {
      if ([301, 302, 401].includes(code)) {
        clearSession();
        throw fail("signIn", "Your NetEase session has ended. Sign in again.");
      }
      throw new NetEaseError(new URL(url).pathname, code, String(body.message || body.msg || ""));
    }
    body.code = code;
    mergeCookies(response.headers, started);
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t("The NetEase request timed out. Try again."));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet(path: string, params: Record<string, unknown> = {}): Promise<Raw> {
  pathOf(path);
  const cookies = readCookies();
  const query = formOf(params).toString();
  return request(
    `${SITE}${path}${query ? `?${query}` : ""}`,
    {
      method: "GET",
      headers: {
        "user-agent": WEB_UA,
        referer: `${SITE}/`,
        cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      },
    },
    [200],
    epoch,
  );
}
export async function apiPost(path: string, data: Record<string, unknown> = {}): Promise<Raw> {
  pathOf(path);
  const cookies = readCookies();
  const csrf = cookies.find((cookie) => cookie.name === "__csrf")?.value;
  return request(
    `${SITE}${path}`,
    {
      method: "POST",
      headers: {
        "user-agent": WEB_UA,
        referer: `${SITE}/`,
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      },
      body: formOf({ ...(csrf ? { csrf_token: csrf } : {}), ...data }).toString(),
    },
    [200],
    epoch,
  );
}

function deviceId(): string {
  const saved = host.storage.get("deviceId");
  if (typeof saved === "string" && /^[0-9A-F]{52}$/.test(saved)) return saved;
  // This is an installation identifier, not cryptographic key material. The
  // sandbox has no randomBytes API; a persistent random hex value matches the
  // legacy client without requiring a helper process.
  const value = Array.from({ length: 52 }, () =>
    Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase(),
  ).join("");
  host.storage.set("deviceId", value);
  return value;
}

export function encryptEapi(path: string, data: Raw): string {
  pathOf(path);
  const text = JSON.stringify(data);
  const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
  return host.crypto
    .aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`)
    .toUpperCase();
}

export async function eapi(
  path: string,
  data: Record<string, unknown> = {},
  acceptedCodes: number[] = [200],
): Promise<Raw> {
  pathOf(path);
  const cookies = readCookies();
  const header: Record<string, string> = {
    ...DESKTOP_CLIENT,
    deviceId: deviceId(),
    mobilename: "",
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: "1920x1080",
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
    __csrf: "",
  };
  for (const cookie of cookies) header[cookie.name] = cookie.value;
  const params = encryptEapi(path, { ...data, header, e_r: false });
  return request(
    `${EAPI_SITE}/eapi/${path.slice("/api/".length)}`,
    {
      method: "POST",
      headers: {
        "user-agent": EAPI_UA,
        "content-type": "application/x-www-form-urlencoded",
        cookie: Object.entries(header)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("; "),
      },
      body: new URLSearchParams({ params }).toString(),
    },
    acceptedCodes,
    epoch,
  );
}

export const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
