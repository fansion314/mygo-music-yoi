package plugin

import (
	"bytes"
	"crypto/aes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mygo-music/internal/music"
)

type yoiCall struct {
	Path string
	Data map[string]any
}

type yoiNetwork struct {
	mu            sync.Mutex
	calls         []yoiCall
	streamStarted chan struct{}
	streamRelease chan struct{}
	streamOnce    sync.Once
}

// decrypt verifies the exact path, digest, PKCS#7 padding and native crypto
// boundary, rather than allowing a mocked encryptor to agree with itself.
func yoiDecrypt(req *http.Request) (map[string]any, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, err
	}
	encrypted, err := hex.DecodeString(form.Get("params"))
	if err != nil || len(encrypted) == 0 || len(encrypted)%aes.BlockSize != 0 {
		return nil, errors.New("invalid EAPI ciphertext")
	}
	block, _ := aes.NewCipher([]byte("e82ckenh8dichen8"))
	plain := make([]byte, len(encrypted))
	for at := 0; at < len(encrypted); at += aes.BlockSize {
		block.Decrypt(plain[at:at+aes.BlockSize], encrypted[at:at+aes.BlockSize])
	}
	pad := int(plain[len(plain)-1])
	if pad == 0 || pad > aes.BlockSize || !bytes.Equal(plain[len(plain)-pad:], bytes.Repeat([]byte{byte(pad)}, pad)) {
		return nil, errors.New("invalid EAPI padding")
	}
	parts := strings.Split(string(plain[:len(plain)-pad]), "-36cd479b6b5-")
	if len(parts) != 3 || parts[0] != "/api/"+strings.TrimPrefix(req.URL.Path, "/eapi/") {
		return nil, errors.New("incorrect EAPI path envelope")
	}
	digest := md5.Sum([]byte("nobody" + parts[0] + "use" + parts[1] + "md5forencrypt"))
	if parts[2] != hex.EncodeToString(digest[:]) {
		return nil, errors.New("incorrect EAPI digest")
	}
	var data map[string]any
	decoder := json.NewDecoder(strings.NewReader(parts[1]))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		return nil, err
	}
	header, ok := data["header"].(map[string]any)
	if !ok || len(fmt.Sprint(header["deviceId"])) != 52 {
		return nil, errors.New("missing persistent device ID")
	}
	if header["os"] != "pc" || header["appver"] != "3.1.17.204416" || header["osver"] != "Microsoft-Windows-10-Professional-build-19045-64bit" {
		return nil, errors.New("EAPI request does not identify the fixed desktop client")
	}
	ua := req.Header.Get("User-Agent")
	if !strings.Contains(ua, "Windows NT 10.0") || !strings.Contains(ua, "NeteaseMusicDesktop/"+fmt.Sprint(header["appver"])) || strings.Contains(ua, "iPhone") {
		return nil, errors.New("EAPI User-Agent disagrees with the encrypted desktop identity")
	}
	for _, key := range []string{"os", "appver", "osver", "deviceId"} {
		cookie, err := req.Cookie(key)
		if err != nil {
			return nil, fmt.Errorf("missing EAPI identity cookie %s", key)
		}
		value, err := url.QueryUnescape(cookie.Value)
		if err != nil || value != fmt.Sprint(header[key]) {
			return nil, fmt.Errorf("EAPI identity cookie %s disagrees with encrypted header", key)
		}
	}
	if data["e_r"] != false {
		return nil, errors.New("expected plaintext EAPI response")
	}
	return data, nil
}

func (network *yoiNetwork) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Hostname() != "music.163.com" && req.URL.Hostname() != "interfacepc.music.163.com" {
		return nil, fmt.Errorf("unexpected network host: %s", req.URL.Hostname())
	}
	path := req.URL.Path
	data := map[string]any{}
	if strings.HasPrefix(path, "/eapi/") {
		var err error
		data, err = yoiDecrypt(req)
		if err != nil {
			return nil, err
		}
		path = "/api/" + strings.TrimPrefix(path, "/eapi/")
	} else {
		for key, values := range req.URL.Query() {
			data[key] = values[0]
		}
	}
	network.mu.Lock()
	network.calls = append(network.calls, yoiCall{path, data})
	network.mu.Unlock()
	headers := http.Header{"Content-Type": {"application/json"}}
	var body string
	song := `{"id":9007199254740999,"name":"Exact ID song","ar":[{"id":10,"name":"Artist"}],"al":{"id":20,"name":"Album"},"dt":90000,"fee":1}`
	switch path {
	case "/api/login/qrcode/unikey":
		body = `{"code":200,"unikey":"fixture-qr"}`
	case "/api/login/qrcode/client/login":
		headers.Add("Set-Cookie", "MUSIC_U=runtime-session; Domain=.music.163.com; Path=/; HttpOnly")
		headers.Add("Set-Cookie", "__csrf=runtime-csrf; Domain=.music.163.com; Path=/")
		body = `{"code":803}`
	case "/api/nuser/account/get":
		if !strings.Contains(req.Header.Get("Cookie"), "MUSIC_U=runtime-session") || !strings.Contains(req.Header.Get("Cookie"), "__csrf=runtime-csrf") {
			return nil, errors.New("login cookies did not cross the host Headers/storage boundary")
		}
		body = `{"code":200,"profile":{"userId":42,"nickname":"Runtime User"}}`
	case "/api/cloudsearch/pc":
		body = `{"code":200,"result":{"songs":[` + song + `],"songCount":1}}`
	case "/api/v3/song/detail":
		body = `{"code":200,"songs":[` + song + `],"privileges":[{"id":9007199254740999,"st":0,"pl":320000}]}`
	case "/api/v3/discovery/recommend/songs":
		body = `{"code":200,"data":{"dailySongs":[` + song + `]}}`
	case "/api/v1/discovery/recommend/resource":
		body = `{"code":200,"recommend":[{"id":7,"name":"Recommended"}]}`
	case "/api/personalized/playlist":
		body = `{"code":200,"result":[{"id":7,"name":"Featured"}]}`
	case "/api/toplist/detail":
		body = `{"code":200,"list":[{"id":8,"name":"Chart"}]}`
	case "/api/djradio/recommend/v1":
		body = `{"code":200,"djRadios":[{"id":9,"name":"Podcast"}]}`
	case "/api/song/enhance/player/url/v1":
		if data["ids"] == "[7]" {
			body = `{"code":-460,"message":"fixture network risk"}`
			break
		}
		if data["ids"] != "[9007199254740999]" && data["ids"] != "[6]" {
			return nil, fmt.Errorf("stream used wrong audio ID: %v", data["ids"])
		}
		if network.streamStarted != nil && data["ids"] == "[6]" {
			network.streamOnce.Do(func() { close(network.streamStarted) })
			select {
			case <-network.streamRelease:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
		body = `{"code":200,"data":[{"url":"http://m7.music.126.net/audio.flac","type":"FLAC","level":"lossless","size":1234,"br":900000,"gain":-4.5,"peak":0.8,"exp":1200}]}`
	case "/api/song/lyric":
		body = `{"code":200,"lrc":{"lyric":"[00:01]A B"},"tlyric":{"lyric":"[00:01.020]译文"}}`
	case "/api/song/lyric/v1":
		body = `{"code":200,"yrc":{"lyric":"[1000,300](1000,100,0)A(1100,50,0) (1150,150,0)B"}}`
	case "/api/djradio/v2/get":
		body = `{"code":200,"data":{"id":9,"name":"Podcast","dj":{"userId":42,"nickname":"Runtime User"}}}`
	case "/api/dj/program/byradio":
		body = `{"code":200,"programs":[{"id":5,"name":"Episode","duration":90000,"mainSong":{"id":6}}],"more":false}`
	case "/api/resource/like":
		if data["threadId"] != "A_DJ_1_5" {
			return nil, fmt.Errorf("episode like used wrong ID: %v", data["threadId"])
		}
		body = `{"code":200}`
	case "/api/v1/resource/comments/A_DJ_1_5":
		body = `{"code":200,"hotComments":[{"commentId":11,"content":"Hot","user":{"nickname":"Listener"},"likedCount":2}],"comments":[{"commentId":12,"content":"Latest","user":{"nickname":"Other"}}],"total":2,"more":false}`
	case "/api/v1/comment/like":
		if data["threadId"] != "A_DJ_1_5" || data["commentId"] != "11" {
			return nil, errors.New("comment like used audio ID instead of program ID")
		}
		body = `{"code":200}`
	case "/api/logout":
		body = `{"code":200}`
	default:
		return nil, fmt.Errorf("unexpected fixture request: %s", path)
	}
	return &http.Response{StatusCode: 200, Status: "200 OK", Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
}

// The published JavaScript runs in the real app, including native encryption,
// fetch Headers, persistent storage, source stamps and all JSON decoders.
func TestYOIInstallableBundle(t *testing.T) {
	root := os.Getenv("YOI_PLUGIN_DIR")
	if root == "" {
		t.Skip("run through scripts/runtime-test.mjs")
	}
	network := &yoiNetwork{}
	previous := http.DefaultTransport
	http.DefaultTransport = network
	t.Cleanup(func() { http.DefaultTransport = previous })
	SetAppVersion("0.1.22")
	t.Cleanup(func() { SetAppVersion("") })
	data := t.TempDir()
	p, err := Load(root, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if p.Info().Name != "You Own It" || p.Info().Version != "0.1.1" {
		t.Fatalf("release identity: %+v", p.Info())
	}
	for _, capability := range []string{"signIn", "signOut", "account", "search", "home", "browse", "playlists", "playlist", "like", "isLiked", "stations", "stationNext", "shows", "show", "likeEpisode", "stream", "lyrics", "comments", "likeComment"} {
		if !p.Can(capability) {
			t.Errorf("missing capability %s", capability)
		}
	}
	if p.Can("postComment") || p.Can("movePlaylistTrack") {
		t.Fatal("unsupported actions were advertised")
	}
	var promptMu sync.Mutex
	var qr string
	p.OnSignInPrompt(func(prompt music.SignInPrompt) {
		promptMu.Lock()
		defer promptMu.Unlock()
		if prompt.QR != "" {
			qr = prompt.QR
		}
	})
	me, err := p.SignIn()
	if err != nil {
		t.Fatal("signIn:", err)
	}
	if me.ID != "42" || me.Page != "user:42" {
		t.Fatalf("account: %+v", me)
	}
	promptMu.Lock()
	gotQR := qr
	promptMu.Unlock()
	if gotQR != "https://music.163.com/login?codekey=fixture-qr" {
		t.Fatalf("QR: %s", gotQR)
	}
	if _, err := os.Stat(filepath.Join(data, p.Info().ID, "storage.json")); err != nil {
		t.Fatal("session was not persisted:", err)
	}
	p.Close()
	restored, err := Load(root, data)
	if err != nil {
		t.Fatal(err)
	}
	p = restored
	t.Cleanup(restored.Close)
	me, err = p.Account()
	if err != nil || me == nil || me.ID != "42" {
		t.Fatalf("restored account: %+v %v", me, err)
	}
	result, err := p.Search("fixture", music.SearchTracks, 0)
	if err != nil {
		t.Fatal("search:", err)
	}
	if len(result.Tracks) != 1 || result.Tracks[0].ID != "song:9007199254740999" || result.Tracks[0].Source != p.Info().ID || result.Tracks[0].Unavailable {
		t.Fatalf("search track identity/privileges: %+v", result)
	}
	home, err := p.Home()
	if err != nil || len(home.Sections) < 4 || len(home.Sections[0].Tracks) != 1 || home.Sections[0].Tracks[0].Source != p.Info().ID {
		t.Fatalf("home: %+v %v", home, err)
	}
	if err := p.SetSetting("quality", "hires"); err != nil {
		t.Fatal(err)
	}
	audio, err := p.Stream(result.Tracks[0].ID, "high")
	if err != nil || audio.Type != "flac" || audio.Quality != "lossless" || audio.Gain != -4.5 || audio.Peak != 0.8 || !strings.HasPrefix(audio.URL, "https://") {
		t.Fatalf("audio: %+v %v", audio, err)
	}
	lyric, err := p.Lyrics(result.Tracks[0].ID)
	if err != nil || len(lyric.Lines) != 1 || len(lyric.Lines[0].Words) != 2 || lyric.Lines[0].Words[1].Start != 1150 || lyric.Lines[0].Translation != "译文" {
		t.Fatalf("lyrics: %+v %v", lyric, err)
	}
	show, err := p.Show("9", 0)
	if err != nil || len(show.Episodes) != 1 || show.Episodes[0].ID != "program:5:6" || show.Episodes[0].Source != p.Info().ID || show.Show.PublisherPage != "user:42" {
		t.Fatalf("podcast: %+v %v", show, err)
	}
	episode := show.Episodes[0].ID
	if _, err := p.Stream(episode, "standard"); err != nil {
		t.Fatal("episode audio:", err)
	}
	if err := p.LikeEpisode(episode, true); err != nil {
		t.Fatal("episode like:", err)
	}
	comments, err := p.Comments(episode, 0)
	if err != nil || len(comments.Comments) != 2 || comments.Comments[0].ID != "11" {
		t.Fatalf("comments: %+v %v", comments, err)
	}
	if err := p.LikeComment(episode, "11", true); err != nil {
		t.Fatal("comment like:", err)
	}
	if err := p.SignOut(); err != nil {
		t.Fatal("signOut:", err)
	}
	me, err = p.Account()
	if err != nil || me != nil {
		t.Fatalf("account after signOut: %+v %v", me, err)
	}
	p.Close()
	last, err := Load(root, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(last.Close)
	if me, err := last.Account(); err != nil || me != nil {
		t.Fatalf("session survived signOut: %+v %v", me, err)
	}
	network.mu.Lock()
	defer network.mu.Unlock()
	var requestedHires bool
	for _, call := range network.calls {
		if call.Path == "/api/song/enhance/player/url/v1" && call.Data["level"] == "hires" {
			requestedHires = true
		}
	}
	if !requestedHires {
		t.Fatal("plugin quality setting did not reach EAPI")
	}
}

// Both downloadable artifacts pass the app's actual folder/ZIP installer and
// run from their installed location, without developer dependencies or a build.
func TestYOIInstallFolderAndZip(t *testing.T) {
	root := os.Getenv("YOI_PLUGIN_DIR")
	if root == "" {
		t.Skip("run through scripts/runtime-test.mjs")
	}
	manifestBytes, err := os.ReadFile(filepath.Join(root, "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected Manifest
	if err := json.Unmarshal(manifestBytes, &expected); err != nil {
		t.Fatal(err)
	}
	entry, err := os.ReadFile(filepath.Join(root, expected.Main))
	if err != nil {
		t.Fatal(err)
	}
	SetAppVersion("0.1.22")
	t.Cleanup(func() { SetAppVersion("") })
	for _, artifact := range []struct {
		name string
		path string
	}{
		{"folder", filepath.Join(root, "dist", "mygo-music-yoi")},
		{"zip", filepath.Join(root, "dist", "mygo-music-yoi-"+expected.Version+".zip")},
	} {
		t.Run(artifact.name, func(t *testing.T) {
			plugins, work, data := t.TempDir(), t.TempDir(), t.TempDir()
			pending, err := Open(artifact.path, work)
			if err != nil {
				t.Fatalf("opening installation artifact (run vp run package first): %v", err)
			}
			t.Cleanup(pending.Discard)
			if pending.Manifest.ID != expected.ID || pending.Version != expected.Version || pending.Manifest.Main != expected.Main || pending.Manifest.Name != "You Own It" {
				t.Fatalf("artifact manifest mismatch: %+v", pending.Manifest)
			}
			if err := pending.Install(plugins); err != nil {
				t.Fatal("install:", err)
			}
			installed := filepath.Join(plugins, expected.ID)
			installedEntry, err := os.ReadFile(filepath.Join(installed, expected.Main))
			if err != nil || !bytes.Equal(entry, installedEntry) {
				t.Fatalf("installed entry differs from tested bundle: %v", err)
			}
			for _, resource := range []string{"locales/zh-CN.json", "LICENSE", "NOTICE.md", "README.md"} {
				if _, err := os.Stat(filepath.Join(installed, filepath.FromSlash(resource))); err != nil {
					t.Fatalf("missing installed resource %s: %v", resource, err)
				}
			}
			p, err := Load(installed, data)
			if err != nil {
				t.Fatal("load installed plugin:", err)
			}
			t.Cleanup(p.Close)
			if p.Info().Name != "You Own It" {
				t.Fatalf("installed source selector name: %q", p.Info().Name)
			}
			if me, err := p.Account(); err != nil || me != nil {
				t.Fatalf("new installation account: %+v %v", me, err)
			}
			page, err := p.Browse("more")
			if err != nil || len(page.Sections) == 0 || len(page.Sections[0].Links) == 0 {
				t.Fatalf("installed plugin did not run: %+v %v", page, err)
			}
		})
	}
}

// Concurrent host fetches and song/episode aliases share one audio request;
// a risk response blocks further calls and survives runtime recreation.
func TestYOIStreamCoalescingAndRiskCooldown(t *testing.T) {
	root := os.Getenv("YOI_PLUGIN_DIR")
	if root == "" {
		t.Skip("run through scripts/runtime-test.mjs")
	}
	network := &yoiNetwork{streamStarted: make(chan struct{}), streamRelease: make(chan struct{})}
	previous := http.DefaultTransport
	http.DefaultTransport = network
	t.Cleanup(func() { http.DefaultTransport = previous })
	data := t.TempDir()
	p, err := Load(root, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, track := range []string{"song:6", "program:5:6"} {
		go func(track string) {
			ready.Done()
			_, err := p.Stream(track, "high")
			results <- err
		}(track)
	}
	ready.Wait()
	select {
	case <-network.streamStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("host did not start the stream request")
	}
	close(network.streamRelease)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal("coalesced stream:", err)
		}
	}
	if _, err := p.Stream("song:6", "high"); err != nil {
		t.Fatal("cached stream:", err)
	}
	streamCalls := func() int {
		network.mu.Lock()
		defer network.mu.Unlock()
		count := 0
		for _, call := range network.calls {
			if call.Path == "/api/song/enhance/player/url/v1" {
				count++
			}
		}
		return count
	}
	if calls := streamCalls(); calls != 1 {
		t.Fatalf("coalesced/cached aliases made %d stream requests, want 1", calls)
	}
	if _, err := p.Stream("song:7", "high"); err == nil || !strings.Contains(err.Error(), "seconds") {
		t.Fatalf("risk response should provide the cooldown: %v", err)
	}
	if _, err := p.Stream("song:8", "high"); err == nil || !strings.Contains(err.Error(), "seconds") {
		t.Fatalf("another song should fail fast in cooldown: %v", err)
	}
	p.Close()
	reloaded, err := Load(root, data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reloaded.Close)
	if _, err := reloaded.Stream("song:8", "high"); err == nil || !strings.Contains(err.Error(), "seconds") {
		t.Fatalf("runtime recreation lost the cooldown: %v", err)
	}
	if calls := streamCalls(); calls != 2 {
		t.Fatalf("cooldown made more network requests: %d, want 2", calls)
	}
}

// Optional post-publication check uses the same release discovery, asset
// selection and installer as the client, anonymously against real GitHub.
func TestYOIGitHubInstall(t *testing.T) {
	repo, root := os.Getenv("YOI_GITHUB_REPO"), os.Getenv("YOI_PLUGIN_DIR")
	if repo == "" || root == "" {
		t.Skip("set YOI_GITHUB_REPO after publishing a release")
	}
	parsed, err := ParseRepo(repo)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := os.ReadFile(filepath.Join(root, "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected Manifest
	if err := json.Unmarshal(manifestBytes, &expected); err != nil {
		t.Fatal(err)
	}
	oldToken := githubToken
	githubToken = func() string { return "" }
	t.Cleanup(func() { githubToken = oldToken })
	SetAppVersion("0.1.22")
	t.Cleanup(func() { SetAppVersion("") })
	release, err := Latest(parsed)
	if err != nil {
		t.Fatal("discover public release:", err)
	}
	if strings.TrimPrefix(release.Version, "v") != expected.Version || !strings.HasSuffix(strings.Split(release.url, "?")[0], ".zip") || !strings.Contains(release.url, "/releases/download/") {
		t.Fatalf("client did not choose the versioned ZIP release: %+v", release)
	}
	plugins, work, data := t.TempDir(), t.TempDir(), t.TempDir()
	pending, err := FetchRelease(release, work)
	if err != nil {
		t.Fatal("download/check release:", err)
	}
	t.Cleanup(pending.Discard)
	if pending.Manifest.ID != expected.ID || pending.Manifest.Version != expected.Version || pending.Manifest.Name != "You Own It" {
		t.Fatalf("public manifest does not match tested release: %+v", pending.Manifest)
	}
	if err := pending.Install(plugins); err != nil {
		t.Fatal("install public release:", err)
	}
	installed := filepath.Join(plugins, expected.ID)
	localEntry, err := os.ReadFile(filepath.Join(root, expected.Main))
	if err != nil {
		t.Fatal(err)
	}
	publicEntry, err := os.ReadFile(filepath.Join(installed, expected.Main))
	if err != nil || !bytes.Equal(publicEntry, localEntry) {
		t.Fatalf("published entry differs from the tested bundle: %v", err)
	}
	p, err := Load(installed, data)
	if err != nil {
		t.Fatal("load public release:", err)
	}
	t.Cleanup(p.Close)
	if origin := p.Origin(); origin == nil || origin.Repo != parsed || origin.Version != release.Version {
		t.Fatalf("installed origin cannot track future updates: %+v", origin)
	}
	if me, err := p.Account(); err != nil || me != nil {
		t.Fatalf("fresh public installation account: %+v %v", me, err)
	}
	page, err := p.Browse("more")
	if err != nil || len(page.Sections) == 0 || p.Info().Name != "You Own It" {
		t.Fatalf("public plugin did not run: %+v %v", page, err)
	}
	t.Logf("Installed public %s@%s through client release discovery and ZIP installer", parsed, release.Version)
}
