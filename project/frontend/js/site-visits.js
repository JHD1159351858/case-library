// 公开页面每次打开仅上报一次；浏览器去重和管理员排除均由服务端处理。
fetch('/api/site-visits', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
