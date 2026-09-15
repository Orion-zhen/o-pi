const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
	const window = new BrowserWindow({
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	return window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
