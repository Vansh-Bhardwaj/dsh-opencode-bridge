(() => {
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const shell = document.createElement('div');
  shell.innerHTML = `<nav class="dsh-mobile-nav" aria-label="Mobile navigation"><button type="button" data-dsh-open-sessions aria-label="Open chats and sessions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16M4 12h16M4 18.5h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Chats</span></button><span class="dsh-mobile-nav-context"><span class="dsh-mobile-nav-title">DeepSeek Harness</span><span class="dsh-mobile-run-state" aria-live="polite" hidden><i></i>Running</span></span><button type="button" class="dsh-mobile-new" data-dsh-new-session aria-label="Start a new session"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></nav><div class="dsh-mobile-connection" role="status" hidden><span>Computer unavailable — reconnecting…</span><button type="button" data-dsh-reconnect>Retry</button></div><button type="button" class="dsh-mobile-sidebar-backdrop" aria-label="Close chats and sessions"></button>`;
  document.body.append(...shell.children);

  const openButton = document.querySelector('[data-dsh-open-sessions]');
  const newButton = document.querySelector('[data-dsh-new-session]');
  const backdrop = document.querySelector('.dsh-mobile-sidebar-backdrop');
  const title = document.querySelector('.dsh-mobile-nav-title');
  const runningState = document.querySelector('.dsh-mobile-run-state');
  const connectionNotice = document.querySelector('.dsh-mobile-connection');
  const reconnectButton = document.querySelector('[data-dsh-reconnect]');
  let frame;
  let sidebar;
  let touchStartX;
  let wirePending = false;

  function sidebarToggle(mode) {
    if (!sidebar) return undefined;
    const buttons = [...sidebar.querySelectorAll('button[aria-label]')];
    const pattern = mode === 'open' ? /open.*sidebar|sidebar.*open/i : /collapse.*sidebar|sidebar.*collapse|close.*sidebar|sidebar.*close/i;
    const localizedMatch = buttons.find((button) => pattern.test(button.getAttribute('aria-label') || ''));
    if (localizedMatch) return localizedMatch;
    const logoRow = sidebar.firstElementChild?.firstElementChild;
    const headerButtons = [...(logoRow?.querySelectorAll('button') || [])];
    return headerButtons.at(-1);
  }

  function closeSidebar() {
    sidebarToggle('close')?.click();
  }

  function wireFrame() {
    const overlay = document.querySelector('[data-shell-overlay]');
    const nextFrame = overlay?.parentElement;
    if (!nextFrame || nextFrame.children.length < 4) return;
    frame = nextFrame;
    sidebar = frame.children[0];
    const center = frame.children[1];
    const details = frame.children[2];
    frame.setAttribute('data-dsh-mobile-frame', '');
    sidebar.setAttribute('data-dsh-mobile-sidebar', '');
    sidebar.firstElementChild?.setAttribute('data-dsh-mobile-sidebar-root', '');
    center.setAttribute('data-dsh-mobile-center', '');
    details.setAttribute('data-dsh-mobile-details', '');
    overlay.setAttribute('data-dsh-mobile-overlay', '');
    syncSidebarState();
  }

  function syncSidebarState() {
    const open = Boolean(isMobile() && frame && !frame.hasAttribute('data-sidebar-collapsed'));
    document.body.toggleAttribute('data-dsh-mobile-sidebar-open', open);
    openButton?.setAttribute('aria-expanded', String(open));
  }

  function syncCurrentSession() {
    const rawTitle = document.title.split(/\s+[—-]\s+DeepSeek Harness$/i)[0].trim();
    const nextTitle = rawTitle && !/^DeepSeek Harness$/i.test(rawTitle) ? rawTitle : 'DeepSeek Harness';
    if (title.textContent !== nextTitle) title.textContent = nextTitle;
    if (title.title !== nextTitle) title.title = nextTitle;
    const running = Boolean(document.querySelector('button[aria-label="Stop generating"]'));
    runningState.hidden = !running;
  }

  function wireComposer() {
    for (const card of document.querySelectorAll('[data-composer-card]')) {
      card.setAttribute('data-dsh-mobile-composer-card', '');
      card.parentElement?.setAttribute('data-dsh-mobile-composer-root', '');
      card.parentElement?.querySelector('[data-slot="conversation.composer.dock"]')?.setAttribute('data-dsh-mobile-composer-dock', '');
    }
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--dsh-mobile-viewport-height', `${Math.round(height)}px`);
    document.body.toggleAttribute('data-dsh-mobile-keyboard-open', Boolean(viewport && window.innerHeight - viewport.height > 140));
  }

  async function checkConnection() {
    try {
      const response = await fetch('/_bridge/status', { credentials: 'same-origin', cache: 'no-store' });
      const connected = response.ok;
      document.body.toggleAttribute('data-dsh-lan-connected', connected);
      connectionNotice.hidden = connected;
    } catch {
      document.body.removeAttribute('data-dsh-lan-connected');
      connectionNotice.hidden = false;
    }
  }

  function wireSettings() {
    let settingsOpen = false;
    for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      const nav = [...dialog.children].find((element) => element.tagName === 'NAV');
      const content = nav?.nextElementSibling;
      if (!nav || !content) continue;
      settingsOpen = true;
      const title = nav.children[0];
      const tabs = nav.children[1];
      const header = content.children[0];
      const options = content.children[1];
      const actions = header?.children[0];
      const close = header?.children[1];

      dialog.setAttribute('data-dsh-mobile-settings', '');
      nav.setAttribute('data-dsh-mobile-settings-nav', '');
      title?.setAttribute('data-dsh-mobile-settings-title', '');
      tabs?.setAttribute('data-dsh-mobile-settings-tabs', '');
      content.setAttribute('data-dsh-mobile-settings-content', '');
      header?.setAttribute('data-dsh-mobile-settings-header', '');
      actions?.setAttribute('data-dsh-mobile-settings-actions', '');
      close?.setAttribute('data-dsh-mobile-settings-close', '');
      options?.setAttribute('data-dsh-mobile-settings-options', '');
      header?.toggleAttribute('data-has-actions', Boolean(actions?.children.length));
    }
    document.body.toggleAttribute('data-dsh-mobile-settings-open', settingsOpen);
  }

  openButton?.addEventListener('click', () => {
    wireFrame();
    sidebarToggle('open')?.click();
  });
  newButton?.addEventListener('click', () => {
    const candidate = [...document.querySelectorAll('button')].find((button) => button !== newButton && /new session/i.test(`${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`));
    candidate?.click();
    closeSidebar();
  });
  reconnectButton?.addEventListener('click', checkConnection);
  backdrop?.addEventListener('click', closeSidebar);
  document.addEventListener('touchstart', (event) => {
    if (document.body.hasAttribute('data-dsh-mobile-sidebar-open')) touchStartX = event.touches[0]?.clientX;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    const endX = event.changedTouches[0]?.clientX;
    if (typeof touchStartX === 'number' && typeof endX === 'number' && touchStartX - endX > 64) closeSidebar();
    touchStartX = undefined;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.hasAttribute('data-dsh-mobile-sidebar-open')) closeSidebar();
  });
  document.addEventListener('click', (event) => {
    if (!document.body.hasAttribute('data-dsh-mobile-sidebar-open')) return;
    if (event.target.closest('[data-dsh-mobile-sidebar] [aria-selected]')) setTimeout(closeSidebar, 0);
  });

  function scheduleWire() {
    if (wirePending) return;
    wirePending = true;
    requestAnimationFrame(() => {
      wirePending = false;
      wireFrame();
      wireSettings();
      wireComposer();
      syncCurrentSession();
      syncSidebarState();
    });
  }

  const observer = new MutationObserver(scheduleWire);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'] });
  addEventListener('resize', () => {
    wireFrame();
    syncViewport();
    syncSidebarState();
  }, { passive: true });
  window.visualViewport?.addEventListener('resize', syncViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncViewport, { passive: true });
  addEventListener('online', checkConnection);
  addEventListener('offline', checkConnection);
  wireFrame();
  wireSettings();
  wireComposer();
  syncCurrentSession();
  syncViewport();

  checkConnection();
  setInterval(checkConnection, 15_000);
})();
