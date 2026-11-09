import { apiGet, eapi, sessionEpoch } from "./api";
import { needAccount } from "./auth";
import { decodeTrack, fail, id, offsetOf, toProgram, toShow } from "./model";
import type { Raw, Show } from "./types";

const pageSize = 30;
export async function shows(): Promise<Show[]> {
  await needAccount();
  const epoch = sessionEpoch();
  const result: Show[] = [],
    seen = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
    const res = await apiGet("/api/djradio/get/subed", { offset, limit: 100, total: true });
    if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
    if (!Array.isArray(res.djRadios)) throw new Error("Invalid podcast subscriptions response");
    const rows: Raw[] = res.djRadios;
    let added = 0;
    for (const row of rows) {
      const mapped = toShow(row);
      if (!seen.has(mapped.id)) {
        seen.add(mapped.id);
        result.push({ ...mapped, subscribed: true });
        added++;
      }
    }
    if (!res.hasMore) return result;
    if (!added) throw new Error("Podcast subscriptions pagination did not advance");
  }
}
export async function show({ id: value, offset = 0 }: { id: string; offset?: number }) {
  const showId = id(value),
    at = offsetOf(offset);
  const [detail, programs] = await Promise.all([
    apiGet("/api/djradio/v2/get", { id: showId }),
    apiGet("/api/dj/program/byradio", { radioId: showId, limit: pageSize, offset: at, asc: false }),
  ]);
  if (!detail.data || id(detail.data.id) !== showId)
    throw fail("unavailable", "This podcast is not available");
  const rows: Raw[] = programs.programs || [];
  return {
    show: toShow(detail.data),
    episodes: rows.map((raw) => toProgram(raw, detail.data)),
    more: !!programs.more && rows.length > 0,
  };
}
export async function subscribeShow({ id: value, on }: { id: string; on: boolean }): Promise<void> {
  await needAccount();
  await eapi(`/api/djradio/${on ? "sub" : "unsub"}`, { id: id(value) });
}
export async function likeEpisode({ id: value, on }: { id: string; on: boolean }): Promise<void> {
  const { programId } = decodeTrack(value);
  if (!programId) throw fail("unsupported", "This is not a podcast episode");
  await needAccount();
  const epoch = sessionEpoch();
  await eapi(`/api/resource/${on ? "like" : "unlike"}`, { threadId: `A_DJ_1_${programId}` });
  if (epoch !== sessionEpoch()) throw fail("signIn", "Your account changed. Try again.");
}
