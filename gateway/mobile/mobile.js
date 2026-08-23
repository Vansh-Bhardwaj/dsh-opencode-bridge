(() => {
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const shell = document.createElement('div');
  shell.innerHTML = `<nav class="dsh-mobile-nav" aria-label="Mobile navigation"><button type="button" data-dsh-open-sessions aria-label="Open chats and sessions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16M4 12h16M4 18.5h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Chats</span></button><span class="dsh-mobile-nav-title">DeepSeek Harness</span></nav><button type="button" class="dsh-mobile-sidebar-backdrop" aria-label="Close chats and sessions"></button>`;
  document.body.append(...shell.children);

  const openButton = document.querySelector('[data-dsh-open-sessions]');
  const backdrop = document.querySelector('.dsh-mobile-sidebar-backdrop');
  let frame;
  let sidebar;

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

  openButton?.addEventListener('click', () => {
    wireFrame();
    sidebarToggle('open')?.click();
  });
  backdrop?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.hasAttribute('data-dsh-mobile-sidebar-open')) closeSidebar();
  });
  document.addEventListener('click', (event) => {
    if (!document.body.hasAttribute('data-dsh-mobile-sidebar-open')) return;
    if (event.target.closest('[data-dsh-mobile-sidebar] [aria-selected]')) setTimeout(closeSidebar, 0);
  });

  const observer = new MutationObserver(() => {
    wireFrame();
    syncSidebarState();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'] });
  addEventListener('resize', () => {
    wireFrame();
    syncSidebarState();
  }, { passive: true });
  wireFrame();

  fetch('/_bridge/status', { credentials: 'same-origin' })
    .then((response) => document.body.toggleAttribute('data-dsh-lan-connected', response.ok))
    .catch(() => document.body.removeAttribute('data-dsh-lan-connected'));
})();
