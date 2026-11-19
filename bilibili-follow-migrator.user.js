// ==UserScript==
// @name         B站关注迁移助手（A → B）
// @namespace    local.bilibili-follow-migrator
// @version      1.0.1
// @description  导出自己的关注列表，切换账号后去重迁移；限速、暂停续传、失败重试与结果核对。
// @match        https://www.bilibili.com/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';
  const FORMAT = 'bilibili-follow-migration/v1';
  const STATUSES = ['pending', 'sending', 'success', 'existing', 'self', 'failed'];
  const RISK = new Set([-352, -412, -509, -799, 412, 429, 22015]);
  const HALT = new Set([-101, -102, -111, 22009, 'ACCOUNT', 'PAUSED', 'NETWORK', 'PROTOCOL']);
  function fault(message, code) { return Object.assign(new Error(message), { code }); }
  function uid(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fault('UID 数字精度不可靠，请重新导出。', 'FORMAT');
    const s = String(value ?? '');
    if (!/^[1-9]\d{0,19}$/.test(s)) throw fault('文件包含无效 UID。', 'FORMAT');
    return s;
  }
  function normalize(raw) {
    if (!raw || raw.format !== FORMAT || raw.complete !== true || !Array.isArray(raw.users) || raw.users.length > 20000)
      throw fault('请选择本助手完整导出的关注 JSON 文件。', 'FORMAT');
    const source = { uid: uid(raw.source?.uid), name: String(raw.source?.name || '').slice(0, 100) };
    if (!Number.isInteger(raw.total) || raw.total !== raw.users.length) throw fault('文件人数不一致，拒绝导入。', 'FORMAT');
    const users = raw.users.map(u => ({ uid: uid(u.uid), name: String(u.name || '').slice(0, 100) }));
    if (new Set(users.map(u => u.uid)).size !== users.length) throw fault('文件存在重复 UID，请重新导出。', 'FORMAT');
    return { format: FORMAT, complete: true, source, total: users.length, exportedAt: String(raw.exportedAt || ''), users };
  }
  async function collect(account, api, wait, checkpoint, progress = () => {}) {
    await checkpoint(account.uid);
    const before = (await api('/x/relation/stat', { vmid: account.uid })).following;
    if (!Number.isInteger(before) || before < 0 || before > 20000) throw fault('关注总数异常。', 'PROTOCOL');
    const seen = new Map();
    for (let pn = 1; pn <= Math.ceil(before / 50); pn++) {
      await checkpoint(account.uid);
      const data = await api('/x/relation/followings', { vmid: account.uid, pn, ps: 50, order: 'desc', order_type: 'attention' });
      if (!data || !Array.isArray(data.list) || data.total !== before || !data.list.length)
        throw fault('关注列表不完整或读取期间发生变化，请稍后重新读取。', 'INCOMPLETE');
      for (const u of data.list) {
        const id = uid(u.mid);
        if (seen.has(id)) throw fault('分页出现重复记录，不能确认列表完整，请重新读取。', 'INCOMPLETE');
        seen.set(id, { uid: id, name: String(u.uname || '').slice(0, 100) });
      }
      progress(seen.size, before);
      await wait(1600);
    }
    await checkpoint(account.uid);
    const after = (await api('/x/relation/stat', { vmid: account.uid })).following;
    if (after !== before || seen.size !== before) throw fault(`列表未通过完整性检查：读取 ${seen.size} / ${before}，当前总数 ${after}。`, 'INCOMPLETE');
    return [...seen.values()];
  }
  function reconcile(job, current, verify = false) {
    const set = new Set(current.map(u => uid(u.uid)));
    for (const item of job.items) {
      if (item.uid === job.target.uid) { item.status = 'self'; item.error = ''; }
      else if (set.has(item.uid)) {
        item.status = ['success', 'sending'].includes(item.status) ? 'success' : 'existing';
        item.error = '';
      } else if (verify) { item.status = 'failed'; item.error = '核对时 B 的关注列表中未找到'; }
      else if (item.status !== 'failed') { item.status = 'pending'; item.error = ''; }
    }
    job.verifiedAt = verify ? new Date().toISOString() : null;
    return job;
  }
  function counts(job) {
    return Object.fromEntries(STATUSES.map(s => [s, job?.items.filter(i => i.status === s).length || 0]));
  }
  async function runQueue(job, env, retry = false) {
    const queue = job.items.filter(i => i.status === 'pending' || (retry && i.status === 'failed'));
    let consecutive = 0;
    for (const item of queue) {
      await env.wait(job.delay * 1000 + Math.floor(env.random() * 2000));
      await env.checkpoint(job.target.uid);
      item.status = 'sending'; item.error = ''; item.attempts++;
      job.verifiedAt = null;
      env.save(job); // Persist before the write; interrupted requests are reconciled on resume.
      try {
        await env.follow(item.uid, job.target.uid);
        item.status = 'success'; consecutive = 0;
      } catch (e) {
        if (e.code === 22014) { item.status = 'existing'; item.error = ''; consecutive = 0; }
        else {
          item.status = 'failed'; item.error = String(e.message).slice(0, 300); consecutive++;
          env.save(job);
          if (RISK.has(e.code) || HALT.has(e.code) || consecutive >= 3) throw e;
        }
      }
      env.save(job);
    }
  }
  const Core = { FORMAT, uid, normalize, collect, reconcile, counts, runQueue };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

  const KEY = 'bfm-migration-job-v1';
  const LOCK = 'local-bilibili-follow-migration-v1';
  let job = GM_getValue(KEY, null), busy = false, paused = false, account = null;
  let sourceFile = null;
  const cookie = key => document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1);
  const host = document.createElement('div');
  host.id = 'bili-migration-assistant';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host{all:initial;font-family:system-ui,-apple-system,sans-serif;color:#203245;font-size:14px}
    *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;border:1px solid #d4e0e8;border-radius:8px;padding:9px 12px;background:#fff;color:#203245}button:disabled{opacity:.45;cursor:not-allowed}button:hover:enabled{border-color:#008bb5}.primary{background:#007fa4;color:white;border-color:#007fa4}
    #launch{position:fixed;right:22px;bottom:32px;z-index:2147483646;box-shadow:0 3px 18px #0002}
    #panel{position:fixed;right:20px;bottom:88px;z-index:2147483647;width:min(600px,calc(100vw - 30px));max-height:calc(100vh - 110px);overflow:auto;background:#f6f9fc;border:1px solid #c9d9e5;border-radius:16px;box-shadow:0 12px 60px #0003;padding:20px}
    [hidden]{display:none!important}header{display:flex;justify-content:space-between;align-items:center}h2{font-size:20px;margin:0}h3{font-size:15px;margin:0 0 10px}p{line-height:1.65;margin:8px 0;color:#53677b}section{background:white;border:1px solid #e0e8ef;border-radius:10px;padding:14px;margin-top:12px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.small{font-size:12px}input[type=number]{width:70px;padding:7px;border:1px solid #cad9e3;border-radius:6px}#stats{font-variant-numeric:tabular-nums;margin:10px 0;line-height:1.8}#log{white-space:pre-wrap;font-size:12px;max-height:120px;overflow:auto;background:#eaf0f6;border-radius:8px;padding:10px;line-height:1.65}#preview{max-height:180px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:6px;border-bottom:1px solid #e9eef2;word-break:break-all}#status{font-weight:600;color:#00728f}summary{cursor:pointer}#who{word-break:break-all}
  </style>
  <button id="launch" class="primary">关注迁移 A → B</button>
  <div id="panel" hidden>
    <header><h2>关注迁移助手</h2><button id="close">收起</button></header>
    <p class="small">只添加 B 缺少的关注；不取消 A/B 的关注，不迁移分组、粉丝身份或关注时间。</p>
    <div class="row"><span id="who">当前账号：尚未读取</span><button id="identify">识别账号</button></div>
    <section><h3>① 在 A 账号导出</h3><p class="small">先在 B站网页登录 A，再点导出。完整性检查通过后才会下载文件。</p><button id="export">读取并导出 A 的全部关注</button></section>
    <section><h3>② 切换 B 账号，导入并比对</h3><p class="small">切换账号后刷新网页。选择刚才的 JSON 文件，比对只读取数据，不会关注任何人。</p><div class="row"><button id="choose">选择 A 的名单</button><input id="file" type="file" accept=".json,application/json" hidden><button id="prepare">比对 B，生成待迁移名单</button></div><p id="fileinfo" class="small">未选择文件</p></section>
    <section><h3>③ 迁移与核对</h3><p id="route">尚未建立任务</p><div class="row"><label>每次关注至少间隔 <input id="delay" type="number" min="5" max="120" value="8"> 秒</label></div><p class="small">额外随机等待 0–2 秒。开始/续传前重新比对 B；失败不会被当作成功。</p><div id="stats"></div><div class="row"><button id="start" class="primary">开始 / 继续</button><button id="pause">暂停</button><button id="retry">重试失败项</button><button id="verify">核对迁移结果</button></div><div class="row" style="margin-top:8px"><button id="report">导出进度报告</button><button id="clear">清除本地任务</button></div><details style="margin-top:12px"><summary>查看名单（最多展示前 200 条）</summary><div id="preview"></div></details></section>
    <p id="status" role="status" aria-live="polite">准备就绪</p><div id="log" aria-label="操作日志">进度仅保存在本浏览器的脚本存储中。\n刷新/关闭页面后不会自动继续，需手动点击“开始 / 继续”。</div>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  function log(s) {
    const lines = ($('log').textContent + '\n' + new Date().toLocaleTimeString() + ' ' + s).split('\n');
    $('log').textContent = lines.slice(-70).join('\n'); $('log').scrollTop = $('log').scrollHeight;
  }
  function status(s) { $('status').textContent = s; }
  const labels = { pending: '待迁移', sending: '结果待核对', success: '已新增', existing: '已有关注，跳过', self: 'B 自己，跳过', failed: '失败/未核实' };
  function render() {
    $('who').textContent = account ? `当前：${account.name}（UID ${account.uid}）` : '当前账号：尚未读取';
    $('route').textContent = job ? `A：${job.source.name}（${job.source.uid}） → B：${job.target.name}（${job.target.uid}）` : '尚未建立任务';
    const c = counts(job);
    $('stats').textContent = job ? `共 ${job.items.length} 人 · 待迁移 ${c.pending} · 已新增 ${c.success} · 跳过 ${c.existing + c.self} · 失败 ${c.failed} · 待核对 ${c.sending}${job.verifiedAt ? ' · 已于 ' + new Date(job.verifiedAt).toLocaleString() + ' 核对' : ''}` : '先导入并比对';
    $('preview').replaceChildren();
    if (job) {
      const table = document.createElement('table');
      for (const item of job.items.slice(0, 200)) {
        const tr = document.createElement('tr');
        for (const value of [item.name || '未命名', item.uid, labels[item.status], item.error || '']) {
          const td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      $('preview').appendChild(table);
    }
    for (const id of ['identify', 'export', 'choose', 'clear', 'delay']) $(id).disabled = busy;
    $('prepare').disabled = busy || !sourceFile;
    for (const id of ['start', 'retry', 'verify', 'report']) $(id).disabled = busy || !job;
    $('pause').disabled = !busy || paused;
  }
  function save(j) { j.updatedAt = new Date().toISOString(); GM_setValue(KEY, j); job = j; render(); }
  function guard(expected) {
    if (paused) throw fault('已暂停。当前已发出的请求会先记录结果。', 'PAUSED');
    if (expected && cookie('DedeUserID') !== expected) throw fault('登录账号已变化，已停止；请切回任务的 B 账号并刷新。', 'ACCOUNT');
  }
  async function wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { guard(); await new Promise(r => setTimeout(r, Math.min(250, end - Date.now()))); }
  }
  async function api(path, params = {}, method = 'GET') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const url = new URL(path, 'https://api.bilibili.com');
      const options = { method, credentials: 'include', cache: 'no-store', signal: controller.signal };
      if (method === 'GET') url.search = new URLSearchParams(params).toString();
      else { options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; options.body = new URLSearchParams(params).toString(); }
      const response = await fetch(url, options);
      if (!response.ok) throw fault(`接口 HTTP ${response.status}，已暂停，请稍后再试。`, [412, 429].includes(response.status) ? response.status : 'NETWORK');
      let json;
      try { json = await response.json(); } catch { throw fault('接口未返回有效数据，请稍后重试。', 'PROTOCOL'); }
      if (!json || !Number.isInteger(json.code)) throw fault('接口响应格式异常。', 'PROTOCOL');
      if (json.code !== 0) throw fault(`接口 ${json.code}：${String(json.message || '请求失败').slice(0, 180)}`, json.code);
      return json.data;
    } catch (e) {
      if (e.code !== undefined && !(e instanceof DOMException)) throw e;
      throw fault('网络中断或超时。写入结果可能尚未返回，续传前会重新比对，避免重复关注。', 'NETWORK');
    } finally { clearTimeout(timer); }
  }
  async function identity(expected) {
    guard(expected);
    const data = await api('/x/web-interface/nav');
    if (!data?.isLogin) throw fault('请先登录 B站网页版。', 'ACCOUNT');
    const me = { uid: uid(data.mid), name: String(data.uname || '').slice(0, 100) };
    if ((expected && me.uid !== expected) || cookie('DedeUserID') !== me.uid) throw fault('账号状态不一致，请刷新网页。', 'ACCOUNT');
    guard(expected); account = me; render(); return me;
  }
  async function fullList(me) {
    const list = await collect(me, api, wait, async expected => { guard(expected); }, (n, total) => status(`读取 ${me.name} 的关注：${n} / ${total}`));
    await identity(me.uid);
    return list;
  }
  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function action(work) {
    if (busy) return;
    if (!navigator.locks) { status('浏览器缺少任务互斥支持，请使用新版 Chrome、Edge 或 Firefox。'); return; }
    try {
      await navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
        if (!lock) throw fault('另一个 B站标签页正在执行本助手任务，请先在那里暂停。', 'LOCK');
        busy = true; paused = false; job = GM_getValue(KEY, null); render();
        try { await work(); }
        catch (e) { status(e.message); log(e.message); }
        finally { busy = false; paused = false; render(); }
      });
    } catch (e) { status(e.message); log(e.message); }
  }
  $('launch').onclick = () => { $('panel').hidden = !$('panel').hidden; };
  $('close').onclick = () => { $('panel').hidden = true; };
  GM_registerMenuCommand('打开关注迁移助手', () => { $('panel').hidden = false; });
  $('identify').onclick = () => action(async () => { await identity(); status('账号已识别'); });
  $('export').onclick = () => action(async () => {
    const me = await identity(), users = await fullList(me);
    download(`B站关注_A-${me.uid}_${new Date().toISOString().slice(0, 10)}.json`, { format: FORMAT, source: me, complete: true, total: users.length, exportedAt: new Date().toISOString(), users });
    status(`已完整导出 ${users.length} 人。现在可切换 B 账号并刷新页面。`);
  });
  $('choose').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const file = $('file').files[0]; if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('文件过大，请选择本助手导出的 JSON。');
      sourceFile = normalize(JSON.parse(await file.text()));
      $('fileinfo').textContent = `A：${sourceFile.source.name}（${sourceFile.source.uid}），${sourceFile.total} 人`;
      status('名单已载入，点击“比对 B”');
    } catch (e) { sourceFile = null; $('fileinfo').textContent = '导入失败'; status(e.message); }
    $('file').value = ''; render();
  };
  $('prepare').onclick = () => action(async () => {
    if (!sourceFile) throw new Error('请先选择名单。');
    const me = await identity();
    if (me.uid === sourceFile.source.uid) throw new Error('当前仍是 A 账号，请切换 B 账号后刷新。');
    if (job && !confirm('生成新任务会替换本地旧任务进度（不会改变账号的已有关注）。是否继续？')) return;
    const current = await fullList(me);
    const next = { version: 1, source: sourceFile.source, target: me, delay: 8, createdAt: new Date().toISOString(), items: sourceFile.users.map(u => ({ ...u, status: 'pending', error: '', attempts: 0 })) };
    reconcile(next, current); save(next); $('delay').value = next.delay;
    status(`比对完成：${counts(next).pending} 人待迁移。请展开名单检查，再点击“开始 / 继续”。`);
  });
  async function migrate(retry) {
    if (!job) throw new Error('请先生成任务。');
    const delay = Number($('delay').value);
    if (!Number.isFinite(delay) || delay < 5 || delay > 120) throw new Error('间隔需为 5–120 秒。');
    job.delay = delay;
    const me = await identity(job.target.uid);
    if (me.uid === job.source.uid) throw new Error('来源和目标不能是同一账号。');
    const current = await fullList(me); reconcile(job, current); save(job);
    const c = counts(job), n = c.pending + (retry ? c.failed : 0);
    if (!n) { status(c.failed ? '待迁移项已处理；还有失败项，可点击“重试失败项”。' : '名单中的 UP 已全部在 B 的关注中（B 自己除外）。'); return; }
    if (!confirm(`目标 B：${me.name}（UID ${me.uid}）\n本次最多关注 ${n} 人，跳过已关注和 B 自己。\n每次间隔 ${delay}–${delay + 2} 秒，可随时暂停。\n是否开始？`)) { status('已取消开始，未执行关注。'); return; }
    status('迁移中；请保持此页面打开，不要切换登录账号。');
    await runQueue(job, {
      wait, random: Math.random, checkpoint: identity, save,
      follow: async (id, target) => {
        guard(target);
        const csrf = cookie('bili_jct');
        if (!csrf) throw fault('登录凭据缺失，请重新登录并刷新。', 'ACCOUNT');
        return api('/x/relation/modify', { fid: id, act: 1, re_src: 11, csrf }, 'POST');
      }
    }, retry);
    status('本轮已结束，正在重新读取 B 的关注核对结果…');
    await wait(3000);
    reconcile(job, await fullList(await identity(job.target.uid)), true); save(job);
    status(counts(job).failed ? `核对完成，${counts(job).failed} 人仍未关注，可检查报告后重试。` : '核对通过：A 名单中的 UP 已在 B 的关注列表中（B 自己除外）。');
  }
  $('start').onclick = () => action(() => migrate(false));
  $('retry').onclick = () => action(() => migrate(true));
  $('pause').onclick = () => { paused = true; status('正在暂停：等待当前请求返回并保存，之后不再发送新请求。'); render(); };
  $('verify').onclick = () => action(async () => {
    if (!job) return;
    reconcile(job, await fullList(await identity(job.target.uid)), true); save(job);
    status(`核对完成：${counts(job).failed} 人尚未确认关注。`);
  });
  $('report').onclick = () => action(async () => {
    if (!job) return;
    download(`B站迁移报告_B-${job.target.uid}.json`, { ...job, summary: counts(job), note: '此文件为审阅报告，不含 Cookie，不用作 A 名单导入。任务续传使用当前浏览器脚本存储。' });
    status('已导出进度报告');
  });
  $('clear').onclick = () => action(async () => {
    if (!confirm('只删除本浏览器保存的任务进度，不会取关任何人。确定清除？')) return;
    GM_deleteValue(KEY); job = null; status('本地任务已清除'); render();
  });
  if (job) $('delay').value = job.delay;
  window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  render();
})();
