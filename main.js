const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const msmc = require('msmc');
const { Client } = require('minecraft-launcher-core');
const launcher = new Client();
const fs = require('fs');
const AdmZip = require('adm-zip');
const { autoUpdater } = require('electron-updater');
const DiscordRPC = require('discord-rpc');

// --- Système de capture de logs corrigé ---
const appLogs = [];
const originalLog = console.log;
const originalError = console.error;

const formatArgs = (args) => {
    return args.map(arg => {
        if (typeof arg === 'object') {
            try {
                // Tente de transformer l'objet en JSON lisible
                return JSON.stringify(arg, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
            } catch (e) {
                return '[Objet non-affichable]';
            }
        }
        return String(arg);
    }).join(' ');
};

console.log = (...args) => {
    appLogs.push(`[INFO] ${formatArgs(args)}`);
    originalLog(...args);
};

console.error = (...args) => {
    const errorText = args.map(arg => (arg instanceof Error ? arg.stack || arg.message : arg)).join(' ');
    appLogs.push(`[ERREUR] ${errorText}`);
    originalError(...args);
};

function showLogsWindow() {
    const logsWindow = new BrowserWindow({
        width: 900,
        height: 600,
        title: "Logs d'erreur - Solisyum",
        autoHideMenuBar: true,
        backgroundColor: '#1e1e24'
    });
    const safeLogs = appLogs.map(log => log.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
    const rawHtml = `<html><head><title>Logs d'erreur</title></head><body style="background-color: #1e1e24; color: #4CAF50; font-family: Consolas, monospace; padding: 20px; font-size: 14px; word-wrap: break-word;"><h2 style="color:#f44336;">Une erreur majeure a bloqué le lancement :</h2>${safeLogs}</body></html>`;
    logsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rawHtml)}`);
}
// ----------------------------------

console.log("1. Le script main.js s'exécute...");

function createWindow() {
    console.log("Initialisation de la fenêtre principale...");
    
    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 600,
        minWidth: 800, // Empêche de réduire la fenêtre en dessous de cette largeur
        minHeight: 500, // Empêche de réduire la fenêtre en dessous de cette hauteur
        resizable: true, 
        autoHideMenuBar: true, 
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false, 
            contextIsolation: true,
            autoplayPolicy: 'no-user-gesture-required' // Autorise la musique à se lancer toute seule
        }
    });

    mainWindow.loadFile('index.html').then(() => {
        console.log("4. Le fichier index.html a été chargé dans la fenêtre !");
    }).catch((err) => {
        console.error("Erreur de chargement HTML :", err);
    });
}

// Désactive l'accélération matérielle pour éviter les erreurs de cache GPU
app.disableHardwareAcceleration();

app.whenReady().then(() => {
    console.log("2. Electron est totalement prêt !");
    createWindow();
}).catch((err) => {
    console.error("Erreur au ready d'Electron :", err);
});

// Écoute du signal pour ouvrir un lien internet externe
ipcMain.on('open-url', (event, url) => {
    shell.openExternal(url);
});

// Envoi de la version de l'application à l'interface
ipcMain.handle('get-version', () => {
    return app.getVersion();
});

// Initialisation de Discord Rich Presence
const clientId = '1515908175637905518'; // Client ID Discord (à configurer)
let rpc;

function setDiscordActivity() {
    DiscordRPC.register(clientId);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
        rpc.setActivity({
            details: 'Joue à Solisyum',
            state: 'En pleine aventure',
            startTimestamp: new Date(),
            largeImageKey: 'logo', // Clé de la grande image (sur le portail Discord)
            largeImageText: 'Solisyum Server',
            instance: false,
            buttons: [
                { label: 'Rejoindre le Discord', url: 'https://discord.gg/Ka9YcZeXcB' }
            ]
        });
    });
    rpc.login({ clientId }).catch(console.error);
}

// Vérification de la session au démarrage
ipcMain.on('check-login', (event) => {
    const launcherDir = path.join(app.getPath('appData'), '.mon-launcher');
    const savedSession = loadSession(launcherDir);
    
    if (savedSession) {
        event.sender.send('info-joueur', {
            nom: savedSession.name,
            uuid: savedSession.uuid
        });
    }
});

// On écoute le signal envoyé par le bouton HTML
ipcMain.on('demande-lancement', async (event, gameOptions) => {
    console.log("--------------------------------------------------");
    console.log("🔑 Démarrage de l'authentification Microsoft...");
    
    try {
        // 1. Définition des chemins
        const launcherDir = path.join(app.getPath('appData'), '.mon-launcher');
        const sessionPath = path.join(launcherDir, 'session.json');
        
        let mclcAuth;
        let sessionValid = false;

        // On tente de charger et valider la session existante
        const savedSession = loadSession(launcherDir);
        if (savedSession) {
            console.log("📂 Session trouvée, vérification de la validité...");
            try {
                const isValid = await msmc.validate(savedSession);
                if (isValid) {
                    console.log("✅ Session valide !");
                    mclcAuth = savedSession;
                    sessionValid = true;
                } else {
                    console.log("⚠️ Session expirée, suppression du fichier...");
                    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
                }
            } catch (e) {
                console.log("⚠️ Erreur lors de la validation msmc :", e);
                if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
            }
        }

        // Si aucune session valide n'a été trouvée/validée, on authentifie
        if (!sessionValid) {
            console.log("🔑 Authentification Microsoft requise...");
            const authManager = new msmc.Auth("select_account");
            const xboxManager = await authManager.launch("electron");
            
            const token = await xboxManager.getMinecraft();
            if (!token) {
                throw new Error("Ce compte Microsoft ne possède pas Minecraft Java Edition.");
            }
            
            mclcAuth = token.mclc();
            saveSession(launcherDir, mclcAuth);

        // 3. AFFICHAGE DU SKIN (Envoi à l'interface)
        // On envoie le nom et l'UUID pour afficher la tête
        event.sender.send('info-joueur', {
            nom: mclcAuth.name,
            uuid: mclcAuth.uuid
        });

        // Mode Réparation : Nettoyage complet des fichiers locaux
        if (gameOptions?.repair) {
            console.log("🛠️ Mode Réparation : Suppression des anciens fichiers...");
            event.sender.send('mise-a-jour-progression', { pourcentage: 5, etape: "Nettoyage des fichiers de jeu..." });
            
            // On supprime les cœurs de Java, Minecraft et des Mods
            const foldersToClean = ['jre17', 'mods', 'assets', 'libraries', 'versions'];
            for (const folder of foldersToClean) {
                const folderPath = path.join(launcherDir, folder);
                if (fs.existsSync(folderPath)) {
                    try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch (e) { console.log(`Erreur de suppression sur ${folder}:`, e); }
                }
            }
            const installedModsJson = path.join(launcherDir, 'installed_mods.json');
            if (fs.existsSync(installedModsJson)) {
                try { fs.unlinkSync(installedModsJson); } catch (e) {}
            }
        }

        const javaZipPath = path.join(launcherDir, 'java17.zip');
        const javaExtractedPath = path.join(launcherDir, 'jre17');
        // Le chemin exact vers l'exécutable Java une fois décompressé
        const customJavaPath = path.join(javaExtractedPath, 'jdk-17.0.10+7-jre', 'bin', 'java.exe');

        // 2. Vérification et téléchargement automatique de Java 17
        if (!fs.existsSync(customJavaPath)) {
            console.log("⬇️ Java 17 introuvable. Début du téléchargement automatique...");
            event.sender.send('mise-a-jour-progression', { pourcentage: 10, etape: "Téléchargement de Java 17..." });
            
            // Création du dossier racine s'il n'existe pas
            if (!fs.existsSync(launcherDir)) fs.mkdirSync(launcherDir, { recursive: true });

            // Lien de téléchargement officiel d'Adoptium (JRE 17 Windows x64)
            const javaUrl = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.10%2B7/OpenJDK17U-jre_x64_windows_hotspot_17.0.10_7.zip";
            
            // Téléchargement intelligent qui gère les redirections GitHub
            const response = await fetch(javaUrl);
            const arrayBuffer = await response.arrayBuffer();
            fs.writeFileSync(javaZipPath, Buffer.from(arrayBuffer));

            console.log("📦 Extraction de Java 17 en cours...");
            event.sender.send('mise-a-jour-progression', { pourcentage: 50, etape: "Installation de Java 17..." });
            
            const zip = new AdmZip(javaZipPath);
            zip.extractAllTo(javaExtractedPath, true);
            
            // Nettoyage du fichier zip pour gagner de la place
            fs.unlinkSync(javaZipPath); 
            console.log("✅ Java 17 installé avec succès !");
        }

        // Synchronisation du dossier mods via fichier de configuration
        const modsZipPath = path.join(launcherDir, 'mods.zip');
        const modsDirPath = path.join(launcherDir, 'mods');
        const installedModsPath = path.join(launcherDir, 'installed_mods.json');

        console.log("🔄 Récupération de la configuration à distance...");
        event.sender.send('mise-a-jour-progression', { pourcentage: 60, etape: "Vérification de la mise à jour..." });

        // L'URL vers ton fichier JSON (doit utiliser "raw.githubusercontent.com" pour lire le texte brut)
        const configUrl = "https://raw.githubusercontent.com/Math170/mon-modpack-serveur/main/config.json";
        
        const configResponse = await fetch(configUrl);
        if (!configResponse.ok) throw new Error("Impossible de lire le fichier de configuration distant.");
        
        const configData = await configResponse.json();
        const modsUrl = configData.modsUrl;

        // Vérification des mises à jour du launcher (uniquement si l'application est compilée)
        if (app.isPackaged) {
            console.log("🔄 Vérification des mises à jour du launcher...");
            event.sender.send('mise-a-jour-progression', { pourcentage: 65, etape: "Recherche de mise à jour du launcher..." });

            autoUpdater.autoDownload = false; // On gère le téléchargement manuellement pour afficher la progression
            try {
                // On écoute les signaux officiels de electron-updater
                const updateAvailable = await new Promise((resolve, reject) => {
                    autoUpdater.once('update-available', (info) => resolve(info));
                    autoUpdater.once('update-not-available', () => resolve(false));
                    autoUpdater.once('error', (err) => reject(err));
                    autoUpdater.checkForUpdates();
                });

                if (updateAvailable) {
                    console.log(`📌 Nouvelle version du launcher trouvée : ${updateAvailable.version}`);

                    // Promesse pour surveiller l'avancement du téléchargement de l'exécutable
                    await new Promise((resolve, reject) => {
                        const onProgress = (progressObj) => {
                            event.sender.send('mise-a-jour-progression', { pourcentage: Math.round(progressObj.percent), etape: `Mise à jour du launcher... ${Math.round(progressObj.percent)}%` });
                        };
                        autoUpdater.on('download-progress', onProgress);
                        
                        autoUpdater.once('update-downloaded', () => {
                            autoUpdater.removeListener('download-progress', onProgress);
                            resolve();
                        });
                        autoUpdater.once('error', (err) => reject(err));
                        
                        autoUpdater.downloadUpdate();
                    });

                    event.sender.send('mise-a-jour-progression', { pourcentage: 100, etape: "Mise à jour terminée ! Redémarrage automatique..." });
                    autoUpdater.quitAndInstall(false, true); // Ferme le launcher et installe la MAJ
                    return; // On stoppe le script pour ne pas lancer Minecraft par-dessus
                } else {
                    console.log("✅ Le launcher est déjà à la dernière version.");
                }
            } catch (err) {
                console.error("⚠️ Erreur lors de la vérification de mise à jour du launcher :", err);
                // En cas d'erreur de mise à jour du launcher, on bloque tout
                throw new Error("Mise à jour du launcher impossible : " + err.message);
            }
        } else {
            console.log("🛠️ Mode développement : Vérification de la mise à jour du launcher ignorée.");
        }

        console.log("🔄 Vérification et mise à jour des mods...");
        event.sender.send('mise-a-jour-progression', { pourcentage: 75, etape: "Vérification des mods locaux..." });

        let needsUpdate = true;

        if (fs.existsSync(installedModsPath)) {
            try {
                const localData = JSON.parse(fs.readFileSync(installedModsPath, 'utf8'));
                // Si l'URL distante n'a pas changé et que le dossier mods est présent
                if (localData.modsUrl === modsUrl && fs.existsSync(modsDirPath)) {
                    const currentFiles = fs.readdirSync(modsDirPath);
                    const expectedFiles = localData.files || [];
                    
                    // Vérification : S'il manque des fichiers vitaux, on télécharge tout
                    const missingFiles = expectedFiles.filter(f => !currentFiles.includes(f));
                    
                    if (missingFiles.length === 0) {
                        needsUpdate = false; // Pas besoin de télécharger
                        
                        // Suppression des fichiers en trop (mods ajoutés manuellement par erreur)
                        const extraFiles = currentFiles.filter(f => !expectedFiles.includes(f));
                        for (const file of extraFiles) {
                            try {
                                fs.rmSync(path.join(modsDirPath, file), { recursive: true, force: true });
                                console.log(`🗑️ Mod en trop supprimé : ${file}`);
                            } catch (e) {
                                console.log(`⚠️ Impossible de supprimer : ${file}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.log("⚠️ Fichier d'état illisible, vérification forcée.");
            }
        }

        if (needsUpdate) {
            console.log("⬇️ Téléchargement des nouveaux mods...");
            event.sender.send('mise-a-jour-progression', { pourcentage: 80, etape: "Téléchargement des mods..." });

        try {
            // On télécharge la dernière version de tes mods
            const responseMods = await fetch(modsUrl);
            
            if (responseMods.ok) {
                const arrayBufferMods = await responseMods.arrayBuffer();
                fs.writeFileSync(modsZipPath, Buffer.from(arrayBufferMods));

                // On supprime l'ancien dossier mods pour éviter les conflits
                if (fs.existsSync(modsDirPath)) {
                    try {
                        fs.rmSync(modsDirPath, { recursive: true, force: true });
                    } catch (e) {
                        console.log("⚠️ Le dossier mods est verrouillé, on tente de continuer quand même...");
                    }
                }
                
                // Recréation du dossier mods
                fs.mkdirSync(modsDirPath, { recursive: true });

                console.log("📦 Extraction de la nouvelle mise à jour des mods...");
                const zipMods = new AdmZip(modsZipPath);
                
                // Extraction directe dans le dossier
                zipMods.extractAllTo(modsDirPath, true); 

                fs.unlinkSync(modsZipPath); 
                
                // Sauvegarde de l'état actuel pour le prochain lancement
                const extractedFiles = fs.readdirSync(modsDirPath);
                fs.writeFileSync(installedModsPath, JSON.stringify({
                    modsUrl: modsUrl,
                    files: extractedFiles
                }));

                console.log("✅ Mods synchronisés avec succès !");
            } else {
                console.log("⚠️ Le lien renvoie une erreur :", responseMods.status, responseMods.statusText);
            }
        } catch (err) {
            console.log("⚠️ ERREUR CRITIQUE :");
            console.error(err);
            
            // On force l'affichage : soit le message d'erreur, soit le texte brut de l'erreur
            let messageFinal = err.message || err.toString();
            
            // Détection de coupure internet
            if (messageFinal.includes('fetch') || messageFinal.includes('ENOTFOUND') || messageFinal.includes('ECONNRESET') || messageFinal.includes('ETIMEDOUT') || messageFinal.includes('network')) {
                messageFinal = "Connexion internet perdue pendant le téléchargement. Vérifiez votre réseau.";
            }
            
            event.sender.send('mise-a-jour-progression', {
                pourcentage: 0,
                etape: `❌ Erreur : ${messageFinal}`
            });
            throw new Error(messageFinal);
        }
        } else {
            console.log("✅ Les mods sont déjà à jour, téléchargement ignoré !");
            event.sender.send('mise-a-jour-progression', { pourcentage: 100, etape: "Mods à jour !" });
        }

        // 3. Configuration des options de lancement pour Minecraft et Forge
        let opts = {
            clientPackage: null,
            authorization: mclcAuth,
            root: launcherDir,
            version: {
                number: "1.20.1",
                type: "release"
            },
            // Chemin vers l'installeur (adaptation asar.unpacked pour Electron)
            forge: path.join(__dirname, 'forge-installer.jar').replace('app.asar', 'app.asar.unpacked'), 
            javaPath: customJavaPath, 
            memory: {
                max: gameOptions?.ram || "4G",
                min: "2G"
            },
            window: {
                fullscreen: gameOptions?.fullscreen || false
            }
        };

    // Connexion automatique si le joueur a cliqué sur "Rejoindre le serveur"
    if (gameOptions?.autoConnect) {
        opts.server = {
            host: "90.22.22.119", // IP du serveur Solisyum
            port: 25565
        };
        
        // Depuis Minecraft 1.20+, l'ancien système "server" a été remplacé par "Quick Play"
        opts.quickPlay = {
            type: "multiplayer",
            identifier: "90.22.22.119:25565"
        };
    }

        console.log("🚀 Lancement de Minecraft 1.20.1 (Forge) en cours...");
        
        launcher.launch(opts);

        let timeoutFermeture; // Permet d'annuler la fermeture si le jeu crash immédiatement

        // Radar de crash natif
        launcher.on('close', (code) => {
            if (code !== 0) {
                if (timeoutFermeture) clearTimeout(timeoutFermeture); // On annule la fermeture !
                event.sender.send('mise-a-jour-progression', { 
                    pourcentage: 0, 
                    etape: `❌ Crash instantané de Java (Code ${code})` 
                });
            }
            event.sender.send('jeu-ferme');
            if (rpc) {
                rpc.destroy().catch(console.error); // Coupe le statut Discord
                rpc = null;
            }
        });

        launcher.on('debug', (e) => {
            if (typeof e === 'string' && (e.includes("Error") || e.includes("Exception"))) {
                event.sender.send('mise-a-jour-progression', { 
                    pourcentage: 0, 
                    etape: `⚠️ ${e.substring(0, 60)}...` 
                });
            }
        });

        launcher.on('progress', (e) => {
            let pourcentage = Math.round((e.task / e.total) * 100);
            event.sender.send('mise-a-jour-progression', {
                pourcentage: pourcentage,
                etape: `Téléchargement : ${e.type} (${e.task} / ${e.total})`
            });
        });

        launcher.on('arguments', () => {
            event.sender.send('mise-a-jour-progression', {
                pourcentage: 100,
                etape: "🚀 Le jeu est en cours d'exécution !"
            });
        
        // Afficher le statut sur Discord !
        setDiscordActivity();

            if (gameOptions?.closeLauncher !== false) {
                // Fermeture automatique du launcher au bout de 3 secondes
                timeoutFermeture = setTimeout(() => {
                    const window = BrowserWindow.fromWebContents(event.sender);
                    if (window && !window.isDestroyed()) window.close();
                }, 3000);
            }
        });
        }
    } catch (erreur) {
        console.error("❌ Erreur lors de la connexion ou du lancement :");
        console.error(erreur);
        
        let messageErreur = erreur.message || erreur.toString();
        
        // Détection de coupure internet globale
        if (messageErreur.includes('fetch') || messageErreur.includes('ENOTFOUND') || messageErreur.includes('ECONNRESET') || messageErreur.includes('ETIMEDOUT') || messageErreur.includes('network')) {
            messageErreur = "Connexion internet instable ou interrompue. Veuillez vérifier votre réseau.";
        }

        // Transmission de l'erreur d'exécution à l'interface utilisateur
        event.sender.send('mise-a-jour-progression', {
            pourcentage: 0,
            etape: `❌ Erreur : ${messageErreur}`
        });
        event.sender.send('jeu-ferme');
        if (rpc) {
            rpc.destroy().catch(console.error);
            rpc = null;
        }
        
        // Affichage de la page de logs pour analyser le problème
        showLogsWindow();
    }
});

ipcMain.on('deconnexion', () => {
    const sessionPath = path.join(app.getPath('appData'), '.mon-launcher', 'session.json');
    if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath); // Suppression du fichier de session
        console.log("🔒 Session supprimée, déconnexion réussie.");
    }
});

/**
 * Charge une session d'authentification existante depuis le disque.
 */
function loadSession(launcherDir) {
    const sessionPath = path.join(launcherDir, 'session.json');
    if (fs.existsSync(sessionPath)) {
        try {
            return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        } catch (e) {
            return null;
        }
    }
    return null;
}

/**
 * Sauvegarde la session d'authentification.
 */
function saveSession(launcherDir, mclcAuth) {
    // On vérifie si le dossier existe, sinon on le crée
    if (!fs.existsSync(launcherDir)){
        fs.mkdirSync(launcherDir, { recursive: true });
    }
    
    const sessionPath = path.join(launcherDir, 'session.json');
    fs.writeFileSync(sessionPath, JSON.stringify(mclcAuth));
}

// Fermeture de l'application à la fermeture de toutes les fenêtres (sauf macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});