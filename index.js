const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const readline = require("readline");
const config = require("./settings");

// Constants
const MAX_VIEWED_STATUS_SIZE = 1000;
const PAIRING_STABILIZATION_DELAY = config.pairingDelay || 10000;
const STATUS_CLEANUP_INTERVAL = 3600000; // 1 hour
const MAX_RETRY_ATTEMPTS = 5;
const PRESENCE_UPDATE_INTERVAL = 60000; // Update presence every 1 minute
const STATUS_SYNC_INTERVAL = 300000; // Re-sync status subscription every 5 minutes

// Utilities
const viewedStatus = new Set();
let retryAttempts = 0;
let presenceInterval = null;
let statusSyncInterval = null;

function formatPhoneNumber(phone) {
    return phone.replace(/[^0-9]/g, '');
}

function extractUsername(jid) {
    return jid?.split('@')[0] || 'Unknown';
}

function validateConfig() {
    const required = ['botName', 'ownerNumber', 'reconnectDelay'];
    const missing = required.filter(key => !config[key]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required config: ${missing.join(', ')}`);
    }
    
    if (config.ownerNumber && !/^\d{10,15}$/.test(config.ownerNumber)) {
        throw new Error('Invalid owner number format');
    }
}

function cleanupViewedStatus() {
    if (viewedStatus.size > MAX_VIEWED_STATUS_SIZE) {
        const toDelete = viewedStatus.size - MAX_VIEWED_STATUS_SIZE;
        const iterator = viewedStatus.values();
        for (let i = 0; i < toDelete; i++) {
            viewedStatus.delete(iterator.next().value);
        }
    }
}

async function getPairingCode(sock) {
    const rl = readline.createInterface({ 
        input: process.stdin, 
        output: process.stdout 
    });

    try {
        const question = (text) => new Promise((resolve) => rl.question(text, resolve));
        
        console.log("⏳ Stabilizing connection... please wait.");
        await new Promise(resolve => setTimeout(resolve, PAIRING_STABILIZATION_DELAY));

        let phoneNumber = await question("📞 Enter your WhatsApp number (e.g., 254...): ");
        phoneNumber = formatPhoneNumber(phoneNumber);

        if (!phoneNumber || phoneNumber.length < 10 || phoneNumber.length > 15) {
            throw new Error('Invalid phone number. Must be 10-15 digits.');
        }

        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n✅ PAIR USING THIS CODE: \x1b[32m${code}\x1b[0m\n`);
        retryAttempts = 0;
        
    } catch (err) {
        console.error("❌ Pairing error:", err.message);
        
        if (retryAttempts < MAX_RETRY_ATTEMPTS) {
            retryAttempts++;
            console.log(`🔄 Retrying... (${retryAttempts}/${MAX_RETRY_ATTEMPTS})`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return getPairingCode(sock);
        } else {
            throw new Error('Max pairing attempts reached. Restarting bot...');
        }
    } finally {
        rl.close();
    }
}

async function handleStatusView(sock, msg) {
    const statusId = msg.key.id;

    if (viewedStatus.has(statusId)) return;
    
    viewedStatus.add(statusId);
    cleanupViewedStatus();

    setTimeout(() => viewedStatus.delete(statusId), STATUS_CLEANUP_INTERVAL);

    try {
        const sender = msg.key.participant;
        if (!sender) return;

        await sock.readMessages([msg.key]);
        console.log(`👁️ Viewed Status: ${extractUsername(sender)}`);

        if (config.autoReactStatus && config.statusReactionEmoji) {
            await sock.sendMessage("status@broadcast", {
                react: { text: config.statusReactionEmoji, key: msg.key }
            }, { statusJidList: [sender] });
        }
    } catch (err) {
        console.error("⚠️ Status view error:", err.message);
    }
}

async function handleAntiDelete(sock, msg) {
    try {
        if (!msg.message?.protocolMessage) return;
        if (msg.message.protocolMessage.type !== 0) return;
        
        const deletedKey = msg.message.protocolMessage.key;
        const deletedJid = deletedKey.remoteJid;
        
        // Ignore status broadcast deletions
        if (!deletedJid || deletedJid === "status@broadcast") return;

        const ownerJid = `${config.ownerNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(ownerJid, {
            text: `♻️ *Anti-Delete Alert*\n\n` +
                  `👤 User: @${extractUsername(deletedJid)}\n` +
                  `🗑️ Deleted a message\n` +
                  `⏰ Time: ${new Date().toLocaleString()}`,
            mentions: [deletedJid]
        });
        
        console.log(`♻️ Anti-Delete: ${extractUsername(deletedJid)} deleted a message`);
    } catch (err) {
        console.error("⚠️ Anti-delete error:", err.message);
    }
}

async function handleIncomingMessages(sock, chatUpdate) {
    try {
        const msg = chatUpdate.messages[0];
        if (!msg?.message) return;

        // Handle status views
        if (msg.key.remoteJid === "status@broadcast" && config.autoViewStatus) {
            await handleStatusView(sock, msg);
        }

        // Handle anti-delete
        if (config.antiDelete) {
            await handleAntiDelete(sock, msg);
        }

    } catch (err) {
        console.error("❌ Message handler error:", err.message);
    }
}

async function handleIncomingCall(sock, calls) {
    if (!config.antiCall) return;

    try {
        for (const call of calls) {
            await sock.rejectCall(call.id, call.from);
            console.log(`📵 Rejected call from: ${extractUsername(call.from)}`);
        }
    } catch (err) {
        console.error("⚠️ Call rejection error:", err.message);
    }
}

async function initializeStatusViewing(sock) {
    if (!config.autoViewStatus) return;
    
    try {
        // Subscribe to status updates
        await sock.sendMessage("status@broadcast", { text: "" }, { statusJidList: [] });
        console.log("👁️ Status viewing initialized");
    } catch (err) {
        console.log("⚠️ Status initialization failed (normal on first run)");
    }
}

function startPresenceUpdates(sock) {
    // Clear any existing interval
    if (presenceInterval) clearInterval(presenceInterval);
    
    // Update presence immediately
    updatePresence(sock);
    
    // Then update every minute
    presenceInterval = setInterval(() => {
        updatePresence(sock);
    }, PRESENCE_UPDATE_INTERVAL);
}

async function updatePresence(sock) {
    try {
        await sock.sendPresenceUpdate('available');
    } catch (err) {
        // Silently fail - not critical
    }
}

function startStatusSync(sock) {
    if (!config.autoViewStatus) return;
    
    // Clear any existing interval
    if (statusSyncInterval) clearInterval(statusSyncInterval);
    
    // Re-sync status subscription every 5 minutes
    statusSyncInterval = setInterval(async () => {
        try {
            await sock.sendMessage("status@broadcast", { text: "" }, { statusJidList: [] });
            console.log("🔄 Status subscription refreshed");
        } catch (err) {
            // Silently fail
        }
    }, STATUS_SYNC_INTERVAL);
}

async function handleConnectionUpdate(update, sock) {
    const { connection, lastDisconnect } = update;
    
    if (connection === "close") {
        // Clear intervals on disconnect
        if (presenceInterval) clearInterval(presenceInterval);
        if (statusSyncInterval) clearInterval(statusSyncInterval);
        
        const shouldReconnect = lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
            : true;

        if (shouldReconnect) {
            const delay = config.reconnectDelay || 5000;
            console.log(`⚠️ Connection lost. Reconnecting in ${delay/1000}s...`);
            setTimeout(() => startBot(), delay);
        } else {
            console.log("🚪 Logged out. Please delete auth_session and restart.");
            process.exit(0);
        }
    } else if (connection === "open") {
        console.log(`✅ ${config.botName} is ONLINE!`);
        retryAttempts = 0;
        
        // Initialize status viewing after connection
        await initializeStatusViewing(sock);
        
        // Start presence updates
        startPresenceUpdates(sock);
        
        // Start status sync
        startStatusSync(sock);
    }
}

async function startBot() {
    try {
        // Validate configuration
        validateConfig();

        // Initialize authentication
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        const { version } = await fetchLatestBaileysVersion();

        // Create socket connection
        const sock = makeWASocket({
            version,
            logger: P({ level: "fatal" }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, P({ level: "fatal" })),
            },
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        // Handle pairing for new sessions
        if (!sock.authState.creds.registered) {
            await getPairingCode(sock);
        }

        // Event listeners
        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("messages.upsert", (chatUpdate) => handleIncomingMessages(sock, chatUpdate));
        sock.ev.on("call", (calls) => handleIncomingCall(sock, calls));
        sock.ev.on("connection.update", (update) => handleConnectionUpdate(update, sock));

        console.log("🤖 Bot initialized successfully");

    } catch (err) {
        console.error("💥 Fatal error:", err.message);
        
        const delay = config.reconnectDelay || 5000;
        console.log(`🔄 Restarting in ${delay/1000}s...`);
        setTimeout(() => startBot(), delay);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    if (presenceInterval) clearInterval(presenceInterval);
    if (statusSyncInterval) clearInterval(statusSyncInterval);
    viewedStatus.clear();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('💥 Unhandled rejection:', err.message);
});

// Start the bot
console.log("🚀 Starting bot...");
startBot();
