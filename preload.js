const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    launchGame: (options) => ipcRenderer.send('demande-lancement', options),
    onProgress: (callback) => ipcRenderer.on('mise-a-jour-progression', (event, data) => callback(data)),
    openUrl: (url) => ipcRenderer.send('open-url', url),
    onPlayerInfo: (callback) => ipcRenderer.on('info-joueur', (event, data) => callback(data)),
    disconnect: () => ipcRenderer.send('deconnexion'),
    checkLogin: () => ipcRenderer.send('check-login'),
    onGameClosed: (callback) => ipcRenderer.on('jeu-ferme', () => callback()),
    getVersion: () => ipcRenderer.invoke('get-version')
});