# Source and acknowledgements

YOI — You Own It adapts the NetEase Cloud Music implementation written by
egoist and contributors for `egoist/mygo-cloudmusic`, under AGPL-3.0.

The migration baseline is the locally preserved 0.1.25 source at commit
`4986c5314fe15a7f24a843b32559257369ab1fa8`, compared with 0.1.24
(`fe3bfd97a4ad71c1a93bc92f53c9b1e90f18ab09`) and the preserved PR #70
snapshot (`31cc505b1961d17a670202dc77f3bda9cdd7e17c`). The 0.1.25 source
was recovered from a pull-request reference; this does not establish an
official release or the final pre-removal main branch.

The request encryption, account flow, API endpoints, privilege handling,
playlist operations, FM, podcast and lyric behavior were ported from the
preserved `internal/netease` and `internal/lyrics` Go packages to TypeScript.
The original repository is https://github.com/egoist/mygo-cloudmusic.

Plugin integration follows https://github.com/egoist/mygo-music and its
example https://github.com/egoist/mygo-music-youtube-music. The latter is a
reference for the host integration, not a bundled dependency.

The original project credits NeteaseCloudMusicApi for EAPI encryption and
QR login references. EAPI's shared key is a public protocol constant,
not an account credential. No user cookies or credentials are distributed.

YOI is independent of NetEase and is not endorsed by NetEase. Music rights
remain with their respective rights holders. This plugin retains normal
account, subscription, region and availability restrictions.

See LICENSE for GNU Affero General Public License version 3.0.
