const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  Tray,
  Menu,
  nativeImage,
  screen,
  globalShortcut,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const netease = require('./apis/netease');
const qq = require('./apis/qq');
const kuwo = require('./apis/kuwo');
const bili = require('./apis/bili');

// id -> 搜索结果里的时长(毫秒)，取链时用来识别"只有 10 秒试听片段"的伪音源
const durationCache = new Map();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let tray = null;
// 桌面歌词：独立无边框透明窗口，只显示两行歌词
let lyricWin = null;
let lyricMoveSaveTimer = 0;
// 拖动：渲染层只负责告诉我「开始 / 结束」，位置由主进程按光标屏幕坐标算，
// 跨 DPI、拖动时窗口飞出窗口区都能跟住
let lyricDrag = null;
let lastLyricPayload = null;
// 桌面歌词是否已锁定成鼠标穿透（锁上后靠托盘菜单或全局快捷键解锁）
let lyricLocked = false;
// 解锁快捷键：Ctrl+Alt+L 常被别的软件抢先注册（globalShortcut 失败也不报错），
// 这里按顺序试一组候选，谁注册成功就用谁，并把真实键位告知用户
const LYRIC_HOTKEY_CANDIDATES = [
  { accel: 'Control+Alt+L', label: 'Ctrl+Alt+L' },
  { accel: 'Control+Alt+Shift+L', label: 'Ctrl+Alt+Shift+L' },
  { accel: 'Control+Alt+U', label: 'Ctrl+Alt+U' },
  { accel: 'Control+Shift+L', label: 'Ctrl+Shift+L' },
  { accel: 'Control+Alt+K', label: 'Ctrl+Alt+K' },
];
// 实际注册成功的那个（空串表示全被占用，只能走托盘）
let lyricHotkeyLabel = '';
app.isQuitting = false;

/* ---------------- 配置持久化 ---------------- */
// 软件已由 babaMusic 更名为 BBMusic，userData 目录随之变化，首次启动时把旧配置（含登录 Cookie）搬过来
const cfgPath = () => path.join(app.getPath('userData'), 'bbmusic.json');

function migrateOldCfg() {
  try {
    const target = cfgPath();
    if (fs.existsSync(target)) return;
    const appData = app.getPath('appData');
    const candidates = [
      path.join(appData, 'babaMusic', 'babamusic.json'),
      path.join(appData, 'babaMusic', 'bbmusic.json'),
      path.join(appData, 'bbmusic', 'babamusic.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(p, target);
        break;
      }
    }
  } catch (e) {
    /* 迁移失败不影响启动 */
  }
}

let cfg = {
  neteaseCookie: '',
  qqCookie: '',
  // 登录态检测结果（落盘做 24h 缓存，避免每次启动都去问平台）：
  // { netease: { state:'ok'|'off'|'err', nick, vipType, at, err }, qq: { state, nick, uin, at, err } }
  // 只看 cookie 字符串非空是不够的 —— cookie 过期后界面会一直亮绿灯，这就是之前"永远显示已登录"的根因
  authState: {},
  volume: 0.8,
  // 默认按评论总数排：热度值 QQ/酷我拿不到真实播放量，排出来常常不是用户想要的那首
  sortMode: 'comments',
  preferPlatform: 'netease',
  // 关闭窗口行为：tray = 最小化到托盘（默认），quit = 直接退出
  closeAction: 'tray',
  // 正在播放页的歌词滚动效果：fade/plain/fly/rise/zoom/blur/karaoke
  lyricFx: 'fade',
  // 桌面歌词窗口位置，拖动后记住
  lyricBounds: null,
  // 桌面歌词字号（主行像素），次行按 0.65 缩放
  lyricFont: 34,
  // 音质选择：auto 跟随账号自动，128/192/320/flac 为固定档位
  quality: 'auto',
  // 歌词颜色：orange/pink/blue/green/purple/white/rainbow
  lyricColor: 'orange',
  // 播放模式：order 顺序播放 / loop 列表循环 / single 单曲循环 / shuffle 随机播放
  playMode: 'order',
  // 歌词延迟补偿（毫秒）：负=歌词提前，正=歌词延后；0 为不补偿
  lyricOffset: 0,
  // 音频缓存：播过的音频留档，下次直接读本地；cacheDir 为空时用 userData/audio-cache
  cacheEnabled: true,
  cacheDir: '',
  // 我的歌单：id=default 为内置默认歌单（收藏爱心直接进这里）
  playlists: null,
  // 播放历史：最近播放的歌曲，最多留 100 首，新的在最前
  history: [],
  // 断点续播：关闭时正在播放的那首、进度、所在歌单与队列，下次启动接着放
  resume: null,
  cfgRev: 4,
};

// 歌词颜色主题：hi 是当前句高亮色，dim 是逐字模式下未唱到的底色
const LYRIC_COLORS = {
  orange: { label: '活力橙', hi: '#ff7a1a', dim: '#dccab9' },
  pink: { label: '樱花粉', hi: '#ff5c94', dim: '#e0c4cf' },
  blue: { label: '天青蓝', hi: '#2f8bff', dim: '#c2cddb' },
  green: { label: '抹茶绿', hi: '#25a86b', dim: '#c2d3c7' },
  purple: { label: '星河紫', hi: '#8a5cff', dim: '#cbc3e4' },
  white: { label: '珍珠白', hi: '#ffffff', dim: '#d7cfc6' },
  rainbow: { label: '彩虹渐变', hi: '#ff7a1a', dim: '#dccab9' },
};
function normLyricColor(v) {
  return Object.prototype.hasOwnProperty.call(LYRIC_COLORS, v) ? v : 'orange';
}

// 音质档位（低 -> 高）+ 各平台映射
const QUALITY_TIERS = ['auto', '128', '192', '320', 'flac'];
const QUALITY_LABEL = {
  auto: '自动（跟随账号）',
  '128': '标准 128kbps',
  '192': '较高 192kbps',
  '320': '高品质 320kbps',
  flac: '无损 FLAC',
};
// 网易云 br 参数
const NET_BR = { '128': 128000, '192': 192000, '320': 320000, flac: 999000 };
function normQuality(v) {
  return QUALITY_TIERS.indexOf(v) >= 0 ? v : 'auto';
}
// 把选择解析成实际档位（按平台分别判定）：
// - 未登录任何账号：默认用酷我的 128k 标准音质
// - 已登录某平台：该平台按会员能给的最高音质取流（网易云->无损，QQ->320k）
//   平台自身会再按账号等级降级，这里只负责给到上限请求
function effQuality(platform) {
  const q = normQuality(cfg.quality);
  if (q !== 'auto') return q;
  const p = platform || cfg.preferPlatform || 'netease';
  if (p === 'netease') return cfg.neteaseCookie ? 'flac' : '128';
  if (p === 'qq') return cfg.qqCookie ? '320' : '128';
  return '128';
}

// 桌面歌词可选字号档位
const LYRIC_FONTS = [26, 34, 42, 52];
function normLyricFont(v) {
  const n = Number(v);
  return LYRIC_FONTS.indexOf(n) >= 0 ? n : 34;
}

// 断点续播快照：界面只会写进「当前歌曲 + 进度 + 来源歌单 + 队列」这几项，
// 这里统一过一遍结构校验，脏数据直接丢掉（宁可下次不续播，也不能带坏配置文件）
function normResume(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v.song && typeof v.song === 'object' ? v.song : null;
  if (!s) return null;
  const key = String(s.key || '');
  const packSrc = (x) => ({
    platform: String(x.platform),
    id: String(x.id),
    duration: Number(x.duration) || 0,
    platformRank: Number(x.platformRank) || 0,
    name: String(x.name || s.name || ''),
    alt: x.alt ? 1 : 0,
  });
  const sources = Array.isArray(s.sources)
    ? s.sources
        .filter((x) => x && x.platform && x.id !== undefined && x.id !== null && String(x.id) !== '')
        .map(packSrc)
        .slice(0, 4)
    : [];
  if (!key || !sources.length) return null;
  const pos = Number(v.pos);
  const queue = Array.isArray(v.queue)
    ? v.queue
        .filter((it) => it && typeof it === 'object')
        .map((it) => {
          const k = String(it.key || '');
          const ss = Array.isArray(it.sources)
            ? it.sources
                .filter((x) => x && x.platform && x.id !== undefined && x.id !== null && String(x.id) !== '')
                .map((x) => ({
                  platform: String(x.platform),
                  id: String(x.id),
                  duration: Number(x.duration) || 0,
                  platformRank: Number(x.platformRank) || 0,
                  name: String(x.name || it.name || ''),
                  alt: x.alt ? 1 : 0,
                }))
                .slice(0, 4)
            : [];
          if (!k || !ss.length) return null;
          return {
            key: k,
            name: String(it.name || ''),
            artists: String(it.artists || ''),
            album: String(it.album || ''),
            cover: String(it.cover || ''),
            duration: Number(it.duration) || 0,
            sources: ss,
          };
        })
        .filter(Boolean)
        .slice(0, 80)
    : [];
  const from = v.src && typeof v.src === 'object' ? v.src : {};
  return {
    song: {
      key,
      name: String(s.name || ''),
      artists: String(s.artists || ''),
      album: String(s.album || ''),
      cover: String(s.cover || ''),
      duration: Number(s.duration) || 0,
      vtag: String(s.vtag || ''),
      vip: s.vip ? 1 : 0,
      sources,
    },
    pos: isFinite(pos) && pos > 0 ? Math.round(pos) : 0,
    playing: !!v.playing,
    mode: normPlayMode(v.mode),
    src: { type: String(from.type || 'search'), id: String(from.id || '') },
    queue,
    at: Number(v.at) || 0,
  };
}

function loadCfg() {
  migrateOldCfg();
  try {
    // 别家编辑器改过的配置文件可能带 BOM，JSON.parse 会直接炸，先剥掉
    let raw = fs.readFileSync(cfgPath(), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    Object.assign(cfg, JSON.parse(raw));
  } catch (e) {
    /* 首次运行无配置 */
  }
  // 幂等纠偏（不依赖 cfgRev，避免老用户的 cfgRev 已被写成新值导致升级被跳过）：
  // smart 模式已废弃，一律归到"按评论总数"；没设置关闭行为的一律默认最小化到托盘
  let needSave = false;
  if (!cfg.sortMode || cfg.sortMode === 'smart') {
    cfg.sortMode = 'comments';
    needSave = true;
  }
  if (!cfg.closeAction) {
    cfg.closeAction = 'tray';
    needSave = true;
  }
  if (!cfg.cfgRev || cfg.cfgRev < 2) {
    cfg.cfgRev = 2;
    needSave = true;
  }
  // 音质选择：老配置没有该字段则默认跟随账号（auto）
  if (cfg.quality === undefined || normQuality(cfg.quality) !== cfg.quality) {
    cfg.quality = 'auto';
    needSave = true;
  }
  // 歌词颜色：老配置没有该字段则默认活力橙
  if (cfg.lyricColor === undefined || normLyricColor(cfg.lyricColor) !== cfg.lyricColor) {
    cfg.lyricColor = normLyricColor(cfg.lyricColor);
    needSave = true;
  }
  if (cfg.cfgRev < 3) {
    cfg.cfgRev = 3;
    needSave = true;
  }
  // 歌单与播放历史（0.2.3 起）：老配置没有这两个字段，补默认值并做一次规整
  const fixedPls = normPlaylists(cfg.playlists);
  if (JSON.stringify(fixedPls) !== JSON.stringify(cfg.playlists)) {
    cfg.playlists = fixedPls;
    needSave = true;
  }
  const fixedHis = normHistory(cfg.history);
  if (JSON.stringify(fixedHis) !== JSON.stringify(cfg.history)) {
    cfg.history = fixedHis;
    needSave = true;
  }
  if (!cfg.cfgRev || cfg.cfgRev < 4) {
    cfg.cfgRev = 4;
    needSave = true;
  }
  if (needSave) saveCfg();
}
function saveCfg() {
  try {
    fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    /* 写入失败不阻塞播放 */
  }
}

/* ---------------- 登录态检测 ----------------
 * 三态：ok=已登录（平台认这个 cookie） / off=未登录（没填，或 cookie 已失效） / err=这次没检测出来（网络/接口异常）
 * 结果落盘缓存 24 小时；err 不缓存（at=0），下次启动或手动重测会重新问平台。
 */
const AUTH_TTL = 24 * 3600 * 1000;

function authFresh(rec) {
  return !!(rec && rec.at && Date.now() - Number(rec.at) < AUTH_TTL);
}

async function checkAuth(force = false) {
  const prev = cfg.authState || {};
  const out = {};

  // 网易云
  if (!cfg.neteaseCookie) {
    out.netease = { state: 'off', nick: '', vipType: 0, at: 0, err: '未设置 Cookie' };
  } else if (!force && authFresh(prev.netease)) {
    out.netease = prev.netease;
  } else {
    out.netease = await netease
      .account(cfg.neteaseCookie)
      .then((r) =>
        r && r.ok
          ? { state: 'ok', nick: r.nick || '', vipType: r.vipType || 0, at: Date.now(), err: '' }
          : { state: 'off', nick: '', vipType: 0, at: Date.now(), err: 'Cookie 已失效，需要重新登录' }
      )
      .catch((e) => ({ state: 'err', nick: '', vipType: 0, at: 0, err: '检测失败：' + String((e && e.message) || e) }));
  }

  // QQ 音乐
  if (!cfg.qqCookie) {
    out.qq = { state: 'off', nick: '', uin: '', at: 0, err: '未设置 Cookie' };
  } else if (!force && authFresh(prev.qq)) {
    out.qq = prev.qq;
  } else {
    out.qq = await qq
      .account(cfg.qqCookie)
      .then((r) =>
        r && r.ok
          ? { state: 'ok', nick: r.nick || '', uin: r.uin || '', at: Date.now(), err: '' }
          : { state: 'off', nick: '', uin: '', at: Date.now(), err: (r && r.reason) || 'Cookie 已失效，需要重新登录' }
      )
      .catch((e) => ({ state: 'err', nick: '', uin: '', at: 0, err: '检测失败：' + String((e && e.message) || e) }));
  }

  cfg.authState = out;
  saveCfg();
  return out;
}

/* ---------------- 歌单与播放历史：结构规整 ---------------- */
// 歌单/历史里只存"能直接起播"的字段，去掉热度、评论、匹配度等搜索期临时数据，
// 否则配置文件会被搜索结果撑到几 MB，每次写盘都变慢
function normSong(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = (Array.isArray(raw.sources) ? raw.sources : [])
    .filter((s) => s && s.platform && s.id !== undefined && s.id !== null && String(s.id) !== '')
    .map((s) => ({
      platform: String(s.platform),
      id: String(s.id),
      duration: Number(s.duration) || 0,
      platformRank: Number(s.platformRank) || 0,
      name: String(s.name || raw.name || ''),
      // alt=1 表示这是导入平台不可播时补上来的替代音源，界面要能区分
      alt: s.alt ? 1 : 0,
    }))
    .slice(0, 4);
  const first = src[0];
  const name = String(raw.name || (first && first.name) || '').trim();
  if (!first || !name) return null;
  const out = {
    key: String(raw.key || first.platform + ':' + first.id),
    name,
    artists: String(raw.artists || ''),
    album: String(raw.album || ''),
    cover: String(raw.cover || ''),
    duration: Number(raw.duration) || first.duration || 0,
    sources: src,
  };
  if (raw.playedAt) out.playedAt = Number(raw.playedAt) || 0;
  // vip=1：导入时平台就标了要会员/付费，点播时很可能要跨平台换源，界面先提示出来
  if (raw.vip) out.vip = 1;
  return out;
}

function defaultPlaylist() {
  return { id: 'default', name: '默认歌单', from: 'local', createdAt: 0, songs: [] };
}

function normPlaylists(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    const songs = [];
    const seenSong = new Set();
    (Array.isArray(p.songs) ? p.songs : []).forEach((s) => {
      const n = normSong(s);
      if (!n || seenSong.has(n.key)) return;
      seenSong.add(n.key);
      songs.push(n);
    });
    out.push({
      id,
      name: String(p.name || '未命名歌单').slice(0, 40),
      from: String(p.from || 'local'),
      createdAt: Number(p.createdAt) || 0,
      songs,
    });
  });
  // 默认歌单必须存在且排第一
  if (!out.some((p) => p.id === 'default')) out.unshift(defaultPlaylist());
  out.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return out;
}

const HISTORY_MAX = 100;
function normHistory(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((raw) => {
    const n = normSong(raw);
    if (!n || seen.has(n.key)) return;
    seen.add(n.key);
    n.playedAt = Number(raw && raw.playedAt) || 0;
    out.push(n);
  });
  out.sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));
  return out.slice(0, HISTORY_MAX);
}

/* ---------------- 歌单与外部分享链接导入 ---------------- */
const SHARE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QQ_COVER = (mid) => (mid ? 'https://y.qq.com/music/photo_new/T002R300x300M000' + mid + '.jpg' : '');
const NE_COVER = (url) => (url ? String(url).replace(/^http:/, 'https:') + '?param=300y300' : '');

// 从一段文字里抠出分享链接，并尽量跟随短链拿到真实地址
async function pickShareUrl(text) {
  const s = String(text || '');
  const m = s.match(/https?:\/\/[^\s"'<>，。、）)]+/);
  if (!m) return '';
  let url = m[0];
  if (/163cn\.tv|qq\.com\/base\/fcgi-bin\/u|url\.cn|t\.cn/i.test(url)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': SHARE_UA }, redirect: 'follow' });
      if (res.url && res.url !== url) url = res.url;
      else {
        const html = await res.text();
        const m2 = html.match(/https?:\/\/[^\s"'<>]+/);
        if (m2) url = m2[0];
      }
    } catch (e) {
      /* 跟不到就用原始地址兜底 */
    }
  }
  return url;
}

function detectPlatform(url) {
  if (/163cn\.tv|163\.com|music\.163/i.test(url)) return 'netease';
  if (/qq\.com|qqmusic|y\.qq/i.test(url)) return 'qq';
  return '';
}

function pickId(url, platform) {
  const u = String(url || '');
  let m = null;
  if (platform === 'netease') {
    m =
      u.match(/playlist[^\d]{0,12}(\d{4,})/i) ||
      u.match(/[?&#]id=(\d{4,})/i) ||
      u.match(/\/(\d{4,})(?:[?&#]|$)/);
  } else {
    m =
      u.match(/(?:disstid|dissid|[?&#]id)=(\d{4,})/i) ||
      u.match(/playlist\/(\d{4,})/i) ||
      u.match(/taoge\/(\d{4,})/i) ||
      u.match(/(\d{4,})/);
  }
  return m ? m[1] : '';
}

async function importNetease(id) {
  const cookie = String(cfg.neteaseCookie || '').trim();
  const headers = {
    Referer: 'https://music.163.com/',
    'User-Agent': SHARE_UA,
    Cookie: cookie
      ? 'MUSIC_U=' + cookie.replace(/^MUSIC_U=/, '') + '; appver=2.0.2; os=pc'
      : 'appver=2.0.2; os=pc',
  };
  const res = await fetch('https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000&s=8', {
    headers,
  });
  if (!res.ok) throw new Error('网易云接口返回 ' + res.status);
  const data = await res.json();
  const pl = data && data.playlist;
  if (!pl) throw new Error('没取到歌单，链接可能失效或歌单已设为私密');
  let tracks = Array.isArray(pl.tracks) ? pl.tracks.slice() : [];
  const ids = (pl.trackIds || []).map((t) => t && t.id).filter(Boolean);
  // 新版接口常常只给 trackIds，不给完整曲目，缺了再按 id 批量补
  if (ids.length && tracks.length < Math.min(ids.length, 500)) {
    tracks = [];
    for (let i = 0; i < ids.length && i < 1000; i += 200) {
      const batch = ids.slice(i, i + 200);
      try {
        const r2 = await fetch('https://music.163.com/api/song/detail?ids=[' + batch.join(',') + ']', { headers });
        const d2 = await r2.json();
        (d2 && d2.songs ? d2.songs : []).forEach((s) => tracks.push(s));
      } catch (e) {
        /* 单批失败不影响其它批 */
      }
    }
  }
  const songs = tracks
    .map((t) => {
      const sid = String(t.id || '');
      if (!sid) return null;
      return normSong({
        key: 'netease:' + sid,
        name: t.name || '',
        artists: (t.ar || t.artists || []).map((a) => a.name).join(' / '),
        album: (t.al && t.al.name) || (t.album && t.album.name) || '',
        cover: NE_COVER((t.al && t.al.picUrl) || (t.album && t.album.picUrl) || ''),
        duration: t.dt || t.duration || 0,
        // fee：0/8 免费，1 会员，4 付费专辑 —— 这类曲子点播时网易云很可能没版权或需会员
        vip: t.fee === 1 || t.fee === 4 || (t.fee !== undefined && t.fee !== 0 && t.fee !== 8) ? 1 : 0,
        sources: [{ platform: 'netease', id: sid, duration: t.dt || t.duration || 0, platformRank: 0 }],
      });
    })
    .filter(Boolean);
  return { name: pl.name || '网易云歌单', songs };
}

async function importQq(id) {
  const cookie = String(cfg.qqCookie || '');
  const headers = { Referer: 'https://y.qq.com/', 'User-Agent': SHARE_UA, Cookie: cookie };
  let list = [];
  let title = '';
  // 通道一：老版歌单接口，免登录通常就能拿到完整歌单
  try {
    const url =
      'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1' +
      '&disstid=' + encodeURIComponent(id) +
      '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
    const res = await fetch(url, { headers });
    const txt = (await res.text()).replace(/^[^({]*\(/, '').replace(/\);?\s*$/, '');
    const data = JSON.parse(txt);
    const cd = data && data.cdlist && data.cdlist[0];
    if (cd) {
      title = cd.dissname || cd.dissname2 || '';
      list = (cd.songlist || []).map((s) => ({
        mid: s.songmid || s.mid,
        name: s.songname || s.name || s.title || '',
        artists: (s.singer || []).map((a) => a.name).join(' / '),
        album: s.albumname || (s.album && s.album.name) || '',
        albumMid: s.albummid || (s.album && s.album.mid) || '',
        duration: (Number(s.interval) || 0) * 1000,
        // QQ 的 pay.pay_play 非 0 即付费/VIP 曲，非会员点播会被平台拒
        vip: s.pay && Number(s.pay.pay_play) ? 1 : 0,
      }));
    }
  } catch (e) {
    /* 落到通道二 */
  }
  // 通道二：musicu 歌单详情，老接口改版时兜底
  if (!list.length) {
    try {
      const body = {
        comm: { ct: 24, cv: 0 },
        req_1: {
          module: 'music.srfDissInfo.aiDissInfo',
          method: 'uniform_get_Dissinfo',
          param: { disstid: Number(id), enc_host_uin: '', tag: 1, userinfo: 1, song_begin: 0, song_num: 1000 },
        },
      };
      const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const d = data && data.req_1 && data.req_1.data;
      if (d) {
        title = title || d.dirinfo && d.dirinfo.title || d.dissname || '';
        const arr = d.songlist || (d.songlist && d.songlist.songlist) || [];
        list = (Array.isArray(arr) ? arr : []).map((s) => ({
          mid: s.mid || s.songmid || s.file && s.file.media_mid,
          name: s.name || s.title || s.songname || '',
          artists: (s.singer || []).map((a) => a.name).join(' / '),
          album: (s.album && s.album.name) || s.albumname || '',
          albumMid: (s.album && s.album.mid) || s.albummid || '',
          duration: Number(s.interval) ? Number(s.interval) * 1000 : 0,
          vip: s.pay && Number(s.pay.pay_play) ? 1 : 0,
        }));
      }
    } catch (e) {
      /* 两个通道都失败，交给上层报错 */
    }
  }
  if (!list.length) throw new Error('没取到歌单，链接可能失效、歌单为私密或平台接口改版');
  const songs = list
    .map((s) => {
      const mid = String(s.mid || '');
      if (!mid || !s.name) return null;
      return normSong({
        key: 'qq:' + mid,
        name: s.name,
        artists: s.artists,
        album: s.album,
        cover: QQ_COVER(s.albumMid),
        duration: s.duration,
        vip: s.vip,
        sources: [{ platform: 'qq', id: mid, duration: s.duration, platformRank: 0 }],
      });
    })
    .filter(Boolean);
  return { name: title || 'QQ 音乐歌单', songs };
}

async function importPlaylistFromLink(link) {
  const url = await pickShareUrl(link);
  if (!url) return { ok: false, reason: '没有识别到链接，请把歌单分享链接整段粘贴进来' };
  let platform = detectPlatform(url);
  let id = pickId(url, platform || 'netease');
  if (!id) return { ok: false, reason: '链接里没找到歌单 id，请确认是「歌单」分享链接而不是单曲' };
  // 域名判断不出来时（比如短链没跟到），两个平台各试一次
  const tryOrder = platform ? [platform] : ['netease', 'qq'];
  let lastErr = null;
  for (const p of tryOrder) {
    const pid = pickId(url, p);
    if (!pid) continue;
    try {
      const r = p === 'netease' ? await importNetease(pid) : await importQq(pid);
      if (r && r.songs && r.songs.length) {
        return { ok: true, platform: p, playlistId: pid, name: r.name, songs: r.songs };
      }
      lastErr = new Error('歌单里没有可播放的歌曲');
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, reason: (lastErr && lastErr.message) || '导入失败' };
}

/* ---------------- 文本规整与匹配度 ---------------- */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(\[【].*?[)）\]】]/g, '')
    .replace(/[\s\-_·、,，.。!！?？'"“”‘’~]/g, '')
    .replace(/(live|remix|伴奏|翻唱|版|dj|feat.*)/g, '');
}

// 版本标记识别：伴奏 / 翻唱 / remix / 现场等属于不同"作品"，绝不能与原版合并
const VERSION_RULES = [
  { tag: '伴奏', re: /伴奏|卡拉|karaoke|instrumental|off\s*vocal|无和声/i },
  { tag: '纯音乐', re: /纯音乐|inst\.?\s|instrumental/i },
  { tag: '翻唱', re: /翻唱|cover|致敬|原唱\s*[:：]/i },
  { tag: 'remix', re: /remix|混音|dj\s*版|电音|club\s*mix|bootleg/i },
  { tag: '现场', re: /live|现场|演唱会|concert/i },
  // 倍速版（0.8x / 1.2x）本质也是片段改编，必须单独识别：
  // 漏掉时《说好的幸福呢 (0.8x)》会因为评论数极高被当成原版顶到第一
  { tag: '片段', re: /抖音|热播|片段|剪辑|加速|降速|慢速|sped\s*up|slowed|完整版|高清版|\d+(?:\.\d+)?\s*[xX](?![a-zA-Z])/i },
  { tag: '乐器版', re: /钢琴|piano|吉他|guitar|八音盒|music\s*box|古筝|二胡|小提琴|violin|口琴|尤克里里|ukulele/i },
  { tag: '换声', re: /女声|男声|童声|女版|男版|ai\s*翻唱/i },
  { tag: '改编', re: /治愈|改编|重制|重新编曲|新版|不插电|unplugged|acoustic|古风|摇滚|爵士|轻音乐|八音盒|助眠|白噪音|欢快|律动|动感|抒情|伤感|唯美|温柔|清新|燃|萌|搞笑/i },
  { tag: 'beat', re: /\bbeat\b|type\s*beat|beats/i },
];

function versionTag(name) {
  const s = String(name || '');
  const tags = [];
  for (const r of VERSION_RULES) if (r.re.test(s)) tags.push(r.tag);
  // 兜底：名字里带"版"却没人认领的（如"欢快律动版"），一样视为改编版本
  if (!tags.length && /版/.test(s)) tags.push('改编');
  return Array.from(new Set(tags)).sort().join('+');
}

// 合并键专用规整：只去掉符号本身，保留括号内的文字。
// norm() 会把"稻香(治愈版)"整段括号删成"稻香"，导致各种改编版本被误判成同一首，
// 于是"封面信息是原版、播出来是伴奏/翻唱"——合并键必须用这个更严格的版本。
function strictNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·、,，.。!！?？'"“”‘’~/\\|+&()[\]【】<>《》：:;；]/g, '');
}

// 查询分词：只按空格 / 顿号 / 逗号 / 斜杠切，绝不按"的"切。
// 按"的"切会把《说好的幸福呢》切成"说好"+"幸福呢"，歌名精确匹配反而被破坏。
function parseQueryTokens(keyword) {
  return String(keyword || '')
    .split(/[\s,，、/|+]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);
}

// 从查询串里剥掉歌手名，剩下的才是真正的歌名查询串。
// 只在"结果里的歌手名确实出现在查询中"时才剥，纯歌名搜索原样返回，不会误伤。
function splitTitleQuery(keyword, artists) {
  const k = String(keyword || '');
  let title = k;
  let hit = false;
  const names = String(artists || '')
    .split(/[\/、,，&]/)
    .map((a) => a.trim())
    .filter((a) => a.length >= 2);
  for (const n of names) {
    if (title.includes(n)) title = title.split(n).join(' ').trim();
    if (k.includes(n)) hit = true;
  }
  return { title: title.trim() || k, hit };
}

function matchScore(title, kw) {
  const t = norm(title);
  const k = norm(kw);
  if (!k) return 0.5;
  if (!t) return 0;
  if (t === k) return 1;
  // 以关键词开头/结尾：按多出来的字数衰减，"晴天"vs"晴天，雨"不至于和原版同分
  if (t.startsWith(k) || t.endsWith(k)) {
    const extra = t.length - k.length;
    return Math.max(0.6, 0.94 - extra * 0.06);
  }
  // 关键词只占标题一部分：按覆盖率衰减，"夏日友晴天"之于"晴天"只能算半个相关
  if (t.includes(k)) return 0.45 + 0.35 * (k.length / t.length);
  if (k.includes(t) && t.length >= 2) return 0.55 + 0.2 * (t.length / k.length);
  let hit = 0;
  for (const ch of k) if (t.includes(ch)) hit++;
  return (hit / k.length) * 0.5;
}

// 统一热度到 0-1：网易云用官方 pop 值；QQ 接口不返回播放量，只能用结果内排名换算（估算值）
function hotScore(item, total) {
  if (item.platform === 'netease') return Math.min(1, (item.popularity || 0) / 100);
  const rank = item.platformRank || 0;
  const ratio = total > 1 ? 1 - rank / total : 1;
  return Math.max(0.08, Math.min(1, ratio));
}

/* ---------------- 排序 ---------------- */
// 评论数换算到 0~1：4.6 万条 ≈ 0.92，1000 条 ≈ 0.6，1 条 ≈ 0.06。
// 用对数压缩，避免少数大爆款把其它候选全挤到后面
function commentWeight(c) {
  return Math.log10(1 + (c || 0)) / 5;
}

// 统一排序入口：搜索出结果时排一次，评论数补全后再排一次
function sortResultList(list, keyword, mode) {
  const kwLen = String(keyword || '').length;
  const m = mode || 'comments';
  const kwHasVer = versionTag(keyword) !== '';
  list.forEach((r) => {
    const ver = r.version || '';
    const cover = r.cover === undefined ? 1 : r.cover;
    if (m === 'comments') {
      // 权重重新分配。原来评论数占 62%，但 QQ/酷我独有条目（网易云没版权的正版，
      // 典型如周杰伦）评论数恒为 0，等于被判死刑——搜「我不配」时原版被翻唱挤到第 14 名。
      // 现在评论只做辅助，主权重交回「歌名匹配 + 查询分词覆盖 + 平台热度」。
      let sc =
        (r.match || 0) * 0.34 +
        cover * 0.26 +
        (r.hot || 0) * 0.18 +
        // 评论缺失补偿：没评论不代表不火，歌手对得上的给 0.1 基线，不再按 0 硬算
        Math.max(commentWeight(r.comments), r.artHit ? 0.1 : 0) * 0.12 +
        // 多平台同时能播，多半就是各曲库里都存在的那一版
        Math.min(0.1, Math.max(0, (r.platCount || 1) - 1) * 0.05);
      // 相关度是门槛：评论再多，不是这首歌也不能压过正主（"夏日友晴天"之于"晴天"）
      if ((r.match || 0) < 0.7) sc *= 0.6;
      else if ((r.match || 0) < 0.95) sc *= 0.85; // 标题只是包含关键词的
      if (ver && !kwHasVer) sc *= 0.62; // live/伴奏等改编版本降权，但不隐藏
      // 逐字同名且没有任何版本标记的给保底加分，避免正版被同名片压到首屏之外
      if ((r.match || 0) >= 0.99 && !ver) sc += 0.06;
      if (r.artHit) sc += 0.02;
      r.score = Math.min(1, sc);
    } else if (m === 'hot') {
      r.score = (r.hot || 0) * (ver && !kwHasVer ? 0.72 : 1);
    } else if (m === 'match') {
      r.score = ((r.match || 0) * 0.62 + cover * 0.38) * (ver && !kwHasVer ? 0.85 : 1);
    } else {
      let sc = (r.match || 0) * 0.42 + cover * 0.24 + (r.hot || 0) * 0.24;
      if (ver && !kwHasVer) sc *= 0.72;
      if (r.artHit) sc = Math.min(1, sc + 0.12);
      if (r.shortDur) sc *= 0.78;
      r.score = sc;
    }
  });
  list.sort((a, b) => {
    if (Math.abs((b.score || 0) - (a.score || 0)) > 0.001) return b.score - a.score;
    // 评论模式下分数打平时，谁评论多谁在前
    if (m === 'comments' && (b.comments || 0) !== (a.comments || 0)) return (b.comments || 0) - (a.comments || 0);
    if (!!a.artHit !== !!b.artHit) return a.artHit ? -1 : 1;
    if (!!a.version !== !!b.version) return a.version ? 1 : -1;
    const la = Math.abs(a.name.length - kwLen);
    const lb = Math.abs(b.name.length - kwLen);
    if (la !== lb) return la - lb;
    if ((b.platCount || 1) !== (a.platCount || 1)) return (b.platCount || 1) - (a.platCount || 1);
    return (b.duration || 0) - (a.duration || 0);
  });
  return list;
}

/* ---------------- 聚合搜索 + 去重合并 ---------------- */
async function aggregateSearch(keyword, opts = {}) {
  const limit = opts.limit || 30;
  const tasks = [
    netease.search(keyword, limit, cfg.neteaseCookie).catch((e) => ({ error: 'netease: ' + e.message })),
    qq.search(keyword, limit, cfg.qqCookie).catch((e) => ({ error: 'qq: ' + e.message })),
    kuwo.search(keyword, limit).catch((e) => ({ error: 'kuwo: ' + e.message })),
  ];
  const settled = await Promise.all(tasks);

  const errors = [];
  let raw = [];
  for (const r of settled) {
    if (Array.isArray(r)) raw = raw.concat(r);
    else if (r && r.error) errors.push(r.error);
  }

  const totals = { netease: 0, qq: 0, kuwo: 0 };
  for (const x of raw) {
    if (totals[x.platform] === undefined) totals[x.platform] = 0;
    totals[x.platform] += 1;
    // 取链时库里没有时长, 用搜索结果里的时长做参照, 才能识别试听片段
    if (x.duration) durationCache.set(x.platform + ':' + x.id, x.duration);
  }

  // 一首歌在多个平台/多个 mid 上的时长投票：8 秒内算同一版本，票多的簇胜出，平票取更长的那簇
  function pickDuration(durs) {
    const arr = (durs || []).filter((d) => d > 0).sort((a, b) => a - b);
    if (!arr.length) return 0;
    const clusters = [];
    for (const d of arr) {
      const c = clusters.find((cl) => Math.abs(d - cl[0]) <= 8000);
      if (c) c.push(d);
      else clusters.push([d]);
    }
    clusters.sort((a, b) => b.length - a.length || b[0] - a[0]);
    const win = clusters[0];
    return win[Math.floor(win.length / 2)];
  }

  // 合并同名同歌手同版本的可用源；版本不同（伴奏/翻唱/remix…）一律分开，避免串源
  const map = new Map();
  for (const item of raw) {
    // 过滤残缺条目：短于 30 秒的多是试听片段、铃声，不是完整歌曲
    if (item.duration && item.duration < 45000) continue;
    const vtag = versionTag(item.name);
    // 展示与降权用"歌名+专辑名"判断版本：很多平台的 live/伴奏标记写在专辑名里，
    // 只认歌名会把《稻香》和《稻香 (Live)》当成同一首合并，播放时就串了
    const vtagFull = versionTag(item.name + ' ' + (item.album || ''));
    // 合并键必须带上"歌名+专辑"识别出的版本标签。
    // QQ 大量 live/伴奏版本把标记写在专辑名里、歌名仍是《孤勇者》，
    // 只用歌名做键就会把它们并进原版，列表里看着是原版、点开响的是伴奏
    const baseKey = strictNorm(item.name) + '|' + strictNorm((item.artists || '').split('/')[0]) + '|' + (vtagFull || '');
    // 名字+歌手+版本标签相同的才可能是同一首；但平台经常把 live/伴奏版的歌名和专辑都写得很干净，
    // 靠文本根本分不出来。这时用时长当第二道判据：差 8 秒以上（或超过 8%）的，宁可多出一条，
    // 也绝不合并 —— 用户宁可搜到的不能播，也不要播出来的不是原版。
    let bucket = map.get(baseKey);
    if (!bucket) {
      bucket = [];
      map.set(baseKey, bucket);
    }
    let rec = null;
    for (const cand of bucket) {
      const d1 = cand.duration || 0;
      const d2 = item.duration || 0;
      if (!d1 || !d2) {
        rec = cand;
        break;
      }
      if (Math.abs(d1 - d2) <= Math.max(8000, d1 * 0.08)) {
        rec = cand;
        break;
      }
    }
    if (!rec) {
      rec = {
        key: bucket.length ? baseKey + '#' + (bucket.length + 1) : baseKey,
        name: item.name,
        artists: item.artists,
        album: item.album,
        cover: item.cover || '',
        duration: item.duration,
        vtag,
        vtagAlbum: vtagFull,
        sources: [],
        // 各源上报的时长，合并结束后投票定出"列表标注时长"
        durs: [],
        hot: 0,
        hotDetail: {},
      };
      bucket.push(rec);
    }
    if (item.duration) rec.durs.push(item.duration);
    // 同一平台同名同歌手最多留 2 条源（按平台原始排名先后）：QQ 搜索会返回十几条同名记录，
    // 里面混着搬运、伴奏、翻录，全挂上去只会在取链失败时把用户带到错误音源
    if (rec.sources.filter((s) => s.platform === item.platform).length >= 2) continue;
    // 记下每个源的真实时长, 取链时用它识别"试听片段"伪音源(酷我/QQ 都会给片段)
    if (item.duration) durationCache.set(item.platform + ':' + item.id, item.duration);
    rec.sources.push({
      platform: item.platform,
      id: item.id,
      // QQ 源的数字 songid：取评论数只能用它（传 songmid 会拿到 0）
      songid: item.songid || '',
      // 该源所在的平台是否标了「需会员/付费」：列表据此打角标，说明文案也据此改准
      vip: item.vip ? 1 : 0,
      popularity: item.popularity,
      platformRank: item.platformRank,
      // 该源自己的时长：前端播放时用它做"是否被平台塞了别的版本"的校验基准，
      // 用合并后条目的时长（取最长源）当基准会把正常音源误判成串源
      duration: item.duration || 0,
      name: item.name || '',
      fee: item.fee,
    });
    const hs = hotScore(item, totals[item.platform] || 1);
    const hv = item.platform === 'netease' ? item.popularity || 0 : Math.round(hs * 100);
    rec.hotDetail[item.platform] = Math.max(rec.hotDetail[item.platform] || 0, hv);
    if (hs > rec.hot) rec.hot = hs;
    if (!rec.cover && item.cover) rec.cover = item.cover;
  }

  // 列表标注时长取「票数最多的那个时长」，而不是原来取最长源：
  // QQ 常把整张专辑/长音频挂成一首歌的另一个 mid（《我不配》那条 2052 秒=34:12），
  // 取最长会让列表和播放条一路显示错时长（曾显示 5:17，实际 4:48），播放校验基准也跟着错。
  for (const bucket of map.values()) {
    for (const rec of bucket) rec.duration = pickDuration(rec.durs) || rec.duration || 0;
  }

  // 本次结果的时长中位数, 用来识别"片段版"
  const durs = Array.from(map.values()).flat().map((r) => r.duration || 0).filter((d) => d > 0).sort((a, b) => a - b);
  const medDur = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const kwNorm = norm(keyword);
  // 歌名查询串：只在查询里确实出现了结果条目的歌手名时才剥掉歌手名，
  // 搜「我不配」原样保留，搜「周杰伦 我不配」剥成「我不配」。
  const kwTokens = parseQueryTokens(keyword);
  const list = Array.from(map.values()).flat().map((r) => {
    const q = splitTitleQuery(keyword, r.artists);
    r.match = matchScore(r.name, q.title);
    // 版本标签：歌名或专辑名任一带 live/伴奏/翻唱等，都算"不是原版"
    r.version = r.vtagAlbum || r.vtag || '';
    // 歌手命中加权：搜"周杰伦 稻香"时，翻唱者的《稻香》不该排到周杰伦前面
    r.artHit =
      q.hit ||
      String(r.artists || '').split(/[\/、,，&]/).some((a) => {
        const n = norm(a);
        return n.length >= 2 && (kwNorm.includes(n) || n.includes(kwNorm));
      });
    // token 覆盖率：查询的每一段在「歌名 + 歌手」里命中几成。
    // 搜「周杰伦 我不配」时，翻唱条目歌名对得上、歌手对不上，只能拿一半分。
    // 只有一段词（纯歌名搜索）时没有区分度，按中性 1 处理，避免全体一起被拉低。
    r.cover =
      kwTokens.length >= 2
        ? kwTokens.filter((t) => (norm(r.name) + ' ' + norm(r.artists)).includes(norm(t))).length / kwTokens.length
        : 1;
    // 时长明显短于同批中位数的（30~60 秒的片段版）
    r.shortDur = !!(r.duration && medDur && r.duration < medDur * 0.6);
    // 严格同名：与"去掉歌手词之后的歌名"逐字一致的条目优先展示
    r.strictName = matchScore(r.name, q.title) >= 0.92;
    // 覆盖平台数：多平台可播的优先
    r.platCount = new Set(r.sources.map((s) => s.platform)).size;
    // 首源 = 提供标题/封面/时长信息的源，播放必须优先用它，
    // 否则界面显示的是原版信息、响的却是另一个源的音频
    r.primary = r.sources[0] ? { platform: r.sources[0].platform, id: r.sources[0].id } : null;
    // 任一源被平台标成需会员/付费，就在列表上打 VIP 角标（点播会自动跨平台补源，含 B站兜底）
    r.vip = r.sources.some((s) => s.vip === 1) ? 1 : 0;
    return r;
  });

  // 平台会顺带返回同歌手的其他热门歌（搜"陈奕迅 富士山下"塞进《孤勇者》），
  // 标题与关键词几乎无重合的直接剔掉；万一把结果削没了就退回原列表
  const related = list.filter((r) => r.match >= 0.3);
  const out = related.length >= 3 ? related : list;

  sortResultList(out, keyword, opts.sortMode || cfg.sortMode || 'comments');
  return { list: out, errors, counts: totals };
}

/* ---------------- 热度画像补全 ----------------
   搜索结果里能直接拿到的热度只有网易云的 pop 值和平台排名；
   评论数、酷我 score100 都要额外查一次。为了不拖慢搜索，
   列表先返回，补到的数据再按条目增量推给界面。 */
async function pool(tasks, size) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      await t().catch(() => {});
    }
  });
  await Promise.all(workers);
}

// 网易云评论数缓存：按歌曲 id 去重，切排序或重复搜索不会二次请求
const neCommentCache = new Map();
async function neCommentCount(id) {
  const k = String(id || '');
  if (!k) return 0;
  if (neCommentCache.has(k)) return neCommentCache.get(k);
  neCommentCache.set(k, 0); // 先占位，防并发重复打同一个接口
  let c = 0;
  try {
    c = (await netease.commentCount(k)) || 0;
  } catch (e) {
    c = 0;
  }
  neCommentCache.set(k, c);
  return c;
}

// QQ + 网易云 评论数求和：comments 存合计用于排序，commentsDetail 存拆分供界面提示
function applyCommentSum(sender, r) {
  const ne = r.neComments || 0;
  const qq = r.qqComments || 0;
  const sum = ne + qq;
  r.commentsDetail = { netease: ne, qq: qq };
  if (!sum) return;
  r.comments = sum;
  if (sender && !sender.isDestroyed()) {
    sender.send('meta:update', { key: r.key, comments: sum, commentsDetail: r.commentsDetail });
  }
}

async function enrichMeta(sender, list) {
  const tasks = [];
  const push = (fn) => tasks.push(fn);

  // QQ 评论数走批量接口（一次请求带回整批），按数字 songid 精确匹配，
  // 不做「歌名+歌手」模糊猜测——那条路会把原版评论数套到 live/伴奏版头上
  const qqIds = [];
  list.forEach((r) => {
    (r.sources || []).forEach((s) => {
      if (s.platform !== 'qq') return;
      const sid = String(s.songid || '');
      if (/^\d+$/.test(sid) && qqIds.indexOf(sid) === -1) qqIds.push(sid);
    });
  });
  let qqMap = {};
  if (qqIds.length) {
    try {
      qqMap = (await qq.commentCounts(qqIds, cfg.qqCookie)) || {};
    } catch (e) {
      qqMap = {};
      if (process.env.BBM_DEBUG) console.log('[bbm] qq commentCounts 失败:', e.message);
    }
  }
  if (process.env.BBM_DEBUG) {
    try {
      fs.appendFileSync(
        path.join(app.getPath('temp'), 'bbm-debug.log'),
        '[bbm] enrichMeta entries=' + list.length + ' qqIds=' + qqIds.length + ' got=' + Object.keys(qqMap).length + ' ' + JSON.stringify(qqMap).slice(0, 300) + '\n'
      );
    } catch (e) {}
  }
  // 同一首歌可能挂多个同平台源（不同版本），各平台内部取评论数最大值，避免同平台重复累加
  list.forEach((r) => {
    const cs = (r.sources || [])
      .filter((s) => s.platform === 'qq')
      .map((s) => Number(qqMap[String(s.songid || '')]) || 0);
    if (cs.length) {
      const max = Math.max.apply(null, cs);
      if (max > 0) r.qqComments = max;
    }
  });

  // 网易云评论数逐条补（带缓存），拿到后与 QQ 值相加写回 comments
  list.forEach((r) => {
    const neIds = (r.sources || [])
      .filter((s) => s.platform === 'netease')
      .map((s) => String(s.id || ''))
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (neIds.length) {
      push(async () => {
        let neMax = 0;
        for (const id of neIds) {
          const c = await neCommentCount(id);
          if (c > neMax) neMax = c;
        }
        if (neMax > 0) r.neComments = neMax;
        applyCommentSum(sender, r);
      });
    } else {
      // 没有网易云源的条目（QQ/酷我独有）：只算 QQ 真实评论数，不对缺失平台猜数
      applyCommentSum(sender, r);
    }
    const kw = (r.sources || []).find((s) => s.platform === 'kuwo');
    if (kw) {
      push(async () => {
        const sc = await kuwo.musicInfo(kw.id);
        if (!sc) return;
        r.hotDetail = r.hotDetail || {};
        r.hotDetail.kuwo = sc;
        if (!sender.isDestroyed()) sender.send('meta:update', { key: r.key, hotDetail: r.hotDetail });
      });
    }
  });
  await pool(tasks, 8);
}

/* ---------------- 播放模式 ---------------- */
const PLAY_MODES = ['order', 'loop', 'single', 'shuffle'];
function normPlayMode(v) {
  return PLAY_MODES.indexOf(v) >= 0 ? v : 'order';
}

// 歌词延迟补偿：整数毫秒，限幅 ±1000（再大就不是延迟问题而是歌词本身对不上了）
function normLyricOffset(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(-1000, Math.min(1000, Math.round(n)));
}

// 音量归一化到 0~1，脏配置别把播放器搞成静音或爆音
function normVolume(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0.8;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

/* ---------------- 音频缓存 ----------------
   播过的音频落盘留档，下次同一首直接读本地文件：省流量、链接过期也不受影响。
   结构是「一首歌一个文件」平铺在缓存目录里，清理时只删本目录下的普通文件，
   不递归、不碰子目录，避免用户把缓存目录指到别处时误删文件。 */
function cacheRoot() {
  const custom = String(cfg.cacheDir || '').trim();
  return custom || path.join(app.getPath('userData'), 'audio-cache');
}
const CACHE_EXTS = ['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.wav', '.mp4'];
function cacheKeyOf(platform, id, qv) {
  const safe = String(id).replace(/[^\w.-]/g, '_');
  return String(platform) + '_' + safe + '_' + (qv || 'auto');
}
function cacheExtOf(url) {
  const s = String(url || '');
  // B站 dash 音频地址是 .m4s（实际内容是 mp4/AAC），落盘必须写 .m4a，
  // 否则 file:// 下浏览器按扩展名猜类型，会当 mp3 解析直接不出声
  if (/\.m4s(?:\?|#|$)/i.test(s)) return '.m4a';
  const m = s.match(/\.(mp3|m4a|aac|flac|ogg|wav|mp4)(?:\?|#|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.mp3';
}
function cacheFind(platform, id, qv) {
  const base = cacheKeyOf(platform, id, qv);
  const dir = cacheRoot();
  for (const ext of CACHE_EXTS) {
    const f = path.join(dir, base + ext);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.size > 32768) return f;
    } catch (e) {}
  }
  return null;
}
const cacheInflight = new Set();
// 已判定「内容和歌名不符」的音源前缀（platform_id_）：已删掉的错音频不许再写回缓存
const cacheSkip = new Set();
const CACHE_REFERER = {
  netease: 'https://music.163.com/',
  qq: 'https://y.qq.com/',
  kuwo: 'https://www.kuwo.cn/',
  bili: 'https://www.bilibili.com/',
};
// 用原生 http(s) 下载，不依赖 fetch（各版本 Electron 的 Node 能力不一致）
function httpDownload(url, dest, referer) {
  return new Promise((resolve, reject) => {
    const go = (target, hop) => {
      const lib = String(target).startsWith('https:') ? require('https') : require('http');
      const req = lib.get(
        target,
        { headers: { 'User-Agent': UA, Referer: referer || 'https://music.163.com/' } },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && hop > 0) {
            res.resume();
            go(new URL(res.headers.location, target).toString(), hop - 1);
            return;
          }
          if (code !== 200) {
            res.resume();
            reject(new Error('HTTP ' + code));
            return;
          }
          const tmp = dest + '.part';
          const ws = fs.createWriteStream(tmp);
          res.pipe(ws);
          ws.on('finish', () => {
            ws.close(() => {
              try {
                fs.renameSync(tmp, dest);
                resolve(dest);
              } catch (e) {
                reject(e);
              }
            });
          });
          ws.on('error', reject);
        }
      );
      req.on('error', reject);
      req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    };
    go(url, 3);
  });
}
async function cacheDownload(platform, id, qv, url) {
  const base = cacheKeyOf(platform, id, qv);
  if (cacheInflight.has(base)) return;
  if (!/^https?:/i.test(String(url || ''))) return;
  cacheInflight.add(base);
  try {
    const dir = cacheRoot();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, base + cacheExtOf(url));
    if (!fs.existsSync(dest)) await httpDownload(url, dest, CACHE_REFERER[platform]);
    // 下载期间渲染层可能已用真实时长判定这条是错音频并删掉了它，此时别把下载结果又写回磁盘
    const skipPrefix = String(platform) + '_' + String(id).replace(/[^\w.-]/g, '_') + '_';
    if (cacheSkip.has(skipPrefix)) {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch (e) {}
    }
  } catch (e) {
    // 缓存失败不影响播放，静默放弃
  } finally {
    cacheInflight.delete(base);
  }
}
function cacheStat() {
  const dir = cacheRoot();
  let size = 0;
  let count = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.part')) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) {
          size += st.size;
          count += 1;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return { dir, size, count, enabled: !!cfg.cacheEnabled };
}
function cacheClearFiles() {
  const dir = cacheRoot();
  let freed = 0;
  let count = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile()) continue;
        fs.unlinkSync(f);
        freed += st.size;
        count += 1;
      } catch (e) {}
    }
  } catch (e) {}
  return { freed, count };
}

// 单条坏缓存清除：只删该 platform_id 名下（各音质档、各扩展名）的文件
// 用途：缓存命中后由渲染层用真实时长发现「内容和歌名不符」，把这段错音频删掉，避免下次再命中
function cacheDropOne(platform, id) {
  const dir = cacheRoot();
  const prefix = String(platform) + '_' + String(id).replace(/[^\w.-]/g, '_') + '_';
  // 拉黑这个前缀：本进程内不再让它的缓存落盘（否则删完一次下载又写回来，白折腾 30MB）
  cacheSkip.add(prefix);
  let count = 0;
  let freed = 0;
  let failed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const f = path.join(dir, name);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile()) continue;
        fs.unlinkSync(f);
        count += 1;
        freed += st.size;
      } catch (e) {
        // Windows 下正被播放器句柄打开的文件删不掉，交给下次启动兜底
        failed += 1;
      }
    }
  } catch (e) {}
  return { count, freed, failed };
}

// 启动时清掉上次删失败的坏缓存（那时文件已不再被占用）
function cacheFlushPending() {
  const list = Array.isArray(cfg.pendingCacheDrop) ? cfg.pendingCacheDrop.slice() : [];
  if (!list.length) return;
  const keep = [];
  for (const it of list) {
    if (!it || !it.platform || it.id == null) continue;
    const r = cacheDropOne(it.platform, it.id);
    if (r.failed) keep.push(it);
  }
  cfg.pendingCacheDrop = keep;
  saveCfg();
}

/* ---------------- 播放直链（多源自动切换） ---------------- */
// 取流前先看缓存，取到流后顺手存档；缓存没命中就是普通远程播放
async function resolveUrlWithCache(platform, id) {
  const qv = effQuality(platform);
  // B站直链是防盗链 + 短时效的（约两小时），边下边播容易播到一半 403，
  // 所以 B站音源统一「先下载到本地缓存，再用 file:// 播放」
  if (platform === 'bili') return resolveBiliWithCache(id);
  if (cfg.cacheEnabled) {
    const hit = cacheFind(platform, id, qv);
    if (hit) {
      return {
        url: require('url').pathToFileURL(hit).href,
        quality: qv,
        qualityLabel: QUALITY_LABEL[qv] || '',
        note: '本地缓存',
        cached: true,
      };
    }
  }
  const r = await resolveUrl(platform, id);
  if (cfg.cacheEnabled && r && r.url) cacheDownload(platform, id, qv, r.url);
  return r;
}

// B站音源专用：缓存命中直接用本地文件；没命中就先整首下载到缓存目录再返回本地地址。
// 下载失败才退回远程直链（配合 downloader 的请求头注入，多数情况也能播）。
async function resolveBiliWithCache(id) {
  const bid = String(id || '');
  if (cfg.cacheEnabled) {
    const hit = cacheFind('bili', bid, 'bili');
    if (hit) {
      return {
        url: require('url').pathToFileURL(hit).href,
        quality: 'bili',
        qualityLabel: 'B站音源',
        note: '本地缓存',
        cached: true,
      };
    }
  }
  const r = await resolveUrl('bili', bid);
  if (!r || !r.url || !cfg.cacheEnabled) return r;
  // 这个 B站源已经被时长校验判成「内容和歌名不符」：别再整首下载回来，
  // 否则等于每次点播都白下一次 8MB 再播错一次
  if (cacheSkip.has('bili_' + bid.replace(/[^\w.-]/g, '_') + '_')) return r;
  try {
    const dir = cacheRoot();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, cacheKeyOf('bili', bid, 'bili') + (r.ext || '.m4a'));
    if (!fs.existsSync(dest)) await httpDownload(r.url, dest, CACHE_REFERER.bili);
    const st = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (st && st.size > 32768) {
      return {
        url: require('url').pathToFileURL(dest).href,
        quality: 'bili',
        qualityLabel: 'B站音源',
        note: '已下载到本地后播放',
        cached: true,
      };
    }
  } catch (e) {
    if (process.env.BBM_DEBUG) console.log('[bbm] bili 下载失败，退回远程直链:', e.message);
  }
  return r;
}

async function resolveUrl(platform, id) {
  // 按设置页的音质档位取流；auto 时未登录走酷我 128k，登录后走所在平台会员音质
  const qv = effQuality(platform);
  if (platform === 'netease') return netease.getUrl(id, cfg.neteaseCookie, NET_BR[qv] || 320000);
  if (platform === 'kuwo') {
    return kuwo.getUrl(id, '', durationCache.get('kuwo:' + id) || 0, qv);
  }
  if (platform === 'qq') {
    const r = await qq.getUrl(id, cfg.qqCookie, qv);
    if (r && r.url) return { url: r.url, quality: r.quality, qualityLabel: r.qualityLabel, note: r.note };
    return {
      url: null,
      // 只陈述接口事实，不再替用户判断「是不是没会员」——之前就是这句错文案把会员权益问题说反了
      reason:
        (r && r.reason) ||
        (cfg.qqCookie ? 'QQ 音乐没给可用音源（可能已下架，或 Cookie 已失效）' : 'QQ 音乐未登录，取不到音源'),
    };
  }
  if (platform === 'bili') {
    const r = await bili.getUrl(id);
    if (r && r.url) {
      return {
        url: r.url,
        ext: r.ext || '.m4a',
        quality: 'bili',
        qualityLabel: r.qualityLabel || 'B站音源',
        note: r.note || '',
      };
    }
    return { url: null, reason: (r && r.reason) || 'B站音源取流失败，已跳过' };
  }
  return { url: null, reason: '未知平台' };
}

/* ---------------- 跨平台补源 ----------------
   导入的歌单里只带导入平台的源，遇到 VIP / 版权下架就一首首都播不了。
   这里按「歌名 + 歌手 + 版本标签 + 时长」去三个平台反查同一首歌，
   逐个真去取一次直链，能取到才算替代源，挂回原条目（歌单里的歌一首都不删，
   只是多了可播音源）。找不到同名同版本的就如实返回空，绝不拿伴奏/live 顶替。 */
async function findSources(payload) {
  const p = payload || {};
  const name = String(p.name || '').trim();
  const artists = String(p.artists || '').trim();
  const album = String(p.album || '');
  if (!name) return { ok: false, sources: [], reason: '缺少歌名，无法反查' };
  const first = artists.split(/[\/、,&]/)[0].trim();
  const kw = (name + ' ' + first).trim();
  const wantName = strictNorm(name);
  // 版本标签必须与原曲一致：用伴奏/翻唱/live 顶替原版，比播不出来更糟
  const wantVer = versionTag(name + ' ' + album);
  const wantDur = Number(p.duration) || 0;
  const exclude = new Set(
    (Array.isArray(p.exclude) ? p.exclude : []).map((s) => String(s.platform) + ':' + String(s.id))
  );

  const searches = await Promise.all([
    netease.search(kw, 15, cfg.neteaseCookie).catch(() => []),
    qq.search(kw, 15, cfg.qqCookie).catch(() => []),
    kuwo.search(kw, 15).catch(() => []),
  ]);

  const cands = [];
  const seen = new Set();
  for (const list of searches) {
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || it.id === undefined || it.id === null || String(it.id) === '') continue;
      const k = String(it.platform) + ':' + String(it.id);
      if (seen.has(k) || exclude.has(k)) continue;
      if (strictNorm(it.name) !== wantName) continue;
      if (versionTag(it.name + ' ' + (it.album || '')) !== wantVer) continue;
      const dur = Number(it.duration) || 0;
      // 短于 45 秒的多是铃声/试听片段，不是完整歌
      if (dur && dur < 45000) continue;
      // 时长容差原来放到 12%（342 秒的歌能容忍 36 秒误差），结果把网易云那首同名翻唱
      // 「以父之名 / 吉克曲布 / 306s」当成了周杰伦原唱的替代源，点开播出来完全是另一首歌。
      // 收紧到 4%（最多 4 秒），同名但时长明显不同的一律不要。
      if (wantDur && dur && Math.abs(dur - wantDur) > Math.max(4000, wantDur * 0.04)) continue;
      // 歌手必须是同一个人/组合：这是判断"同名不同歌"最硬的一条。
      // 网易云没有周杰伦版权，搜「以父之名」回来的全是翻唱，只靠歌名+版本+时长根本拦不住。
      // 用严格相等而不是双向 includes：平台上有大量「周杰伦♚」「周杰伦音乐台」这类冒充/搬运账号，
      // 用 includes 会把它们当成周杰伦本人，播出来又是另一首歌。
      const ni = strictNorm(first);
      const artHit =
        !ni ||
        String(it.artists || '')
          .split(/[\/、,&]/)
          .some((a) => strictNorm(a) === ni);
      if (!artHit) continue;
      // 酷我取链要靠这里的时长识别"10 秒试听片段"，先写进缓存
      if (dur) durationCache.set(k, dur);
      seen.add(k);
      cands.push({
        platform: String(it.platform),
        id: String(it.id),
        duration: dur,
        name: it.name || name,
        platformRank: Number(it.platformRank) || 90,
        artHit,
      });
    }
  }
  // 三个正规平台都没有同名同版本时（VIP 专享 / 版权下架），去 B站投稿里找同一首歌兜底：
  // 免费、不用会员。B站是用户投稿，翻唱/伴奏/整专拼长版都有，
  // 筛选（歌名+歌手+时长+排除翻唱）全在 apis/bili.js 的 pick() 里，挑不准宁可返回空。
  let biliHit = null;
  try {
    biliHit = await bili.findBest({ name, artists, duration: wantDur });
  } catch (e) {
    biliHit = null;
    if (process.env.BBM_DEBUG) console.log('[bbm] B站兜底查找失败:', e.message);
  }
  if (!cands.length && !biliHit) {
    return { ok: false, sources: [], reason: '其他平台和 B站 都没有同名同版本的曲目' };
  }

  // 歌手对得上的、时长更接近原曲的排前面
  cands.sort((a, b) => {
    if (!!a.artHit !== !!b.artHit) return a.artHit ? -1 : 1;
    const da = wantDur ? Math.abs((a.duration || 0) - wantDur) : 0;
    const db = wantDur ? Math.abs((b.duration || 0) - wantDur) : 0;
    if (da !== db) return da - db;
    return (a.platformRank || 0) - (b.platformRank || 0);
  });
  const keep = cands.slice(0, 6);
  // B站兜底排在三平台之后：正版平台能取到就不用 B站，避免用户听到二压/翻录音轨
  if (biliHit) {
    keep.push({
      platform: 'bili',
      id: biliHit.id,
      duration: biliHit.duration || 0,
      name: biliHit.title || name,
      platformRank: 90,
      bili: 1,
    });
  }

  // 候选逐个真取一次链：挂一个取不到地址的源，等于让用户多点一次失败
  let hit = null;
  const tried = [];
  // 验证失败过的候选不进后备列表（比如酷我只给 11 秒试听片段），免得播放时白试一轮
  const bad = new Set();
  for (let i = 0; i < keep.length && !hit; i += 3) {
    const batch = keep.slice(i, i + 3);
    const rs = await Promise.all(
      batch.map(async (c) => {
        try {
          return { c, r: (await resolveUrl(c.platform, c.id)) || null };
        } catch (e) {
          return { c, r: { url: null, reason: e.message || '请求异常' } };
        }
      })
    );
    for (const x of rs) {
      tried.push({
        platform: x.c.platform,
        ok: !!(x.r && x.r.url),
        reason: (x.r && x.r.reason) || '',
      });
      if (x.r && x.r.url) {
        if (!hit) hit = x.c;
      } else {
        bad.add(x.c.platform + ':' + x.c.id);
      }
    }
  }
  if (!hit) return { ok: false, sources: [], tried, reason: '其他平台也取不到可用音源' };

  const toSrc = (c) => ({
    platform: c.platform,
    id: c.id,
    duration: c.duration || 0,
    name: c.name || name,
    platformRank: c.platformRank || 90,
    alt: 1,
    bili: c.bili ? 1 : 0,
  });
  // 验证通过的那条排最前，其余候选当后备带上（取不到地址的已进 bad，不会再挂上去）
  const sources = [toSrc(hit)];
  for (const c of keep) {
    if (c === hit) continue;
    if (bad.has(c.platform + ':' + c.id)) continue;
    // 酷我未验证过的一律不挂：它给 11 秒试听片段的概率很高，挂上去只会播十秒就断
    if (c.platform === 'kuwo') continue;
    if (sources.some((s) => s.platform === c.platform)) continue;
    sources.push(toSrc(c));
    if (sources.length >= 3) break;
  }
  return { ok: true, sources, tried, hit: hit.platform };
}

/* ---------------- 登录窗口 ---------------- */
function openLogin(platform) {
  return new Promise((resolve) => {
    const target = platform === 'netease' ? 'https://music.163.com/#/login' : 'https://y.qq.com/';
    const domain = platform === 'netease' ? '.music.163.com' : '.qq.com';
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      title: '登录 ' + (platform === 'netease' ? '网易云音乐' : 'QQ音乐'),
      autoHideMenuBar: true,
      parent: mainWindow,
      webPreferences: { partition: 'persist:' + platform },
    });
    win.loadURL(target);

    let done = false;
    const check = async () => {
      if (done) return;
      try {
        const cookies = await win.webContents.session.cookies.get({ domain });
        const pick = (name) => {
          const c = cookies.find((x) => x.name === name);
          return c ? c.value : '';
        };
        if (platform === 'netease' && pick('MUSIC_U')) {
          done = true;
          cfg.neteaseCookie = pick('MUSIC_U');
          saveCfg();
          finish(true);
        } else if (platform === 'qq' && pick('qm_keyst')) {
          done = true;
          cfg.qqCookie = 'uin=' + pick('uin') + '; qm_keyst=' + pick('qm_keyst');
          saveCfg();
          finish(true);
        }
      } catch (e) {
        /* 忽略单次读取失败 */
      }
    };
    const timer = setInterval(check, 1500);
    const finish = (ok) => {
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve({ ok, platform });
    };
    win.on('closed', () => {
      clearInterval(timer);
      if (!done) resolve({ ok: false, platform, cancelled: true });
    });
  });
}

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 660,
    backgroundColor: '#fff8f2',
    title: 'BBMusic',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    // 自绘顶部栏：让系统窗口按钮也走白色系，与底部播放条统一
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#8a7361',
      height: 54,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 关闭行为：默认收进托盘继续放歌，用户也可以在设置里改成直接退出
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    if ((cfg.closeAction || 'tray') === 'tray') {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        try {
          tray.displayBalloon &&
            tray.displayBalloon({ title: 'BBMusic', content: '已最小化到托盘，音乐继续播放' });
        } catch (err) {
          /* 部分系统不支持气泡提示 */
        }
      }
    } else {
      // 直接退出模式下顺手关掉桌面歌词，否则它会拖着进程不退出
      destroyLyricWindow();
    }
  });
}

/* ---------------- 桌面歌词窗口 ---------------- */
const LYRIC_WIN_W = 1000;
const LYRIC_WIN_H = 148;

function lyricVisible() {
  return !!(lyricWin && !lyricWin.isDestroyed());
}

function createLyricWindow() {
  if (lyricVisible()) {
    lyricWin.showInactive();
    return lyricWin;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(LYRIC_WIN_W, Math.max(560, area.width - 160));
  const height = LYRIC_WIN_H;
  const saved = cfg.lyricBounds || {};
  let x = Number.isFinite(saved.x) ? saved.x : Math.round(area.x + (area.width - width) / 2);
  let y = Number.isFinite(saved.y) ? saved.y : Math.round(area.y + area.height - height - 90);
  // 上次可能停在副屏，副屏拔掉后要拉回主屏，避免窗口飘到看不见的地方
  const displays = screen.getAllDisplays();
  const inSomeDisplay = (v, axis) =>
    displays.some((d) => {
      const start = axis === 'x' ? d.workArea.x : d.workArea.y;
      const size = axis === 'x' ? d.workArea.width : d.workArea.height;
      return v >= start - 60 && v <= start + size - 60;
    });
  if (!inSomeDisplay(x, 'x')) x = Math.round(area.x + (area.width - width) / 2);
  if (!inSomeDisplay(y, 'y')) y = Math.round(area.y + area.height - height - 90);

  lyricWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'BBMusic 桌面歌词',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口失焦时也要继续推进逐字进度
      backgroundThrottling: false,
    },
  });
  // screen-saver 层级：压在其他置顶窗口之上，但不抢焦点
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  lyricWin.loadFile(path.join(__dirname, 'renderer', 'lyric.html'));

  lyricWin.webContents.on('did-finish-load', () => {
    if (lastLyricPayload && lyricVisible()) lyricWin.webContents.send('lyric:state', lastLyricPayload);
    if (lyricVisible()) lyricWin.webContents.send('lyric:font', normLyricFont(cfg.lyricFont));
    // 歌词颜色主题跟着配置走，新开的窗口不用等用户再选一次
    if (lyricVisible()) lyricWin.webContents.send('lyric:color', normLyricColor(cfg.lyricColor));
  });
  lyricWin.once('ready-to-show', () => {
    if (!lyricVisible()) return;
    lyricWin.showInactive();
    // 上次锁成穿透的话，新窗口也要接着穿透，不然一开就挡住下面的窗口
    if (lyricLocked) applyLyricLock(true);
    // 字号要等页面起来再推，不然 CSS 变量还没地方挂
    try {
      lyricWin.webContents.send('lyric:font', normLyricFont(cfg.lyricFont));
    } catch (e) {
      /* 页面还没就绪就等下面 did-finish-load 补推 */
    }
    hookLyricDblclick();
  });
  lyricWin.on('moved', () => {
    if (!lyricVisible()) return;
    const nb = lyricWin.getBounds();
    cfg.lyricBounds = { x: nb.x, y: nb.y };
    // 渲染层拖动会连续触发 moved，攒一小会儿再落盘，别每帧写配置
    clearTimeout(lyricMoveSaveTimer);
    lyricMoveSaveTimer = setTimeout(() => {
      if (lyricVisible()) saveCfg();
    }, 300);
  });
  lyricWin.on('closed', () => {
    lyricWin = null;
    notifyLyricVisibility();
  });
  notifyLyricVisibility();
  return lyricWin;
}

function destroyLyricWindow() {
  const w = lyricWin;
  lyricWin = null;
  if (w && !w.isDestroyed()) w.close();
  notifyLyricVisibility();
}

function notifyLyricVisibility() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyric:visibility', lyricVisible());
    }
  } catch (e) {
    /* 主窗口正在销毁时忽略 */
  }
  if (tray) {
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch (e) {
      /* 菜单刷新失败不影响歌词窗口 */
    }
  }
}

function toggleLyricWindow(force) {
  if (force === true) createLyricWindow();
  else if (force === false) destroyLyricWindow();
  else if (lyricVisible()) destroyLyricWindow();
  else createLyricWindow();
  return { visible: lyricVisible() };
}

// 注册桌面歌词解锁快捷键：逐个候选试，第一个成功的生效
// globalShortcut.register 被占用时只返回 false 不抛错，所以必须看返回值
function registerLyricHotkey() {
  const tried = [];
  for (const item of LYRIC_HOTKEY_CANDIDATES) {
    let ok = false;
    try {
      ok = globalShortcut.register(item.accel, () => {
        if (lyricVisible()) applyLyricLock(!lyricLocked);
      });
    } catch (e) {
      ok = false;
    }
    tried.push(`${item.label}=${ok ? 'OK' : 'FAIL'}`);
    if (ok) {
      lyricHotkeyLabel = item.label;
      break;
    }
  }
  if (!lyricHotkeyLabel) lyricHotkeyLabel = '';
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'hotkey.log'),
      `[${new Date().toISOString()}] ${tried.join(' | ')} => 生效: ${lyricHotkeyLabel || '无（仅托盘菜单）'}\n`,
      'utf8'
    );
  } catch (e) {
    /* 日志失败不影响功能 */
  }
  return lyricHotkeyLabel;
}

// 给界面文案用的键位描述
function lyricHotkeyText() {
  return lyricHotkeyLabel || '托盘菜单';
}

// 锁定 = 鼠标穿透，桌面歌词变成纯装饰层，不挡下面的操作
function applyLyricLock(locked) {
  lyricLocked = !!locked;
  if (lyricVisible()) {
    lyricWin.setIgnoreMouseEvents(lyricLocked, { forward: true });
    try {
      lyricWin.webContents.send('lyric:lock', lyricLocked);
    } catch (e) {
      /* 窗口还没加载完就跳过 */
    }
  }
  if (tray) {
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch (e) {
      /* 忽略菜单刷新失败 */
    }
  }
  return lyricLocked;
}

// 拖动歌词窗口：16ms 跟一次光标，位移直接加到起始位置上，
// 渲染层的 screenX/Y 在不同缩放下口径不一致，交给主进程算最稳
function startLyricDrag() {
  if (!lyricVisible() || lyricLocked) return false;
  if (lyricDrag) endLyricDrag();
  const c = screen.getCursorScreenPoint();
  const b = lyricWin.getBounds();
  const d = { cx: c.x, cy: c.y, bx: b.x, by: b.y, timer: 0 };
  d.timer = setInterval(() => {
    if (!d || !lyricVisible() || lyricLocked) {
      endLyricDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    const nx = Math.round(d.bx + (p.x - d.cx));
    const ny = Math.round(d.by + (p.y - d.cy));
    const cur = lyricWin.getBounds();
    if (cur.x !== nx || cur.y !== ny) lyricWin.setPosition(nx, ny);
  }, 16);
  lyricDrag = d;
  return true;
}

function endLyricDrag() {
  if (!lyricDrag) return false;
  clearInterval(lyricDrag.timer);
  lyricDrag = null;
  // setPosition 是程序移动，Windows 下不一定派发 moved 事件，这里手动落盘
  if (lyricVisible()) {
    const b = lyricWin.getBounds();
    cfg.lyricBounds = { x: b.x, y: b.y };
    saveCfg();
  }
  return true;
}

// 双击歌词区域 == 一键锁定（鼠标穿透）
function hookLyricDblclick() {
  if (!lyricVisible()) return false;
  try {
    return lyricWin.hookWindowMessage(0x0203, () => {
      // 只在解锁态响应：锁定后已经鼠标穿透，收不到任何鼠标消息
      if (!lyricLocked) {
        applyLyricLock(true);
        try {
          if (tray) {
            tray.displayBalloon({
              title: '桌面歌词已锁定',
              content: `已开启鼠标穿透，${lyricHotkeyText()} 或托盘菜单可解锁`,
            });
          }
        } catch (e) {
          /* 气泡失败不影响锁定 */
        }
      }
    });
  } catch (e) {
    return false;
  }
}

// 字号改动：记住 + 立即推给歌词窗口（用 CSS 变量，不重排窗口）
function applyLyricFont(size) {
  cfg.lyricFont = normLyricFont(size === undefined ? cfg.lyricFont : size);
  saveCfg();
  if (lyricVisible()) {
    try {
      lyricWin.webContents.send('lyric:font', cfg.lyricFont);
    } catch (e) {
      /* 窗口正在销毁时忽略 */
    }
  }
  if (tray) {
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch (e) {
      /* 忽略菜单刷新失败 */
    }
  }
  return cfg.lyricFont;
}

// 歌词被拖到奇怪的地方时一键拉回主屏底部居中
function resetLyricPosition() {
  if (!lyricVisible()) return { visible: false };
  const area = screen.getPrimaryDisplay().workArea;
  const b = lyricWin.getBounds();
  const x = Math.round(area.x + (area.width - b.width) / 2);
  const y = Math.round(area.y + area.height - b.height - 90);
  lyricWin.setBounds({ x, y, width: b.width, height: b.height });
  cfg.lyricBounds = { x, y };
  saveCfg();
  return { visible: true, x, y };
}

/* ---------------- 自动检测更新（electron-updater） ----------------
   只在安装版生效：源码直跑没有 app-update.yml，检查必然失败，这里直接给友好提示。
   流程：启动后静默查一次 → 发现有新版推给界面 → 用户点下载 → 下完提示重启安装。 */
const UPDATE_RELEASE_URL = 'https://github.com/March886/bbmusic/releases/latest';
const updateState = {
  status: 'idle', // idle | dev | checking | available | not-available | downloading | downloaded | error
  info: null,
  progress: 0,
  error: '',
  manual: false,
  lastCheckAt: 0,
};
let updater = null;
let updaterReady = false;

function updaterLog(msg) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'update.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch (e) {
    /* 日志写不进去不影响主流程 */
  }
}

// 把 electron-updater 的原始报错翻成人话，别把 ERR_CONNECTION_REFUSED 甩给用户
function friendlyUpdateError(e) {
  const raw = (e && (e.message || String(e))) || '';
  const low = raw.toLowerCase();
  if (
    low.includes('err_connection') || low.includes('err_name') || low.includes('enotfound') ||
    low.includes('etimedout') || low.includes('econnreset') || low.includes('econnrefused') ||
    low.includes('network') || low.includes('wsarecv') || low.includes('socket') || low.includes('timeout')
  ) {
    return '连不上更新服务器（GitHub 访问受限），挂上代理后再试，或直接到发布页手动下载';
  }
  if (low.includes('no published versions') || low.includes('404') || low.includes('cannot find')) {
    return '发布页还没上传更新文件，请到发布页手动下载安装';
  }
  if (low.includes('sha512') || low.includes('checksum') || low.includes('integrity')) {
    return '安装包校验没通过，请到发布页重新下载';
  }
  if (low.includes('eacces') || low.includes('eperm') || low.includes('ebusy') || low.includes('ebusy')) {
    return '更新文件写入失败（文件可能被占用），重启应用后再试';
  }
  return raw || '未知错误';
}

function pickReleaseNotes(info) {
  const n = info && info.releaseNotes;
  if (!n) return '';
  let text = '';
  if (typeof n === 'string') text = n;
  else if (Array.isArray(n)) text = n.map((x) => (x && x.note) || '').join('\n');
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 600);
}

function packUpdateInfo(info) {
  if (!info) return null;
  return {
    version: info.version || '',
    releaseDate: info.releaseDate || '',
    releaseName: info.releaseName || '',
    notes: pickReleaseNotes(info),
  };
}

function updateSnapshot(extra) {
  return Object.assign(
    {
      status: updateState.status,
      info: updateState.info,
      progress: updateState.progress,
      error: updateState.error,
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
    },
    extra || {}
  );
}

// 状态一动就推给界面；窗口缩在托盘里没人看时，用托盘气泡顶一下
function pushUpdateState(balloon) {
  const payload = updateSnapshot();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:event', payload);
  } catch (e) {
    /* 窗口正在销毁，忽略 */
  }
  if (balloon && tray && tray.displayBalloon) {
    try {
      tray.displayBalloon(balloon);
    } catch (e) {
      /* 部分系统不支持气泡 */
    }
  }
  return payload;
}

function initUpdater() {
  if (updaterReady) return updater;
  updaterReady = true;
  if (!app.isPackaged) {
    updateState.status = 'dev';
    updaterLog('源码运行（未安装），跳过 electron-updater 初始化');
    return null;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
  } catch (e) {
    updateState.status = 'error';
    updateState.error = '更新组件加载失败：' + e.message;
    updaterLog('require electron-updater 失败: ' + (e && e.stack));
    return null;
  }
  updater.logger = {
    info: (m) => updaterLog('[info] ' + m),
    warn: (m) => updaterLog('[warn] ' + m),
    error: (m) => updaterLog('[error] ' + m),
    debug: (m) => updaterLog('[debug] ' + m),
  };
  // 先问再下：不替用户偷跑流量
  updater.autoDownload = false;
  // 退出时顺手把已下好的包装上
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = '';
    pushUpdateState();
  });
  updater.on('update-available', (info) => {
    updateState.status = 'available';
    updateState.info = packUpdateInfo(info);
    updateState.progress = 0;
    updateState.lastCheckAt = Date.now();
    const ver = (updateState.info && updateState.info.version) || '新版本';
    // 用户自己点的检查，界面里已有反馈，不用再弹气泡
    pushUpdateState(
      updateState.manual ? null : { title: 'BBMusic 有新版本', content: `发现 ${ver}，可在设置页下载安装` }
    );
  });
  updater.on('update-not-available', () => {
    updateState.status = 'not-available';
    updateState.progress = 0;
    updateState.lastCheckAt = Date.now();
    pushUpdateState();
  });
  updater.on('download-progress', (p) => {
    updateState.status = 'downloading';
    updateState.progress = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    pushUpdateState();
  });
  updater.on('update-downloaded', (info) => {
    updateState.status = 'downloaded';
    updateState.info = packUpdateInfo(info) || updateState.info;
    updateState.progress = 100;
    pushUpdateState({ title: 'BBMusic 更新已就绪', content: '重启应用即可完成安装' });
  });
  updater.on('error', (e) => {
    updateState.status = 'error';
    updateState.error = friendlyUpdateError(e);
    updaterLog('[error] 原始报错: ' + ((e && e.stack) || e));
    pushUpdateState();
  });
  return updater;
}

// 检查更新：等一个确定结果再回给界面，按钮点下去不能没反应
function checkUpdates(manual) {
  const u = initUpdater();
  updateState.manual = !!manual;
  if (!u) {
    return Promise.resolve(updateSnapshot({ ok: false }));
  }
  updateState.error = '';
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      u.removeListener('update-available', onAvail);
      u.removeListener('update-not-available', onNone);
      u.removeListener('error', onErr);
      resolve(res);
    };
    const onAvail = () => finish(updateSnapshot({ ok: true }));
    const onNone = () => finish(updateSnapshot({ ok: true }));
    const onErr = () => finish(updateSnapshot({ ok: false }));
    u.once('update-available', onAvail);
    u.once('update-not-available', onNone);
    u.once('error', onErr);
    timer = setTimeout(() => {
      updateState.status = 'error';
      updateState.error = '检查更新超时，请检查网络或代理后重试';
      finish(updateSnapshot({ ok: false }));
      pushUpdateState();
    }, 20000);
    Promise.resolve()
      .then(() => u.checkForUpdates())
      .catch((e) => {
        updateState.status = 'error';
        updateState.error = friendlyUpdateError(e);
        updaterLog('[error] checkForUpdates: ' + ((e && e.stack) || e));
        finish(updateSnapshot({ ok: false }));
      });
  });
}

async function downloadUpdate() {
  const u = initUpdater();
  if (!u) return updateSnapshot({ ok: false });
  if (updateState.status === 'downloaded') return updateSnapshot({ ok: true });
  if (updateState.status === 'downloading') return updateSnapshot({ ok: true });
  try {
    updateState.status = 'downloading';
    updateState.progress = 0;
    updateState.error = '';
    pushUpdateState();
    await u.downloadUpdate();
    return updateSnapshot({ ok: true });
  } catch (e) {
    updateState.status = 'error';
    updateState.error = friendlyUpdateError(e);
    updaterLog('[error] downloadUpdate: ' + ((e && e.stack) || e));
    return pushUpdateState({ ok: false });
  }
}

function installUpdate() {
  if (!updater || updateState.status !== 'downloaded') {
    return updateSnapshot({ ok: false, error: updateState.error || '更新包还没下载完成' });
  }
  // 先把退出拦截摘掉，否则"最小化到托盘"会把这次退出吃掉
  app.isQuitting = true;
  setTimeout(() => {
    try {
      updater.quitAndInstall(false, true);
    } catch (e) {
      updateState.status = 'error';
      updateState.error = '安装没能启动，请到发布页手动下载安装包';
      updaterLog('[error] quitAndInstall: ' + ((e && e.stack) || e));
      pushUpdateState();
    }
  }, 150);
  return updateSnapshot({ ok: true });
}

// 托盘里的更新入口：已经下好就直接装，发现新版就开下，其余按手动检查处理
async function trayUpdateAction() {
  try {
    if (!mainWindow) createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (e) {
    /* 窗口状态异常也不该卡住检查 */
  }
  if (updateState.status === 'downloaded') {
    installUpdate();
    return;
  }
  if (updateState.status === 'available') {
    if (tray && tray.displayBalloon) {
      try {
        tray.displayBalloon({ title: 'BBMusic', content: '开始下载新版本…' });
      } catch (e) {
        /* 忽略 */
      }
    }
    downloadUpdate();
    return;
  }
  await checkUpdates(true);
}

ipcMain.handle('update:check', () => checkUpdates(true));
ipcMain.handle('update:download', () => downloadUpdate());
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('update:state', () => updateSnapshot({ ok: true }));
ipcMain.handle('update:open-release', () => {
  shell.openExternal(UPDATE_RELEASE_URL);
  return { ok: true };
});

/* ---------------- 托盘 ---------------- */
function trayIconPath() {
  const ico = path.join(__dirname, 'icon.ico');
  const png = path.join(__dirname, 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  return fs.existsSync(png) ? png : ico;
}

function buildTrayMenu() {
  const on = lyricVisible();
  const curFont = normLyricFont(cfg.lyricFont);
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (!mainWindow) return createWindow();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: '桌面歌词',
      type: 'checkbox',
      checked: on,
      click: () => toggleLyricWindow(),
    },
    {
      label: lyricLocked
        ? `解锁桌面歌词（当前鼠标穿透，${lyricHotkeyText()}）`
        : `锁定桌面歌词（鼠标穿透，${lyricHotkeyText()} 解锁）`,
      enabled: on,
      click: () => applyLyricLock(!lyricLocked),
    },
    {
      label: '桌面歌词字号',
      enabled: on,
      submenu: [
        { label: '小', type: 'radio', checked: curFont === 26, click: () => applyLyricFont(26) },
        { label: '标准', type: 'radio', checked: curFont === 34, click: () => applyLyricFont(34) },
        { label: '大', type: 'radio', checked: curFont === 42, click: () => applyLyricFont(42) },
        { label: '特大', type: 'radio', checked: curFont === 52, click: () => applyLyricFont(52) },
      ],
    },
    {
      label: '桌面歌词归位（底部居中）',
      enabled: on,
      click: () => resetLyricPosition(),
    },
    { type: 'separator' },
    {
      label: (function () {
        if (updateState.status === 'downloaded') return '重启安装新版本';
        if (updateState.status === 'available')
          return '下载新版本 ' + ((updateState.info && updateState.info.version) || '');
        if (updateState.status === 'downloading') return '正在下载更新 ' + updateState.progress + '%';
        return '检查更新';
      })(),
      click: () => trayUpdateAction(),
    },
    { type: 'separator' },
    {
      label: '退出 BBMusic',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    tray.setToolTip('BBMusic');
    tray.setContextMenu(buildTrayMenu());
    // 菜单里有「桌面歌词」勾选项，每次右键前重建一次，保证勾选状态与窗口真实状态一致
    tray.on('right-click', () => {
      try {
        tray.popUpContextMenu(buildTrayMenu());
      } catch (e) {
        /* 弹出失败就沿用旧菜单 */
      }
    });
    tray.on('click', () => {
      if (!mainWindow) return createWindow();
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    /* 托盘创建失败不影响主流程 */
  }
}

app.whenReady().then(() => {
  loadCfg();

  // 上次运行时因文件被播放器占用而没删掉的坏缓存（内容与歌名不符），启动时补删
  try {
    cacheFlushPending();
  } catch (e) {}

  // 音频直链防盗链：补 Referer / UA
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.music.126.net/*',
        '*://*.qqmusic.qq.com/*',
        '*://*.stream.qqmusic.qq.com/*',
        // B站音频 CDN：mcdn / upos 域名会变，.com / .cn / .net 都有，漏一个就 403
        '*://*.bilivideo.com/*',
        '*://*.bilivideo.cn/*',
        '*://*.bilivideo.net/*',
        '*://*.hdslb.com/*',
      ],
    },
    (details, cb) => {
      const u = details.url || '';
      const ref = u.includes('bilivideo')
        ? 'https://www.bilibili.com/'
        : u.includes('qqmusic')
          ? 'https://y.qq.com/'
          : 'https://music.163.com/';
      details.requestHeaders['Referer'] = ref;
      details.requestHeaders['User-Agent'] = UA;
      cb({ requestHeaders: details.requestHeaders });
    }
  );

  ipcMain.handle('search', async (e, keyword, opts) => {
    const o = opts || {};
    const mode = o.sortMode || cfg.sortMode || 'comments';
    const res = await aggregateSearch(keyword, o);
    // 按评论总数排序必须先补全评论数再重排，否则整列都是空值根本排不出意义
    if (mode === 'comments') {
      await enrichMeta(e.sender, res.list);
      sortResultList(res.list, keyword, 'comments');
      return res;
    }
    // 其他排序不阻塞返回，热度/评论数补到了再推给界面
    enrichMeta(e.sender, res.list.slice(0, 48));
    return res;
  });
  ipcMain.handle('get-url', async (e, platform, id) => resolveUrlWithCache(platform, id));
  /* ---------- 桌面歌词颜色：窗口启动时主动来问一次 ---------- */
  ipcMain.handle('lyric-window:color', () => normLyricColor(cfg.lyricColor));
  /* ---------- 缓存设置 ---------- */
  ipcMain.handle('cache:info', () => cacheStat());
  ipcMain.handle('cache:pick-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择缓存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return Object.assign({ ok: false }, cacheStat());
    cfg.cacheDir = r.filePaths[0];
    saveCfg();
    return Object.assign({ ok: true }, cacheStat());
  });
  ipcMain.handle('cache:clear', () => {
    const r = cacheClearFiles();
    return Object.assign({ ok: true, freed: r.freed, cleared: r.count }, cacheStat());
  });
  ipcMain.handle('cache:set-enabled', (e, on) => {
    cfg.cacheEnabled = !!on;
    saveCfg();
    return Object.assign({ ok: true }, cacheStat());
  });
  // 渲染层用真实音频时长发现某条缓存内容和歌名不符时，只清掉这一条
  ipcMain.handle('cache:drop-one', (e, platform, id) => {
    const r = cacheDropOne(platform, id);
    if (r.failed) {
      const list = Array.isArray(cfg.pendingCacheDrop) ? cfg.pendingCacheDrop : [];
      if (!list.some((x) => x && x.platform === platform && String(x.id) === String(id))) {
        list.push({ platform, id });
        cfg.pendingCacheDrop = list;
        saveCfg();
      }
    }
    return r;
  });
  // 当前平台不可播（VIP / 版权下架）时，去其他平台反查同一首歌的可播音源
  ipcMain.handle('song:find-sources', async (e, payload) => {
    try {
      return await findSources(payload);
    } catch (err) {
      return { ok: false, sources: [], reason: err.message || '反查失败' };
    }
  });
  // 歌词兜底匹配：标题必须一致，歌手命中加权，避免拿到同名片段的歌词
  function pickLyricMatch(list, name, artists) {
    const t = norm(name);
    const firstArtist = norm(String(artists || '').split(/[/、,&]|feat\.?/i)[0]);
    let best = null;
    let bestScore = -1;
    for (const it of list || []) {
      const nt = norm(it.name);
      let score = 0;
      if (nt === t) score += 70;
      else if (nt.includes(t) || t.includes(nt)) score += 25;
      else continue;
      if (firstArtist && norm(it.artists).includes(firstArtist)) score += 40;
      score += Math.min(Number(it.popularity || 0), 100) / 50;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return bestScore >= 70 ? best : null;
  }

  ipcMain.handle('lyric', async (e, platform, id, name, artists) => {
    try {
      let lrc = '';
      if (platform === 'netease' && id) lrc = await netease.lyric(id).catch(() => '');
      // 非网易云曲目（QQ / 酷我）没有歌词接口，按"歌名 + 歌手"回搜网易云，仅认标题一致的候选
      if (!lrc && name) {
        const list = await netease.search((name + ' ' + (artists || '')).trim(), 10, cfg.neteaseCookie).catch(() => []);
        const hit = pickLyricMatch(list, name, artists);
        if (hit) lrc = await netease.lyric(hit.id).catch(() => '');
      }
      return { lrc: lrc || '' };
    } catch (err) {
      return { lrc: '' };
    }
  });
  // 从 QQ 音乐 / 网易云歌单分享链接导入整张歌单
  ipcMain.handle('playlist:import', async (e, link) => {
    try {
      const r = await importPlaylistFromLink(link);
      return r;
    } catch (err) {
      return { ok: false, reason: (err && err.message) || '导入失败' };
    }
  });
  // 登录态检测：force=true 忽略 24h 缓存重测（界面上的「重新检测」按钮）
  ipcMain.handle('auth:check', (e, force) => checkAuth(!!force));
  ipcMain.handle('settings:get', () => ({
    sortMode: cfg.sortMode,
    volume: normVolume(cfg.volume),
    // 歌词延迟补偿（毫秒），设置页滑杆直接读写
    lyricOffset: normLyricOffset(cfg.lyricOffset),
    preferPlatform: cfg.preferPlatform,
    closeAction: cfg.closeAction || 'tray',
    lyricFx: cfg.lyricFx || 'fade',
    lyricFont: normLyricFont(cfg.lyricFont),
    // 歌词颜色主题，主窗口与桌面歌词窗口共用
    lyricColor: normLyricColor(cfg.lyricColor),
    lyricColorTiers: Object.keys(LYRIC_COLORS).map((k) => ({ value: k, label: LYRIC_COLORS[k].label, hi: LYRIC_COLORS[k].hi })),
    // 播放模式：播放条上「上一曲」左侧那个按钮
    playMode: normPlayMode(cfg.playMode),
    playModeTiers: [
      { value: 'order', label: '顺序播放' },
      { value: 'loop', label: '列表循环' },
      { value: 'single', label: '单曲循环' },
      { value: 'shuffle', label: '随机播放' },
    ],
    cacheEnabled: !!cfg.cacheEnabled,
    // 音质：quality 是用户在设置页选的档位，qualityEff 是实际生效档位（auto 时按登录态解析）
    quality: normQuality(cfg.quality),
    qualityEff: effQuality(),
    qualityEffLabel: QUALITY_LABEL[effQuality()],
    qualityTiers: QUALITY_TIERS.map((k) => ({ value: k, label: QUALITY_LABEL[k] })),
    // 登录态：以真实检测结果为准（ok 已登录 / off 未登录或已失效 / err 这次没测出来 / unknown 待检测）
    // 以前这里写的是 !!cfg.qqCookie，cookie 过期了绿灯也照亮，界面等于在骗人
    authState: {
      netease: (cfg.authState && cfg.authState.netease) || { state: cfg.neteaseCookie ? 'unknown' : 'off' },
      qq: (cfg.authState && cfg.authState.qq) || { state: cfg.qqCookie ? 'unknown' : 'off' },
    },
    neteaseLogged: !!(cfg.authState && cfg.authState.netease && cfg.authState.netease.state === 'ok'),
    qqLogged: !!(cfg.authState && cfg.authState.qq && cfg.authState.qq.state === 'ok'),
    // 我的歌单与播放历史（界面侧全量读写，改动后整体回存）
    playlists: normPlaylists(cfg.playlists),
    history: normHistory(cfg.history),
    // 断点续播快照：上次关闭时在放哪首、放到第几秒、属于哪个歌单
    resume: normResume(cfg.resume),
  }));
  ipcMain.handle('settings:save', (e, patch) => {
    // 只接受界面真正用到的设置项，别让任意字段塞进配置文件
    const allow = [
      'sortMode',
      'preferPlatform',
      'volume',
      'closeAction',
      'lyricFx',
      'lyricFont',
      'quality',
      'lyricColor',
      'playMode',
      'lyricOffset',
      'cacheEnabled',
      'playlists',
      'history',
      // 断点续播快照（界面在播放中/关闭前写入）
      'resume',
    ];
    const p = patch || {};
    for (const k of allow) {
      if (p[k] !== undefined) cfg[k] = p[k];
    }
    if (cfg.closeAction !== 'quit') cfg.closeAction = 'tray';
    cfg.quality = normQuality(cfg.quality);
    cfg.lyricColor = normLyricColor(cfg.lyricColor);
    cfg.playMode = normPlayMode(cfg.playMode);
    cfg.lyricOffset = normLyricOffset(cfg.lyricOffset);
    cfg.volume = normVolume(cfg.volume);
    // 歌单/历史由界面整体回存，这里统一过一遍结构校验，脏数据不进配置文件
    if (p.playlists !== undefined) cfg.playlists = normPlaylists(cfg.playlists);
    if (p.history !== undefined) cfg.history = normHistory(cfg.history);
    // 续播快照同理：传 null 表示主动清空（比如界面点了"从头开始"）
    if (p.resume !== undefined) cfg.resume = normResume(cfg.resume);
    saveCfg();
    // 歌词效果改了要同步给桌面歌词窗口，两边保持一致
    if (p.lyricFx !== undefined && lastLyricPayload) {
      lastLyricPayload = Object.assign({}, lastLyricPayload, { fx: cfg.lyricFx });
      if (lyricVisible()) lyricWin.webContents.send('lyric:state', lastLyricPayload);
    }
    // 歌词颜色同理，换色立刻生效
    if (p.lyricColor !== undefined) {
      if (lastLyricPayload) {
        lastLyricPayload = Object.assign({}, lastLyricPayload, { color: cfg.lyricColor });
        if (lyricVisible()) lyricWin.webContents.send('lyric:state', lastLyricPayload);
      }
      if (lyricVisible()) lyricWin.webContents.send('lyric:color', cfg.lyricColor);
    }
    // 字号改了同样立刻生效，不用等下次开歌词窗口
    if (p.lyricFont !== undefined) applyLyricFont(cfg.lyricFont);
    return { ok: true };
  });

  /* ---------- 桌面歌词窗口 ---------- */
  ipcMain.handle('lyric-window:toggle', (e, force) => toggleLyricWindow(force));
  ipcMain.handle('lyric-window:state', () => ({ visible: lyricVisible() }));
  ipcMain.on('lyric:push', (e, payload) => {
    if (!payload) return;
    lastLyricPayload = payload;
    if (lyricVisible()) lyricWin.webContents.send('lyric:state', payload);
  });
  ipcMain.on('lyric-window:command', (e, action) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyric:command', action);
  });
  ipcMain.on('lyric-window:close-req', () => destroyLyricWindow());
  ipcMain.on('lyric-window:lock', (e, locked) => applyLyricLock(!!locked));
  ipcMain.on('lyric-window:drag-start', () => startLyricDrag());
  ipcMain.on('lyric-window:drag-end', () => endLyricDrag());
  ipcMain.handle('lyric-window:font', (e, size) => ({ ok: true, font: applyLyricFont(size) }));
  ipcMain.handle('lyric-window:reset-pos', () => resetLyricPosition());
  ipcMain.handle('login', async (e, platform) => openLogin(platform));
  ipcMain.handle('logout', (e, platform) => {
    if (platform === 'netease') {
      cfg.neteaseCookie = '';
      if (cfg.authState) delete cfg.authState.netease;
    }
    if (platform === 'qq') {
      cfg.qqCookie = '';
      if (cfg.authState) delete cfg.authState.qq;
    }
    saveCfg();
    return { ok: true };
  });
  ipcMain.handle('open-external', (e, url) => shell.openExternal(url));
  ipcMain.handle('toplist', async () => {
    try {
      const res = await netease.search('热歌', 20, cfg.neteaseCookie);
      return { list: res };
    } catch (e) {
      return { list: [], error: e.message };
    }
  });
  ipcMain.handle('lyric-window:hotkey', () => lyricHotkeyText());
  ipcMain.handle('app-info', () => ({
    name: 'BBMusic',
    version: app.getVersion(),
    author: '粑粑超人',
  }));

  createWindow();
  createTray();
  // 桌面歌词锁成鼠标穿透后，靠这个组合键在托盘之外也能解回来
  // 候选键位逐个尝试：Ctrl+Alt+L 被别的软件抢走时自动降级到备用键
  registerLyricHotkey();
  // 装好之后静默查一次更新；断网、超时都只是后台记日志，不打扰用户
  setTimeout(() => {
    checkUpdates(false);
  }, 8000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch (e) {
    /* 退出阶段忽略 */
  }
});

app.on('window-all-closed', () => {
  // 选了"最小化到托盘"时，窗口关掉只是隐藏，不该退出进程
  if ((cfg.closeAction || 'tray') === 'tray' && !app.isQuitting) return;
  if (process.platform !== 'darwin') app.quit();
});
