// YOI — You Own It. SPDX-License-Identifier: AGPL-3.0-only
// Derived from egoist/mygo-cloudmusic; see NOTICE.md.
// src/model.ts
var t = (text) => host.t(text);
function fail(code, message) {
	return Object.assign(new Error(t(message)), { code });
}
function id(value) {
	if (typeof value === "string" && /^\d+$/.test(value) && !/^0+$/.test(value)) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	throw new Error("Invalid or unsafe NetEase ID");
}
function offsetOf(value = 0) {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid offset");
	return Number(value);
}
function image(value) {
	if (typeof value !== "string" || !value) return void 0;
	try {
		const url = new URL(value.replace(/^http:/, "https:"));
		if (url.protocol !== "https:") return void 0;
		if (url.hostname.endsWith(".music.126.net") || url.hostname.endsWith(".music.163.com")) url.searchParams.set("param", "{size}y{size}");
		return url.toString();
	} catch {
		return;
	}
}
function toArtist(raw) {
	return {
		id: raw.id && String(raw.id) !== "0" ? id(raw.id) : "",
		name: String(raw.name || ""),
		imageUrl: image(raw.img1v1Url || raw.picUrl),
		following: !!(raw.followed ?? raw.following)
	};
}
function toAlbum(raw = {}) {
	const artists = raw.artists || (raw.artist ? [raw.artist] : []);
	return {
		id: raw.id ? id(raw.id) : "",
		name: String(raw.name || ""),
		imageUrl: image(raw.picUrl),
		artists: artists.map(toArtist),
		released: raw.publishTime ? new Date(raw.publishTime).toISOString().slice(0, 10) : void 0
	};
}
function toTrack(raw) {
	const privilege = raw.privilege;
	const unavailable = privilege ? Number(privilege.st) < 0 || Number(privilege.pl) <= 0 : raw.fee === 1 || raw.fee === 4;
	const song = id(raw.id);
	return {
		id: `song:${song}`,
		name: String(raw.name || ""),
		artists: (raw.ar || raw.artists || []).map(toArtist),
		album: toAlbum(raw.al || raw.album),
		duration: Number(raw.dt ?? raw.duration ?? 0),
		url: `https://music.163.com/song?id=${song}`,
		unavailable
	};
}
function toPlaylist(raw, uid) {
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
		fixed: mine && Number(raw.specialType) === 5
	};
}
function toShow(raw) {
	return {
		id: id(raw.id),
		name: String(raw.name || ""),
		imageUrl: image(raw.picUrl),
		description: String(raw.desc || ""),
		publisher: String(raw.dj?.nickname || ""),
		publisherPage: raw.dj?.userId ? `user:${id(raw.dj.userId)}` : void 0,
		episodeCount: Number(raw.programCount || 0),
		subscribed: !!raw.subed
	};
}
function toProgram(raw, show) {
	const program = id(raw.id), audio = id(raw.mainSong?.id), showId = id(show.id);
	return {
		id: `program:${program}:${audio}`,
		name: String(raw.name || ""),
		artists: show.dj?.nickname ? [{
			id: "",
			name: String(show.dj.nickname)
		}] : [],
		album: {
			id: "",
			name: String(show.name || ""),
			imageUrl: image(raw.coverUrl || show.picUrl)
		},
		duration: Number(raw.duration || 0),
		url: `https://music.163.com/program?id=${program}`,
		showId,
		description: String(raw.description || ""),
		published: raw.createTime ? new Date(raw.createTime).toISOString().slice(0, 10) : void 0
	};
}
function decodeTrack(value) {
	const song = /^song:(\d+)$/.exec(value);
	if (song) return { songId: id(song[1]) };
	const program = /^program:(\d+):(\d+)$/.exec(value);
	if (program) return {
		programId: id(program[1]),
		songId: id(program[2])
	};
	throw new Error("Invalid YOI track ID");
}
function threadOf(value) {
	const track = decodeTrack(value);
	return track.programId ? `A_DJ_1_${track.programId}` : `R_SO_4_${track.songId}`;
}
// src/api.ts
var SITE = "https://music.163.com";
var EAPI_SITE = "https://interfacepc.music.163.com";
var EAPI_KEY = "e82ckenh8dichen8";
var WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
var DESKTOP_CLIENT = {
	os: "pc",
	appver: "3.1.17.204416",
	osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
	channel: "netease",
	versioncode: "140"
};
var EAPI_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.164 Safari/537.36 NeteaseMusicDesktop/${DESKTOP_CLIENT.appver}`;
var COOKIE_NAMES = /* @__PURE__ */ new Set([
	"MUSIC_U",
	"__csrf",
	"NMTID",
	"MUSIC_A"
]);
var REQUEST_TIMEOUT = 2e4;
var epoch = 0;
var listeners = /* @__PURE__ */ new Set();
var sessionEpoch = () => epoch;
function onSessionChange(callback) {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}
function notify() {
	for (const callback of listeners) callback();
}
function clearSession() {
	epoch++;
	host.storage.remove("session");
	notify();
}
function readCookies() {
	const stored = host.storage.get("session");
	if (stored?.version !== 1 || !Array.isArray(stored.cookies)) return [];
	const valid = (cookie) => !!cookie && COOKIE_NAMES.has(cookie.name) && typeof cookie.value === "string" && !/[\r\n;]/.test(cookie.value);
	const all = stored.cookies.filter(valid);
	const live = all.filter((cookie) => cookie.expires === void 0 || Number.isFinite(cookie.expires) && cookie.expires > Date.now());
	if (all.some((cookie) => cookie.name === "MUSIC_U") && !live.some((cookie) => cookie.name === "MUSIC_U")) {
		clearSession();
		return [];
	}
	return live;
}
var hasSession = () => readCookies().some((cookie) => cookie.name === "MUSIC_U" && cookie.value !== "");
function setCookieLines(headers) {
	const native = headers.getSetCookie;
	if (native) return native.call(headers);
	const combined = headers.get("set-cookie");
	return combined ? combined.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}
function mergeCookies(headers, started) {
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
		let expires;
		let maxAge;
		let domain;
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
		if (domain && domain !== "music.163.com" && domain !== "163.com" && domain !== "interfacepc.music.163.com") continue;
		if (maxAge !== void 0) expires = Date.now() + maxAge * 1e3;
		if (!value || expires !== void 0 && expires <= Date.now()) cookies.delete(name);
		else cookies.set(name, {
			name,
			value,
			...expires === void 0 ? {} : { expires }
		});
		changed = true;
	}
	if (!changed) return;
	if (before && !cookies.get("MUSIC_U")?.value) {
		clearSession();
		return;
	}
	host.storage.set("session", {
		version: 1,
		cookies: [...cookies.values()]
	});
	if (before !== cookies.get("MUSIC_U")?.value) notify();
}
function pathOf(path) {
	if (!/^\/api\/[A-Za-z0-9_/-]+$/.test(path)) throw new Error("Invalid NetEase API path");
	return path;
}
function formOf(data) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(data)) if (value !== void 0 && value !== null) params.set(key, String(value));
	return params;
}
function parseJSON(text) {
	let output = "", at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === "\"") {
			const start = at++;
			while (at < text.length) {
				if (text[at] === "\\") {
					at += 2;
					continue;
				}
				if (text[at++] === "\"") break;
			}
			output += text.slice(start, at);
		} else if (char === "-" || /[0-9]/.test(char)) {
			const start = at++;
			while (at < text.length && /[0-9.eE+-]/.test(text[at])) at++;
			const token = text.slice(start, at);
			output += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
		} else {
			output += char;
			at++;
		}
	}
	const result = JSON.parse(output);
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid NetEase API response");
	return result;
}
var NetEaseError = class extends Error {
	apiCode;
	constructor(path, code, message) {
		super(`${t("NetEase request failed")}: ${path}: ${code}${message ? ` ${message}` : ""}`);
		this.name = "NetEaseError";
		this.apiCode = code;
	}
};
async function request(url, init, acceptedCodes, started) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
	try {
		const response = await fetch(url, {
			...init,
			redirect: "error",
			signal: controller.signal
		});
		if (started !== epoch) throw fail("sessionChanged", "Your account changed. Try again.");
		if (!response.ok) {
			if (response.status === 401) {
				clearSession();
				throw fail("signIn", "Your NetEase session has ended. Sign in again.");
			}
			throw Object.assign(/* @__PURE__ */ new Error(`${t("NetEase request failed")}: HTTP ${response.status}`), { status: response.status });
		}
		let body;
		try {
			body = parseJSON(await response.text());
		} catch {
			throw new Error(t("NetEase returned an invalid response. Try again."));
		}
		if (started !== epoch) throw fail("sessionChanged", "Your account changed. Try again.");
		const code = Number(body.code);
		if (!acceptedCodes.includes(code)) {
			if ([
				301,
				302,
				401
			].includes(code)) {
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
async function apiGet(path, params = {}) {
	pathOf(path);
	const cookies = readCookies();
	const query = formOf(params).toString();
	return request(`${SITE}${path}${query ? `?${query}` : ""}`, {
		method: "GET",
		headers: {
			"user-agent": WEB_UA,
			referer: `${SITE}/`,
			cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
		}
	}, [200], epoch);
}
async function apiPost(path, data = {}) {
	pathOf(path);
	const cookies = readCookies();
	const csrf = cookies.find((cookie) => cookie.name === "__csrf")?.value;
	return request(`${SITE}${path}`, {
		method: "POST",
		headers: {
			"user-agent": WEB_UA,
			referer: `${SITE}/`,
			"content-type": "application/x-www-form-urlencoded",
			cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
		},
		body: formOf({
			...csrf ? { csrf_token: csrf } : {},
			...data
		}).toString()
	}, [200], epoch);
}
function deviceId() {
	const saved = host.storage.get("deviceId");
	if (typeof saved === "string" && /^[0-9A-F]{52}$/.test(saved)) return saved;
	const value = Array.from({ length: 52 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join("");
	host.storage.set("deviceId", value);
	return value;
}
function encryptEapi(path, data) {
	pathOf(path);
	const text = JSON.stringify(data);
	const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
	return host.crypto.aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`).toUpperCase();
}
async function eapi(path, data = {}, acceptedCodes = [200]) {
	pathOf(path);
	const cookies = readCookies();
	const header = {
		...DESKTOP_CLIENT,
		deviceId: deviceId(),
		mobilename: "",
		buildver: String(Math.floor(Date.now() / 1e3)),
		resolution: "1920x1080",
		requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`,
		__csrf: ""
	};
	for (const cookie of cookies) header[cookie.name] = cookie.value;
	const params = encryptEapi(path, {
		...data,
		header,
		e_r: false
	});
	return request(`${EAPI_SITE}/eapi/${path.slice(5)}`, {
		method: "POST",
		headers: {
			"user-agent": EAPI_UA,
			"content-type": "application/x-www-form-urlencoded",
			cookie: Object.entries(header).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("; ")
		},
		body: new URLSearchParams({ params }).toString()
	}, acceptedCodes, epoch);
}
var delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// src/auth.ts
var cached;
var loading;
var signing;
onSessionChange(() => {
	cached = void 0;
	loading = void 0;
});
function profileOf(profile) {
	const uid = id(profile.userId);
	return {
		id: uid,
		name: String(profile.nickname || ""),
		imageUrl: image(profile.avatarUrl),
		page: `user:${uid}`
	};
}
async function account() {
	if (!hasSession()) return null;
	const generation = sessionEpoch();
	if (cached?.epoch === generation && cached.until > Date.now()) return cached.value;
	if (loading?.epoch === generation) return loading.promise;
	const promise = (async () => {
		try {
			const response = await apiGet("/api/nuser/account/get");
			if (sessionEpoch() !== generation) return null;
			if (!response.profile?.userId) {
				clearSession();
				return null;
			}
			const value = profileOf(response.profile);
			cached = {
				value,
				until: Date.now() + 3e4,
				epoch: generation
			};
			return value;
		} catch (error) {
			if (error.code === "signIn" || sessionEpoch() !== generation) return null;
			throw error;
		}
	})();
	loading = {
		epoch: generation,
		promise
	};
	try {
		return await promise;
	} finally {
		if (loading?.promise === promise) loading = void 0;
	}
}
async function needAccount() {
	const value = await account();
	if (!value) throw fail("signIn", "Sign in to NetEase first.");
	return value;
}
function checkGeneration(generation) {
	if (sessionEpoch() !== generation) throw fail("sessionChanged", "Sign-in was cancelled. Try again.");
}
async function qrSignIn() {
	clearSession();
	const generation = sessionEpoch();
	const deadline = Date.now() + 24e4;
	try {
		while (Date.now() < deadline) {
			checkGeneration(generation);
			const key = await eapi("/api/login/qrcode/unikey", { type: 3 });
			checkGeneration(generation);
			if (typeof key.unikey !== "string" || !key.unikey) throw new Error(t("NetEase did not provide a login QR code. Try again."));
			const qr = `https://music.163.com/login?codekey=${encodeURIComponent(key.unikey)}`;
			host.signInPrompt({
				qr,
				text: t("Scan with the NetEase Cloud Music app to sign in.")
			});
			while (Date.now() < deadline) {
				await delay(1500);
				checkGeneration(generation);
				const response = await eapi("/api/login/qrcode/client/login", {
					key: key.unikey,
					type: 3
				}, [
					800,
					801,
					802,
					803
				]);
				checkGeneration(generation);
				if (response.code === 800) {
					host.signInPrompt({ text: t("The QR code expired. Getting a new one…") });
					break;
				}
				if (response.code === 802) host.signInPrompt({
					qr,
					text: t("Scanned. Confirm sign-in on your phone.")
				});
				if (response.code === 803) {
					if (!hasSession()) throw new Error(t("NetEase confirmed sign-in without a session cookie. Try again."));
					const value = await account();
					checkGeneration(generation);
					if (!value) throw fail("signIn", "NetEase could not confirm your account. Sign in again.");
					host.signInPrompt({ text: t("Signed in.") });
					return value;
				}
			}
		}
		throw new Error(t("Sign-in timed out. Try again."));
	} catch (error) {
		if (sessionEpoch() === generation) clearSession();
		throw error;
	}
}
function signIn() {
	if (!signing) {
		const attempt = qrSignIn();
		signing = attempt;
		attempt.finally(() => {
			if (signing === attempt) signing = void 0;
		}).catch(() => {});
	}
	return signing;
}
async function signOut() {
	const revoke = hasSession() ? apiPost("/api/logout") : void 0;
	clearSession();
	signing = void 0;
	if (revoke) await revoke.catch(() => {});
}
// src/catalog.ts
var PAGE = 30;
var LAST_QUERY = "lastSearchQuery";
var RECENT_ARTISTS = "recentArtists";
function rows(value, field) {
	if (!Array.isArray(value)) throw new Error(`${t("NetEase returned an invalid catalog response. Try again.")} (${field})`);
	return value;
}
function record(value, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${t("NetEase returned an invalid catalog response. Try again.")} (${field})`);
	return value;
}
async function songDetails(ids) {
	const requested = ids.map(id);
	const byID = /* @__PURE__ */ new Map();
	for (let start = 0; start < requested.length; start += 400) {
		const batch = requested.slice(start, start + 400);
		const res = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((song) => ({ id: song }))) });
		if (!Array.isArray(res.songs)) throw new Error("NetEase returned an invalid song detail response");
		const privileges = new Map((res.privileges || []).map((p) => [id(p.id), p]));
		for (const song of res.songs || []) {
			const songID = id(song.id);
			byID.set(songID, {
				...song,
				privilege: privileges.get(songID) || song.privilege
			});
		}
	}
	return requested.map((song) => {
		return byID.get(song) || {
			id: song,
			name: t("Unavailable track"),
			privilege: {
				id: song,
				st: -1,
				pl: 0
			}
		};
	});
}
async function tracksWithPrivileges(raw) {
	if (!raw.length) return [];
	const details = await songDetails(raw.map((song) => id(song.id)));
	return raw.map((song, i) => toTrack({
		...song,
		privilege: details[i]?.privilege ?? song.privilege
	}));
}
var searchKinds = {
	tracks: {
		type: 1,
		field: "songs",
		count: "songCount",
		map: toTrack
	},
	albums: {
		type: 10,
		field: "albums",
		count: "albumCount",
		map: toAlbum
	},
	artists: {
		type: 100,
		field: "artists",
		count: "artistCount",
		map: toArtist
	},
	playlists: {
		type: 1e3,
		field: "playlists",
		count: "playlistCount",
		map: toPlaylist
	},
	shows: {
		type: 1009,
		field: "djRadios",
		count: "djRadiosCount",
		map: toShow
	}
};
async function search({ query, kind, offset = 0 }) {
	const config = searchKinds[kind];
	if (!config) throw fail("unsupported", "This search kind is not supported.");
	const at = offsetOf(offset), text = String(query).trim();
	if (!text) return {
		[kind]: [],
		more: false
	};
	if (at === 0) host.storage.set(LAST_QUERY, text);
	const result = record((await apiGet("/api/cloudsearch/pc", {
		s: text,
		type: config.type,
		limit: PAGE,
		offset: at,
		total: true
	})).result, "result"), raw = rows(result[config.field] ?? (Number(result[config.count]) === 0 ? [] : void 0), config.field);
	const values = kind === "tracks" ? await tracksWithPrivileges(raw) : raw.map((item) => config.map(item));
	return {
		[kind]: values,
		more: raw.length > 0 && at + raw.length < Number(result[config.count] || 0)
	};
}
async function suggest({ query }) {
	const text = String(query).trim();
	if (!text) return [];
	const result = record((await apiGet("/api/search/suggest/web", { s: text })).result, "result");
	const suggestions = /* @__PURE__ */ new Set();
	for (const kind of result.order || [
		"songs",
		"artists",
		"albums",
		"playlists"
	]) for (const item of result[kind] || []) if (item.name) suggestions.add(String(item.name));
	return [...suggestions];
}
async function album({ id: value }) {
	const res = await apiGet(`/api/v1/album/${id(value)}`);
	if (!res.album) throw fail("unavailable", "This album is not available.");
	return {
		album: toAlbum(res.album),
		tracks: await tracksWithPrivileges(rows(res.songs, "songs"))
	};
}
function rememberArtist(raw) {
	const entry = toArtist(raw), old = host.storage.get(RECENT_ARTISTS);
	const entries = Array.isArray(old) ? old.filter((value) => value && value.id !== entry.id) : [];
	host.storage.set(RECENT_ARTISTS, [entry, ...entries].slice(0, 20));
}
async function artistProfile(value) {
	const res = await apiGet(`/api/v1/artist/${id(value)}`);
	if (!res.artist) throw fail("unavailable", "This artist is not available.");
	return {
		...record(res.artist, "artist"),
		songs: rows(res.hotSongs, "hotSongs")
	};
}
async function artist({ id: value }) {
	const raw = await artistProfile(value);
	rememberArtist(raw);
	const [tracks, albums] = await Promise.all([tracksWithPrivileges(raw.songs), apiGet(`/api/artist/albums/${id(value)}`, {
		limit: PAGE,
		offset: 0
	})]);
	return {
		artist: toArtist(raw),
		tracks,
		albums: rows(albums.hotAlbums, "hotAlbums").map(toAlbum)
	};
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
async function shelf(title, load) {
	try {
		return {
			title: t(title),
			...await load()
		};
	} catch (error) {
		return {
			title: t(title),
			empty: `${t("Could not load this section")}: ${errorMessage(error)}`
		};
	}
}
async function home() {
	const signedIn = hasSession();
	const sections = await Promise.all([
		shelf("Daily Picks", async () => {
			if (!signedIn) return { empty: t("Sign in for your daily song picks.") };
			return {
				tracks: await tracksWithPrivileges(rows((await apiGet("/api/v3/discovery/recommend/songs")).data?.dailySongs, "data.dailySongs")),
				pageTitle: t("Daily Song Picks"),
				empty: t("No daily song picks are available.")
			};
		}),
		shelf(signedIn ? "Recommended Playlists" : "Featured Playlists", async () => {
			const res = signedIn ? await apiGet("/api/v1/discovery/recommend/resource") : await apiGet("/api/personalized/playlist", { limit: PAGE });
			return { playlists: rows(signedIn ? res.recommend : res.result, signedIn ? "recommend" : "result").map((raw) => toPlaylist(raw)) };
		}),
		shelf("Charts", async () => ({
			playlists: (await chartList()).slice(0, 8).map((raw) => toPlaylist(raw)),
			morePage: "charts"
		})),
		shelf("Recommended Podcasts", async () => ({
			shows: rows((await apiGet("/api/djradio/recommend/v1")).djRadios, "djRadios").map(toShow),
			morePage: "podcasts"
		}))
	]);
	sections.push({
		title: t("Explore More"),
		links: moreLinks()
	});
	return {
		title: t("You Own It"),
		sections
	};
}
async function chartList() {
	return rows((await apiGet("/api/toplist/detail")).list, "list");
}
function moreLinks() {
	return [
		{
			title: t("Charts"),
			page: "charts"
		},
		{
			title: t("Search Users"),
			subtitle: t("Uses your most recently submitted search"),
			page: "users"
		},
		{
			title: t("Artists and Updates"),
			subtitle: t("Followed and recently viewed artists"),
			page: "artists"
		},
		{
			title: t("Discover Podcasts"),
			page: "podcasts"
		},
		{
			title: t("Featured Playlists"),
			page: "featured"
		}
	];
}
function nextSection(page) {
	return { links: [{
		title: t("Next Page"),
		page
	}] };
}
async function usersPage(query, offset) {
	if (!query) return {
		title: t("Search Users"),
		sections: [{ empty: t("Search in the app first, then open this page to find matching users.") }]
	};
	const result = record((await apiGet("/api/cloudsearch/pc", {
		s: query,
		type: 1002,
		limit: PAGE,
		offset,
		total: true
	})).result, "result");
	const users = rows(result.userprofiles ?? (Number(result.userprofileCount) === 0 ? [] : void 0), "userprofiles");
	const sections = [{
		title: query,
		empty: t("No users found."),
		links: users.map((user) => ({
			title: String(user.nickname || ""),
			subtitle: String(user.signature || ""),
			imageUrl: image(user.avatarUrl),
			page: `user:${id(user.userId)}`
		}))
	}];
	if (users.length && offset + users.length < Number(result.userprofileCount || 0)) sections.push(nextSection(`users:${encodeURIComponent(query)}:${offset + users.length}`));
	return {
		title: t("Search Users"),
		subtitle: query,
		sections
	};
}
async function userPage(uid, offset) {
	const [detail, lists] = await Promise.all([apiGet(`/api/v1/user/detail/${uid}`), apiGet("/api/user/playlist", {
		uid,
		limit: PAGE,
		offset
	})]);
	const user = record(detail.profile, "profile"), raw = rows(lists.playlist, "playlist");
	const self = hasSession() ? await account() : null;
	const made = raw.filter((list) => String(list.creator?.userId) === uid);
	const saved = raw.filter((list) => String(list.creator?.userId) !== uid);
	const sections = [
		{
			title: t("Created Playlists"),
			playlists: made.map((list) => toPlaylist(list, self?.id)),
			empty: t("No public playlists.")
		},
		{
			title: t("Saved Playlists"),
			playlists: saved.map((list) => toPlaylist(list, self?.id))
		},
		{ links: [{
			title: t("Updates"),
			page: `events:${uid}:-1`
		}] }
	];
	if (lists.more && raw.length) sections.push(nextSection(`user:${uid}:${offset + raw.length}`));
	return {
		title: String(user.nickname || t("User")),
		imageUrl: image(user.avatarUrl),
		description: String(user.signature || ""),
		subtitle: `${t("Followers")}: ${Number(user.followeds || 0)} · ${t("Following")}: ${Number(user.follows || 0)}`,
		sections
	};
}
async function followedPage(offset) {
	await needAccount();
	const res = await apiGet("/api/artist/sublist", {
		limit: PAGE,
		offset,
		total: true
	});
	const raw = rows(res.data, "data");
	const sections = [{
		title: t("Followed Artists"),
		links: raw.map((artist) => ({
			title: String(artist.name || ""),
			imageUrl: image(artist.img1v1Url || artist.picUrl),
			page: `artist:${id(artist.id)}`
		})),
		empty: t("No followed artists.")
	}];
	if (res.hasMore && raw.length) sections.push(nextSection(`artists-followed:${offset + raw.length}`));
	return {
		title: t("Followed Artists"),
		sections
	};
}
async function artistsPage() {
	const recent = host.storage.get(RECENT_ARTISTS);
	const raw = Array.isArray(recent) ? recent : [];
	const sections = [{
		title: t("Recently Viewed Artists"),
		links: raw.map((artist) => ({
			title: String(artist.name || ""),
			imageUrl: artist.imageUrl,
			page: `artist:${id(artist.id)}`
		})),
		empty: t("Open an artist in the app first to see their extended page here.")
	}];
	if (hasSession()) sections.unshift(...(await followedPage(0)).sections);
	else sections.unshift({
		title: t("Followed Artists"),
		empty: t("Sign in to see the artists you follow.")
	});
	return {
		title: t("Artists and Updates"),
		sections
	};
}
async function artistExtended(value) {
	const raw = await artistProfile(value);
	rememberArtist(raw);
	const links = [{
		title: t("Latest Songs"),
		page: `artist-latest:${value}:0`
	}, {
		title: t("All Albums"),
		page: `artist-albums:${value}:0`
	}];
	if (raw.accountId) links.push({
		title: t("Updates"),
		page: `events:${id(raw.accountId)}:-1`
	}, {
		title: t("User Page"),
		page: `user:${id(raw.accountId)}`
	});
	return {
		title: String(raw.name || ""),
		imageUrl: image(raw.img1v1Url || raw.picUrl),
		description: String(raw.briefDesc || ""),
		sections: [{ links }, {
			title: t("Popular Songs"),
			tracks: await tracksWithPrivileges(raw.songs)
		}]
	};
}
async function artistLatest(value, offset) {
	const res = await apiPost("/api/v1/artist/songs", {
		id: value,
		order: "time",
		limit: PAGE,
		offset
	});
	const raw = rows(res.songs, "songs");
	const sections = [{
		tracks: (await songDetails(raw.map((song) => id(song.id)))).map(toTrack),
		empty: t("No songs found.")
	}];
	const more = res.more ?? res.hasMore ?? (res.total === void 0 ? raw.length === PAGE : offset + raw.length < Number(res.total));
	if (raw.length && more) sections.push(nextSection(`artist-latest:${value}:${offset + raw.length}`));
	return {
		title: t("Latest Songs"),
		sections
	};
}
async function artistAlbums(value, offset) {
	const res = await apiGet(`/api/artist/albums/${value}`, {
		limit: PAGE,
		offset
	});
	const raw = rows(res.hotAlbums, "hotAlbums");
	const sections = [{
		albums: raw.map(toAlbum),
		empty: t("No albums found.")
	}];
	if (res.more && raw.length) sections.push(nextSection(`artist-albums:${value}:${offset + raw.length}`));
	return {
		title: t("All Albums"),
		sections
	};
}
function parseEvent(raw) {
	try {
		return typeof raw.json === "string" ? parseJSON(raw.json) : raw.json || {};
	} catch {
		return { msg: t("This update could not be read.") };
	}
}
async function eventsPage(uid, before) {
	const res = await apiGet(`/api/event/get/${uid}`, {
		time: before,
		limit: 20,
		getcounts: true,
		total: false
	});
	const raw = rows(res.events, "events"), sections = [];
	const contents = raw.map(parseEvent);
	const sharedTracks = await tracksWithPrivileges(contents.flatMap((content) => content.song?.id ? [content.song] : []));
	let songAt = 0;
	for (let index = 0; index < raw.length; index++) {
		const event = raw[index], content = contents[index], text = [String(content.msg || "")];
		if (content.event) {
			const forwarded = parseEvent(content.event);
			text.push(`${content.event.user?.nickname || ""}: ${forwarded.msg || ""}`);
		}
		if (content.mv || content.video) text.push(t("Video playback is not supported by this plugin."));
		if (event.pics?.length) text.push(`${t("Pictures")}: ${event.pics.length} — ${t("Image galleries are not supported by the host.")}`);
		const section = {
			title: [event.eventTime ? new Date(event.eventTime).toISOString().replace("T", " ").slice(0, 16) : "", ...text.filter(Boolean)].filter(Boolean).join("\n"),
			empty: content.song || content.album || content.artist || content.playlist ? void 0 : t("Text update")
		};
		if (content.song?.id) section.tracks = [sharedTracks[songAt++]];
		if (content.album?.id) section.albums = [toAlbum(content.album)];
		if (content.artist?.id) section.artists = [toArtist(content.artist)];
		if (content.playlist?.id) section.playlists = [toPlaylist(content.playlist)];
		sections.push(section);
	}
	const last = Number(res.lasttime);
	if (res.more && raw.length) {
		if (!Number.isSafeInteger(last) || last < 0 || before !== -1 && last >= before) throw new Error("NetEase returned a non-advancing event cursor");
		sections.push(nextSection(`events:${uid}:${last}`));
	}
	if (!raw.length) sections.push({ empty: t("No public updates.") });
	return {
		title: t("Updates"),
		sections
	};
}
async function podcastPage(offset) {
	const at = offset ?? 0;
	const res = await apiGet("/api/djradio/hot/v1", {
		limit: PAGE,
		offset: at
	});
	const raw = rows(res.djRadios, "djRadios");
	const sections = [{
		title: t("Popular Podcasts"),
		shows: raw.map(toShow),
		empty: t("No podcasts found.")
	}];
	if (offset === void 0) {
		const recommended = await shelf("Recommended Podcasts", async () => ({ shows: rows((await apiGet("/api/djradio/recommend/v1")).djRadios, "djRadios").map(toShow) }));
		sections.unshift(recommended);
	}
	if (res.hasMore && raw.length) sections.push(nextSection(`podcasts-hot:${at + raw.length}`));
	return {
		title: t("Discover Podcasts"),
		sections
	};
}
async function browse({ page }) {
	if (page === "more") return {
		title: t("Explore More"),
		sections: [{ links: moreLinks() }, {
			title: t("Plugin Limitations"),
			empty: t("FM dislike, native user search tabs, image galleries and video playback need host API support. Extended pages preserve the available catalog features.")
		}]
	};
	if (page === "charts") return {
		title: t("Charts"),
		sections: [{ playlists: (await chartList()).map((raw) => toPlaylist(raw)) }]
	};
	if (page === "featured") return {
		title: t("Featured Playlists"),
		sections: [{ playlists: rows((await apiGet("/api/personalized/playlist", { limit: 100 })).result, "result").map((raw) => toPlaylist(raw)) }]
	};
	if (page === "users") return usersPage(String(host.storage.get(LAST_QUERY) || ""), 0);
	if (page === "artists") return artistsPage();
	if (page === "podcasts") return podcastPage();
	const parts = page.split(":"), kind = parts.shift();
	if (kind === "users" && parts.length === 2) return usersPage(decodeURIComponent(parts[0]), offsetOf(Number(parts[1])));
	if (kind === "user" && (parts.length === 1 || parts.length === 2)) return userPage(id(parts[0]), offsetOf(Number(parts[1] || 0)));
	if (kind === "artists-followed" && parts.length === 1) return followedPage(offsetOf(Number(parts[0])));
	if (kind === "artist" && parts.length === 1) return artistExtended(id(parts[0]));
	if (kind === "artist-latest" && parts.length === 2) return artistLatest(id(parts[0]), offsetOf(Number(parts[1])));
	if (kind === "artist-albums" && parts.length === 2) return artistAlbums(id(parts[0]), offsetOf(Number(parts[1])));
	if (kind === "podcasts-hot" && parts.length === 1) return podcastPage(offsetOf(Number(parts[0])));
	if (kind === "events" && parts.length === 2) {
		const before = Number(parts[1]);
		if (before !== -1) offsetOf(before);
		return eventsPage(id(parts[0]), before);
	}
	throw fail("unsupported", "This YOI page does not exist.");
}
// src/library.ts
var pageSize$2 = 200;
var likedPageSize = 100;
var likeTTL = 15e3;
var likes;
var likeRequest;
var likesVersion = 0;
var heart;
var stationChain = Promise.resolve();
onSessionChange(() => {
	likes = void 0;
	likeRequest = void 0;
	likesVersion++;
	heart = void 0;
	host.storage.remove("lastPlayed");
});
function current(epoch) {
	if (sessionEpoch() !== epoch) throw fail("signIn", "Your account changed. Please try again.");
}
var numericIds = (values) => `[${values.map(id).join(",")}]`;
var checkName = (name) => {
	if (typeof name !== "string" || !name.trim()) throw new Error(t("Enter a playlist name."));
	return name.trim();
};
async function userPlaylistRows(uid) {
	uid = id(uid);
	const epoch = sessionEpoch();
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	let offset = 0;
	for (;;) {
		const page = await apiGet("/api/user/playlist", {
			uid,
			limit: pageSize$2,
			offset
		});
		current(epoch);
		const rows = page.playlist || [];
		let added = 0;
		for (const row of rows) {
			const key = id(row.id);
			if (!seen.has(key)) {
				seen.add(key);
				result.push(row);
				added++;
			}
		}
		if (!page.more && (page.more === false || rows.length < pageSize$2)) return result;
		if (!rows.length || !added) throw new Error(t("The playlist list stopped advancing. Please try again."));
		offset += rows.length;
	}
}
async function playlists() {
	const me = await needAccount();
	const epoch = sessionEpoch();
	const rows = await userPlaylistRows(me.id);
	current(epoch);
	return rows.map((row) => toPlaylist(row, me.id));
}
async function playlistRow(playlistId) {
	const response = await apiGet("/api/v6/playlist/detail", {
		id: id(playlistId),
		n: 1e3
	});
	if (!response.playlist || String(response.playlist.id) !== playlistId) throw fail("unavailable", "This playlist is not available.");
	return response.playlist;
}
async function playlist({ id: playlistId }) {
	playlistId = id(playlistId);
	const epoch = sessionEpoch();
	const [row, me] = await Promise.all([playlistRow(playlistId), account()]);
	current(epoch);
	const tracks = row.tracks || [];
	const ids = (row.trackIds || []).map((entry) => id(entry.id));
	if (Number(row.trackCount || 0) > (ids.length || tracks.length)) throw new Error(t("The service did not return the complete playlist. Please try again."));
	const complete = ids.length ? await songDetails(ids) : await songDetails(tracks.map((track) => id(track.id)));
	current(epoch);
	const byId = new Map(complete.map((track) => [id(track.id), track]));
	const ordered = (ids.length ? ids : tracks.map((track) => id(track.id))).map((song) => {
		const detail = byId.get(song);
		return detail ? toTrack(detail) : toTrack({
			id: song,
			name: t("Unavailable track"),
			privilege: {
				st: -1,
				pl: 0
			}
		});
	});
	return {
		...toPlaylist(row, me?.id),
		tracks: ordered,
		trackCount: ordered.length
	};
}
async function likedSongIds(refresh = false) {
	const me = await needAccount();
	const epoch = sessionEpoch();
	if (!refresh && likes?.epoch === epoch && likes.uid === me.id && Date.now() - likes.at < likeTTL) return [...likes.ids];
	if (!refresh && likeRequest?.epoch === epoch && likeRequest.uid === me.id) return [...await likeRequest.promise];
	const version = likesVersion;
	const request = (async () => {
		const response = await eapi("/api/song/like/get", { uid: me.id });
		current(epoch);
		const ids = [...new Set((response.ids || []).map(id))];
		if (likesVersion === version) likes = {
			epoch,
			uid: me.id,
			at: Date.now(),
			ids
		};
		return ids;
	})();
	const inFlight = {
		epoch,
		uid: me.id,
		promise: request
	};
	likeRequest = inFlight;
	try {
		return [...await request];
	} finally {
		if (likeRequest === inFlight) likeRequest = void 0;
	}
}
async function liked({ offset = 0 } = {}) {
	offset = offsetOf(offset);
	const epoch = sessionEpoch();
	const me = await needAccount();
	const rows = await userPlaylistRows(me.id);
	current(epoch);
	const likedPlaylist = rows.find((row) => String(row.creator?.userId) === me.id && Number(row.specialType) === 5);
	let ids;
	if (likedPlaylist) {
		const row = await playlistRow(id(likedPlaylist.id));
		ids = (row.trackIds || row.tracks || []).map((song) => id(song.id));
		if (Number(row.trackCount || 0) > ids.length) throw new Error(t("The service did not return all liked songs. Please try again."));
	} else ids = await likedSongIds(offset === 0);
	current(epoch);
	const details = await songDetails(ids.slice(offset, offset + likedPageSize));
	current(epoch);
	const byId = new Map(details.map((song) => [id(song.id), song]));
	return {
		tracks: ids.slice(offset, offset + likedPageSize).map((song) => toTrack(byId.get(song) || {
			id: song,
			name: t("Unavailable track"),
			privilege: {
				st: -1,
				pl: 0
			}
		})),
		more: offset + likedPageSize < ids.length
	};
}
async function isLiked({ ids }) {
	if (!Array.isArray(ids)) throw new Error("Expected track IDs");
	const decoded = ids.map((value) => ({
		value,
		...decodeTrack(value)
	}));
	const result = Object.fromEntries(ids.map((value) => [value, false]));
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
			resourceIds: numericIds(batch.map((track) => track.programId))
		});
		const states = new Map((response.data || []).map((row) => [id(row.resourceId), !!row.liked]));
		for (const episode of batch) result[episode.value] = states.get(episode.programId) || false;
	}
	current(epoch);
	return result;
}
async function like({ id: trackId, on }) {
	const track = decodeTrack(trackId);
	if (track.programId) throw fail("unsupported", "Use the episode like action for podcast episodes.");
	await needAccount();
	const epoch = sessionEpoch();
	await eapi("/api/radio/like", {
		alg: "itembased",
		trackId: track.songId,
		like: String(!!on),
		time: "3"
	});
	current(epoch);
	likesVersion++;
	likes = void 0;
	likeRequest = void 0;
}
async function editable(playlistId) {
	const me = await needAccount();
	const epoch = sessionEpoch();
	const row = await playlistRow(id(playlistId));
	current(epoch);
	if (String(row.creator?.userId) !== me.id) throw fail("unsupported", "Only your own playlists can be edited.");
	if (Number(row.specialType) === 5) throw fail("unsupported", "Use the heart button to change liked songs.");
	return {
		row,
		epoch
	};
}
async function createPlaylist({ name }) {
	name = checkName(name);
	const me = await needAccount();
	const epoch = sessionEpoch();
	const response = await eapi("/api/playlist/create", {
		name,
		privacy: "0",
		type: "NORMAL"
	});
	current(epoch);
	const row = {
		...response.playlist,
		id: response.playlist?.id || response.id,
		name: response.playlist?.name || name
	};
	return {
		...toPlaylist({
			...row,
			creator: row.creator || {
				userId: me.id,
				nickname: me.name
			}
		}, me.id),
		mine: true
	};
}
async function renamePlaylist({ id: playlistId, name }) {
	name = checkName(name);
	const { epoch } = await editable(playlistId);
	current(epoch);
	await eapi("/api/playlist/update/name", {
		id: id(playlistId),
		name
	});
	current(epoch);
}
async function deletePlaylist({ id: playlistId }) {
	const { epoch } = await editable(playlistId);
	current(epoch);
	await eapi("/api/playlist/remove", { ids: numericIds([playlistId]) });
	current(epoch);
}
async function manipulate(op, playlistId, trackIds) {
	if (!Array.isArray(trackIds)) throw new Error("Expected track IDs");
	const songs = [...new Set(trackIds.map((trackId) => {
		const track = decodeTrack(trackId);
		if (track.programId) throw fail("unsupported", "Podcast episodes cannot be added to song playlists.");
		return track.songId;
	}))];
	const { epoch } = await editable(playlistId);
	current(epoch);
	if (!songs.length) return;
	const send = (values) => eapi("/api/playlist/manipulate/tracks", {
		op,
		pid: id(playlistId),
		trackIds: numericIds(values),
		imme: "true"
	}, [
		200,
		502,
		512
	]);
	let response = await send(songs);
	current(epoch);
	if (Number(response.code) === 512) {
		response = await send([...songs, ...songs]);
		current(epoch);
	}
	if (Number(response.code) === 502) throw new Error(t("A selected song is already in the playlist."));
	if (Number(response.code) !== 200) throw new Error(`${t("The playlist could not be changed.")} (${response.code})`);
}
var addToPlaylist = ({ id: playlistId, trackIds }) => manipulate("add", playlistId, trackIds);
var removeFromPlaylist = ({ id: playlistId, trackIds }) => manipulate("del", playlistId, trackIds);
async function savePlaylist({ id: playlistId, on }) {
	const me = await needAccount();
	const epoch = sessionEpoch();
	const row = await playlistRow(id(playlistId));
	current(epoch);
	if (String(row.creator?.userId) === me.id) throw fail("unsupported", "Your own playlists do not need saving.");
	await eapi(on ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe", { id: id(playlistId) });
	current(epoch);
}
async function followArtist({ id: artistId, on }) {
	await needAccount();
	const epoch = sessionEpoch();
	await apiPost(on ? "/api/artist/sub" : "/api/artist/unsub", {
		artistId: id(artistId),
		artistIds: numericIds([artistId])
	});
	current(epoch);
}
async function recent() {
	await needAccount();
	const epoch = sessionEpoch();
	const tracks = await tracksWithPrivileges(((await eapi("/api/play-record/song/list", { limit: 100 })).data?.list || []).map((row) => row.data));
	current(epoch);
	return tracks;
}
function played({ id: trackId }) {
	const track = decodeTrack(trackId);
	if (hasSession() && !track.programId) host.storage.set("lastPlayed", trackId);
}
function stations() {
	return [
		{
			id: "default",
			name: t("For You"),
			description: t("Personal FM picked for your taste")
		},
		{
			id: "familiar",
			name: t("Familiar"),
			description: t("Songs like the ones you know")
		},
		{
			id: "explore",
			name: t("Explore"),
			description: t("Discover something new")
		},
		{
			id: "heart",
			name: t("Heart Mode"),
			description: t("More like your liked songs")
		}
	];
}
async function nextStation(stationId, invokedEpoch) {
	current(invokedEpoch);
	const me = await needAccount();
	const epoch = sessionEpoch();
	const modes = {
		default: "DEFAULT",
		familiar: "FAMILIAR",
		explore: "EXPLORE"
	};
	let tracks;
	if (stationId in modes) {
		heart = void 0;
		tracks = (await songDetails(((await eapi("/api/v1/radio/get", {
			mode: modes[stationId],
			limit: 3
		})).data || []).map((song) => id(song.id)))).map(toTrack);
	} else if (stationId === "heart") {
		if (!heart || heart.epoch !== epoch) {
			const ids = await likedSongIds(true);
			if (!ids.length) throw fail("unavailable", "Like some songs before starting Heart Mode.");
			const rows = await userPlaylistRows(me.id);
			current(epoch);
			const fixed = rows.find((row) => String(row.creator?.userId) === me.id && Number(row.specialType) === 5);
			if (!fixed) throw fail("unavailable", "Your liked songs playlist is not available.");
			const previous = host.storage.get("lastPlayed");
			let seed = ids[0];
			if (typeof previous === "string") try {
				const track = decodeTrack(previous);
				if (!track.programId && ids.includes(track.songId)) seed = track.songId;
			} catch {}
			heart = {
				start: seed,
				last: seed,
				playlist: id(fixed.id),
				epoch
			};
		}
		const state = heart;
		tracks = await tracksWithPrivileges(((await eapi("/api/playmode/intelligence/list", {
			songId: state.last,
			startMusicId: state.start,
			playlistId: state.playlist,
			type: "fromPlayOne",
			count: 1
		})).data || []).flatMap((row) => row.songInfo ? [row.songInfo] : []));
		current(epoch);
		const playable = tracks.filter((track) => !track.unavailable);
		if (playable.length) state.last = decodeTrack(playable[playable.length - 1].id).songId;
	} else throw fail("unsupported", "Unknown station.");
	current(epoch);
	const playable = tracks.filter((track) => !track.unavailable);
	if (!playable.length) throw fail("unavailable", "No playable songs were returned. Please try again.");
	return playable;
}
function stationNext({ id: stationId }) {
	const epoch = sessionEpoch();
	const next = stationChain.then(() => nextStation(stationId, epoch));
	stationChain = next.catch(() => void 0);
	return next;
}
// src/podcasts.ts
var pageSize$1 = 30;
async function shows() {
	await needAccount();
	const epoch = sessionEpoch();
	const result = [], seen = /* @__PURE__ */ new Set();
	for (let offset = 0;; offset += 100) {
		if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
		const res = await apiGet("/api/djradio/get/subed", {
			offset,
			limit: 100,
			total: true
		});
		if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
		if (!Array.isArray(res.djRadios)) throw new Error("Invalid podcast subscriptions response");
		const rows = res.djRadios;
		let added = 0;
		for (const row of rows) {
			const mapped = toShow(row);
			if (!seen.has(mapped.id)) {
				seen.add(mapped.id);
				result.push({
					...mapped,
					subscribed: true
				});
				added++;
			}
		}
		if (!res.hasMore) return result;
		if (!added) throw new Error("Podcast subscriptions pagination did not advance");
	}
}
async function show({ id: value, offset = 0 }) {
	const showId = id(value), at = offsetOf(offset);
	const [detail, programs] = await Promise.all([apiGet("/api/djradio/v2/get", { id: showId }), apiGet("/api/dj/program/byradio", {
		radioId: showId,
		limit: pageSize$1,
		offset: at,
		asc: false
	})]);
	if (!detail.data || id(detail.data.id) !== showId) throw fail("unavailable", "This podcast is not available");
	const rows = programs.programs || [];
	return {
		show: toShow(detail.data),
		episodes: rows.map((raw) => toProgram(raw, detail.data)),
		more: !!programs.more && rows.length > 0
	};
}
async function subscribeShow({ id: value, on }) {
	await needAccount();
	await eapi(`/api/djradio/${on ? "sub" : "unsub"}`, { id: id(value) });
}
async function likeEpisode({ id: value, on }) {
	const { programId } = decodeTrack(value);
	if (!programId) throw fail("unsupported", "This is not a podcast episode");
	await needAccount();
	const epoch = sessionEpoch();
	await eapi(`/api/resource/${on ? "like" : "unlike"}`, { threadId: `A_DJ_1_${programId}` });
	if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
}
// src/comments.ts
var pageSize = 30;
var snapshots = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
onSessionChange(() => {
	snapshots.clear();
	pending.clear();
});
function toComment(raw) {
	let text = String(raw.content || "");
	for (const reply of raw.beReplied || []) text += `\n↳ ${reply.user?.nickname || ""}: ${reply.content || ""}`;
	if (raw.ipLocation?.location) text += `\n${raw.ipLocation.location}`;
	return {
		id: id(raw.commentId),
		author: String(raw.user?.nickname || ""),
		avatarUrl: image(raw.user?.avatarUrl),
		text,
		time: Number(raw.time || 0),
		likes: Number(raw.likedCount || 0),
		liked: !!raw.liked
	};
}
async function comments({ trackId, offset = 0 }) {
	const thread = threadOf(trackId), at = offsetOf(offset);
	const invokedEpoch = sessionEpoch();
	const job = (pending.get(thread) || Promise.resolve()).catch(() => {}).then(() => {
		if (invokedEpoch !== sessionEpoch()) throw new Error("The account changed while loading comments");
		return readPage(thread, at);
	});
	pending.set(thread, job);
	try {
		return await job;
	} finally {
		if (pending.get(thread) === job) pending.delete(thread);
	}
}
async function readPage(thread, offset) {
	const epoch = sessionEpoch();
	let snapshot = snapshots.get(thread);
	if (!snapshot || snapshot.epoch !== epoch || offset === 0) {
		snapshot = {
			rows: [],
			seen: /* @__PURE__ */ new Set(),
			cursor: 0,
			more: true,
			total: 0,
			epoch,
			started: false
		};
		snapshots.set(thread, snapshot);
		if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value);
	}
	while (snapshot.rows.length < offset + pageSize && snapshot.more) {
		const res = await apiGet(`/api/v1/resource/comments/${thread}`, {
			limit: pageSize,
			offset: snapshot.cursor
		});
		if (epoch !== sessionEpoch()) throw new Error("The account changed while loading comments");
		if (!Array.isArray(res.comments)) throw new Error("Invalid comments response");
		const latest = res.comments;
		const rows = snapshot.started ? latest : [...res.hotComments || [], ...latest];
		const before = snapshot.rows.length;
		for (const raw of rows) {
			const comment = toComment(raw);
			if (!snapshot.seen.has(comment.id)) {
				snapshot.seen.add(comment.id);
				snapshot.rows.push(comment);
			}
		}
		snapshot.cursor += latest.length;
		snapshot.started = true;
		if (res.more && latest.length > 0 && snapshot.rows.length === before) throw new Error("Comments pagination did not advance");
		snapshot.more = !!res.more && latest.length > 0;
		snapshot.total = Number(res.total || 0);
	}
	return {
		comments: snapshot.rows.slice(offset, offset + pageSize),
		total: Math.max(snapshot.total, snapshot.rows.length),
		more: snapshot.rows.length > offset + pageSize || snapshot.more
	};
}
async function likeComment({ trackId, commentId, on }) {
	const thread = threadOf(trackId), comment = id(commentId);
	await needAccount();
	const epoch = sessionEpoch();
	await eapi(`/api/v1/comment/${on ? "like" : "unlike"}`, {
		threadId: thread,
		commentId: comment
	});
	if (epoch !== sessionEpoch()) throw new Error("The account changed while liking the comment");
	for (const row of snapshots.get(thread)?.rows || []) if (row.id === comment && row.liked !== on) {
		row.likes = Math.max(0, (row.likes || 0) + (on ? 1 : -1));
		row.liked = on;
	}
}
// src/playback.ts
var levels = [
	"standard",
	"higher",
	"exhigh",
	"lossless",
	"hires"
];
var streamCacheTTL = 1e4;
var streamCacheLimit = 32;
var cooldownDuration = 6e4;
var cooldownKey = "streamCooldownUntil";
var pendingStreams = /* @__PURE__ */ new Map();
var streamCache = /* @__PURE__ */ new Map();
var streamGeneration = 0;
onSessionChange(() => {
	streamGeneration++;
	pendingStreams.clear();
	streamCache.clear();
});
function checkStreamSession(epoch, generation) {
	if (epoch !== sessionEpoch() || generation !== streamGeneration) throw fail("sessionChanged", "Your account changed. Try again.");
}
function cooldownRemaining() {
	const until = host.storage.get(cooldownKey);
	if (until === void 0) return 0;
	const now = Date.now();
	if (typeof until !== "number" || !Number.isFinite(until) || until <= now || until > now + cooldownDuration) {
		host.storage.remove(cooldownKey);
		return 0;
	}
	return Math.ceil((until - now) / 1e3);
}
function cooldownError(seconds) {
	return new Error(t("NetEase temporarily blocked playback requests. Try again in {seconds} seconds.").replace("{seconds}", String(seconds)));
}
function isRiskBlock(error) {
	if (!error || typeof error !== "object") return false;
	const details = error;
	return details.apiCode === -460 || details.apiCode === 460 || details.apiCode === 429 || details.status === 429;
}
function setSetting({ key, value }) {
	if (key !== "quality") throw fail("setup", "Unknown setting");
	if (value && value !== "auto" && !levels.includes(value)) throw fail("setup", "Choose auto, standard, higher, exhigh, lossless, or hires");
}
function requestedLevel(quality) {
	const override = host.setting("quality").trim();
	if (override && override !== "auto") {
		setSetting({
			key: "quality",
			value: override
		});
		return override;
	}
	return {
		standard: "standard",
		high: "exhigh",
		lossless: "lossless"
	}[quality] || "exhigh";
}
async function stream({ id, quality = "high" }) {
	const { songId } = decodeTrack(id);
	const level = requestedLevel(quality);
	const seconds = cooldownRemaining();
	if (seconds) throw cooldownError(seconds);
	const epoch = sessionEpoch(), generation = streamGeneration;
	const key = `${epoch}:${generation}:${songId}:${level}`;
	const cached = streamCache.get(key);
	if (cached && cached.until > Date.now()) return { ...cached.value };
	streamCache.delete(key);
	const existing = pendingStreams.get(key);
	if (existing) return { ...await existing };
	const pending = resolveStream(songId, level, key, epoch, generation);
	pendingStreams.set(key, pending);
	try {
		return { ...await pending };
	} finally {
		if (pendingStreams.get(key) === pending) pendingStreams.delete(key);
	}
}
async function resolveStream(songId, level, key, epoch, generation) {
	const started = Date.now();
	let res;
	try {
		res = await eapi("/api/song/enhance/player/url/v1", {
			ids: `[${songId}]`,
			level,
			encodeType: level === "lossless" || level === "hires" ? "flac" : "mp3"
		});
	} catch (error) {
		checkStreamSession(epoch, generation);
		if (isRiskBlock(error)) {
			host.storage.set(cooldownKey, Date.now() + cooldownDuration);
			throw cooldownError(cooldownDuration / 1e3);
		}
		throw error;
	}
	checkStreamSession(epoch, generation);
	const data = res.data?.[0];
	if (data && isRiskBlock({ apiCode: Number(data.code) })) {
		host.storage.set(cooldownKey, Date.now() + cooldownDuration);
		throw cooldownError(cooldownDuration / 1e3);
	}
	if (!data?.url || data.freeTrialInfo != null || Number(data.code || 200) !== 200) throw fail("unavailable", "This track is not available in full for your account");
	const type = String(data.type || "").toLowerCase();
	if (type !== "mp3" && type !== "flac") throw fail("unavailable", "The service returned an unsupported audio format");
	const address = new URL(String(data.url).replace(/^http:/, "https:"));
	if (address.protocol !== "https:" || !audioHost(address.hostname)) throw fail("unavailable", "The service returned an unexpected audio host");
	const served = String(data.level || level);
	const value = {
		url: address.toString(),
		type,
		quality: served === "lossless" || served === "hires" ? "lossless" : served === "standard" ? "standard" : "high",
		bitRate: Number(data.br || 0),
		size: Number(data.size || 0),
		gain: Number(data.gain || 0),
		peak: Number(data.peak || 0)
	};
	const expires = typeof data.exp === "number" || typeof data.exp === "string" ? Number(data.exp) : NaN;
	if (Number.isFinite(expires) && expires > 0) {
		const until = Math.min(Date.now() + streamCacheTTL, started + expires * 1e3);
		if (until > Date.now()) {
			streamCache.set(key, {
				until,
				value
			});
			if (streamCache.size > streamCacheLimit) streamCache.delete(streamCache.keys().next().value);
		}
	}
	return value;
}
function audioHost(name) {
	return [
		"music.126.net",
		"music.163.com",
		"music.163.net",
		"music.126.com"
	].some((domain) => name.endsWith(`.${domain}`));
}
function parseLRC(text) {
	const lines = [];
	const offset = /\[offset:([+-]?\d+)\]/i.exec(text);
	const shift = offset ? Number(offset[1]) : 0;
	for (const raw of text.split(/\r?\n/)) {
		const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
		const content = raw.replace(/\[[^\]]*\]/g, "").trim();
		if (!content) continue;
		for (const stamp of stamps) {
			const start = Number(stamp[1]) * 6e4 + Number(stamp[2]) * 1e3 + Number((stamp[3] || "").padEnd(3, "0")) + shift;
			lines.push({
				start: Math.max(0, start),
				text: content
			});
		}
	}
	return lines.sort((a, b) => a.start - b.start);
}
function parseYRC(text, translation = "") {
	const lines = [];
	for (const raw of text.split(/\r?\n/)) {
		const timing = /^\[(\d+),(\d+)\]/.exec(raw);
		if (!timing) continue;
		const start = Number(timing[1]), end = start + Number(timing[2]);
		const words = [];
		for (const word of raw.slice(timing[0].length).matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)) {
			if (!word[3].trim()) {
				if (words.length) words[words.length - 1].text += word[3];
				continue;
			}
			const at = Number(word[1]);
			words.push({
				start: at,
				end: at + Number(word[2]),
				text: word[3]
			});
		}
		const content = words.map((word) => word.text).join("").trim();
		if (content) lines.push({
			start,
			end,
			text: content,
			words
		});
	}
	lines.sort((a, b) => a.start - b.start);
	for (const translated of parseLRC(translation)) {
		let best, distance = 1500;
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
async function lyrics({ id }) {
	const { songId, programId } = decodeTrack(id);
	if (programId) return {};
	const results = await Promise.allSettled([apiGet("/api/song/lyric", {
		id: songId,
		lv: "1",
		tv: "-1"
	}), eapi("/api/song/lyric/v1", {
		id: songId,
		cp: false,
		tv: 0,
		lv: 0,
		rv: 0,
		kv: 0,
		yv: 0,
		ytv: 0,
		yrv: 0
	})]);
	for (const result of results) if (result.status === "rejected" && ["signIn", "sessionChanged"].includes(result.reason?.code)) throw result.reason;
	const base = results[0].status === "fulfilled" ? results[0].value : {};
	const words = results[1].status === "fulfilled" ? results[1].value : {};
	const lrc = String(base.lrc?.lyric || ""), translation = String(base.tlyric?.lyric || "");
	const lines = parseYRC(String(words?.yrc?.lyric || ""), translation);
	if (!lines.length && results[0].status === "rejected") throw results[0].reason;
	return lines.length ? {
		lines,
		lrc,
		translation
	} : {
		lrc,
		translation
	};
}
export { account, addToPlaylist, album, artist, browse, comments, createPlaylist, deletePlaylist, followArtist, home, isLiked, like, likeComment, likeEpisode, liked, lyrics, played, playlist, playlists, recent, removeFromPlaylist, renamePlaylist, savePlaylist, search, setSetting, show, shows, signIn, signOut, stationNext, stations, stream, subscribeShow, suggest };
