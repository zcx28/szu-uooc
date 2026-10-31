export const allowedHost = (hostname) => /(^|\.)(uooc\.net\.cn|uooconline\.com|uooc\.online)$/.test(hostname);
export const verificationSelector = '#commitConfirmDialog #sc #aliyunCaptcha-checkbox-icon';

export async function stopCourseScript(page) {
  const stopped = await page.evaluate(() => {
    if (typeof window.szuUoocDebug?.stopCourse !== 'function') return false;
    window.szuUoocDebug.stopCourse(); return true;
  });
  if (!stopped) {
    const stop = page.locator('[data-action="course-stop"]');
    if (await stop.count()) await stop.evaluate(node => node.click());
    else {
      const active = await page.evaluate(() => { const node = document.querySelector('#szu-uooc-course-state'); return node ? JSON.parse(node.textContent).active : Boolean(window.__szuUoocRunnerInstalled); });
      if (active) throw new Error('课程停止入口不可用，尚未确认暂停');
      return;
    }
  }
  await page.waitForFunction(() => {
    const state = document.querySelector('#szu-uooc-course-state');
    return !state || JSON.parse(state.textContent).active === false;
  }, null, { timeout: 3000 });
}

export async function clickVerificationControl(page, frame, beforeClick) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // UOOC's desktop sidebar leaves the quiz clipped in a narrow browser viewport.
  if (viewport.width < 1000) await page.setViewportSize({ width: 1280, height: Math.max(900, viewport.height) });
  const checkbox = frame.locator(verificationSelector);
  // The native icon can keep animating; scrolling must not wait for layout stability.
  await checkbox.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  const visible = await checkbox.evaluate(node => {
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let x = r.x + r.width / 2, y = r.y + r.height / 2, target = node, view = window;
    while (true) {
      const hit = view.document.elementFromPoint(x, y);
      if (!hit || !(hit === target || target.contains(hit))) return false;
      if (view === view.top) return true;
      const iframe = view.frameElement;
      if (!iframe) return false;
      const box = iframe.getBoundingClientRect();
      x = box.x + (x + iframe.clientLeft) * box.width / iframe.offsetWidth;
      y = box.y + (y + iframe.clientTop) * box.height / iframe.offsetHeight;
      target = iframe; view = view.parent;
    }
  });
  if (!visible) throw new Error('验证控件被裁剪或遮挡，未发送点击');
  // Like drissionpage-ai's adapter, use viewport coordinates for native input.
  // Playwright boundingBox already includes iframe offsets; do not add them again.
  const box = await checkbox.boundingBox();
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > size.width || box.y + box.height > size.height) throw new Error('验证控件不在课程视口内，未发送点击');
  if (beforeClick && !await beforeClick()) return false;
  const firefox = await page.evaluate(() => /Firefox/i.test(navigator.userAgent));
  if (firefox) {
    // Aliyun's smart captcha rejects Playwright Firefox synthetic clicks and then loops.
    await page.bringToFront();
    await checkbox.waitFor({ state: 'hidden', timeout: 120000 });
    return true;
  }
  // Native input must not wait for a target to reappear after the cancellation check.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

export async function installCourseScript(target, { config, bank, script, expectedCourse, requestAPI, consoleMode = false }) {
  const stillSolving = (node, state) => node.evaluate((node, prior) => {
    if (!node.isConnected) return false;
    const current = JSON.parse(node.textContent);
    return current.active && current.phase === 'solving' && current.courseId === prior.courseId && current.sourceId === prior.sourceId && current.runId === prior.runId;
  }, state).catch(() => false);
  const binding = await target.exposeBinding('szuUoocNetwork', async ({ page, frame }, details) => {
    const source = new URL(frame.url());
    if (frame !== page.mainFrame() || source.protocol !== 'https:' || !allowedHost(source.hostname) || !/^\/home\/learn\//.test(source.pathname)) throw new Error('拒绝不属于课程学习页的 API 请求');
    const node = await page.locator('#szu-uooc-course-state').elementHandle({ timeout: 2000 });
    if (!node) throw new Error('课程状态不可读，未发送解题请求');
    try {
      const state = await node.evaluate(node => JSON.parse(node.textContent));
      if (String(state.courseId) !== expectedCourse || !state.active || state.phase !== 'solving') throw new Error('当前课程范围内没有等待解题的任务');
      if (config.answer_mode === 'free') throw new Error('免费模式不会调用解题服务。');
      try { return await requestAPI(state.courseId, details, () => stillSolving(node, state)); } catch (error) {
        if (error.notSent) return { status: 0, notSent: true, error: '课程已暂停，未发送解题请求' };
        const message = String(error.message || '本地控制器已暂停请求').replaceAll(config.api_key || '\0', '[redacted]');
        console.log(message); throw new Error(message);
      }
    } finally { await node.dispose(); }
  });

  const imageBinding = await target.exposeBinding('szuUoocImage', async ({ page, frame }, value) => {
    const source = new URL(frame.url());
    if (frame !== page.mainFrame() || source.protocol !== 'https:' || !allowedHost(source.hostname) || !/^\/home\/learn\//.test(source.pathname)) throw new Error('拒绝不属于课程学习页的图片请求');
    const node = await page.locator('#szu-uooc-course-state').elementHandle({ timeout: 2000 });
    if (!node) throw new Error('课程状态不可读，未发送图片请求');
    try {
      const state = await node.evaluate(node => JSON.parse(node.textContent));
      if (String(state.courseId) !== expectedCourse || !state.active || state.phase !== 'solving') throw new Error('当前课程没有等待解题的图片任务');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !(allowedHost(url.hostname) || /(^|\.)(aliyuncs\.com|myqcloud\.com|qpic\.cn)$/.test(url.hostname))) throw new Error('题目图片地址不在支持范围内，请手动完成图片题。');
      const present = await page.evaluate(value => {
        const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
        return docs.some(doc => [...doc.querySelectorAll('.queContainer img')].some(img => { try { return new URL(img.getAttribute('data-src') || img.currentSrc || img.getAttribute('src'), doc.baseURI).href === value; } catch { return false; } }));
      }, url.href);
      if (!present) throw new Error('题目图片与当前试卷不匹配，已暂停。');
      const response = await page.request.get(url.href, { timeout: 15000, maxRedirects: 0 });
      try {
        if (!response.ok()) throw new Error('题目图片读取失败，请在课程页面检查图片。');
        const bytes = await response.body();
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('题目图片为空或超过5MB。');
        if (!await stillSolving(node, state)) throw new Error('课程已暂停或更换题目，未发送图片解题请求。');
        return { base64: bytes.toString('base64'), type: response.headers()['content-type'] || '' };
      } finally { await response.dispose(); }
    } finally { await node.dispose(); }
  });

  let injection, focus;
  try {
    try {
      focus = await target.context().newCDPSession(target);
      // The original-browser connection skips Playwright's focus override; keep only this course running in the background.
      await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) {
      if (!/CDP session is only available in Chromium/i.test(error.message)) throw error;
      focus = null;
    }
    injection = await target.addInitScript({ content: `
if (window === window.top && /(^|\\.)(uooc\\.net\\.cn|uooconline\\.com|uooc\\.online)$/.test(location.hostname) && /^\\/home\\/learn\\//.test(location.pathname) && location.hash.replace(/^#\\/?/, '').split('/')[0] === ${JSON.stringify(expectedCourse)}) {
  (() => {
    const values = { 'szu-uooc:ai-api-key': '[managed-by-local-controller]', 'szu-uooc:answer-bank': ${JSON.stringify(bank)} };
    window.GM_getValue = (key, fallback) => key in values ? values[key] : fallback;
    window.GM_setValue = (key, value) => { if (key !== 'szu-uooc:ai-api-key') values[key] = value; };
    window.GM_getResourceURL = () => '';
    window.GM_xmlhttpRequest = (details) => {
      window.szuUoocNetwork({ method: details.method, url: details.url, data: details.data, timeout: details.timeout }).then(
        (response) => response.notSent ? details.onerror?.({error: response.error, notSent: true}) : details.onload?.(response), (error) => details.onerror?.({ error: error.message || '本地控制器已拒绝或暂停请求' })
      );
      return { abort() {} };
    };
    const key = 'szu-uooc:auto-player:config';
    let prior = {}; try { prior = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
    delete prior.aiApiKey;
    localStorage.setItem(key, JSON.stringify({ ...prior, enabled: false, autoPlay: false, autoNext: false, aiBaseUrl: ${JSON.stringify(config.base_url)}, aiModel: ${JSON.stringify(config.model)}, aiTimeout: 90000, aiManaged: true, aiServiceReady: ${JSON.stringify(Boolean(config.profile?.verified_text))}, aiVisionModel: ${JSON.stringify(config.image_profile?.id || '')},
      aiInputPrice: ${JSON.stringify(config.pricing?.input_per_million ?? '')}, aiCachedInputPrice: ${JSON.stringify(config.pricing?.cached_input_per_million ?? '')}, aiOutputPrice: ${JSON.stringify(config.pricing?.output_per_million ?? '')}, aiBudget: ${JSON.stringify(config.budget)}, aiOutputTokens: 2048, courseAnswerMode: ${JSON.stringify(config.answer_mode || 'ai')} }));
    ${script}
    ${consoleMode ? "const hide = () => { const style = document.createElement('style'); style.textContent = '#szu-uooc-auto-player-controls{display:none!important}'; document.head.appendChild(style); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide, {once:true}); else hide();" : ''}
  })();
}` }); }
  catch (error) { await focus?.detach().catch(() => {}); await imageBinding.dispose(); await binding.dispose(); throw error; }
  return async () => {
    try { await injection.dispose(); }
    finally { try { await imageBinding.dispose(); await binding.dispose(); } finally { await focus?.detach().catch(() => {}); } }
  };
}
