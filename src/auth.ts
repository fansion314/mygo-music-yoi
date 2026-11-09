import {
  apiGet,
  apiPost,
  clearSession,
  delay,
  eapi,
  hasSession,
  onSessionChange,
  sessionEpoch,
} from "./api";
import { fail, id, image, t } from "./model";
import type { Account, Raw } from "./types";

let cached: { value: Account; until: number; epoch: number } | undefined;
let loading: { epoch: number; promise: Promise<Account | null> } | undefined;
let signing: Promise<Account> | undefined;
onSessionChange(() => {
  cached = undefined;
  loading = undefined;
});

function profileOf(profile: Raw): Account {
  const uid = id(profile.userId);
  return {
    id: uid,
    name: String(profile.nickname || ""),
    imageUrl: image(profile.avatarUrl),
    page: `user:${uid}`,
  };
}

export async function account(): Promise<Account | null> {
  if (!hasSession()) return null;
  const generation = sessionEpoch();
  if (cached?.epoch === generation && cached.until > Date.now()) return cached.value;
  if (loading?.epoch === generation) return loading.promise;
  const promise = (async (): Promise<Account | null> => {
    try {
      const response = await apiGet("/api/nuser/account/get");
      if (sessionEpoch() !== generation) return null;
      if (!response.profile?.userId) {
        clearSession();
        return null;
      }
      const value = profileOf(response.profile);
      cached = { value, until: Date.now() + 30_000, epoch: generation };
      return value;
    } catch (error) {
      if ((error as { code?: string }).code === "signIn" || sessionEpoch() !== generation)
        return null;
      throw error;
    }
  })();
  loading = { epoch: generation, promise };
  try {
    return await promise;
  } finally {
    if (loading?.promise === promise) loading = undefined;
  }
}

export async function needAccount(): Promise<Account> {
  const value = await account();
  if (!value) throw fail("signIn", "Sign in to NetEase first.");
  return value;
}

function checkGeneration(generation: number): void {
  if (sessionEpoch() !== generation)
    throw fail("sessionChanged", "Sign-in was cancelled. Try again.");
}

async function qrSignIn(): Promise<Account> {
  clearSession();
  const generation = sessionEpoch();
  const deadline = Date.now() + 4 * 60_000;
  try {
    while (Date.now() < deadline) {
      checkGeneration(generation);
      const key = await eapi("/api/login/qrcode/unikey", { type: 3 });
      checkGeneration(generation);
      if (typeof key.unikey !== "string" || !key.unikey)
        throw new Error(t("NetEase did not provide a login QR code. Try again."));
      const qr = `https://music.163.com/login?codekey=${encodeURIComponent(key.unikey)}`;
      host.signInPrompt({ qr, text: t("Scan with the NetEase Cloud Music app to sign in.") });
      while (Date.now() < deadline) {
        await delay(1_500);
        checkGeneration(generation);
        const response = await eapi(
          "/api/login/qrcode/client/login",
          { key: key.unikey, type: 3 },
          [800, 801, 802, 803],
        );
        checkGeneration(generation);
        if (response.code === 800) {
          host.signInPrompt({ text: t("The QR code expired. Getting a new one…") });
          break;
        }
        if (response.code === 802)
          host.signInPrompt({ qr, text: t("Scanned. Confirm sign-in on your phone.") });
        if (response.code === 803) {
          if (!hasSession())
            throw new Error(t("NetEase confirmed sign-in without a session cookie. Try again."));
          const value = await account();
          checkGeneration(generation);
          if (!value)
            throw fail("signIn", "NetEase could not confirm your account. Sign in again.");
          host.signInPrompt({ text: t("Signed in.") });
          return value;
        }
      }
    }
    throw new Error(t("Sign-in timed out. Try again."));
  } catch (error) {
    // A failed attempt may have received partial session cookies. Never erase
    // cookies belonging to a newer sign-in or resurrect those from this one.
    if (sessionEpoch() === generation) clearSession();
    throw error;
  }
}

export function signIn(): Promise<Account> {
  if (!signing) {
    const attempt = qrSignIn();
    signing = attempt;
    void attempt
      .finally(() => {
        if (signing === attempt) signing = undefined;
      })
      .catch(() => {});
  }
  return signing;
}

export async function signOut(): Promise<void> {
  // Start revocation with the old cookie, then forget it locally immediately.
  // The response's cookies are discarded by its old generation. As in the
  // legacy client, remote revocation is best effort when the service is down.
  const revoke = hasSession() ? apiPost("/api/logout") : undefined;
  clearSession();
  signing = undefined;
  if (revoke) await revoke.catch(() => {});
}
