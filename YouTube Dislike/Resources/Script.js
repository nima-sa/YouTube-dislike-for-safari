'use strict';
const ru = navigator.language.startsWith('ru');
const copy = ru ? {
  tagline: 'Дизлайки снова видны',
  extensionUnknown: 'Лайки и дизлайки — в кнопке расширения.', extensionOn: 'Расширение включено.', extensionOff: 'Расширение выключено.',
  setup: 'Настроить', settingsError: 'Не удалось открыть настройки Safari.',
  privacyTitle: 'Источник и приватность',
  privacy: 'Статистика поступает из Return YouTube Dislike. Сервис получает ID видео и видит IP-адрес. Отправка голосов управляется в настройках расширения Safari.',
  source: 'О Return YouTube Dislike ↗', feedback: 'Отправить отзыв',
} : {
  tagline: 'See dislikes again',
  extensionUnknown: 'Likes and dislikes in the extension toolbar button.', extensionOn: 'The extension is on.', extensionOff: 'The extension is off.',
  setup: 'Set up', settingsError: 'Safari settings could not be opened.',
  privacyTitle: 'Source & privacy',
  privacy: 'Statistics come from Return YouTube Dislike. The service receives the video ID and sees your IP address. Manage vote submission in Safari extension settings.',
  source: 'About Return YouTube Dislike ↗', feedback: 'Send feedback',
};
document.documentElement.lang = ru ? 'ru' : 'en';
for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = copy[node.dataset.i18n];
function setFeedback(version) {
  document.getElementById('version').textContent = version;
  document.getElementById('feedback').href = 'mailto:denis@malina.page?subject=' +
    encodeURIComponent('YouTube Dislike — ' + copy.feedback) + '&body=' +
    encodeURIComponent('\n\nYouTube Dislike ' + version + ' · macOS');
}
setFeedback('');
window.receiveNative = payload => {
  if (payload.type === 'ci' && /^https:\/\/github\.com\/skar404\/youtube-dislike-for-safari\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/.test(payload.url)) {
    const link = document.getElementById('ci');
    link.href = payload.url; link.textContent = payload.label; link.hidden = false;
  }
  if (payload.type === 'app') setFeedback(`v${payload.version} (${payload.build})`);
  if (payload.type === 'extension') document.getElementById('extension-status').textContent =
    payload.enabled === true ? copy.extensionOn : payload.enabled === false ? copy.extensionOff : copy.extensionUnknown;
  if (payload.type === 'settings-error') document.getElementById('extension-status').textContent = copy.settingsError;
};
document.getElementById('preferences').addEventListener('click', () => window.webkit.messageHandlers.controller.postMessage({ type: 'open-preferences' }));
