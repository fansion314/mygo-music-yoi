import type { Album, Artist, Playlist, Raw, Show, Track } from "./types";

export const t = (text: string): string => host.t(text);
export function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(t(message)), { code });
}
// Never turn a string ID into a Number. Refuse already-rounded JSON numbers.
export function id(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value) && !/^0+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error("Invalid or unsafe NetEase ID");
}
export function offsetOf(value: unknown = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid offset");
  return Number(value);
}
export function image(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value.replace(/^http:/, "https:"));
    if (url.protocol !== "https:") return undefined;
    if (url.hostname.endsWith(".music.126.net") || url.hostname.endsWith(".music.163.com"))
      url.searchParams.set("param", "{size}y{size}");
    return url.toString();
  } catch {
    return undefined;
  }
}
export function toArtist(raw: Raw): Artist {
  return {
    id: raw.id && String(raw.id) !== "0" ? id(raw.id) : "",
    name: String(raw.name || ""),
    imageUrl: image(raw.img1v1Url || raw.picUrl),
    following: !!(raw.followed ?? raw.following),
  };
}
export function toAlbum(raw: Raw = {}): Album {
  const artists = raw.artists || (raw.artist ? [raw.artist] : []);
  return {
    id: raw.id ? id(raw.id) : "",
    name: String(raw.name || ""),
    imageUrl: image(raw.picUrl),
    artists: artists.map(toArtist),
    released: raw.publishTime ? new Date(raw.publishTime).toISOString().slice(0, 10) : undefined,
  };
}
export function toTrack(raw: Raw): Track {
  const privilege = raw.privilege;
  const unavailable = privilege
    ? Number(privilege.st) < 0 || Number(privilege.pl) <= 0
    : raw.fee === 1 || raw.fee === 4;
  const song = id(raw.id);
  return {
    id: `song:${song}`,
    name: String(raw.name || ""),
    artists: (raw.ar || raw.artists || []).map(toArtist),
    album: toAlbum(raw.al || raw.album),
    duration: Number(raw.dt ?? raw.duration ?? 0),
    url: `https://music.163.com/song?id=${song}`,
    unavailable,
  };
}
export function toPlaylist(raw: Raw, uid?: string): Playlist {
  const mine = !!uid && String(raw.creator?.userId) === uid;
  return {
    id: id(raw.id),
    name: String(raw.name || ""),
    imageUrl: image(raw.coverImgUrl || raw.picUrl),
    description: String(raw.description || ""),
    owner: String(raw.creator?.nickname || ""),
    trackCount: Number(raw.trackCount || 0),
    mine,
    saved: !!raw.subscribed,
    fixed: mine && Number(raw.specialType) === 5,
  };
}
export function toShow(raw: Raw): Show {
  return {
    id: id(raw.id),
    name: String(raw.name || ""),
    imageUrl: image(raw.picUrl),
    description: String(raw.desc || ""),
    publisher: String(raw.dj?.nickname || ""),
    publisherPage: raw.dj?.userId ? `user:${id(raw.dj.userId)}` : undefined,
    episodeCount: Number(raw.programCount || 0),
    subscribed: !!raw.subed,
  };
}
export function toProgram(raw: Raw, show: Raw): Track {
  const program = id(raw.id),
    audio = id(raw.mainSong?.id),
    showId = id(show.id);
  return {
    id: `program:${program}:${audio}`,
    name: String(raw.name || ""),
    artists: show.dj?.nickname ? [{ id: "", name: String(show.dj.nickname) }] : [],
    album: { id: "", name: String(show.name || ""), imageUrl: image(raw.coverUrl || show.picUrl) },
    duration: Number(raw.duration || 0),
    url: `https://music.163.com/program?id=${program}`,
    showId,
    description: String(raw.description || ""),
    published: raw.createTime ? new Date(raw.createTime).toISOString().slice(0, 10) : undefined,
  };
}
export function decodeTrack(value: string): { songId: string; programId?: string } {
  const song = /^song:(\d+)$/.exec(value);
  if (song) return { songId: id(song[1]) };
  const program = /^program:(\d+):(\d+)$/.exec(value);
  if (program) return { programId: id(program[1]), songId: id(program[2]) };
  throw new Error("Invalid YOI track ID");
}
export function threadOf(value: string): string {
  const track = decodeTrack(value);
  return track.programId ? `A_DJ_1_${track.programId}` : `R_SO_4_${track.songId}`;
}
