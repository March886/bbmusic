// 网易云音乐 接口层（非官方接口，仅供个人本机使用）
const { weapi } = require('./crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function baseHeaders(cookie) {
  return {
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
    'User-Agent': UA,
    Cookie: cookie && cookie.trim() ? 'MUSIC_U=' + cookie.trim().replace(/^MUSIC_U=/, '') + '; appver=2.0.2; os=pc' : 'appver=2.0.2; os=pc',
  };
}

// 搜索：cloudsearch 接口返回 pop（热度 0-100）与封面
async function search(keyword, limit = 30, cookie = '') {
  const res = await fetch('https://music.163.com/api/cloudsearch/pc', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, baseHeaders(cookie)),
    body:
      's=' +
      encodeURIComponent(keyword) +
      '&type=1&limit=' +
      limit +
      '&offset=0&total=true',
  });
  if (!res.ok) throw new Error('netease http ' + res.status);
  const data = await res.json();
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map((s, i) => ({
    platform: 'netease',
    id: String(s.id),
    name: s.name || '',
    artists: (s.ar || s.artists || []).map((a) => a.name).join(' / '),
    album: (s.al && s.al.name) || '',
    cover: (s.al && s.al.picUrl) || '',
    duration: s.dt || s.duration || 0,
    // pop: 平台给出的热度值 0-100
    popularity: Number(s.pop || 0),
    fee: s.fee,
    platformRank: i,
  }));
}

// eapi 加密（AES-128-ECB），网易云客户端实际使用的接口协议。
// 旧 weapi 接口对大量曲目（包括免费曲）已经开始返回空地址，eapi 明显更稳。
const crypto = require('crypto');

function eapiEncrypt(apiPath, obj) {
  const text = JSON.stringify(obj);
  const digest = crypto
    .createHash('md5')
    .update('nobody' + apiPath + 'use' + text + 'md5forencrypt', 'utf8')
    .digest('hex');
  const data = apiPath + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  return Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

// 把平台的返回码翻译成人话：别让"没版权"看起来像"登录没成功"
function neFailReason(item) {
  const code = item && item.code;
  if (code === -110) return '网易云要求会员权限（可能是账号会员已过期）';
  if (code === 404 || code === 200 && item && !item.url) return '该曲目在网易云已无版权，平台不下发音频';
  if (item && item.freeTrialInfo) return '仅提供试听片段（VIP 曲目），完整版需会员';
  return '无版权或需付费';
}

async function getUrlEapi(id, cookie = '', br = 999000) {
  const apiPath = '/api/song/enhance/player/url';
  // br: 128000 / 192000 / 320000 / 999000(无损)。账号没权限时平台自动降档下发
  const params = eapiEncrypt(apiPath, { ids: '[' + id + ']', br });
  const ck =
    (cookie && cookie.trim() ? 'MUSIC_U=' + cookie.trim() + '; ' : '') +
    'os=pc; appver=2.9.7; osver=10; deviceId=babamusic; requestId=babamusic';
  const res = await fetch('https://interface3.music.163.com/eapi/song/enhance/player/url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      Cookie: ck,
    },
    body: 'params=' + params,
  });
  if (!res.ok) return { url: null, reason: 'http ' + res.status };
  const data = await res.json();
  const item = data && data.data && data.data[0];
  if (!item || !item.url) {
    return {
      url: null,
      reason: neFailReason(item),
    };
  }
  if (item.id && String(item.id) !== String(id)) {
    return { url: null, reason: '平台返回了其他曲目，已拦截' };
  }
  return { url: item.url.replace(/^http:/, 'http:'), br: item.br, size: item.size };
}

// 取播放直链：先走 eapi，失败再回退旧 weapi
// br 由调用方按"音质选择"传入，默认 320000
async function getUrl(id, cookie = '', br = 320000) {
  let eapiErr = null;
  try {
    const r = await getUrlEapi(id, cookie, br);
    if (r && r.url) return r;
    eapiErr = r;
  } catch (e) {
    eapiErr = { url: null, reason: 'eapi: ' + e.message };
  }
  const legacy = await getUrlWeapi(id, cookie, br).catch(() => null);
  if (legacy && legacy.url) return legacy;
  return eapiErr || legacy || { url: null, reason: '无版权或需付费' };
}

// 旧 weapi 接口（兜底）
async function getUrlWeapi(id, cookie = '', br = 320000) {
  const { params, encSecKey } = weapi({ ids: '[' + id + ']', br, csrf_token: '' });
  const res = await fetch('https://music.163.com/weapi/song/enhance/player/url?csrf_token=', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, baseHeaders(cookie)),
    body: 'params=' + encodeURIComponent(params) + '&encSecKey=' + encodeURIComponent(encSecKey),
  });
  if (!res.ok) return { url: null, reason: 'http ' + res.status };
  const data = await res.json();
  const item = data && data.data && data.data[0];
  if (!item || !item.url) {
    return { url: null, reason: neFailReason(item) };
  }
  // 防串源：返回的歌曲 id 必须与请求一致
  if (item.id && String(item.id) !== String(id)) {
    return { url: null, reason: '平台返回了其他曲目，已拦截' };
  }
  return { url: item.url.replace(/^http:/, 'http:'), br: item.br, size: item.size };
}

// 歌词
async function lyric(id) {
  const res = await fetch('https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1', {
    headers: baseHeaders(''),
  });
  const data = await res.json();
  return (data && data.lrc && data.lrc.lyric) || '';
}

// 评论总数（真实讨论度，用于排序维度）
async function commentCount(id) {
  const res = await fetch(
    'https://music.163.com/api/v1/resource/comments/R_SO_4_' + id + '?limit=1&offset=0&total=true',
    { headers: baseHeaders('') }
  );
  if (!res.ok) return 0;
  const data = await res.json();
  return Number((data && (data.total || (data.data && data.data.total))) || 0);
}

// 登录态探测：/api/nuser/account/get 是网易云客户端自己的「当前账号」接口。
// cookie 有效时返回 account.id（实测还会带 profile.nickname 与 account.vipType），
// cookie 过期时仍然 code=200，但 account 与 profile 都是 null —— 所以不能只看 code。
async function account(cookie = '') {
  const res = await fetch('https://music.163.com/api/nuser/account/get', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, baseHeaders(cookie)),
    body: '',
  });
  if (!res.ok) throw new Error('netease account http ' + res.status);
  const data = await res.json();
  const ac = data && data.account;
  if (!ac || !ac.id) return { ok: false, code: Number((data && data.code) || 0) };
  const p = (data && data.profile) || {};
  return {
    ok: true,
    id: String(ac.id),
    nick: p.nickname || '',
    // vipType：0 非会员 / 10 音乐包 / 11 黑胶 VIP / 12 黑胶 SVIP
    vipType: Number(ac.vipType || 0) || 0,
  };
}

module.exports = { search, getUrl, lyric, commentCount, account };
