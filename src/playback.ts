import { apiGet, eapi, onSessionChange, sessionEpoch } from "./api";
import { decodeTrack, fail, offsetOf, t } from "./model";
import type { LyricLine, Raw } from "./types";

export const levels = ["standard", "higher", "exhigh", "lossless", "hires"] as const;
const streamCacheTTL = 10_000;
const streamCacheLimit = 32;
const cooldownDuration = 60_000;
const cooldownKey = "streamCooldownUntil";
type AudioStream = {
  url: string;
  type: string;
  quality: string;
  bitRate: number;
  size: number;
  gain: number;
  peak: number;
};
const pendingStreams = new Map<string, Promise<AudioStream>>();
const streamCache = new Map<string, { until: number; value: AudioStream }>();
let streamGeneration = 0;
onSessionChange(() => {
  streamGeneration++;
  pendingStreams.clear();
  streamCache.clear();
  // A network/device risk block can outlive an account, so keep its deadline.
});

function checkStreamSession(epoch: number, generation: number): void {
  if (epoch !== sessionEpoch() || generation !== streamGeneration)
    throw fail("sessionChanged", "Your account changed. Try again.");
}
function cooldownRemaining(): number {
  const until = host.storage.get(cooldownKey);
  if (until === undefined) return 0;
  const now = Date.now();
  // Corrupt storage or a clock adjustment must not block playback indefinitely.
  if (
    typeof until !== "number" ||
    !Number.isFinite(until) ||
    until <= now ||
    until > now + cooldownDuration
  ) {
    host.storage.remove(cooldownKey);
    return 0;
  }
  return Math.ceil((until - now) / 1000);
}
function cooldownError(seconds: number): Error {
  return new Error(
    t("NetEase temporarily blocked playback requests. Try again in {seconds} seconds.").replace(
      "{seconds}",
      String(seconds),
    ),
  );
}
function isRiskBlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { apiCode?: number; status?: number };
  return (
    details.apiCode === -460 ||
    details.apiCode === 460 ||
    details.apiCode === 429 ||
    details.status === 429
  );
}
export function setSetting({ key, value }: { key: string; value: string }): void {
  if (key !== "quality") throw fail("setup", "Unknown setting");
  if (value && value !== "auto" && !(levels as readonly string[]).includes(value)) {
    throw fail("setup", "Choose auto, standard, higher, exhigh, lossless, or hires");
  }
}
export function requestedLevel(quality: string): string {
  const override = host.setting("quality").trim();
  if (override && override !== "auto") {
    setSetting({ key: "quality", value: override });
    return override;
  }
  return (
    ({ standard: "standard", high: "exhigh", lossless: "lossless" } as Record<string, string>)[
      quality
    ] || "exhigh"
  );
}
export async function stream({
  id,
  quality = "high",
}: {
  id: string;
  quality?: string;
}): Promise<AudioStream> {
  const { songId } = decodeTrack(id);
  const level = requestedLevel(quality);
  const seconds = cooldownRemaining();
  if (seconds) throw cooldownError(seconds);
  const epoch = sessionEpoch(),
    generation = streamGeneration;
  const key = `${epoch}:${generation}:${songId}:${level}`;
  const cached = streamCache.get(key);
  if (cached && cached.until > Date.now()) return { ...cached.value };
  streamCache.delete(key);
  const existing = pendingStreams.get(key);
  if (existing) return { ...(await existing) };
  const pending = resolveStream(songId, level, key, epoch, generation);
  pendingStreams.set(key, pending);
  try {
    return { ...(await pending) };
  } finally {
    // An old account's result must not remove a newer pending request.
    if (pendingStreams.get(key) === pending) pendingStreams.delete(key);
  }
}
async function resolveStream(
  songId: string,
  level: string,
  key: string,
  epoch: number,
  generation: number,
): Promise<AudioStream> {
  const started = Date.now();
  let res: Raw;
  try {
    res = await eapi("/api/song/enhance/player/url/v1", {
      ids: `[${songId}]`,
      level,
      encodeType: level === "lossless" || level === "hires" ? "flac" : "mp3",
    });
  } catch (error) {
    checkStreamSession(epoch, generation);
    if (isRiskBlock(error)) {
      host.storage.set(cooldownKey, Date.now() + cooldownDuration);
      throw cooldownError(cooldownDuration / 1000);
    }
    throw error;
  }
  checkStreamSession(epoch, generation);
  const data = res.data?.[0];
  if (data && isRiskBlock({ apiCode: Number(data.code) })) {
    host.storage.set(cooldownKey, Date.now() + cooldownDuration);
    throw cooldownError(cooldownDuration / 1000);
  }
  if (!data?.url || data.freeTrialInfo != null || Number(data.code || 200) !== 200)
    throw fail("unavailable", "This track is not available in full for your account");
  const type = String(data.type || "").toLowerCase();
  if (type !== "mp3" && type !== "flac")
    throw fail("unavailable", "The service returned an unsupported audio format");
  const address = new URL(String(data.url).replace(/^http:/, "https:"));
  if (address.protocol !== "https:" || !audioHost(address.hostname))
    throw fail("unavailable", "The service returned an unexpected audio host");
  // The host cache only understands its three buckets. Preserve actual encoding
  // and bitrate; hires/lossless both belong in its lossless bucket.
  const served = String(data.level || level);
  const value: AudioStream = {
    url: address.toString(),
    type,
    quality:
      served === "lossless" || served === "hires"
        ? "lossless"
        : served === "standard"
          ? "standard"
          : "high",
    bitRate: Number(data.br || 0),
    size: Number(data.size || 0),
    gain: Number(data.gain || 0),
    peak: Number(data.peak || 0),
  };
  // NetEase's exp is the URL's lifetime in seconds. Missing/invalid expiry
  // permits in-flight coalescing only, never an invented reusable lifetime.
  const expires =
    typeof data.exp === "number" || typeof data.exp === "string" ? Number(data.exp) : NaN;
  if (Number.isFinite(expires) && expires > 0) {
    const until = Math.min(Date.now() + streamCacheTTL, started + expires * 1000);
    if (until > Date.now()) {
      streamCache.set(key, { until, value });
      if (streamCache.size > streamCacheLimit) streamCache.delete(streamCache.keys().next().value!);
    }
  }
  return value;
}
function audioHost(name: string): boolean {
  return ["music.126.net", "music.163.com", "music.163.net", "music.126.com"].some((domain) =>
    name.endsWith(`.${domain}`),
  );
}

export function parseLRC(text: string): { start: number; text: string }[] {
  const lines: { start: number; text: string }[] = [];
  const offset = /\[offset:([+-]?\d+)\]/i.exec(text);
  const shift = offset ? Number(offset[1]) : 0;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!content) continue;
    for (const stamp of stamps) {
      const start =
        Number(stamp[1]) * 60000 +
        Number(stamp[2]) * 1000 +
        Number((stamp[3] || "").padEnd(3, "0")) +
        shift;
      lines.push({ start: Math.max(0, start), text: content });
    }
  }
  return lines.sort((a, b) => a.start - b.start);
}
export function parseYRC(text: string, translation = ""): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const timing = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!timing) continue;
    const start = Number(timing[1]),
      end = start + Number(timing[2]);
    const words: NonNullable<LyricLine["words"]> = [];
    for (const word of raw.slice(timing[0].length).matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)) {
      if (!word[3].trim()) {
        if (words.length) words[words.length - 1].text += word[3];
        continue;
      }
      const at = Number(word[1]);
      words.push({ start: at, end: at + Number(word[2]), text: word[3] });
    }
    const content = words
      .map((word) => word.text)
      .join("")
      .trim();
    if (content) lines.push({ start, end, text: content, words });
  }
  lines.sort((a, b) => a.start - b.start);
  for (const translated of parseLRC(translation)) {
    let best: LyricLine | undefined,
      distance = 1500;
    for (const line of lines) {
      const gap = Math.abs(line.start - translated.start);
      if (gap < distance) {
        best = line;
        distance = gap;
      }
    }
    if (best && !best.translation) best.translation = translated.text;
  }
  return lines;
}
export async function lyrics({ id }: { id: string }) {
  const { songId, programId } = decodeTrack(id);
  if (programId) return {};
  // Both endpoints fit inside one request deadline, rather than adding two
  // 20-second waits beyond the host's 30-second plugin call budget.
  const results = await Promise.allSettled([
    apiGet("/api/song/lyric", { id: songId, lv: "1", tv: "-1" }),
    eapi("/api/song/lyric/v1", {
      id: songId,
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    }),
  ]);
  for (const result of results) {
    if (result.status === "rejected" && ["signIn", "sessionChanged"].includes(result.reason?.code))
      throw result.reason;
  }
  const base: Raw = results[0].status === "fulfilled" ? results[0].value : {};
  const words: Raw = results[1].status === "fulfilled" ? results[1].value : {};
  const lrc = String(base.lrc?.lyric || ""),
    translation = String(base.tlyric?.lyric || "");
  const lines = parseYRC(String(words?.yrc?.lyric || ""), translation);
  if (!lines.length && results[0].status === "rejected") throw results[0].reason;
  return lines.length ? { lines, lrc, translation } : { lrc, translation };
}

// Imported by callers that accept an optional offset, so malformed cursors fail
// before issuing a request instead of repeatedly fetching the first page.
export { offsetOf };
