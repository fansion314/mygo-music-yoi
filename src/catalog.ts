// Ported from mygo-cloudmusic's NetEase catalog. See NOTICE for provenance.
import { apiGet, apiPost, eapi, hasSession, parseJSON } from "./api";
import { account, needAccount } from "./auth";
import {
  fail,
  id,
  image,
  offsetOf,
  t,
  toAlbum,
  toArtist,
  toPlaylist,
  toShow,
  toTrack,
} from "./model";
import type { Browse, Link, Raw, Section, Track } from "./types";

const PAGE = 30;
const LAST_QUERY = "lastSearchQuery";
const RECENT_ARTISTS = "recentArtists";

function rows(value: unknown, field: string): Raw[] {
  if (!Array.isArray(value))
    throw new Error(`${t("NetEase returned an invalid catalog response. Try again.")} (${field})`);
  return value;
}

function record(value: unknown, field: string): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${t("NetEase returned an invalid catalog response. Try again.")} (${field})`);
  return value as Raw;
}

// Song detail is the authority for VIP privileges; other endpoints can say a
// subscriber's songs have been removed. Preserve input order, including repeats.
export async function songDetails(ids: string[]): Promise<Raw[]> {
  const requested = ids.map(id);
  const byID = new Map<string, Raw>();
  for (let start = 0; start < requested.length; start += 400) {
    const batch = requested.slice(start, start + 400);
    const res = await eapi("/api/v3/song/detail", {
      c: JSON.stringify(batch.map((song) => ({ id: song }))),
    });
    if (!Array.isArray(res.songs))
      throw new Error("NetEase returned an invalid song detail response");
    const privileges = new Map<string, Raw>((res.privileges || []).map((p: Raw) => [id(p.id), p]));
    for (const song of res.songs || []) {
      const songID = id(song.id);
      byID.set(songID, { ...song, privilege: privileges.get(songID) || song.privilege });
    }
  }
  return requested.map((song) => {
    return (
      byID.get(song) || {
        id: song,
        name: t("Unavailable track"),
        privilege: { id: song, st: -1, pl: 0 },
      }
    );
  });
}

export async function tracksWithPrivileges(raw: Raw[]): Promise<Track[]> {
  if (!raw.length) return [];
  const details = await songDetails(raw.map((song) => id(song.id)));
  return raw.map((song, i) =>
    toTrack({ ...song, privilege: details[i]?.privilege ?? song.privilege }),
  );
}

const searchKinds: Record<
  string,
  { type: number; field: string; count: string; map: (raw: Raw) => unknown }
> = {
  tracks: { type: 1, field: "songs", count: "songCount", map: toTrack },
  albums: { type: 10, field: "albums", count: "albumCount", map: toAlbum },
  artists: { type: 100, field: "artists", count: "artistCount", map: toArtist },
  playlists: { type: 1000, field: "playlists", count: "playlistCount", map: toPlaylist },
  shows: { type: 1009, field: "djRadios", count: "djRadiosCount", map: toShow },
};

export async function search({
  query,
  kind,
  offset = 0,
}: {
  query: string;
  kind: string;
  offset?: number;
}): Promise<Raw> {
  const config = searchKinds[kind];
  if (!config) throw fail("unsupported", "This search kind is not supported.");
  const at = offsetOf(offset),
    text = String(query).trim();
  if (!text) return { [kind]: [], more: false };
  if (at === 0) host.storage.set(LAST_QUERY, text);
  const res = await apiGet("/api/cloudsearch/pc", {
    s: text,
    type: config.type,
    limit: PAGE,
    offset: at,
    total: true,
  });
  const result = record(res.result, "result"),
    raw = rows(
      result[config.field] ?? (Number(result[config.count]) === 0 ? [] : undefined),
      config.field,
    );
  const values =
    kind === "tracks" ? await tracksWithPrivileges(raw) : raw.map((item) => config.map(item));
  return {
    [kind]: values,
    more: raw.length > 0 && at + raw.length < Number(result[config.count] || 0),
  };
}

export async function suggest({ query }: { query: string }): Promise<string[]> {
  const text = String(query).trim();
  if (!text) return [];
  const result = record((await apiGet("/api/search/suggest/web", { s: text })).result, "result");
  const suggestions = new Set<string>();
  for (const kind of result.order || ["songs", "artists", "albums", "playlists"]) {
    for (const item of result[kind] || []) if (item.name) suggestions.add(String(item.name));
  }
  return [...suggestions];
}

export async function album({ id: value }: { id: string }): Promise<Raw> {
  const res = await apiGet(`/api/v1/album/${id(value)}`);
  if (!res.album) throw fail("unavailable", "This album is not available.");
  return {
    album: toAlbum(res.album),
    tracks: await tracksWithPrivileges(rows(res.songs, "songs")),
  };
}

function rememberArtist(raw: Raw): void {
  const entry = toArtist(raw),
    old = host.storage.get(RECENT_ARTISTS);
  const entries = Array.isArray(old) ? old.filter((value) => value && value.id !== entry.id) : [];
  host.storage.set(RECENT_ARTISTS, [entry, ...entries].slice(0, 20));
}

async function artistProfile(value: string): Promise<Raw> {
  const res = await apiGet(`/api/v1/artist/${id(value)}`);
  if (!res.artist) throw fail("unavailable", "This artist is not available.");
  return { ...record(res.artist, "artist"), songs: rows(res.hotSongs, "hotSongs") };
}

export async function artist({ id: value }: { id: string }): Promise<Raw> {
  const raw = await artistProfile(value);
  rememberArtist(raw);
  const [tracks, albums] = await Promise.all([
    tracksWithPrivileges(raw.songs),
    apiGet(`/api/artist/albums/${id(value)}`, { limit: PAGE, offset: 0 }),
  ]);
  return {
    artist: toArtist(raw),
    tracks,
    albums: rows(albums.hotAlbums, "hotAlbums").map(toAlbum),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Independent home shelves must not hide failures as empty recommendations.
async function shelf(title: string, load: () => Promise<Section>): Promise<Section> {
  try {
    return { title: t(title), ...(await load()) };
  } catch (error) {
    return {
      title: t(title),
      empty: `${t("Could not load this section")}: ${errorMessage(error)}`,
    };
  }
}

export async function home(): Promise<Browse> {
  const signedIn = hasSession();
  const sections = await Promise.all([
    shelf("Daily Picks", async () => {
      if (!signedIn) return { empty: t("Sign in for your daily song picks.") };
      const res = await apiGet("/api/v3/discovery/recommend/songs");
      return {
        tracks: await tracksWithPrivileges(rows(res.data?.dailySongs, "data.dailySongs")),
        pageTitle: t("Daily Song Picks"),
        empty: t("No daily song picks are available."),
      };
    }),
    shelf(signedIn ? "Recommended Playlists" : "Featured Playlists", async () => {
      const res = signedIn
        ? await apiGet("/api/v1/discovery/recommend/resource")
        : await apiGet("/api/personalized/playlist", { limit: PAGE });
      return {
        playlists: rows(
          signedIn ? res.recommend : res.result,
          signedIn ? "recommend" : "result",
        ).map((raw) => toPlaylist(raw)),
      };
    }),
    shelf("Charts", async () => ({
      playlists: (await chartList()).slice(0, 8).map((raw) => toPlaylist(raw)),
      morePage: "charts",
    })),
    shelf("Recommended Podcasts", async () => ({
      shows: rows((await apiGet("/api/djradio/recommend/v1")).djRadios, "djRadios").map(toShow),
      morePage: "podcasts",
    })),
  ]);
  sections.push({ title: t("Explore More"), links: moreLinks() });
  return { title: t("You Own It"), sections };
}

async function chartList(): Promise<Raw[]> {
  return rows((await apiGet("/api/toplist/detail")).list, "list");
}

function moreLinks(): Link[] {
  return [
    { title: t("Charts"), page: "charts" },
    {
      title: t("Search Users"),
      subtitle: t("Uses your most recently submitted search"),
      page: "users",
    },
    {
      title: t("Artists and Updates"),
      subtitle: t("Followed and recently viewed artists"),
      page: "artists",
    },
    { title: t("Discover Podcasts"), page: "podcasts" },
    { title: t("Featured Playlists"), page: "featured" },
  ];
}

function nextSection(page: string): Section {
  return { links: [{ title: t("Next Page"), page }] };
}

async function usersPage(query: string, offset: number): Promise<Browse> {
  if (!query)
    return {
      title: t("Search Users"),
      sections: [
        { empty: t("Search in the app first, then open this page to find matching users.") },
      ],
    };
  const response = await apiGet("/api/cloudsearch/pc", {
    s: query,
    type: 1002,
    limit: PAGE,
    offset,
    total: true,
  });
  const result = record(response.result, "result");
  const users = rows(
    result.userprofiles ?? (Number(result.userprofileCount) === 0 ? [] : undefined),
    "userprofiles",
  );
  const sections: Section[] = [
    {
      title: query,
      empty: t("No users found."),
      links: users.map((user) => ({
        title: String(user.nickname || ""),
        subtitle: String(user.signature || ""),
        imageUrl: image(user.avatarUrl),
        page: `user:${id(user.userId)}`,
      })),
    },
  ];
  if (users.length && offset + users.length < Number(result.userprofileCount || 0))
    sections.push(nextSection(`users:${encodeURIComponent(query)}:${offset + users.length}`));
  return { title: t("Search Users"), subtitle: query, sections };
}

async function userPage(uid: string, offset: number): Promise<Browse> {
  const [detail, lists] = await Promise.all([
    apiGet(`/api/v1/user/detail/${uid}`),
    apiGet("/api/user/playlist", { uid, limit: PAGE, offset }),
  ]);
  const user = record(detail.profile, "profile"),
    raw = rows(lists.playlist, "playlist");
  const self = hasSession() ? await account() : null;
  const made = raw.filter((list) => String(list.creator?.userId) === uid);
  const saved = raw.filter((list) => String(list.creator?.userId) !== uid);
  const sections: Section[] = [
    {
      title: t("Created Playlists"),
      playlists: made.map((list) => toPlaylist(list, self?.id)),
      empty: t("No public playlists."),
    },
    { title: t("Saved Playlists"), playlists: saved.map((list) => toPlaylist(list, self?.id)) },
    { links: [{ title: t("Updates"), page: `events:${uid}:-1` }] },
  ];
  if (lists.more && raw.length) sections.push(nextSection(`user:${uid}:${offset + raw.length}`));
  return {
    title: String(user.nickname || t("User")),
    imageUrl: image(user.avatarUrl),
    description: String(user.signature || ""),
    subtitle: `${t("Followers")}: ${Number(user.followeds || 0)} · ${t("Following")}: ${Number(user.follows || 0)}`,
    sections,
  };
}

async function followedPage(offset: number): Promise<Browse> {
  await needAccount();
  const res = await apiGet("/api/artist/sublist", { limit: PAGE, offset, total: true });
  const raw = rows(res.data, "data");
  const sections: Section[] = [
    {
      title: t("Followed Artists"),
      links: raw.map((artist) => ({
        title: String(artist.name || ""),
        imageUrl: image(artist.img1v1Url || artist.picUrl),
        page: `artist:${id(artist.id)}`,
      })),
      empty: t("No followed artists."),
    },
  ];
  if (res.hasMore && raw.length)
    sections.push(nextSection(`artists-followed:${offset + raw.length}`));
  return { title: t("Followed Artists"), sections };
}

async function artistsPage(): Promise<Browse> {
  const recent = host.storage.get(RECENT_ARTISTS);
  const raw: Raw[] = Array.isArray(recent) ? recent : [];
  const sections: Section[] = [
    {
      title: t("Recently Viewed Artists"),
      links: raw.map((artist) => ({
        title: String(artist.name || ""),
        imageUrl: artist.imageUrl,
        page: `artist:${id(artist.id)}`,
      })),
      empty: t("Open an artist in the app first to see their extended page here."),
    },
  ];
  if (hasSession()) sections.unshift(...(await followedPage(0)).sections);
  else
    sections.unshift({
      title: t("Followed Artists"),
      empty: t("Sign in to see the artists you follow."),
    });
  return { title: t("Artists and Updates"), sections };
}

async function artistExtended(value: string): Promise<Browse> {
  const raw = await artistProfile(value);
  rememberArtist(raw);
  const links: Link[] = [
    { title: t("Latest Songs"), page: `artist-latest:${value}:0` },
    { title: t("All Albums"), page: `artist-albums:${value}:0` },
  ];
  if (raw.accountId)
    links.push(
      { title: t("Updates"), page: `events:${id(raw.accountId)}:-1` },
      { title: t("User Page"), page: `user:${id(raw.accountId)}` },
    );
  return {
    title: String(raw.name || ""),
    imageUrl: image(raw.img1v1Url || raw.picUrl),
    description: String(raw.briefDesc || ""),
    sections: [
      { links },
      { title: t("Popular Songs"), tracks: await tracksWithPrivileges(raw.songs) },
    ],
  };
}

async function artistLatest(value: string, offset: number): Promise<Browse> {
  const res = await apiPost("/api/v1/artist/songs", {
    id: value,
    order: "time",
    limit: PAGE,
    offset,
  });
  const raw = rows(res.songs, "songs");
  const sections: Section[] = [
    {
      tracks: (await songDetails(raw.map((song) => id(song.id)))).map(toTrack),
      empty: t("No songs found."),
    },
  ];
  const more =
    res.more ??
    res.hasMore ??
    (res.total === undefined ? raw.length === PAGE : offset + raw.length < Number(res.total));
  if (raw.length && more)
    sections.push(nextSection(`artist-latest:${value}:${offset + raw.length}`));
  return { title: t("Latest Songs"), sections };
}

async function artistAlbums(value: string, offset: number): Promise<Browse> {
  const res = await apiGet(`/api/artist/albums/${value}`, { limit: PAGE, offset });
  const raw = rows(res.hotAlbums, "hotAlbums");
  const sections: Section[] = [{ albums: raw.map(toAlbum), empty: t("No albums found.") }];
  if (res.more && raw.length)
    sections.push(nextSection(`artist-albums:${value}:${offset + raw.length}`));
  return { title: t("All Albums"), sections };
}

function parseEvent(raw: Raw): Raw {
  try {
    return typeof raw.json === "string" ? parseJSON(raw.json) : raw.json || {};
  } catch {
    return { msg: t("This update could not be read.") };
  }
}

async function eventsPage(uid: string, before: number): Promise<Browse> {
  const res = await apiGet(`/api/event/get/${uid}`, {
    time: before,
    limit: 20,
    getcounts: true,
    total: false,
  });
  const raw = rows(res.events, "events"),
    sections: Section[] = [];
  const contents = raw.map(parseEvent);
  // Detail requests refresh VIP privileges once for the whole page, rather
  // than serializing up to twenty network round trips within a host call.
  const sharedTracks = await tracksWithPrivileges(
    contents.flatMap((content) => (content.song?.id ? [content.song] : [])),
  );
  let songAt = 0;
  for (let index = 0; index < raw.length; index++) {
    const event = raw[index],
      content = contents[index],
      text: string[] = [String(content.msg || "")];
    if (content.event) {
      const forwarded = parseEvent(content.event);
      text.push(`${content.event.user?.nickname || ""}: ${forwarded.msg || ""}`);
    }
    if (content.mv || content.video)
      text.push(t("Video playback is not supported by this plugin."));
    if (event.pics?.length)
      text.push(
        `${t("Pictures")}: ${event.pics.length} — ${t("Image galleries are not supported by the host.")}`,
      );
    const title = [
      event.eventTime ? new Date(event.eventTime).toISOString().replace("T", " ").slice(0, 16) : "",
      ...text.filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n");
    const section: Section = {
      title,
      empty:
        content.song || content.album || content.artist || content.playlist
          ? undefined
          : t("Text update"),
    };
    if (content.song?.id) section.tracks = [sharedTracks[songAt++]];
    if (content.album?.id) section.albums = [toAlbum(content.album)];
    if (content.artist?.id) section.artists = [toArtist(content.artist)];
    if (content.playlist?.id) section.playlists = [toPlaylist(content.playlist)];
    sections.push(section);
  }
  const last = Number(res.lasttime);
  if (res.more && raw.length) {
    if (!Number.isSafeInteger(last) || last < 0 || (before !== -1 && last >= before))
      throw new Error("NetEase returned a non-advancing event cursor");
    sections.push(nextSection(`events:${uid}:${last}`));
  }
  if (!raw.length) sections.push({ empty: t("No public updates.") });
  return { title: t("Updates"), sections };
}

async function podcastPage(offset?: number): Promise<Browse> {
  const at = offset ?? 0;
  const res = await apiGet("/api/djradio/hot/v1", { limit: PAGE, offset: at });
  const raw = rows(res.djRadios, "djRadios");
  const sections: Section[] = [
    { title: t("Popular Podcasts"), shows: raw.map(toShow), empty: t("No podcasts found.") },
  ];
  if (offset === undefined) {
    const recommended = await shelf("Recommended Podcasts", async () => ({
      shows: rows((await apiGet("/api/djradio/recommend/v1")).djRadios, "djRadios").map(toShow),
    }));
    sections.unshift(recommended);
  }
  if (res.hasMore && raw.length) sections.push(nextSection(`podcasts-hot:${at + raw.length}`));
  return { title: t("Discover Podcasts"), sections };
}

export async function browse({ page }: { page: string }): Promise<Browse> {
  if (page === "more")
    return {
      title: t("Explore More"),
      sections: [
        { links: moreLinks() },
        {
          title: t("Plugin Limitations"),
          empty: t(
            "FM dislike, native user search tabs, image galleries and video playback need host API support. Extended pages preserve the available catalog features.",
          ),
        },
      ],
    };
  if (page === "charts")
    return {
      title: t("Charts"),
      sections: [{ playlists: (await chartList()).map((raw) => toPlaylist(raw)) }],
    };
  if (page === "featured")
    return {
      title: t("Featured Playlists"),
      sections: [
        {
          playlists: rows(
            (await apiGet("/api/personalized/playlist", { limit: 100 })).result,
            "result",
          ).map((raw) => toPlaylist(raw)),
        },
      ],
    };
  if (page === "users") return usersPage(String(host.storage.get(LAST_QUERY) || ""), 0);
  if (page === "artists") return artistsPage();
  if (page === "podcasts") return podcastPage();
  const parts = page.split(":"),
    kind = parts.shift();
  if (kind === "users" && parts.length === 2)
    return usersPage(decodeURIComponent(parts[0]), offsetOf(Number(parts[1])));
  if (kind === "user" && (parts.length === 1 || parts.length === 2))
    return userPage(id(parts[0]), offsetOf(Number(parts[1] || 0)));
  if (kind === "artists-followed" && parts.length === 1)
    return followedPage(offsetOf(Number(parts[0])));
  if (kind === "artist" && parts.length === 1) return artistExtended(id(parts[0]));
  if (kind === "artist-latest" && parts.length === 2)
    return artistLatest(id(parts[0]), offsetOf(Number(parts[1])));
  if (kind === "artist-albums" && parts.length === 2)
    return artistAlbums(id(parts[0]), offsetOf(Number(parts[1])));
  if (kind === "podcasts-hot" && parts.length === 1) return podcastPage(offsetOf(Number(parts[0])));
  if (kind === "events" && parts.length === 2) {
    const before = Number(parts[1]);
    if (before !== -1) offsetOf(before);
    return eventsPage(id(parts[0]), before);
  }
  throw fail("unsupported", "This YOI page does not exist.");
}
