// Only supported MyGo Music capabilities are exported from this entry.
export { signIn, signOut, account } from "./auth";
export { home, browse, search, suggest, album, artist } from "./catalog";
export {
  playlists,
  playlist,
  liked,
  isLiked,
  like,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  savePlaylist,
  followArtist,
  recent,
  played,
  stations,
  stationNext,
} from "./library";
export { shows, show, subscribeShow, likeEpisode } from "./podcasts";
export { comments, likeComment } from "./comments";
export { stream, lyrics, setSetting } from "./playback";
