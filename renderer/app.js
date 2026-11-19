/* BBMusic 渲染层 */
const audio = document.getElementById('audio');
// 一首播完按当前播放模式自动接歌
audio.addEventListener('ended', () => onTrackEnded());
const $ = (id) => document.getElementById(id);

const state = {
  results: [],
  current: null,
  srcIndex: 0,
  sortMode: 'comments',
  prefer: 'netease',
  // 播放模式：order 顺序播放 / loop 列表循环 / single 单曲循环 / shuffle 随机播放
  playMode: 'order',
  // 音量 0~1，启动时从配置回填，改动后写回配置（别再每次开机都是 80%）
  volume: 0.8,
  // 歌词延迟补偿（毫秒）：负数=歌词提前追上演唱，正数=歌词延后
  lyricOffset: 0,
  playing: false,
  logged: { netease: false, qq: false },
  lastKeyword: '',
  // 已判定「内容与歌名不符」的坏音源（platform|id → 真实时长秒），本次会话内不再重试
  badSrc: {},
  // 当前 audio 里实际装载的源对象，用于推出「是哪个源串了」
  nowSrc: null,
  // 待删除的坏缓存队列：audio 还攥着该文件时 Windows 删不掉，必须等切源后再删
  pendingDrop: [],
  // 正在卸空 audio 时置位：removeAttribute('src')+load() 会连带触发事件，别让它再走换源逻辑
  unloading: false,
};

const PLAT_LABEL = { netease: '网易云', qq: 'QQ音乐', kuwo: '酷我', bili: 'B站' };

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ms) {
  if (!ms || ms < 0) return '00:00';
  const t = Math.floor(ms / 1000);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function fmtCount(n) {
  if (!n) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}

// 评论数是 QQ 音乐 + 网易云 的合计，悬浮时把两边明细摊开
// commentsKnown=false 表示这次没问出结果，跟"确实 0 条"必须分开说，否则等于骗用户
function cmtTitle(it) {
  const d = it && it.commentsDetail;
  if (!d) return '评论数还在取…';
  const parts = [];
  if (d.netease) parts.push('网易云 ' + fmtCount(d.netease));
  if (d.qq) parts.push('QQ音乐 ' + fmtCount(d.qq));
  if (!parts.length) {
    return it.commentsKnown ? '两个平台均无评论' : '未取到评论数（接口没返回，不等于零评论）';
  }
  return '评论数合计 ' + fmtCount((d.netease || 0) + (d.qq || 0)) + '：' + parts.join(' + ');
}

let toastTimer = null;
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  // 无音源那种长原因 2.4 秒根本读不完，调用方可传更长的停留时间
  toastTimer = setTimeout(() => el.classList.add('hidden'), Number(ms) || 2400);
}

/* ---------------- 搜索 ---------------- */
async function doSearch() {
  const kw = $('searchInput').value.trim();
  if (!kw) return;
  switchView('search');
  state.lastKeyword = kw;
  $('resultTitle').textContent = '搜索「' + kw + '」';
  $('resultMeta').textContent = '正在同时检索网易云与 QQ 音乐…';
  $('songList').innerHTML = '<div class="empty">正在检索…</div>';
  try {
    const r = await window.baba.search(kw, { sortMode: state.sortMode });
    state.results = r.list || [];
    // 后端已按当前排序模式算好 score 并排好序，这里原样留底，切排序时靠它还原
    state.results.forEach((it) => { it.bs = typeof it.score === 'number' ? it.score : undefined; });
    rerenderSorted();
    const counts = r.counts || {};
    let meta = '共 ' + state.results.length + ' 首（网易云 ' + (counts.netease || 0) + ' / QQ ' + (counts.qq || 0) + ' / 酷我 ' + (counts.kuwo || 0) + '）';
    if (r.errors && r.errors.length) meta += '　⚠ ' + r.errors.join('；');
    $('resultMeta').textContent = meta;
  } catch (e) {
    $('songList').innerHTML = '<div class="empty">搜索失败：' + esc(e.message) + '</div>';
    $('resultMeta').textContent = '';
  }
}

function rerenderSorted() {
  if (!state.results.length) return;
  const mode = state.sortMode === 'match' || state.sortMode === 'smart' ? state.sortMode : 'comments';
  state.results.forEach((it) => {
    if (it.sources && it.sources.length) it.platCount = new Set(it.sources.map((s) => s.platform)).size;
  });
  // 打分与排序全部交给主进程同一份 renderer/rank.js：
  // 前端只要还留着自己的一套公式，用户切一次排序就会把后端排好的顺序整个推翻
  //（老毛病：周杰伦这类只有 QQ/酷我有源的正版，评论数恒为 0，被网易云翻唱挤到十几名）
  if (window.BBM_RANK) window.BBM_RANK.rankList(state.results, state.lastKeyword, mode);
  else state.results.sort((a, b) => (b.score || 0) - (a.score || 0));
  renderList();
}

// 行渲染抽出来复用：搜索结果、歌单详情、播放历史三个列表长得一样，只有队列不同
function rowHtml(it, i) {
  // 同一平台只留一个标签；替代音源（原平台 VIP/版权不可播时补的）单独标出来
  const seenTag = [];
  const tags = (it.sources || [])
    .filter((s) => {
      const k = s.platform + (s.alt ? '|alt' : '');
      if (seenTag.includes(k)) return false;
      seenTag.push(k);
      return true;
    })
    .map(
      (s) =>
        '<span class="tag ' +
        s.platform +
        '" title="' +
        (s.alt ? '原平台不可播，已用该平台音源替代' : '原生音源') +
        '">' +
        (PLAT_LABEL[s.platform] || s.platform) +
        (s.alt ? '·替代' : '') +
        '</span>'
    )
    .join('');
  const isPlaying = state.current && state.current.key === it.key;
  const inDef = inPlaylist(DEFAULT_PL_ID, it);
  const key = esc(it.key || '');
  // 封面地址必须是 http(s) 的绝对地址，其它任何值（空串、"1"、0.66 这种打分残留）
  // 一律当作没有封面处理，避免 img 拿相对路径去请求文件协议下的不存在的图
  const cover = coverSrc(it.cover);
  const coverHtml = cover
    ? '<img class="row-cover" loading="lazy" decoding="async" src="' + esc(cover) + '" onerror="this.removeAttribute(\'src\')" />'
    : '<div class="row-cover"></div>';
  return (
    '<div class="song-row' + (isPlaying ? ' playing' : '') + '" data-idx="' + i + '" data-key="' + key + '">' +
    '<span class="col-idx">' + (i + 1) + '</span>' +
    '<div class="title-cell">' +
    coverHtml +
    '<div style="min-width:0">' +
    '<div class="title-text">' + esc(it.name) +
    (it.vtag ? '<span class="vtag" title="这是一个不同于原版的独立版本，播放内容与原版不同">' + esc(it.vtag) + '</span>' : '') +
    (it.vip ? '<span class="vtag" title="导入的平台把这首标成会员/付费专享，点播时会自动换其他平台或 B站 的音源">VIP</span>' : '') +
    '</div>' +
    '<div class="artist-text">' + esc(it.artists) + '</div>' +
    '</div></div>' +
    '<span class="album-cell">' + esc(it.album) + '</span>' +
    '<span class="plat-tags">' + tags + '</span>' +
    '<span class="cmt-cell" title="' + esc(cmtTitle(it)) + '">' + (it.commentsKnown ? fmtCount(it.comments) : '—') + '</span>' +
    '<span class="time-cell">' + fmtTime(it.duration) + '</span>' +
    '<span class="act-cell"><button class="add-btn' + (inDef ? ' in' : '') + '" data-key="' + key +
    '" title="' + (inDef ? '已在默认歌单，点击换到别的歌单' : '添加到歌单') + '">+</button></span>' +
    '</div>'
  );
}

// 列表绑定：左键播放（队列跟着当前列表走），右键出菜单
function bindRows(box, list) {
  box.querySelectorAll('.song-row').forEach((row) => {
    const it = list[Number(row.dataset.idx)];
    if (!it) return;
    row.addEventListener('click', () => playItem(it, list));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, it);
    });
  });
}

function renderList() {
  const box = $('songList');
  if (!state.results.length) {
    box.innerHTML = '<div class="empty">没有找到结果，换个关键词试试</div>';
    return;
  }
  box.innerHTML = state.results.map((it, i) => rowHtml(it, i)).join('');
  bindRows(box, state.results);
}

/* ---------------- 播放 ---------------- */
// 曲目标识：同一首歌在不同平台 id 不同，判断"当前放的是不是这首"只能靠名字+歌手+时长
function itemKeyOf(item) {
  if (!item) return '';
  return [item.name || '', item.artists || '', item.duration || 0].join('|');
}

function orderSources(item) {
  const pref = state.prefer;
  const prim = item.primary || null;
  const isPrim = (s) => prim && s.platform === prim.platform && s.id === prim.id;
  // 排序优先级：主源（界面信息来自它）> 原生源 > 替代音源 > 偏好平台 > 平台原始排名
  // 替代音源（导入平台不可播时补的）永远排最后，这样补源后从「原来的源数量」接着试就行，不会重试已失败的源
  return item.sources.slice().sort((a, b) => {
    const pa = isPrim(a) ? 0 : 1;
    const pb = isPrim(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const aa = a.alt ? 1 : 0;
    const ab = b.alt ? 1 : 0;
    if (aa !== ab) return aa - ab;
    const ra = a.platform === pref ? 0 : 1;
    const rb = b.platform === pref ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.platformRank || 0) - (b.platformRank || 0);
  });
}

async function playItem(item, queue, opts) {
  if (!item) return;
  // silent=true：只装载音源并把进度定位到记忆点，不自动出声，等用户自己点播放
  const silent = !!(opts && opts.silent);
  state.current = item;
  // 每点一次歌都重新允许跨平台补源一次（补到的源会写回歌单，下次直接用）
  item._altTried = false;
  state.srcIndex = 0;
  // 从歌单/播放历史里点播时，上下一首要顺着那个列表走，而不是跳回搜索结果
  state.queue = Array.isArray(queue) && queue.length ? queue : state.results;
  // 记住这个队列是从哪来的（哪个歌单 / 播放历史 / 搜索结果），续播恢复时据此把队列原样接回去
  state.queueSrc = detectQueueSrc(state.queue);
  // 每次点歌递增序号：旧一轮的异步取链回来时若序号已变，直接丢弃，
  // 否则慢接口回来会把后点的歌顶掉、或者同一首被并行试播好几遍
  state.playSeq = (state.playSeq || 0) + 1;
  renderList();
  updateNowPlaying(item);
  // 刚切歌：audio 里还挂着上一首（甚至是上一首的坏源）的 duration，条上先按列表标注时长显示
  syncBarTime(true);
  await tryPlayFrom(0, null, state.playSeq, silent);
  // 切歌后立刻把续播快照改成新歌（进度 0），避免下次启动续上上一首的中断点
  saveResumeNow();
}

// 音源唯一标识：同一首歌在 QQ 上可能挂着多个 mid（正版 + 长音频/合集），必须按 mid 区分
function srcKeyOf(s) {
  if (!s) return '';
  return String(s.platform || '') + '|' + String(s.id || '');
}

// 判定某个源「内容与歌名不符」后：本会话拉黑，并把它的本地缓存排进删除队列
// 缓存按 platform_id 命名，只要还在，下次点同一首会直接命中这段错误音频，校验能拦住但每回都白等一次下载
function markBadSrc(s, realSec) {
  if (!s) return;
  const k = srcKeyOf(s);
  if (k) state.badSrc[k] = Math.round(realSec || 0) || 1;
  if (!Array.isArray(state.pendingDrop)) state.pendingDrop = [];
  if (!state.pendingDrop.some((x) => srcKeyOf(x) === k)) {
    state.pendingDrop.push({ platform: s.platform, id: s.id });
  }
}

// 真正删缓存：必须等 audio 已经切到别的源（旧文件句柄释放）再动手，否则 Windows 下必删失败
function flushPendingDrop() {
  const q = Array.isArray(state.pendingDrop) ? state.pendingDrop.splice(0) : [];
  if (!q.length) return;
  setTimeout(() => {
    for (const s of q) {
      try {
        if (window.baba && window.baba.cacheDropOne) window.baba.cacheDropOne(s.platform, s.id);
      } catch (e) {}
    }
  }, 600);
}

// 播放条总时长只认两种值：列表标注时长，或「通过了防串校验的 audio 真实时长」。
// 原来 durTime 无脑取 audio.duration：《我不配》那段 34:12 的 QQ 长音频一加载，条上的总时长立刻被改成 34:12，
// 后面虽然暂停并拉黑了它，这个数字仍然留在条上（audio.duration 不清零），用户看着就是「问题还在」。
function barTotalSec(item) {
  const want = item && item.duration ? Math.round(item.duration / 1000) : 0;
  const real = Number(audio.duration) || 0;
  const okReal = real > 0 && (!want || Math.abs(real - want) <= Math.max(6, want * 0.03));
  return okReal ? real : want;
}

function syncBarTime(forceReset) {
  const total = barTotalSec(state.current);
  $('durTime').textContent = total ? fmtTime(total * 1000) : '--:--';
  const real = Number(audio.duration) || 0;
  if (forceReset || !real || !total) {
    $('curTime').textContent = '00:00';
    $('progress').value = 0;
    return;
  }
  $('curTime').textContent = fmtTime(audio.currentTime * 1000);
  $('progress').value = Math.min(1000, Math.floor((audio.currentTime / total) * 1000));
}

// 单曲彻底没得播时把 audio 卸空：不清 src 的话 duration 会一直挂着坏源的值，
// 播放条、进度条、以及上面那次 timeupdate 都会继续按错时长渲染
function unloadAudio() {
  try {
    state.unloading = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch (e) {
  } finally {
    setTimeout(() => {
      state.unloading = false;
    }, 0);
  }
  state.nowSrc = null;
  state.nowItemKey = null;
  setPlaying(false);
  syncBarTime(true);
}

async function tryPlayFrom(index, fails, seq, silent) {
  const item = state.current;
  if (!item) return;
  const quiet = !!silent;
  const mySeq = seq || state.playSeq || 0;
  if (mySeq !== state.playSeq) return;
  const order = orderSources(item);
  const errs = fails || [];
  // 记在 state 上：时长校验那一步自己换源时没有 errs 上下文，要靠它把前面的失败原因带下去
  state.errChain = errs;
  if (index >= order.length) {
    // 只有「此刻放着的就是这首」才静默（时长校验换源走到尽头时会误报，别打扰）；
    // 若上一首还在响、而用户刚点的这首全平台都没音源，必须明确告知，否则点了没反应像卡死
    const playingThisOne = state.playing && audio.src && state.nowItemKey === itemKeyOf(item);
    if (playingThisOne) return;
    // 手上的源全失败（导入歌单最常见：VIP / 版权下架）：去其他平台反查同一首歌，
    // 找到能播的音源就补到这首歌上，歌单条目本身一首都不动
    if (!item._altTried) {
      item._altTried = true;
      // 文案要准：不是"没有音源"，是"当前这些平台没给（多半是会员专享/下架），正在找替代版本"
      toast('当前这些平台没给「' + item.name + '」的音源，正在找其他平台和 B站 的同名同版本…');
      let alt = null;
      try {
        alt = await window.baba.findSources({
          name: item.name,
          artists: item.artists,
          album: item.album,
          duration: item.duration,
          exclude: order.map((s) => ({ platform: s.platform, id: s.id })),
        });
      } catch (e) {
        alt = null;
      }
      // 期间用户点了别的歌，这轮补源结果作废
      if (mySeq !== state.playSeq) return;
      if (alt && alt.sources && alt.sources.length) {
        const added = [];
        alt.sources.forEach((s) => {
          const dup = (item.sources || []).some(
            (x) => x.platform === s.platform && String(x.id) === String(s.id)
          );
          if (dup) return;
          item.sources.push({
            platform: String(s.platform),
            id: String(s.id),
            duration: Number(s.duration) || 0,
            platformRank: Number(s.platformRank) || 90,
            name: String(s.name || item.name || ''),
            alt: 1,
            bili: s.bili ? 1 : 0,
          });
          added.push(PLAT_LABEL[s.platform] || s.platform);
        });
        if (added.length) {
          // 写回歌单/历史，下次点同一首直接用替代源，不必再跨平台找一遍
          persistAltSources(item);
          updateNowPlaying(item);
          if (state.plCur) renderPlSongs();
          if (state.view === 'history') renderHistory();
          toast(
            '已换成' + added.join(' / ') + '的音源：' + item.name +
              (alt.sources.some((s) => s.platform === 'bili') ? '（B站投稿音频，已下载到本地缓存）' : '')
          );
          // order 是补源前的列表，长度恰好是新源（排在末尾）的起点
          return tryPlayFrom(order.length, errs, mySeq, quiet);
        }
      }
      const why = (alt && alt.reason) || '其他平台和 B站 也没有可播版本';
      console.log('[alt] no-fallback', item.name, why);
      errs.push({ platform: '其他平台', reason: why });
    }
    // 这首所有源都失败、不会再切源了，此刻把队列里的坏缓存清掉（音频已暂停，句柄通常已释放）
    flushPendingDrop();
    // 每个平台为什么失败都摊开告诉用户，别只丢一句"可能需会员"
    const detail = errs.length
      ? '：' + errs.map((e) => (PLAT_LABEL[e.platform] || e.platform) + ' — ' + e.reason).join('；')
      : '';
    if (state.playing && audio.src) {
      // 上一首还在播：只提示这首点不动，不能把上一首的播放状态误标成暂停
      toast('「' + item.name + '」QQ音乐、网易云、酷我、B站 都没拿到能播的版本' + detail);
      return;
    }
    toast('该曲目在 QQ音乐、网易云、酷我、B站 都没拿到能播的版本' + detail, 9000);
    // 上一首还在播时不能动 audio（上面已 return），走到这里说明 audio 里装的就是这首的废源或空
    if (!state.playing || !audio.src || state.nowItemKey === itemKeyOf(item)) unloadAudio();
    else setPlaying(false);
    return;
  }
  const src = order[index];
  // 已经被真实时长戳穿的坏源，别再浪费一次取链和下载
  if (state.badSrc[srcKeyOf(src)]) {
    errs.push({ platform: src.platform, reason: '音源内容与歌曲不符（已跳过）' });
    return tryPlayFrom(index + 1, errs, mySeq, quiet);
  }
  // 替代源（跨平台补的）先卡一道时长：与原曲相差超过 4% 的直接不要，宁可没得播也不播错版本
  if (src.alt && item.duration && src.duration && Math.abs(src.duration - item.duration) > Math.max(4000, item.duration * 0.04)) {
    errs.push({ platform: src.platform, reason: '时长与原曲不符（可能是翻唱/剪辑版），已跳过' });
    return tryPlayFrom(index + 1, errs, mySeq, quiet);
  }
  state.srcIndex = index;
  console.log('[try] idx=' + index + ' plat=' + src.platform + ' id=' + src.id + ' srcDur=' + (src.duration || 0) + ' itemDur=' + (item.duration || 0));
  toast('尝试音源：' + PLAT_LABEL[src.platform]);
  let r = null;
  try {
    r = await window.baba.getUrl(src.platform, src.id);
  } catch (e) {
    r = { url: null, reason: e.message || '请求异常' };
  }
  if (!r || !r.url) {
    errs.push({ platform: src.platform, reason: (r && r.reason) || '接口没有返回地址' });
    console.log('[switch] no-url', src.platform, src.id, (r && r.reason) || '');
    return tryPlayFrom(index + 1, errs, mySeq, quiet);
  }
  audio.src = r.url;
  // 已切到新源，旧文件不再被独占，这时候才删得掉排在队列里的坏缓存
  flushPendingDrop();
  // 记下「audio 里现在装的是哪首」，收尾判断该不该提示时要用
  state.nowItemKey = itemKeyOf(item);
  // 同时记下具体是哪个平台的哪个 mid，时长校验失败时要知道拉黑谁
  state.nowSrc = src;
  // 平台返回的 duration 是毫秒，audio.duration 是秒，这里统一折成秒再比
  // 校验基准必须是「这首歌在列表里标注的时长」，而不是这个源自己报的时长：
  // 拿源自己的时长当基准，翻唱版（306 秒）永远能通过校验，用户就会被静默换成别人的版本。
  audio.dataset.expectDur = String(Math.round((item.duration || src.duration || 0) / 1000));
  // 装载前先把条复位到列表时长，新源的真实时长要等校验通过才敢显示
  syncBarTime(true);
  audio.volume = clamp01(state.volume);
  // 静默装载（启动续播专用）：只把音源装进 audio，进度交给 loadedmetadata 里的 restorePos 定位，
  // 不出声、不把状态标成「正在播放」，等用户自己点播放键
  if (quiet) {
    try {
      audio.preload = 'auto';
      audio.load();
    } catch (e) {}
    setPlaying(false);
    syncBarTime(true);
    return;
  }
  const p = audio.play();
  if (p && p.catch) {
    p.catch((e) => {
      // 浏览器自动播放限制（NotAllowedError）不是音源问题，别误判成"这个平台拿不到"而换源
      if (e && e.name === 'NotAllowedError') {
        toast('浏览器拦截了自动播放，点一下播放键继续');
        return;
      }
      console.log('[switch] play-reject', src.platform, e && e.name, e && e.message);
      if (mySeq === state.playSeq) tryPlayFrom(index + 1, null, mySeq, quiet);
    });
  }
}

// 音源防串校验：拿到真实时长后与条目标注时长比对，差异过大说明平台返回了别的音频
audio.addEventListener('loadedmetadata', () => {
  if (!state.current) return;
  const expect = Number(audio.dataset.expectDur || 0);
  const real = Math.round(audio.duration || 0);
  if (!expect || !real || !isFinite(real)) return;
  // 只有刚起播（还没播起来）时才做串源校验，播到一半的不要打断
  if (audio.currentTime > 2) return;
  const gap = Math.abs(real - expect);
  // 阈值从 15 秒/12% 收紧到 6 秒/3%：342 秒的《以父之名》原来能容忍 41 秒误差，
  // 结果把 306 秒的同名翻唱（网易云吉克曲布）当成原版放了出来，用户听到的是另一首歌。
  // 同一首歌不同平台相差 1~3 秒属正常，3% 足够容错，又能挡住时长明显不同的翻唱/剪辑版。
  if (gap > Math.max(6, expect * 0.03)) {
    const order = orderSources(state.current);
    const badSrc = state.nowSrc;
    const mins = Math.floor(real / 60) + ':' + String(real % 60).padStart(2, '0');
    const want = Math.floor(expect / 60) + ':' + String(expect % 60).padStart(2, '0');
    console.log('[switch] duration-mismatch expect=' + expect + ' real=' + real + ' gap=' + gap + ' src=' + (badSrc ? badSrc.platform + ':' + badSrc.id : '?'));
    // 先停掉这段错音频再换源。原来这里只换源不暂停：一旦后续源全失败，这段对不上的音频会一路播下去，
    // 用户看到的就是「列表标 04:48、播放条却在 34:12 继续唱」（《我不配》QQ 长音频串源即此）
    audio.pause();
    setPlaying(false);
    markBadSrc(badSrc, real);
    if (state.srcIndex + 1 >= order.length) {
      toast('该音源时长与标注不符（' + mins + '，应为 ' + want + '），可能不是原版（已无备用源），已停止播放');
      // 不卸空 audio 的话，这段 34:12 会一直挂在 audio.duration 上，条上总时长永远是错的
      unloadAudio();
      return;
    }
    toast('该平台返回的音频时长不符（' + mins + '，应为 ' + want + '），已自动换源');
    // 把这条源的失败原因接在前面，否则换源后 errs 被清空，最终提示里会丢掉"为什么这首播不了"
    const carried = Array.isArray(state.errChain) ? state.errChain.slice() : [];
    carried.push({ platform: badSrc ? badSrc.platform : '音源', reason: '音频时长与标注不符（' + mins + '，应为 ' + want + '），已跳过' });
    tryPlayFrom(state.srcIndex + 1, carried);
  }
});

audio.addEventListener('error', () => {
  if (!state.current) return;
  if (state.unloading) return;
  console.log('[switch] media-error', audio.error && audio.error.code, String(audio.src).slice(0, 60));
  tryPlayFrom(state.srcIndex + 1);
});

audio.addEventListener('playing', () => {
  setPlaying(true);
  toast('正在播放：' + (state.current ? state.current.name : ''));
});
audio.addEventListener('pause', () => setPlaying(false));

function setPlaying(v) {
  state.playing = v;
  $('playBtn').textContent = v ? '⏸' : '▶';
}

function updateNowPlaying(item) {
  $('barName').textContent = item.name;
  $('barArtist').textContent = item.artists;
  setCover($('barCover'), item.cover);
  $('npName').textContent = item.name;
  $('npArtist').textContent = item.artists;
  $('npAlbum').textContent = item.album ? '专辑：' + item.album : '';
  $('npPlat').innerHTML = item.sources
    .map((s) => '<span class="tag ' + s.platform + '" style="margin-right:6px">' + PLAT_LABEL[s.platform] + '</span>')
    .join('');
  setCover($('npCover'), item.cover);
  loadLyric(item);
  pushNowPlaying();
}

// 把当前曲目推给主进程：任务栏标题 / 托盘提示实时显示「歌名 - 歌手」，跟 QQ 音乐一个观感
function pushNowPlaying() {
  try {
    if (!window.baba || !window.baba.nowPlaying) return;
    const it = state.current;
    window.baba.nowPlaying({
      name: it ? it.name || '' : '',
      artist: it ? it.artists || '' : '',
      album: it ? it.album || '' : '',
      playing: !!(state.playing && !audio.paused),
    });
    // Windows 系统媒体控制（音量弹窗 / Win+G）也带上歌名歌手
    if (it && typeof MediaMetadata !== 'undefined' && navigator.mediaSession) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: it.name || '',
          artist: it.artists || '',
          album: it.album || '',
          artwork: it.cover ? [{ src: it.cover, sizes: '300x300' }] : [],
        });
      } catch (e) {}
    }
  } catch (e) {}
}

// 判断一个值是不是可用的封面地址：只认 http/https 绝对地址。
// 历史 bug：搜索结果打分把覆盖率写进了 cover 字段，封面会变成 "1" / "0.667" 这种数字，
// 这里统一兜住，非法的按无封面处理，走 CSS 里的音符占位。
function coverSrc(v) {
  if (!v) return '';
  const s = String(v).trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
}

// 封面为空时移除 src（避免 img 拿页面自身 URL 去请求，出现破图），
// 并退回 CSS 里的音符占位底图，未播放状态下也不会露出一块坏掉的贴图
function setCover(imgEl, url) {
  if (!imgEl) return;
  const src = coverSrc(url);
  if (src) {
    imgEl.onerror = () => {
      imgEl.removeAttribute('src');
      imgEl.style.visibility = 'visible';
    };
    imgEl.src = src;
    imgEl.style.visibility = 'visible';
  } else {
    imgEl.removeAttribute('src');
    imgEl.style.visibility = 'visible';
  }
}

async function loadLyric(item) {
  const ne = item.sources.find((s) => s.platform === 'netease');
  if (!ne) {
    $('lyricBox').textContent = '该曲目暂无歌词（歌词来自网易云）';
    return;
  }
  $('lyricBox').textContent = '歌词加载中…';
  try {
    const lrc = await window.baba.lyric('netease', ne.id);
    const plain = String(lrc || '')
      .split('\n')
      .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
      .filter(Boolean)
      .join('\n');
    $('lyricBox').textContent = plain || '暂无歌词';
  } catch (e) {
    $('lyricBox').textContent = '暂无歌词';
  }
}

/* ---------------- 进度与音量 ---------------- */
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  // 总时长不再直接取 audio.duration：坏源（34:12 长音频）的值不能显示到条上
  syncBarTime();
});

audio.addEventListener('loadedmetadata', () => {
  syncBarTime();
});

$('progress').addEventListener('input', () => {
  if (!audio.duration) return;
  audio.currentTime = (Number($('progress').value) / 1000) * audio.duration;
});

$('volume').addEventListener('input', () => {
  state.volume = clamp01(Number($('volume').value) / 100);
  audio.volume = state.volume;
  saveVolumeSoon();
});

// 音量写盘：拖动时不刷盘，松手 400ms 后再写，避免一路拖动疯狂写配置文件
let volumeSaveTimer = 0;
function saveVolumeSoon() {
  if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => {
    volumeSaveTimer = 0;
    if (window.baba && window.baba.saveSettings) window.baba.saveSettings({ volume: state.volume });
  }, 400);
}

function clamp01(v) {
  if (!isFinite(v)) return 0.8;
  return Math.min(1, Math.max(0, v));
}

/* ---------------- 歌词延迟补偿（逐字特效对不齐时手动微调） ---------------- */
// 歌词所有时间定位都走这里：真实播放进度 + 补偿值（毫秒，负=提前，正=延后）
function lyricNow() {
  const t = Number(audio.currentTime) || 0;
  const off = Number(state.lyricOffset) || 0;
  return Math.max(0, t + off / 1000);
}

function lyricOffsetText(v) {
  if (!v) return '不补偿';
  return (v > 0 ? '延后 ' : '提前 ') + Math.abs(v) + 'ms';
}

function applyLyricOffsetUi() {
  const v = Math.round(Number(state.lyricOffset) || 0);
  const r = $('lyricOffsetRange');
  if (r) r.value = String(v);
  const txt = $('lyricOffsetVal');
  if (txt) txt.textContent = lyricOffsetText(v);
  // 主窗那句高亮/逐字也跟着重算，改完立刻能看到差别
  try { if (typeof syncLyric === 'function') syncLyric(true); } catch (e) { /* 歌词还没加载 */ }
  // 顺手重推一次给桌面歌词，省得等下一句才生效（还没歌词时不推，别把窗口刷成空）
  try {
    if (lyricLines.length && typeof pushLyricState === 'function') pushLyricState();
  } catch (e) { /* 同上 */ }
}

let offsetSaveTimer = 0;
function saveLyricOffsetSoon() {
  if (offsetSaveTimer) clearTimeout(offsetSaveTimer);
  offsetSaveTimer = setTimeout(() => {
    offsetSaveTimer = 0;
    if (window.baba && window.baba.saveSettings) window.baba.saveSettings({ lyricOffset: state.lyricOffset });
  }, 400);
}

function bindLyricOffset() {
  const r = $('lyricOffsetRange');
  if (!r) return;
  r.addEventListener('input', () => {
    state.lyricOffset = Math.max(-1000, Math.min(1000, Math.round(Number(r.value) || 0)));
    applyLyricOffsetUi();
    saveLyricOffsetSoon();
  });
  // 双击直接回零，调歪了方便复位
  r.addEventListener('dblclick', () => {
    state.lyricOffset = 0;
    applyLyricOffsetUi();
    saveLyricOffsetSoon();
  });
  applyLyricOffsetUi();
}
// 等本文件的 let/const 都初始化完再绑，避免踩暂时性死区
setTimeout(bindLyricOffset, 0);

$('playBtn').addEventListener('click', () => {
  if (!audio.src) {
    if (state.results.length) playItem(state.results[0]);
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
});

$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));

/* 播放模式：顺序 / 列表循环 / 单曲循环 / 随机，按钮在「上一曲」左边 */
// 播放模式图标（方案 A：2px 描边 + 圆头端点，24 viewBox，与上一曲/下一曲同一套线性风格）
const PLAY_MODE_ICONS = {
  order: '<path d="M4 7h9"/><path d="M4 12h9"/><path d="M4 17h6"/><path d="M17.5 5.5v13"/><path d="M13.5 14.8l4 4 4-4"/>',
  loop: '<path d="M17 3.6l3 3-3 3"/><path d="M20 6.6H8.6A4.6 4.6 0 0 0 4 11.2v.6"/><path d="M7 20.4l-3-3 3-3"/><path d="M4 17.4h11.4A4.6 4.6 0 0 0 20 12.8v-.6"/>',
  single: '<path d="M17 3.6l3 3-3 3"/><path d="M20 6.6H8.6A4.6 4.6 0 0 0 4 11.2v.6"/><path d="M7 20.4l-3-3 3-3"/><path d="M4 17.4h11.4A4.6 4.6 0 0 0 20 12.8v-.6"/><path d="M10.6 10.6l1.7-1.1v5.4"/><path d="M9.9 15.2h4.6"/>',
  shuffle: '<path d="M4 6.4h3.1c1.2 0 2.3.6 3 1.6l3.8 6c.7 1 1.8 1.6 3 1.6H20"/><path d="M17 3.4l3 3-3 3"/><path d="M4 17.6h3.1c1.2 0 2.3-.6 3-1.6l.9-1.4"/><path d="M13.6 8.9l.7-1.1c.7-1 1.8-1.6 3-1.6H20"/><path d="M17 14.6l3 3-3 3"/>',
};

// 统一包一层 svg，属性与其它控制键保持一致
function playModeSvg(mode) {
  return (
    '<svg class="ico-svg mode-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (PLAY_MODE_ICONS[mode] || PLAY_MODE_ICONS.order) +
    '</svg>'
  );
}

const PLAY_MODES = [
  { value: 'order', label: '顺序播放', short: '顺序' },
  { value: 'loop', label: '列表循环', short: '循环' },
  { value: 'single', label: '单曲循环', short: '单曲' },
  { value: 'shuffle', label: '随机播放', short: '随机' },
];

function renderPlayMode() {
  const btn = $('modeBtn');
  if (!btn) return;
  const m = PLAY_MODES.find((x) => x.value === state.playMode) || PLAY_MODES[0];
  const t = btn.querySelector('#modeText');
  // 图标按模式切换；同模式重复渲染不重绘，避免点击时闪一下
  if (t && t.dataset.mode !== m.value) {
    t.innerHTML = playModeSvg(m.value);
    t.dataset.mode = m.value;
  }
  btn.title = '播放模式：' + m.label + '（点击切换）';
  btn.setAttribute('aria-label', '播放模式：' + m.label);
  btn.dataset.mode = m.value;
}

function setPlayMode(v, save) {
  state.playMode = PLAY_MODES.some((x) => x.value === v) ? v : 'order';
  renderPlayMode();
  if (save && window.baba && window.baba.saveSettings) window.baba.saveSettings({ playMode: state.playMode });
}

$('modeBtn').addEventListener('click', () => {
  const i = PLAY_MODES.findIndex((x) => x.value === state.playMode);
  const next = PLAY_MODES[(i + 1) % PLAY_MODES.length];
  setPlayMode(next.value, true);
  toast('播放模式：' + next.label);
});

// 随机挑一个不等于当前的下标（列表只有一首时原样返回）
function randomOtherIndex(len, cur) {
  if (len <= 1) return cur;
  let n = cur;
  for (let i = 0; i < 24 && n === cur; i += 1) n = Math.floor(Math.random() * len);
  return n === cur ? (cur + 1) % len : n;
}

function step(delta) {
  const list = state.queue && state.queue.length ? state.queue : state.results;
  if (!state.current || !list || !list.length) return;
  const idx = list.findIndex((x) => x.key === state.current.key);
  if (idx < 0) {
    playItem(list[0], list);
    return;
  }
  let n;
  if (state.playMode === 'shuffle') {
    n = randomOtherIndex(list.length, idx);
  } else {
    n = idx + delta;
    // 手动点上一曲/下一曲：顺序播放在列表两端停住，循环模式绕回去
    if (n < 0) n = state.playMode === 'order' ? 0 : list.length - 1;
    if (n >= list.length) n = state.playMode === 'order' ? list.length - 1 : 0;
  }
  const next = list[n];
  if (next && next.key !== state.current.key) playItem(next, list);
}

// 一首播完自动接下一首：单曲循环重播、随机挑、顺序到末尾停、列表循环绕回
function onTrackEnded() {
  const list = state.queue && state.queue.length ? state.queue : state.results;
  if (!state.current || !list || !list.length) return;
  if (state.playMode === 'single') {
    try {
      audio.currentTime = 0;
      audio.play();
    } catch (e) {}
    return;
  }
  const idx = list.findIndex((x) => x.key === state.current.key);
  if (idx < 0) return;
  let n;
  if (state.playMode === 'shuffle') {
    n = randomOtherIndex(list.length, idx);
  } else {
    n = idx + 1;
    if (n >= list.length) {
      if (state.playMode !== 'loop') return;
      n = 0;
    }
  }
  if (list[n]) playItem(list[n], list);
}

/* ---------------- 视图与设置 ---------------- */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

$('searchBtn').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    $('playBtn').click();
  }
});

$('sortSelect').addEventListener('change', () => {
  const v = $('sortSelect').value;
  // 热度排序已取消，老配置/老页面残留的 hot 一律按评论总数处理
  state.sortMode = v || 'comments';
  window.baba.saveSettings({ sortMode: state.sortMode });
  rerenderSorted();
});

$('preferSelect').addEventListener('change', () => {
  state.prefer = $('preferSelect').value;
  window.baba.saveSettings({ preferPlatform: state.prefer });
});

// 音质选择：档位由低到高，auto = 跟随账号（未登录走酷我音质，登录后按所在平台会员音质）
const QUALITY_LABEL = {
  auto: '自动（跟随账号）',
  '128': '标准 128kbps',
  '192': '较高 192kbps',
  '320': '高品质 320kbps',
  flac: '无损 FLAC',
};
function applyQualityUi(s) {
  if (!$('qualitySelect')) return;
  const sel = (s && s.quality) || 'auto';
  $('qualitySelect').value = sel;
  // 手动指定的档位就是实际档位；auto 才按账号解析出的生效档位显示
  const eff =
    (sel !== 'auto' ? QUALITY_LABEL[sel] : '') ||
    (s && s.qualityEffLabel) ||
    QUALITY_LABEL[(s && s.qualityEff) || '128'] ||
    '';
  const hint = $('qualityHint');
  if (hint) {
    hint.textContent =
      '当前实际取流：' +
      eff +
      '（' +
      (sel === 'auto' ? '跟随账号：未登录默认酷我音质，登录后按所在平台会员音质' : '已手动指定档位') +
      '）';
  }
}
if ($('qualitySelect')) {
  $('qualitySelect').addEventListener('change', async () => {
    const v = $('qualitySelect').value;
    try {
      await window.baba.saveSettings({ quality: v });
    } catch (e) {
      /* 保存失败也给出提示，别让界面静默 */
    }
    let s = null;
    try {
      s = await window.baba.getSettings();
    } catch (e) {
      s = { quality: v };
    }
    applyQualityUi(s || { quality: v });
    toast('音质已切换为：' + (QUALITY_LABEL[v] || v));
  });
}

// 关闭窗口时的行为：默认收进托盘，改成 quit 就点了关闭直接退出
if ($('closeActionSelect')) {
  $('closeActionSelect').addEventListener('change', () => {
    const v = $('closeActionSelect').value;
    window.baba.saveSettings({ closeAction: v });
    toast(v === 'tray' ? '关闭窗口后将最小化到托盘' : '关闭窗口后将直接退出程序');
  });
}

document.querySelectorAll('[data-login]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const plat = btn.dataset.login;
    toast('请在弹出的窗口完成扫码登录');
    const r = await window.baba.login(plat);
    if (r && r.ok) {
      toast(PLAT_LABEL[plat] + ' 登录成功');
      refreshStatus();
    } else {
      toast('未检测到登录状态');
    }
  });
});

document.querySelectorAll('[data-logout]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await window.baba.logout(btn.dataset.logout);
    toast('已退出');
    refreshStatus();
  });
});

// 登录态渲染只在文件后半段维护一份（见「左下角改成真正的登录状态」那处）。
// 这里原先还有一份旧实现，函数声明同名会把新实现覆盖回去，已删除。
refreshStatus();

/* ---------------- 版本与更新 ---------------- */
// 状态口径与主进程一致：idle / dev / checking / available / not-available / downloading / downloaded / error
let updateStatus = 'idle';

function renderUpdateState(s) {
  if (!s) return;
  const cur = s.currentVersion ? 'v' + s.currentVersion : '';
  const latest = s.info && s.info.version ? 'v' + s.info.version : '';
  const txt = $('updateStatusText');
  const notes = $('updateNotesText');
  const btnCheck = $('checkUpdateBtn');
  const btnDown = $('downloadUpdateBtn');
  const btnInst = $('installUpdateBtn');
  const setShown = (el, on) => {
    if (el) el.hidden = !on;
  };

  let main = '当前版本 ' + cur;
  switch (s.status) {
    case 'dev':
      main = '当前版本 ' + cur + '（源码运行，自动更新只在安装版生效）';
      break;
    case 'checking':
      main = '正在检查更新…（当前 ' + cur + '）';
      break;
    case 'available':
      main = '发现新版本 ' + latest + '，当前 ' + cur;
      break;
    case 'not-available':
      main = '已是最新版本 ' + cur;
      break;
    case 'downloading':
      main = '正在下载 ' + latest + '（' + (s.progress || 0) + '%）';
      break;
    case 'downloaded':
      main = '新版本 ' + latest + ' 已下载完成，重启即可安装';
      break;
    case 'error':
      main = '更新检查失败：' + (s.error || '未知错误');
      break;
    default:
      main = '当前版本 ' + cur;
  }
  if (txt) txt.textContent = main;

  if (notes) {
    const body = s.info && s.info.notes ? s.info.notes : '';
    notes.textContent = s.status === 'available' || s.status === 'downloaded' ? body : '';
    notes.hidden = !notes.textContent;
  }

  setShown(btnCheck, s.status !== 'downloading' && s.status !== 'downloaded');
  setShown(btnDown, s.status === 'available');
  setShown(btnInst, s.status === 'downloaded');
  updateStatus = s.status;
}

async function refreshUpdateState() {
  try {
    renderUpdateState(await window.baba.getUpdateState());
  } catch (e) {
    /* 读不到状态就保持默认文案 */
  }
}

if (window.baba && window.baba.onUpdateEvent) {
  window.baba.onUpdateEvent((p) => {
    if (!p) return;
    const prev = updateStatus;
    renderUpdateState(p);
    if (p.status === 'available' && prev !== 'available') {
      toast('发现新版本 v' + ((p.info && p.info.version) || ''));
    } else if (p.status === 'downloaded' && prev !== 'downloaded') {
      toast('更新已下载完成，点"重启安装"即可升级');
    }
  });
}

if ($('checkUpdateBtn')) {
  $('checkUpdateBtn').addEventListener('click', async () => {
    const btn = $('checkUpdateBtn');
    btn.disabled = true;
    btn.textContent = '检查中…';
    try {
      const r = await window.baba.checkUpdate();
      renderUpdateState(r);
      if (!r || !r.ok) {
        toast((r && r.error) || '检查更新失败，请稍后重试');
      } else if (r.status === 'available') {
        toast('发现新版本 v' + ((r.info && r.info.version) || ''));
      } else if (r.status === 'not-available') {
        toast('已是最新版本 v' + r.currentVersion);
      } else if (r.status === 'dev') {
        toast('源码运行状态下不支持自动更新，安装版可用');
      }
    } catch (e) {
      toast('检查更新失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '检查更新';
    }
  });
}

if ($('downloadUpdateBtn')) {
  $('downloadUpdateBtn').addEventListener('click', async () => {
    toast('开始下载新版本…');
    const r = await window.baba.downloadUpdate();
    renderUpdateState(r);
    if (!r || !r.ok) toast((r && r.error) || '下载失败，请稍后重试');
  });
}

if ($('installUpdateBtn')) {
  $('installUpdateBtn').addEventListener('click', async () => {
    const btn = $('installUpdateBtn');
    btn.disabled = true;
    toast('正在重启并安装新版本…');
    const r = await window.baba.installUpdate();
    if (!r || !r.ok) {
      btn.disabled = false;
      toast((r && r.error) || '安装失败，请手动重新下载安装包');
    }
  });
}

if ($('releasePageBtn')) {
  $('releasePageBtn').addEventListener('click', () => window.baba.openReleasePage());
}

refreshUpdateState();

// 搜索先返回列表，评论数是后端随后补的，补到一条更新一条
if (window.baba && window.baba.onMeta) {
  window.baba.onMeta((p) => {
    if (!p) return;
    const it = state.results.find((x) => x.key === p.key);
    if (!it) return;
    if (typeof p.comments === 'number') it.comments = p.comments;
    // known 必须一起同步：只给 comments 不带标记，界面分不清「真 0 条」和「没查到」，评论列会一直显示 —
    if (typeof p.commentsKnown === 'boolean') it.commentsKnown = p.commentsKnown;
    if (p.commentsDetail) it.commentsDetail = p.commentsDetail;
    rerenderSorted();
  });
}

// 首次启动给出提示
setTimeout(() => {
  toast('BBMusic 已就绪，搜首歌试试');
}, 600);


/* ================= UI 强化补丁：统一配色 / 平台状态 / 滚动歌词 ================= */
const ICON_PLAY =
  '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.4 5.15v13.7a1.05 1.05 0 0 0 1.6.9l10.95-6.85a1.05 1.05 0 0 0 0-1.8L10 4.25a1.05 1.05 0 0 0-1.6.9z"/></svg>';
const ICON_PAUSE =
  '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.5"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.5"/></svg>';

// 播放/暂停、上下一曲统一走「橙 + 白」：主键橙底白图形，副键白底橙图形，状态切换不改配色
function setPlaying(v) {
  state.playing = !!v;
  const btn = $('playBtn');
  if (btn) {
    btn.innerHTML = v ? ICON_PAUSE : ICON_PLAY;
    btn.setAttribute('aria-label', v ? '暂停' : '播放');
  }
  const cover = $('npCover');
  if (cover) cover.classList.toggle('spin', !!v);
  // 逐字效果靠帧循环推进，暂停后停掉省电
  if (v) startKaraoke();
  // 播放/暂停都要同步一次任务栏标题与系统媒体信息
  pushNowPlaying();
}

let lyricLines = [];

/* ---------------- 歌词动效 / 桌面歌词 基础件 ---------------- */
// 下拉框可选的滚动效果；桌面歌词窗口用的是同一套名字与关键帧
const LYRIC_FX_LIST = ['fade', 'plain', 'fly', 'rise', 'zoom', 'blur', 'karaoke'];
const LYRIC_OFFSET = 0.12;
let lyrFx = 'fade';
let karaokeRAF = 0;

// 歌词颜色主题（与 main.js 的 LYRIC_COLORS 保持一致）
const LYRIC_COLORS = {
  orange: { label: '活力橙', hi: '#ff7a1a', dim: '#dccab9', glow: 'rgba(255, 122, 26, .55)' },
  pink: { label: '樱花粉', hi: '#ff5c94', dim: '#e0c4cf', glow: 'rgba(255, 92, 148, .55)' },
  blue: { label: '天青蓝', hi: '#2f8bff', dim: '#c2cddb', glow: 'rgba(47, 139, 255, .55)' },
  green: { label: '抹茶绿', hi: '#25a86b', dim: '#c2d3c7', glow: 'rgba(37, 168, 107, .55)' },
  purple: { label: '星河紫', hi: '#8a5cff', dim: '#cbc3e4', glow: 'rgba(138, 92, 255, .55)' },
  white: { label: '珍珠白', hi: '#ffffff', dim: '#d7cfc6', glow: 'rgba(255, 255, 255, .5)' },
  rainbow: { label: '彩虹渐变', hi: '#ff7a1a', dim: '#dccab9', glow: 'rgba(255, 122, 26, .55)' },
};
let lyrColor = 'orange';

function applyLyricColor(mode, save) {
  lyrColor = Object.prototype.hasOwnProperty.call(LYRIC_COLORS, mode) ? mode : 'orange';
  const c = LYRIC_COLORS[lyrColor];
  const root = document.documentElement;
  root.style.setProperty('--lyric-hi', c.hi);
  root.style.setProperty('--lyric-dim', c.dim);
  root.style.setProperty('--lyric-glow', c.glow);
  // 彩虹用渐变文字，单独挂类
  if (document.body) document.body.classList.toggle('lc-rainbow', lyrColor === 'rainbow');
  const a = $('lyricColorSelect');
  if (a && a.value !== lyrColor) a.value = lyrColor;
  const b = $('lyricColorQuick');
  if (b && b.value !== lyrColor) b.value = lyrColor;
  if (save) {
    if (window.baba && window.baba.saveSettings) window.baba.saveSettings({ lyricColor: lyrColor });
    pushLyricState();
  }
  return lyrColor;
}

// 一句歌词真正被唱出来的时长：起唱空档 + 每字时长，且不超过到下一句的间隔。
// 关键点：不能再拿"到下一句的时间"当演唱时长——中间夹着间奏时，
// 那一行会被拉成几倍长，逐字进度就明显跟不上唱（长间奏能差 7 倍）。
const LYRIC_PER_CHAR = 0.22;
const LYRIC_LEAD = 0.30;
function lineSingSpan(cur, next) {
  const gap = next ? Math.max(0.35, next.t - cur.t) : Math.max(3, (audio.duration || cur.t + 4) - cur.t);
  // 有声字（去掉标点/空白）才算时长，纯标点行按最短处理
  const voiced = String(cur.text || '').replace(/[\s\p{P}]/gu, '').length;
  const est = LYRIC_LEAD + LYRIC_PER_CHAR * Math.max(1, voiced);
  return Math.max(0.6, Math.min(est, gap));
}

const FX_ANIM = {
  fade: [
    { opacity: 0.1, transform: 'translateY(10px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  fly: [
    { opacity: 0, transform: 'translateX(58px) scale(.94)' },
    { opacity: 1, transform: 'translateX(0) scale(1)' },
  ],
  rise: [
    { opacity: 0, transform: 'translateY(26px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  zoom: [
    { opacity: 0, transform: 'scale(.78)' },
    { opacity: 1, transform: 'scale(1)' },
  ],
  blur: [
    { opacity: 0.2, filter: 'blur(7px)' },
    { opacity: 1, filter: 'blur(0px)' },
  ],
};

// 按当前进度找到应该高亮的行号
function curLyricIndex(t) {
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].t <= t + LYRIC_OFFSET) idx = i;
    else break;
  }
  return idx < 0 ? 0 : idx;
}

function playLyricFx(el, mode) {
  if (!el || typeof el.animate !== 'function') return;
  const kf = FX_ANIM[mode];
  if (!kf) return;
  try {
    el.animate(kf, { duration: 460, easing: 'cubic-bezier(.2,.86,.28,1)', fill: 'both' });
  } catch (e) {
    /* 动画不支持就退化成纯颜色变化 */
  }
}

// 逐字模式：按「本行时长」推进 --lp，桌面歌词用的是同一算法
function karaokeTick() {
  karaokeRAF = 0;
  const box = $('lyricBox');
  if (!box || !lyricLines.length || lyrFx !== 'karaoke') return;
  const t = lyricNow();
  const idx = curLyricIndex(t);
  const cur = lyricLines[idx];
  const next = lyricLines[idx + 1];
  if (cur) {
    // 用「这句唱多久」推进，唱完就停在 100%，间奏期间不再慢慢爬
    const span = lineSingSpan(cur, next);
    const p = Math.max(0, Math.min(1, (t - cur.t - LYRIC_LEAD) / Math.max(0.2, span - LYRIC_LEAD)));
    const el = box.querySelector('.lyric-line[data-i="' + idx + '"]');
    if (el) el.style.setProperty('--lp', (p * 100).toFixed(2) + '%');
  }
  if (state.playing) karaokeRAF = requestAnimationFrame(karaokeTick);
}

function startKaraoke() {
  if (lyrFx === 'karaoke' && !karaokeRAF) karaokeRAF = requestAnimationFrame(karaokeTick);
}

function applyLyricFx(mode, save) {
  lyrFx = LYRIC_FX_LIST.indexOf(mode) >= 0 ? mode : 'fade';
  const box = $('lyricBox');
  if (box) LYRIC_FX_LIST.forEach((m) => box.classList.toggle('fx-' + m, m === lyrFx));
  const sel = $('lyricFxSelect');
  if (sel && sel.value !== lyrFx) sel.value = lyrFx;
  if (lyrFx === 'karaoke') {
    karaokeTick();
    startKaraoke();
  } else {
    // 退出逐字模式时清掉残留的行内进度，避免颜色卡在中间
    if (box) box.querySelectorAll('.lyric-line').forEach((el) => el.style.removeProperty('--lp'));
  }
  // 立刻重播一次当前行动画，切换效果马上能看见
  if (box) playLyricFx(box.querySelector('.lyric-line.active'), lyrFx);
  if (save && window.baba && window.baba.saveSettings) window.baba.saveSettings({ lyricFx: lyrFx });
  pushLyricState();
  return lyrFx;
}

// 把当前两句歌词 + 时间窗推给桌面歌词窗口，让它自己按帧推进进度
function pushLyricState(idx) {
  if (!window.baba || !window.baba.pushLyricState) return;
  const box = $('lyricBox');
  const i = typeof idx === 'number' ? idx : box && box.dataset.cur !== '' ? Number(box.dataset.cur) : -1;
  const cur = lyricLines[i] || null;
  const next = lyricLines[i + 1] || null;
  const curT = cur ? cur.t : 0;
  const nextT = next ? next.t : Math.max(curT + 6, audio.duration || curT + 6);
  window.baba.pushLyricState({
    cur: cur ? cur.text : '',
    next: next ? next.text : '',
    curT: curT,
    nextT: nextT,
    // 推送瞬间的真实进度，桌面歌词从这儿往后自己推，避免慢半句
    t: lyricNow(),
    playing: !!state.playing && !audio.paused,
    fx: lyrFx,
    color: lyrColor,
    // 这句真正唱多久 + 起唱空档，桌面歌词照着它推进逐字进度，
    // 免得拿 curT→nextT 的间隔当演唱时长，间奏长时进度就被拖慢
    dur: cur ? lineSingSpan(cur, next) : 0,
    lead: LYRIC_LEAD,
    empty: !lyricLines.length,
    name: state.current ? state.current.name || '' : '',
    artists: state.current ? state.current.artists || '' : '',
    sentAt: Date.now(),
  });
}

function fmtSec(v) {
  return Number(v) || 0;
}

function parseLrc(text) {
  const out = [];
  if (!text) return out;
  String(text)
    .split(/\r?\n/)
    .forEach((raw) => {
      const tags = raw.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
      if (!tags) return;
      const body = raw.replace(/\[[^\]]*\]/g, '').trim();
      if (!body) return;
      tags.forEach((tag) => {
        const m = tag.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
        if (!m) return;
        const ms = m[3] ? Number(('0.' + m[3]).slice(0, 5)) : 0;
        out.push({ t: fmtSec(m[1]) * 60 + fmtSec(m[2]) + ms, text: body });
      });
    });
  out.sort((a, b) => a.t - b.t);
  return out;
}

function renderLyric(lines, tip) {
  const box = $('lyricBox');
  if (!box) return;
  if (!lines || !lines.length) {
    lyricLines = [];
    box.dataset.cur = '';
    box.innerHTML = '<div class="lyric-empty">' + esc(tip || '暂无歌词') + '</div>';
    pushLyricState(-1);
    return;
  }
  lyricLines = lines;
  box.dataset.cur = '';
  // data-t 存这一行的时间轴，点击歌词行就能跳到该位置播放
  box.innerHTML = lines
    .map(
      (l, i) =>
        '<div class="lyric-line" data-i="' +
        i +
        '" data-t="' +
        Number(l.t || 0).toFixed(3) +
        '" data-text="' +
        esc(l.text) +
        '" title="点击跳到这一句">' +
        esc(l.text) +
        '</div>'
    )
    .join('');
  syncLyric(true);
}

// 按播放进度高亮当前行、播放选中效果并平滑滚动到中间
function syncLyric(force) {
  const box = $('lyricBox');
  if (!box || !lyricLines.length) return;
  const t = lyricNow();
  const idx = curLyricIndex(t);
  if (!force && box.dataset.cur === String(idx)) return;
  box.dataset.cur = String(idx);
  const rows = box.querySelectorAll('.lyric-line');
  rows.forEach((r, i) => r.classList.toggle('active', i === idx));
  const cur = rows[idx];
  if (cur) {
    // 新的一行进来时按当前效果播一次入场动画（平淡/逐字走纯样式，不播动画）
    playLyricFx(cur, lyrFx);
    // offsetTop 的 offsetParent 不一定是歌词容器，改用视口矩形差值计算滚动量
    const bRect = box.getBoundingClientRect();
    const cRect = cur.getBoundingClientRect();
    const delta = cRect.top - bRect.top;
    const target = box.scrollTop + delta - box.clientHeight * 0.42;
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
  if (lyrFx === 'karaoke') karaokeTick();
  startKaraoke();
  pushLyricState(idx);
}

async function loadLyric(item) {
  const box = $('lyricBox');
  const from = $('lyricFrom');
  lyricLines = [];
  if (from) from.textContent = '滚动歌词';
  if (!item) {
    renderLyric([], '播放后歌词会自动滚动高亮');
    return;
  }
  if (box) box.innerHTML = '<div class="lyric-tip">歌词加载中…</div>';
  const sources = item.sources || [];
  const ne = sources.find((s) => s.platform === 'netease');
  const first = ne || sources[0] || null;
  let r = null;
  try {
    r = await window.baba.lyric(
      first ? first.platform : 'netease',
      first ? first.id : '',
      item.name || '',
      item.artists || ''
    );
  } catch (e) {
    r = null;
  }
  // 切歌过快时丢弃过期结果，避免歌词串到上一首
  if (state.current && item.key && state.current.key !== item.key) return;
  const lrc = r && typeof r === 'object' ? r.lrc || '' : r || '';
  const lines = parseLrc(lrc);
  if (lines.length) {
    renderLyric(lines);
    if (from) from.textContent = ne ? '来自网易云' : '来自网易云同款匹配';
  } else {
    renderLyric([], '这首歌暂时没取到歌词（QQ / 酷我可按同名同歌手匹配网易云歌词）');
    if (from) from.textContent = '暂无歌词';
  }
}

function updateNowPlaying(item) {
  if (!item) return;
  const name = item.name || '未在播放';
  const artists = item.artists || '—';
  if ($('barName')) $('barName').textContent = name;
  if ($('barArtist')) $('barArtist').textContent = artists;
  if ($('npName')) $('npName').textContent = name;
  if ($('npArtist')) $('npArtist').textContent = artists;
  if ($('npAlbum')) $('npAlbum').textContent = item.album ? '专辑：' + item.album : '';
  const plat = $('npPlat');
  if (plat) {
    // 按实际取链顺序展示；替代音源（原平台 VIP/版权不可播时补的）加「·替代」后缀
    plat.innerHTML = orderSources(item)
      .map(
        (s) =>
          '<span class="tag ' +
          s.platform +
          '" title="' +
          (s.alt ? '原平台不可播，已用该平台音源替代' : '原生音源') +
          '">' +
          (PLAT_LABEL[s.platform] || s.platform) +
          (s.alt ? '·替代' : '') +
          '</span>'
      )
      .join('');
  }
  setCover($('barCover'), item.cover);
  setCover($('npCover'), item.cover);
  loadLyric(item);
  syncFavBtn();
}

// 左下角改成真正的登录状态：绿色=已登录，灰色=未登录，黄点=免登录可用
async function refreshStatus() {
  let s = {};
  try {
    s = (await window.baba.getSettings()) || {};
  } catch (e) {
    s = {};
  }
  // 主动问一次真实的登录态（24 小时内有缓存就直接用，命中时几乎无延迟）。
  // 只判断 cookie 字符串非空是不够的：cookie 过期后界面会一直亮绿灯。
  try {
    const st = await window.baba.authCheck(false);
    if (st) s.authState = st;
  } catch (e) {
    /* 检测失败不阻塞界面，退回缓存/默认值 */
  }
  const as = s.authState || {};
  const neRec = as.netease || { state: s.neteaseLogged ? 'ok' : 'off' };
  const qqRec = as.qq || { state: s.qqLogged ? 'ok' : 'off' };
  const ne = neRec.state === 'ok';
  const qq = qqRec.state === 'ok';
  // 三态配色：ok 绿 / off 灰 / err 与 unknown 黄（检测中或没测出来，既不冒充已登录也不误判为未登录）
  const neCls = neRec.state === 'ok' ? 'on' : neRec.state === 'off' ? 'off' : 'warn';
  const qqCls = qqRec.state === 'ok' ? 'on' : qqRec.state === 'off' ? 'off' : 'warn';
  state.logged = { netease: ne, qq: qq };
  if (s.sortMode) state.sortMode = s.sortMode;
  if (s.preferPlatform) state.prefer = s.preferPlatform;
  const sortSel = $('sortSelect');
  if (sortSel && s.sortMode && Array.prototype.some.call(sortSel.options, (o) => o.value === s.sortMode)) {
    sortSel.value = s.sortMode;
    state.sortMode = s.sortMode;
  }
  if ($('preferSelect') && s.preferPlatform) $('preferSelect').value = s.preferPlatform;
  // 关闭行为也要回填，否则下拉框启动后总停在下拉第一项，和实际配置对不上
  if ($('closeActionSelect')) $('closeActionSelect').value = s.closeAction || 'tray';
  // 歌词滚动效果跟着配置走，重启后保持上次选择
  applyLyricFx(s.lyricFx || lyrFx, false);
  // 歌词颜色也按配置回填
  applyLyricColor(s.lyricColor || lyrColor, false);
  // 播放模式回填
  setPlayMode(s.playMode || 'order', false);
  // 音量回填：恢复上次关闭时的音量（以前这里没回填，所以每次开机都是 80%）
  const savedVol = Number(s.volume);
  if (isFinite(savedVol) && savedVol >= 0 && savedVol <= 1) state.volume = savedVol;
  audio.volume = clamp01(state.volume);
  if ($('volume')) $('volume').value = String(Math.round(clamp01(state.volume) * 100));
  // 歌词延迟补偿回填
  const savedOff = Number(s.lyricOffset);
  if (isFinite(savedOff)) state.lyricOffset = Math.max(-1000, Math.min(1000, Math.round(savedOff)));
  applyLyricOffsetUi();
  // 桌面歌词字号也回填，别每次重启跳回标准
  if ($('dlFontSelect')) $('dlFontSelect').value = String(s.lyricFont || 34);
  // 音质下拉也回填，并显示当前账号下实际生效的档位
  applyQualityUi(s);
  refreshDesktopLyricBtn();

  // 状态文案按三态给：已登录带上平台返回的真实昵称（网易云带会员类型），失败时说明原因而不是笼统说「未登录」
  const fmtNe = () => {
    if (neRec.state === 'ok') {
      const vip =
        neRec.vipType === 12 ? '黑胶 SVIP' : neRec.vipType === 11 ? '黑胶 VIP' : neRec.vipType === 10 ? '音乐包' : '';
      return '已登录：' + (neRec.nick || '账号') + (vip ? '（' + vip + '）' : '');
    }
    if (neRec.state === 'unknown') return '检测中…';
    if (neRec.state === 'err') return '检测失败（' + (neRec.err || '网络异常') + '），点此重试';
    return neRec.err && neRec.err.indexOf('未设置') === -1 ? '未登录（' + neRec.err + '）' : '未登录（仅能播放部分免费曲目）';
  };
  const fmtQq = () => {
    if (qqRec.state === 'ok') return '已登录：' + (qqRec.nick || '账号') + (qqRec.uin ? '（uin ' + qqRec.uin + '）' : '');
    if (qqRec.state === 'unknown') return '检测中…';
    if (qqRec.state === 'err') return '检测失败（' + (qqRec.err || '网络异常') + '），点此重试';
    return qqRec.err && qqRec.err.indexOf('未设置') === -1 ? '未登录（' + qqRec.err + '）' : '未登录（部分曲目取不到音源）';
  };
  if ($('neStatus')) $('neStatus').textContent = fmtNe();
  if ($('qqStatus')) $('qqStatus').textContent = fmtQq();

  const box = $('platStatus');
  if (box) {
    const short = (rec, okTxt) => (rec.state === 'ok' ? okTxt : rec.state === 'off' ? '未登录' : rec.state === 'unknown' ? '检测中' : '检测失败');
    const rows = [
      { name: '网易云', cls: neCls, txt: short(neRec, '已登录') },
      { name: 'QQ音乐', cls: qqCls, txt: short(qqRec, '已登录') },
      { name: '酷我', cls: 'free', txt: '免登录' },
    ];
    box.innerHTML = rows
      .map(
        (r) =>
          '<span class="plat-row"><i class="dot ' +
          r.cls +
          '"></i><span class="pname">' +
          r.name +
          '</span><span class="pstate">' +
          r.txt +
          '</span></span>'
      )
      .join('');
    // 点一下强制重测（忽略 24h 缓存），换号或 cookie 刚过期时不用重启
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.title = '点击重新检测登录状态';
      box.style.cursor = 'pointer';
      box.addEventListener('click', async () => {
        box.innerHTML = '<span class="plat-row"><span class="pstate">正在检测登录状态…</span></span>';
        try {
          await window.baba.authCheck(true);
        } catch (e) {
          /* 失败交给下面 refreshStatus 呈现 err 态 */
        }
        refreshStatus();
      });
    }
  }
}

audio.addEventListener('timeupdate', () => syncLyric(false));
audio.addEventListener('seeked', () => syncLyric(true));
audio.addEventListener('play', () => setPlaying(true));
audio.addEventListener('pause', () => setPlaying(false));
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'playing') setTimeout(() => syncLyric(true), 80);
  });
});

setPlaying(false);
refreshStatus();

/* ================= 点击歌词跳转 / 效果开关 / 桌面歌词 ================= */
const FX_LABEL = {
  fade: '淡入',
  plain: '平淡',
  fly: '飞入',
  rise: '上浮',
  zoom: '弹跳',
  blur: '聚焦',
  karaoke: '逐字',
};

// 点歌词行就跳到该句的时间点，跟网易云一样点了继续放
const lyricBoxEl = $('lyricBox');
if (lyricBoxEl) {
  lyricBoxEl.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.lyric-line') : null;
    if (!row) return;
    const t = Number(row.dataset.t || 0);
    if (!isFinite(t)) return;
    if (!audio.src) {
      toast('先点一首歌，再点歌词跳转');
      return;
    }
    const max = audio.duration || 0;
    audio.currentTime = max > 0 ? Math.min(t, Math.max(0, max - 0.2)) : Math.max(0, t);
    if (audio.paused) audio.play().catch(() => {});
    syncLyric(true);
    toast('跳到 ' + fmtTime(audio.currentTime * 1000));
  });
}

if ($('lyricFxSelect')) {
  $('lyricFxSelect').addEventListener('change', () => {
    const v = applyLyricFx($('lyricFxSelect').value, true);
    toast('歌词效果：' + (FX_LABEL[v] || v));
  });
}

// 歌词颜色：设置页和歌词头上各一个下拉，改哪边都同步
['lyricColorSelect', 'lyricColorQuick'].forEach((id) => {
  if (!$('' + id)) return;
  $('' + id).addEventListener('change', () => {
    const v = applyLyricColor($('' + id).value, true);
    toast('歌词颜色：' + ((LYRIC_COLORS[v] && LYRIC_COLORS[v].label) || v));
  });
});

// 桌面歌词字号：改完立刻推给歌词窗口，没开窗也先记着
const DL_FONT_LABEL = { 26: '小', 34: '标准', 42: '大', 52: '特大' };
if ($('dlFontSelect')) {
  $('dlFontSelect').addEventListener('change', async () => {
    const v = Number($('dlFontSelect').value) || 34;
    const name = DL_FONT_LABEL[v] || String(v);
    let visible = false;
    if (window.baba && window.baba.setLyricFont) {
      try {
        await window.baba.setLyricFont(v);
      } catch (e) {
        /* 主进程没接住也不影响界面提示 */
      }
    } else if (window.baba && window.baba.saveSettings) {
      window.baba.saveSettings({ lyricFont: v });
    }
    if (window.baba && window.baba.desktopLyricState) {
      try {
        const r = await window.baba.desktopLyricState();
        visible = !!(r && r.visible);
      } catch (e) {
        visible = false;
      }
    }
    toast(visible ? '桌面歌词字号：' + name : '字号已设为「' + name + '」，开启桌面歌词后生效');
  });
}

// 桌面歌词开关按钮：0.3.1 起从「正在播放」页搬到主界面底部功能栏（#dlBtn，收藏旁边），
// 旧位置的按钮若仍存在也一起同步，两处状态永远一致
function desktopLyricBtns() {
  return ['dlBtn', 'desktopLyricBtn'].map((id) => $(id)).filter(Boolean);
}

async function refreshDesktopLyricBtn() {
  if (!window.baba || !window.baba.desktopLyricState) return;
  let on = false;
  try {
    const r = await window.baba.desktopLyricState();
    on = !!(r && r.visible);
  } catch (e) {
    on = false;
  }
  syncDesktopLyricBtn(on);
}

function syncDesktopLyricBtn(on) {
  const list = desktopLyricBtns();
  if (!list.length) return;
  for (const btn of list) {
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // 图标按钮只切状态类，绝不覆写内部 SVG；老式文字按钮才更新文案
    if (!btn.querySelector('svg')) btn.textContent = on ? '关闭桌面歌词' : '桌面歌词';
  }
}

async function toggleDesktopLyricNow() {
  if (!window.baba || !window.baba.toggleDesktopLyric) {
    toast('当前版本不支持桌面歌词');
    return;
  }
  let r = null;
  try {
    r = await window.baba.toggleDesktopLyric();
  } catch (e) {
    r = null;
  }
  const on = !!(r && r.visible);
  syncDesktopLyricBtn(on);
  // 与收藏按钮同一个弹一下的反馈动画
  const btn = $('dlBtn');
  if (btn) {
    btn.classList.remove('pop');
    void btn.offsetWidth;
    btn.classList.add('pop');
    setTimeout(() => btn.classList.remove('pop'), 380);
  }
  if (on) {
    // 刚开窗时先推一次当前两句，不用等下一次换行
    const box = $('lyricBox');
    pushLyricState(box && box.dataset.cur !== '' ? Number(box.dataset.cur) : -1);
    toast('桌面歌词已开启，按住可拖动位置');
  } else {
    toast('桌面歌词已关闭');
  }
}

desktopLyricBtns().forEach((btn) => btn.addEventListener('click', toggleDesktopLyricNow));

// 托盘菜单里开关桌面歌词时，主窗口按钮状态跟着变
if (window.baba && window.baba.onLyricVisibility) {
  window.baba.onLyricVisibility((visible) => syncDesktopLyricBtn(visible));
}

// 桌面歌词窗口上的按钮转给主窗口执行
if (window.baba && window.baba.onLyricCommand) {
  window.baba.onLyricCommand((action) => {
    if (action === 'play-pause' || action === 'play') $('playBtn').click();
    else if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
  });
}

// 播放状态变化时补一次时间基准，桌面歌词据此做平滑推进
audio.addEventListener('play', () => pushLyricState());
audio.addEventListener('pause', () => pushLyricState());
audio.addEventListener('seeked', () => pushLyricState());

applyLyricFx(lyrFx, false);
refreshDesktopLyricBtn();


/* ================= 我的歌单 / 播放历史（0.2.3） ================= */
const DEFAULT_PL_ID = 'default';
const HIS_MAX = 100;
const HIS_PAGE = 30;

// 挂到 state 上，避免散落全局变量
state.playlists = [];
state.history = [];
state.queue = null;
state.view = 'search';
state.plCur = '';
state.plKw = '';
state.hisKw = '';
state.hisShow = HIS_PAGE;

function songKey(it) {
  if (!it) return '';
  if (it.key) return String(it.key);
  const s = (it.sources || [])[0];
  return s ? String(s.platform) + ':' + String(s.id) : String(it.name || '') + '|' + String(it.artists || '');
}

// 只保留「能直接起播」的字段：评论/匹配度等搜索期临时数据写进配置会把文件撑大
function clientSong(it) {
  if (!it) return null;
  const sources = (it.sources || [])
    .filter((s) => s && s.platform && s.id !== undefined && s.id !== null && String(s.id) !== '')
    .map((s) => ({
      platform: String(s.platform),
      id: String(s.id),
      duration: Number(s.duration) || 0,
      platformRank: Number(s.platformRank) || 0,
      name: String(s.name || it.name || ''),
      // 替代音源标记必须一起存下来，否则重开应用又得跨平台找一遍
      alt: s.alt ? 1 : 0,
    }))
    .slice(0, 4);
  if (!sources.length) return null;
  return {
    key: songKey(it),
    name: String(it.name || sources[0].name || ''),
    artists: String(it.artists || ''),
    album: String(it.album || ''),
    cover: String(it.cover || ''),
    duration: Number(it.duration) || sources[0].duration || 0,
    vtag: String(it.vtag || ''),
    vip: it.vip ? 1 : 0,
    sources,
  };
}

// 替代音源拿到后写回歌单/历史：同一首歌下次直接命中，不用再跨平台反查一遍。
// 只追加 alt 音源，原生源顺序不动 —— 歌单条目本身永远是原来那首
function persistAltSources(item) {
  if (!item) return;
  const k = songKey(item);
  const alts = (item.sources || []).filter((s) => s.alt);
  if (!alts.length) return;
  const pack = (s) => ({
    platform: String(s.platform),
    id: String(s.id),
    duration: Number(s.duration) || 0,
    platformRank: Number(s.platformRank) || 90,
    name: String(s.name || item.name || ''),
    alt: 1,
  });
  const merge = (list) => {
    const t = (list || []).find((x) => songKey(x) === k);
    if (!t || t === item) return false;
    alts.forEach((s) => {
      if (!(t.sources || []).some((x) => x.platform === s.platform && String(x.id) === String(s.id))) {
        t.sources.push(pack(s));
      }
    });
    // 后端只存 4 条源：超出时优先砍掉多余原生源，保证替代音源留得住
    if (t.sources.length > 4) {
      const keepAlt = t.sources.filter((s) => s.alt);
      const keepBase = t.sources.filter((s) => !s.alt);
      t.sources = keepBase.slice(0, Math.max(1, 4 - keepAlt.length)).concat(keepAlt).slice(0, 4);
    }
    return true;
  };
  let hit = false;
  (state.playlists || []).forEach((p) => {
    if (merge(p.songs)) hit = true;
  });
  if (merge(state.history)) hit = true;
  if (hit) saveLib(0);
}

// 加号按钮只带 key，需要按 key 把完整条目找回来（可能来自搜索 / 歌单 / 历史任一来源）
function findSongByKey(key) {
  const k = String(key || '');
  if (!k) return null;
  let hit = (state.results || []).find((x) => songKey(x) === k);
  if (hit) return hit;
  hit = (state.history || []).find((x) => songKey(x) === k);
  if (hit) return hit;
  const pls = state.playlists || [];
  for (let i = 0; i < pls.length; i++) {
    const s = (pls[i].songs || []).find((x) => songKey(x) === k);
    if (s) return s;
  }
  if (state.current && songKey(state.current) === k) return state.current;
  return null;
}

function getPl(id) {
  return (state.playlists || []).find((p) => p.id === id) || null;
}

function inPlaylist(id, it) {
  const pl = getPl(id);
  if (!pl || !it) return false;
  const k = songKey(it);
  return (pl.songs || []).some((s) => songKey(s) === k);
}

// 歌单/历史里的搜索只在本列表内匹配，跟顶部全局搜索完全两条路
function matchSong(it, kw) {
  if (!it) return false;
  const words = String(kw || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = [it.name, it.artists, it.album].map((v) => String(v || '').toLowerCase()).join(' ');
  return words.every((w) => hay.indexOf(w) >= 0);
}

/* ---------- 读写配置 ---------- */
let libSaveTimer = null;
function saveLib(delay) {
  clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(() => {
    try {
      const p = window.baba.saveSettings({
        playlists: state.playlists,
        history: (state.history || []).slice(0, HIS_MAX),
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* 写盘失败不打断界面操作 */
    }
  }, typeof delay === 'number' ? delay : 600);
}

async function loadLib() {
  let s = null;
  try {
    s = await window.baba.getSettings();
  } catch (e) {
    s = null;
  }
  if (!s) return;
  state.playlists = Array.isArray(s.playlists) ? s.playlists : [];
  if (!state.playlists.some((p) => p.id === DEFAULT_PL_ID)) {
    state.playlists.unshift({ id: DEFAULT_PL_ID, name: '默认歌单', from: 'local', createdAt: 0, songs: [] });
  }
  state.history = Array.isArray(s.history) ? s.history : [];
  renderPlIndex();
  renderHistory();
  syncFavBtn();
}

/* ---------- 歌单增删改 ---------- */
function newPlId() {
  return 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createPlaylist(name) {
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return null;
  let final = nm;
  let n = 2;
  while (state.playlists.some((p) => p.name === final)) final = nm + '(' + n++ + ')';
  const pl = { id: newPlId(), name: final, from: 'local', createdAt: Date.now(), songs: [] };
  state.playlists.push(pl);
  saveLib();
  renderPlIndex();
  return pl;
}

function addToPlaylist(id, it, opts) {
  opts = opts || {};
  const pl = getPl(id);
  if (!pl) return false;
  const s = clientSong(it);
  if (!s) return false;
  if ((pl.songs || []).some((x) => songKey(x) === s.key)) {
    if (!opts.silent) toast('「' + pl.name + '」里已经有这首了');
    return false;
  }
  pl.songs.push(s);
  saveLib();
  if (!opts.silent) toast('已加入「' + pl.name + '」');
  afterLibChange(id);
  return true;
}

function removeFromPlaylist(id, it, opts) {
  const pl = getPl(id);
  if (!pl || !it) return false;
  const k = songKey(it);
  const before = (pl.songs || []).length;
  pl.songs = (pl.songs || []).filter((x) => songKey(x) !== k);
  if (pl.songs.length === before) return false;
  saveLib();
  if (!opts || !opts.silent) toast('已从「' + pl.name + '」移出');
  afterLibChange(id);
  return true;
}

// 列表里的加号状态只做局部刷新，整表重绘会把滚动位置顶回顶部
function refreshPlusButtons() {
  document.querySelectorAll('.add-btn').forEach((b) => {
    const hit = findSongByKey(b.dataset.key || '');
    const inDef = hit ? inPlaylist(DEFAULT_PL_ID, hit) : false;
    b.classList.toggle('in', inDef);
    b.title = inDef ? '已在默认歌单，点击换到别的歌单' : '添加到歌单';
  });
}

function afterLibChange(id) {
  renderPlIndex();
  if (id && state.plCur === id) renderPlSongs();
  if (state.view === 'history') renderHistory();
  refreshPlusButtons();
  syncFavBtn();
}

/* ---------- 歌单一览（一级页） ---------- */
function plFromLabel(p, isDef) {
  if (!p.from || p.from === 'local') return isDef ? '默认收藏' : '本地歌单';
  if (p.from === 'qq') return 'QQ音乐导入';
  if (p.from === 'netease') return '网易云导入';
  return '外部导入';
}

function renderPlIndex() {
  const grid = $('plGrid');
  if (!grid) return;
  const cards = (state.playlists || [])
    .map((p) => {
      const cnt = (p.songs || []).length;
      const isDef = p.id === DEFAULT_PL_ID;
      return (
        '<div class="pl-card" data-pl="' + esc(p.id) + '">' +
        '<div class="pc-top">' +
        '<div class="pc-ico">' + (isDef ? '&#10084;' : '&#9836;') + '</div>' +
        '<div class="pc-txt"><div class="pc-name">' + esc(p.name) + '</div>' +
        '<div class="pc-sub">' + cnt + ' 首 · ' + plFromLabel(p, isDef) + '</div></div>' +
        '</div>' +
        '<div class="pc-acts">' +
        '<button class="pc-btn" data-act="open">打开</button>' +
        '<button class="pc-btn" data-act="play">播放</button>' +
        (isDef ? '' : '<button class="pc-btn danger" data-act="del">删除</button>') +
        '</div></div>'
      );
    })
    .join('');
  grid.innerHTML =
    cards + '<div class="pl-card new" id="plNewCard"><div class="pc-plus">+</div><div>新建 / 导入歌单</div></div>';
}


/* ---------- 歌单详情（二级页） ---------- */
function openPlaylist(id) {
  const pl = getPl(id);
  if (!pl) return;
  state.plCur = id;
  state.plKw = '';
  if ($('plSearchInput')) $('plSearchInput').value = '';
  if ($('plIndex')) $('plIndex').classList.add('hidden');
  if ($('plDetail')) $('plDetail').classList.remove('hidden');
  renderPlSongs();
}

function closePlaylist() {
  state.plCur = '';
  state.plKw = '';
  if ($('plDetail')) $('plDetail').classList.add('hidden');
  if ($('plIndex')) $('plIndex').classList.remove('hidden');
  renderPlIndex();
}

function renderPlSongs() {
  const pl = getPl(state.plCur);
  const box = $('plSongList');
  if (!pl || !box) return;
  const kw = String(state.plKw || '').trim();
  const all = pl.songs || [];
  const list = kw ? all.filter((it) => matchSong(it, kw)) : all;
  if ($('plTitle')) $('plTitle').textContent = pl.name;
  if ($('plMeta')) $('plMeta').textContent = '共 ' + all.length + ' 首' + (kw ? '，匹配 ' + list.length + ' 首' : '');
  if ($('plDelBtn')) $('plDelBtn').style.display = pl.id === DEFAULT_PL_ID ? 'none' : '';
  if ($('plPlayAllBtn')) $('plPlayAllBtn').style.display = all.length ? '' : 'none';
  if (!list.length) {
    box.innerHTML =
      '<div class="empty">' +
      (kw
        ? '这个歌单里没有匹配「' + esc(kw) + '」的歌曲'
        : '歌单还是空的：在搜索结果或播放历史里点歌曲右边的 + 就能加进来') +
      '</div>';
    return;
  }
  box.innerHTML = list.map((it, i) => rowHtml(it, i)).join('');
  bindRows(box, list);
}

/* ---------- 播放历史 ---------- */
function renderHistory() {
  const box = $('hisList');
  if (!box) return;
  const all = state.history || [];
  const kw = String(state.hisKw || '').trim();
  const list = kw ? all.filter((it) => matchSong(it, kw)) : all;
  if ($('hisMeta'))
    $('hisMeta').textContent =
      '最近播放 ' + all.length + ' 首（最多保留 100 首）' + (kw ? '，匹配 ' + list.length + ' 首' : '');
  const show = list.slice(0, state.hisShow);
  if (!show.length) {
    box.innerHTML =
      '<div class="empty">' +
      (kw
        ? '播放历史里没有匹配「' + esc(kw) + '」的歌曲'
        : '还没有播放记录：播过的歌会自动记在这里，最多留最近 100 首') +
      '</div>';
  } else {
    box.innerHTML = show.map((it, i) => rowHtml(it, i)).join('');
    bindRows(box, list);
  }
  if ($('hisMoreWrap')) $('hisMoreWrap').classList.toggle('hidden', list.length <= state.hisShow);
  if ($('hisMoreBtn'))
    $('hisMoreBtn').textContent = '加载更多（还有 ' + Math.max(0, list.length - state.hisShow) + ' 首）';
}

function pushHistory(item) {
  const s = clientSong(item);
  if (!s) return;
  s.playedAt = Date.now();
  const rest = (state.history || []).filter((x) => songKey(x) !== s.key);
  state.history = [s].concat(rest).slice(0, HIS_MAX);
  saveLib(900);
  if (state.view === 'history') renderHistory();
}

/* ---------- 弹层：通用输入 ---------- */
let inputResolve = null;
function openInput(cfg) {
  cfg = cfg || {};
  return new Promise((resolve) => {
    const mask = $('inputMask');
    const box = $('inputBox');
    if (!mask || !box) {
      resolve(null);
      return;
    }
    if (inputResolve) inputResolve(null);
    $('inputTitle').textContent = cfg.title || '';
    $('inputHint').textContent = cfg.hint || '';
    $('inputOk').textContent = cfg.okText || '确定';
    box.value = cfg.value || '';
    box.placeholder = cfg.placeholder || '';
    box.rows = cfg.multiline ? 5 : 1;
    box.style.minHeight = cfg.multiline ? '112px' : '44px';
    mask.classList.remove('hidden');
    inputResolve = (v) => {
      inputResolve = null;
      mask.classList.add('hidden');
      resolve(v);
    };
    setTimeout(() => {
      box.focus();
      if (!cfg.multiline) box.select();
    }, 60);
  });
}

/* ---------- 弹层：选歌单 ---------- */
let pickTarget = null;
function openPick(item) {
  if (!item) return;
  pickTarget = item;
  const mask = $('plPickMask');
  if (!mask) return;
  if ($('plPickTitle')) $('plPickTitle').textContent = '添加到歌单';
  if ($('plPickSub')) $('plPickSub').textContent = (item.name || '') + ' — ' + (item.artists || '未知歌手');
  renderPickList();
  mask.classList.remove('hidden');
}

function closePick() {
  if ($('plPickMask')) $('plPickMask').classList.add('hidden');
  pickTarget = null;
}

function renderPickList() {
  const box = $('plPickList');
  if (!box) return;
  const it = pickTarget;
  const html = (state.playlists || [])
    .map((p) => {
      const has = it ? inPlaylist(p.id, it) : false;
      const fl = !p.from || p.from === 'local' ? '' : plFromLabel(p, p.id === DEFAULT_PL_ID);
      return (
        '<div class="pick-row" data-pl="' + esc(p.id) + '">' +
        '<div class="pr-ico">' + (p.id === DEFAULT_PL_ID ? '&#10084;' : '&#9836;') + '</div>' +
        '<div class="pr-txt"><div class="pr-name">' + esc(p.name) + '</div>' +
        '<div class="pr-sub">' + (p.songs || []).length + ' 首' + (fl ? ' · ' + fl : '') + '</div></div>' +
        (has ? '<span class="pr-state">已加入</span>' : '') +
        '</div>'
      );
    })
    .join('');
  box.innerHTML = html || '<div class="pick-empty">还没有歌单，点下面新建一个</div>';
}


/* ---------- 右键菜单 ---------- */
function hideCtx() {
  if ($('ctxMenu')) $('ctxMenu').classList.add('hidden');
}

function currentQueueFor(item) {
  const k = songKey(item);
  if (state.view === 'playlists') {
    const pl = getPl(state.plCur);
    if (pl && (pl.songs || []).some((x) => songKey(x) === k)) return pl.songs;
  }
  if (state.view === 'history') return state.history;
  return state.results;
}

function openCtx(x, y, item) {
  const menu = $('ctxMenu');
  if (!menu || !item) return;
  const inDef = inPlaylist(DEFAULT_PL_ID, item);
  const curPl = state.view === 'playlists' ? getPl(state.plCur) : null;
  const inCur = curPl ? inPlaylist(curPl.id, item) : false;
  const rows = [];
  rows.push('<div class="ctx-item" data-act="play">&#9654; 播放这首</div>');
  rows.push('<div class="ctx-sep"></div>');
  rows.push('<div class="ctx-item" data-act="add">&#43; 添加到歌单…</div>');
  rows.push(
    '<div class="ctx-item" data-act="' +
      (inDef ? 'unfav' : 'fav') +
      '">' +
      (inDef ? '&#10084; 从默认歌单移出' : '&#10084; 加入默认歌单') +
      '</div>'
  );
  if (inCur) rows.push('<div class="ctx-item" data-act="uncur">&#8722; 从「' + esc(curPl.name) + '」移出</div>');
  menu.innerHTML = rows.join('');
  menu.dataset.key = songKey(item);
  menu.dataset.pl = curPl ? curPl.id : '';
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

/* ---------- 业务动作 ---------- */
async function promptNewPlaylist() {
  const n = (state.playlists || []).length;
  const name = await openInput({
    title: '新建歌单',
    hint: '给歌单起个名字（最多 40 个字），同名会自动加序号。',
    value: '我的歌单 ' + (n > 0 ? n : 1),
    okText: '创建',
  });
  if (name === null) return null;
  const pl = createPlaylist(name);
  if (!pl) {
    toast('歌单名不能为空');
    return null;
  }
  toast('已创建歌单「' + pl.name + '」');
  return pl;
}

async function renamePlaylist(id) {
  const pl = getPl(id);
  if (!pl) return;
  const name = await openInput({
    title: '重命名歌单',
    hint: '当前名称：' + pl.name,
    value: pl.name,
    okText: '保存',
  });
  if (name === null) return;
  if (!name.trim()) {
    toast('歌单名不能为空');
    return;
  }
  pl.name = name.trim().slice(0, 40);
  saveLib();
  renderPlIndex();
  if (state.plCur === id) renderPlSongs();
  toast('已重命名为「' + pl.name + '」');
}

function delPlaylist(id) {
  const pl = getPl(id);
  if (!pl) return;
  if (pl.id === DEFAULT_PL_ID) {
    toast('默认歌单不能删除');
    return;
  }
  const ok = window.confirm(
    '确定删除歌单「' +
      pl.name +
      '」吗？\n歌单里的 ' +
      (pl.songs || []).length +
      ' 首歌曲记录会一起删掉，歌曲文件本身不受影响。'
  );
  if (!ok) return;
  state.playlists = state.playlists.filter((p) => p.id !== id);
  if (state.plCur === id) closePlaylist();
  saveLib();
  renderPlIndex();
  toast('已删除歌单「' + pl.name + '」');
}

async function importPlaylistFlow() {
  const link = await openInput({
    title: '导入外部歌单',
    hint:
      '把 QQ 音乐 / 网易云的歌单分享链接整段粘进来（短链也行，例如 https://163cn.tv/xxxx 或 https://y.qq.com/n/ryqq/playlist/123456），会自动拉取歌单名和歌曲列表。',
    multiline: true,
    placeholder: 'https://...',
    okText: '解析并保存',
  });
  if (link === null) return;
  if (!link.trim()) {
    toast('请先粘贴歌单分享链接');
    return;
  }
  toast('正在解析歌单，曲目多的话要等几秒…');
  let r = null;
  try {
    r = await window.baba.importPlaylist(link.trim());
  } catch (e) {
    r = { ok: false, reason: e.message || '请求异常' };
  }
  if (!r || !r.ok) {
    toast('导入失败：' + ((r && r.reason) || '没识别到这个链接'));
    return;
  }
  const fromLabel = r.platform === 'qq' ? 'QQ音乐' : '网易云';
  const baseName = String(r.name || '').trim() || fromLabel + '导入歌单';
  let name = baseName;
  let n = 2;
  while (state.playlists.some((p) => p.name === name)) name = baseName + '(' + n++ + ')';
  const pl = { id: newPlId(), name, from: r.platform || 'import', createdAt: Date.now(), songs: [] };
  (r.songs || []).forEach((s) => {
    const cs = clientSong({
      key: '',
      name: s.name,
      artists: s.artists,
      album: s.album,
      cover: s.cover,
      duration: s.duration,
      vip: s.vip,
      sources: s.sources,
    });
    if (!cs) return;
    if (pl.songs.some((x) => songKey(x) === cs.key)) return;
    pl.songs.push(cs);
  });
  if (!pl.songs.length) {
    toast('这个歌单里没有取到可播放的歌曲');
    return;
  }
  state.playlists.push(pl);
  saveLib();
  renderPlIndex();
  // 导入时平台标了 VIP/付费的曲目，点播自动跨平台换源，先在提示里说清楚
  const vipN = pl.songs.filter((s) => s.vip).length;
  toast(
    '已从' + fromLabel + '导入「' + pl.name + '」，共 ' + pl.songs.length + ' 首' +
      (vipN ? '（其中 ' + vipN + ' 首需会员/付费，点播时自动找其他平台音源）' : '')
  );
  openPlaylist(pl.id);
}

/* ---------- 播放条爱心 ---------- */
function syncFavBtn() {
  const btn = $('favBtn');
  if (!btn) return;
  const cur = state.current;
  const inDef = cur ? inPlaylist(DEFAULT_PL_ID, cur) : false;
  btn.classList.toggle('on', inDef);
  btn.setAttribute('aria-pressed', inDef ? 'true' : 'false');
  btn.title = !cur
    ? '还没在播放歌曲，左键：加入默认歌单'
    : inDef
    ? '已在默认歌单，左键点击移出'
    : '左键：加入默认歌单';
}

/* ---------- 视图切换：交给统一切换器，避免多套内联逻辑打架 ---------- */
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  ['search', 'playlists', 'history', 'playing', 'settings'].forEach((name) => {
    const el = $('view-' + name);
    if (el) el.classList.toggle('hidden', name !== v);
  });
  if (v === 'playlists') {
    if (state.plCur) renderPlSongs();
    else renderPlIndex();
  } else if (v === 'history') {
    renderHistory();
  } else if (v === 'playing') {
    setTimeout(() => {
      try {
        syncLyric(true);
      } catch (e) {
        /* 歌词模块未就绪时忽略 */
      }
    }, 80);
  }
  hideCtx();
}


/* ================= 事件绑定 ================= */
// 列表内的 + 号：捕获阶段先处理并断掉冒泡，否则会顺带触发整行播放
['songList', 'plSongList', 'hisList'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.add-btn') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const item = findSongByKey(btn.dataset.key);
      if (item) openPick(item);
    },
    true
  );
});

if ($('favBtn')) {
  $('favBtn').addEventListener('click', () => {
    if (!state.current) {
      toast('先点一首歌播放，再点爱心收藏到默认歌单');
      return;
    }
    if (inPlaylist(DEFAULT_PL_ID, state.current)) removeFromPlaylist(DEFAULT_PL_ID, state.current);
    else addToPlaylist(DEFAULT_PL_ID, state.current);
    syncFavBtn();
    const btn = $('favBtn');
    if (btn) {
      btn.classList.remove('pop');
      void btn.offsetWidth;
      btn.classList.add('pop');
    }
  });
}

if ($('plNewBtn')) $('plNewBtn').addEventListener('click', () => promptNewPlaylist());
if ($('plImportBtn')) $('plImportBtn').addEventListener('click', () => importPlaylistFlow());
if ($('plBackBtn')) $('plBackBtn').addEventListener('click', () => closePlaylist());
if ($('plRenameBtn')) $('plRenameBtn').addEventListener('click', () => renamePlaylist(state.plCur));
if ($('plDelBtn')) $('plDelBtn').addEventListener('click', () => delPlaylist(state.plCur));
if ($('plPlayAllBtn')) {
  $('plPlayAllBtn').addEventListener('click', () => {
    const pl = getPl(state.plCur);
    if (!pl || !(pl.songs || []).length) {
      toast('这个歌单还没有歌');
      return;
    }
    playItem(pl.songs[0], pl.songs);
    toast('播放歌单：' + pl.name);
  });
}

if ($('plGrid')) {
  $('plGrid').addEventListener('click', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('.pl-card') : null;
    if (!card) return;
    if (card.id === 'plNewCard') {
      promptNewPlaylist();
      return;
    }
    const id = card.dataset.pl;
    const actEl = e.target.closest('.pc-btn');
    if (actEl) {
      const act = actEl.dataset.act;
      if (act === 'open') openPlaylist(id);
      else if (act === 'play') {
        const pl = getPl(id);
        if (!pl || !(pl.songs || []).length) {
          toast('这个歌单还是空的');
          return;
        }
        openPlaylist(id);
        playItem(pl.songs[0], pl.songs);
      } else if (act === 'del') {
        delPlaylist(id);
      }
      return;
    }
    openPlaylist(id);
  });
}

if ($('plSearchInput')) {
  let t = null;
  $('plSearchInput').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.plKw = $('plSearchInput').value;
      renderPlSongs();
    }, 140);
  });
  $('plSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('plSearchInput').value = '';
      state.plKw = '';
      renderPlSongs();
    }
  });
}
if ($('plSearchClear')) {
  $('plSearchClear').addEventListener('click', () => {
    if ($('plSearchInput')) $('plSearchInput').value = '';
    state.plKw = '';
    renderPlSongs();
    if ($('plSearchInput')) $('plSearchInput').focus();
  });
}

if ($('hisSearchInput')) {
  let t = null;
  $('hisSearchInput').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.hisKw = $('hisSearchInput').value;
      state.hisShow = HIS_PAGE;
      renderHistory();
    }, 140);
  });
  $('hisSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('hisSearchInput').value = '';
      state.hisKw = '';
      state.hisShow = HIS_PAGE;
      renderHistory();
    }
  });
}
if ($('hisSearchClear')) {
  $('hisSearchClear').addEventListener('click', () => {
    if ($('hisSearchInput')) $('hisSearchInput').value = '';
    state.hisKw = '';
    state.hisShow = HIS_PAGE;
    renderHistory();
    if ($('hisSearchInput')) $('hisSearchInput').focus();
  });
}

if ($('hisMoreBtn')) {
  $('hisMoreBtn').addEventListener('click', () => {
    state.hisShow += HIS_PAGE;
    renderHistory();
  });
}

if ($('hisClearBtn')) {
  $('hisClearBtn').addEventListener('click', () => {
    if (!(state.history || []).length) {
      toast('播放历史已经是空的');
      return;
    }
    const ok = window.confirm('确定清空播放历史吗？这会删掉最近 ' + state.history.length + ' 首的播放记录。');
    if (!ok) return;
    state.history = [];
    state.hisShow = HIS_PAGE;
    saveLib(200);
    renderHistory();
    toast('播放历史已清空');
  });
}

if ($('plPickList')) {
  $('plPickList').addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.pick-row') : null;
    if (!row || !pickTarget) return;
    const id = row.dataset.pl;
    if (inPlaylist(id, pickTarget)) removeFromPlaylist(id, pickTarget);
    else addToPlaylist(id, pickTarget);
    renderPickList();
  });
}
if ($('plPickClose')) $('plPickClose').addEventListener('click', () => closePick());
if ($('plPickMask')) {
  $('plPickMask').addEventListener('click', (e) => {
    if (e.target === $('plPickMask')) closePick();
  });
}
if ($('plPickNew')) {
  $('plPickNew').addEventListener('click', async () => {
    const target = pickTarget;
    const pl = await promptNewPlaylist();
    if (!pl) return;
    if (target) {
      addToPlaylist(pl.id, target);
      renderPickList();
    }
  });
}

if ($('inputOk')) {
  $('inputOk').addEventListener('click', () => {
    if (inputResolve) inputResolve(String($('inputBox').value || '').trim());
  });
}
if ($('inputCancel')) $('inputCancel').addEventListener('click', () => { if (inputResolve) inputResolve(null); });
if ($('inputClose')) $('inputClose').addEventListener('click', () => { if (inputResolve) inputResolve(null); });
if ($('inputMask')) {
  $('inputMask').addEventListener('click', (e) => {
    if (e.target === $('inputMask') && inputResolve) inputResolve(null);
  });
}
if ($('inputBox')) {
  $('inputBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && $('inputBox').rows === 1) {
      e.preventDefault();
      if ($('inputOk')) $('inputOk').click();
    } else if (e.key === 'Escape') {
      if (inputResolve) inputResolve(null);
    }
  });
}

if ($('ctxMenu')) {
  $('ctxMenu').addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.ctx-item') : null;
    if (!el) return;
    const menu = $('ctxMenu');
    const act = el.dataset.act;
    const item = findSongByKey(menu.dataset.key);
    const plId = menu.dataset.pl;
    hideCtx();
    if (!item) return;
    if (act === 'play') playItem(item, currentQueueFor(item));
    else if (act === 'add') openPick(item);
    else if (act === 'fav') addToPlaylist(DEFAULT_PL_ID, item);
    else if (act === 'unfav') removeFromPlaylist(DEFAULT_PL_ID, item);
    else if (act === 'uncur' && plId) removeFromPlaylist(plId, item);
    syncFavBtn();
  });
}
document.addEventListener('click', (e) => {
  const menu = $('ctxMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (!e.target.closest || !e.target.closest('#ctxMenu')) hideCtx();
});
document.addEventListener('scroll', () => hideCtx(), true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  hideCtx();
  if ($('plPickMask') && !$('plPickMask').classList.contains('hidden')) closePick();
});

// 真正开始出声才记一条历史：点了但没音源没播成的不该进历史
audio.addEventListener('playing', () => pushHistory(state.current));

// 启动即补一次状态同步，重启后爱心和加号的红点状态就是对的
// （歌单/历史加载完紧接着做断点续播恢复，见文件末尾 loadLibSafeThenRestore）

/* ---------------- 缓存设置 ---------------- */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function paintCache(info) {
  if (!info) return;
  if ($('cacheDirText')) $('cacheDirText').textContent = '缓存位置：' + (info.dir || '未设置');
  if ($('cacheSizeText')) {
    const cnt = info.count || 0;
    $('cacheSizeText').textContent = '已用缓存：' + fmtBytes(info.size) + (cnt ? '（' + cnt + ' 首）' : '（暂无缓存）');
  }
  if ($('cacheToggleBtn')) {
    $('cacheToggleBtn').textContent = info.enabled ? '已开启' : '已关闭';
    $('cacheToggleBtn').classList.toggle('on', !!info.enabled);
    $('cacheToggleBtn').title = info.enabled
      ? '开启后播放过的音频会存到缓存目录，下次直接读本地（点击关闭）'
      : '缓存已关闭，播放完全走在线流（点击开启）';
  }
}

async function refreshCacheUi() {
  if (!window.baba || !window.baba.cacheInfo) return;
  try {
    paintCache(await window.baba.cacheInfo());
  } catch (e) {}
}

$('cachePickBtn') &&
  $('cachePickBtn').addEventListener('click', async () => {
    try {
      const r = await window.baba.cachePickDir();
      paintCache(r);
      if (r && r.ok) toast('缓存位置已切换到新文件夹');
    } catch (e) {
      toast('选择缓存目录失败');
    }
  });

$('cacheClearBtn') &&
  $('cacheClearBtn').addEventListener('click', async () => {
    const tip = $('cacheSizeText') ? $('cacheSizeText').textContent : '';
    if (!window.confirm('确定清空缓存目录里已缓存的音频吗？\n只删缓存文件，不会动歌单和历史。\n' + tip)) return;
    try {
      const r = await window.baba.cacheClear();
      paintCache(r);
      toast('已清理 ' + fmtBytes((r && r.freed) || 0) + '（' + ((r && r.cleared) || 0) + ' 个文件）');
    } catch (e) {
      toast('清理缓存失败');
    }
  });

$('cacheToggleBtn') &&
  $('cacheToggleBtn').addEventListener('click', async () => {
    const on = !($('cacheToggleBtn').classList.contains('on'));
    try {
      paintCache(await window.baba.cacheSetEnabled(on));
      toast(on ? '已开启缓存' : '已关闭缓存');
    } catch (e) {}
  });

refreshCacheUi();

/* ================= 断点续播（0.3.1）================= */
// 需求：关掉时在放哪首、放到第几秒、在哪个歌单，下次打开原样接回去；
// 接回去之后播完当前这首，仍按当前播放模式继续歌单里的其他内容（队列一并恢复即可）。
// 快照存在配置文件的 resume 字段，主进程 normResume 兜底校验。
const RESUME_SAVE_GAP = 8000; // 播放中每 8 秒刷一次进度；暂停/拖动/切歌/隐藏窗口立刻刷
state.queueSrc = { type: 'search', id: '' };
state.restorePos = 0;
state.restoreAutoplay = false;
state.resumeAt = 0;
state.resumeDone = false;

// 认出当前队列的出处：哪个歌单 / 播放历史 / 搜索结果
function detectQueueSrc(list) {
  if (!Array.isArray(list) || !list.length) return { type: 'search', id: '' };
  if (list === state.history) return { type: 'history', id: '' };
  const pls = Array.isArray(state.playlists) ? state.playlists : [];
  for (const p of pls) {
    if (p && p.songs === list) return { type: 'playlist', id: p.id };
  }
  // 队列可能是歌单歌曲的副本（筛过关键词、去重过），按首曲+长度兜底认一次
  const fk = songKey(list[0]);
  if (fk) {
    for (const p of pls) {
      const songs = Array.isArray(p && p.songs) ? p.songs : [];
      if (songs.length === list.length && songs.some((x) => songKey(x) === fk)) {
        return { type: 'playlist', id: p.id };
      }
    }
  }
  return { type: 'search', id: '' };
}

function resumeSnapshot() {
  const it = state.current;
  if (!it || !songKey(it)) return null;
  const src = state.queueSrc || { type: 'search', id: '' };
  // 音频还没真正加载（关窗口太快 / 源失效）就别写快照，免得把上次记着的进度抹成 0
  if (!state.restorePos && !audio.currentSrc && !(Number(audio.currentTime) > 0)) return null;
  // 已经放到结尾（剩不到 3 秒）就当这首放完了，下次从头开始，别一打开就直接跳下一首
  const total = Number(it.duration ? it.duration / 1000 : 0) || 0;
  let pos = Number(audio.currentTime) || 0;
  // 还没定位到记忆点（音频没就绪/加载失败）时，别把记着的进度抹成 0
  const keep = Number(state.restorePos) || 0;
  if (keep > 0 && pos < keep - 1) pos = keep;
  if (total > 5 && pos > total - 3) pos = 0;
  return {
    song: clientSong(it),
    pos: Math.max(0, Math.round(pos)),
    playing: !!(state.playing || !audio.paused),
    mode: state.playMode,
    src: { type: src.type, id: src.id || '' },
    // 只有搜索结果/临时队列才需要把列表一起存；歌单与历史恢复时用现成的，省配置体积
    queue: src.type === 'search' ? (state.queue || []).slice(0, 80).map(clientSong).filter(Boolean) : [],
    at: Date.now(),
  };
}

function saveResumeNow() {
  if (!window.baba || !window.baba.saveSettings) return;
  const pack = resumeSnapshot();
  if (!pack) return;
  state.resumeAt = Date.now();
  try {
    window.baba.saveSettings({ resume: pack });
  } catch (e) {}
}

function saveResumeSoon(force) {
  if (!force && Date.now() - (state.resumeAt || 0) < RESUME_SAVE_GAP) return;
  saveResumeNow();
}

audio.addEventListener('timeupdate', () => {
  // 定位到位后就不再干预进度，避免反复拉扯
  if (state.restorePos && audio.currentTime > state.restorePos + 12) state.restorePos = 0;
  saveResumeSoon(false);
});
audio.addEventListener('pause', () => saveResumeSoon(true));
audio.addEventListener('seeked', () => saveResumeSoon(true));
audio.addEventListener('emptied', () => saveResumeSoon(true));
window.addEventListener('beforeunload', () => saveResumeNow());
// 关到托盘 / 最小化时窗口变隐藏，算一次「关闭」，立刻把进度落盘
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveResumeNow();
});
window.addEventListener('blur', () => saveResumeSoon(false));

// 元数据就绪后跳到上次的位置；换源重试会再来一次 loadedmetadata，restorePos 还在就再定位一次
audio.addEventListener('loadedmetadata', () => {
  const p = Number(state.restorePos) || 0;
  if (p <= 0) return;
  const d = Number(audio.duration) || 0;
  try {
    audio.currentTime = d > 1.5 ? Math.min(p, d - 1) : p;
  } catch (e) {}
  // 只定位、绝不起播：定位完就停在记忆点，等用户自己点播放键
  state.restoreAutoplay = false;
  syncBarTime(false);
});

async function restoreResume() {
  // 只恢复一次：任何重复调用都别再把用户已经点开的新歌顶回去
  if (state.resumeDone) return;
  state.resumeDone = true;
  if (!window.baba || !window.baba.getSettings) return;
  let s = null;
  try {
    s = await window.baba.getSettings();
  } catch (e) {
    return;
  }
  const r = s && s.resume;
  if (!r || !r.song || !songKey(r.song)) return;
  const song = r.song;
  const from = r.src || { type: 'search', id: '' };
  let queue = null;
  let plName = '';
  if (from.type === 'playlist') {
    const pl = getPl(from.id);
    if (pl && Array.isArray(pl.songs) && pl.songs.length) {
      queue = pl.songs;
      plName = pl.name;
      // 顺手把界面停回那个歌单，用户一眼看到「接着播的是这个歌单」
      try {
        switchView('playlists');
        openPlaylist(pl.id);
      } catch (e) {}
    }
  } else if (from.type === 'history' && Array.isArray(state.history) && state.history.length) {
    queue = state.history;
  } else if (Array.isArray(r.queue) && r.queue.length) {
    queue = r.queue;
  }
  if (r.mode) setPlayMode(r.mode, false);
  state.restorePos = Math.max(0, Number(r.pos) || 0);
  // 启动一律不自动播放：只把歌名、封面、进度条摆在记忆点，等用户自己点播放
  state.restoreAutoplay = false;
  try {
    // silent：装载音源 + 定位进度，但不出声
    await playItem(song, queue && queue.length ? queue : [song], { silent: true });
  } catch (e) {
    return;
  }
  if (state.restorePos > 0) {
    toast(
      '已恢复到上次进度：' + (song.name || '未知歌曲') + ' ' + fmtTime(state.restorePos * 1000) +
        (plName ? '（歌单「' + plName + '」）' : '') + '，点播放键继续',
      4200
    );
  } else if (plName) {
    toast('已恢复到歌单「' + plName + '」，点播放键开始', 3600);
  }
}

// 歌单/历史加载完再恢复，否则「所在歌单」可能还没就位
loadLibSafeThenRestore();

async function loadLibSafeThenRestore() {
  try {
    await loadLib();
  } catch (e) {}
  try {
    await restoreResume();
  } catch (e) {}
}

