/* BBMusic 排序内核（主进程 / 渲染进程共用）
   目的：前后端只允许存在这一套打分公式。
   历史上主进程排一次、渲染层 rerenderSorted 又按另一套公式重算，
   结果界面顺序与后端顺序互相推翻（周杰伦这类只有 QQ/酷我源的正版被翻唱挤下去）。
   用法：
     主进程  const RANK = require('./renderer/rank.js');
     渲染层  window.BBM_RANK
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BBM_RANK = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /* ---------------- 文本规整 ---------------- */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[（(\[【].*?[)）\]】]/g, '')
      .replace(/[\s\-_·、,，.。!！?？'"“”‘’~]/g, '')
      .replace(/(live|remix|伴奏|翻唱|版|dj|feat.*)/g, '');
  }

  // 合并键专用：只去符号，保留括号内文字（"稻香(治愈版)"不能塌成"稻香"）
  function strictNorm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\-_·、,，.。!！?？'"“”‘’~/\\|+&()[\]【】<>《》：:;；]/g, '');
  }

  /* ---------------- 版本标记 ---------------- */
  // 版本不同 = 作品不同，绝不能合并，也不能按原版排序
  const VERSION_RULES = [
    { tag: '伴奏', re: /伴奏|卡拉|karaoke|instrumental|off\s*vocal|无和声/i },
    { tag: '纯音乐', re: /纯音乐|inst\.?\s|instrumental/i },
    { tag: '翻唱', re: /翻唱|cover|致敬|原唱\s*[:：]/i },
    { tag: 'remix', re: /remix|混音|dj\s*版|电音|club\s*mix|bootleg/i },
    { tag: '现场', re: /live|现场|演唱会|concert/i },
    // 倍速版（0.8x / 1.2x）本质是片段改编：
    // 漏掉时《说好的幸福呢 (0.8x)》会因为评论数极高被当成原版顶到第一
    { tag: '片段', re: /抖音|热播|片段|剪辑|加速|降速|慢速|sped\s*up|slowed|完整版|高清版|\d+(?:\.\d+)?\s*[xX](?![a-zA-Z])/i },
    { tag: '乐器版', re: /钢琴|piano|吉他|guitar|八音盒|music\s*box|古筝|二胡|小提琴|violin|口琴|尤克里里|ukulele/i },
    { tag: '换声', re: /女声|男声|童声|女版|男版|ai\s*翻唱/i },
    { tag: '改编', re: /治愈|改编|重制|重新编曲|新版|不插电|unplugged|acoustic|古风|摇滚|爵士|轻音乐|八音盒|助眠|白噪音|欢快|律动|动感|抒情|伤感|唯美|温柔|清新|燃|萌|搞笑/i },
    { tag: 'beat', re: /\bbeat\b|type\s*beat|beats/i },
  ];

  // 歌手名里的版本线索：只用明确词，绝不把"DJ某某""燃""萌"这类艺名当版本
  const ARTIST_VERSION_RULES = [
    { tag: '翻唱', re: /翻唱|cover|tribute|致敬/i },
    { tag: '伴奏', re: /伴奏|instrumental|karaoke|off\s*vocal/i },
    { tag: '纯音乐', re: /纯音乐/i },
    { tag: 'remix', re: /remix|混音/i },
    { tag: '现场', re: /live|现场|演唱会/i },
  ];

  function versionTag(name) {
    const s = String(name || '');
    const tags = [];
    for (const r of VERSION_RULES) if (r.re.test(s)) tags.push(r.tag);
    // 兜底：名字带"版"却没人认领的（如"欢快律动版"），一样视为改编版本
    if (!tags.length && /版/.test(s)) tags.push('改编');
    return Array.from(new Set(tags)).sort().join('+');
  }

  // 歌手名里的版本标记（"群星"是合辑不是版本，不在此列）
  function artistVersionTag(artists) {
    const s = String(artists || '');
    if (!s) return '';
    const tags = [];
    for (const r of ARTIST_VERSION_RULES) if (r.re.test(s)) tags.push(r.tag);
    return Array.from(new Set(tags)).sort().join('+');
  }

  // 歌名 + 专辑 + 歌手 三处合起来才算完整的版本判定
  function fullVersionTag(name, album, artists) {
    const parts = [versionTag(name), versionTag(String(name || '') + ' ' + String(album || '')), artistVersionTag(artists)].filter(Boolean);
    if (!parts.length) return '';
    const set = [];
    parts.forEach((p) => p.split('+').forEach((t) => set.push(t)));
    return Array.from(new Set(set)).sort().join('+');
  }

  /* ---------------- 查询解析与匹配度 ---------------- */
  // 只按空格 / 顿号 / 逗号 / 斜杠切，绝不按"的"切
  function parseQueryTokens(keyword) {
    return String(keyword || '')
      .split(/[\s,，、/|+]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 1);
  }

  // 从查询串剥掉歌手名，剩下的才是歌名查询串（纯歌名搜索原样返回）
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
    if (t.startsWith(k) || t.endsWith(k)) {
      const extra = t.length - k.length;
      return Math.max(0.6, 0.94 - extra * 0.06);
    }
    if (t.includes(k)) return 0.45 + 0.35 * (k.length / t.length);
    if (k.includes(t) && t.length >= 2) return 0.55 + 0.2 * (t.length / k.length);
    let hit = 0;
    for (const ch of k) if (t.includes(ch)) hit++;
    return (hit / k.length) * 0.5;
  }

  /* ---------------- 三路信号 ---------------- */
  // 评论数压到 0~1：4.6 万条 ≈ 0.93，1000 条 ≈ 0.6。对数压缩防爆款通吃
  function commentWeight(c) {
    return Math.log10(1 + (Number(c) || 0)) / 5;
  }

  // RRF（倒数排名融合）：替代原来的 hot 维度。
  // 原 hotScore 把"平台第一名"一律折成 1.0（QQ/酷我第一名 = 网易云 pop 100），
  // 0.18 权重等于发给所有平台首位，什么区分度都没有。
  // RRF 用各平台原始排名的倒数和，多平台同时靠前的条目才真正得分。
  const RRF_K = 12;
  function rrfScore(r) {
    const best = {};
    (r && r.sources ? r.sources : []).forEach((s) => {
      const rk = Number(s.platformRank);
      if (!isFinite(rk) || rk < 0) return;
      const k = s.platform || '?';
      if (best[k] === undefined || rk < best[k]) best[k] = rk;
    });
    let sum = 0;
    let n = 0;
    Object.keys(best).forEach((k) => {
      sum += 1 / (RRF_K + best[k]);
      n += 1;
    });
    if (!n) return 0;
    // 三个平台全部排第一 = 1；只有一个平台排第一 ≈ 0.33
    return clamp(sum / (3 / RRF_K), 0, 1);
  }

  // 跨平台一致性：同歌名同歌手同版本之外，专辑名还得对得上才算"同一张录音"。
  // 纯平台数（platCount）会把"同名但不同专辑"的搬运版也算成互相印证，这里是收紧版
  function consistencyScore(r) {
    const n = Number(r && (r.consist || r.platCount || 1));
    return clamp((n - 1) / 2, 0, 1);
  }

  /* ---------------- 第一层：身份（是不是这首歌、这一版） ---------------- */
  function identityScore(r, kwHasVer, kwVer) {
    const match = Number(r.match) || 0;
    const cover = r.cover === undefined ? 1 : Number(r.cover) || 0;
    let s = match * 0.62 + cover * 0.18;
    if (r.artHit) s += 0.16;
    if (r.strictName) s += 0.04;
    const ver = String(r.version || '');
    if (ver) {
      if (kwHasVer) {
        // 用户明确要 live/伴奏版：版本对得上才加分，对不上就降权
        if (kwVer && ver.indexOf(kwVer) >= 0) s += 0.04;
        else s -= 0.1;
      } else {
        // 用户要的是原版：所有改编版本整体降到下一档，但不隐藏
        s -= 0.22;
      }
    } else if (kwHasVer) {
      // 查询带了版本词，结果却没版本标记，说明不是用户要的那一版
      s -= 0.06;
    }
    if (r.shortDur) s -= 0.06;
    return clamp(s, 0, 1);
  }

  /* ---------------- 第二层：质量（同一身份内谁更该在前） ---------------- */
  function qualityScore(r) {
    const rr = rrfScore(r);
    // 评论数未知（接口没给）不参与惩罚，只有已知时才作为强弱信号
    const cm = r.commentsKnown ? clamp(commentWeight(r.comments), 0, 1) : r.artHit ? 0.1 : 0;
    const cons = consistencyScore(r);
    // 权重分配实测过一轮：RRF 只看各平台内部排名，同名不同歌的搬运版在自家平台排名也靠前，
    // 一旦让它占大头，48 条评论的双平台条目就能压过 1000+ 条评论的正主。
    // 所以评论量拿主权重（唯一跨平台可比且可解释的信号），一致性降为旁证，RRF 只做微调
    return clamp(cm * 0.8 + cons * 0.12 + rr * 0.08, 0, 1);
  }

  /* ---------------- 统一排序入口 ---------------- */
  // mode: comments（按评论总数）/ match（按相关度）/ smart（综合推荐）
  // hot 排序已取消：热度数据本身缺失（QQ/酷我拿不到播放量），排序只留可解释的三种
  function rankList(list, keyword, mode) {
    const arr = Array.isArray(list) ? list : [];
    const m = mode === 'match' || mode === 'smart' ? mode : 'comments';
    const kw = String(keyword || '');
    const kwVer = versionTag(kw);
    const kwHasVer = kwVer !== '';
    const kwLen = kw.length;

    arr.forEach((r) => {
      const idS = identityScore(r, kwHasVer, kwVer);
      const qS = qualityScore(r);
      r.ident = Math.round(idS * 10000) / 10000;
      r.quality = Math.round(qS * 10000) / 10000;
      // 身份分桶（20 档）：排序先比档位，同档内才轮到质量分，
      // 从根本上堵掉"高热度低相关条目越档反超正主"
      r.ib = Math.round(clamp(idS, 0, 1) * 20);
      // 评论模式专用的粗档（5 档）：20 档太细，差一档（0.05）就能让 8 万评论的正版排在
      // 一千评论的搬运版后面。评论模式只拦"明显不相关"，剩下交给评论数自己说话
      r.cib = Math.round(clamp(idS, 0, 1) * 4);
      let sc;
      if (m === 'match') sc = idS;
      else if (m === 'smart') sc = idS * 0.72 + qS * 0.28;
      else sc = idS * 0.86 + qS * 0.14;
      r.score = Math.round(clamp(sc, 0, 1) * 10000) / 10000;
    });

    arr.sort((a, b) => {
      if (m === 'comments') {
        // 评论模式先按粗身份档（只挡明显不相关），再严格按评论数自己说话
        if ((b.cib || 0) !== (a.cib || 0)) return (b.cib || 0) - (a.cib || 0);
      } else if ((b.ib || 0) !== (a.ib || 0)) {
        return (b.ib || 0) - (a.ib || 0);
      }
      if (m === 'comments') {
        // 「按评论总数」就该按评论总数来：同一身份档内，已查证的评论多者优先。
        // 未知（-1）统一排到已知之后——未知不等于零评论，但也不能凭空插到有数据的条目前面。
        // 首屏还没补全评论时两边都是 -1，自动落到下面的综合分比较。
        const ca = a.commentsKnown ? Number(a.comments) || 0 : -1;
        const cb = b.commentsKnown ? Number(b.comments) || 0 : -1;
        if (ca !== cb) return cb - ca;
      }
      if (Math.abs((b.score || 0) - (a.score || 0)) > 0.0005) return (b.score || 0) - (a.score || 0);
      const va = a.version ? 1 : 0;
      const vb = b.version ? 1 : 0;
      if (va !== vb) return va - vb;
      if (!!a.artHit !== !!b.artHit) return a.artHit ? -1 : 1;
      const la = Math.abs(String(a.name || '').length - kwLen);
      const lb = Math.abs(String(b.name || '').length - kwLen);
      if (la !== lb) return la - lb;
      const pa = Number(a.consist || a.platCount || 1);
      const pb = Number(b.consist || b.platCount || 1);
      if (pb !== pa) return pb - pa;
      // 分都一样时先看评论：原唱通常评论远多于翻唱，比"谁时长更长"更接近人的判断
      const ka = a.commentsKnown ? Number(a.comments) || 0 : -1;
      const kb = b.commentsKnown ? Number(b.comments) || 0 : -1;
      if (kb !== ka) return kb - ka;
      return (b.duration || 0) - (a.duration || 0);
    });
    return arr;
  }

  return {
    norm: norm,
    strictNorm: strictNorm,
    versionTag: versionTag,
    artistVersionTag: artistVersionTag,
    fullVersionTag: fullVersionTag,
    parseQueryTokens: parseQueryTokens,
    splitTitleQuery: splitTitleQuery,
    matchScore: matchScore,
    commentWeight: commentWeight,
    rrfScore: rrfScore,
    consistencyScore: consistencyScore,
    identityScore: identityScore,
    qualityScore: qualityScore,
    rankList: rankList,
    // 兼容旧调用名
    sortResultList: rankList,
  };
});
