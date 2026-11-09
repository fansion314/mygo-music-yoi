// Ported from egoist/mygo-cloudmusic's NetEase library and radio implementation.
import { apiGet, apiPost, eapi, hasSession, onSessionChange, sessionEpoch } from "./api";
import { account, needAccount } from "./auth";
import { songDetails, tracksWithPrivileges } from "./catalog";
import { decodeTrack, fail, id, offsetOf, t, toPlaylist, toTrack } from "./model";
import type { Playlist, Raw, Station, Track } from "./types";

const pageSize = 200;
const likedPageSize = 100;
const likeTTL = 15_000;
let likes: { epoch: number; uid: string; at: number; ids: string[] } | undefined;
let likeRequest: { epoch: number; uid: string; promise: Promise<string[]> } | undefined;
let likesVersion = 0;
type Heart = { start: string; last: string; playlist: string; epoch: number };
let heart: Heart | undefined;
let stationChain: Promise<unknown> = Promise.resolve();

onSessionChange(() => {
  likes = undefined;
  likeRequest = undefined;
  likesVersion++;
  heart = undefined;
  host.storage.remove("lastPlayed");
});

function current(epoch: number): void {
  if (sessionEpoch() !== epoch) throw fail("signIn", "Your account changed. Please try again.");
}
const numericIds = (values: string[]): string => `[${values.map(id).join(",")}]`;
const checkName = (name: string): string => {
  if (typeof name !== "string" || !name.trim()) throw new Error(t("Enter a playlist name."));
  return name.trim();
};

// A non-paged host contract must collect every server page, not only the first 200.
export async function userPlaylistRows(uid: string): Promise<Raw[]> {
  uid = id(uid);
  const epoch = sessionEpoch();
  const result: Raw[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await apiGet("/api/user/playlist", { uid, limit: pageSize, offset });
    current(epoch);
    const rows: Raw[] = page.playlist || [];
    let added = 0;
    for (const row of rows) {
      const key = id(row.id);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(row);
        added++;
      }
    }
    if (!page.more && (page.more === false || rows.length < pageSize)) return result;
    if (!rows.length || !added)
      throw new Error(t("The playlist list stopped advancing. Please try again."));
    offset += rows.length;
  }
}

export async function playlists(): Promise<Playlist[]> {
  const me = await needAccount();
  const epoch = sessionEpoch();
  const rows = await userPlaylistRows(me.id);
  current(epoch);
  return rows.map((row) => toPlaylist(row, me.id));
}

async function playlistRow(playlistId: string): Promise<Raw> {
  const response = await apiGet("/api/v6/playlist/detail", { id: id(playlistId), n: 1000 });
  if (!response.playlist || String(response.playlist.id) !== playlistId) {
    throw fail("unavailable", "This playlist is not available.");
  }
  return response.playlist;
}

export async function playlist({ id: playlistId }: { id: string }): Promise<Playlist> {
  playlistId = id(playlistId);
  const epoch = sessionEpoch();
  const [row, me] = await Promise.all([playlistRow(playlistId), account()]);
  current(epoch);
  const tracks: Raw[] = row.tracks || [];
  const ids: string[] = (row.trackIds || []).map((entry: Raw) => id(entry.id));
  const expected = Number(row.trackCount || 0);
  if (expected > (ids.length || tracks.length)) {
    throw new Error(t("The service did not return the complete playlist. Please try again."));
  }
  const complete = ids.length
    ? await songDetails(ids)
    : await songDetails(tracks.map((track) => id(track.id)));
  current(epoch);
  const byId = new Map(complete.map((track) => [id(track.id), track]));
  const ordered = (ids.length ? ids : tracks.map((track) => id(track.id))).map((song) => {
    const detail = byId.get(song);
    // Removed tracks still occupy their place, rather than shifting queue positions.
    return detail
      ? toTrack(detail)
      : toTrack({ id: song, name: t("Unavailable track"), privilege: { st: -1, pl: 0 } });
  });
  return { ...toPlaylist(row, me?.id), tracks: ordered, trackCount: ordered.length };
}

export async function likedSongIds(refresh = false): Promise<string[]> {
  const me = await needAccount();
  const epoch = sessionEpoch();
  if (!refresh && likes?.epoch === epoch && likes.uid === me.id && Date.now() - likes.at < likeTTL)
    return [...likes.ids];
  if (!refresh && likeRequest?.epoch === epoch && likeRequest.uid === me.id)
    return [...(await likeRequest.promise)];
  const version = likesVersion;
  const request = (async () => {
    const response = await eapi("/api/song/like/get", { uid: me.id });
    current(epoch);
    const ids = [...new Set<string>((response.ids || []).map(id))];
    if (likesVersion === version) likes = { epoch, uid: me.id, at: Date.now(), ids };
    return ids;
  })();
  const inFlight = { epoch, uid: me.id, promise: request };
  likeRequest = inFlight;
  try {
    return [...(await request)];
  } finally {
    if (likeRequest === inFlight) likeRequest = undefined;
  }
}

export async function liked({ offset = 0 }: { offset?: number } = {}): Promise<{
  tracks: Track[];
  more: boolean;
}> {
  offset = offsetOf(offset);
  const epoch = sessionEpoch();
  const me = await needAccount();
  const rows = await userPlaylistRows(me.id);
  current(epoch);
  const likedPlaylist = rows.find(
    (row) => String(row.creator?.userId) === me.id && Number(row.specialType) === 5,
  );
  let ids: string[];
  if (likedPlaylist) {
    const row = await playlistRow(id(likedPlaylist.id));
    ids = (row.trackIds || row.tracks || []).map((song: Raw) => id(song.id));
    if (Number(row.trackCount || 0) > ids.length)
      throw new Error(t("The service did not return all liked songs. Please try again."));
  } else {
    ids = await likedSongIds(offset === 0);
  }
  current(epoch);
  const details = await songDetails(ids.slice(offset, offset + likedPageSize));
  current(epoch);
  const byId = new Map(details.map((song) => [id(song.id), song]));
  return {
    tracks: ids.slice(offset, offset + likedPageSize).map((song) =>
      toTrack(
        byId.get(song) || {
          id: song,
          name: t("Unavailable track"),
          privilege: { st: -1, pl: 0 },
        },
      ),
    ),
    more: offset + likedPageSize < ids.length,
  };
}

export async function isLiked({ ids }: { ids: string[] }): Promise<Record<string, boolean>> {
  if (!Array.isArray(ids)) throw new Error("Expected track IDs");
  const decoded = ids.map((value) => ({ value, ...decodeTrack(value) }));
  const result: Record<string, boolean> = Object.fromEntries(ids.map((value) => [value, false]));
  if (!hasSession() || !ids.length) return result;
  const epoch = sessionEpoch();
  const songs = decoded.filter((track) => !track.programId);
  if (songs.length) {
    const liked = new Set(await likedSongIds());
    for (const song of songs) result[song.value] = liked.has(song.songId);
  }
  const episodes = decoded.filter((track) => track.programId);
  for (let offset = 0; offset < episodes.length; offset += 100) {
    const batch = episodes.slice(offset, offset + 100);
    const response = await eapi("/api/resource/commentInfo/list", {
      resourceType: "1",
      resourceIds: numericIds(batch.map((track) => track.programId!)),
    });
    const states = new Map<string, boolean>(
      (response.data || []).map((row: Raw) => [id(row.resourceId), !!row.liked]),
    );
    for (const episode of batch) result[episode.value] = states.get(episode.programId!) || false;
  }
  current(epoch);
  return result;
}

export async function like({ id: trackId, on }: { id: string; on: boolean }): Promise<void> {
  const track = decodeTrack(trackId);
  if (track.programId)
    throw fail("unsupported", "Use the episode like action for podcast episodes.");
  await needAccount();
  const epoch = sessionEpoch();
  await eapi("/api/radio/like", {
    alg: "itembased",
    trackId: track.songId,
    like: String(!!on),
    time: "3",
  });
  current(epoch);
  likesVersion++;
  likes = undefined;
  likeRequest = undefined;
}

async function editable(playlistId: string): Promise<{ row: Raw; epoch: number }> {
  const me = await needAccount();
  const epoch = sessionEpoch();
  const row = await playlistRow(id(playlistId));
  current(epoch);
  if (String(row.creator?.userId) !== me.id)
    throw fail("unsupported", "Only your own playlists can be edited.");
  if (Number(row.specialType) === 5)
    throw fail("unsupported", "Use the heart button to change liked songs.");
  return { row, epoch };
}

export async function createPlaylist({ name }: { name: string }): Promise<Playlist> {
  name = checkName(name);
  const me = await needAccount();
  const epoch = sessionEpoch();
  const response = await eapi("/api/playlist/create", { name, privacy: "0", type: "NORMAL" });
  current(epoch);
  const row = {
    ...response.playlist,
    id: response.playlist?.id || response.id,
    name: response.playlist?.name || name,
  };
  return {
    ...toPlaylist({ ...row, creator: row.creator || { userId: me.id, nickname: me.name } }, me.id),
    mine: true,
  };
}

export async function renamePlaylist({
  id: playlistId,
  name,
}: {
  id: string;
  name: string;
}): Promise<void> {
  name = checkName(name);
  const { epoch } = await editable(playlistId);
  current(epoch);
  await eapi("/api/playlist/update/name", { id: id(playlistId), name });
  current(epoch);
}

export async function deletePlaylist({ id: playlistId }: { id: string }): Promise<void> {
  const { epoch } = await editable(playlistId);
  current(epoch);
  await eapi("/api/playlist/remove", { ids: numericIds([playlistId]) });
  current(epoch);
}

async function manipulate(
  op: "add" | "del",
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  if (!Array.isArray(trackIds)) throw new Error("Expected track IDs");
  const songs = [
    ...new Set(
      trackIds.map((trackId) => {
        const track = decodeTrack(trackId);
        if (track.programId)
          throw fail("unsupported", "Podcast episodes cannot be added to song playlists.");
        return track.songId;
      }),
    ),
  ];
  const { epoch } = await editable(playlistId);
  current(epoch);
  if (!songs.length) return;
  // One request preserves the server's all-or-error result for the selected songs.
  const send = (values: string[]) =>
    eapi(
      "/api/playlist/manipulate/tracks",
      { op, pid: id(playlistId), trackIds: numericIds(values), imme: "true" },
      [200, 502, 512],
    );
  let response = await send(songs);
  current(epoch);
  if (Number(response.code) === 512) {
    response = await send([...songs, ...songs]);
    current(epoch);
  }
  if (Number(response.code) === 502)
    throw new Error(t("A selected song is already in the playlist."));
  if (Number(response.code) !== 200)
    throw new Error(`${t("The playlist could not be changed.")} (${response.code})`);
}

export const addToPlaylist = ({
  id: playlistId,
  trackIds,
}: {
  id: string;
  trackIds: string[];
}): Promise<void> => manipulate("add", playlistId, trackIds);
export const removeFromPlaylist = ({
  id: playlistId,
  trackIds,
}: {
  id: string;
  trackIds: string[];
}): Promise<void> => manipulate("del", playlistId, trackIds);

export async function savePlaylist({
  id: playlistId,
  on,
}: {
  id: string;
  on: boolean;
}): Promise<void> {
  const me = await needAccount();
  const epoch = sessionEpoch();
  const row = await playlistRow(id(playlistId));
  current(epoch);
  if (String(row.creator?.userId) === me.id)
    throw fail("unsupported", "Your own playlists do not need saving.");
  await eapi(on ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe", { id: id(playlistId) });
  current(epoch);
}

export async function followArtist({
  id: artistId,
  on,
}: {
  id: string;
  on: boolean;
}): Promise<void> {
  await needAccount();
  const epoch = sessionEpoch();
  // NetEase rejects following over EAPI with -460; the old client uses Web API.
  await apiPost(on ? "/api/artist/sub" : "/api/artist/unsub", {
    artistId: id(artistId),
    artistIds: numericIds([artistId]),
  });
  current(epoch);
}

export async function recent(): Promise<Track[]> {
  await needAccount();
  const epoch = sessionEpoch();
  const response = await eapi("/api/play-record/song/list", { limit: 100 });
  const tracks = await tracksWithPrivileges(
    (response.data?.list || []).map((row: Raw) => row.data),
  );
  current(epoch);
  return tracks;
}

// The hook carries only a track ID. It is seed context, not a listening log.
export function played({ id: trackId }: { id: string }): void {
  const track = decodeTrack(trackId);
  if (hasSession() && !track.programId) host.storage.set("lastPlayed", trackId);
}

export function stations(): Station[] {
  return [
    { id: "default", name: t("For You"), description: t("Personal FM picked for your taste") },
    { id: "familiar", name: t("Familiar"), description: t("Songs like the ones you know") },
    { id: "explore", name: t("Explore"), description: t("Discover something new") },
    { id: "heart", name: t("Heart Mode"), description: t("More like your liked songs") },
  ];
}

async function nextStation(stationId: string, invokedEpoch: number): Promise<Track[]> {
  current(invokedEpoch);
  const me = await needAccount();
  const epoch = sessionEpoch();
  const modes: Record<string, string> = {
    default: "DEFAULT",
    familiar: "FAMILIAR",
    explore: "EXPLORE",
  };
  let tracks: Track[];
  if (stationId in modes) {
    heart = undefined;
    const response = await eapi("/api/v1/radio/get", { mode: modes[stationId], limit: 3 });
    tracks = (await songDetails((response.data || []).map((song: Raw) => id(song.id)))).map(
      toTrack,
    );
  } else if (stationId === "heart") {
    if (!heart || heart.epoch !== epoch) {
      const ids = await likedSongIds(true);
      if (!ids.length) throw fail("unavailable", "Like some songs before starting Heart Mode.");
      const rows = await userPlaylistRows(me.id);
      current(epoch);
      const fixed = rows.find(
        (row) => String(row.creator?.userId) === me.id && Number(row.specialType) === 5,
      );
      if (!fixed) throw fail("unavailable", "Your liked songs playlist is not available.");
      const previous = host.storage.get("lastPlayed");
      let seed = ids[0];
      if (typeof previous === "string") {
        try {
          const track = decodeTrack(previous);
          if (!track.programId && ids.includes(track.songId)) seed = track.songId;
        } catch {
          /* Ignore stale storage from another plugin version. */
        }
      }
      heart = { start: seed, last: seed, playlist: id(fixed.id), epoch };
    }
    const state = heart;
    const response = await eapi("/api/playmode/intelligence/list", {
      songId: state.last,
      startMusicId: state.start,
      playlistId: state.playlist,
      type: "fromPlayOne",
      count: 1,
    });
    tracks = await tracksWithPrivileges(
      (response.data || []).flatMap((row: Raw) => (row.songInfo ? [row.songInfo] : [])),
    );
    current(epoch);
    const playable = tracks.filter((track) => !track.unavailable);
    if (playable.length) state.last = decodeTrack(playable[playable.length - 1].id).songId;
  } else throw fail("unsupported", "Unknown station.");
  current(epoch);
  const playable = tracks.filter((track) => !track.unavailable);
  if (!playable.length)
    throw fail("unavailable", "No playable songs were returned. Please try again.");
  return playable;
}

// Serialize feed requests so concurrent prefetches cannot initialize two heart seeds.
export function stationNext({ id: stationId }: { id: string }): Promise<Track[]> {
  const epoch = sessionEpoch();
  const next = stationChain.then(() => nextStation(stationId, epoch));
  stationChain = next.catch(() => undefined);
  return next;
}
