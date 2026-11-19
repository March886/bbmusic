// 酷我音乐 接口层 (非官方, 仅供本机使用)
// 搜索: https://www.kuwo.cn/search/searchMusicBykeyWord (需 Secret 签名头)
// 取链: https://antiserver.kuwo.cn/anti.s (返回直链文本)
//
// 关键点:
// 1) Secret 头由酷我前端算法 h(token, cookieName) 生成, token 来自 www.kuwo.cn 的 Cookie;
// 2) 正版受限曲目 anti.s 仍会返回链接, 但内容是 10 秒左右的试听片段。
//    因此取链后必须用 Range 探测文件体积估算时长, 与搜索结果的 DURATION 比对,
//    明显偏短的判为片段不采用 —— 否则界面上标 223 秒、实际响 11 秒就停。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_NAME = 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324';

let tokenCache = { token: '', ts: 0 };

// 音质档位：对应设置页"音质选择"（低 -> 高）
// 酷我免登录只给 128k，登录态/资源允许时才有 192k / 320k / 无损
const QUALITY = {
  '128': { format: 'mp3', br: '128kmp3', bps: 128000, label: '标准 128kbps' },
  '192': { format: 'mp3', br: '192kmp3', bps: 192000, label: '较高 192kbps' },
  '320': { format: 'mp3', br: '320kmp3', bps: 320000, label: '高品质 320kbps' },
  flac: { format: 'flac', br: '2000kflac', bps: 900000, label: '无损 FLAC' },
};
function q(spec) {
  return QUALITY[spec] || QUALITY['128'];
}

// 酷我前端签名算法 (来自站点自身脚本)
function h(t, e) {
  if (null == e || e.length <= 0) return null;
  let n = '';
  for (let i = 0; i < e.length; i++) n += e.charCodeAt(i).toString();
  const r = Math.floor(n.length / 5);
  const o = parseInt(
    n.charAt(r) + n.charAt(2 * r) + n.charAt(3 * r) + n.charAt(4 * r) + n.charAt(5 * r)
  );
  const l = Math.ceil(e.length / 2);
  const c = Math.pow(2, 31) - 1;
  if (o < 2) return null;
  let d = Math.round(1e9 * Math.random()) % 1e8;
  for (n += d; n.length > 10; )
    n = (parseInt(n.substring(0, 10)) + parseInt(n.substring(10, n.length))).toString();
  n = (o * n + l) % c;
  let hx = '';
  let f = '';
  for (let i = 0; i < t.length; i++) {
    hx = parseInt(t.charCodeAt(i) ^ Math.floor((n / c) * 255));
    f += hx < 16 ? '0' + hx.toString(16) : hx.toString(16);
    n = (o * n + l) % c;
  }
  d = d.toString(16);
  while (d.length < 8) d = '0' + d;
  return f + d;
}

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now - tokenCache.ts < 10 * 60 * 1000) return tokenCache.token;
  const res = await fetch('https://www.kuwo.cn/', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let token = '';
  for (const c of raw) {
    const m = new RegExp(COOKIE_NAME + '=([^;]+)').exec(c);
    if (m) token = m[1];
  }
  if (token) tokenCache = { token, ts: now };
  return token;
}

function headers(token) {
  return {
    'User-Agent': UA,
    Referer: 'https://www.kuwo.cn/',
    Accept: 'application/json, text/plain, */*',
    Cookie: COOKIE_NAME + '=' + token,
    Secret: h(token, COOKIE_NAME),
  };
}

// 搜索
async function search(keyword, limit = 30, cookie = '') {
  const token = await getToken();
  const url =
    'https://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0' +
    '&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1' +
    '&pn=0&rn=' +
    limit +
    '&all=' +
    encodeURIComponent(keyword);
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error('kuwo http ' + res.status);
  const data = await res.json();
  const list = data.abslist || [];
  return list.map((it, i) => ({
    platform: 'kuwo',
    id: String(it.MUSICRID || '').replace('MUSIC_', ''),
    name: it.NAME || it.SONGNAME || '',
    artists: it.ARTIST || '',
    album: it.ALBUM || '',
    cover: it.web_albumpic_short
      ? 'https://img1.kuwo.cn/star/albumcover/' + it.web_albumpic_short
      : '',
    duration: Number(it.DURATION || 0) * 1000,
    // 酷我搜索接口不返回播放量, 用平台原始排名换算热度
    popularity: 0,
    fee: it.PAY,
    platformRank: i,
  }));
}

// 用 Range 探测文件体积, 估算实际音频时长(秒)
// bps 必须与所取音质一致，否则估算时长会偏，误判成试听片段
async function probeSeconds(url, expect, bps = 128000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.kuwo.cn/', Range: 'bytes=0-0' },
    });
    const cr = res.headers.get('content-range') || '';
    let size = Number((cr.split('/')[1] || '').trim()) || 0;
    if (!size) size = Number(res.headers.get('content-length') || 0);
    if (!size) return { ok: true, sec: 0 };
    const sec = (size * 8) / (bps || 128000);
    if (expect && sec < expect * 0.7) return { ok: false, sec };
    return { ok: true, sec };
  } catch (e) {
    return { ok: true, sec: 0 };
  }
}

// 取播放直链
// quality: '128' | '192' | '320' | 'flac'；高音质取不到时自动回落到 128k，保证能放
async function getUrl(id, cookie = '', expectDuration = 0, quality = '128') {
  const first = await getUrlOnce(id, expectDuration, quality);
  if (first.url || quality === '128') return first;
  const fallback = await getUrlOnce(id, expectDuration, '128');
  if (fallback.url) {
    fallback.quality = '128';
    fallback.note = '酷我没有 ' + q(quality).label + ' 音源，已回落到 128kbps';
    return fallback;
  }
  return first;
}

async function getUrlOnce(id, expectDuration, quality) {
  const spec = q(quality);
  const token = await getToken();
  const url =
    'https://antiserver.kuwo.cn/anti.s?type=convert_url&br=' +
    spec.br +
    '&format=' +
    spec.format +
    '&response=url&rid=MUSIC_' +
    encodeURIComponent(id);
  let res;
  try {
    res = await fetch(url, { headers: headers(token) });
  } catch (e) {
    return { url: null, reason: '网络错误: ' + e.message };
  }
  if (!res.ok) return { url: null, reason: 'http ' + res.status };
  const text = (await res.text()).trim();
  if (!/^https?:\/\//i.test(text)) {
    return { url: null, reason: '无版权或需付费' };
  }
  // 正版受限曲目在此处返回的是试听片段, 必须拦掉
  const probe = await probeSeconds(text, expectDuration ? expectDuration / 1000 : 0, spec.bps);
  if (!probe.ok) {
    return { url: null, reason: '仅提供试听片段(约' + Math.round(probe.sec) + '秒), 已跳过' };
  }
  return { url: text, seconds: probe.sec, platform: 'kuwo', quality, qualityLabel: spec.label };
}

// 曲目热度分 score100(0-100)，搜索接口不返回，需单独查一次
async function musicInfo(id) {
  const token = await getToken();
  const res = await fetch(
    'https://www.kuwo.cn/api/www/music/musicInfo?mid=' + encodeURIComponent(id) + '&httpsStatus=1',
    { headers: headers(token) }
  );
  if (!res.ok) return 0;
  const data = await res.json();
  const d = (data && data.data) || {};
  return Number(d.score100 || 0);
}

module.exports = { search, getUrl, musicInfo };
