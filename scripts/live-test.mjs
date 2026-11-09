// Anonymous, read-only API smoke test. Never loads a real account's cookies.
import { createCipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url)));
const data = new Map();
const allowed = (name) =>
  manifest.permissions.network.some((host) =>
    host.startsWith("*.") ? name.endsWith(host.slice(1)) : name === host,
  );
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const address = new URL(url);
  if (address.protocol !== "https:" || !allowed(address.hostname))
    throw new Error("Blocked network host");
  return nativeFetch(url, init);
};
globalThis.host = {
  platform: process.platform,
  arch: process.arch,
  dir: "",
  dataDir: "",
  storage: {
    get: (key) => data.get(key),
    set: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
  },
  t: (text) => text,
  language: () => "en",
  setting: () => "",
  signInPrompt: () => {
    throw new Error("Live smoke test must not sign in");
  },
  openURL: () => {},
  crypto: {
    md5: (text) => createHash("md5").update(text).digest("hex"),
    aesEcbEncrypt: (key, text) => {
      const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
      return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
    },
  },
};
const plugin = await import("../index.js");
const results = [];
async function check(name, action) {
  try {
    const detail = await action();
    results.push({ name, passed: true, detail });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}
await check("anonymous account", async () => {
  if ((await plugin.account()) !== null) throw new Error("Unexpected account");
  return "signed out";
});
let tracks = [];
let charts = [],
  podcasts = [];
await check("search and EAPI song details", async () => {
  const result = await plugin.search({
    query: process.env.YOI_QUERY || "春日影",
    kind: "tracks",
    offset: 0,
  });
  if (!Array.isArray(result.tracks) || result.tracks.length === 0)
    throw new Error("No tracks returned");
  tracks = result.tracks;
  return `${tracks.length} tracks, typed ID ${tracks[0].id}`;
});
await check("charts", async () => {
  const page = await plugin.browse({ page: "charts" });
  charts = page.sections.flatMap((s) => s.playlists || []);
  const count = page.sections.reduce((n, s) => n + (s.playlists?.length || 0), 0);
  if (!count) throw new Error("No charts returned");
  return `${count} charts`;
});
await check("podcast discovery", async () => {
  const page = await plugin.browse({ page: "podcasts" });
  podcasts = page.sections.flatMap((s) => s.shows || []);
  const count = page.sections.reduce((n, s) => n + (s.shows?.length || 0), 0);
  if (!count) throw new Error("No podcasts returned");
  return `${count} podcasts`;
});
if (tracks.length) {
  await check("search suggestions", async () => {
    const result = await plugin.suggest({ query: "春日影" });
    if (!result.length) throw new Error("No suggestions returned");
    return `${result.length} suggestions`;
  });
  await check("artist and extended latest songs", async () => {
    const artistId = tracks[0].artists.find((artist) => artist.id)?.id;
    if (!artistId) throw new Error("No linked artist");
    const value = await plugin.artist({ id: artistId });
    const extended = await plugin.browse({ page: `artist-latest:${artistId}:0` });
    return `${value.tracks.length} popular, ${extended.sections[0].tracks.length} latest songs`;
  });
  await check("album details", async () => {
    const album = await plugin.album({ id: tracks[0].album.id });
    if (!album.tracks.length) throw new Error("No album tracks");
    return `${album.tracks.length} tracks`;
  });
  await check("lyrics", async () => {
    const value = await plugin.lyrics({ id: tracks[0].id });
    return value.lines?.length
      ? `${value.lines.length} word-timed lines`
      : `${value.lrc?.length || 0} LRC characters`;
  });
  const playable = tracks.find((track) => !track.unavailable);
  if (playable)
    await check("anonymous full stream resolution", async () => {
      const value = await plugin.stream({ id: playable.id, quality: "standard" });
      const response = await fetch(value.url, {
        headers: { range: "bytes=0-1023" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok || !response.body) throw new Error(`Audio response: ${response.status}`);
      const reader = response.body.getReader();
      const chunk = await reader.read();
      await reader.cancel();
      if (!chunk.value?.length) throw new Error("Empty audio response");
      return `${value.type}, ${value.quality}, ${value.bitRate} bit/s, received ${chunk.value.length} audio bytes (URL omitted)`;
    });
  await check("comments", async () => {
    const value = await plugin.comments({ trackId: tracks[0].id, offset: 0 });
    if (!value.comments.length) throw new Error("No comments");
    return `${value.comments.length} displayed, ${value.total} total`;
  });
}
if (charts.length)
  await check("chart playlist and ordered song details", async () => {
    const value = await plugin.playlist({ id: charts[0].id });
    if (value.tracks.length !== value.trackCount || !value.tracks.length)
      throw new Error("Incomplete chart");
    return `${value.tracks.length} tracks`;
  });
if (podcasts.length)
  await check("podcast programs", async () => {
    const value = await plugin.show({ id: podcasts[0].id, offset: 0 });
    if (!value.episodes.length || !value.episodes[0].id.startsWith("program:"))
      throw new Error("No typed episodes");
    return `${value.episodes.length} episodes`;
  });
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
