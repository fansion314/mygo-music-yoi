// MyGo Music's JSON contract. Times are milliseconds; IDs belong to this source.
export type Raw = Record<string, any>;
export interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
  following?: boolean;
}
export interface Album {
  id: string;
  name: string;
  imageUrl?: string;
  artists?: Artist[];
  released?: string;
  saved?: boolean;
}
export interface Track {
  id: string;
  name: string;
  artists: Artist[];
  album: Album;
  duration: number;
  url?: string;
  unavailable?: boolean;
  showId?: string;
  description?: string;
  published?: string;
}
export interface Playlist {
  id: string;
  name: string;
  imageUrl?: string;
  description?: string;
  owner?: string;
  trackCount?: number;
  mine?: boolean;
  saved?: boolean;
  fixed?: boolean;
  tracks?: Track[];
}
export interface Show {
  id: string;
  name: string;
  imageUrl?: string;
  description?: string;
  publisher?: string;
  publisherPage?: string;
  episodeCount?: number;
  subscribed?: boolean;
}
export interface Account {
  id: string;
  name: string;
  imageUrl?: string;
  page?: string;
}
export interface Link {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  page: string;
}
export interface Station {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
}
export interface Section {
  title?: string;
  subtitle?: string;
  pageTitle?: string;
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
  shows?: Show[];
  stations?: Station[];
  links?: Link[];
  morePage?: string;
  empty?: string;
}
export interface Browse {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  description?: string;
  sections: Section[];
}
export interface Comment {
  id: string;
  author: string;
  avatarUrl?: string;
  text: string;
  time?: number;
  likes?: number;
  liked?: boolean;
}
export interface LyricWord {
  start: number;
  end: number;
  text: string;
}
export interface LyricLine {
  start: number;
  end?: number;
  text: string;
  translation?: string;
  words?: LyricWord[];
}
export interface Host {
  platform: string;
  arch: string;
  dir: string;
  dataDir: string;
  storage: { get(key: string): any; set(key: string, value: any): void; remove(key: string): void };
  setting(key: string): string;
  t(text: string): string;
  language(): string;
  crypto: { md5(text: string): string; aesEcbEncrypt(key: string, text: string): string };
  signInPrompt(prompt: { qr?: string; text?: string }): void;
  openURL(url: string): void;
}
declare global {
  const host: Host;
}
