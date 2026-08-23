(() => {
  const status = document.createElement('div');
  status.className = 'dsh-lan-status';
  status.textContent = 'Local remote';
  status.title = 'Connected through the authenticated local-network gateway';
  document.body.append(status);
  fetch('/_bridge/status', { credentials: 'same-origin' }).then((response) => {
    if (!response.ok) throw new Error('offline');
    status.textContent = 'Local remote';
  }).catch(() => {
    status.textContent = 'Reconnecting';
    status.style.setProperty('--dsw-alias-state-success-primary', 'var(--dsw-alias-state-warn-primary)');
  });
})();
