/* BBMusic 桌面歌词渲染：只显示两行，滚动效果与「正在播放」页完全同源 */
(function () {
  const stage = document.getElementById('stage');
  const elCur = document.getElementById('lineCur');
  const elNext = document.getElementById('lineNext');
  const hint = document.getElementById('hint');
  const ops = document.getElementById('ops');
  const playBtn = ops.querySelector('[data-act="play"]');
  // 解锁快捷键的真实键位，由主进程下发（默认值兜底）
  let hotkeyLabel = 'Ctrl+Alt+L';
  let lastState = null;

  // 与 renderer/app.js 里 LYRIC_FX_LIST / FX_ANIM 保持一致，效果才对得上
  const FX_LIST = ['fade', 'plain', 'fly', 'rise', 'zoom', 'blur', 'karaoke'];
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

  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"/></svg>';

  let st = {
    cur: '',
    next: '',
    curT: 0,
    nextT: 6,
    t: 0,
    playing: false,
    fx: 'fade',
    empty: true,
    name: '',
    artists: '',
    sentAt: 0,
  };
  let fx = 'fade';
  let locked = false;
  let raf = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 每行两层文字：dl-base 常规色，dl-fill 是逐字高亮层（clip-path 刷过去）
  // 返回 true 表示内容确实换了，调用方据此决定要不要播入场动画
  function setLine(el, text) {
    const t = String(text || '');
    if (el.dataset.text === t) return false;
    el.dataset.text = t;
    el.innerHTML = '<span class="dl-base">' + esc(t) + '</span><span class="dl-fill">' + esc(t) + '</span>';
    return true;
  }

  function playFx(el, mode) {
    if (!el || typeof el.animate !== 'function') return;
    const kf = FX_ANIM[mode];
    if (!kf) return;
    try {
      const anim = el.animate(kf, {
        duration: 460,
        easing: 'cubic-bezier(.2,.86,.28,1)',
        fill: 'both',
      });
      // 播完就撤掉，否则动画终态会盖住 CSS 里「待播行压暗」的样式
      anim.onfinish = () => {
        try {
          anim.cancel();
        } catch (e) {
          /* 节点被换掉时忽略 */
        }
      };
    } catch (e) {
      /* 动画不支持就只留颜色变化 */
    }
  }

  // 主进程只在换句/暂停/跳转时推一次，中间的进度靠本地时钟从推送瞬间的 t 往后推
  function localTime() {
    const base = typeof st.t === 'number' ? st.t : st.curT;
    if (!st.playing) return base;
    const drift = Math.max(0, (Date.now() - st.sentAt) / 1000);
    const cap = Math.max(0.5, st.nextT - base) + 0.6;
    return base + Math.min(drift, cap);
  }

  // 逐字进度：优先用主窗口算好的「这一句真正唱多久」(st.dur)，
  // 没有就按字数估算，绝不拿"到下一句的时间"当演唱时长——
  // 那样遇到长间奏，进度会被间奏拖成龟速，看起来就是词跟不上唱
  function singDuration() {
    if (typeof st.dur === 'number' && st.dur > 0) return st.dur;
    const gap = Math.max(0.35, st.nextT - st.curT);
    const chars = String(st.cur || '').length;
    const est = 0.3 + 0.22 * chars;
    return Math.max(0.6, Math.min(est, gap));
  }

  function tick() {
    raf = 0;
    if (fx === 'karaoke' && !st.empty) {
      const dur = singDuration();
      const lead = typeof st.lead === 'number' ? st.lead : 0.3;
      const p = Math.max(0, Math.min(1, (localTime() - st.curT - lead) / Math.max(0.2, dur - lead)));
      elCur.style.setProperty('--lp', (p * 100).toFixed(2) + '%');
    }
    if (st.playing) raf = requestAnimationFrame(tick);
  }

  function startTick() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function applyFxClasses() {
    FX_LIST.forEach((m) => stage.classList.toggle('fx-' + m, m === fx));
  }

  function apply(p) {
    if (!p) return;
    const prevCur = st.cur;
    const nextState = Object.assign({}, st, p);
    st = nextState;

    const mode = FX_LIST.indexOf(p.fx) >= 0 ? p.fx : fx;
    if (mode !== fx) {
      fx = mode;
      applyFxClasses();
      // 切到逐字模式且正在播放时，得先把逐字进度帧跑起来
      if (fx === 'karaoke') startTick();
    }

    // 没歌词/还没开播时给个占位，免得窗口看起来是空的找不到
    const noContent = st.empty || (!st.cur && !st.next);
    const curText = noContent ? '♪ 桌面歌词' : st.cur || '';
    const nextText = noContent ? '在主窗口点「桌面歌词」可随时开关' : st.next || '';

    if (curText !== prevCur) {
      setLine(elCur, curText);
      elCur.style.setProperty('--lp', '0%');
      if (curText) playFx(elCur, fx);
      startTick();
    }
    // 下一句换新内容时也跟着播一次同款入场，两行节奏才一致
    if (setLine(elNext, nextText) && nextText) playFx(elNext, fx);

    // 暂停/继续、歌名、按钮图形
    document.body.classList.toggle('paused', !st.playing);
    playBtn.innerHTML = st.playing ? ICON_PAUSE : ICON_PLAY;
    // 主窗口换色时，payload 里会带上 color
    if (p.color && p.color !== colorMode) setColor(p.color);
    hint.textContent = st.name
      ? st.name + (st.artists ? ' · ' + st.artists : '')
      : 'BBMusic 桌面歌词 · 拖动可移动，双击锁定（' + hotkeyLabel + ' 解锁）';
    lastState = st;

    if (st.playing) startTick();
    else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      tick();
    }
  }

  function setLocked(v) {
    locked = !!v;
    document.body.classList.toggle('locked', locked);
    document.body.classList.toggle('unlocked', !locked);
  }

  ops.addEventListener('click', (e) => {
    const btn = e.target.closest('.dl-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    if (!window.baba) return;
    if (act === 'play') window.baba.lyricCommand('play-pause');
    else if (act === 'prev' || act === 'next') window.baba.lyricCommand(act);
    else if (act === 'lock') window.baba.lockDesktopLyric(true);
    else if (act === 'close') window.baba.closeDesktopLyric();
  });

  // 字号由主进程推下来，走 CSS 变量，不重排窗口
  function setFont(sz) {
    const n = Number(sz);
    if (!n || n < 10 || n > 96) return;
    document.documentElement.style.setProperty('--dl-font', n + 'px');
  }

  // 歌词颜色主题：和主窗口共用一套色板，只改 CSS 变量，不动结构
  const LYRIC_COLORS = {
    orange: { hi: '#ff7a1a', glow: 'rgba(255, 122, 26, .55)' },
    pink: { hi: '#ff5c94', glow: 'rgba(255, 92, 148, .55)' },
    blue: { hi: '#2f8bff', glow: 'rgba(47, 139, 255, .55)' },
    green: { hi: '#25a86b', glow: 'rgba(37, 168, 107, .55)' },
    purple: { hi: '#8a5cff', glow: 'rgba(138, 92, 255, .55)' },
    white: { hi: '#ffffff', glow: 'rgba(255, 255, 255, .5)' },
    rainbow: { hi: '#ff7a1a', glow: 'rgba(255, 122, 26, .55)' },
  };
  let colorMode = 'orange';
  // 渐变文字要「背景裁剪成文字」才成立，老内核不支持时退成单色，避免透明字变黑
  const CAN_GRADIENT_TEXT = (() => {
    try {
      return CSS.supports('-webkit-background-clip', 'text') || CSS.supports('background-clip', 'text');
    } catch (e) {
      return false;
    }
  })();
  if (CAN_GRADIENT_TEXT) document.body.classList.add('lc-rainbow-ok');

  function hexToRgba(hex, a) {
    const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 'rgba(255, 122, 26, ' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  }

  function setColor(name) {
    const key = LYRIC_COLORS[name] ? name : 'orange';
    colorMode = key;
    const c = LYRIC_COLORS[key];
    // 只认标准 6 位 hex：脏配置进来也不会让 var() 失效变黑字
    const hi = /^#[0-9a-f]{6}$/i.test(c.hi) ? c.hi : '#ff7a1a';
    const root = document.documentElement;
    root.style.setProperty('--dl-hi', hi);
    root.style.setProperty('--dl-glow', c.glow || hexToRgba(hi, 0.55));
    // 下一句 / 逐字未唱部分用同色系淡版，纯白主题才用白
    root.style.setProperty('--dl-dim', key === 'white' ? 'rgba(255, 255, 255, .72)' : hexToRgba(hi, 0.62));
    // 彩虹走渐变文字，用单独的类控制
    document.body.classList.toggle('lc-rainbow', key === 'rainbow');
  }

  // 拖动：不用 -webkit-app-region: drag（会吞掉双击），改为按下时通知主进程，
  // 由主进程按光标屏幕坐标持续移动窗口，跨缩放/窗口飞出可视区都不丢
  let dragging = false;

  stage.addEventListener('pointerdown', (e) => {
    if (locked || e.button !== 0) return;
    if (e.target.closest('.dl-btn')) return;
    if (!window.baba || !window.baba.startLyricDrag) return;
    dragging = true;
    document.body.classList.add('dragging');
    window.baba.startLyricDrag();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    if (window.baba && window.baba.endLyricDrag) window.baba.endLyricDrag();
  }

  // 用 window 级监听：鼠标拖到窗口外松手也能收尾，不然窗口会一直跟着鼠标跑
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  // 双击歌词 = 锁定（进鼠标穿透）。主进程另有系统级双击消息兜底，
  // 这里覆盖控制条这类非拖拽区域的双击
  stage.addEventListener('dblclick', (e) => {
    if (locked) return;
    if (e.target.closest('.dl-btn')) return;
    if (window.baba) window.baba.lockDesktopLyric(true);
  });

  if (window.baba) {
    window.baba.onLyricState(apply);
    window.baba.onLyricLock(setLocked);
    if (window.baba.onLyricFont) window.baba.onLyricFont(setFont);
    if (window.baba.onLyricColor) window.baba.onLyricColor(setColor);
    // 窗口加载完成和主进程推送颜色之间有竞态：这里主动问一次当前主题色，
    // 避免刚打开桌面歌词时一直是默认色/白色
    if (window.baba.getLyricColor) {
      window.baba
        .getLyricColor()
        .then((c) => {
          if (c) setColor(c);
        })
        .catch(() => {});
    }
    // 锁定后靠全局快捷键解锁，但 Ctrl+Alt+L 可能被别的软件占走，
    // 真实生效的键位由主进程告知，这里同步到空态提示里
    if (window.baba.getLyricHotkey) {
      window.baba
        .getLyricHotkey()
        .then((hk) => {
          hotkeyLabel = hk || '托盘菜单';
          if (lastState && !lastState.name) {
            hint.textContent =
              'BBMusic 桌面歌词 · 拖动可移动，双击锁定（' + hotkeyLabel + ' 解锁）';
          }
        })
        .catch(() => {});
    }
  }

  applyFxClasses();
  setLine(elCur, '');
  setLine(elNext, '');
  playBtn.innerHTML = ICON_PLAY;
})();
