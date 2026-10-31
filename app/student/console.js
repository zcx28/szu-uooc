import {explainProblem, activityMessage, serviceActionFor} from './user-guidance.mjs';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = { play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>', pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>' };
let state;
let polling = false;
let busy = false;
let toastTimeout;
let closed = false;
let guideStep = "login";
let guideError = "";
const browserName = () => state?.browser?.name || 'Chrome';

function toast(message, error = false) {
  if (error) { const dialog = document.querySelector('dialog[open]'); const target = dialog?.querySelector('.form-error') || $('#action-error'); if (dialog && target.id === 'action-error') dialog.close(); target.textContent = explainProblem(message, browserName()); target.hidden = false; return; }
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => element.hidden = true, error ? 6500 : 3000);
}
function money(amount) { return amount === null ? '待核对' : amount > 0 && amount < .0001 ? '< $0.0001' : '$' + Number(amount || 0).toFixed(4); }
function courseCosts(course) {
  const costs = course.costs;
  const processing = state.activeIds.includes(course.id) && course.phase === 'solving' && costs.pending > 0 && costs.unresolvedRequests === costs.pending && costs.unknownRequests === 0;
  return `费用 ${money(costs.spent)}${costs.reserved ? (processing ? ' · 处理中 ' : ' · 待核对 ') + money(costs.reserved) : ''}${costs.unknown && !processing ? ' · 请核对账单' : ''}`;
}
function detectionCost(costs) { return `预估 ${money(costs.estimated_usd)}${costs.unknown ? ' · 费用待核对' : ''}`; }
function percent(course) { return course.total ? Math.max(0, Math.min(100, Math.round(course.completed / course.total * 100))) : 0; }
function progress(course) {
  if (course.lockedUnits > 0 || course.phase === 'loading_catalog') return `<p class="field-help">已读取任务 · ${course.lockedUnits > 0 ? `${Number(course.lockedUnits)} 个目录单元待解锁` : '正在读取目录'}，总任务数待确认</p>`;
  return `<progress class="progress" value="${percent(course)}" max="100" aria-label="${esc(course.name)}任务进度">${percent(course)}%</progress>`;
}
function courseButton(course, action, text, cls = 'secondary') {
  const blocked = ['start', 'resume'].includes(action) && state.activeIds.some(id => id !== course.id);
  return `<button class="button ${cls}" data-course="${esc(course.id)}" data-action="${action}" ${busy || blocked ? 'disabled' : ''} ${blocked ? 'title="先停止当前课程，再开始另一门"' : ''}>${text}</button>`;
}
function buttons(course) {
  if (['pausing', 'stopping'].includes(course.status)) return `<button class="button secondary" disabled>${esc(course.statusLabel)}…</button>`;
  if (course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id)) return courseButton(course, 'focus', '去验证', 'primary') + courseButton(course, 'pause', '暂停');
  if (state.activeIds.includes(course.id) && ['running', 'starting'].includes(course.status)) return courseButton(course, 'pause', '暂停');
  if (course.status === 'paused') return courseButton(course, 'resume', '继续') + (state.activeIds.includes(course.id) ? courseButton(course, 'stop', '停止') : '');
  if (course.status === 'complete') return '<span class="done-icon" aria-label="已完成"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></span>';
  return courseButton(course, 'start', ['error','stopped'].includes(course.status) ? '继续' : '开始');
}
const renderedHTML = new Map();
function updateHTML(selector, html) {
  if (renderedHTML.get(selector) === html) return;
  const element = $(selector), opened = [...element.querySelectorAll('.course-row details[open]')].map(detail => detail.closest('[data-id]').dataset.id);
  const focus = document.activeElement;
  const focusCheckin = element.contains(focus) ? focus.dataset.checkinCourse : null;
  const focusRow = element.contains(focus) ? focus.closest('.course-row')?.dataset.id : null;
  const focusIndex = focusRow ? [...focus.closest('.course-row').querySelectorAll('button,input,summary,a')].indexOf(focus) : -1;
  element.innerHTML = html; renderedHTML.set(selector, html);
  for (const id of opened) element.querySelector(`.course-row[data-id="${CSS.escape(id)}"] details`)?.setAttribute('open', '');
  if (focusRow) element.querySelector(`.course-row[data-id="${CSS.escape(focusRow)}"]`)?.querySelectorAll('button,input,summary,a')[focusIndex]?.focus({ preventScroll: true });
  if (focusCheckin) element.querySelector(`[data-checkin-course="${CSS.escape(focusCheckin)}"]`)?.focus({ preventScroll: true });
}
function renderGuide() {
  const environment = state.environment, browser = state.browser || {};
  let html;
  if (environment.status !== 'ready') html = `<h2>${esc(environment.status === 'error' ? '启动文件未就绪' : '正在准备运行环境')}</h2>${environment.status === 'error' ? '<button class="button primary" data-environment>重新下载</button>' : '<progress aria-label="正在准备运行环境"></progress>'}`;
  else if (browser.selectionRequired) html = '<h2>选择学习浏览器</h2><div class="guide-actions"><button class="button primary" data-open="browser">选择浏览器</button></div>';
  else if (browser.status !== 'connected') {
    if (browser.kind === 'firefox') html = '<h2>连接 Firefox</h2><p class="guide-note">将打开独立的 Firefox 窗口。首次尝试导入优课网登录；需要时请在该窗口登录，再读取课程。</p><div class="guide-actions"><button class="button primary" data-connect>打开 Firefox 并连接</button></div>';
    else if (guideStep === 'login' && !state.courses.length && browser.status !== 'connecting') html = '<h2>登录课程账号</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-guide-step="debug">已登录，下一步</button></div>';
    else html = `<h2>${browser.status === 'connecting' ? `在 ${esc(browserName())} 中允许连接` : `连接 ${esc(browserName())}`}</h2><div class="debug-address"><input id="debug-url" aria-label="${esc(browserName())} 调试页地址" readonly value="${esc(browser.debugURL)}"><button class="button secondary" data-copy-debug>复制调试页地址</button></div><ol class="guide-steps"><li>复制地址，在 ${esc(browserName())} 中粘贴打开。</li><li>开启 <strong>Allow remote debugging</strong>，连接时选择「允许」。</li></ol><div class="guide-actions"><button class="button primary" data-connect>${browser.status === 'connecting' ? '等待允许…' : `已开启，连接 ${esc(browserName())}`}</button></div>`;
  } else if (browser.catalog === 'error') html = '<h2>重新打开我的课程</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-read-courses>已登录，读取课程</button></div>';
  else if (!state.courses.length) html = '<h2>导入课程</h2><div class="guide-actions"><button class="button primary" data-read-courses>读取我的课程</button><button class="button secondary" data-browser-open="site">打开我的课程</button></div><p class="guide-note"><button class="text-button" data-open="add">粘贴课程网址</button></p>';
  else if (browser.needsCourseRefresh) html = '<h2>核对课程账号</h2><button class="button primary" data-read-courses>读取我的课程</button>';
  else if (!state.config.hasKey && state.config.answer_mode !== 'free') html = '<h2>选择答题方式</h2><p class="guide-note">免费模式优先题库，缺题随机提交，可能答错。</p><div class="guide-actions"><button class="button primary" data-free-mode>免费开始</button><button class="button secondary" data-open="settings">设置解题服务</button></div>';
  if (!html && (guideError || browser.error || state.configError)) html = '<h2>需要处理</h2>';
  $('#onboarding').hidden = !html;
  updateHTML('#guide-content', html ? `<div class="guide-body">${html}</div>` : '');
  $('#guide-error').textContent = explainProblem(guideError || browser.error || state.configError, browserName());
  document.querySelectorAll('#onboarding button').forEach(button => button.disabled = busy);
}
function courseHelp(course) {
  if (course.costs.unreadable || course.costs.meteringBoundExceeded) return `<div class="course-help" role="status"><p>${esc(explainProblem('费用记录异常'))}</p></div>`;
  const billing = /上次请求费用未知|结果或费用未知|已自动(?:补跑|重试) 2 次/.test(course.error);
  if (course.costs.recoveryRequired && (!course.error || ['用户暂停','用户停止'].includes(course.error) || billing)) return `<div class="course-help" role="status"><p>${esc(explainProblem('上次请求费用未知'))}</p></div>`;
  const issue = serviceActionFor(course.error);
  const service = /Key|API|HTTP\s*[45]\d\d|解题服务|模型|图片|价格|余额|费用未知|用量上限/.test(course.error);
  const manual = /图片|识图|测验|视频|资源|交卷|验证|答案|选项|断点|锁定|闯关/.test(course.error);
  const serviceButton = service && !billing ? `<button class="button secondary" data-fix-service="${esc(course.id)}" data-service-kind="${issue}" ${issue === 'retry' ? 'data-service-retry="true"' : ''}>${{ key: '修改 Key', retry: '重新检测', model: '更换模型', url: '修改服务' }[issue]}</button>` : '';
  const courseLink = state.activeIds.includes(course.id) ? `data-course="${esc(course.id)}" data-action="focus"` : `data-course-open="${esc(course.id)}"`;
  return `<div class="course-help" role="status"><p>${esc(explainProblem(course.error, browserName()))}</p>${service || manual ? `<span class="dialog-actions">${serviceButton}${manual ? `<button class="button secondary" ${courseLink}>打开课程</button>` : ''}</span>` : ''}</div>`;
}
function render() {
  state.activeIds ||= state.activeId ? [state.activeId] : [];
  renderGuide();
  $('#courses-section').hidden = !state.courses.length;
  $('#service-label').textContent = state.config.answer_mode === 'free' ? '免费模式' : state.config.hasKey ? state.config.model : '未设置';
  $('#checkin-summary').textContent = state.checkin?.settings.enabled ? '已开启' : '未开启';
  $('#browser-name-summary').textContent = browserName();
  $('#learning-browser-status').textContent = `${browserName()} · ${state.browser?.status === 'connected' ? '已连接' : state.browser?.status === 'connecting' ? '正在连接' : '未连接'}`;
  $('#change-learning-browser').title = state.activeIds.length ? '先停止当前课程，再更换浏览器' : '选择已安装的学习浏览器';
  $('#connect-again-label').textContent = '重新连接 ' + browserName();
  $('#checkin-profile-label').textContent = browserName() + ' 个人资料';
  $('#browser-summary').textContent = state.browser?.status === 'connected' ? '已连接' : '未连接';
  $('#stop-all').disabled = busy || !state.activeIds.length;
  $('#stop-all').hidden = !state.activeIds.length;
  $('#connect-again').hidden = state.browser?.status === 'connected';
  document.querySelectorAll('[data-open]').forEach(button => button.disabled = busy || (button.dataset.open === 'browser' && state.activeIds.length > 0));
  updateHTML('#course-list', state.courses.map(course => {
    const awaiting = course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id);
    const canStart = (state.config.hasKey || state.config.answer_mode === 'free') && state.environment.status === 'ready' && state.browser?.status === 'connected' && !state.browser.needsCourseRefresh;
    const control = !canStart && !state.activeIds.includes(course.id) ? '' : buttons(course);
    return `<article class="course-row" data-id="${esc(course.id)}"><div class="course-name"><h3>${esc(course.name)}</h3><p>${esc(course.currentTitle || (course.status === 'ready' ? '' : course.phaseLabel || ''))}</p></div><div class="course-progress"><div class="course-status ${esc(awaiting ? course.phase : course.status)}"><span>${esc(awaiting ? '待验证' : course.statusLabel)}</span><span>${course.total ? `${Number(course.completed) || 0} / ${Number(course.total)}` : '—'}</span></div>${progress(course)}</div><div class="course-buttons">${control}<details class="course-menu"><summary aria-label="${esc(course.name)}更多操作"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="focus">切到课程</button>` : `<button data-course-open="${esc(course.id)}">打开课程</button>`}<button data-edit-course="${esc(course.id)}">课程与签到</button>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="stop">停止学习</button>` : `<button data-course="${esc(course.id)}" data-action="remove">移出列表</button>`}<span class="field-help">${courseCosts(course)}</span></div></details></div>${(course.error && !['用户暂停','用户停止'].includes(course.error) || !['running','starting','pausing','stopping','complete'].includes(course.status) && (course.costs.recoveryRequired || course.costs.unreadable || course.costs.meteringBoundExceeded)) ? courseHelp(course) : awaiting ? '<p class="course-help">完成验证后保持课程页打开。</p>' : ''}</article>`;
  }).join(''));
  updateHTML('#log-list', [...state.logs].reverse().map(log => ({...log, text: activityMessage(log.message, browserName())})).filter(log => log.text).map(log => `<li><time>${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>${esc(log.text)}</li>`).join(''));
  if (state.checkin) {
    $('#checkin-status-error').textContent = explainProblem(state.checkin.error, browserName());
    $('#checkin-message').textContent = `今日已打开 ${state.checkin.counts.opened} / ${state.checkin.counts.total}`;
    $('#checkin-reopen').disabled = busy || state.checkin.running || !state.checkin.settings.browser || !state.checkin.counts.total;
    updateHTML('#checkin-courses', state.courses.map(course => `<div class="checkin-choice"><label class="checkbox-label"><input type="checkbox" data-checkin-course="${esc(course.id)}" ${course.checkin.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>${esc(course.name)}</label><span>${esc(course.checkin.error ? explainProblem('签到打开失败：' + course.checkin.error, browserName()) : course.checkin.label)}</span></div>`).join(''));
  }
}
async function refresh() {
  if (polling || closed) return;
  polling = true;
  try {
    const response = await fetch('/api/state'); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法连接控制台');
    state = data; $('#connection-error').hidden = true; render();
    if (state.shuttingDown) showClosed();
  } catch (error) { $('#connection-error').textContent = '连接已断开，请双击启动文件重新打开。'; $('#connection-error').hidden = false; }
  finally { polling = false; }
}
async function api(route, data = {}) {
  if (!state) throw new Error('控制台尚未连接，请稍后重试。');
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Szu-Token': state.csrf }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '操作没有完成'), { requiresSubmissionConfirmation: result.requiresSubmissionConfirmation === true });
  await refresh(); return result;
}
async function runAction(fn) {
  if (busy) return;
  const focusCheckin = document.activeElement?.dataset.checkinCourse;
  busy = true; $('#action-error').hidden = true; if (state) render();
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally {
    busy = false; if (state && !closed) render();
    if (focusCheckin && $('#checkin-dialog').open && [document.body, $('#checkin-dialog')].includes(document.activeElement)) $('#checkin-courses').querySelector(`[data-checkin-course="${CSS.escape(focusCheckin)}"]`)?.focus({ preventScroll: true });
  }
}
function settingsValues() {
  return { answer_mode: $('#answer-mode').value, api_key: $('#api-key').value.trim(), base_url: $('#base-url').value.trim(), model: $('#model').value };
}
function updatePrices() {
  const free = $('#answer-mode').value === 'free';
  $('#ai-settings').hidden = free; $('#free-mode-note').hidden = !free;
  $('#ai-settings').querySelectorAll('input,select').forEach(input => input.disabled = free);
  $('#detect-save').textContent = free ? '保存答题方式' : '检测并保存';
  $('#detection-cost-note').hidden = free;
  $('#detection-cost-note').textContent = `检测≤$0.02 · 每课≤$${state.config.budget}`;
}
function showDetection(result) {
  $('#model-result').hidden = !result?.profile;
  $('#model-options').hidden = !result?.models?.length && !result?.testCosts?.calls;
  $('#model-summary').textContent = result?.model || '尚无经过验证的可用模型';
  $('#model-capability').textContent = result?.image_profile ? '文字、图片可用' : '文字可用 · 图片题需手动完成';
  $('#model-capability').classList.toggle('limited', !result?.image_profile);
  $('#model-reason').textContent = result?.profile?.price_source === 'https://www.volcengine.com/docs/82379/1544106' ? '人民币报价按 1 美元 = 6 元保守折算。' : '';
  $('#image-model-summary').textContent = result?.image_profile && result.image_profile.id !== result.model ? `图片模型：${result.image_profile.id}` : '';
  $('#model').innerHTML = (result?.models || []).map(model => `<option value="${esc(model.id)}">${esc(model.id)} · ${model.verified_image ? '文字 / 图片' : model.verified_text ? '文字' : model.status === 'failed' ? '不可用' : '未检测'}${model.pricing ? '' : ' · 价格待核实'}</option>`).join('');
  $('#model').value = result?.model || result?.models?.[0]?.id || '';
  $('#model-options').open = false;
  const testCost = result?.testCosts?.calls ? `检测 ${result.testCosts.calls} 次 · ${detectionCost(result.testCosts)}` : '';
  $('#test-result').className = 'test-result'; $('#test-result').textContent = testCost;
  $('#price-summary').textContent = result ? `每课上限 $${state.config.budget}${result.profile ? ' · 报价更新 ' + result.profile.price_updated : result.models?.some(model => model.pricing) ? ' · 模型未通过检测' : ' · 价格待核实'}${testCost ? '。' + testCost : ''}` : '';
  updatePrices();
}
function serviceActions(message) {
  const issue = serviceActionFor(message);
  return issue === 'retry' ? '' : `<button type="button" class="text-button" data-service-action="${issue}">${{ key: '修改 Key', model: '更换模型', url: '修改网址' }[issue]}</button>`;
}
async function openDialog(name) {
  if (name === 'browser') {
    $('#browser-error').textContent = ''; $('#browser-same-account').checked = false;
    $('#browser-submission-field').hidden = true; $('#browser-submission-confirmed').checked = false; $('#browser-submission-confirmed').required = false;
    try {
      const response = await fetch('/api/browsers'); const data = await response.json(); if (!response.ok) throw new Error(data.error);
      $('#browser-kind').innerHTML = data.browsers.map(browser => `<option value="${esc(browser.kind)}" ${browser.installed ? '' : 'disabled'}>${esc(browser.name)}${browser.installed ? '' : '（未安装）'}</option>`).join('');
      let kind = state.browser.kind;
      if (state.browser.selectionRequired && !data.browsers.some(browser => browser.kind === kind && browser.installed)) kind = data.browsers.find(browser => browser.installed)?.kind || '';
      $('#browser-kind').value = kind;
    } catch (error) { $('#browser-error').textContent = explainProblem(error.message, browserName()); }
  }
  if (name === 'checkin') {
    if (!state?.checkin) { toast('控制台正在连接，请稍候。'); return; }
    const settings = state.checkin.settings;
    $('#checkin-enabled').checked = settings.enabled; $('#checkin-mode').value = settings.mode; $('#checkin-time').value = settings.time;
    $('#checkin-time-field').hidden = settings.mode !== 'scheduled'; $('#checkin-autostart').checked = settings.autostart; $('#checkin-script-ready').checked = settings.scriptReady;
    $('#checkin-confirmation-field').hidden = !settings.requiresConfirmation; $('#checkin-account-confirmed').checked = false;
    $('#checkin-error').textContent = ''; loadProfiles(settings.browser?.profileDirectory);
  }
  if (name === 'settings') {
    if (!state) { toast('控制台正在连接，请稍候。'); return; }
    const config = state.config;
    $('#answer-mode').value = config.answer_mode || 'ai';
    $('#api-key').value = ''; $('#api-key').type = 'password'; $('#show-key').textContent = '显示';
    $('#show-key').setAttribute('aria-label', '显示输入的 Key'); $('#show-key').setAttribute('aria-pressed', 'false');
    $('#api-key').placeholder = config.hasKey ? '已保存，留空不修改' : '粘贴完整 Key';
    $('#base-url').value = config.base_url; showDetection(config.detection);
    $('#settings-error').textContent = ''; $('#service-actions').innerHTML = ''; updatePrices();
  }
  if (name === 'add') { $('#add-error').textContent = ''; }
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#' + name + '-dialog').showModal();
}
document.addEventListener('click', event => {
  const fix = event.target.closest('[data-fix-service]');
  if (fix) runAction(async () => {
    if (state.activeIds.includes(fix.dataset.fixService)) {
      await api('/api/course-action', { id: fix.dataset.fixService, action: 'stop' });
      for (let attempt = 0; state.activeIds.includes(fix.dataset.fixService) && attempt < 100; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); await refresh(); }
      if (state.activeIds.includes(fix.dataset.fixService)) throw new Error('正在停止课程并记录费用，请稍等后再修改服务。');
    }
    await openDialog('settings');
    if (fix.dataset.serviceKind === 'model' && !$('#model-options').hidden) { $('#model-options').open = true; $('#model').focus(); }
    else $(fix.dataset.serviceKind === 'key' ? '#api-key' : '#base-url').focus();
  }).then(() => { if (fix.dataset.serviceRetry && $('#settings-dialog').open) detectAndSave(true); });
  const menu = event.target.closest('.course-menu'); if (menu && !event.target.closest('summary')) menu.removeAttribute('open');
  const edit = event.target.closest('[data-edit-course]');
  if (edit) {
    const course = state.courses.find(course => course.id === edit.dataset.editCourse);
    $('#edit-course-id').value = course.id; $('#edit-course-name').value = course.name; $('#edit-course-checkin').checked = course.checkin.enabled;
    $('#edit-checkin-url').value = course.checkin.url; $('#course-checkin-error').textContent = ''; $('#course-checkin-dialog').showModal();
  }
  const courseOpen = event.target.closest('[data-course-open]'); if (courseOpen) runAction(() => api('/api/course-open', { id: courseOpen.dataset.courseOpen }));
  const reopen = event.target.closest('[data-reopen-course]');
  if (reopen) runAction(() => api('/api/checkin-open', { ids: [reopen.dataset.reopenCourse] }));
  const open = event.target.closest('[data-open]'); if (open && !busy) openDialog(open.dataset.open);
  const close = event.target.closest('[data-close]'); if (close) close.closest('dialog').close();
  const action = event.target.closest('[data-course][data-action]');
  if (action) runAction(async () => { await api('/api/course-action', { id: action.dataset.course, action: action.dataset.action }); if (action.dataset.action === 'remove') toast('已从列表移除，已完成进度保留。'); });

});
document.addEventListener('change', event => {
  if (event.target.matches('[data-checkin-course]')) runAction(() => api('/api/checkin-course', { id: event.target.dataset.checkinCourse, enabled: event.target.checked }));
});
async function loadProfiles(selected = $('#checkin-profile').value) {
  $('#checkin-profile').disabled = true;
  try {
    const response = await fetch('/api/checkin-profiles'); const data = await response.json(); if (!response.ok) throw new Error(data.error);
    $('#checkin-profile').innerHTML = '<option value="">请选择已登录的资料</option>' + data.profiles.map(profile => `<option value="${esc(profile.directory)}">${esc(profile.name)}</option>`).join('');
    if (selected) $('#checkin-profile').value = selected;
    $('#checkin-profile-note').textContent = data.error ? explainProblem(data.error, browserName()) : '选择浏览器头像菜单中的同名资料。';
  } catch (error) { $('#checkin-profile-note').textContent = explainProblem(error.message, browserName()); }
  finally { $('#checkin-profile').disabled = false; }
}
$('#browser-kind').addEventListener('change', () => {
  $('#browser-error').textContent = '';
  $('#browser-submission-field').hidden = true; $('#browser-submission-confirmed').checked = false; $('#browser-submission-confirmed').required = false;
});
$('#browser-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => {
    try {
      await api('/api/browser-select', { kind: $('#browser-kind').value, sameAccount: $('#browser-same-account').checked, submissionConfirmed: $('#browser-submission-confirmed').checked });
      guideStep = 'login'; guideError = ''; $('#browser-dialog').close(); toast('已切换浏览器，请重新读取课程。');
    } catch (error) {
      $('#browser-submission-field').hidden = !error.requiresSubmissionConfirmation;
      $('#browser-submission-confirmed').required = error.requiresSubmissionConfirmation === true; $('#browser-submission-confirmed').checked = false;
      $('#browser-error').textContent = error.requiresSubmissionConfirmation ? error.message : explainProblem(error.message, browserName());
    }
  });
});
$('#checkin-mode').addEventListener('change', () => $('#checkin-time-field').hidden = $('#checkin-mode').value !== 'scheduled');
$('#checkin-refresh-profiles').addEventListener('click', () => loadProfiles());
$('#checkin-test-browser').addEventListener('click', () => runAction(async () => { await api('/api/checkin-test', { profileDirectory: $('#checkin-profile').value }); toast('已请求打开 UOOC，请核对当前账号。'); }));
$('#checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => {
    try { await api('/api/checkin-config', { enabled: $('#checkin-enabled').checked, mode: $('#checkin-mode').value, time: $('#checkin-time').value, autostart: $('#checkin-autostart').checked, scriptReady: $('#checkin-script-ready').checked, profileDirectory: $('#checkin-profile').value, accountConfirmed: $('#checkin-account-confirmed').checked }); $('#checkin-dialog').close(); toast('签到设置已保存。'); }
    catch (error) { $('#checkin-error').textContent = explainProblem(error.message, browserName()); }
  });
});
$('#edit-course-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: [$('#edit-course-id').value] })));
$('#course-checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => { try { await api('/api/checkin-course', { id: $('#edit-course-id').value, name: $('#edit-course-name').value, enabled: $('#edit-course-checkin').checked, url: $('#edit-checkin-url').value }); $('#course-checkin-dialog').close(); toast('课程设置已保存。'); } catch (error) { $('#course-checkin-error').textContent = explainProblem(error.message, browserName()); } });
});
$('#checkin-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: state.courses.filter(course => course.checkin.enabled).map(course => course.id) })));
$('#add-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return; const button = event.submitter; button.disabled = true;
  runAction(async () => { try { await api('/api/courses-import', { urls: $('#course-url').value }); event.target.reset(); $('#add-dialog').close(); toast('课程已添加。'); } catch (error) { $('#add-error').textContent = explainProblem(error.message, browserName()); } finally { button.disabled = false; } });
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault(); detectAndSave();
});
async function detectAndSave(force = false) {
  if (busy) return;
  return runAction(async () => {
    const values = settingsValues(); const button = $('#detect-save'); button.disabled = true;
    const fields = [...$('#settings-form').querySelectorAll('input,select,#show-key')].map(field => [field, field.disabled]);
    fields.forEach(([field]) => field.disabled = true);
    $('#settings-error').textContent = ''; $('#service-actions').innerHTML = ''; $('#test-result').className = 'test-result'; $('#test-result').textContent = values.answer_mode === 'free' ? '正在保存…' : '正在检测…';
    button.textContent = values.answer_mode === 'free' ? '保存中…' : '检测中…';
    $('#settings-form').setAttribute('aria-busy', 'true');
    try {
      if (values.answer_mode === 'free') { await api('/api/config', { answer_mode: 'free' }); $('#settings-dialog').close(); toast('已切换为免费答题。'); return; }
      const result = await api('/api/detect-save', { ...values, force });
      if (result.detection) { showDetection(result.detection); $('#api-key').value = ''; $('#api-key').placeholder = '已保存，留空不修改'; $('#base-url').value = result.detection.base_url; }
      const costs = result.detection?.testCosts;
      $('#test-result').textContent = (result.connection.status === 'error' ? explainProblem(result.connection.message, browserName()) : '连接成功，已保存。回到课程点「继续」恢复学习') + (costs?.calls ? ` · 本次${detectionCost(costs)}` : ''); $('#test-result').classList.toggle('error', result.connection.status === 'error'); $('#test-result').classList.toggle('success', result.connection.status !== 'error');
      if (result.connection.status === 'error') $('#service-actions').innerHTML = serviceActions(result.connection.message);
    } catch (error) { $('#settings-error').textContent = explainProblem(error.message, browserName()); $('#service-actions').innerHTML = serviceActions(error.message); }
    finally { button.disabled = false; fields.forEach(([field, disabled]) => field.disabled = disabled); updatePrices(); $('#settings-form').removeAttribute('aria-busy'); }
  });
}
$('#settings-form').addEventListener('input', event => {
  if (event.target.matches('#base-url,#api-key')) { showDetection(null); $('#settings-error').textContent = ''; $('#service-actions').innerHTML = ''; $('#test-result').className = 'test-result'; $('#test-result').textContent = '已修改，请重新检测。'; }
});
$('#answer-mode').addEventListener('change', updatePrices);
$('#show-key').addEventListener('click', () => { const field = $('#api-key'); field.type = field.type === 'password' ? 'text' : 'password'; $('#show-key').textContent = field.type === 'password' ? '显示' : '隐藏'; $('#show-key').setAttribute('aria-label', field.type === 'password' ? '显示输入的 Key' : '隐藏输入的 Key'); $('#show-key').setAttribute('aria-pressed', String(field.type === 'text')); });
document.addEventListener('click', event => {
  const action = event.target.closest('[data-service-action]'); if (!action || busy) return;
  if (action.dataset.serviceAction === 'retry') detectAndSave(true);
  else { const model = action.dataset.serviceAction === 'model' && !$('#model-options').hidden; if (model) $('#model-options').open = true; const input = model ? $('#model') : action.dataset.serviceAction === 'key' ? $('#api-key') : $('#base-url'); input.focus(); if (input.select) input.select(); }
});
$('#stop-all').addEventListener('click', () => runAction(() => api('/api/queue', { action: 'stop' })));
$('#export-diagnostics').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; button.textContent = '正在生成诊断包…'; $('#diagnostics-error').textContent = '';
  try {
    const response = await fetch('/api/diagnostics', { method:'POST', headers:{'Content-Type':'application/json','X-Szu-Token':state.csrf},body:'{}' });
    if (!response.ok) throw new Error((await response.json()).error || '诊断包导出失败，请重试。');
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="([\w.-]+)"/)?.[1] || 'ShenYiShua-diagnostics.zip';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('诊断包已下载。');
  } catch (error) { $('#diagnostics-error').textContent = error.message; }
  finally { button.disabled = closed; button.textContent = '导出诊断包'; }
});
document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy-debug]');
  if (copy) {
    const field = $('#debug-url'); field.focus(); field.select();
    try { await navigator.clipboard.writeText(field.value); toast(`已复制，在 ${browserName()} 地址栏粘贴并回车。`); }
    catch { toast(`请复制已选中的地址，粘贴到 ${browserName()} 地址栏。`); }
  }
  const step = event.target.closest('[data-guide-step]'); if (step) { guideStep = step.dataset.guideStep; guideError = ''; render(); }
  if (event.target.closest('[data-free-mode]')) runAction(() => api('/api/config', { answer_mode: 'free' }));
  const open = event.target.closest('[data-browser-open]'); if (open) runAction(async () => { await api('/api/browser-open', { target: open.dataset.browserOpen }); });
  const connect = event.target.closest('[data-connect]'); if (connect) runAction(async () => { guideError = ''; try { await api('/api/browser-connect'); await api('/api/browser-courses'); } catch (error) { guideError = error.message; } });
  const read = event.target.closest('[data-read-courses]'); if (read) runAction(async () => { guideError = ''; const label = read.textContent; read.textContent = '读取中…'; try { const result = await api('/api/browser-courses'); toast(result.added ? `已添加 ${result.added} 门课程` : '课程已更新'); } catch (error) { guideError = error.message; toast(error.message, true); } finally { read.textContent = label; } });
  if (event.target.closest('[data-environment]')) runAction(() => api('/api/environment'));
});
$('#connect-again').addEventListener('click', () => { $('#preferences-dialog').close(); guideStep = 'debug'; runAction(async () => { await api('/api/browser-connect'); await api('/api/browser-courses'); }); });
function showClosed() { closed = true; document.querySelectorAll('button').forEach(button => button.disabled = true); $('#connection-error').className = 'notice'; $('#connection-error').textContent = '程序已退出。下次双击启动即可继续。'; $('#connection-error').hidden = false; }
$('#exit-button').addEventListener('click', () => runAction(async () => { await api('/api/shutdown'); showClosed(); }));
refresh(); setInterval(refresh, 1000);
