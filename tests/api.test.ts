import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function environment() {
  const storage = new Map<string, unknown>();
  const crypto = {
    md5: (text: string) => createHash("md5").update(text).digest("hex"),
    aesEcbEncrypt: (key: string, text: string) => {
      const cipher = createCipheriv("aes-128-ecb", key, null);
      return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
    },
  };
  const native = {
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: (key: string) => {
        storage.delete(key);
      },
    },
    crypto,
    t: (text: string) => text,
  };
  vi.stubGlobal("host", native);
  return { storage, native };
}
function response(body: unknown = { code: 200 }, cookies: string[] = []): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { headers });
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NetEase transport", () => {
  // JSON IDs must survive the parser, including digits inside escaped text.
  it("preserves large integer IDs without changing strings or normal numbers", async () => {
    environment();
    const { parseJSON } = await import("../src/api");
    expect(
      parseJSON(
        '{"id":9223372036854775807,"count":20,"fraction":1.5,"text":"12345678901234567890 \\\"quoted\\\""}',
      ),
    ).toEqual({
      id: "9223372036854775807",
      count: 20,
      fraction: 1.5,
      text: '12345678901234567890 "quoted"',
    });
    expect(() => parseJSON("[1,2]")).toThrow();
  });

  // The digest and AES padding must match the legacy EAPI byte-for-byte.
  it("matches the EAPI protocol vector for UTF-8 text", async () => {
    environment();
    const { encryptEapi } = await import("../src/api");
    expect(encryptEapi("/api/test", { id: "123", text: "中文" })).toBe(
      "4DC723619A991588865191FD2F319BADCA322C02F0CC90F830CAC1CCCFB92A70BC274E633D05B31B525BA87D64378483A32E2019F3108405799360FEBF311FB0A6BF379D843198CD9C303C3FAF7551091316B4F4C917D107BB6249278C441234",
    );
  });

  // QR login returns more than one Set-Cookie; a comma in Expires is not a separator.
  it("keeps multiple session cookies and sends them only to fixed API hosts", async () => {
    const { storage } = environment();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ code: 803 }, [
          "MUSIC_U=token=a; Domain=.music.163.com; Path=/; HttpOnly",
          "__csrf=csrf-token; Expires=Wed, 01 Jan 2098 00:00:00 GMT; Path=/",
          "NMTID=visitor; Domain=attacker.example; Path=/",
        ]),
      )
      .mockResolvedValue(response());
    vi.stubGlobal("fetch", fetcher);
    const api = await import("../src/api");
    await api.eapi("/api/login/qrcode/client/login", { key: "qr", type: 3 }, [803]);
    expect(api.hasSession()).toBe(true);
    expect((storage.get("session") as { cookies: unknown[] }).cookies).toHaveLength(2);
    await api.apiGet("/api/nuser/account/get");
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://music.163.com/api/nuser/account/get");
    expect((init.headers as Record<string, string>).cookie).toBe(
      "MUSIC_U=token=a; __csrf=csrf-token",
    );
    expect(init.redirect).toBe("error");
    await expect(api.apiGet("https://attacker.example/api/read")).rejects.toThrow(
      "Invalid NetEase API path",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // A late response from before logout must never repopulate saved credentials.
  it("ignores session cookies returned after the account generation changed", async () => {
    const { storage } = environment();
    let answer!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const api = await import("../src/api");
    const pending = api.eapi("/api/login/qrcode/client/login", {}, [803]);
    const rejected = expect(pending).rejects.toMatchObject({ code: "sessionChanged" });
    api.clearSession();
    answer(response({ code: 803 }, ["MUSIC_U=stale; Path=/"]));
    await rejected;
    expect(storage.has("session")).toBe(false);
  });

  // Expiration and explicit removal end the generation, invalidating cached account data.
  it("expires primary cookies and handles a server deletion", async () => {
    const { storage } = environment();
    const api = await import("../src/api");
    storage.set("session", {
      version: 1,
      cookies: [{ name: "MUSIC_U", value: "old", expires: Date.now() - 1 }],
    });
    const changed = vi.fn();
    api.onSessionChange(changed);
    expect(api.hasSession()).toBe(false);
    expect(api.sessionEpoch()).toBe(1);
    storage.set("session", { version: 1, cookies: [{ name: "MUSIC_U", value: "new" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ code: 200 }, ["MUSIC_U=; Max-Age=0; Path=/"])),
    );
    await api.apiGet("/api/test");
    expect(api.hasSession()).toBe(false);
    expect(api.sessionEpoch()).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // Writes need their service result checked; an HTTP 200 can still be a failed mutation.
  it("surfaces service errors, while allowing explicitly handled playlist codes", async () => {
    environment();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ code: 512, msg: "retry required" })),
    );
    const api = await import("../src/api");
    await expect(api.eapi("/api/playlist/manipulate/tracks")).rejects.toMatchObject({
      name: "NetEaseError",
      apiCode: 512,
    });
    await expect(
      api.eapi("/api/playlist/manipulate/tracks", {}, [200, 512]),
    ).resolves.toMatchObject({ code: 512 });
  });

  // Authentication failure forgets credentials, but a transport outage does not.
  it("clears only a rejected session, retaining it on a service outage", async () => {
    const { storage } = environment();
    storage.set("session", { version: 1, cookies: [{ name: "MUSIC_U", value: "token" }] });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(response({ code: 301 }));
    vi.stubGlobal("fetch", fetcher);
    const api = await import("../src/api");
    await expect(api.apiGet("/api/test")).rejects.toThrow("503");
    expect(api.hasSession()).toBe(true);
    await expect(api.apiGet("/api/test")).rejects.toMatchObject({ code: "signIn" });
    expect(api.hasSession()).toBe(false);
  });

  // Playback needs a structured rate-limit status without parsing translated messages.
  it("exposes HTTP 429 without losing the account or automatically retrying", async () => {
    const { storage } = environment();
    storage.set("session", { version: 1, cookies: [{ name: "MUSIC_U", value: "token" }] });
    const fetcher = vi.fn(async () => new Response("Too many requests", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const api = await import("../src/api");
    await expect(api.eapi("/api/song/enhance/player/url/v1", { ids: "[1]" })).rejects.toMatchObject(
      {
        status: 429,
        message: "NetEase request failed: HTTP 429",
      },
    );
    expect(api.hasSession()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // A request must stop before the host's 30-second plugin call deadline.
  it("aborts a stalled request after its own timeout without losing the account", async () => {
    const { storage } = environment();
    storage.set("session", { version: 1, cookies: [{ name: "MUSIC_U", value: "token" }] });
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const api = await import("../src/api");
    const pending = api.apiGet("/api/test");
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(api.hasSession()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The install's device ID survives calls instead of looking like a new client each time.
  it("persists the desktop device ID and includes cookies in the encrypted header", async () => {
    const { storage, native } = environment();
    storage.set("session", {
      version: 1,
      cookies: [
        { name: "MUSIC_U", value: "token" },
        { name: "__csrf", value: "csrf" },
      ],
    });
    const encrypt = vi.spyOn(native.crypto, "aesEcbEncrypt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const api = await import("../src/api");
    await api.eapi("/api/test", { item: "1" });
    const device = storage.get("deviceId");
    expect(device).toMatch(/^[0-9A-F]{52}$/);
    await api.eapi("/api/test", { item: "2" });
    expect(storage.get("deviceId")).toBe(device);
    const body = JSON.parse(encrypt.mock.calls[0][1].split("-36cd479b6b5-")[1]);
    expect(body.header).toMatchObject({
      deviceId: device,
      MUSIC_U: "token",
      __csrf: "csrf",
      os: "pc",
    });
    expect(body.e_r).toBe(false);
  });

  // An iPhone User-Agent used to contradict the Windows PC identity inside EAPI.
  it("sends one desktop identity in the User-Agent, encrypted payload and cookies", async () => {
    const { storage, native } = environment();
    const device = "A".repeat(52);
    storage.set("deviceId", device);
    storage.set("session", {
      version: 1,
      cookies: [
        { name: "MUSIC_U", value: "existing-token" },
        { name: "__csrf", value: "existing-csrf" },
      ],
    });
    const encrypt = vi.spyOn(native.crypto, "aesEcbEncrypt");
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const api = await import("../src/api");
    await api.eapi("/api/song/enhance/player/url/v1", { ids: "[1]", level: "standard" });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://interfacepc.music.163.com/eapi/song/enhance/player/url/v1");
    const ciphertext = new URLSearchParams(String(init.body)).get("params")!;
    const decipher = createDecipheriv("aes-128-ecb", encrypt.mock.calls[0][0], null);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
    const [path, json, digest] = plaintext.split("-36cd479b6b5-");
    const payload = JSON.parse(json);
    const headers = new Headers(init.headers);
    const ua = headers.get("user-agent")!;
    const cookies = Object.fromEntries(
      headers
        .get("cookie")!
        .split("; ")
        .map((part) => {
          const at = part.indexOf("=");
          return [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))];
        }),
    );
    expect(path).toBe("/api/song/enhance/player/url/v1");
    expect(digest).toBe(
      createHash("md5").update(`nobody${path}use${json}md5forencrypt`).digest("hex"),
    );
    expect(payload.header).toMatchObject({
      os: "pc",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: device,
      MUSIC_U: "existing-token",
      __csrf: "existing-csrf",
    });
    expect(cookies).toEqual(payload.header);
    expect(ua).toContain("Windows NT 10.0; Win64; x64");
    expect(ua).toContain(`NeteaseMusicDesktop/${payload.header.appver}`);
    expect(ua).not.toMatch(/iPhone|iOS/);
    expect(storage.get("deviceId")).toBe(device);
    expect(api.hasSession()).toBe(true);
  });
});
