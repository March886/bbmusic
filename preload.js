const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('baba', {
  search: (keyword, opts) => ipcRenderer.invoke('search', keyword, opts),
  getUrl: (platform, id) => ipcRenderer.invoke('get-url', platform, id),
  lyric: (platform, id, name, artists) => ipcRenderer.invoke('lyric', platform, id, name, artists),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  login: (platform) => ipcRenderer.invoke('login', platform),
  logout: (platform) => ipcRenderer.invoke('logout', platform),
  // 登录态检测：force=true 忽略 24h 缓存重测；返回 { netease:{state,nick,...}, qq:{state,nick,uin,...} }
  authCheck: (force) => ipcRenderer.invoke('auth:check', !!force),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchToplist: (platform) => ipcRenderer.invoke('toplist', platform),
  appInfo: () => ipcRenderer.invoke('app-info'),
  // 歌单分享链接导入：传 QQ 音乐 / 网易云的歌单分享文本，返回解析后的歌单
  importPlaylist: (link) => ipcRenderer.invoke('playlist:import', link),
  // 该曲在导入平台因 VIP / 版权下架不可播时，去其他平台反查同一首歌的可播音源
  findSources: (song) => ipcRenderer.invoke('song:find-sources', song),
  // 搜索返回后热度/评论数是异步补的，补到一条推一条
  onMeta: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('meta:update', h);
    return () => ipcRenderer.removeListener('meta:update', h);
  },

  /* ---------- 桌面歌词 ---------- */
  // force 省略即切换：开着就关、关着就开
  toggleDesktopLyric: (force) => ipcRenderer.invoke('lyric-window:toggle', force),
  desktopLyricState: () => ipcRenderer.invoke('lyric-window:state'),
  // 主窗口 → 主进程 → 桌面歌词窗口
  pushLyricState: (payload) => ipcRenderer.send('lyric:push', payload),
  onLyricState: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('lyric:state', h);
    return () => ipcRenderer.removeListener('lyric:state', h);
  },
  onLyricVisibility: (cb) => {
    const h = (e, visible) => cb(visible);
    ipcRenderer.on('lyric:visibility', h);
    return () => ipcRenderer.removeListener('lyric:visibility', h);
  },
  // 桌面歌词窗口 → 主窗口（播放/暂停、上下一曲）
  lyricCommand: (action) => ipcRenderer.send('lyric-window:command', action),
  onLyricCommand: (cb) => {
    const h = (e, action) => cb(action);
    ipcRenderer.on('lyric:command', h);
    return () => ipcRenderer.removeListener('lyric:command', h);
  },
  closeDesktopLyric: () => ipcRenderer.send('lyric-window:close-req'),
  lockDesktopLyric: (locked) => ipcRenderer.send('lyric-window:lock', !!locked),
  startLyricDrag: () => ipcRenderer.send('lyric-window:drag-start'),
  endLyricDrag: () => ipcRenderer.send('lyric-window:drag-end'),
  // 主进程（托盘 / 快捷键）把穿透状态改回来后通知歌词窗口，让本地状态跟上
  onLyricLock: (cb) => {
    const h = (e, locked) => cb(locked);
    ipcRenderer.on('lyric:lock', h);
    return () => ipcRenderer.removeListener('lyric:lock', h);
  },
  // 桌面歌词字号：26 / 34 / 42 / 52（主行像素，次行自动按比例缩）
  setLyricFont: (size) => ipcRenderer.invoke('lyric-window:font', size),
  onLyricFont: (cb) => {
    const h = (e, size) => cb(size);
    ipcRenderer.on('lyric:font', h);
    return () => ipcRenderer.removeListener('lyric:font', h);
  },
  // 歌词颜色主题（orange/pink/blue/green/purple/white/rainbow）
  onLyricColor: (cb) => {
    const h = (e, color) => cb(color);
    ipcRenderer.on('lyric:color', h);
    return () => ipcRenderer.removeListener('lyric:color', h);
  },
  // 歌词被拖到屏幕外面时拉回主屏底部居中
  resetLyricPosition: () => ipcRenderer.invoke('lyric-window:reset-pos'),
  // 桌面歌词窗口启动时主动拉一次当前主题色，补上推送时序的空档
  getLyricColor: () => ipcRenderer.invoke('lyric-window:color'),
  // 缓存设置：查占用、换目录、清空、开关
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  cachePickDir: () => ipcRenderer.invoke('cache:pick-dir'),
  cacheClear: () => ipcRenderer.invoke('cache:clear'),
  cacheSetEnabled: (on) => ipcRenderer.invoke('cache:set-enabled', !!on),
  cacheDropOne: (platform, id) => ipcRenderer.invoke('cache:drop-one', platform, id),
  // 解锁快捷键实际生效的键位（Ctrl+Alt+L 被占用时会降级到备用键）
  getLyricHotkey: () => ipcRenderer.invoke('lyric-window:hotkey'),

  /* ---------- 自动检测更新 ---------- */
  // 检查是否有新版本，返回 { ok, status, currentVersion, info:{version,notes}, progress, error }
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  // 退出应用并安装已下载的新版本
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  openReleasePage: () => ipcRenderer.invoke('update:open-release'),
  // 主进程推送更新状态：checking / available / downloading / downloaded / error
  onUpdateEvent: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('update:event', h);
    return () => ipcRenderer.removeListener('update:event', h);
  },
});
