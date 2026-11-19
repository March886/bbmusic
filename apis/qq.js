// QQ音乐 接口层（非官方接口，仅供个人本地使用）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function headers(cookie) {
  return {
    Referer: 'https://y.qq.com/portal/player.html',
    'User-Agent': UA,
    Cookie: cookie || '',
  };
}

async function search(keyword, limit = 30, cookie = '') {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=' +
    limit +
    '&w=' +
    encodeURIComponent(keyword) +
    '&cr=1&new_json=1&t=0';
  const res = await fetch(url, { headers: headers(cookie) });
  if (!res.ok) throw new Error('qq search http ' + res.status);
  const data = await res.json();
  const list = (data && data.data && data.data.song && data.data.song.list) || [];
  return list.map((s, i) => {
    // new_json=1 时封面在 album.mid，老格式在 albummid
    const albumMid = (s.album && s.album.mid) || s.albummid || '';
    return {
      platform: 'qq',
      id: s.songmid || s.mid || '',
      // 评论数接口只认数字 songid（传 mid 一律回 0），搜索时先把 songid 一并带上
      songid: String(s.songid || s.id || ''),
      name: s.name || s.title || '',
      artists: (s.singer || []).map((a) => a.name).join(' / '),
      album: (s.album && (s.album.name || s.album.title)) || '',
      cover: albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : '',
      duration: (s.interval || 0) * 1000,
      // play_latest / listenCount 在不同版本接口里叫法不同，取到即用
      popularity: Number(s.play_latest || s.listenCount || s.play_count || 0),
      platformRank: i,
      // pay.pay_play=1：平台把这首标成付费/会员曲。注意它只说明「平台打了标记」，
      // 不代表当前账号真的没权益 —— 实测 SVIP 账号对 pay_play=1 的曲子照样能拿到 320k 与无损直链。
      // 列表据它打 VIP 角标（提示可能需跨平台换源），不拿它当「你没会员」的证据。
      vip: s.pay && Number(s.pay.pay_play) === 1 ? 1 : 0,
      payTrack: s.pay ? Number(s.pay.price_track) || 0 : 0,
    };
  });
}

// 从 cookie 中解析真实 uin，登录后用真实 uin 取链才可靠
function parseUin(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)uin=o?0*(\d+)/i);
  return m ? m[1] : '0';
}

// 音质档位 -> QQ 文件名前缀（低 -> 高）
// M500=128k mp3, M800=320k mp3, F000=无损 flac；QQ 没有 192k 档，192 按 128k 取
// 注意：指定 filename 后非会员账号平台可能直接返回 404，因此失败要回落到不指定 filename
const QUALITY_FN = {
  '128': { prefix: 'M500', ext: 'mp3', label: '标准 128kbps' },
  '192': { prefix: 'M500', ext: 'mp3', label: '较高 192kbps（QQ 无此档，按 128k 下发）' },
  '320': { prefix: 'M800', ext: 'mp3', label: '高品质 320kbps' },
  flac: { prefix: 'F000', ext: 'flac', label: '无损 FLAC' },
};

// 从 cookie 中取登录 key（qm_keyst）：musicu.fcg 的 comm.authst 就是它
function authKey(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)qm_keyst=([^;]+)/i);
  return m ? m[1] : '';
}

// 音频文件名用的是 file.media_mid，不是搜索返回的 songmid —— 这两个经常不是同一个值
// （实测「我不配」songmid=001T3JAT15palI、media_mid=001JSgnB2LDUqI，「晴天」songmid=0039MnYb0qxYhV、media_mid=003Qui1q2u1Zho）。
// 用 songmid 拼 filename 会拿到 purl 却下载 404（errorcode -46628 file not exist），
// 这正是之前 QQ 源「登录了也播不了、只能跳酷我/网易云」的真正原因。
const mediaMidCache = new Map();
async function getMediaMid(songmid, cookie) {
  const key = String(songmid || '');
  if (!key) return '';
  if (mediaMidCache.has(key)) return mediaMidCache.get(key);
  let mid = key;
  try {
    const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers(cookie)),
      body: JSON.stringify({
        req_0: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: key } },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const t = (data && data.req_0 && data.req_0.data && data.req_0.data.track_info) || {};
      const mmid = (t.file && t.file.media_mid) || '';
      if (mmid) mid = String(mmid);
    }
  } catch (e) {
    mid = key;
  }
  mediaMidCache.set(key, mid);
  return mid;
}

// 取 vkey。返回 { url, filename, result }：
// result=0 表示平台认这次请求，purl 才会是完整直链；其它值（104003 Cookie 失效、101404 档位未下发）都拿不到音频。
async function requestVkey(songmid, cookie, filename, expectMid) {
  const uin = parseUin(cookie);
  const param = {
    guid: String(1000000 + Math.floor(Math.random() * 8999999)),
    songmid: [songmid],
    songtype: [0],
    uin: uin,
    loginflag: 1,
    platform: '20',
  };
  if (filename) {
    param.filename = [filename];
  }
  // 实测结论（2026-11）：带 comm.authst 的 music.vkey.GetVkey / UrlGetVkey 是本机唯一稳定通道，
  // 有效 cookie 下 C400/完整曲目 result=0 且直链可播；换成 CgiGetVkey 或额外加 tmeAppID/tmeLoginType
  // 会一律退化成 104003。未登录（authst 为空）时平台回 104003/104009，属预期。
  const body = {
    comm: { uin: uin, format: 'json', ct: 24, cv: 0, authst: authKey(cookie) },
    req_0: { module: 'music.vkey.GetVkey', method: 'UrlGetVkey', param },
  };
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers(cookie)),
    body: JSON.stringify(body),
  });
  if (!res.ok) return { url: null, filename: '', result: -1 };
  const data = await res.json();
  const req0 = (data && data.req_0) || {};
  const d = req0.data || {};
  const info = (d.midurlinfo || [])[0];
  if (!info) return { url: null, filename: '', result: -1 };
  const fn = String(info.filename || '');
  const result = Number(info.result == null ? 0 : info.result);
  if (!info.purl) return { url: null, filename: fn, result };
  // 防串源：文件名里的 mid 必须与这首歌对得上（不指定 filename 时平台会拿别的歌顶包）
  if (expectMid && fn && fn.indexOf(expectMid) === -1) return { url: null, filename: fn, result: -2 };
  const sip = (d.sip && d.sip[0]) || 'https://ws.stream.qqmusic.qq.com/';
  return { url: sip + info.purl, filename: fn, result };
}

// 实测直链是否真能出声：平台常常下发「名义存在、实际无权」的链接（非会员的 320k 最典型），
// 只判断 purl 非空会把这种空壳链接当成功，落到 audio 上就是 Format error。
async function probePlayable(url, cookie) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      // 多拉一点：平台对「无权/占位」音源常返回 200/404 + 64 字节的空壳，光看 content-type 会误判可播
      headers: Object.assign({ Range: 'bytes=0-2047' }, headers(cookie)),
    });
    if (!res.ok) return false;
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (!/audio|mpeg|mp4|flac|octet-stream/.test(ct)) return false;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len < 1024) return false;
    let got = 0;
    try {
      const buf = await res.arrayBuffer();
      got = buf.byteLength;
    } catch (e) {
      got = 0;
    }
    return got > 1024 || (!got && len >= 1024);
  } catch (e) {
    return false;
  }
}

// 取播放直链：quality = '128' | '192' | '320' | 'flac'
// 顺序：用户要求的音质档 → 320k → 128k → C400 平台 AAC（登录态下最稳，实测唯一稳定出音源的一档）→ 平台默认
async function getUrl(songmid, cookie = '', quality = '') {
  const spec = QUALITY_FN[quality];
  // 所有档位的文件名都必须用 media_mid 拼，用 songmid 拼必然 404
  const mmid = (await getMediaMid(songmid, cookie)) || songmid;
  const tries = [];
  if (spec) tries.push({ fn: spec.prefix + mmid + '.' + spec.ext, quality, qualityLabel: spec.label });
  ['M800', 'M500'].forEach((pfx) => {
    if (quality === '320' && pfx === 'M800') return;
    if (quality === '128' && pfx === 'M500') return;
    tries.push({ fn: pfx + mmid + '.mp3', quality: pfx === 'M800' ? '320' : '128', qualityLabel: QUALITY_FN[pfx === 'M800' ? '320' : '128'].label });
  });
  tries.push({ fn: 'C400' + mmid + '.m4a', quality: 'auto', qualityLabel: '平台 AAC 128k（完整音源）' });

  let gotPurl = 0;
  let lastResult = 0;
  for (const t of tries) {
    const r = await requestVkey(songmid, cookie, t.fn, mmid).catch(() => null);
    if (!r) continue;
    if (r.result) lastResult = r.result;
    if (!r.url) continue;
    gotPurl += 1;
    if (await probePlayable(r.url, cookie)) {
      const fell = spec && t.quality !== quality;
      return {
        url: r.url,
        quality: t.quality,
        qualityLabel: t.qualityLabel,
        filename: r.filename,
        note: fell
          ? 'QQ 音乐未下发 ' + spec.label + '（该档位需要客户端授权，网页登录态只能拿到 128k AAC），已回落到 ' + t.qualityLabel
          : '',
      };
    }
  }
  // 兜底：不指定 filename，交给平台自己给默认音源；文件名里必须是这首歌的 mid，否则判串源（宁可播不了也不播错）
  const fb = await requestVkey(songmid, cookie, '', mmid).catch(() => null);
  if (fb && fb.url && (await probePlayable(fb.url, cookie))) {
    return {
      url: fb.url,
      quality: 'auto',
      qualityLabel: '平台默认音源',
      filename: fb.filename,
      note: spec ? 'QQ 音乐未下发 ' + spec.label + '，已回落到平台默认音源' : '',
    };
  }
  if (fb && fb.result) lastResult = fb.result;
  return {
    url: null,
    // 归因只说接口事实，别再猜「是不是没会员」：档位未下发和 Cookie 失效是完全不同的两件事
    reason: !String(cookie || '').trim()
      ? 'QQ 音乐需要登录后才能取到该曲目音源'
      : lastResult === 101404
        ? 'QQ 音乐没有下发这首歌的可用音源（当前登录态拿不到该档位）'
        : 'QQ 音乐没有下发这首歌的音源（可能已下架，或 Cookie 已失效）',
  };
}

// 登录态探测：用一首固定探针曲在「不指定 filename」下取 vkey —— 整轮只发 1 个请求。
// 有效 cookie：result=0 且 purl 非空（实测 150-400ms）；Cookie 过期：result=104003 且 purl 为空。
const PROBE_MID = '0039MnYb0qxYhV';
async function probeLogin(cookie = '') {
  if (!String(cookie || '').trim()) return { ok: false, reason: '未配置 Cookie' };
  const r = await requestVkey(PROBE_MID, cookie, '').catch(() => null);
  if (!r || r.result === -1) return { ok: false, reason: 'vkey 接口无响应' };
  if (r.result === 0 && r.url) return { ok: true, uin: parseUin(cookie) };
  return { ok: false, reason: 'Cookie 已失效（result ' + r.result + '）' };
}

// 账号信息：先验登录，再取昵称（GetLoginUserInfo / GetVipInfo 系列接口已稳定返回 500003，不可用，
// 所以这里不再尝试读取会员字段 —— 读不到不等于没开通，界面不能据此判定「非绿钻」）。
async function account(cookie = '') {
  const p = await probeLogin(cookie);
  if (!p.ok) return p;
  let nick = '';
  try {
    const res = await fetch(
      'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=' + p.uin + '&format=json&inCharset=utf8&outCharset=utf-8',
      { headers: headers(cookie) }
    );
    if (res.ok) {
      const data = await res.json();
      nick = (data && data.data && data.data.hostname) || '';
    }
  } catch (e) {
    nick = '';
  }
  return { ok: true, uin: p.uin, nick };
}

// 歌曲评论数：GlobalComment.GlobalCommentReadServer/GetCommentCount 支持批量，
// biz_id 必须是数字 songid（传 songmid 恒返回 0），返回 count 就是客户端上看到的评论数
async function commentCounts(songids, cookie = '') {
  const ids = (songids || []).map((x) => String(x == null ? '' : x)).filter((x) => /^\d+$/.test(x));
  if (!ids.length) return {};
  const uniq = Array.from(new Set(ids));
  const body = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
      uin: parseUin(cookie),
    },
    req_0: {
      module: 'GlobalComment.GlobalCommentReadServer',
      method: 'GetCommentCount',
      param: { request_list: uniq.map((id) => ({ biz_type: 1, biz_id: id })) },
    },
  };
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers(cookie)),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('qq commentCount http ' + res.status);
  const data = await res.json();
  const q = data && data.req_0;
  if (!q || q.code !== 0) return {};
  const rows = (q.data && q.data.response_list) || [];
  const out = {};
  rows.forEach((x) => {
    if (!x || x.biz_id == null) return;
    out[String(x.biz_id)] = Number(x.count) || 0;
  });
  return out;
}

module.exports = { search, getUrl, commentCounts, account, probeLogin };
