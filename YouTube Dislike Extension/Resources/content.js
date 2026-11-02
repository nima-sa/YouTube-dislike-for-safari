// RYD estimates in YouTube's own button. No page-to-extension message bridge.
(() => {
  'use strict';
  const isMobileLayout = () => location.hostname === 'm.youtube.com' ||
    !!document.querySelector('ytm-app, ytm-watch');
  const russian = (document.documentElement.lang || navigator.language).startsWith('ru');
  const estimateText = russian ? 'Приблизительное число дизлайков по данным Return YouTube Dislike' :
    'Estimated dislike count from Return YouTube Dislike';
  const exact = new Intl.NumberFormat(russian ? 'ru' : 'en');
  const compact = new Intl.NumberFormat(russian ? 'ru' : 'en', { notation: 'compact', maximumFractionDigits: 1 });
  let videoId, generation = 0, stats = null, estimateLabel = null, navigating = false;
  let activation = null, pending = null;
  const send = message => browser.runtime.sendMessage({ version: 1, ...message });
  const style = document.createElement('style');
  style.textContent = `
    .ryd-vote-controls, .ryd-vote-controls like-button-view-model,
    .ryd-vote-controls dislike-button-view-model {
      flex-shrink: 0 !important; width: auto !important; white-space: nowrap !important;
    }
    .ryd-vote-controls button { white-space: nowrap !important; }
    button.ryd-has-estimate {
      width: auto !important; min-width: 64px; flex-shrink: 0 !important;
      padding-inline: 12px !important; white-space: nowrap !important;
    }
    .ryd-estimate-label { margin-inline-start: 6px; white-space: nowrap; }
    @media (max-width: 767px) {
      button.ryd-has-estimate {
        min-height: 44px; min-width: 64px; padding-inline: 8px !important;
        display: inline-flex; align-items: center; justify-content: center;
        gap: 0; vertical-align: middle;
      }
      button.ryd-has-estimate .ryd-estimate-label {
        font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif;
        font-variant-numeric: tabular-nums; margin-inline-start: 4px;
        color: inherit; letter-spacing: -.2px;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  function getVideoId() {
    const url = new URL(location.href);
    const id = url.pathname === '/watch' ? url.searchParams.get('v') :
      /^\/shorts\/[^/]+\/?$/.test(url.pathname) ? url.pathname.split('/')[2] : null;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  function getControls() {
    const shorts = location.pathname.startsWith('/shorts/');
    const mobile = isMobileLayout();
    let root = document;
    if (shorts) {
      root = document.querySelector('ytd-reel-video-renderer[is-active], ytd-reel-video-renderer[active], ytm-reel-item-renderer[is-active], ytm-reel-item-renderer[active]');
      if (!root) return null;
    } else if (!mobile) {
      root = document.querySelector('ytd-watch-grid, ytd-watch-flexy');
      if (!root) return null;
    }
    if (root.getAttribute?.('video-id') && root.getAttribute('video-id') !== videoId) return null;
    const host = root.querySelector(shorts
      ? '#actions, reel-action-bar-view-model, .reel-player-overlay-actions'
      : mobile ? '.slim-video-action-bar-actions .segmented-buttons, .slim-video-action-bar-actions'
        : '#top-level-buttons-computed, ytd-menu-renderer.ytd-watch-metadata > div, ytd-menu-renderer.ytd-video-primary-info-renderer > div');
    if (!host) return null;
    const group = host.querySelector('segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer, ytm-segmented-like-dislike-button-renderer, ytm-like-button-renderer') ||
      (host.matches('.segmented-buttons') ? host : host.querySelector('.segmented-buttons'));
    const like = host.querySelector('like-button-view-model, #segmented-like-button, #like-button') || group?.children[0];
    const dislike = host.querySelector('dislike-button-view-model, #segmented-dislike-button, #dislike-button') || group?.children[1];
    // Never guess that arbitrary adjacent controls are voting buttons.
    if (!like || !dislike || like === dislike) return null;
    const button = control => control.matches('button') ? control : control.querySelector('button');
    const likeButton = button(like), dislikeButton = button(dislike);
    if (!likeButton || !dislikeButton) return null;
    return { host, like, dislike, likeButton, dislikeButton };
  }
  function clearEstimate() {
    if (!estimateLabel) return;
    const { element, text, title, rendered, created, button, group } = estimateLabel;
    button?.classList.remove('ryd-has-estimate');
    group?.classList.remove('ryd-vote-controls');
    if (created) element.remove();
    else if (element.textContent === rendered) {
      element.textContent = text;
      if (title === null) element.removeAttribute('title'); else element.title = title;
    }
    estimateLabel = null;
  }
  function render() {
    const controls = getControls();
    if (!controls || !stats) { clearEstimate(); return; }
    const { dislike, dislikeButton: button } = controls;
    let label = dislike.querySelector('#text, .button-renderer-text, yt-formatted-string, span[role="text"], .yt-core-attributed-string, .yt-spec-button-shape-next__button-text-content, .ytSpecButtonShapeNextButtonTextContent, .ryd-estimate-label');
    if (estimateLabel && estimateLabel.element !== label) clearEstimate();
    if (!label) {
      label = document.createElement('span');
      label.className = 'ryd-estimate-label';
      button.appendChild(label);
      estimateLabel = { element: label, created: true };
    }
    if (!estimateLabel || (!estimateLabel.created && label.textContent !== estimateLabel.rendered)) {
      const title = label.getAttribute('title');
      estimateLabel = { element: label, text: label.textContent,
        title: estimateLabel && title === estimateLabel.renderedTitle ? estimateLabel.title : title, created: false };
    }
    const group = dislike.closest('segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer, ytm-segmented-like-dislike-button-renderer, .segmented-buttons');
    if (!button.classList.contains('ryd-has-estimate')) button.classList.add('ryd-has-estimate');
    if (group && !group.classList.contains('ryd-vote-controls')) group.classList.add('ryd-vote-controls');
    Object.assign(estimateLabel, { button, group });
    const rendered = `≈ ${compact.format(stats.dislikes)}`;
    if (label.textContent !== rendered) label.textContent = rendered;
    const title = `${estimateText}: ${exact.format(stats.dislikes)}`;
    if (label.title !== title) label.title = title;
    estimateLabel.rendered = rendered;
    estimateLabel.renderedTitle = title;
  }
  async function loadVotes(id, requestGeneration) {
    try {
      const result = await send({ type: 'ryd.stats', videoId: id });
      if (requestGeneration !== generation || id !== getVideoId()) return;
      stats = result?.ok && Number.isSafeInteger(result.stats?.dislikes) && result.stats.dislikes >= 0 ? result.stats : null;
    } catch {
      if (requestGeneration !== generation || id !== getVideoId()) return;
      stats = null;
    }
    render();
  }
  function voteState(controls) {
    if (!controls) return null;
    const like = controls.likeButton.getAttribute('aria-pressed');
    const dislike = controls.dislikeButton.getAttribute('aria-pressed');
    if (!['true', 'false'].includes(like) || !['true', 'false'].includes(dislike) ||
        (like === 'true' && dislike === 'true')) return null;
    return like === 'true' ? 1 : dislike === 'true' ? -1 : 0;
  }
  function visible(element) {
    for (let node = element; node && node !== document; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
    }
    return true;
  }
  function hasDialog() {
    return [...document.querySelectorAll('[role="dialog"], dialog[open], ytd-modal-with-title-and-button-renderer, ytm-sign-in-dialog-renderer')].some(visible);
  }
  function capture(event) {
    if (!event.isTrusted || navigating || !videoId || videoId !== getVideoId() || hasDialog()) return null;
    const controls = getControls();
    const before = voteState(controls);
    if (before === null) return null;
    for (const [value, button] of [[1, controls.likeButton], [-1, controls.dislikeButton]]) {
      if (button.contains(event.target) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button)) {
        return { id: videoId, generation, before, expected: before === value ? 0 : value, button, at: Date.now() };
      }
    }
    return null;
  }
  function checkPending() {
    if (!pending) return;
    if (pending.id !== getVideoId() || pending.generation !== generation || navigating ||
        Date.now() - pending.at > 2500 || hasDialog()) { pending = null; return; }
    const state = voteState(getControls());
    if (state !== pending.expected || state === pending.before) { pending.confirmedAt = null; return; }
    // Wait for a stable native state; a sign-in dialog or optimistic rollback cancels it.
    if (pending.confirmedAt == null) { pending.confirmedAt = Date.now(); return; }
    if (Date.now() - pending.confirmedAt < 300) return;
    const action = pending;
    pending = null;
    void send({ type: 'ryd.vote', videoId: action.id, value: action.expected }).catch(() => {});
  }
  window.addEventListener('pointerdown', event => { activation = event.button === 0 ? capture(event) : null; }, true);
  window.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) activation = capture(event);
  }, true);
  window.addEventListener('click', event => {
    if (!event.isTrusted || (event.button !== undefined && event.button !== 0)) return;
    const current = capture(event);
    if (!current) { activation = null; pending = null; return; }
    const action = activation?.button === current.button && activation.generation === generation &&
      Date.now() - activation.at < 2000 ? activation : current;
    activation = null;
    pending = { ...action, at: Date.now(), confirmedAt: null };
    // Capture listeners run before YouTube's handler. The observer/poll reads its result.
  }, true);
  const observer = new MutationObserver(checkPending);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-pressed', 'aria-hidden', 'hidden', 'open'] });
  function sync() {
    if (navigating) return;
    const id = getVideoId();
    if (id !== videoId) {
      generation++;
      activation = pending = null;
      clearEstimate();
      videoId = id;
      stats = null;
      if (id) void loadVotes(id, generation);
    }
    checkPending();
    if (id) render();
  }
  window.addEventListener('yt-navigate-start', () => {
    navigating = true;
    generation++;
    activation = pending = null;
    videoId = undefined;
    stats = null;
    clearEstimate();
  });
  window.addEventListener('yt-navigate-finish', () => { navigating = false; sync(); });
  let poll = setInterval(sync, 500);
  window.addEventListener('pagehide', () => {
    generation++;
    activation = pending = null;
    clearInterval(poll);
    observer.disconnect();
    clearEstimate();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    navigating = false;
    videoId = undefined;
    clearInterval(poll);
    poll = setInterval(sync, 500);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-pressed', 'aria-hidden', 'hidden', 'open'] });
    sync();
  });
  sync();
})();
