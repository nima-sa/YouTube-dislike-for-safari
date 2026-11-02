(() => {
  'use strict';
  const ru = (browser.i18n.getUILanguage() || navigator.language).startsWith('ru');
  document.documentElement.lang = ru ? 'ru' : 'en';
  const text = ru ? {
    feedback: 'Отправить отзыв',
    likes: 'Лайки', dislikes: 'Дизлайки', refresh: 'Обновить', statsLoading: 'Загружаем статистику…',
    noVideo: 'Откройте видео YouTube в этой вкладке.', statsError: 'Не удалось загрузить статистику. Проверьте доступ расширения к YouTube и RYD.', changed: 'Видео изменилось. Нажмите «Обновить».',
    intro: '≈ — оценка по данным RYD.',
    toggle: 'Отправлять мои голоса в RYD',
    offNote: 'Выключение удаляет очередь. Уже принятые сервером голоса остаются. Статистика продолжает загружаться.',
    privacyTitle: 'Голоса и приватность',
    privacyStats: 'Для статистики RYD получает ID открытого видео.',
    privacyVotes: 'При отправке голоса: случайный ID установки, ID видео, лайк, дизлайк или отмена и данные проверки challenge. Имя и аккаунт YouTube не передаются.',
    privacyNetwork: 'Запросы отправляются без cookies и referrer. Сервер RYD также видит ваш IP-адрес. ID, настройка и очередь хранятся локально; очередь — не более 24 часов.',
    source: 'О Return YouTube Dislike ↗',
    off: 'Отправка выключена.', ready: 'Отправка включена.', pending: 'Ожидают доставки: ',
    delivered: 'Последний голос доставлен', failed: 'Последний голос не доставлен',
    earlier: 'Есть недоставленный голос', expired: 'истёк срок ожидания 24 часа',
    limit: 'очередь заполнена', network: 'не удалось получить подтверждение RYD',
    unavailable: 'Не удалось прочитать настройки. Откройте popup ещё раз.',
    saveError: 'Не удалось сохранить настройку. Попробуйте ещё раз.',
  } : {
    feedback: 'Send feedback',
    likes: 'Likes', dislikes: 'Dislikes', refresh: 'Refresh', statsLoading: 'Loading statistics…',
    noVideo: 'Open a YouTube video in this tab.', statsError: 'Statistics could not be loaded. Check extension access to YouTube and RYD.', changed: 'The video changed. Click Refresh.',
    intro: '≈ is an estimate from RYD.',
    toggle: 'Send my votes to RYD',
    offNote: 'Turning this off clears the queue. Votes already accepted by the server remain. Statistics still load.',
    privacyTitle: 'Votes & privacy',
    privacyStats: 'For statistics, RYD receives the ID of the video you open.',
    privacyVotes: 'Voting sends a random installation ID, video ID, like, dislike or withdrawal, and challenge data. Your name and YouTube account are not sent.',
    privacyNetwork: 'Requests omit cookies and referrer. The RYD server also sees your IP address. The ID, preference and queue stay in local storage; queued votes expire after 24 hours.',
    source: 'About Return YouTube Dislike ↗',
    off: 'Vote submission is off.', ready: 'Vote submission is on.', pending: 'Awaiting delivery: ',
    delivered: 'Last vote delivered', failed: 'Last vote was not delivered',
    earlier: 'A vote was not delivered', expired: 'the 24-hour waiting period expired',
    limit: 'the queue is full', network: 'RYD confirmation could not be obtained',
    unavailable: 'Settings could not be loaded. Reopen this popup.',
    saveError: 'The setting could not be saved. Please try again.',
  };
  if (document.body.classList.contains('compact')) {
    document.getElementById('likes-label').textContent = text.likes;
    document.getElementById('dislikes-label').textContent = text.dislikes;
    const status = document.getElementById('video-status');
    status.textContent = ru ? 'Загрузка…' : 'Loading…';
    browser.runtime.sendMessage({ version: 1, type: 'ryd.activeStats' }).then(result => {
      if (!result?.ok) {
        status.textContent = result?.error === 'no-video' ? text.noVideo :
          ru ? 'Не удалось загрузить. Откройте окно ещё раз.' : 'Could not load. Reopen this popup.';
        return;
      }
      if (![result.stats?.likes, result.stats?.dislikes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('stats');
      const format = new Intl.NumberFormat(ru ? 'ru' : 'en');
      document.getElementById('video-likes').textContent = format.format(result.stats.likes);
      document.getElementById('video-dislikes').textContent = '≈ ' + format.format(result.stats.dislikes);
      document.getElementById('video-dislikes').title = text.intro;
      status.hidden = true;
      document.getElementById('video-stats').hidden = false;
    }).catch(() => { status.textContent = ru ? 'Не удалось загрузить. Откройте окно ещё раз.' : 'Could not load. Reopen this popup.'; });
    return;
  }
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text[node.dataset.i18n];
  const version = browser.runtime.getManifest().version;
  document.getElementById('version').textContent = `v${version}`;
  document.getElementById('feedback').href = 'mailto:denis@malina.page?subject=' +
    encodeURIComponent('YouTube Dislike — ' + text.feedback) + '&body=' +
    encodeURIComponent(`\n\nYouTube Dislike v${version} · Safari extension`);
  const toggle = document.getElementById('enabled');
  const status = document.getElementById('status');
  const failure = document.getElementById('failure');
  let saving = false;
  const stamp = record => record ? ` · ${new Date(record.at).toLocaleTimeString(ru ? 'ru' : 'en', { hour: '2-digit', minute: '2-digit' })}` : '';
  function render(result) {
    toggle.checked = result.enabled;
    toggle.disabled = saving;
    status.textContent = !result.enabled ? text.off : result.pending ? text.pending + result.pending :
      result.lastDelivery?.status === 'delivered' ? text.delivered + stamp(result.lastDelivery) :
      result.lastDelivery?.status === 'failed' ? text.failed + stamp(result.lastDelivery) : text.ready;
    const failed = result.lastFailure;
    failure.hidden = !failed;
    failure.textContent = failed ? `${text.earlier}: ${failed.reason === 'expired' ? text.expired :
      failed.reason === 'queue-full' ? text.limit : text.network}${stamp(failed)}.` : '';
  }
  const send = message => browser.runtime.sendMessage({ version: 1, ...message });
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    saving = true;
    toggle.disabled = true;
    try {
      const result = await send({ type: 'ryd.configure', enabled });
      if (!result?.ok) throw new Error('save');
      saving = false;
      render(result);
    } catch {
      toggle.checked = !enabled;
      status.textContent = text.saveError;
    } finally { saving = false; toggle.disabled = false; }
  });
  browser.storage.onChanged.addListener((changes, area) => {
    const state = changes.rydState?.newValue;
    if (area === 'local' && state) render({ ...state, pending: Object.keys(state.queue || {}).length });
  });
  send({ type: 'ryd.status' }).then(result => {
    if (!result?.ok) throw new Error('load');
    render(result);
  }).catch(() => { status.textContent = text.unavailable; });
})();
