// B站音源兜底（非官方接口，仅供个人本地使用）
//
// 用途：QQ/网易云/酷我都拿不到音源时（会员专享、版权下架），去 B站投稿里找同一首歌的音频。
// 注意 B站的坑：同一个歌名下有翻唱、伴奏、纯音乐、整张专辑拼成的长视频、片段剪辑，
// 所以这里绝不"搜到什么就返回什么"，必须同时满足：
//   1) 标题里出现完整歌名；
//   2) 标题或 UP 主里出现歌手名（防止同名不同歌）；
//   3) 时长与原曲接近（默认容差 3.5%，最少 6 秒）；
//   4) 标题不含翻唱/伴奏/live/片段等非原版标记。
// 任一条不满足就返回空 —— 宁可播不出来，也不播成另一首歌。

const https = require('https');
const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

// wbi 签名混排表，B站前端固定值
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

// 不是原版唱的版本，一律不要（比时长校验更早拦住翻唱/伴奏）
const BAD_WORDS = [
  '翻唱', '翻自', 'cover', '翻录', '伴奏', 'instrumental', 'off vocal', '纯音乐', '钢琴', '吉他版', '古筝', '二胡',
  '教学', '教程', '舞蹈', 'dj', 'remix', 'mashup', '串烧', '片段', '试听', '铃声', '改编', '升调', '降调', '加速',
  '减速', '慢速', '0.8x', '1.2x', 'reaction', '解说', '盘点', '合集', 'karaoke', 'ktv', 'live', '现场', '演唱会',
  '音乐节', 'ai', 'suno', '口哨', '八音盒', '鼓点', '贝斯',
];

let cookie = '';
let cookieAt = 0;
let mixinKey = '';
let mixinAt = 0;

function jget(url, opt) {
  const o = opt || {};
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: Object.assign(
          { 'User-Agent': UA, Referer: REFERER, Cookie: cookie, Accept: 'application/json, text/plain, */*' },
          o.headers || {}
        ),
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          resolve(jget(new URL(res.headers.location, url).toString(), opt));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('B站返回非 JSON（HTTP ' + code + '）'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(o.timeout || 15000, () => req.destroy(new Error('B站请求超时')));
  });
}

// 没有 buvid3 时搜索接口容易 -352（风控），先用指纹接口拿一个匿名 cookie
async function ensureCookie() {
  if (cookie && Date.now() - cookieAt < 6 * 3600 * 1000) return cookie;
  try {
    const j = await jget('https://api.bilibili.com/x/frontend/finger/spi');
    const d = (j && j.data) || {};
    if (d.b_3) {
      cookie = 'buvid3=' + d.b_3 + (d.b_4 ? '; buvid4=' + d.b_4 : '');
      cookieAt = Date.now();
    }
  } catch (e) {}
  return cookie;
}

async function ensureMixin() {
  if (mixinKey && Date.now() - mixinAt < 30 * 60 * 1000) return mixinKey;
  await ensureCookie();
  const j = await jget('https://api.bilibili.com/x/web-interface/nav');
  const w = (j && j.data && j.data.wbi_img) || {};
  const key = (w.img_url || '').split('/').pop().split('.')[0] + (w.sub_url || '').split('/').pop().split('.')[0];
  if (!key || key.length < 32) return '';
  let mixin = '';
  for (const i of MIXIN) mixin += key[i] || '';
  mixinKey = mixin.slice(0, 32);
  mixinAt = Date.now();
  return mixinKey;
}

function signWbi(params, mixin) {
  const p = Object.assign({}, params);
  p.wts = Math.round(Date.now() / 1000);
  const q = Object.keys(p)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, '')))
    .join('&');
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex');
  return q + '&w_rid=' + w_rid;
}

// "4:49" / "1:02:03" / "289" -> 毫秒
function parseDur(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const p = s.split(':').map((x) => parseInt(x, 10) || 0);
  if (p.length === 3) return ((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
  if (p.length === 2) return ((p[0] * 60 + p[1]) * 1000);
  return 0;
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// 去掉【4K】《》这类修饰，但把含版本标记的括号内容保留下来给负向词判断
function cleanTitle(t) {
  let s = htmlDecode(t);
  s = s.replace(/【[^】]*】/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/[（(]([^）)]*)[）)]/g, (m, inner) => {
    return /翻|伴奏|cover|live|现场|版|dj|remix|片段|试听|纯音乐|钢琴|ai/i.test(inner) ? ' ' + inner + ' ' : ' ';
  });
  return s.replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》〈〉【】\[\]（）()「」『』"'“”‘’、，,。.！!？?：:；;·~～\-_—/\\|@#￥$%^&*+=]/g, '');
}

async function search(keyword, limit) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const mixin = await ensureMixin();
  const params = {
    search_type: 'video',
    keyword: kw,
    page: 1,
    page_size: Math.max(1, Math.min(50, Number(limit) || 30)),
    order: 'totalrank',
  };
  const url = mixin
    ? 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + signWbi(params, mixin)
    : 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(kw) + '&page=1';
  const j = await jget(url);
  if (!j || j.code !== 0) {
    throw new Error('B站搜索失败（' + ((j && (j.message || j.msg)) || '未知原因') + '）');
  }
  const raw = ((j.data && j.data.result) || []).slice();
  return raw
    .map((v, i) => ({
      platform: 'bili',
      id: v.bvid || '',
      bvid: v.bvid || '',
      title: cleanTitle(v.title),
      rawTitle: htmlDecode(v.title),
      author: v.author || '',
      duration: parseDur(v.duration),
      play: Number(v.play) || 0,
      cover: v.pic ? (String(v.pic).startsWith('//') ? 'https:' + String(v.pic) : String(v.pic)) : '',
      platformRank: i,
    }))
    .filter((v) => v.bvid && v.duration > 0);
}

function artistList(artists) {
  return String(artists || '')
    .split(/[\/、,&，]/)
    .map((a) => norm(a))
    .filter((a) => a.length >= 1);
}

// 从 B站搜索结果里挑一首"确定是同一首歌"的投稿；挑不出来就返回 null
function pick(list, want) {
  const w = want || {};
  const nameN = norm(w.name);
  if (!nameN) return null;
  const arts = artistList(w.artists);
  const wantDur = Number(w.duration) || 0;
  const tol = wantDur ? Math.max(6000, wantDur * 0.035) : 0;
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || !v.bvid) continue;
    const titleN = norm(v.title);
    if (!titleN.includes(nameN)) continue;
    const blob = norm(v.rawTitle || v.title) + ' ' + norm(v.author);
    if (BAD_WORDS.some((b) => blob.includes(norm(b)))) continue;
    const dur = Number(v.duration) || 0;
    if (wantDur) {
      // 时长对不上的一律不要：B站同一首歌里混着专辑拼长版、试听片段
      if (!dur || Math.abs(dur - wantDur) > tol) continue;
    } else if (dur < 90000) {
      // 没有原曲时长可参照时，至少要 90 秒以上的完整投稿
      continue;
    }
    const artInTitle = arts.some((a) => a && titleN.includes(a));
    const artAuthor = arts.some((a) => a && norm(v.author).includes(a));
    // 歌手完全对不上，说明只是同名不同歌
    if (arts.length && !artInTitle && !artAuthor) continue;
    let score = 0;
    if (artInTitle) score += 40;
    if (artAuthor) score += 25;
    if (titleN === nameN) score += 15;
    if (wantDur && dur) score += Math.round(20 * (1 - Math.min(1, Math.abs(dur - wantDur) / tol)));
    if (v.play) score += Math.min(10, Math.round(Math.log10(Math.max(1, v.play)) * 2));
    out.push({
      platform: 'bili',
      id: v.bvid,
      bvid: v.bvid,
      title: v.title,
      author: v.author,
      duration: dur,
      play: v.play || 0,
      cover: v.cover || '',
      score,
      platformRank: v.platformRank,
    });
  }
  out.sort((a, b) => b.score - a.score || (a.platformRank || 0) - (b.platformRank || 0));
  return out[0] || null;
}

// 按歌名+歌手搜一轮（必要时再补一轮"歌名 歌手 MV"），返回最佳候选
async function findBest(want) {
  const w = want || {};
  const name = String(w.name || '').trim();
  if (!name) return null;
  const first = String(w.artists || '').split(/[\/、,&，]/)[0].trim();
  const kw = (name + ' ' + first).trim();
  let best = null;
  try {
    best = pick(await search(kw, 30), w);
  } catch (e) {
    best = null;
  }
  if (!best && first) {
    try {
      best = pick(await search(name + ' ' + first + ' 原版', 30), w);
    } catch (e) {
      best = null;
    }
  }
  return best;
}

// 取音频流：pagelist 拿 cid -> playurl(fnval=16) 拿 dash 音频
// 返回值里的 ext 给缓存落盘用（B站 dash 音频可能是 m4a 也可能是 flac）
async function getUrl(bvid) {
  const id = String(bvid || '').trim();
  if (!/^BV[0-9A-Za-z]+$/.test(id)) return { url: null, reason: 'B站音源参数异常' };
  await ensureCookie();
  let pl = null;
  try {
    pl = await jget('https://api.bilibili.com/x/player/pagelist?bvid=' + id);
  } catch (e) {
    return { url: null, reason: 'B站音源请求失败（' + e.message + '）' };
  }
  const cid = pl && pl.data && pl.data[0] && pl.data[0].cid;
  if (!cid) return { url: null, reason: 'B站投稿已失效（取不到分P）' };
  let pu = null;
  try {
    pu = await jget('https://api.bilibili.com/x/player/playurl?bvid=' + id + '&cid=' + cid + '&fnval=16&fourk=1');
  } catch (e) {
    return { url: null, reason: 'B站取流失败（' + e.message + '）' };
  }
  if (!pu || pu.code !== 0) {
    return { url: null, reason: 'B站取流失败（' + ((pu && pu.message) || '未知原因') + '）' };
  }
  const dash = pu.data && pu.data.dash;
  const auds = (dash && dash.audio) || [];
  let url = '';
  let ext = '.m4a';
  if (auds.length) {
    const best = auds
      .slice()
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    url = best.baseUrl || best.base_url || '';
    if (!url && Array.isArray(best.backupUrl) && best.backupUrl.length) url = best.backupUrl[0];
    if (/flac/i.test(String(best.codecs || ''))) ext = '.flac';
  }
  // 没有 dash 时退回 durl（mp4/flv 音视频合一，浏览器能只放音频轨）
  if (!url && pu.data && pu.data.durl && pu.data.durl[0]) {
    url = pu.data.durl[0].url || '';
    ext = '.mp4';
  }
  if (!url) return { url: null, reason: 'B站没有下发音频地址（投稿可能被限制）' };
  return {
    url,
    ext,
    quality: 'bili',
    qualityLabel: 'B站音源',
    note: 'B站投稿音频',
    headers: { Referer: REFERER },
  };
}

module.exports = { search, pick, findBest, getUrl, UA, REFERER, cleanTitle, parseDur };
