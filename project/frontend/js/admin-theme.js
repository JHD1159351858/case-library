(() => {
  const storageKey = 'admin-color-theme';
  const root = document.documentElement;

  // 在样式和页面内容加载前恢复配色，避免刷新时闪回暗色。
  let theme = 'dark';
  try {
    if (localStorage.getItem(storageKey) === 'light') theme = 'light';
  } catch {
    // 浏览器禁用本地存储时，仍可在当前页面切换。
  }
  root.dataset.adminTheme = theme;

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('admin-theme-toggle');
    const applyTheme = () => {
      root.dataset.adminTheme = theme;
      const light = theme === 'light';
      button.textContent = light ? '☾ 暗色模式' : '☀ 明亮模式';
      button.setAttribute('aria-label', light ? '切换为暗色配色' : '切换为明亮配色');
      button.setAttribute('aria-pressed', String(light));
    };

    applyTheme();
    button.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      applyTheme();
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        // 当前页面的配色已生效，不依赖存储成功。
      }
    });
  });
})();
