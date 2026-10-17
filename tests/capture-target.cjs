const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 500, title: 'OnRecord capture test' });
  window.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent('<html><head><title>OnRecord capture test</title></head><body style="margin:0;background:#e7effb;color:#24456e;font:28px Segoe UI;display:grid;place-content:center;height:100vh"><h1>OnRecord capture test</h1><p>External window capture verification</p></body></html>'));
});
app.on('window-all-closed', () => app.quit());
