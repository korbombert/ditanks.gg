require('dotenv').config();//
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const os = require('os');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
// ===================== SERVER CONFIG =====================
const ServerState = { "gateway": true, "game": true };
const { game: isGame, gateway: isGateway } = ServerState;
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.RAILWAY_STATIC_URL || `localhost:${PORT}`;
// ===================== DATABASE =====================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'game.db') 
    : 'game.db';

const db = new Database(dbPath);

console.log(`[Database] Mounted at: ${dbPath}`);

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        pfp TEXT,
        provider TEXT,
        coins INTEGER DEFAULT 0,
        unlocked_colors TEXT DEFAULT '["#ffffff"]',
        selected_color TEXT DEFAULT '#ffffff',
        session_token TEXT
    )
`).run();

// Persistent World Mode data. The terrain seed is generated once and is only
// replaced by the Discord administrator regeneration command.
db.prepare(`CREATE TABLE IF NOT EXISTS world_meta (id INTEGER PRIMARY KEY CHECK(id=1), seed INTEGER NOT NULL, created_at INTEGER NOT NULL)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS world_players (user_id TEXT PRIMARY KEY, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, upgrades TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, owned_car TEXT, session_coins INTEGER NOT NULL DEFAULT 0)`).run();
try { db.prepare('ALTER TABLE world_players ADD COLUMN session_coins INTEGER NOT NULL DEFAULT 0').run(); } catch (err) { if (!String(err.message).includes('duplicate column')) throw err; }
db.prepare(`CREATE TABLE IF NOT EXISTS world_houses (id TEXT PRIMARY KEY, owner_id TEXT, price INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, purchased_at INTEGER, last_seen INTEGER)`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_config (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS banned_ips_v2 (
        ip_hash TEXT PRIMARY KEY,
        timestamp INTEGER,
        reason TEXT
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS changelogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        markdown TEXT,
        date INTEGER,
        sort_order INTEGER
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS achievements_v2 (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        badge TEXT
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS lobby_configs (
        room_id TEXT PRIMARY KEY,
        config TEXT
    )
`).run();
db.prepare(`
    CREATE TABLE IF NOT EXISTS user_achievements_v2 (
        user_id TEXT,
        achievement_id TEXT,
        unlocked_at INTEGER,
        PRIMARY KEY (user_id, achievement_id)
    )
`).run();

// Global highscore leaderboard: top scores are kept per game mode, capped at
// LEADERBOARD_LIMIT entries per mode (see recordLeaderboardScore()).
db.prepare(`
    CREATE TABLE IF NOT EXISTS leaderboard_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        score INTEGER NOT NULL,
        tank TEXT,
        pos_x REAL,
        pos_y REAL,
        scorer_name TEXT,
        scorer_is_bot INTEGER DEFAULT 0,
        scorer_account_id TEXT,
        scorer_account_name TEXT,
        killer_name TEXT,
        killer_is_bot INTEGER DEFAULT 0,
        killer_account_id TEXT,
        killer_account_name TEXT,
        created_at INTEGER
    )
`).run();
db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_leaderboard_mode_score
    ON leaderboard_scores(mode, score DESC)
`).run();

// Migrations must run after every CREATE TABLE above, since they ALTER
// tables (e.g. changelogs) that need to already exist.
const migrations = [
    `ALTER TABLE changelogs ADD COLUMN type TEXT DEFAULT 'changelog'`,
    `ALTER TABLE changelogs ADD COLUMN estimated_end INTEGER`,
    // These two columns were already referenced by the death-handling code
    // (high_score / kills tracking) but were never actually added to the
    // table, which made every one of those UPDATE queries throw. Adding
    // them here fixes that and lets per-user high score + kill tracking work.
    `ALTER TABLE users ADD COLUMN high_score INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN kills INTEGER DEFAULT 0`
];

migrations.forEach(query => {
    try {
        db.prepare(query).run();
        console.log(`[Database] Migration successful: ${query}`);
    } catch (err) {
        if (!err.message.includes("duplicate column name")) {
            console.error(`[Database] Migration failed: ${err.message}`);
        }
    }
});
// ===================== BOT CONSTANTS =====================
const BACKUP_INTERVAL = 1000 * 60 * 60 * 12;
const BACKUP_CHANNEL_ID = '1513631360450035753';
const LEADERBOARD_CHANNEL_ID = '1470498877168812062';
// ===================== GAME CONSTANTS =====================
const GAME_SPEED = 1; 
const VIEW_DISTANCE = 1000; 
const WORLD_SIZE = 5500;
const BASE_SIZE = 600;
const MAX_LEVEL = 30;
const TICK_RATE = 60; 
const SERVER_LOCATION = process.env.SERVER_LOCATION;
const LEVEL_REQUIREMENTS = [ 0, 0, 22, 100, 210, 355, 470, 600, 775, 930, 1100, 1300, 1525, 1650, 1780, 1900, 2500, 3200, 4100, 5000, 6100, 7000, 8000, 9000, 10000, 11100, 12200, 13300, 14400, 15600, 16800 ];

// ===================== SANDBOX MODE =====================
// When enabled, every bot and player is granted SANDBOX_SPAWN_SCORE xp the
// moment they spawn, which (via addXP's normal leveling loop) puts them at
// MAX_LEVEL immediately instead of having to grind for it. Persisted in
// bot_config so it survives restarts, but read from this in-memory
// variable on every spawn so toggling it takes effect immediately.
const SANDBOX_SPAWN_SCORE = 24000;
let sandboxMode = true;
// ===================== GAME DATA =====================
let BOT_NAMES = [];
try {
    const namesPath = path.join(__dirname, 'names.json');
    if (fs.existsSync(namesPath)) {
        const rawData = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
        BOT_NAMES = Array.isArray(rawData[0]) ? rawData.flat() : rawData; 
    }
} catch (err) {}

const TANK_SPECS = {
    'Basic': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0, spread: 0, dmg: 1, spd: 1, rel: 1, size: 1, delay: 0}] },
    'Twin': { barrels: [
        {x:0, y:-10, w:16, l:1.8, angle:0, spread: 0, dmg: 0.67, spd: 1, rel: 1, size: 1, delay: 0}, 
        {x:0, y:10, w:16, l:1.8, angle:0, spread: 0, dmg: 0.67, spd: 1, rel: 1, size: 1, delay: 0.5}
    ]},
    'Sniper': { barrels: [{x:0, y:0, w:18, l:2.4, angle:0, spread: 0, dmg: 1.18, spd: 1.4, rel: 1.66, size: 1, delay: 0}] },
    'Machine Gun': { barrels: [{x:0, y:0, w:22, w2: 32, l:1.6, angle:0, spread: 0.5, dmg: 0.745, spd: 1, rel: 0.5, size: 1, delay: 0, recoilMult: 1.3}] },
    'Flank Guard': { barrels: [
        {x:0, y:0, w:18, l:1.8, angle:0, spread: 0, dmg: 1, spd: 1, rel: 1, size: 1, delay: 0}, 
        {x:0, y:0, w:18, l:1.5, angle:Math.PI, spread: 0, dmg: 1, spd: 1, rel: 1, size: 1, delay: 0}
    ]},
    'Overlord': { 
            isDroneSpawner: true,
            maxDrones: 8,
            barrels: [
                {x:0, y:0, w:30, w2:40, l:1.4, angle:0, spread:0, dmg:1.461, spd:0.8, rel:5.2, size:1, delay:0},
                {x:0, y:0, w:30, w2:40, l:1.4, angle:Math.PI/2, spread:0, dmg:1.461, spd:0.8, rel:5.2, size:1, delay:0},
                {x:0, y:0, w:30, w2:40, l:1.4, angle:Math.PI, spread:0, dmg:1.461, spd:0.8, rel:5.2, size:1, delay:0},
                {x:0, y:0, w:30, w2:40, l:1.4, angle:-Math.PI/2, spread:0, dmg:1.461, spd:0.8, rel:5.2, size:1, delay:0}
            ]
    },
    'Manager': {
            isDroneSpawner: true,
            maxDrones: 8,
            barrels: [
                {x:0, y:0, w:30, w2:40, l:1.4, angle:0, spread:0, dmg:1.461, spd:0.8, rel:2.6, size:1, delay:0}
            ]
    },
    'Necromancer': { 
        isDroneSpawner: true,
        maxDrones: 32,
        barrels: [], square: true
    },
    'Destroyer': { barrels: [{x:0, y:0, w:33, l:1.9, angle:0, spread: 0, dmg: 4.5, spd: 0.8, rel: 8, size: 1.8, delay: 0}] },
    'Octo Tank': { 
    barrels: [
        {x:0, y:0, w:16, l:1.8, angle:0, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0}, 
        {x:0, y:0, w:16, l:1.8, angle:Math.PI/4, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0.5},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI/2, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0}, 
        {x:0, y:0, w:16, l:1.8, angle:3*Math.PI/4, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0.5},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0}, 
        {x:0, y:0, w:16, l:1.8, angle:-3*Math.PI/4, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0.5},
        {x:0, y:0, w:16, l:1.8, angle:-Math.PI/2, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0}, 
        {x:0, y:0, w:16, l:1.8, angle:-Math.PI/4, spread: 0, dmg: 0.54, spd: 1, rel: 1.1, size: 1, delay: 0.5}
    ]
},
    'Triplet': { barrels: [
        {x:0, y:-12, w:14, l:1.6, angle:0, spread: 0, dmg: 0.48, spd: 1, rel: 0.8, size: 1, delay: 0.5}, 
        {x:0, y:12, w:14, l:1.6, angle:0, spread: 0, dmg: 0.48, spd: 1, rel: 0.8, size: 1, delay: 0.5},
        {x:0, y:0, w:14, l:1.8, angle:0, spread: 0, dmg: 0.5, spd: 1, rel: 0.8, size: 1, delay: 0}
    ]},
    'Tri-angle': { barrels: [
        {x:0, y:0, w:18, l:1.8, angle:0, spread: 0, dmg: 1, spd: 0.9, rel: 1, size: 1, delay: 0},
        {x:0, y:0, w:16, l:1.6, angle:5*Math.PI/6, spread: 0, recoilMult: 3.8, dmg: 0.5, spd: 0.9, rel: 1, size: 1, delay: 0.5},
        {x:0, y:0, w:16, l:1.6, angle:-5*Math.PI/6, spread: 0, recoilMult: 3.8, dmg: 0.5, spd: 0.9, rel: 1, size: 1, delay: 0.5}
    ]},
    'Twin Flank': { barrels: [
        {x:0, y:-10, w:16, l:1.8, angle:0, spread:0, dmg:0.63, spd:1, rel:1, size:1, delay:0},
        {x:0, y:10, w:16, l:1.8, angle:0, spread:0, dmg:0.63, spd:1, rel:1, size:1, delay:0.5},
        {x:0, y:-10, w:16, l:1.8, angle:Math.PI, spread:0, dmg:0.67, spd:1, rel:1, size:1, delay:0},
        {x:0, y:10, w:16, l:1.8, angle:Math.PI, spread:0, dmg:0.67, spd:1, rel:1, size:1, delay:0.5}
    ]},
    'Pentashot': { barrels: [
        {x:0, y:0, w:18, l:1.85, angle:0, spread:0, dmg:0.5, spd:1, rel:1, size:1, delay:0},
        {x:0, y:0, w:16, l:1.725, angle:Math.PI/10, spread:0, dmg:0.5, spd:1, rel:1, size:1, delay:0.1},
        {x:0, y:0, w:16, l:1.725, angle:-Math.PI/10, spread:0, dmg:0.5, spd:1, rel:1, size:1, delay:0.1},
        {x:0, y:0, w:14, l:1.6, angle:Math.PI/5, spread:0, dmg:0.5, spd:1, rel:1, size:1, delay:0.2},
        {x:0, y:0, w:14, l:1.6, angle:-Math.PI/5, spread:0, dmg:0.5, spd:1, rel:1, size:1, delay:0.2}
    ]},
    'Predator': { barrels: [
        {x:0, y:0, w:24, l:1.5, angle:0, spread:0, dmg:0.9, spd:1.4, rel:3, size:0.9, delay:0},
        {x:0, y:0, w:17, l:2, angle:0, spread:0, dmg:0.9, spd:1.4, rel:3,size:1, delay:0.25},
        {x:0, y:0, w:10, l:2.5, angle:0, spread:0, dmg:0.9, spd:1.4, rel:3,size:1.1, delay:0.5}
    ]},
    'Sprayer': { barrels: [
        {x:0, y:0, w:22, w2:32, l:1.6, angle:0, spread:0.5, dmg:0.745, spd:1, rel:0.5, size:1, delay:0, recoilMult:1.3},
        {x:0, y:0, w:10, l:1.7, angle:0, spread:0.3, dmg:0.15, spd:1, rel:1, size:0.55, delay:0}
    ]},
    'Railgun': { barrels: [
        {x:0, y:-16, w:9, l:1.6, angle:0, spread:0, dmg:0.26, spd:1.2, rel:0.8, size:0.58, delay:0},
        {x:0, y:16, w:9, l:1.6, angle:0, spread:0, dmg:0.26, spd:1.2, rel:0.8, size:0.58, delay:0.25},
        {x:0, y:-8, w:7, l:1.7, angle:0, spread:0, dmg:0.26, spd:1.2, rel:0.8, size:0.58, delay:0.5},
        {x:0, y:8, w:7, l:1.7, angle:0, spread:0, dmg:0.26, spd:1.2, rel:0.8, size:0.58, delay:0.75}
    ]}
};
const POWERUP_SPAWN_CHANCE = 1 / 150;
const POWERUP_DURATION = 30_000;

// Fixed heal amount for every powerup pickup.
const POWERUP_HEAL_AMOUNT = 25;

// Multiplier applied to max HP while the maxHealth powerup is active.
// Kept consistent with the 1.5x used by the other powerup multipliers.
const MAX_HEALTH_POWERUP_MULTIPLIER = 1.5;

const POWERUP_TYPES = [
    'movementSpeed',
    'reload',
    'damage',
    'fov',
    'bulletSpeed',
    'forceField',
    'maxHealth',
    'healthRegen'
];
const ACHIEVEMENTS = [
    {
        id: 'millionaire_hunter',
        name: 'Millionaire Hunter',
        description: 'Kill a player with over 1,000,000 score',
        badge: 'millionaire'
    },
    {
        id: 'first_blood',
        name: 'First Blood',
        description: 'Get your first player kill',
        badge: 'blood'
    },
    {
        id: 'tank_destroyer',
        name: 'Tank Destroyer',
        description: 'Destroy 100 players',
        badge: 'destroyer'
    },
    {
        id: 'unstoppable',
        name: 'Unstoppable',
        description: 'Reach 1,000,000 score',
        badge: 'fire'
    },
    {
        id: 'survivor',
        name: 'Survivor',
        description: 'Stay alive for 15 minutes',
        badge: 'shield'
    }
];
ACHIEVEMENTS.forEach(a => {
    db.prepare(`
        INSERT OR IGNORE INTO achievements_v2 (id, name, description, badge)
        VALUES (?, ?, ?, ?)
    `).run(a.id, a.name, a.description, a.badge);
});
const UPGRADE_TREE = {
    'Basic': ['Twin', 'Sniper', 'Machine Gun', 'Flank Guard'],
    'Sniper': ['Overlord', 'Necromancer', 'Predator', 'Manager'],
    'Twin': ['Triplet', 'Octo Tank', 'Twin Flank', 'Pentashot'],
    'Flank Guard': ['Tri-angle', 'Octo Tank', 'Twin Flank'],
    'Machine Gun': ['Destroyer', 'Sprayer', 'Railgun'],
    'Twin Flank': ['Pentashot']
};

const SHOP_ITEMS = {
    colors: [
        { id: '#ff0000', name: 'Red', cost: 5000 },
        { id: '#00ff00', name: 'Green', cost: 5000 },
        { id: '#0000ff', name: 'Blue', cost: 5000 },
        { id: '#ff00ff', name: 'Pink', cost: 5000 },
        { id: '#ffff00', name: 'Yellow', cost: 5000 }
    ]
};
function saveLobbyConfig(roomId, config) {
    db.prepare(`
        INSERT OR REPLACE INTO lobby_configs (room_id, config)
        VALUES (?, ?)
    `).run(roomId, JSON.stringify(config));
}

function loadLobbyConfig(roomId) {
    const row = db.prepare(`
        SELECT config
        FROM lobby_configs
        WHERE room_id = ?
    `).get(roomId);

    return row ? JSON.parse(row.config) : {};
}
// ===================== EXPRESS SETUP =====================

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===================== MIDDLEWARE ========================

const requireAdmin = (req, res, next) => {
    let token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token && req.headers.cookie) {
        const match = req.headers.cookie.match(/sessionToken=([^;]+)/);
        if (match) token = match[1];
    }
    
    if (!token) {
        return res.status(401).sendFile(path.join(__dirname, 'public', '401.html'));
    }
    
    const user = db.prepare("SELECT username FROM users WHERE session_token = ?").get(token);
    if (!user || user.username !== process.env.ADMIN_USERNAME) {
        return res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
    }
    next();
};

// ===================== ROUTING =====================

function handleUserLogin(res, providerId, username, pfp, provider) {
    let user = db.prepare("SELECT * FROM users WHERE id = ?").get(providerId);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    if (!user) {
        db.prepare(`
            INSERT INTO users (id, username, pfp, provider, session_token, unlocked_colors) 
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(providerId, username, pfp, provider, sessionToken, JSON.stringify(['#ffffff']));
    } else {
        db.prepare(`
            UPDATE users 
            SET username = ?, pfp = ?, session_token = ? 
            WHERE id = ?
        `).run(username, pfp, sessionToken, providerId);
    }
    res.redirect(`/?token=${sessionToken}`);
}

app.get('/auth/google', (req, res) => {
    const redirectUri = `${process.env.BASE_URL}/auth/google/callback`;
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'profile'
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) throw new Error("No code provided from Google");
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET, 
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: `${process.env.BASE_URL}/auth/google/callback`,
            })
        });
        const tokenData = await tokenRes.json();
        
        if (!tokenRes.ok) {
            console.error("Google Token Exchange Failed:", tokenData);
            return res.redirect('/?error=token_exchange_failed');
        }
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const profile = await profileRes.json();
        handleUserLogin(res, `google_${profile.id}`, profile.name, profile.picture, 'google');
    } catch (err) {
        console.error("Google Auth Crash:", err.message);
        res.redirect('/?error=auth_failed');
    }
});

app.get('/auth/discord', (req, res) => {
    const url = `https://discord.com/oauth2/authorize?client_id=1487399148566089828&response_type=code&redirect_uri=https%3A%2F%2Fditanks.up.railway.app%2Fauth%2Fdiscord%2Fcallback&scope=identify`;
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) throw new Error("No code provided from Discord");

        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: `https://ditanks.up.railway.app/auth/discord/callback`
            })
        });

        const tokenData = await tokenRes.json();
        
        if (!tokenRes.ok) {
            console.error("Token Exchange Failed:", tokenData);
            return res.redirect('/?error=token_exchange_failed');
        }

        const profileRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });

        const profile = await profileRes.json();
        console.log("Discord Profile:", profile);

        const avatarUrl = profile.avatar 
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` 
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator || 0) % 5}.png`;

        handleUserLogin(res, `discord_${profile.id}`, profile.username, avatarUrl, 'discord');
    } catch (err) {
        console.error("Full Auth Crash:", err.message);
        res.redirect('/?error=auth_failed');
    }
});

app.get('/api/me', (req, res) => {
    let token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const user = db.prepare("SELECT username, pfp, coins FROM users WHERE session_token = ?").get(token);
    if (user) res.json(user);
    else res.status(404).json({ error: "User not found" });
});

app.get('/app', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/app/build/tank', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'tankbuilder.html'));
});

app.get('/api/servers', (req, res) => {
    const serverList = {};
    for (let roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'stopped') continue;
        const parts = roomId.split('-');
        const mode = parts[0];
        const region = parts.slice(1).join('-'); 
        
        if (!serverList[mode]) serverList[mode] = [];
        
        const playerCount = room.clients.filter(c => c.player && c.player.type !== 'ai').length;
        serverList[mode].push({ 
            id: region, 
            name: `Server ${region.replace('S', '')}`, 
            players: playerCount 
        });
    }
    res.json(serverList);
});

app.get('/api/admin/rooms', requireAdmin, (req, res) => {
    const roomData = Object.keys(rooms).filter(roomId => rooms[roomId].status === 'running').map(roomId => ({
        id: roomId,
        mode: rooms[roomId].mode,
        players: rooms[roomId].clients.filter(c => c.player).length
    }));
    res.json(roomData);
});

app.get('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });

    const players = room.clients.filter(c => c.player).map(c => ({
        id: c.player.id,
        name: c.player.name,
        team: c.player.team,
        score: Math.floor(c.player.score),
        ipHash: c.ipHash,
        country: c.country || 'xx'
    }));
    res.json({ mode: room.mode, players });
});

app.post('/api/admin/action', requireAdmin, (req, res) => {
    const { action, roomId, playerId, ipHash, reason, newName } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });

    const targetClient = room.clients.find(c => c.player && c.player.id === playerId);

    if (action === 'kick' || action === 'ban') {
        if (action === 'ban' && ipHash) {
            db.prepare("INSERT OR REPLACE INTO banned_ips_v2 (ip_hash, timestamp, reason) VALUES (?, ?, ?)").run(ipHash, Date.now(), reason || "No reason specified");
        }
        if (targetClient) {
            targetClient.ws.close(4000, action === 'ban' ? "Banned" : "Kicked");
            if (targetClient.player) targetClient.player.markedForDeletion = true;
        }
        return res.json({ success: true });
    } else if (action === 'rename') {
        if (targetClient && targetClient.player) {
            targetClient.player.name = newName || "Unnamed";
        }
        return res.json({ success: true });
    }
    
    res.status(400).json({ error: "Invalid action" });
});

app.get('/api/admin/bans', requireAdmin, (req, res) => {
    const bans = db.prepare("SELECT * FROM banned_ips_v2 ORDER BY timestamp DESC").all();
    res.json(bans);
});

app.post('/api/admin/unban', requireAdmin, (req, res) => {
    const { ipHash } = req.body;
    db.prepare("DELETE FROM banned_ips_v2 WHERE ip_hash = ?").run(ipHash);
    res.json({ success: true });
});

app.get('/api/admin/server_instances', requireAdmin, (req, res) => {
    const instances = Object.values(rooms).map(r => ({
        id: r.id,
        mode: r.mode,
        status: r.status,
        players: r.clients.length
    }));
    res.json(instances);
});

app.post('/api/admin/server_instances/create', requireAdmin, (req, res) => {
    const { id, mode } = req.body;
    if (!id || !mode) return res.status(400).json({ error: "Invalid parameters" });
    if (rooms[id]) return res.status(400).json({ error: "Server already exists" });
    
    rooms[id] = new Room(
    id,
    mode,
    loadLobbyConfig(id)
);
    res.json({ success: true });
});

app.post('/api/admin/server_instances/action', requireAdmin, (req, res) => {
    const { action, serverIds } = req.body;
    if (!serverIds || !Array.isArray(serverIds)) return res.status(400).json({ error: "Invalid payload" });

    serverIds.forEach(id => {
        const room = rooms[id];
        if (room) {
            if (action === 'kill') room.stop();
            else if (action === 'boot') room.start();
            else if (action === 'restart') room.restart();
            else if (action === 'delete') {
                room.stop();
                delete rooms[id]; 
            }
        }
    });
    res.json({ success: true });
});
app.get('/api/admin/lobbies/:roomId/config', requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({ error: "Room not found" });
    }

    res.json(room.config);
});
app.post('/api/admin/lobbies/:roomId/config', requireAdmin, (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({ error: "Room not found" });
    }

    room.config = {
        ...room.config,
        ...req.body
    };

    saveLobbyConfig(room.id, room.config);

    const bots = room.entities.filter(e => e.type === 'ai');

    if (bots.length < room.config.botCount) {
        for (let i = bots.length; i < room.config.botCount; i++) {
            room.spawnBot(i);
        }
    }

    if (bots.length > room.config.botCount) {
        bots
            .slice(room.config.botCount)
            .forEach(bot => bot.markedForDeletion = true);
    }
    const shapes = room.entities.filter(e =>
    ['square','triangle','pentagon','hexagon'].includes(e.type)
);

if (shapes.length < room.config.shapeCount) {
    for (let i = shapes.length; i < room.config.shapeCount; i++) {
        room.spawnShape();
    }
}

if (shapes.length > room.config.shapeCount) {
    shapes
        .slice(room.config.shapeCount)
        .forEach(shape => shape.markedForDeletion = true);
}
    res.json({
        success: true,
        config: room.config
    });
});
app.get('/api/changelogs', (req, res) => {
    const logs = db.prepare("SELECT * FROM changelogs ORDER BY sort_order DESC, date DESC").all();
    res.json(logs);
});

app.post('/api/admin/changelogs', requireAdmin, (req, res) => {
    const { title, description, markdown, sort_order } = req.body;
    db.prepare("INSERT INTO changelogs (title, description, markdown, date, sort_order) VALUES (?, ?, ?, ?, ?)").run(title, description, markdown, Date.now(), sort_order || 0);
    res.json({ success: true });
});

app.delete('/api/admin/changelogs/:id', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM changelogs WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});
app.get('/api/achievements', (req, res) => {
    res.json(ACHIEVEMENTS);
});

// ===================== LEADERBOARD API =====================
// Global highscore leaderboard: top 50 scores per game mode. Public/read-only,
// like /api/changelogs and /api/achievements above.

app.get('/api/leaderboard/modes', (req, res) => {
    const rows = db.prepare(`SELECT DISTINCT mode FROM leaderboard_scores`).all();
    res.json(rows.map(r => r.mode));
});

app.get('/api/leaderboard/:mode', (req, res) => {
    const { mode } = req.params;
    const rows = db.prepare(`
        SELECT * FROM leaderboard_scores
        WHERE mode = ?
        ORDER BY score DESC
        LIMIT ?
    `).all(mode, LEADERBOARD_LIMIT);

    res.json({
        mode,
        leaderboard: rows.map(formatLeaderboardRow)
    });
});

app.get('/api/leaderboard', (req, res) => {
    const modes = db.prepare(`SELECT DISTINCT mode FROM leaderboard_scores`).all().map(r => r.mode);
    const result = {};
    modes.forEach(mode => {
        const rows = db.prepare(`
            SELECT * FROM leaderboard_scores
            WHERE mode = ?
            ORDER BY score DESC
            LIMIT ?
        `).all(mode, LEADERBOARD_LIMIT);
        result[mode] = rows.map(formatLeaderboardRow);
    });
    res.json(result);
});

app.get('/api/me/achievements', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        let token = authHeader?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        // 1. Safe User Lookup
        const user = db.prepare(`
            SELECT id FROM users
            WHERE session_token = ?
        `).get(token);

        // Check if user exists BEFORE accessing user.id to avoid TypeError crash
        if (!user) {
            return res.status(404).json({ error: 'Invalid or expired session token' });
        }

        // 2. Fetch Achievements (Fixing 'badge' vs 'icon' based on your frontend)
        const achievements = db.prepare(`
            SELECT
                a.id,
                a.name,
                a.description,
                a.badge,         -- Double check if your SQLite column is 'badge' or 'icon'
                ua.unlocked_at
            FROM user_achievements_v2 ua
            JOIN achievements_v2 a ON ua.achievement_id = a.id
            WHERE ua.user_id = ?
            ORDER BY ua.unlocked_at DESC
        `).all(user.id);

        res.json(achievements);

    } catch (dbError) {
        // This catches SQLite errors instead of completely crashing the request pipeline
        console.error("Database error in /api/me/achievements:", dbError);
        res.status(500).json({ error: 'Internal Server Error', details: dbError.message });
    }
});
// ===================== ADMIN: STATS =====================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const totalPlayers = Object.values(rooms).reduce((sum, r) => sum + r.clients.filter(c => c.player).length, 0);
    const totalRooms = Object.values(rooms).filter(r => r.status === 'running').length;
    const memUsage = process.memoryUsage();
    const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const totalAccounts = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    res.json({
        totalPlayers,
        totalRooms,
        memory: { usedMB },
        uptime: Math.floor(process.uptime()),
        totalAccounts
    });
});

// ===================== ADMIN: ACCOUNTS =====================

app.get('/api/admin/accounts', requireAdmin, (req, res) => {
    const accounts = db.prepare("SELECT id, username, pfp, provider, coins, unlocked_colors, selected_color, session_token FROM users ORDER BY username").all();
    const result = accounts.map(a => {
        let colors = ['#ffffff'];
        try { colors = JSON.parse(a.unlocked_colors); } catch(e) {}
        return {
            id: a.id,
            username: a.username,
            pfp: a.pfp,
            provider: a.provider,
            coins: a.coins,
            unlocked_colors: colors,
            selected_color: a.selected_color,
            has_session: !!a.session_token
        };
    });
    res.json(result);
});

app.patch('/api/admin/accounts/:id', requireAdmin, (req, res) => {
    const coins = parseInt(req.body.coins);
    if (isNaN(coins) || coins < 0) return res.status(400).json({ error: "Invalid coins value" });
    db.prepare("UPDATE users SET coins = ? WHERE id = ?").run(coins, req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/accounts/:id/reset', requireAdmin, (req, res) => {
    db.prepare("UPDATE users SET coins = 0, unlocked_colors = ?, selected_color = '#ffffff' WHERE id = ?")
        .run(JSON.stringify(['#ffffff']), req.params.id);
    res.json({ success: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/accounts/:id/expire', requireAdmin, (req, res) => {
    db.prepare("UPDATE users SET session_token = NULL WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

app.post('/api/admin/expire-all-sessions', requireAdmin, (req, res) => {
    db.prepare("UPDATE users SET session_token = NULL").run();
    res.json({ success: true });
});

// ===================== ADMIN: GAME CONFIG =====================

app.get('/api/admin/game-config', requireAdmin, (req, res) => {
    const keys = ['maintenance_mode', 'motd', 'coin_multiplier', 'max_bots'];
    const config = {};
    keys.forEach(k => {
        const row = db.prepare("SELECT value FROM bot_config WHERE key = ?").get(k);
        config[k] = row ? row.value : null;
    });
    config.sandbox_mode = sandboxMode;
    res.json(config);
});

app.post('/api/admin/game-config', requireAdmin, (req, res) => {
    const { maintenance_mode, motd, coin_multiplier, max_bots, sandbox_mode } = req.body;
    const entries = { maintenance_mode, motd, coin_multiplier, max_bots };
    const upsert = db.prepare("INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(entries)) {
        if (v !== undefined) upsert.run(k, String(v));
    }
    if (sandbox_mode !== undefined) {
        setSandboxMode(sandbox_mode === true || sandbox_mode === 'true');
    }
    res.json({ success: true, sandbox_mode: sandboxMode });
});

// ===================== ADMIN: BROADCAST =====================

app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
    const { message, type } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });
    let sent = 0;
    for (const room of Object.values(rooms)) {
        if (room.status !== 'running') continue;
        for (const client of room.clients) {
            if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'broadcast', msgType: type || 'announcement', message }));
                sent++;
            }
        }
    }
    res.json({ sent });
});

// ===================== ADMIN: KICK ALL =====================

app.post('/api/admin/kick-all', requireAdmin, (req, res) => {
    for (const room of Object.values(rooms)) {
        for (const client of [...room.clients]) {
            try { client.ws.close(4000, "Kicked by admin"); } catch(e) {}
            if (client.player) client.player.markedForDeletion = true;
        }
    }
    res.json({ success: true });
});

// ===================== ADMIN: DOWNTIME =====================

app.post('/api/admin/downtime', requireAdmin, (req, res) => {
    const { title, message, severity, estimated_end } = req.body;
    if (!title || !message) return res.status(400).json({ error: "Title and message are required" });
    // First line of markdown encodes severity so the changelog renderer can extract it
    const markdown = `severity:${severity || 'warning'}\n${message}`;
    const endTime = estimated_end ? new Date(estimated_end).getTime() : null;
    db.prepare(`
        INSERT INTO changelogs (title, description, markdown, date, sort_order, type, estimated_end)
        VALUES (?, ?, ?, ?, ?, 'downtime', ?)
    `).run(title, message, markdown, Date.now(), 999, endTime);
    res.json({ success: true });
});

app.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ===================== HTTP & WEBSOCKET SERVER =====================

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===================== GAME CLASSES =====================

class SpatialGrid {
    constructor(size, cellSize) {
        this.cellSize = cellSize;
        this.cols = Math.ceil(size / cellSize);
        this.rows = Math.ceil(size / cellSize);
        this.cells = Array.from({ length: this.cols * this.rows }, () => ({ entities: [], bullets: [], drones: [] }));
    }
    clear() {
        for (let i = 0; i < this.cells.length; i++) {
            this.cells[i].entities.length = 0;
            this.cells[i].bullets.length = 0;
            this.cells[i].drones.length = 0;
        }
    }
    insert(obj, type) {
        let col = Math.floor(obj.x / this.cellSize);
        let row = Math.floor(obj.y / this.cellSize);
        if (col < 0) col = 0; if (col >= this.cols) col = this.cols - 1;
        if (row < 0) row = 0; if (row >= this.rows) row = this.rows - 1;
        this.cells[col + row * this.cols][type].push(obj);
    }
    getNearby(x, y, range) {
        let result = { entities: [], bullets: [], drones: [] };
        let startCol = Math.max(0, Math.floor((x - range) / this.cellSize));
        let endCol = Math.min(this.cols - 1, Math.floor((x + range) / this.cellSize));
        let startRow = Math.max(0, Math.floor((y - range) / this.cellSize));
        let endRow = Math.min(this.rows - 1, Math.floor((y + range) / this.cellSize));

        for (let c = startCol; c <= endCol; c++) {
            for (let r = startRow; r <= endRow; r++) {
                let cell = this.cells[c + r * this.cols];
                for (let i = 0; i < cell.entities.length; i++) result.entities.push(cell.entities[i]);
                for (let i = 0; i < cell.bullets.length; i++) result.bullets.push(cell.bullets[i]);
                for (let i = 0; i < cell.drones.length; i++) result.drones.push(cell.drones[i]);
            }
        }
        return result;
    }
}

class SparseGrid extends SpatialGrid {
    constructor(size, cellSize) { super(1, cellSize); this.cols = this.rows = Math.ceil(size / cellSize); this.map = new Map(); }
    clear() { this.map.clear(); }
    insert(obj, type) {
        const col = Math.max(0, Math.min(this.cols - 1, Math.floor(obj.x / this.cellSize))), row = Math.max(0, Math.min(this.rows - 1, Math.floor(obj.y / this.cellSize))), key = col + row * this.cols;
        let cell = this.map.get(key); if (!cell) this.map.set(key, cell = { entities: [], bullets: [], drones: [] });
        cell[type].push(obj);
    }
    getNearby(x, y, range) {
        const result = { entities: [], bullets: [], drones: [] };
        const c0 = Math.max(0, Math.floor((x - range) / this.cellSize)), c1 = Math.min(this.cols - 1, Math.floor((x + range) / this.cellSize));
        const r0 = Math.max(0, Math.floor((y - range) / this.cellSize)), r1 = Math.min(this.rows - 1, Math.floor((y + range) / this.cellSize));
        for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
            const cell = this.map.get(c + r * this.cols); if (!cell) continue;
            for (let i = 0; i < cell.entities.length; i++) result.entities.push(cell.entities[i]);
            for (let i = 0; i < cell.bullets.length; i++) result.bullets.push(cell.bullets[i]);
            for (let i = 0; i < cell.drones.length; i++) result.drones.push(cell.drones[i]);
        }
        return result;
    }
}

class Room {
    constructor(id, mode, config = {}) {
        this.id = id;
        this.mode = mode;
        this.config = {
            shapeCount: config.shapeCount ?? 300,
            botCount: config.botCount ?? 40, // increased default
            shapeRespawn: config.shapeRespawn ?? true,
            ...config
        };
        this.entities = [];
        this.bullets = [];
        this.drones = [];
        this.clients = [];
        this.nextEntityId = 1;
        this.nextBulletId = 1;
        this.nextDroneId = 1;
        this.grid = new SpatialGrid(WORLD_SIZE, 250); 
        this.status = 'running';
        this.spawnEntities();
    }

    stop() {
        this.status = 'stopped';
        this.clients.forEach(c => {
            try { c.ws.close(4000, "Server Stopped"); } catch(e){}
        });
        this.clients = [];
        this.entities = [];
        this.bullets = [];
        this.drones = [];
        this.grid.clear();
    }

    start() {
        if (this.status === 'stopped') {
            this.status = 'running';
            this.nextEntityId = 1;
            this.nextBulletId = 1;
            this.nextDroneId = 1;
            this.spawnEntities();
        }
    }

    restart() {
        this.stop();
        this.start();
    }

    spawnEntities() {
    for (let i = 0; i < this.config.shapeCount; i++) {
        this.spawnShape();
    }

    for (let i = 0; i < this.config.botCount; i++) {
        this.spawnBot(i);
    }
}

    spawnShape() {
        let x = Math.random() * WORLD_SIZE, y = Math.random() * WORLD_SIZE;
        
        let isCenter = x > 1400 && x < 2600 && y > 1400 && y < 2600;
        let type;

        if (isCenter && Math.random() < 0.08) {
            x = WORLD_SIZE / 2 + (Math.random() * 200 - 100);
            y = WORLD_SIZE / 2 + (Math.random() * 200 - 100);
            type = 'hexagon';
        } else {
            type = isCenter 
                ? ['pentagon', 'pentagon', 'triangle', 'pentagon'][Math.floor(Math.random()*4)]
                : ['square','square','square','triangle','triangle','pentagon'][Math.floor(Math.random()*5)]; 
        }
        const shape = new Entity(this, x, y, type);

if (Math.random() < POWERUP_SPAWN_CHANCE) {
    shape.type = 'powerup';
    shape.powerupType = POWERUP_TYPES[
        Math.floor(Math.random() * POWERUP_TYPES.length)
    ];

    shape.hp = 550;
    shape.maxHp = 550;
    shape.radius = 30;
    shape.xpVal = 4000;
}

this.entities.push(shape);
    }

    spawnBot(index, startScore = 0) {
        let team;
        if (this.mode === "2TDM") {
            let t1Count = this.entities.filter(e => e.team === 1 && ['tank', 'ai'].includes(e.type)).length;
            let t2Count = this.entities.filter(e => e.team === 2 && ['tank', 'ai'].includes(e.type)).length;
            team = t1Count <= t2Count ? 1 : 2;
        } else if (this.mode === "4TDM") {
            let counts = [0, 0, 0, 0];
            this.entities.forEach(e => {
                if(['tank', 'ai'].includes(e.type) && e.team >= 1 && e.team <= 4) counts[e.team-1]++;
            });
            team = counts.indexOf(Math.min(...counts)) + 1;
        } else {
            team = index + 5; 
        }

        let bx, by;
        if(this.mode === "2TDM") {
            bx = team === 1 ? Math.random()*350 + 25 : WORLD_SIZE - 350 - Math.random()*25;
            by = Math.random() * WORLD_SIZE;
        } else if (this.mode === "4TDM") {
            let px = Math.random() * 550 + 25;
            let py = Math.random() * 550 + 25;
            if (team === 1) { bx = px; by = py; } 
            else if (team === 2) { bx = WORLD_SIZE - px; by = WORLD_SIZE - py; } 
            else if (team === 3) { bx = WORLD_SIZE - px; by = py; } 
            else if (team === 4) { bx = px; by = WORLD_SIZE - py; } 
        } else {
            bx = Math.random() * WORLD_SIZE;
            by = Math.random() * WORLD_SIZE;
        }
        let bot = new Entity(this, bx, by, 'ai', "", team);
        if (sandboxMode) {
            bot.addXP(SANDBOX_SPAWN_SCORE);
        } else if (startScore > 0) {
            bot.addXP(startScore);
        }
        this.entities.push(bot);
    }
}

function isInProtectedBase(room, obj, viewerTeam = 0) {
    if (!obj) return false;

    const PROX = 350;
    const BASE_SIZE_4 = 600;
    const BASE_WIDTH_2 = 400;

    if (
        viewerTeam !== 0 &&
        obj.team !== 0 &&
        obj.team === viewerTeam
    ) {
        return false;
    }

    if (room.mode === "2TDM") {

        if (obj.x < BASE_WIDTH_2 + PROX) {
            if (obj.team === 1) return true;
            if (obj.team === 0) return true;
        }

        if (obj.x > WORLD_SIZE - BASE_WIDTH_2 - PROX) {
            if (obj.team === 2) return true;
            if (obj.team === 0) return true;
        }
    }

    if (room.mode === "4TDM") {

        let inTL =
            obj.x < BASE_SIZE_4 + PROX &&
            obj.y < BASE_SIZE_4 + PROX;

        let inTR =
            obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX &&
            obj.y < BASE_SIZE_4 + PROX;

        let inBL =
            obj.x < BASE_SIZE_4 + PROX &&
            obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX;

        let inBR =
            obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX &&
            obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX;

        if (inTL && (obj.team === 1 || obj.team === 0)) return true;
        if (inBR && (obj.team === 2 || obj.team === 0)) return true;
        if (inTR && (obj.team === 3 || obj.team === 0)) return true;
        if (inBL && (obj.team === 4 || obj.team === 0)) return true;
    }

    return false;
}
function getSafeZone(room, team) {
    if (room.mode === "2TDM") {
        return {
            x: team === 1 ? WORLD_SIZE * 0.22 : WORLD_SIZE * 0.78,
            y: WORLD_SIZE / 2
        };
    }

    if (room.mode === "4TDM") {
        if (team === 1) return { x: WORLD_SIZE * 0.22, y: WORLD_SIZE * 0.22 };
        if (team === 2) return { x: WORLD_SIZE * 0.78, y: WORLD_SIZE * 0.78 };
        if (team === 3) return { x: WORLD_SIZE * 0.78, y: WORLD_SIZE * 0.22 };
        if (team === 4) return { x: WORLD_SIZE * 0.22, y: WORLD_SIZE * 0.78 };
    }

    return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
}
// Returns true if obj is inside an ENEMY base zone that the AI (of aiTeam) cannot enter.
// The AI's own base is excluded — bots can freely walk there.
function isInEnemyBase(room, obj, aiTeam) {
    if (!obj) return false;
    
    const PROX = 350;
    const BASE_SIZE_4 = 600;
    const BASE_WIDTH_2 = 400;

    if (room.mode === "2TDM") {
        // Team 1 owns the left side, team 2 owns the right side.
        if (aiTeam !== 1 && obj.x < BASE_WIDTH_2 + PROX) return true;
        if (aiTeam !== 2 && obj.x > WORLD_SIZE - BASE_WIDTH_2 - PROX) return true;
    }

    if (room.mode === "4TDM") {
        // Teams: 1=TL, 2=BR, 3=TR, 4=BL
        let inTL = obj.x < BASE_SIZE_4 + PROX && obj.y < BASE_SIZE_4 + PROX;
        let inBR = obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX && obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX;
        let inTR = obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX && obj.y < BASE_SIZE_4 + PROX;
        let inBL = obj.x < BASE_SIZE_4 + PROX && obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX;
        if (inTL && aiTeam !== 1) return true;
        if (inBR && aiTeam !== 2) return true;
        if (inTR && aiTeam !== 3) return true;
        if (inBL && aiTeam !== 4) return true;
    }

    return false;
}

function unlockAchievement(userId, achievementId, ws = null) {
    const already = db.prepare(`
        SELECT * FROM user_achievements_v2
        WHERE user_id = ? AND achievement_id = ?
    `).get(userId, achievementId);

    if (already) return false;

    db.prepare(`
        INSERT INTO user_achievements_v2
        (user_id, achievement_id, unlocked_at)
        VALUES (?, ?, ?)
    `).run(userId, achievementId, Date.now());

    const achievement = db.prepare(`
        SELECT * FROM achievements_v2 WHERE id = ?
    `).get(achievementId);

    if (ws && achievement) {
        ws.send(JSON.stringify({
            type: 'achievement_unlocked',
            achievement
        }));
    }

    return true;
}

// ===================== GLOBAL LEADERBOARD =====================
const LEADERBOARD_LIMIT = 50;

// Records a death's score against the global per-mode leaderboard, keeping
// only the top LEADERBOARD_LIMIT entries for that mode. `entity` is whoever
// just died (the scorer); `killer`/`killerClient` (both optional) describe
// whoever landed the killing blow, resolved by the caller.
function recordLeaderboardScore(mode, entity, killer, killerClient) {
    if (!['tank', 'ai'].includes(entity.type)) return;
    if (!Number.isFinite(entity.score) || entity.score <= 0) return;

    // Cheap early-out: if the board is already full for this mode and this
    // score wouldn't crack the top LEADERBOARD_LIMIT, skip the insert+prune
    // entirely so low scores don't churn the table.
    const currentCount = db.prepare(
        `SELECT COUNT(*) as c FROM leaderboard_scores WHERE mode = ?`
    ).get(mode).c;
    if (currentCount >= LEADERBOARD_LIMIT) {
        const lowest = db.prepare(
            `SELECT score FROM leaderboard_scores WHERE mode = ? ORDER BY score ASC LIMIT 1`
        ).get(mode);
        if (lowest && entity.score <= lowest.score) return;
    }

    let scorerAccountId = null;
    let scorerAccountName = null;
    // This runs before the client's `.player` reference is cleared on death,
    // so we can still look it up here to check for a linked account.
    const scorerRoomClient = entity.room?.clients?.find(c => c.player === entity) || null;
    if (scorerRoomClient?.dbId) {
        const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(scorerRoomClient.dbId);
        if (user) {
            scorerAccountId = user.id;
            scorerAccountName = user.username;
        }
    }

    let killerAccountId = null;
    let killerAccountName = null;
    if (killerClient?.dbId) {
        const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(killerClient.dbId);
        if (user) {
            killerAccountId = user.id;
            killerAccountName = user.username;
        }
    }

    db.prepare(`
        INSERT INTO leaderboard_scores
        (mode, score, tank, pos_x, pos_y, scorer_name, scorer_is_bot, scorer_account_id, scorer_account_name,
         killer_name, killer_is_bot, killer_account_id, killer_account_name, created_at)
        VALUES (@mode, @score, @tank, @pos_x, @pos_y, @scorer_name, @scorer_is_bot, @scorer_account_id, @scorer_account_name,
                @killer_name, @killer_is_bot, @killer_account_id, @killer_account_name, @created_at)
    `).run({
        mode,
        score: Math.floor(entity.score),
        tank: entity.tankType || null,
        pos_x: entity.x,
        pos_y: entity.y,
        scorer_name: entity.name || (entity.type === 'ai' ? 'Bot' : 'Unnamed'),
        scorer_is_bot: entity.type === 'ai' ? 1 : 0,
        scorer_account_id: scorerAccountId,
        scorer_account_name: scorerAccountName,
        killer_name: killer ? (killer.name || (killer.type === 'ai' ? 'Bot' : 'Unnamed')) : null,
        killer_is_bot: killer ? (killer.type === 'ai' ? 1 : 0) : null,
        killer_account_id: killerAccountId,
        killer_account_name: killerAccountName,
        created_at: Date.now()
    });

    // Prune back down to the top LEADERBOARD_LIMIT entries for this mode.
    db.prepare(`
        DELETE FROM leaderboard_scores
        WHERE mode = ? AND id NOT IN (
            SELECT id FROM leaderboard_scores WHERE mode = ? ORDER BY score DESC LIMIT ?
        )
    `).run(mode, mode, LEADERBOARD_LIMIT);
}

function formatLeaderboardRow(row, index) {
    return {
        rank: index + 1,
        score: row.score,
        tank: row.tank,
        position: { x: row.pos_x, y: row.pos_y },
        mode: row.mode,
        scorer: {
            name: row.scorer_name,
            isBot: !!row.scorer_is_bot,
            account: row.scorer_account_id
                ? { id: row.scorer_account_id, username: row.scorer_account_name }
                : null
        },
        killer: {
            name: row.killer_name,
            isBot: row.killer_is_bot === null ? null : !!row.killer_is_bot,
            account: row.killer_account_id
                ? { id: row.killer_account_id, username: row.killer_account_name }
                : null
        },
        timestamp: row.created_at
    };
}

class Entity {
    constructor(room, x, y, type, name = "", team = 0, isPlayer = false, ws = null) {
        this.room = room;
        this.id = room.nextEntityId++;
        this.x = x; this.y = y; this.type = type;
        this.name = name; this.team = team;
        this.isPlayer = isPlayer; this.ws = ws;
        this.tankType = 'Basic';
        this.score = 0; this.level = 1; this.xp = 0; this.statPoints = 0;
        this.stats = [0,0,0,0,0,0,0,0];
        this.hp = 100; this.maxHp = 100;
        this.powerups = {
    movementSpeed: 0,
    reload: 0,
    damage: 0,
    fov: 0,
    bulletSpeed: 0,
    forceField: 0,
    maxHealth: 0,
    healthRegen: 0
};

this.maxHealthPowerupActive = false;
this.baseMaxHpBeforePowerup = null;
        this.radius = 20; this.angle = 0;
        this.vehicle = null; this.ghost = false;
        this.vx = 0; this.vy = 0;
        this.barrelTimers = []; this.wasShooting = false; this.activeDrones = 0;
        this.inputs = { up: false, down: false, left: false, right: false, shooting: false, angle: 0, repel: false };
        this.markedForDeletion = false;
        this.spawnTime = Date.now();
        this.targetId = null; 
        this.lastDamagedBy = null;
        this.nameColor = '#ffffff';
        this.lastDamageTime = Date.now();
        this.thinkTimer = Math.floor(Math.random() * 10); 
        this.aiTarget = null; 
        this.evadeVx = 0; 
        this.evadeVy = 0;
        // Wander anchor: each idle bot patrols around its own point instead of
        // every idle bot being pulled back toward the exact same map-center
        // coordinate, which is what caused AI tanks to flock together and
        // gather in the middle of the map. Re-rolled periodically so patrol
        // routes keep drifting instead of getting stuck in one spot forever.
        this.wanderAnchorX = x;
        this.wanderAnchorY = y;
        this.wanderAnchorTimer = 600 + Math.floor(Math.random() * 900); // ~10-25s @60fps
        // Light separation nudge away from other nearby bots so idle AI
        // spreads out instead of stacking on top of each other.
        this.flockSeparationX = 0;
        this.flockSeparationY = 0;
        // Manager invisibility
        this.opacity = 1;
        this.stillTicks = 0;
        if(type === 'square') { this.hp = 14; this.maxHp = 14; this.radius = 15; this.xpVal = 60; }
        if(type === 'triangle') { this.hp = 35; this.maxHp = 35; this.radius = 18; this.xpVal = 150; }
        if(type === 'pentagon') { this.hp = 140; this.maxHp = 140; this.radius = 30; this.xpVal = 600; }
        if(type === 'hexagon') { this.hp = 750; this.maxHp = 750; this.radius = 45; this.xpVal = 2000; }
        if(type === 'ai') { this.name = BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] || "Bot"; }
    }
    getPowerupActive(type) {
    return (this.powerups?.[type] || 0) > Date.now();
}

getEffectiveMaxHp() {
    return this.maxHp + (this.stats[1] * 20);
}

getPowerupDamageMultiplier() {
    return this.getPowerupActive('damage') ? 1.5 : 1;
}

getPowerupReloadMultiplier() {
    return this.getPowerupActive('reload') ? (1 / 1.5) : 1;
}

getPowerupMoveMultiplier() {
    return this.getPowerupActive('movementSpeed') ? 1.5 : 1;
}

getPowerupBulletSpeedMultiplier() {
    return this.getPowerupActive('bulletSpeed') ? 1.5 : 1;
}
    addXP(amt) {
        if(['square','triangle','pentagon','hexagon'].includes(this.type)) return;
        this.score += amt; 
        if(this.level >= MAX_LEVEL) return;
        
        while(this.level < MAX_LEVEL && this.score >= LEVEL_REQUIREMENTS[this.level + 1]) {
            this.level++; 
            this.statPoints++;
            this.maxHp += 15; 
            this.hp = this.maxHp;
            this.radius = 20 + (this.level * 0.3);
        }
        
        let prevReq = LEVEL_REQUIREMENTS[this.level];
        this.xp = this.level === MAX_LEVEL ? 0 : this.score - prevReq; 
        if (this.isPlayer && this.ws) {
    const client = this.room.clients.find(c => c.player === this);

    if (client?.dbId) {

        if (this.score >= 1000000) {
            unlockAchievement(
                client.dbId,
                'unstoppable',
                client.ws
            );
        }

        const aliveTime = Date.now() - this.spawnTime;

        if (aliveTime >= 900000) {
            unlockAchievement(
                client.dbId,
                'survivor',
                client.ws
            );
        }
    }
}
    }

    // Target selection for a player's drones while in autopilot. Mirrors the bot
    // AI's targeting (enemy drones > enemy tanks > shapes), minus powerups.
    findDroneAutopilotTarget() {
        const nearby = this.room.grid.getNearby(this.x, this.y, 1000);
        let droneTarget = null, minDroneDistSq = Infinity;
        let enemyTarget = null, minEnemyDistSq = Infinity;
        let shapeTarget = null, minShapeDistSq = Infinity;
        const tdm = this.room.mode.includes("TDM");

        nearby.drones.forEach(d => {
            if (d.owner === this || d.markedForDeletion) return;
            if (isInProtectedBase(this.room, d, this.team)) return;
            if (tdm && d.team === this.team && d.team !== 0) return;
            const distSq = (this.x - d.x)**2 + (this.y - d.y)**2;
            if (distSq < 90000 && distSq < minDroneDistSq) { minDroneDistSq = distSq; droneTarget = d; }
        });

        nearby.entities.forEach(e => {
            if (e === this || e.markedForDeletion) return;
            const isTank = ['tank', 'ai'].includes(e.type);
            const isShape = ['square','triangle','pentagon','hexagon'].includes(e.type);
            const isSameTeam = tdm && e.team === this.team && e.team !== 0;
            const distSq = (this.x - e.x)**2 + (this.y - e.y)**2;

            if (isTank) {
                if (isSameTeam) return;
                if (isInProtectedBase(this.room, e, this.team)) return;
                if (e.tankType === 'Manager' && e.opacity < 0.15) return;
                let detectionDist = 300 + (Math.min(e.score, 17000) / 17000) * 700;
                if (this.tankType === 'Overlord') detectionDist *= 1.2;
                if (distSq < detectionDist * detectionDist && distSq < minEnemyDistSq) {
                    minEnemyDistSq = distSq; enemyTarget = e;
                }
            } else if (isShape) {
                if (this.tankType === 'Overlord') return; // bot Overlords ignore shapes
                if (isInEnemyBase(this.room, e, this.team)) return;
                if (distSq < minShapeDistSq) { minShapeDistSq = distSq; shapeTarget = e; }
            }
        });

        let target = droneTarget || enemyTarget || shapeTarget;
        if (droneTarget && enemyTarget && minEnemyDistSq < 200 * 200) target = enemyTarget;
        return target;
    }

    update() {
        this.vx *= 0.85; this.vy *= 0.85;
        this.x += this.vx; this.y += this.vy;
        const arenaExtent = this.room.mode === 'WORLD' ? (this.room.worldExtent || WORLD_SIZE) : WORLD_SIZE;
        this.x = Math.max(0, Math.min(arenaExtent, this.x));
        this.y = Math.max(0, Math.min(arenaExtent, this.y));
        // World mode: solid buildings/trees/benches/walls/cars for tanks on foot, car physics when driving.
        if (this.room.worldKind && this.isPlayer) {
            if (this.vehicle) worldStepVehicle(this); else worldCollideEntity(this);
            if (this.room.worldKind !== 'interior') { this.x = Math.max(W_SHORE, Math.min(W_EXT - W_SHORE, this.x)); this.y = Math.max(W_SHORE, Math.min(W_EXT - W_SHORE, this.y)); }
        }
        const now = Date.now();

if (this.maxHealthPowerupActive &&
    this.powerups.maxHealth <= now) {

    this.maxHealthPowerupActive = false;

    if (this.baseMaxHpBeforePowerup !== null) {
        this.maxHp = this.baseMaxHpBeforePowerup;
        this.baseMaxHpBeforePowerup = null;
    }

    this.hp = Math.min(this.hp, this.getEffectiveMaxHp());
}
        if (this.tankType === 'Necromancer') {
            let nearby = this.room.grid.getNearby(this.x, this.y, this.radius + 60);
            nearby.entities.forEach(e => {
                let droneCount = 22+(this.stats[6]*2)
                if (e.type === 'square' && !e.markedForDeletion && this.activeDrones < droneCount) {
                    let dx = e.x - this.x, dy = e.y - this.y;
                    let radSum = this.radius + e.radius + 50;
                    if (dx*dx + dy*dy < radSum*radSum) {
                        e.markedForDeletion = true;
                        this.room.drones.push(new Drone(this.room, e.x, e.y, this));
                        if (typeof this.addXP === 'function' && !e.noReward) this.addXP(e.xpVal || 60);
                    }
                }
            });
        }
        const specs = TANK_SPECS[this.tankType];
        if (!this.barrelTimers || this.barrelTimers.length !== (specs?.barrels?.length || 0)) {
            this.barrelTimers = new Array(specs?.barrels?.length || 0).fill(0);
        }
        for(let i=0; i<this.barrelTimers.length; i++) {
            if(this.barrelTimers[i] > 0) this.barrelTimers[i]--;
        }
        let effectiveMaxHp = this.getEffectiveMaxHp();

if (this.hp < effectiveMaxHp) {
    let timeSinceDamage = Date.now() - this.lastDamageTime;

    if (timeSinceDamage >= 30000) {
        this.hp += effectiveMaxHp * 0.05;
    } else {
        // Existing tank regen.
        this.hp += 0.1 * (1 + this.stats[0] * 1);
    }

    // +10% max HP/sec from the powerup.
    // This stacks on top of the tank's existing regen.
    if (this.getPowerupActive('healthRegen')) {
        this.hp += effectiveMaxHp * 0.10 / TICK_RATE;
    }

    if (this.hp > effectiveMaxHp) {
        this.hp = effectiveMaxHp;
    }
}
        let moveSpeed =
    (0.5 * 0.998 + (this.stats[7] * (0.04 * 0.995))) *
    this.getPowerupMoveMultiplier();
        let isShooting = false;
        const effectiveMaxHpForFlee = this.maxHp + (this.stats[1] * 20);
        if(this.isPlayer) {
            let inputX = 0; let inputY = 0;
            if(this.inputs.left) inputX -= 1;
            if(this.inputs.right) inputX += 1;
            if(this.inputs.up) inputY -= 1;
            if(this.inputs.down) inputY += 1;
            if ((inputX !== 0 || inputY !== 0) && !this.vehicle) {
                let length = Math.sqrt(inputX * inputX + inputY * inputY);
                this.vx += (inputX / length) * moveSpeed;
                this.vy += (inputY / length) * moveSpeed;
            }
            this.angle = this.inputs.angle;
            if(this.inputs.shooting) isShooting = true;

            // Drone-class autopilot: while the player is NOT firing (and not repelling),
            // keep spawning drones and let the drones run the same AI as bot Overlords.
            // As soon as the player fires or repels again, manual control resumes.
            if (specs && specs.isDroneSpawner) {
                const manual = !!(this.inputs.shooting || this.inputs.repel);
                this.droneAutopilot = !manual;
                if (this.droneAutopilot) {
                    isShooting = true; // keep spawning drones
                    this.isFleeing = false;
                    this.thinkTimer++;
                    if (this.thinkTimer >= 9) {
                        this.thinkTimer = 0;
                        this.aiTarget = this.findDroneAutopilotTarget();
                    }
                    if (this.aiTarget && this.aiTarget.markedForDeletion) this.aiTarget = null;
                } else {
                    this.aiTarget = null;
                }
            } else {
                this.droneAutopilot = false;
            }

        } else if(this.type === 'ai') {
            this.thinkTimer++;
            if (this.thinkTimer >= 9) {
                this.thinkTimer = 0;
                this.evadeVx = 0; this.evadeVy = 0; 
                let evadeCount = 0;
                
                let nearby = this.room.grid.getNearby(this.x, this.y, 600);

                nearby.bullets.forEach(b => {
                    if (b.owner === this || b.life <= 0) return;
                    let isSameTeam = this.room.mode.includes("TDM") && b.team === this.team && b.team !== 0;
                    if (isSameTeam) return;
                    let dx = b.x - this.x, dy = b.y - this.y;
                    if (dx*dx + dy*dy < 62500) { 
                        let d = Math.sqrt(dx*dx + dy*dy);
                        let dot = (b.vx * dx + b.vy * dy);
                        if (dot < 0 && d > 0) {
                            this.evadeVx += (-dy/d) * moveSpeed;
                            this.evadeVy += (dx/d) * moveSpeed;
                            evadeCount++;
                        }
                    }
                });

                if (evadeCount > 0) {
                    this.evadeVx /= evadeCount;
                    this.evadeVy /= evadeCount;
                }

                let enemyTarget = null; let minEnemyDistSq = Infinity;
                let shapeTarget = null; let minShapeDistSq = Infinity;
                let droneTarget = null; let minDroneDistSq = Infinity;
                let powerupTarget = null; let minPowerupDistSq = Infinity;

                nearby.drones.forEach(d => {
                    if (d.owner === this || d.markedForDeletion) return;
                    if (isInProtectedBase(this.room, d, this.team)) return;
                    let isSameTeam = this.room.mode.includes("TDM") && d.team === this.team && d.team !== 0;
                    if (isSameTeam) return;
                    let distSq = (this.x - d.x)**2 + (this.y - d.y)**2;
                    if (distSq < 90000 && distSq < minDroneDistSq) { minDroneDistSq = distSq; droneTarget = d; } 
                });

                nearby.entities.forEach(e => {
                    if(e === this || e.markedForDeletion) return;
                    let isTank = ['tank', 'ai'].includes(e.type);
                    let isSameTeam = this.room.mode.includes("TDM") && e.team === this.team && e.team !== 0;
                    let isShape = ['square','triangle','pentagon','hexagon'].includes(e.type);
                    let isPowerup = e.type === 'powerup';
                    if (isSameTeam && !isShape && !isPowerup) return;

                    let distSq = (this.x - e.x)**2 + (this.y - e.y)**2;

                    if (!isShape && !isPowerup && !isSameTeam && isTank) {
                        if (isInProtectedBase(this.room, e, this.team)) return;
                        // Invisible Manager tanks are undetectable by AI
                        if (e.tankType === 'Manager' && e.opacity < 0.15) return;
                        let detectionDist = 300 + (Math.min(e.score, 17000) / 17000) * 700;
                        if (this.tankType === 'Overlord') detectionDist *= 1.2;
                        let detectionSq = detectionDist * detectionDist;
                        
                        if(distSq < detectionSq && distSq < minEnemyDistSq) { 
                            minEnemyDistSq = distSq; 
                            enemyTarget = e; 
                        }
                    } else if (isPowerup) {
                        // Skip powerups inside enemy bases for the same reason shapes are skipped.
                        if (isInEnemyBase(this.room, e, this.team)) return;
                        if(distSq < minPowerupDistSq) {
                            minPowerupDistSq = distSq;
                            powerupTarget = e;
                        }
                    } else if (isShape) {
                        if (this.tankType === 'Overlord') return;
                        // Skip shapes inside enemy bases — the AI can't enter those zones
                        // and will get stuck. Own base is allowed since bots can walk there.
                        if (isInEnemyBase(this.room, e, this.team)) return;
                        if(distSq < minShapeDistSq) { 
                            minShapeDistSq = distSq; 
                            shapeTarget = e; 
                        }
                    }
                });

                // Powerups are valuable but shouldn't distract a bot from a close,
                // actively dangerous enemy — same threat override used for drones below.
                this.aiTarget = droneTarget || enemyTarget || powerupTarget || shapeTarget;
                if (powerupTarget && enemyTarget) {
                    const closeThreatDistSq = 200 * 200;
                    if (minEnemyDistSq < closeThreatDistSq) {
                        this.aiTarget = enemyTarget;
                    }
                }
                // If a drone is the primary target but an enemy tank is dangerously close
                // and actively shooting at us, switch to the enemy instead.
                if (droneTarget && enemyTarget) {
                    const closeThreatDistSq = 200 * 200;
                    if (minEnemyDistSq < closeThreatDistSq) {
                        this.aiTarget = enemyTarget;
                    }
                }
                this.targetId = this.aiTarget ? (this.aiTarget.id || null) : null;
                
                this.isFleeing = (this.hp / effectiveMaxHpForFlee) < 0.25;

                // Separation: push away from other nearby tanks/bots so idle AI
                // doesn't stack on top of each other while wandering/gathering.
                let sepX = 0, sepY = 0, sepCount = 0;
                const SEP_RADIUS = 220;
                const SEP_RADIUS_SQ = SEP_RADIUS * SEP_RADIUS;
                nearby.entities.forEach(e => {
                    if (e === this || e.markedForDeletion) return;
                    if (!['ai', 'tank'].includes(e.type)) return;
                    let dx = this.x - e.x, dy = this.y - e.y;
                    let distSq = dx * dx + dy * dy;
                    if (distSq < SEP_RADIUS_SQ && distSq > 0) {
                        let dist = Math.sqrt(distSq);
                        sepX += (dx / dist) * (1 - dist / SEP_RADIUS);
                        sepY += (dy / dist) * (1 - dist / SEP_RADIUS);
                        sepCount++;
                    }
                });
                this.flockSeparationX = sepCount > 0 ? sepX / sepCount : 0;
                this.flockSeparationY = sepCount > 0 ? sepY / sepCount : 0;
            }
            this.vx += this.evadeVx;
            this.vy += this.evadeVy;
            let target = this.aiTarget;
            if (target && target.markedForDeletion) {
                target = null;
                this.aiTarget = null;
            }
            const isDestroyer = this.tankType === 'Destroyer';
            if(target) {
                let isDrone = target.owner !== undefined;
                let predX = target.x;
                let predY = target.y;
                if (!isDrone) {
                    let dx = target.x - this.x;
                    let dy = target.y - this.y;
                    let dTargetSq = dx*dx + dy*dy;
                    let dTarget = Math.sqrt(dTargetSq);
                    let bSpd = ((6 * 0.998) + (this.stats[3] * (0.4 * 0.995))) * (TANK_SPECS[this.tankType].barrels[0]?.spd || 1);
                    let timeToHit = dTarget / (bSpd || 1);
                    predX += (target.vx || 0) * timeToHit;
                    predY += (target.vy || 0) * timeToHit;
                }              
                if (isDestroyer) {

    let dx = target.x - this.x;
    let dy = target.y - this.y;
    let dist = Math.sqrt(dx * dx + dy * dy);

    this.angle = Math.atan2(predY - this.y, predX - this.x);

    // Low HP = disengage
    if (this.hp < effectiveMaxHpForFlee * 0.45) {

        this.vx -= Math.cos(this.angle) * moveSpeed * 1.8;
        this.vy -= Math.sin(this.angle) * moveSpeed * 1.8;

        // occasional defensive shots
        if (dist < 300) {
            isShooting = true;
        }

        return;
    }

    // Ambush spacing
    const preferredDist = 320;

    if (dist > preferredDist + 40) {
        this.vx += Math.cos(this.angle) * moveSpeed * 0.9;
        this.vy += Math.sin(this.angle) * moveSpeed * 0.9;
    }

    if (dist < preferredDist - 40) {
        this.vx -= Math.cos(this.angle) * moveSpeed * 1.3;
        this.vy -= Math.sin(this.angle) * moveSpeed * 1.3;
    }

    // Only fire when aim is lined up
    let aimError = Math.abs(
        Math.atan2(
            Math.sin(this.angle - Math.atan2(dy, dx)),
            Math.cos(this.angle - Math.atan2(dy, dx))
        )
    );

    // Check both conditions to fire, otherwise stop firing
isShooting = (aimError < 0.25 && dist < 1050);

    return;
}
                if (this.isFleeing && !target.isShape) {
                    this.angle = Math.atan2(predY - this.y, predX - this.x);
                    isShooting = true;
                    this.vx -= Math.cos(this.angle) * moveSpeed;
                    this.vy -= Math.sin(this.angle) * moveSpeed;
                } else {
                    this.angle = Math.atan2(predY - this.y, predX - this.x);
                    isShooting = true;

                    if (isDrone && target.owner) {
                        let evadeAngle = Math.atan2(target.owner.y - this.y, target.owner.x - this.x);
                        this.vx -= Math.cos(evadeAngle) * moveSpeed;
                        this.vy -= Math.sin(evadeAngle) * moveSpeed;
                    } else {
                        let keepDist = this.tankType === 'Overlord' ? 450 : (this.tankType === 'Sniper' ? 300 : (target.isShape ? 50 : 150));
                        let dx = target.x - this.x;
                        let dy = target.y - this.y;
                        let distSq = dx*dx + dy*dy;
                        let keepDistSq = keepDist * keepDist;
                        if(distSq > keepDistSq) {
                            this.vx += Math.cos(this.angle) * moveSpeed;
                            this.vy += Math.sin(this.angle) * moveSpeed;
                        } else if (distSq < (keepDist - 50) * (keepDist - 50)) {
                            this.vx -= Math.cos(this.angle) * moveSpeed;
                            this.vy -= Math.sin(this.angle) * moveSpeed;
                        }
                    }
                }
            } else {
                const safeZone = getSafeZone(this.room, this.team);

let distFromSafeSq =
    (this.x - safeZone.x) ** 2 +
    (this.y - safeZone.y) ** 2;

const tooDeep = distFromSafeSq > 1800 * 1800;

if (tooDeep) {
    let retreatAngle = Math.atan2(
        safeZone.y - this.y,
        safeZone.x - this.x
    );

    this.angle = retreatAngle;

    this.vx += Math.cos(retreatAngle) * moveSpeed * 1.4;
    this.vy += Math.sin(retreatAngle) * moveSpeed * 1.4;

    return;
}
                // For TDM modes, bots should flee/wander toward their own base corner,
                // not the world center which may sit inside enemy territory.
                //
                // For FFA (and any other non-TDM mode), bots used to always default to
                // the exact world-center coordinate here. Since every idle bot shared
                // that same destination, they'd all steer toward it and gather in one
                // clump in the middle of the map. Each bot now patrols around its own
                // wanderAnchor point instead, which is re-rolled to a new random spot
                // every ~10-25s so bots keep circulating the whole map rather than
                // funneling into the center.
                let wanderX = this.wanderAnchorX;
                let wanderY = this.wanderAnchorY;
                if (this.room.mode === "2TDM" && this.team !== 0) {
                    // Wander point placed at 62% across the map toward the enemy side
                    wanderX = this.team === 1 ? WORLD_SIZE * 0.62 : WORLD_SIZE * 0.38;
                    wanderY = WORLD_SIZE / 2;
                } else if (this.room.mode === "4TDM" && this.team !== 0) {
                    // Push wander well past the halfway mark into the opposing quadrant
                    wanderX = (this.team === 1 || this.team === 4) ? WORLD_SIZE * 0.65 : WORLD_SIZE * 0.35;
                    wanderY = (this.team === 1 || this.team === 3) ? WORLD_SIZE * 0.65 : WORLD_SIZE * 0.35;
                } else {
                    // FFA / no-team bots: periodically re-roll the anchor so patrol
                    // routes drift across the whole map over time.
                    this.wanderAnchorTimer--;
                    if (this.wanderAnchorTimer <= 0) {
                        this.wanderAnchorX = Math.random() * WORLD_SIZE;
                        this.wanderAnchorY = Math.random() * WORLD_SIZE;
                        this.wanderAnchorTimer = 600 + Math.floor(Math.random() * 900);
                        wanderX = this.wanderAnchorX;
                        wanderY = this.wanderAnchorY;
                    }
                }

                if (this.isFleeing) {
                    // When low HP and no target in sight, flee back toward own base to recover
                    let fleeAngle = Math.atan2(wanderY - this.y, wanderX - this.x);
                    let angleDiff = fleeAngle - this.angle;
                    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                    this.angle += angleDiff * 0.08;
                    this.vx += Math.cos(this.angle) * moveSpeed;
                    this.vy += Math.sin(this.angle) * moveSpeed;
                } else {
                    let centerX = wanderX;
                    let centerY = wanderY;
                    let distToCenterSq = (this.x - centerX)**2 + (this.y - centerY)**2;
                    
                    if (distToCenterSq > 2250000) { // ~1500px radius before snapping back
                        let centerAngle = Math.atan2(centerY - this.y, centerX - this.x);
                        let angleDiff = centerAngle - this.angle;
                        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                        this.angle += angleDiff * 0.05; 
                    } else if(this.thinkTimer === 0 && Math.random() < 0.2) {
                        this.angle += (Math.random() - 0.5);
                    }
                    
                    this.vx += Math.cos(this.angle) * moveSpeed;
                    this.vy += Math.sin(this.angle) * moveSpeed;

                    // Nudge away from other bots clumped nearby while wandering.
                    this.vx += this.flockSeparationX * moveSpeed * 0.8;
                    this.vy += this.flockSeparationY * moveSpeed * 0.8;

                    if (Math.random() < 0.03) {
                        isShooting = true;
                    }
                }
            }
            
            if (this.thinkTimer === 0) {
                if (this.level >= 15 && this.tankType === 'Basic' && this.type === 'ai') {
                    if (Math.random() > 0.20) { 
                        const choices = ['Twin', 'Sniper', 'Machine Gun', 'Flank Guard']; 
                        this.tankType = choices[Math.floor(Math.random() * choices.length)];
                    }
                } else if (this.level >= 30) {
                    if (Math.random() > 0.10) { 
                        let opts = [];
                        if (this.tankType === 'Sniper') opts = [Math.random() < 0.30 ? 'Sniper' : (Math.random() < 0.5 ? 'Overlord' : 'Predator')];
                        else if (this.tankType === 'Twin') opts = ['Octo Tank', 'Triplet', 'Twin Flank', 'Pentashot'];
                        else if (this.tankType === 'Flank Guard') opts = ['Tri-angle', 'Octo Tank', 'Twin Flank'];
                        else if (this.tankType === 'Machine Gun') opts = ['Destroyer', 'Sprayer', 'Railgun'];
                        
                        if (opts.length > 0) {
                            this.tankType = opts[Math.floor(Math.random() * opts.length)];
                        }
                    }
                }
            }
        }

        // ── Manager invisibility ──────────────────────────────────────────────
        if (this.tankType === 'Manager') {
            const speedSq = this.vx * this.vx + this.vy * this.vy;
            const STILL_THRESHOLD = 0.04; // speed² below which we count as still
            const FADE_TICKS = 180;       // ~3 s at 60 fps to reach full invisibility
            const APPEAR_TICKS = 20;      // ~0.33 s to snap back when moving
            if (speedSq < STILL_THRESHOLD) {
                this.stillTicks = Math.min(this.stillTicks + 1, FADE_TICKS);
                this.opacity = Math.max(0, 1 - (this.stillTicks / FADE_TICKS));
            } else {
                this.stillTicks = 0;
                this.opacity = Math.min(1, this.opacity + (1 / APPEAR_TICKS));
            }
        } else {
            this.opacity = 1;
            this.stillTicks = 0;
        }

        const baseReload =
    Math.max(
        5,
        ((30 * 1.002) - (this.stats[6] * (3 * 0.995)))
    ) * this.getPowerupReloadMultiplier();

        if (this.vehicle || (this.room && this.room.noCombat)) isShooting = false;   // no shooting from a car or indoors
        if (isShooting && !this.wasShooting) {
            specs.barrels.forEach((b, i) => {
                if (this.barrelTimers[i] <= 0) {
                    this.barrelTimers[i] = (baseReload * (b.rel || 1)) * (b.delay || 0);
                }
            });
        }
        
        if (isShooting) shoot(this);
        this.wasShooting = isShooting;
        
        if(this.type === 'ai' && this.statPoints > 0){
            const bulletStats = [3,4,5,6];
            const otherStats = [0,1,2,7]; 
            let pool = [];
            bulletStats.forEach(s=>{ if(this.stats[s] < 7) for(let i=0;i<3;i++) pool.push(s); });
            otherStats.forEach(s=>{ if(this.stats[s] < 7) pool.push(s); });

            if(pool.length){
                let choice = pool[Math.floor(Math.random()*pool.length)];
                this.stats[choice]++;
                this.statPoints--;
            }
        }
    }
}
// Grants the effect of a picked-up powerup to `entity`.
// Handles the generic timed-multiplier powerups plus the special-cased
// maxHealth powerup (which needs to bump maxHp for its duration and
// cleanly revert it afterwards - see Entity#update()).
function applyPowerupEffect(entity, powerupType) {
    if (!entity || !entity.powerups) return;

    const expiry = Date.now() + POWERUP_DURATION;

    if (powerupType === 'maxHealth') {
        if (!entity.maxHealthPowerupActive) {
            entity.baseMaxHpBeforePowerup = entity.maxHp;
        }
        entity.maxHealthPowerupActive = true;
        entity.maxHp = Math.round(entity.baseMaxHpBeforePowerup * MAX_HEALTH_POWERUP_MULTIPLIER);
    }

    entity.powerups[powerupType] = expiry;

    // Every pickup also heals for a fixed amount, capped at the entity's
    // current effective max HP.
    const effectiveMaxHp = typeof entity.getEffectiveMaxHp === 'function'
        ? entity.getEffectiveMaxHp()
        : entity.maxHp;
    entity.hp = Math.min(entity.hp + POWERUP_HEAL_AMOUNT, effectiveMaxHp);
}

function getActivePowerups(entity) {
    if (!entity.powerups) return {};

    const now = Date.now();
    const result = {};

    for (const [type, expiry] of Object.entries(entity.powerups)) {
        if (expiry > now) {
            result[type] = expiry - now;
        }
    }

    return result;
}
class Drone {
    constructor(room, x, y, owner) {
        this.room = room;
        this.id = room.nextDroneId++;
        this.x = x; this.y = y; this.owner = owner;
        this.vx = 0; this.vy = 0;
        this.team = owner.team; this.angle = 0;
        this.markedForDeletion = false;
        
        if (owner.tankType === 'Necromancer') {
            this.hp = (15 + (owner.stats[4] * 5)) * 2;
            this.dmg = 12 + (owner.stats[5] * 3); 
            this.radius = 15;
            this.isNecroSquare = true;
        } else {
            this.radius = 12;
            this.hp = (20 + (owner.stats[4] * 5)) * 2.5;
            this.dmg = 15 + (owner.stats[5] * 5);
        }
        
        owner.activeDrones++;
    }

    update() {
        if (!this.owner || this.owner.hp <= 0 || this.owner.markedForDeletion) {
            this.markedForDeletion = true;
            return;
        }

        let speed = 4 + (this.owner.stats[3] * 0.5);
        if (this.owner.tankType === 'Necromancer') speed *= 0.93;

        let tx = this.x, ty = this.y, moving = false;

        if (this.owner.isPlayer && !this.owner.droneAutopilot) {
            tx = this.owner.inputs.mouseX; ty = this.owner.inputs.mouseY;
            moving = true;
            if(this.owner.inputs.repel) {
                let ang = Math.atan2(this.y - ty, this.x - tx);
                tx = this.x + Math.cos(ang) * 500; ty = this.y + Math.sin(ang) * 500;
            }
        } else {
            let target = null;
            
            if (this.owner.aiTarget && !this.owner.aiTarget.markedForDeletion) {
                let distSq = (this.owner.x - this.owner.aiTarget.x)**2 + (this.owner.y - this.owner.aiTarget.y)**2;
                
                if (this.owner.isFleeing) {
                    let ang = Math.atan2(this.y - this.owner.y, this.x - this.owner.x);
                    tx = this.x + Math.cos(ang) * 500; 
                    ty = this.y + Math.sin(ang) * 500; 
                    moving = true;
                } 
                else if (['Overlord', 'Necromancer'].includes(this.owner.tankType) && distSq > 360000 && distSq <= 1000000) {
                    let angToTarget = Math.atan2(this.owner.aiTarget.y - this.y, this.owner.aiTarget.x - this.x);
                    tx = this.x + Math.cos(angToTarget) * 800; 
                    ty = this.y + Math.sin(angToTarget) * 800; 
                    moving = true;
                } else {
                    target = this.owner.aiTarget;
                }
            } else {
                // No owner target — keep drones leashed close to owner
                const isOverlordType = ['Overlord', 'Necromancer'].includes(this.owner.tankType);
                const leashRadius = isOverlordType ? 300 : 1000;
                const droneDx = this.x - this.owner.x;
                const droneDy = this.y - this.owner.y;
                const droneDistSq = droneDx * droneDx + droneDy * droneDy;

                if (isOverlordType) {
                    // Overlord idle: orbit/stay close to owner, don't wander the map
                    if (droneDistSq > leashRadius * leashRadius) {
                        // Pull back to owner
                        tx = this.owner.x;
                        ty = this.owner.y;
                        moving = true;
                    } else {
                        // Stay orbiting near owner
                        tx = this.owner.x + Math.cos(this.owner.angle) * 180;
                        ty = this.owner.y + Math.sin(this.owner.angle) * 180;
                        moving = true;
                    }
                } else {
                    let minDistSq = Infinity;
                    // Non-overlord: only search within leash radius of OWNER, not drone
                    let nearby = this.room.grid.getNearby(this.owner.x, this.owner.y, leashRadius); 
                    nearby.entities.forEach(e => {
                        if(e === this.owner || e.markedForDeletion) return;
                        if(this.room.mode.includes("TDM") && e.team === this.owner.team && ['ai','tank'].includes(e.type)) return;
                        
                        let distSq = (this.owner.x - e.x)**2 + (this.owner.y - e.y)**2;
                        if(distSq < leashRadius * leashRadius && distSq < minDistSq) { minDistSq = distSq; target = e; }
                    });

                    if (!target) {
                        tx = this.owner.x + Math.cos(this.owner.angle) * 180;
                        ty = this.owner.y + Math.sin(this.owner.angle) * 180;
                        moving = true;
                    }
                }
            }

            if(target) { 
                tx = target.x; ty = target.y; moving = true; 
            }
        }

        if (moving) {
            let angle = Math.atan2(ty - this.y, tx - this.x);
            this.angle = angle;
            this.vx *= 0.80; 
            this.vy *= 0.80;
            this.vx += Math.cos(angle) * (speed * 0.4);
            this.vy += Math.sin(angle) * (speed * 0.4);
        }

        let curSpeedSq = this.vx*this.vx + this.vy*this.vy;
        if(curSpeedSq > speed*speed) {
            let curSpeed = Math.sqrt(curSpeedSq);
            this.vx = (this.vx / curSpeed) * speed;
            this.vy = (this.vy / curSpeed) * speed;
        }

        this.x += this.vx; this.y += this.vy;

        let nearbyDrones = this.room.grid.getNearby(this.x, this.y, this.radius * 2);
        nearbyDrones.drones.forEach(d => {
            if(d !== this && !d.markedForDeletion) {
                let dx = this.x - d.x, dy = this.y - d.y;
                let radSum = this.radius + d.radius;
                let distSq = dx*dx + dy*dy;
                
                if(distSq < radSum*radSum) {
                    let dist = Math.sqrt(distSq) || 1;
                    let overlap = radSum - dist;
                    let pushAngle = Math.atan2(dy, dx);
                    
                    let pushForce = (this.owner && this.owner.tankType === 'Necromancer') ? overlap * 0.4 : overlap * 0.2; 
                    
                    this.x += Math.cos(pushAngle) * pushForce; 
                    this.y += Math.sin(pushAngle) * pushForce;
                }
            }
        });
    }
}

// ===================== ROOMS =====================

const rooms = {
    "FFA-S1": new Room("FFA-S1", "FFA",loadLobbyConfig('FFA-S1')),
    "2TDM-S1": new Room("2TDM-S1", "2TDM",loadLobbyConfig('2TDM-S1')),
    "4TDM-S1": new Room("4TDM-S1", "4TDM",loadLobbyConfig('4TDM-S1')),
};

// WORLD is a real arena Room: the same Entity, input, firing, collision,
// projectile, XP and broadcast loops process its players and shape targets.
const WORLD_TILE = 420, WORLD_GRID = 120, WORLD_EXTENT = WORLD_TILE * WORLD_GRID;
const worldRoom = new Room('WORLD', 'WORLD', { shapeCount: 0, botCount: 0, shapeRespawn: false });
worldRoom.worldExtent = WORLD_EXTENT;
worldRoom.grid = new SpatialGrid(WORLD_EXTENT, 500);
rooms.WORLD = worldRoom;
worldRoom.worldKind = 'exterior';
// Interiors (houses / workplaces) are private Rooms created on demand; they are kept out of `rooms`
// so they never show up in server lists / admin APIs.
const interiorRooms = {};
function allRooms() { return Object.values(rooms).concat(Object.values(interiorRooms)); }

// ===================== GAME LOGIC =====================

function shoot(who) {
    if(who.markedForDeletion) return;
    const specs = TANK_SPECS[who.tankType];
    const room = who.room;

    if (!who.barrelTimers || who.barrelTimers.length !== specs.barrels.length) {
        who.barrelTimers = new Array(specs.barrels.length).fill(0);
    }

    let baseReload = Math.max(5, ((30 * 1.002) - (who.stats[6] * (3 * 0.995))));
    let baseSpeed =
    ((6 * 0.998) + (who.stats[3] * (0.4 * 0.995))) *
    who.getPowerupBulletSpeedMultiplier();

let baseDmg =
    (8 + (who.stats[5] * 3)) *
    who.getPowerupDamageMultiplier();
    let basePen = 1 + (who.stats[4]*0.5);
    if (who.tankType === 'Destroyer') {
        basePen *= 10;
    }
    if(specs.isDroneSpawner) {
        specs.barrels.forEach((b, i) => {
            if (who.barrelTimers[i] <= 0 && who.activeDrones < specs.maxDrones) {
                room.drones.push(new Drone(room, who.x, who.y, who));
                who.barrelTimers[i] = Math.max(10, baseReload * (b.rel || 1));
            }
        });
        return;
    }

    specs.barrels.forEach((b, i) => {
        if (who.barrelTimers[i] <= 0) {
            let bSpeed = baseSpeed * (b.spd || 1);
            let bDmg = baseDmg * (b.dmg || 1);
            let spreadAngle = (Math.random() - 0.5) * (b.spread || 0);
            let finalAngle = who.angle + (b.angle || 0) + spreadAngle;
            let bx = who.x + Math.cos(who.angle + (b.angle || 0)) * (b.l || 1.8) * who.radius - Math.sin(who.angle) * (b.y || 0);
            let by = who.y + Math.sin(who.angle + (b.angle || 0)) * (b.l || 1.8) * who.radius + Math.cos(who.angle) * (b.y || 0);

            let recoilMult = b.recoilMult || 1;
            let recoilForce = (1.5 + bDmg * 0.05) * (b.dmg || 1) * recoilMult;
            
            who.vx -= Math.cos(finalAngle) * recoilForce * 0.25;
            who.vy -= Math.sin(finalAngle) * recoilForce * 0.25;

            let bulletSize = (8 + (who.stats[5]*0.5)) * (b.size || 1);

            const powerupEffects = [];

if (who.getPowerupActive('damage')) {
    powerupEffects.push('damage');
}

if (who.getPowerupActive('bulletSpeed')) {
    powerupEffects.push('bulletSpeed');
}

room.bullets.push({
    id: room.nextBulletId++,
    x: bx,
    y: by,
    vx: Math.cos(finalAngle) * bSpeed,
    vy: Math.sin(finalAngle) * bSpeed,
    r: bulletSize,
    life: 100 * (1 + who.stats[3] * 0.1),
    dmg: bDmg,
    pen: basePen,
    owner: who,
    team: who.team,
    powerupEffects
});

            who.barrelTimers[i] = Math.max(5, baseReload * (b.rel || 1));
        }
    });
}

function updateForceField(player) {
    if (!player.getPowerupActive('forceField')) return;

    const AURA_RADIUS = 100;
    const AURA_DAMAGE = 2;

    const nearby = player.room.grid.getNearby(
        player.x,
        player.y,
        AURA_RADIUS
    );

    // Entities: players, bots, shapes.
    nearby.entities.forEach(target => {
        if (
            target === player ||
            target.markedForDeletion ||
            target.type === 'powerup'
        ) return;

        // Don't damage teammates in TDM.
        if (
            player.room.mode.includes("TDM") &&
            target.team === player.team &&
            target.team !== 0
        ) return;

        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const distSq = dx * dx + dy * dy;
        const radius = AURA_RADIUS + target.radius;

        if (distSq <= radius * radius) {
            const damage =
                AURA_DAMAGE *
                player.getPowerupDamageMultiplier();

            target.hp -= damage;
            target.lastDamageTime = Date.now();
            target.lastDamagedBy = player.id;

            if (target.hp <= 0) {
                target.xpAwarded = target.xpAwarded || false;

                if (
                    !target.xpAwarded &&
                    typeof player.addXP === 'function'
                ) {
                    target.xpAwarded = true;
                    player.addXP(
                        Math.min(
                            target.xpVal || 100,
                            24700
                        )
                    );
                }
            }
        }
    });

    // Bullets.
    nearby.bullets.forEach(bullet => {
        if (bullet.life <= 0 || bullet.owner === player) return;

        if (
            player.room.mode.includes("TDM") &&
            bullet.team === player.team &&
            bullet.team !== 0
        ) return;

        const dx = bullet.x - player.x;
        const dy = bullet.y - player.y;

        if (dx * dx + dy * dy <= AURA_RADIUS * AURA_RADIUS) {
            bullet.life = 0;
        }
    });

    // Drones.
    nearby.drones.forEach(drone => {
        if (
            drone.markedForDeletion ||
            drone.owner === player
        ) return;

        if (
            player.room.mode.includes("TDM") &&
            drone.team === player.team &&
            drone.team !== 0
        ) return;

        const dx = drone.x - player.x;
        const dy = drone.y - player.y;

        if (dx * dx + dy * dy <= AURA_RADIUS * AURA_RADIUS) {
            drone.hp -= AURA_DAMAGE;

            if (drone.hp <= 0) {
                drone.markedForDeletion = true;
            }
        }
    });
}
function updateRoom(room) {
    if (room.status === 'stopped') return;
    const BASE_SIZE_4 = 600;
    const BASE_WIDTH_2 = 400; 
    const PROX = 350; 
    const REPEL_FORCE = 2.5; 

    function applyRepel(obj) {
        let team = obj.team || 0;
        let FAN_FORCE = 0.8;
        let MAX_PUSH = 15;

        if (room.mode === "2TDM" && team !== 0) {
            if (team !== 1 && obj.x < BASE_WIDTH_2 + PROX) { 
                obj.vx += FAN_FORCE; if (obj.vx > MAX_PUSH) obj.vx = MAX_PUSH; 
            }
            if (team !== 2 && obj.x > WORLD_SIZE - BASE_WIDTH_2 - PROX) { 
                obj.vx -= FAN_FORCE; if (obj.vx < -MAX_PUSH) obj.vx = -MAX_PUSH; 
            }
        } else if (room.mode === "4TDM" && team !== 0) {
            MAX_PUSH = 10;
            let inTL = (obj.x < BASE_SIZE_4 + PROX && obj.y < BASE_SIZE_4 + PROX);
            let inTR = (obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX && obj.y < BASE_SIZE_4 + PROX);
            let inBL = (obj.x < BASE_SIZE_4 + PROX && obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX);
            let inBR = (obj.x > WORLD_SIZE - BASE_SIZE_4 - PROX && obj.y > WORLD_SIZE - BASE_SIZE_4 - PROX);

            if (team !== 1 && inTL) { 
                obj.vx += FAN_FORCE; obj.vy += FAN_FORCE; 
                if (obj.vx > MAX_PUSH) obj.vx = MAX_PUSH; if (obj.vy > MAX_PUSH) obj.vy = MAX_PUSH; 
            }
            if (team !== 3 && inTR) { 
                obj.vx -= FAN_FORCE; obj.vy += FAN_FORCE; 
                if (obj.vx < -MAX_PUSH) obj.vx = -MAX_PUSH; if (obj.vy > MAX_PUSH) obj.vy = MAX_PUSH; 
            }
            if (team !== 4 && inBL) { 
                obj.vx += FAN_FORCE; obj.vy -= FAN_FORCE; 
                if (obj.vx > MAX_PUSH) obj.vx = MAX_PUSH; if (obj.vy < -MAX_PUSH) obj.vy = -MAX_PUSH; 
            }
            if (team !== 2 && inBR) { 
                obj.vx -= FAN_FORCE; obj.vy -= FAN_FORCE; 
                if (obj.vx < -MAX_PUSH) obj.vx = -MAX_PUSH; if (obj.vy < -MAX_PUSH) obj.vy = -MAX_PUSH; 
            }
        }
    }

    room.entities.forEach(e => { if(!['square','triangle','pentagon','hexagon'].includes(e.type)) applyRepel(e); });
    room.bullets.forEach(applyRepel);
    room.drones.forEach(d => {
        applyRepel(d);
        // Hard boundary: physically prevent drones from staying inside enemy bases
        let team = d.team || 0;
        if (team !== 0) {
            if (room.mode === "2TDM") {
                if (team !== 1 && d.x < BASE_WIDTH_2 + PROX) {
                    d.x = BASE_WIDTH_2 + PROX + 5;
                    if (d.vx < 0) d.vx = Math.abs(d.vx);
                }
                if (team !== 2 && d.x > WORLD_SIZE - BASE_WIDTH_2 - PROX) {
                    d.x = WORLD_SIZE - BASE_WIDTH_2 - PROX - 5;
                    if (d.vx > 0) d.vx = -Math.abs(d.vx);
                }
            } else if (room.mode === "4TDM") {
                if (team !== 1 && d.x < BASE_SIZE_4 + PROX && d.y < BASE_SIZE_4 + PROX) {
                    if (d.x < BASE_SIZE_4 + PROX) { d.x = BASE_SIZE_4 + PROX + 5; if (d.vx < 0) d.vx = Math.abs(d.vx); }
                    if (d.y < BASE_SIZE_4 + PROX) { d.y = BASE_SIZE_4 + PROX + 5; if (d.vy < 0) d.vy = Math.abs(d.vy); }
                }
                if (team !== 3 && d.x > WORLD_SIZE - BASE_SIZE_4 - PROX && d.y < BASE_SIZE_4 + PROX) {
                    if (d.x > WORLD_SIZE - BASE_SIZE_4 - PROX) { d.x = WORLD_SIZE - BASE_SIZE_4 - PROX - 5; if (d.vx > 0) d.vx = -Math.abs(d.vx); }
                    if (d.y < BASE_SIZE_4 + PROX) { d.y = BASE_SIZE_4 + PROX + 5; if (d.vy < 0) d.vy = Math.abs(d.vy); }
                }
                if (team !== 4 && d.x < BASE_SIZE_4 + PROX && d.y > WORLD_SIZE - BASE_SIZE_4 - PROX) {
                    if (d.x < BASE_SIZE_4 + PROX) { d.x = BASE_SIZE_4 + PROX + 5; if (d.vx < 0) d.vx = Math.abs(d.vx); }
                    if (d.y > WORLD_SIZE - BASE_SIZE_4 - PROX) { d.y = WORLD_SIZE - BASE_SIZE_4 - PROX - 5; if (d.vy > 0) d.vy = -Math.abs(d.vy); }
                }
                if (team !== 2 && d.x > WORLD_SIZE - BASE_SIZE_4 - PROX && d.y > WORLD_SIZE - BASE_SIZE_4 - PROX) {
                    if (d.x > WORLD_SIZE - BASE_SIZE_4 - PROX) { d.x = WORLD_SIZE - BASE_SIZE_4 - PROX - 5; if (d.vx > 0) d.vx = -Math.abs(d.vx); }
                    if (d.y > WORLD_SIZE - BASE_SIZE_4 - PROX) { d.y = WORLD_SIZE - BASE_SIZE_4 - PROX - 5; if (d.vy > 0) d.vy = -Math.abs(d.vy); }
                }
            }
        }
    });

    room.bullets.forEach(b => {
        b.x += b.vx; b.y += b.vy; b.life--;
    });
    room.grid.clear();
    room.entities.forEach(e => { if(!e.markedForDeletion && !e.ghost) room.grid.insert(e, 'entities'); });
    room.bullets.forEach(b => { if(b.life > 0) room.grid.insert(b, 'bullets'); });
    room.drones.forEach(d => { if(!d.markedForDeletion) room.grid.insert(d, 'drones'); });
    room.entities.forEach(e => { if(!e.markedForDeletion) e.update(); });
    room.drones.forEach(d => { if(!d.markedForDeletion) d.update(); });

    room.bullets.forEach(b1 => {
        if (b1.life <= 0) return;
        let nearby = room.grid.getNearby(b1.x, b1.y, b1.r * 2);
        nearby.bullets.forEach(b2 => {
            if (b1.id >= b2.id || b2.life <= 0) return;
            let sameOwner = b1.owner === b2.owner;
            let sameTeam = room.mode.includes("TDM") && b1.team === b2.team && b1.team !== 0;
            if (!sameOwner && !sameTeam) {
                let dx = b1.x - b2.x, dy = b1.y - b2.y, rad = b1.r + b2.r;
                if (dx*dx + dy*dy < rad*rad) {
                    let p1 = b1.pen; let p2 = b2.pen;
                    b1.pen -= p2; b2.pen -= p1;
                    if (b1.pen <= 0) b1.life = 0;
                    if (b2.pen <= 0) b2.life = 0;
                }
            }
        });
    });

    room.drones.forEach(d1 => {
        if (d1.markedForDeletion) return;
        let nearby = room.grid.getNearby(d1.x, d1.y, d1.radius * 2);
        nearby.drones.forEach(d2 => {
            if (d1.id >= d2.id || d2.markedForDeletion) return;
            let sameOwner = d1.owner === d2.owner;
            let sameTeam = room.mode.includes("TDM") && d1.team === d2.team && d1.team !== 0;
            if (!sameOwner && !sameTeam) {
                let dx = d1.x - d2.x, dy = d1.y - d2.y, rad = d1.radius + d2.radius;
                if (dx*dx + dy*dy < rad*rad) {
                    let d1Dmg = d1.dmg; let d2Dmg = d2.dmg;
                    d1.hp -= d2Dmg; d2.hp -= d1Dmg;
                    if (d1.hp <= 0) d1.markedForDeletion = true;
                    if (d2.hp <= 0) d2.markedForDeletion = true;
                }
            }
        });
    });

    room.bullets.forEach(b => {
        if (b.life <= 0) return;
        let nearby = room.grid.getNearby(b.x, b.y, b.r + 50);

        for(let i=0; i<nearby.drones.length; i++) {
            let d = nearby.drones[i];
            if (b.life <= 0 || d.markedForDeletion || b.owner === d.owner) continue;
            if (room.mode.includes("TDM") && d.team === b.team && b.team !== 0) continue;
            let dx = b.x - d.x, dy = b.y - d.y, rad = b.r + d.radius;
            if (dx*dx + dy*dy < rad*rad) {
                d.hp -= b.dmg; b.pen -= 1;
                if (d.hp <= 0) d.markedForDeletion = true;
                if (b.pen <= 0) { b.life = 0; break; }
            }
        }

        if (b.life > 0) {
            for(let i=0; i<nearby.entities.length; i++) {
                let en = nearby.entities[i];
                if (b.life <= 0 || en.markedForDeletion || b.owner === en) continue;
                if (room.mode.includes("TDM") && en.team === b.team && !['square','triangle','pentagon','hexagon'].includes(en.type)) continue;
                
                let dx = b.x - en.x, dy = b.y - en.y, rad = b.r + en.radius;
                let distSq = dx*dx + dy*dy;
                
                if (distSq < rad*rad) {
                    let dist = Math.sqrt(distSq);
                    let overlapRatio = Math.max(0, Math.min(1, (rad - dist) / rad)); 
                    let depthMultiplier = 1 + (overlapRatio * 3);

                    let bMass = b.r * b.r;
                    let eMass = en.radius * en.radius;
                    let massRatio = bMass / eMass;
                    let nudgeFactor = 0.45 * depthMultiplier;
                    
                    en.vx += b.vx * massRatio * nudgeFactor;
                    en.vy += b.vy * massRatio * nudgeFactor;

                    b.vx *= (1 - 0.2 * overlapRatio);
                    b.vy *= (1 - 0.2 * overlapRatio);

                    let damageRate = 0.5 * depthMultiplier;
                    let appliedDmg = b.dmg * damageRate;
                    
                    en.hp -= appliedDmg; 
                    b.pen -= damageRate; 
                    
                    en.lastDamageTime = Date.now();
                    if (b.owner) en.lastDamagedBy = b.owner.id;
                    
                    if (b.pen <= 0) b.life = 0;
                    
                    if (en.hp <= 0 && !en.xpAwarded && b.owner && typeof b.owner.addXP === 'function') {
                        en.xpAwarded = true;
                        let xpGain = ['tank','ai'].includes(en.type) ? Math.max(en.xpVal||100, en.score) : (en.xpVal || 100);
                        b.owner.addXP(Math.min(xpGain, 24700));
                    }
                    if (b.life <= 0) break;
                }
            }
        }
    });

    room.drones.forEach(d => {
        if (d.markedForDeletion) return;
        let nearby = room.grid.getNearby(d.x, d.y, d.radius + 50);
        for(let i=0; i<nearby.entities.length; i++) {
            let en = nearby.entities[i];
            if (d.markedForDeletion || en.markedForDeletion || d.owner === en) continue;
            if (room.mode.includes("TDM") && en.team === d.team && !['square','triangle','pentagon','hexagon'].includes(en.type)) continue;
            
            let dx = d.x - en.x, dy = d.y - en.y, rad = d.radius + en.radius;
            if (dx*dx + dy*dy < rad*rad) {
                let damageRate = 0.45; 
                
                en.hp -= d.dmg * damageRate;
                d.hp -= (['ai','tank'].includes(en.type) ? 20 : 5) * damageRate; 
                en.lastDamageTime = Date.now();
                if (d.owner) en.lastDamagedBy = d.owner.id;
                
                if (en.hp <= 0 && !en.xpAwarded && d.owner && typeof d.owner.addXP === 'function') {
                    en.xpAwarded = true;
                    let xpGain = ['tank','ai'].includes(en.type) ? Math.max(en.xpVal||100, en.score) : (en.xpVal || 100);
                    d.owner.addXP(Math.min(xpGain, 24700)); 
                        
                    let droneCount = 22+(d.owner.stats[6]*2)
                    if (en.type === 'square' && d.owner.tankType === 'Necromancer' && d.owner.activeDrones < droneCount) {
                        room.drones.push(new Drone(room, en.x, en.y, d.owner));
                        if (d.owner.activeDrones < droneCount) {
                            room.drones.push(new Drone(room, en.x, en.y, d.owner));
                        }
                    }
                }
                if (d.hp <= 0) { d.markedForDeletion = true; break; }
            }
        }
    });

    room.entities.forEach(en => {
        if(en.markedForDeletion) return;
        if(['square','triangle','pentagon','hexagon'].includes(en.type)) {
            en.angle += (en.type==='square'?0.01:(en.type==='triangle'?0.02:0.005));
        }

        let nearby = room.grid.getNearby(en.x, en.y, en.radius * 2);
        nearby.entities.forEach(other => {
            if(en.id >= other.id || other.markedForDeletion) return;
            let isSameTeam = room.mode.includes("TDM") && en.team === other.team && en.team !== 0;
            let dx = other.x - en.x, dy = other.y - en.y, rad = en.radius + other.radius;
            
            if(dx*dx + dy*dy < rad*rad) {
                let dist = Math.sqrt(dx*dx + dy*dy) || 1;
                let overlap = rad - dist;
                let springFactor = 0.05; 
                let force = overlap * springFactor;
                let m1 = en.radius * en.radius;
                let m2 = other.radius * other.radius;
                let totalM = m1 + m2;
                
                let pushX = (dx / dist) * force;
                let pushY = (dy / dist) * force;
                en.vx -= pushX * (m2 / totalM);
                en.vy -= pushY * (m2 / totalM);
                other.vx += pushX * (m1 / totalM);
                other.vy += pushY * (m1 / totalM);
                
                if (!isSameTeam && !room.noCombat) {
                    let damageRate = 2; 
                    let dmgE = (1 + (other.stats ? other.stats[2]*2 : 0)) * damageRate;
                    let dmgO = (1 + (en.stats ? en.stats[2]*2 : 0)) * damageRate;
                    
                    en.hp -= dmgE; 
                    other.hp -= dmgO;
                    
                    en.lastDamageTime = Date.now();
                    other.lastDamageTime = Date.now(); 
                    en.lastDamagedBy = other.id; 
                    other.lastDamagedBy = en.id;
                    
                    if(en.hp <= 0 && !en.xpAwarded && typeof other.addXP === 'function') { en.xpAwarded = true; other.addXP(['tank','ai'].includes(en.type) ? Math.max(en.xpVal||100, en.score) : (en.xpVal || 100)); }
                    if(other.hp <= 0 && !other.xpAwarded && typeof en.addXP === 'function') { other.xpAwarded = true; en.addXP(['tank','ai'].includes(other.type) ? Math.max(other.xpVal||100, other.score) : (other.xpVal || 100)); }
                }
            }
        });
    });
    room.bullets = room.bullets.filter(b => b.life > 0);
    room.drones = room.drones.filter(d => {
        if (d.markedForDeletion) {
            if (d.owner && d.owner.activeDrones > 0) {
                d.owner.activeDrones--;
            }
            return false;
        }
        return true;
    });
    room.entities.forEach(e => {
    if (!e.markedForDeletion && e.isPlayer) {
        updateForceField(e);
    }
});
    let respawningBots = [];
    room.entities = room.entities.filter(e => {
        if(e.hp <= 0) {
            if (room.mode === 'WORLD' && e.isPlayer) {
                const owner = room.clients.find(c => c.player === e);
                if (owner?.world) worldOnPlayerDeath(owner, e);
                e.hp = e.maxHp;          // keep the old entity alive for a moment; the world loop respawns the player
                return true;
            }
            // Resolve the killer once so both the achievement logic below and the
            // global leaderboard recording (further down) can share it.
            const killer = ['tank', 'ai'].includes(e.type)
                ? room.entities.find(p => p.id === e.lastDamagedBy)
                : null;
            const killerClient = (killer && killer.isPlayer)
                ? room.clients.find(c => c.player === killer)
                : null;

            // Award kill achievements whenever a tank/bot dies (not just real players)
            if (['tank', 'ai'].includes(e.type)) {
                if (killer && killer.isPlayer) {
                    if (killerClient?.dbId) {
                        db.prepare(`
                            UPDATE users
                            SET kills = kills + 1
                            WHERE id = ?
                        `).run(killerClient.dbId);

                        const stats = db.prepare(`
                            SELECT kills FROM users WHERE id = ?
                        `).get(killerClient.dbId);

                        unlockAchievement(
                            killerClient.dbId,
                            'first_blood',
                            killerClient.ws
                        );

                        if (stats.kills >= 100) {
                            unlockAchievement(
                                killerClient.dbId,
                                'tank_destroyer',
                                killerClient.ws
                            );
                        }

                        if (e.score >= 1000000) {
                            unlockAchievement(
                                killerClient.dbId,
                                'millionaire_hunter',
                                killerClient.ws
                            );
                        }
                    }
                }

                // Record this death's score on the global per-mode leaderboard.
                // Covers both real players and bots (e.g. Overlord AI) so the
                // top-50 board reflects any tank/ai that reached a high score,
                // with an isBot flag on each side so consumers can tell them apart.
                recordLeaderboardScore(room.mode, e, killer, killerClient);
            }

            if(e.isPlayer && e.ws) {
                let timeAlive = Math.floor((Date.now() - e.spawnTime) / 1000);
                e.ws.send(JSON.stringify({ type: 'death', score: e.score, level: e.level, timeAlive: timeAlive, tank: e.tankType, killerId: e.lastDamagedBy }));
                let client = room.clients.find(c => c.player === e);
                if (client && client.dbId) {
                    let earnedCoins = Math.floor(e.score / 1000); 
                    
                    let userRecord = db.prepare("SELECT high_score, provider FROM users WHERE id = ?").get(client.dbId);
                    let isNewHighScore = false;
                    
                    if (userRecord && e.score > (userRecord.high_score || 0)) {
                        db.prepare("UPDATE users SET high_score = ? WHERE id = ?").run(e.score, client.dbId);
                        isNewHighScore = true;
                    }

                    if (earnedCoins > 0) {
                        db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(earnedCoins, client.dbId);
                    }
                    
                    let updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId);
                    client.ws.send(JSON.stringify({ type: 'profile_update', profile: updatedUser }));
                    
                    if (isNewHighScore && userRecord.provider === 'discord') {
                        updateLeaderboard();
                    }
                }
                if (client) {
                    client.player = null;
                    client.spectatingId = e.lastDamagedBy;
                }
            }
            if (room.mode === 'WORLD' && !e.noReward && ['square','triangle','pentagon','hexagon'].includes(e.type) && e.lastDamagedBy) {
                const shooter = room.entities.find(p => p.id === e.lastDamagedBy && p.isPlayer);
                const owner = shooter && room.clients.find(c => c.player === shooter);
                if (owner?.world) {
                    const reward = Math.max(1, Math.floor((e.xpVal || 60) / 20));
                    owner.world.sessionCoins = (owner.world.sessionCoins || 0) + reward;
                    sendWorld(owner, 'world_notice', { message: `+${reward} session coins`, sessionCoins: owner.world.sessionCoins });
                }
            }
            if(e.type === 'ai') respawningBots.push(Math.min(e.score / 5, 6124));

            // Grant the powerup's effect to whoever landed the killing blow.
            if (e.type === 'powerup' && e.powerupType) {
                const picker = room.entities.find(p => p.id === e.lastDamagedBy && ['tank', 'ai'].includes(p.type));
                if (picker) {
                    applyPowerupEffect(picker, e.powerupType);
                }
            }

            room.clients.forEach(c => {
                if (c.spectatingId === e.id) c.spectatingId = e.lastDamagedBy || null; 
            });
            return false;
        }
        return true;
    });

    respawningBots.forEach(score => room.spawnBot(Math.floor(Math.random()*100), score));

    let shapes = room.entities.filter(e => !['ai','tank'].includes(e.type)).length;
    if(shapes < 300 && room.mode !== 'WORLD') room.spawnShape();
}

// ===================== GAME TICK =====================

setInterval(() => { 
    allRooms().forEach(updateRoom); 
}, 1000 / (TICK_RATE * GAME_SPEED));

// <<WORLD_LAYOUT_BEGIN>>
// ---------------------------------------------------------------------------
// Deterministic world layout.
//
// The old generator rolled dice per 420-unit cell, so every cell invented its
// own roads / props and neighbouring cells overlapped. This one works top-down:
//   1. Roads are GLOBAL lines on a 600-unit grid (avenue / street / lane).
//   2. Every block is exactly the space BETWEEN two roads on each axis, so a
//      pavement can never sit on asphalt and no road can cross a building.
//   3. Each block lays out its content inside its own rectangle from explicit
//      slots (rows of house lots, grids of towers, car-park bays, field tiles),
//      so nothing inside a block can overlap anything else.
// ---------------------------------------------------------------------------
const W_GAP = 450000;                  // distance between city centres (multiple of 600); raise it for even longer drives
const W_C = 25200, W_S = 600, W_EXT = 2 * W_C + W_GAP;
const W_NB = Math.ceil(W_EXT / 600);   // collision-bucket row stride
const W_CORE = 3600, W_INNER = 9600, W_SUB = 18000;
const W_SW = 26;                       // pavement width inside a block
const W_BORDER = 19500, W_TOLL = 20;       // city limit (Chebyshev radius from centre) and toll per crossing
worldRoom.worldExtent = W_EXT; worldRoom.grid = new SparseGrid(W_EXT, 500);   // the world room spans every city, not just the original 50 km square
const W_CITIES = [                      // home city first; the others are other seeds of the same generator, clipped to radius R (houses, shops, offices)
    { id: 'central', name: 'Central City', cx: W_C, cy: W_C, border: W_BORDER, home: true, theme: 'home', wageMul: 1, priceMul: 1, toll: 20 },
    { id: 'port',    name: 'Port Aldren',  cx: W_C + W_GAP, cy: W_C, border: 19500, R: 18000, seedAdd: 101, theme: 'port', wageMul: 1.25, priceMul: 0.9, toll: 30 },
    { id: 'highmoor', name: 'Highmoor',    cx: W_C, cy: W_C + W_GAP, border: 19500, R: 18000, seedAdd: 202, theme: 'hill', wageMul: 0.85, priceMul: 0.7, toll: 15 },
    { id: 'solana',  name: 'Solana',       cx: W_C + W_GAP, cy: W_C + W_GAP, border: 19500, R: 18000, seedAdd: 303, theme: 'sun', wageMul: 1.5, priceMul: 1.6, toll: 40 }
];
function worldCityAt(x, y) { for (const c of W_CITIES) if (Math.max(Math.abs(x - c.cx), Math.abs(y - c.cy)) < c.border) return c; return null; }
function worldPayFor(co, pos) { const c = (pos && worldCityAt(pos.x, pos.y)) || W_CITIES[0]; return Math.max(1, Math.round(co.pay * c.wageMul)); }
function worldOnHighway(x, y) {
    if (!WL || !WL.highways) return false;
    for (const h of WL.highways) { const along = h.a === 'h' ? x : y, perp = h.a === 'h' ? y : x; if (Math.abs(perp - h.p) < 125 && along > h.s0 - 50 && along < h.s1 + 50) return true; }
    return false;
}
const W_SHORE = 1800;                  // land ends here; everything beyond is water
const W_CHUNK = 1800;                  // streaming chunk size
const W_NCH = Math.ceil(W_EXT / W_CHUNK);
const ROAD_CLASSES = { avenue: { hw: 105, lanes: 4, e: W_C }, street: { hw: 60, lanes: 2, e: W_SUB }, lane: { hw: 46, lanes: 2, e: W_CORE } };
const W_COMPANIES = [
    { id: 'meridian',  name: 'Meridian Finance',   pay: 38, color: '#2f6fb0', role: 'Analyst' },
    { id: 'atlas',     name: 'Atlas Digital',      pay: 44, color: '#7a4fd0', role: 'Developer' },
    { id: 'northgate', name: 'Northgate Legal',    pay: 52, color: '#9a3544', role: 'Paralegal' },
    { id: 'helix',     name: 'Helix Media',        pay: 34, color: '#d0782f', role: 'Producer' },
    { id: 'orion',     name: 'Orion Logistics',    pay: 40, color: '#2f9c78', role: 'Coordinator' },
    { id: 'pinnacle',  name: 'Pinnacle Insurance', pay: 48, color: '#b8962b', role: 'Underwriter' }
];

function wRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function wHash(seed, a, b) {
    let n = (seed ^ Math.imul((a + 0x9e3779b1) | 0, 374761393) ^ Math.imul((b + 0x85ebca6b) | 0, 668265263)) >>> 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function lineClass(k) {
    const p = Math.abs(k * W_S);
    if (k % 6 === 0) return 'avenue';
    if (k % 2 === 0) return p <= W_SUB ? 'street' : null;
    return p <= W_CORE ? 'lane' : null;
}

// Car-park bay positions. Shared by the server (parking / dealership) and the
// client (painted lines), so both always agree.
function lotBays(lot) {
    const BW = 54, BD = 96, pad = 8, out = [];
    const cols = Math.max(1, Math.floor((lot.w - 2 * pad) / BW));
    const x0 = lot.x + (lot.w - cols * BW) / 2;
    const rows = [];
    if (lot.h >= BD + 2 * pad) rows.push({ y: lot.y + pad, a: -Math.PI / 2 });
    if (lot.h >= BD * 2 + 40) rows.push({ y: lot.y + lot.h - pad - BD, a: Math.PI / 2 });
    if (lot.h >= BD * 4 + 160) {
        rows.push({ y: lot.y + lot.h / 2 - BD, a: -Math.PI / 2 });
        rows.push({ y: lot.y + lot.h / 2, a: Math.PI / 2 });
    }
    for (const r of rows) for (let c = 0; c < cols; c++) out.push({ x: x0 + BW * (c + 0.5), y: r.y + BD / 2, a: r.a });
    return out;
}

function buildCityLayout(seed) {
    const C = W_C, S = W_S;
    const L = {
        seed, roads: [], junctions: [], blocks: [], buildings: [], props: [], lots: [], fields: [], pcars: [],
        colliders: [], houses: [], works: [], bank: null, dealer: null, spawn: { x: C + 300, y: C + 470 },
        nid: 1, rv: {}, rh: {}
    };
    const nid = () => L.nid++;

    // ---- 1. roads -----------------------------------------------------------------
    for (const axis of ['v', 'h']) {
        for (let k = -42; k <= 42; k++) {
            const cls = lineClass(k); if (!cls) continue;
            const rc = ROAD_CLASSES[cls];
            const road = { a: axis, k, p: C + k * S, c: cls[0], hw: rc.hw, ln: rc.lanes, e: rc.e };
            L.roads.push(road);
            (axis === 'v' ? L.rv : L.rh)[k] = road;
        }
    }
    for (const v of L.roads) {
        if (v.a !== 'v') continue;
        for (const h of L.roads) {
            if (h.a !== 'h') continue;
            const rx = v.k * S, ry = h.k * S;
            if (Math.abs(ry) > v.e || Math.abs(rx) > h.e) continue;
            L.junctions.push({
                id: nid(), x: C + rx, y: C + ry,
                n: ry > -v.e ? v.hw : 0, s: ry < v.e ? v.hw : 0,
                w: rx > -h.e ? h.hw : 0, e: rx < h.e ? h.hw : 0, hv: v.hw, hh: h.hw
            });
        }
    }

    // ---- helpers to add content -----------------------------------------------------
    const rectCol = (x, y, w, h) => L.colliders.push({ t: 0, x, y, w, h });
    const circCol = (x, y, r) => L.colliders.push({ t: 1, x, y, r });
    function addBuilding(kind, x, y, w, h, extra) {
        const b = Object.assign({ id: nid(), k: kind, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, extra || {});
        if (!b.door) b.door = { dir: 'S' };
        const d = b.door;
        if (d.dir === 'S') { d.x = b.x + b.w / 2; d.y = b.y + b.h; }
        else if (d.dir === 'N') { d.x = b.x + b.w / 2; d.y = b.y; }
        else if (d.dir === 'E') { d.x = b.x + b.w; d.y = b.y + b.h / 2; }
        else { d.x = b.x; d.y = b.y + b.h / 2; }
        d.x = Math.round(d.x); d.y = Math.round(d.y);
        L.buildings.push(b); rectCol(b.x, b.y, b.w, b.h);
        return b;
    }
    const addTree = (x, y, v, r = 9) => { L.props.push({ k: 'tree', x: Math.round(x), y: Math.round(y), v: v | 0, r: 24 + (v % 4) * 6 }); circCol(x, y, r); };
    const addBench = (x, y, horiz = true) => { const w = horiz ? 56 : 20, h = horiz ? 20 : 56; L.props.push({ k: 'bench', x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h }); rectCol(x - w / 2, y - h / 2, w, h); };
    const addLamp = (x, y) => { L.props.push({ k: 'lamp', x: Math.round(x), y: Math.round(y) }); circCol(x, y, 5); };
    const addDeco = (k, x, y, w, h, extra) => L.props.push(Object.assign({ k, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, extra || {}));
    function addLot(x, y, w, h, dealer) {
        const lot = { id: nid(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), dealer: !!dealer };
        L.lots.push(lot); return lot;
    }
    function fillLotWithCars(lot, rng, fill) {
        const bays = lotBays(lot); lot.bays = bays.length;
        if (lot.dealer) return;
        for (let i = 0; i < bays.length; i++) {
            if (rng() > fill) continue;
            const b = bays[i], vert = Math.abs(Math.sin(b.a)) > 0.5;
            L.pcars.push({ x: Math.round(b.x), y: Math.round(b.y), a: b.a, c: Math.floor(rng() * 8), t: rng() < 0.2 ? 1 : 0 });
            rectCol(b.x - (vert ? 15 : 30), b.y - (vert ? 30 : 15), vert ? 30 : 60, vert ? 60 : 30);
        }
    }
    function addField(x, y, w, h, kind, crop, target) {
        const f = { id: nid(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), kind, crop, target };
        L.fields.push(f); return f;
    }
    // Lamp posts sit on the pavement ring, away from every building (buildings are inset).
    function cornerLamps(B) {
        const o = W_SW / 2;
        addLamp(B.x + o, B.y + o); addLamp(B.x + B.w - o, B.y + o);
        addLamp(B.x + o, B.y + B.h - o); addLamp(B.x + B.w - o, B.y + B.h - o);
        addLamp(B.x + B.w / 2, B.y + o); addLamp(B.x + B.w / 2, B.y + B.h - o);
        addLamp(B.x + o, B.y + B.h / 2); addLamp(B.x + B.w - o, B.y + B.h / 2);
        if (wHash(seed, Math.round(B.x), Math.round(B.y)) < 0.55) { const ax = Math.round(B.x + B.w * 0.27), ay = Math.round(B.y + 6); L.props.push({ k: 'atm', x: ax, y: ay, w: 26, h: 14 }); rectCol(ax, ay, 26, 14); }
    }
    const inset = (r, d) => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });

    function companyFor(b) { return W_COMPANIES[Math.floor(wHash(seed, b.id, 77) * W_COMPANIES.length)]; }
    function makeWork(b) { const co = companyFor(b); b.work = co.id; b.sign = co.name; b.col = co.color; L.works.push(b); }

    // ---- per-zone block generators ---------------------------------------------------
    function parkBlock(B, rng, big) {
        const Lr = inset(B, W_SW);
        L.blocks[L.blocks.length - 1].g = 'park';
        // Trees on a jittered grid, benches at fixed path-side slots: no two can overlap.
        const step = big ? 150 : 110, margin = 36;
        const nx = Math.max(1, Math.floor((Lr.w - 2 * margin) / step)), ny = Math.max(1, Math.floor((Lr.h - 2 * margin) / step));
        const cx = Lr.x + Lr.w / 2, cy = Lr.y + Lr.h / 2;
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            const px = Lr.x + margin + (i + 0.5) * (Lr.w - 2 * margin) / nx, py = Lr.y + margin + (j + 0.5) * (Lr.h - 2 * margin) / ny;
            if (Math.abs(px - cx) < 46 || Math.abs(py - cy) < 46) continue;          // keep the two paths clear
            if (rng() < 0.42) continue;
            addTree(px + (rng() - 0.5) * 20, py + (rng() - 0.5) * 20, Math.floor(rng() * 8));
        }
        addDeco('path', Lr.x, cy - 17, Lr.w, 34); addDeco('path', cx - 17, Lr.y, 34, Lr.h);
        addDeco('fountain', cx - 36, cy - 36, 72, 72); circCol(cx, cy, 36);
        const q = Math.min(Lr.w, Lr.h) * 0.27;
        addBench(cx - q, cy - 30, true); addBench(cx + q, cy + 30, true);
        addBench(cx - 30, cy - q, false); addBench(cx + 30, cy + q, false);
    }
    function towerBlock(B, rng, lowrise) {
        const Lr = inset(B, W_SW + 12);
        const w = Lr.w * (0.74 + rng() * 0.2), h = Lr.h * (0.74 + rng() * 0.2);
        const x = Lr.x + (Lr.w - w) * (0.3 + rng() * 0.4), y = Lr.y + (Lr.h - h) * (0.3 + rng() * 0.4);
        const b = addBuilding('tower', x, y, w, h, {
            s: Math.floor(rng() * 9999), f: lowrise ? 5 + Math.floor(rng() * 6) : 12 + Math.floor(rng() * 26),
            t: Math.floor(rng() * 6), r: Math.floor(rng() * 4)
        });
        if (rng() < (lowrise ? 0.28 : 0.5)) makeWork(b);
        cornerLamps(B);
    }
    function twinBlock(B, rng) {
        const Lr = inset(B, W_SW + 12), gap = 34, horiz = Lr.w >= Lr.h;
        for (let i = 0; i < 2; i++) {
            const w = horiz ? (Lr.w - gap) / 2 : Lr.w, h = horiz ? Lr.h : (Lr.h - gap) / 2;
            const x = horiz ? Lr.x + i * (w + gap) : Lr.x, y = horiz ? Lr.y : Lr.y + i * (h + gap);
            const iw = w * (0.8 + rng() * 0.15), ih = h * (0.8 + rng() * 0.15);
            const b = addBuilding('mid', x + (w - iw) / 2, y + (h - ih) / 2, iw, ih, { s: Math.floor(rng() * 9999), f: 6 + Math.floor(rng() * 8), t: Math.floor(rng() * 6), r: Math.floor(rng() * 4) });
            if (rng() < 0.3) makeWork(b);
        }
        cornerLamps(B);
    }
    function shopsBlock(B, rng) {
        const Lr = inset(B, W_SW + 8), n = Math.max(2, Math.floor(Lr.w / 130)), sw = Lr.w / n, sh = Math.min(150, Lr.h * 0.42);
        for (let i = 0; i < n; i++) addBuilding('shop', Lr.x + i * sw + 6, Lr.y, sw - 12, sh, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), aw: Math.floor(rng() * 6) });
        const ty = Lr.y + sh + 60;
        for (let i = 0; i < n; i++) if (ty + 30 < Lr.y + Lr.h) addTree(Lr.x + i * sw + sw / 2, ty + 20 + (i % 2) * 40, i + 1);
        if (ty + 90 < Lr.y + Lr.h) addBench(Lr.x + Lr.w / 2, Lr.y + Lr.h - 40, true);
        cornerLamps(B);
    }
    function carparkBlock(B, rng, dealer) {
        const Lr = inset(B, W_SW);
        const lot = addLot(Lr.x, Lr.y, Lr.w, Lr.h, dealer);
        fillLotWithCars(lot, rng, 0.55);
        cornerLamps(B);
        return lot;
    }
    function midriseBlock(B, rng) {
        const Lr = inset(B, W_SW + 14), gap = 60;
        const nx = Lr.w > 800 ? 2 : 1, ny = Lr.h > 800 ? 2 : 1, cw = (Lr.w - gap * (nx - 1)) / nx, ch = (Lr.h - gap * (ny - 1)) / ny;
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            const w = cw * (0.62 + rng() * 0.25), h = ch * (0.62 + rng() * 0.25);
            const b = addBuilding('mid', Lr.x + i * (cw + gap) + (cw - w) / 2, Lr.y + j * (ch + gap) + (ch - h) / 2, w, h,
                { s: Math.floor(rng() * 9999), f: 5 + Math.floor(rng() * 10), t: Math.floor(rng() * 6), r: Math.floor(rng() * 4) });
            if (rng() < 0.3) makeWork(b);
        }
        cornerLamps(B);
    }
    function aptBlock(B, rng) {
        const Lr = inset(B, W_SW + 14), rows = 3, gap = 46, rh = (Lr.h - gap * (rows - 1)) / rows;
        for (let j = 0; j < rows; j++) {
            const w = Lr.w * (0.7 + rng() * 0.2), x = Lr.x + (Lr.w - w) * rng();
            addBuilding('apt', x, Lr.y + j * (rh + gap), w, rh * 0.78, { s: Math.floor(rng() * 9999), f: 4 + Math.floor(rng() * 5), t: Math.floor(rng() * 6) });
            const ty = Lr.y + j * (rh + gap) + rh * 0.78 + 22;
            for (let i = 0; i < 4; i++) if (rng() < 0.7) addTree(Lr.x + 60 + i * (Lr.w - 120) / 3, ty, i + j, 8);
        }
        cornerLamps(B);
    }
    function mallBlock(B, rng) {
        const Lr = inset(B, W_SW + 8), bh = Lr.h * 0.5;
        addBuilding('mall', Lr.x + 20, Lr.y, Lr.w - 40, bh - 16, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6) });
        const lot = addLot(Lr.x, Lr.y + bh + 30, Lr.w, Lr.h - bh - 30, false);
        fillLotWithCars(lot, rng, 0.5);
        cornerLamps(B);
    }
    function housingBlock(B, rng, bz) {
        const Lr = inset(B, W_SW), depth = 300;
        const n = Math.max(3, Math.floor(Lr.w / 190)), lw = Lr.w / n;
        const D = Math.max(Math.abs(B.x + B.w / 2 - C), Math.abs(B.y + B.h / 2 - C));
        const basePrice = D < 12000 ? 30000 : D < 15000 ? 17000 : 10000;
        for (const north of [true, false]) {
            const ly0 = north ? Lr.y : Lr.y + Lr.h - depth;
            for (let i = 0; i < n; i++) {
                const lx = Lr.x + i * lw;
                const hw = 92 + Math.floor(rng() * 38), hh = 76 + Math.floor(rng() * 26);
                const room = lw - hw - 28;
                const hx = lx + 14 + rng() * Math.max(0, room);
                const hy = north ? ly0 + 38 : ly0 + depth - 38 - hh;
                const tier = hw * hh > 11400 ? 2 : hw * hh > 8800 ? 1 : 0;
                const hid = 'h' + L.nid;                    // stable: derived from generation order
                const b = addBuilding('house', hx, hy, hw, hh, {
                    s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), r: Math.floor(rng() * 6),
                    door: { dir: north ? 'N' : 'S' }, tier, price: Math.round(basePrice * (0.85 + tier * 0.25) / 500) * 500,
                    gar: rng() > 0.42, por: rng() > 0.35, fen: rng() > 0.55, hid, lot: [Math.round(lx), Math.round(ly0), Math.round(lw), depth]
                });
                L.houses.push(b);
                // Back-garden tree: placed in the band behind the house, so it cannot touch the house.
                const by0 = north ? hy + hh + 46 : ly0 + 22, by1 = north ? ly0 + depth - 22 : hy - 46;
                if (by1 - by0 > 30 && rng() < 0.7) addTree(lx + 24 + rng() * (lw - 48), by0 + 20 + rng() * Math.max(0, by1 - by0 - 40), Math.floor(rng() * 8), 8);
            }
        }
        // Green strip between the two rows: playground bench + trees on fixed slots.
        const gy0 = Lr.y + depth + 24, gy1 = Lr.y + Lr.h - depth - 24;
        if (gy1 - gy0 > 80) {
            const cy = (gy0 + gy1) / 2;
            addDeco('path', Lr.x + 20, cy - 14, Lr.w - 40, 28);
            for (let i = 0; i < n; i++) {
                const tx = Lr.x + (i + 0.5) * lw;
                if (rng() < 0.75) addTree(tx, gy0 + 22 + rng() * 20, i, 8);
                if (rng() < 0.75) addTree(tx + lw * 0.25, gy1 - 22 - rng() * 20, i + 3, 8);
            }
            addBench(Lr.x + Lr.w * 0.3, cy - 34, true); addBench(Lr.x + Lr.w * 0.7, cy + 34, true);
        }
        for (const x of [B.x + 13, B.x + B.w - 13]) for (const y of [B.y + 13, B.y + B.h / 2, B.y + B.h - 13]) addLamp(x, y);
    }
    function allotmentBlock(B, rng) {
        const Lr = inset(B, W_SW + 14), gap = 28;
        const fw = (Lr.w - gap) / 2, fh = (Lr.h - gap) / 2;
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) addField(Lr.x + i * (fw + gap), Lr.y + j * (fh + gap), fw, fh, 'farm', Math.floor(rng() * 5), 12);
    }
    function shopStripBlock(B, rng) {
        const Lr = inset(B, W_SW + 8), n = Math.floor(Lr.w / 150), sw = Lr.w / n;
        for (let i = 0; i < n; i++) addBuilding('shop', Lr.x + i * sw + 6, Lr.y + 10, sw - 12, 110, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), aw: Math.floor(rng() * 6) });
        const lot = addLot(Lr.x, Lr.y + 150, Lr.w, Math.min(300, Lr.h - 150), false);
        fillLotWithCars(lot, rng, 0.4);
        const rest = Lr.h - 150 - Math.min(300, Lr.h - 150);
        if (rest > 120) for (let i = 0; i < 6; i++) addTree(Lr.x + (i + 0.5) * Lr.w / 6, Lr.y + Lr.h - 60, i, 8);
        cornerLamps(B);
    }
    function schoolBlock(B, rng) {
        const Lr = inset(B, W_SW + 14);
        addBuilding('school', Lr.x, Lr.y, Lr.w, 220, { s: Math.floor(rng() * 9999), t: 2 });
        addField(Lr.x + 40, Lr.y + 280, Lr.w - 80, Lr.h - 480, 'pitch', 0, 0);
        const lot = addLot(Lr.x + Lr.w * 0.25, Lr.y + Lr.h - 150, Lr.w * 0.5, 140, false);
        fillLotWithCars(lot, rng, 0.35);
        cornerLamps(B);
    }
    function farmBlock(B, rng, nx, ny, kind) {
        L.blocks[L.blocks.length - 1].g = 'farm';
        const tw = B.w / nx, th = B.h / ny, homeI = Math.floor(rng() * nx), homeJ = Math.floor(rng() * ny);
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            const tx = B.x + i * tw, ty = B.y + j * th;
            if (i === homeI && j === homeJ) {
                // farmstead: every element has its own fixed slot inside the tile
                const hx = tx + 70, hy = ty + 90;
                const house = addBuilding('farmhouse', hx, hy, 150, 110, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 5), r: Math.floor(rng() * 6), door: { dir: 'S' }, tier: 0, price: 6500, hid: 'h' + L.nid, lot: [Math.round(tx + 40), Math.round(ty + 50), 230, 260], por: true });
                L.houses.push(house);
                addBuilding('barn', tx + 330, ty + 90, 250, 170, { s: Math.floor(rng() * 9999), door: { dir: 'S' } });
                addDeco('silo', tx + 640, ty + 110, 84, 84); circCol(tx + 682, ty + 152, 42);
                addDeco('yard', tx + 40, ty + 290, 700, 130);
                for (let q = 0; q < 6; q++) addTree(tx + 70 + q * 120, ty + 470 + (q % 2) * 40, q, 9);
                addBuilding('shed', tx + 120, ty + 330, 80, 60, { s: 1, door: { dir: 'S' } });
            } else {
                const f = addField(tx + 36, ty + 36, tw - 72, th - 72, kind, Math.floor(rng() * 5), 0);
                f.target = Math.max(10, Math.min(30, Math.round(f.w * f.h / 60000)));
            }
        }
    }
    function forestBlock(B, rng, density) {
        L.blocks[L.blocks.length - 1].g = 'forest';
        const step = 175, nx = Math.floor((B.w - 60) / step), ny = Math.floor((B.h - 60) / step);
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            if (rng() > density) continue;
            addTree(B.x + 40 + (i + 0.5) * step + (rng() - 0.5) * 60, B.y + 40 + (j + 0.5) * step + (rng() - 0.5) * 60, Math.floor(rng() * 8), 10);
        }
    }

    // ---- 2. blocks (the space between roads) ------------------------------------------
    const hwAt = (axis, k) => (axis === 'v' ? L.rv[k] : L.rh[k]).hw;
    function cell(i0, j0, i1, j1, sizeKind) {
        const k0 = i0, k1 = i1, m0 = j0, m1 = j1;                    // line indices (units of S)
        const x = C + k0 * S + hwAt('v', k0), y = C + m0 * S + hwAt('h', m0);
        const w = (k1 - k0) * S - hwAt('v', k0) - hwAt('v', k1), h = (m1 - m0) * S - hwAt('h', m0) - hwAt('h', m1);
        const B = { x, y, w, h };
        const ccx = (k0 + k1) * S / 2, ccy = (m0 + m1) * S / 2, D = Math.max(Math.abs(ccx), Math.abs(ccy));
        const zone = D < W_CORE ? 0 : D < W_INNER ? 1 : D < W_SUB ? 2 : 3;
        const rng = wRng(Math.floor(wHash(seed, k0 * 131 + 7, m0 * 197 + 3) * 4294967296));
        const blk = { id: nid(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), z: zone, g: zone === 3 ? 'grass' : 'pav', sw: zone === 3 ? 0 : W_SW };
        L.blocks.push(blk);
        const r = rng();
        const ci = k0 / 1, cj = m0 / 1;                              // cell index in line units (core: 1 per cell)
        if (sizeKind === 'core') {
            // landmarks at fixed cells around the central avenue crossing
            const key = ci + ',' + cj;
            if (key === '0,0') {                                       // Central Plaza (spawn)
                parkBlock(B, rng, false); blk.g = 'plaza';
                L.spawn = { x: Math.round(B.x + B.w / 2), y: Math.round(B.y + B.h - 52) };
                return;
            }
            if (key === '-1,0') { const Lr = inset(B, W_SW + 10); L.bank = addBuilding('bank', Lr.x, Lr.y + 8, Lr.w, Lr.h - 16, { door: { dir: 'S' }, s: 11 }); cornerLamps(B); return; }
            if (key === '1,0') { const Lr = inset(B, W_SW + 10); L.dealer = addBuilding('dealer', Lr.x, Lr.y + 8, Lr.w, Lr.h * 0.62, { door: { dir: 'S' }, s: 12 }); const lot = addLot(Lr.x, Lr.y + 8 + Lr.h * 0.62 + 24, Lr.w, Lr.h - Lr.h * 0.62 - 40, true); lot.showroom = true; cornerLamps(B); return; }
            if (key === '2,0') { L.dealerLot = carparkBlock(B, rng, true); return; }
            if (key === '0,-1') { const Lr = inset(B, W_SW + 12); addBuilding('hall', Lr.x, Lr.y + 20, Lr.w, Lr.h - 40, { door: { dir: 'S' }, s: 13 }); cornerLamps(B); return; }
            if (key === '0,1' || key === '-1,-1') { carparkBlock(B, rng, false); return; }
            if (key === '1,-1') { parkBlock(B, rng, false); return; }
            if (r < 0.46) towerBlock(B, rng, false);
            else if (r < 0.64) twinBlock(B, rng);
            else if (r < 0.76) carparkBlock(B, rng, false);
            else if (r < 0.85) parkBlock(B, rng, false);
            else shopsBlock(B, rng);
        } else if (zone <= 1) {
            if (r < 0.28) midriseBlock(B, rng);
            else if (r < 0.46) aptBlock(B, rng);
            else if (r < 0.62) mallBlock(B, rng);
            else if (r < 0.72) carparkBlock(B, rng, false);
            else if (r < 0.82) parkBlock(B, rng, true);
            else if (r < 0.9) towerBlock(B, rng, true);
            else shopsBlock(B, rng);
        } else if (zone === 2) {
            if (r < 0.7) housingBlock(B, rng);
            else if (r < 0.8) allotmentBlock(B, rng);
            else if (r < 0.9) parkBlock(B, rng, true);
            else if (r < 0.95) schoolBlock(B, rng);
            else shopStripBlock(B, rng);
        } else {
            if (r < 0.5) farmBlock(B, rng, 3, 3, 'farm');
            else if (r < 0.68) farmBlock(B, rng, 2, 2, 'ranch');
            else if (r < 0.9) forestBlock(B, rng, 0.62);
            else forestBlock(B, rng, 0.14);
        }
    }
    // core: 600 cells inside |k|<=6 ; mid: 1200 cells (even lines) outside the core, within SUB ; rural: 3600 cells
    for (let i = -6; i < 6; i++) for (let j = -6; j < 6; j++) cell(i, j, i + 1, j + 1, 'core');
    for (let i = -15; i < 15; i++) for (let j = -15; j < 15; j++) {
        const k0 = i * 2, m0 = j * 2;
        if (k0 >= -6 && k0 + 2 <= 6 && m0 >= -6 && m0 + 2 <= 6) continue;
        cell(k0, m0, k0 + 2, m0 + 2, 'mid');
    }
    for (let i = -7; i < 7; i++) for (let j = -7; j < 7; j++) {
        if (i >= -5 && i < 5 && j >= -5 && j < 5) continue;
        cell(i * 6, j * 6, i * 6 + 6, j * 6 + 6, 'rural');
    }

    indexLayout(L);
    return L;
}
function indexLayout(L) {
    // ---- 3. indexes -----------------------------------------------------------------
    L.dealerLot = L.dealerLot || L.lots.find(l => l.dealer);
    const bucketOf = (x, y) => Math.floor(x / 600) + Math.floor(y / 600) * W_NB;
    L.cbuckets = new Map();
    for (const c of L.colliders) {
        const x0 = c.t ? c.x - c.r : c.x, x1 = c.t ? c.x + c.r : c.x + c.w, y0 = c.t ? c.y - c.r : c.y, y1 = c.t ? c.y + c.r : c.y + c.h;
        for (let bx = Math.floor(x0 / 600); bx <= Math.floor(x1 / 600); bx++) for (let by = Math.floor(y0 / 600); by <= Math.floor(y1 / 600); by++) {
            const key = bx + by * W_NB; let a = L.cbuckets.get(key); if (!a) L.cbuckets.set(key, a = []); a.push(c);
        }
    }
    L.houseById = new Map(L.houses.map(h => [h.hid, h]));
    L.buildingById = new Map(L.buildings.map(b => [b.id, b]));
    L.fieldById = new Map(L.fields.map(f => [f.id, f]));
    // chunk index (objects are listed in every chunk their bounding box touches)
    L.chunks = new Map();
    const chunkList = (key) => { let c = L.chunks.get(key); if (!c) L.chunks.set(key, c = { blocks: [], buildings: [], props: [], lots: [], fields: [], pcars: [], junctions: [] }); return c; };
    const put = (arr, name, o, w, h) => {
        const x0 = Math.max(0, Math.floor(o.x / W_CHUNK)), x1 = Math.min(W_NCH - 1, Math.floor((o.x + (w || 0)) / W_CHUNK));
        const y0 = Math.max(0, Math.floor(o.y / W_CHUNK)), y1 = Math.min(W_NCH - 1, Math.floor((o.y + (h || 0)) / W_CHUNK));
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) chunkList(cx + cy * W_NCH)[name].push(o);
    };
    L.blocks.forEach(o => put(0, 'blocks', o, o.w, o.h));
    L.buildings.forEach(o => put(0, 'buildings', o, o.w, o.h));
    L.lots.forEach(o => put(0, 'lots', o, o.w, o.h));
    L.fields.forEach(o => put(0, 'fields', o, o.w, o.h));
    L.props.forEach(o => put(0, 'props', o, o.w || 0, o.h || 0));
    L.pcars.forEach(o => put(0, 'pcars', o, 0, 0));
    L.junctions.forEach(o => put(0, 'junctions', o, 0, 0));
    (L.xjunctions || []).forEach(o => put(0, 'junctions', o, 0, 0));
    L.chunkJson = new Map();
    return L;
}
// Foreign city: another seed of the same generator, keeping only the downtown box around its centre, shifted into place.
function mergeCity(L, F, city, idx) {
    const ox = city.cx - W_C, oy = city.cy - W_C, R = city.R, off = (idx + 1) * 1000000;
    const inb = (x, y) => Math.abs(x - W_C) <= R && Math.abs(y - W_C) <= R;
    const sh = (o, extra) => Object.assign({}, o, { x: o.x + ox, y: o.y + oy }, extra);
    const skipB = b => b.k === 'bank' || b.k === 'dealer';
    for (const b of F.blocks) if (inb(b.x + b.w / 2, b.y + b.h / 2)) L.blocks.push(sh(b, { id: b.id + off }));
    for (const b of F.buildings) {
        if (skipB(b) || !inb(b.x + b.w / 2, b.y + b.h / 2)) continue;
        const nb = sh(b, { id: b.id + off, city: city.id, door: Object.assign({}, b.door, { x: b.door.x + ox, y: b.door.y + oy }) });
        if (b.price) nb.price = Math.max(500, Math.round(b.price * city.priceMul / 500) * 500);
        if (b.hid) { nb.hid = 'c' + idx + b.hid; if (b.lot) nb.lot = [b.lot[0] + ox, b.lot[1] + oy, b.lot[2], b.lot[3]]; L.houses.push(nb); }
        if (b.work) L.works.push(nb);
        L.buildings.push(nb); L.colliders.push({ t: 0, x: nb.x, y: nb.y, w: nb.w, h: nb.h });
    }
    for (const l of F.lots) if (!l.dealer && inb(l.x + l.w / 2, l.y + l.h / 2)) L.lots.push(sh(l, { id: l.id + off }));
    for (const p of F.props) if (inb(p.x, p.y)) L.props.push(sh(p));
    for (const p of F.pcars) if (inb(p.x, p.y)) L.pcars.push(sh(p));
    const bset = new Set(F.buildings.map(b => b.x + ',' + b.y + ',' + b.w + ',' + b.h));
    for (const c of F.colliders) {
        const cx = c.t ? c.x : c.x + c.w / 2, cy = c.t ? c.y : c.y + c.h / 2;
        if (!inb(cx, cy) || (c.t === 0 && bset.has(c.x + ',' + c.y + ',' + c.w + ',' + c.h))) continue;   // building colliders were added above
        L.colliders.push(sh(c));
    }
    for (const j of F.junctions) if (inb(j.x, j.y)) L.xjunctions.push(sh(j, { id: j.id + off, f: 1 }));
    for (const r of F.roads) if (Math.abs(r.k) * W_S <= R) L.xroads.push(Object.assign({}, r, { p: r.p + (r.a === 'v' ? ox : oy), e: Math.min(r.e, R), o: r.a === 'v' ? city.cy : city.cx, f: 1 }));
}
// Subway: ticket kiosks on the pavement beside each city's two central avenues (line 1 east-west, line 2 north-south).
const W_STATION_NAMES = ['Old Town', 'Riverside', 'Market Square', 'Cathedral', 'University', 'Harbour View', 'Museum', 'Park Lane', 'Union Hall', 'Fairview', 'Stadium', 'Tech Quarter', 'Garden Row', 'Lakeside', 'Kingsway', 'Westbrook', 'Eastgate', 'Southfield', 'Northpoint', 'Highbury', 'Castle Hill', 'Mill Road', 'Bridge Street', 'Library', 'Observatory', 'Chapel Court', 'Foundry', 'Orchard', 'Rosewood', 'Silver Lane'];
function addSubway(L) {
    L.stations = []; L.stationById = new Map();
    W_CITIES.forEach((city, ci) => {
        const used = new Set(); let n = 0;
        for (const line of [1, 2]) {
            const cand = L.blocks.filter(B => B.sw && (line === 1 ? (B.y >= city.cy && B.y - city.cy <= 220) : (B.x >= city.cx && B.x - city.cx <= 220)) && (line === 1 ? Math.abs(B.x + B.w / 2 - city.cx) : Math.abs(B.y + B.h / 2 - city.cy)) < 16500);
            const taken = new Set();
            for (let t = -15000; t <= 15000; t += 3000) {
                if (line === 2 && t === 0) continue;                   // the central hub sits on line 1
                let best = null, bd = 1800;
                for (const B of cand) { if (taken.has(B)) continue; const d = Math.abs((line === 1 ? B.x + B.w / 2 - city.cx : B.y + B.h / 2 - city.cy) - t); if (d < bd) { bd = d; best = B; } }
            if (!best) continue;
            const B = best, hub = line === 1 && t === 0;
            const k = line === 1 ? { x: Math.round(B.x + B.w * 0.62 - 20), y: B.y + 2, w: 40, h: 22 } : { x: B.x + 2, y: Math.round(B.y + B.h * 0.62 - 20), w: 22, h: 40 };
            let ni = (ci * 7 + n * 5 + line * 3) % W_STATION_NAMES.length; while (used.has(ni)) ni = (ni + 1) % W_STATION_NAMES.length; used.add(ni); n++;
            const st = { id: city.id + '-' + line + '-' + (t / 3000), name: hub ? city.name + ' Station' : W_STATION_NAMES[ni], city: city.id, line, hub,
                x: k.x + k.w / 2, y: k.y + k.h / 2, ex: line === 1 ? k.x - 16 : B.x + 13, ey: line === 1 ? B.y + 13 : k.y - 16 };
            L.stations.push(st); L.stationById.set(st.id, st);
            L.props.push({ k: 'metro', x: k.x, y: k.y, w: k.w, h: k.h, sid: st.id, line, name: st.name });
            L.colliders.push({ t: 0, x: k.x, y: k.y, w: k.w, h: k.h });
            taken.add(B);
            }
        }
    });
}
function buildWorldLayout(seed) {
    const L = buildCityLayout(seed);
    L.xroads = []; L.xjunctions = []; L.highways = []; L.cities = W_CITIES;
    W_CITIES.forEach((city, idx) => { if (!city.home) mergeCity(L, buildCityLayout(seed + city.seedAdd), city, idx - 1); });
    const R = W_CITIES[1].R, B = W_C + W_GAP, add = (a, p, s0, s1) => {
        L.xroads.push({ a, k: 'hw' + L.highways.length, p, c: 'x', hw: 130, ln: 4, e: (s1 - s0) / 2, o: (s0 + s1) / 2, f: 1 }); L.highways.push({ a, p, s0, s1 });
    };
    add('h', W_C, 2 * W_C, B - R);  add('v', W_C, 2 * W_C, B - R);       // Central City -> Port Aldren / Highmoor
    add('v', B, W_C + R, B - R);    add('h', B, W_C + R, B - R);         // Port Aldren -> Solana / Highmoor -> Solana
    L.allRoads = L.roads.concat(L.xroads);
    addSubway(L);
    indexLayout(L);
    return L;
}
function layoutChunkJson(L, cx, cy) {
    const key = cx + cy * W_NCH;
    let s = L.chunkJson.get(key);
    if (s) return s;
    const c = L.chunks.get(key) || { blocks: [], buildings: [], props: [], lots: [], fields: [], pcars: [], junctions: [] };
    const slim = b => { const o = Object.assign({}, b); delete o.price; return o; };
    s = JSON.stringify({ cx, cy, blocks: c.blocks, buildings: c.buildings.map(slim), props: c.props, lots: c.lots, fields: c.fields, pcars: c.pcars, junctions: c.junctions });
    L.chunkJson.set(key, s);
    return s;
}
// Circle-vs-static-collider push-out. Returns true when the position was moved.
function layoutPushOut(L, pos, r) {
    let moved = false;
    for (let pass = 0; pass < 3; pass++) {
        let any = false;
        for (let bx = Math.floor((pos.x - r) / 600); bx <= Math.floor((pos.x + r) / 600); bx++)
            for (let by = Math.floor((pos.y - r) / 600); by <= Math.floor((pos.y + r) / 600); by++) {
                const list = L.cbuckets.get(bx + by * W_NB); if (!list) continue;
                for (const c of list) any = collidePush(pos, r, c) || any;
            }
        moved = moved || any; if (!any) break;
    }
    return moved;
}
function collidePush(pos, r, c) {
    if (c.t === 1) {
        const dx = pos.x - c.x, dy = pos.y - c.y, rr = r + c.r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) return false;
        const d = Math.sqrt(d2) || 0.001; pos.x = c.x + dx / d * rr; pos.y = c.y + dy / d * rr; return true;
    }
    const nx = Math.max(c.x, Math.min(pos.x, c.x + c.w)), ny = Math.max(c.y, Math.min(pos.y, c.y + c.h));
    let dx = pos.x - nx, dy = pos.y - ny, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return false;
    if (d2 > 1e-6) { const d = Math.sqrt(d2); pos.x = nx + dx / d * r; pos.y = ny + dy / d * r; return true; }
    // centre is inside the rectangle: exit through the nearest face
    const l = pos.x - c.x, rt = c.x + c.w - pos.x, t = pos.y - c.y, b = c.y + c.h - pos.y, m = Math.min(l, rt, t, b);
    if (m === l) pos.x = c.x - r; else if (m === rt) pos.x = c.x + c.w + r; else if (m === t) pos.y = c.y - r; else pos.y = c.y + c.h + r;
    return true;
}
// <<WORLD_LAYOUT_END>>

// <<WORLD_INTERIORS_BEGIN>>
// ---------------------------------------------------------------------------
// Interior maps. Each interior is its own Room (a separate map the player is
// teleported into). Definitions are pure data: the server turns walls + solid
// furniture into colliders and the client draws the very same rectangles.
// ---------------------------------------------------------------------------
const INT_EXT = 1800, INT_WALL = 26;
function intWallsAround(fl, doorX, doorW) {
    const T = INT_WALL, w = [];
    w.push({ x: fl.x - T, y: fl.y - T, w: fl.w + 2 * T, h: T });                               // top
    w.push({ x: fl.x - T, y: fl.y, w: T, h: fl.h });                                           // left
    w.push({ x: fl.x + fl.w, y: fl.y, w: T, h: fl.h });                                        // right
    w.push({ x: fl.x - T, y: fl.y + fl.h, w: doorX - doorW / 2 - (fl.x - T), h: T });          // bottom-left of the door
    w.push({ x: doorX + doorW / 2, y: fl.y + fl.h, w: fl.x + fl.w + T - (doorX + doorW / 2), h: T }); // bottom-right of the door
    return w;
}
function buildOfficeInterior(co) {
    const X0 = 250, Y0 = 250, W = 1300, H = 1100, fl = { x: X0, y: Y0, w: W, h: H };
    const doorX = X0 + W / 2, doorW = 130;
    const D = {
        kind: 'office', ext: INT_EXT, floor: fl, theme: { accent: co.color, name: co.name },
        walls: intWallsAround(fl, doorX, doorW), furn: [], stations: [], rooms: [],
        door: { x: doorX - doorW / 2, y: Y0 + H, w: doorW, h: INT_WALL, px: doorX, py: Y0 + H - 36, r: 110 },
        spawn: { x: doorX, y: Y0 + H - 90 }
    };
    D.rooms.push({ x: X0, y: Y0, w: W, h: H - 300, c: 'office' }, { x: X0, y: Y0 + H - 300, w: W, h: 300, c: 'lobby' });
    const f = D.furn;
    // reception desk with the receptionist behind it
    f.push({ k: 'reception', x: doorX - 170, y: Y0 + H - 250, w: 340, h: 56, solid: 1 });
    f.push({ k: 'rug', x: doorX - 160, y: Y0 + H - 140, w: 320, h: 90 });
    f.push({ k: 'sofa', x: X0 + 50, y: Y0 + H - 160, w: 190, h: 70, solid: 1 }, { k: 'sofa', x: X0 + W - 240, y: Y0 + H - 160, w: 190, h: 70, solid: 1 });
    f.push({ k: 'plant', x: X0 + 40, y: Y0 + H - 290, r: 20, solid: 1 }, { k: 'plant', x: X0 + W - 40, y: Y0 + H - 290, r: 20, solid: 1 });
    f.push({ k: 'plant', x: X0 + 40, y: Y0 + H - 40, r: 20, solid: 1 }, { k: 'plant', x: X0 + W - 40, y: Y0 + H - 40, r: 20, solid: 1 });
    D.reception = { id: 'reception', x: doorX, y: Y0 + H - 196, r: 150 };
    // open-plan desks: 3 rows x 4 columns, every desk has its own work station
    let n = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        const dx = X0 + 110 + c * 300, dy = Y0 + 120 + r * 220;
        f.push({ k: 'desk', x: dx, y: dy, w: 140, h: 64, solid: 1 });
        f.push({ k: 'monitor', x: dx + 52, y: dy + 8, w: 36, h: 8 });
        f.push({ k: 'chair', x: dx + 55, y: dy + 80, r: 15 });
        D.stations.push({ id: 'desk' + n++, x: dx + 70, y: dy + 70, r: 80 });
    }
    for (let i = 0; i < 5; i++) f.push({ k: 'cabinet', x: X0 + 150 + i * 220, y: Y0 + 10, w: 90, h: 44, solid: 1 });
    f.push({ k: 'plant', x: X0 + 40, y: Y0 + 50, r: 20, solid: 1 }, { k: 'plant', x: X0 + W - 40, y: Y0 + 50, r: 20, solid: 1 });
    f.push({ k: 'cooler', x: X0 + W - 80, y: Y0 + 480, w: 34, h: 34, solid: 1 });
    return D;
}
function buildHouseInterior(tier) {
    const dims = [[960, 720], [1160, 820], [1360, 920]][Math.max(0, Math.min(2, tier | 0))];
    const W = dims[0], H = dims[1], X0 = (INT_EXT - W) / 2, Y0 = (INT_EXT - H) / 2, fl = { x: X0, y: Y0, w: W, h: H };
    const doorW = 120, doorX = X0 + W * 0.28, T = 20;
    const D = {
        kind: 'house', ext: INT_EXT, floor: fl, theme: { tier }, furn: [], stations: [], rooms: [],
        walls: intWallsAround(fl, doorX, doorW),
        door: { x: doorX - doorW / 2, y: Y0 + H, w: doorW, h: INT_WALL, px: doorX, py: Y0 + H - 36, r: 100 },
        spawn: { x: doorX, y: Y0 + H - 80 }
    };
    const sx = Math.round(W * 0.56), ky = Math.round(H * 0.42);
    // interior walls (with doorways)
    const vgap = [Math.round(H * 0.5), 120], hgap = [sx + Math.round((W - sx) * 0.55), 120];
    D.walls.push({ x: X0 + sx, y: Y0, w: T, h: vgap[0] });
    D.walls.push({ x: X0 + sx, y: Y0 + vgap[0] + vgap[1], w: T, h: H - vgap[0] - vgap[1] });
    D.walls.push({ x: X0 + sx + T, y: Y0 + ky, w: hgap[0] - sx - T, h: T });
    D.walls.push({ x: X0 + hgap[0] + hgap[1], y: Y0 + ky, w: W - hgap[0] - hgap[1], h: T });
    D.rooms.push({ x: X0, y: Y0, w: sx, h: H, c: 'living' }, { x: X0 + sx, y: Y0, w: W - sx, h: ky, c: 'kitchen' }, { x: X0 + sx, y: Y0 + ky, w: W - sx, h: H - ky, c: 'bedroom' });
    const f = D.furn, rx = X0 + sx;
    // living room
    f.push({ k: 'rug', x: X0 + 80, y: Y0 + 190, w: 330, h: 210 });
    f.push({ k: 'sofa', x: X0 + 110, y: Y0 + 300, w: 220, h: 80, solid: 1 });
    f.push({ k: 'table', x: X0 + 150, y: Y0 + 215, w: 140, h: 56, solid: 1 });
    f.push({ k: 'tv', x: X0 + 160, y: Y0 + 70, w: 120, h: 34, solid: 1 });
    f.push({ k: 'plant', x: X0 + 40, y: Y0 + 40, r: 18, solid: 1 });
    f.push({ k: 'dining', x: X0 + sx - 230, y: Y0 + H - 270, w: 150, h: 100, solid: 1 });
    f.push({ k: 'chair', x: X0 + sx - 262, y: Y0 + H - 220, r: 14 }, { k: 'chair', x: X0 + sx - 48, y: Y0 + H - 220, r: 14 });
    // kitchen
    f.push({ k: 'counter', x: rx + 30, y: Y0 + 20, w: W - sx - 60, h: 50, solid: 1 });
    f.push({ k: 'island', x: rx + 90, y: Y0 + ky - 160, w: Math.max(120, W - sx - 240), h: 60, solid: 1 });
    // bedroom
    f.push({ k: 'bed', x: rx + (W - sx) - 220, y: Y0 + H - 250, w: 190, h: 220, solid: 1 });
    f.push({ k: 'wardrobe', x: rx + 24, y: Y0 + ky + 34, w: 150, h: 56, solid: 1 });
    f.push({ k: 'nightstand', x: rx + (W - sx) - 262, y: Y0 + H - 250, w: 36, h: 36, solid: 1 });
    f.push({ k: 'rug', x: rx + 40, y: Y0 + H - 250, w: 170, h: 200 });
    D.stations.push({ id: 'bed', x: rx + (W - sx) - 125, y: Y0 + H - 260, r: 120 });
    if (tier >= 1) { f.push({ k: 'desk', x: X0 + 40, y: Y0 + H - 140, w: 130, h: 60, solid: 1 }, { k: 'chair', x: X0 + 95, y: Y0 + H - 70, r: 14 }); }
    if (tier >= 2) { f.push({ k: 'bath', x: X0 + sx - 170, y: Y0 + 24, w: 140, h: 70, solid: 1 }, { k: 'plant', x: X0 + sx - 40, y: Y0 + 180, r: 18, solid: 1 }); }
    return D;
}
function interiorColliders(def) {
    const out = [];
    for (const w of def.walls) out.push({ t: 0, x: w.x, y: w.y, w: w.w, h: w.h });
    for (const f of def.furn) if (f.solid) out.push(f.r ? { t: 1, x: f.x, y: f.y, r: f.r } : { t: 0, x: f.x, y: f.y, w: f.w, h: f.h });
    return out;
}
// <<WORLD_INTERIORS_END>>

// ===================== PERSISTENT WORLD MODE =====================
// The exterior (WORLD room) is the city + suburbs + farmland built by buildWorldLayout().
// Houses and workplaces are separate interior Rooms players are teleported into.
const WORLD_LAYOUT_VERSION = 2;
const WORLD_CARS = [
    { id: 'compact', name: 'Compact', price: 2500,  speed: 6.2,  accel: 0.15, turn: 0.052, color: '#e4e7eb' },
    { id: 'sedan',   name: 'Sedan',   price: 6500,  speed: 8.0,  accel: 0.19, turn: 0.046, color: '#2684d9' },
    { id: 'sport',   name: 'Sport',   price: 18000, speed: 10.4, accel: 0.27, turn: 0.042, color: '#e84d4d' }
];
const WORLD_FIRE_MS = 15 * 60 * 1000;      // online play time allowed between shifts before you are fired
const WORLD_WARN_MS = [5 * 60 * 1000, 60 * 1000];
const WORLD_TASK_MS = 8000;                // one shift task
const WORLD_REHIRE_MS = 3 * 60 * 1000;     // wait after being fired
const WORLD_SAVE_MS = 5000;
const WORLD_CAR_COLORS = ['#e2e7e9', '#286da5', '#b84e46', '#d0ad58', '#5c6975', '#f1f0e9', '#3d7a52', '#7a4f8a'];

// persistent columns ---------------------------------------------------------------
for (const col of ['score REAL NOT NULL DEFAULT 0', 'level INTEGER NOT NULL DEFAULT 1', "tank_type TEXT NOT NULL DEFAULT 'Basic'",
    'stat_points INTEGER NOT NULL DEFAULT 0', 'car_x REAL', 'car_y REAL', 'car_a REAL', 'job TEXT',
    'job_last INTEGER NOT NULL DEFAULT 0', 'play_ms INTEGER NOT NULL DEFAULT 0', 'job_cd INTEGER NOT NULL DEFAULT 0']) {
    try { db.prepare('ALTER TABLE world_players ADD COLUMN ' + col).run(); } catch (err) { if (!/duplicate column/i.test(String(err.message))) throw err; }
}
try { db.prepare('ALTER TABLE world_meta ADD COLUMN layout_version INTEGER NOT NULL DEFAULT 1').run(); } catch (err) { if (!/duplicate column/i.test(String(err.message))) throw err; }

// ---- state ---------------------------------------------------------------------------
let WL = null, WSEED = 0;
const houseOwner = new Map();          // hid -> { owner_id, name, purchased_at }
const parkedCars = new Map();          // user id -> { uid, model, x, y, a, driven, pid }
const worldClients = new Set();
const interiorDefs = new Map();        // scene key -> def (cached)
const traffic = [], peds = [];
let worldNextDyn = 1, worldPidSeq = 1;
const junctionMap = new Map(), roadNodes = new Map(), pcarKeys = new Set();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function sendWorld(client, type, extra = {}) { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type, ...extra })); }
function worldNotice(client, message, extra = {}) { sendWorld(client, 'world_notice', { message, ...extra }); }
function fmtMoney(n) { return Math.floor(n).toLocaleString('en-US'); }
function angDiff(a, b) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function worldZone(x, y) { const c = worldCityAt(x, y) || W_CITIES[0], D = Math.max(Math.abs(x - c.cx), Math.abs(y - c.cy)); return D < W_CORE ? 0 : D < W_INNER ? 1 : D < W_SUB ? 2 : 3; }
function rectDist(x, y, r) { const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h)); return Math.hypot(dx, dy); }

// ---- world bootstrap -------------------------------------------------------------------
function ensureWorld() {
    if (WL) return WSEED;
    let row = db.prepare('SELECT seed, layout_version FROM world_meta WHERE id=1').get();
    if (!row) {
        const seed = crypto.randomInt(1, 0x7fffffff);
        db.prepare('INSERT INTO world_meta(id,seed,created_at,layout_version) VALUES(1,?,?,?)').run(seed, Date.now(), WORLD_LAYOUT_VERSION);
        row = { seed, layout_version: WORLD_LAYOUT_VERSION };
    }
    WSEED = row.seed;
    WL = buildWorldLayout(WSEED);
    WL.dealerLots = WL.lots.filter(l => l.dealer);
    junctionMap.clear(); roadNodes.clear(); pcarKeys.clear();
    for (const j of WL.junctions) junctionMap.set(Math.round((j.x - W_C) / W_S) + ',' + Math.round((j.y - W_C) / W_S), j);
    for (const r of WL.roads) roadNodes.set(r.a + r.k, []);
    for (const j of WL.junctions) {
        const kx = Math.round((j.x - W_C) / W_S), ky = Math.round((j.y - W_C) / W_S);
        roadNodes.get('v' + kx).push(j.y); roadNodes.get('h' + ky).push(j.x);
    }
    for (const a of roadNodes.values()) a.sort((p, q) => p - q);
    for (const c of WL.pcars) pcarKeys.add(Math.round(c.x) + ',' + Math.round(c.y));
    if (row.layout_version < WORLD_LAYOUT_VERSION) worldMigrateLegacyHouses();
    houseOwner.clear();
    for (const h of db.prepare('SELECT h.id, h.owner_id, h.purchased_at, u.username FROM world_houses h LEFT JOIN users u ON u.id = h.owner_id WHERE h.owner_id IS NOT NULL').all())
        houseOwner.set(h.id, { owner_id: h.owner_id, name: h.username || 'Resident', purchased_at: h.purchased_at || 0 });
    parkedCars.clear();
    for (const p of db.prepare('SELECT user_id, owned_car, car_x, car_y, car_a FROM world_players WHERE owned_car IS NOT NULL').all()) {
        if (!WORLD_CARS.find(c => c.id === p.owned_car)) continue;
        let pos = (p.car_x != null && p.car_y != null) ? { x: p.car_x, y: p.car_y, a: p.car_a || 0 } : worldFindFreeBay(p.user_id);
        parkedCars.set(p.user_id, { uid: p.user_id, model: p.owned_car, x: pos.x, y: pos.y, a: pos.a, driven: false, pid: worldPidSeq++ });
    }
    return WSEED;
}
// Old worlds had 320 random plots that could sit on roads. Owned plots are moved to the nearest real house.
function worldMigrateLegacyHouses() {
    const old = db.prepare('SELECT * FROM world_houses WHERE owner_id IS NOT NULL ORDER BY purchased_at').all();
    const taken = new Set();
    const ins = db.prepare('INSERT OR REPLACE INTO world_houses(id,owner_id,price,x,y,purchased_at,last_seen) VALUES(?,?,?,?,?,?,?)');
    db.transaction(() => {
        db.prepare('DELETE FROM world_houses').run();
        for (const h of old) {
            const ax = W_C + h.x, ay = W_C + h.y;
            let best = null, bd = Infinity;
            for (const b of WL.houses) { if (taken.has(b.hid)) continue; const d = (b.x + b.w / 2 - ax) ** 2 + (b.y + b.h / 2 - ay) ** 2; if (d < bd) { bd = d; best = b; } }
            if (!best) continue;
            taken.add(best.hid);
            ins.run(best.hid, h.owner_id, best.price, best.x + best.w / 2, best.y + best.h / 2, h.purchased_at, h.last_seen);
        }
        db.prepare('UPDATE world_meta SET layout_version=? WHERE id=1').run(WORLD_LAYOUT_VERSION);
    })();
    console.log(`[World] Migrated ${taken.size} legacy house plot(s) to the new layout.`);
}
function worldRegenerate() {
    db.prepare('DELETE FROM world_meta WHERE id=1').run();
    db.prepare('DELETE FROM world_houses').run();
    db.prepare('UPDATE world_players SET car_x=NULL, car_y=NULL, car_a=NULL').run();
    for (const c of [...worldClients]) sendWorld(c, 'world_reload');
    worldRoom.entities = worldRoom.entities.filter(e => e.isPlayer);
    traffic.length = 0; peds.length = 0; WL = null; ensureWorld();
}

// ---- parking ------------------------------------------------------------------------------
function worldBayFree(bay, ignoreUid) {
    if (pcarKeys.has(Math.round(bay.x) + ',' + Math.round(bay.y))) return false;
    for (const pc of parkedCars.values()) if (pc.uid !== ignoreUid && Math.abs(pc.x - bay.x) < 34 && Math.abs(pc.y - bay.y) < 34) return false;
    return true;
}
function worldFindFreeBay(ignoreUid, nearX, nearY) {
    const nx = nearX ?? WL.dealer.x, ny = nearY ?? WL.dealer.y;
    for (const lots of [WL.dealerLots, WL.lots.filter(l => !l.dealer && Math.hypot(l.x + l.w / 2 - nx, l.y + l.h / 2 - ny) < 4000).sort((a, b) => Math.hypot(a.x - nx, a.y - ny) - Math.hypot(b.x - nx, b.y - ny))]) {
        const cands = [];
        for (const lot of lots) for (const bay of lotBays(lot)) if (worldBayFree(bay, ignoreUid)) cands.push(bay);
        if (cands.length) { cands.sort((a, b) => Math.hypot(a.x - nx, a.y - ny) - Math.hypot(b.x - nx, b.y - ny)); return cands[0]; }
    }
    return { x: WL.dealer.door.x + 80, y: WL.dealer.door.y + 120, a: 0 };
}
function worldSnapToBay(x, y, uid) {
    for (const lot of WL.lots) {
        if (x < lot.x - 20 || x > lot.x + lot.w + 20 || y < lot.y - 20 || y > lot.y + lot.h + 20) continue;
        let best = null, bd = 80;
        for (const bay of lotBays(lot)) { const d = Math.hypot(bay.x - x, bay.y - y); if (d < bd && worldBayFree(bay, uid)) { bd = d; best = bay; } }
        if (best) return best;
    }
    return null;
}

// ---- collision helpers ---------------------------------------------------------------------
const _circ = [];
function worldCarCircles(x, y, a) { const c = Math.cos(a), s = Math.sin(a); _circ.length = 0; for (const o of [-17, 0, 17]) _circ.push({ x: x + c * o, y: y + s * o, r: 14 }); return _circ; }
function worldDynCars(x, y, range, skipUid, skipTraffic) {
    const out = [];
    for (const pc of parkedCars.values()) { if (pc.driven || pc.uid === skipUid) continue; if (Math.abs(pc.x - x) < range && Math.abs(pc.y - y) < range) out.push(pc); }
    if (!skipTraffic) for (const t of traffic) if (Math.abs(t.x - x) < range && Math.abs(t.y - y) < range) out.push(t);
    return out;
}
function worldPushOutOfCars(pos, r, skipUid) {
    for (const car of worldDynCars(pos.x, pos.y, 90, skipUid, false)) {
        for (const c of worldCarCircles(car.x, car.y, car.a)) {
            const dx = pos.x - c.x, dy = pos.y - c.y, rr = r + c.r, d2 = dx * dx + dy * dy;
            if (d2 < rr * rr) { const d = Math.sqrt(d2) || 0.001; pos.x = c.x + dx / d * rr; pos.y = c.y + dy / d * rr; }
        }
    }
}
// On-foot tank vs buildings, trees, benches, walls and cars. Called from Entity.update().
function worldCollideEntity(e) {
    const room = e.room, pos = { x: e.x, y: e.y };
    if (room.worldKind === 'interior') { for (const c of room.colliders) collidePush(pos, e.radius, c); }
    else if (WL) { layoutPushOut(WL, pos, e.radius); worldPushOutOfCars(pos, e.radius, null); }
    e.x = pos.x; e.y = pos.y;
}
// Driven car: bicycle-style steering, 3-circle body against all static colliders and other cars.
function worldStepVehicle(e) {
    const v = e.vehicle, spec = v.spec, inp = e.inputs || {};
    if (inp.up) v.v += spec.accel;
    else if (inp.down) v.v -= (v.v > 0.2 ? spec.accel * 2.4 : spec.accel * 0.8);
    else v.v *= 0.985;
    if (inp.repel) v.v *= 0.92;                                    // Shift = handbrake
    v.v = clamp(v.v, -spec.speed * 0.35, spec.speed * (worldOnHighway(e.x, e.y) ? 2 : 1));   // highways: double top speed
    if (Math.abs(v.v) < 0.02 && !inp.up && !inp.down) v.v = 0;
    const steer = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    v.a += steer * spec.turn * Math.min(1, Math.abs(v.v) / 2.5) * (v.v >= 0 ? 1 : -1) / (1 + Math.abs(v.v) * 0.08);
    let nx = e.x + Math.cos(v.a) * v.v, ny = e.y + Math.sin(v.a) * v.v, hit = false;
    const uid = e.room.clients.find(c => c.player === e)?.dbId;
    if (WL) {
        for (let pass = 0; pass < 2; pass++) {
            const cs = worldCarCircles(nx, ny, v.a);
            let ox = 0, oy = 0;
            for (const c of cs) {
                const p = { x: c.x, y: c.y };
                if (layoutPushOut(WL, p, c.r)) { ox += p.x - c.x; oy += p.y - c.y; hit = true; }
                for (const car of worldDynCars(c.x, c.y, 90, uid, false)) for (const o of worldCarCircles(car.x, car.y, car.a).slice()) {
                    const dx = c.x + ox - o.x, dy = c.y + oy - o.y, rr = c.r + o.r, d2 = dx * dx + dy * dy;
                    if (d2 < rr * rr) { const d = Math.sqrt(d2) || 0.001; ox += dx / d * (rr - d); oy += dy / d * (rr - d); hit = true; if (car.v !== undefined) car.v = 0; }
                }
            }
            nx += ox / 3; ny += oy / 3;
            if (!hit) break;
        }
    }
    if (hit) v.v *= 0.55;
    // run over anything on foot
    if (Math.abs(v.v) > 3) {
        const now = Date.now();
        for (const o of e.room.entities) {
            if (o === e || !o.isPlayer || o.ghost || o.markedForDeletion) continue;
            if (Math.hypot(o.x - nx, o.y - ny) < o.radius + 24 && now - (o.lastCarHit || 0) > 700) {
                o.lastCarHit = now; o.hp -= 12 + Math.abs(v.v) * 5; o.lastDamageTime = now; o.lastDamagedBy = e.id;
                o.vx += Math.cos(v.a) * v.v * 0.9; o.vy += Math.sin(v.a) * v.v * 0.9; v.v *= 0.7;
            }
        }
    }
    const tc = e.room.clients.find(c => c.player === e);
    if (tc && tc.world) {                                          // city-limit toll: charged whenever a car crosses the border
        const cOld = worldCityAt(e.x, e.y), cNew = worldCityAt(nx, ny);
        if (cOld !== cNew && Date.now() - (e.tollAt || 0) > 10000) {
            const toll = (cNew || cOld).toll;
            if (worldPayToll(tc, toll)) { e.tollAt = Date.now(); worldNotice(tc, `Toll gate: -${toll} coins. ${cNew ? 'Welcome to ' + cNew.name : 'Leaving ' + cOld.name}.`); }
            else { nx = e.x; ny = e.y; v.v = 0; if (Date.now() - (e.tollMsg || 0) > 3000) { e.tollMsg = Date.now(); worldNotice(tc, `Toll gate: you need ${toll} coins (cash or bank) to pass.`, { level: 'bad' }); } }
        }
    }
    e.x = clamp(nx, W_SHORE, W_EXT - W_SHORE); e.y = clamp(ny, W_SHORE, W_EXT - W_SHORE); e.vx = 0; e.vy = 0;
}

// ---- progress / persistence ------------------------------------------------------------------
function worldApplyProgress(ent, prog) {
    ent.score = Math.max(0, prog.score || 0);
    let lvl = 1;
    while (lvl < MAX_LEVEL && ent.score >= LEVEL_REQUIREMENTS[lvl + 1]) lvl++;
    ent.level = lvl; ent.maxHp = 100 + 15 * (lvl - 1); ent.radius = lvl > 1 ? 20 + lvl * 0.3 : 20;
    ent.stats = Array.isArray(prog.stats) && prog.stats.length === 8 ? prog.stats.map(n => clamp(n | 0, 0, 7)) : [0, 0, 0, 0, 0, 0, 0, 0];
    ent.statPoints = Math.max(0, prog.statPoints | 0);
    ent.tankType = TANK_SPECS[prog.tankType] ? prog.tankType : 'Basic';
    ent.xp = lvl >= MAX_LEVEL ? 0 : ent.score - LEVEL_REQUIREMENTS[lvl];
    ent.hp = ent.getEffectiveMaxHp(); ent.barrelTimers = [];
}
function worldSnapshot(client) {
    const w = client.world, p = client.player; if (!w || !p || w.dead) return;   // a dead tank must not overwrite the reset progress
    w.prog = { score: p.score, level: p.level, statPoints: p.statPoints, stats: [...p.stats], tankType: p.tankType };
}
function worldSave(client) {
    const w = client.world; if (!client.dbId || !w) return;
    worldSnapshot(client);
    const now = Date.now(), p = client.player;
    let ex = w.ext; if (p && w.scene === 'ext' && !p.vehicle) ex = { x: p.x, y: p.y };
    const pc = parkedCars.get(client.dbId); let cx = pc?.x ?? null, cy = pc?.y ?? null, ca = pc?.a ?? null;
    if (p?.vehicle) { cx = p.x; cy = p.y; ca = p.vehicle.a; if (w.scene === 'ext') ex = { x: p.x, y: p.y }; }
    w.ext = ex;
    db.prepare(`INSERT INTO world_players(user_id,x,y,upgrades,updated_at,last_seen,owned_car,session_coins,score,level,tank_type,stat_points,car_x,car_y,car_a,job,job_last,play_ms,job_cd)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET x=excluded.x,y=excluded.y,upgrades=excluded.upgrades,updated_at=excluded.updated_at,last_seen=excluded.last_seen,owned_car=excluded.owned_car,
        session_coins=excluded.session_coins,score=excluded.score,level=excluded.level,tank_type=excluded.tank_type,stat_points=excluded.stat_points,car_x=excluded.car_x,car_y=excluded.car_y,car_a=excluded.car_a,
        job=excluded.job,job_last=excluded.job_last,play_ms=excluded.play_ms,job_cd=excluded.job_cd`)
        .run(client.dbId, ex.x - W_C, ex.y - W_C, JSON.stringify({ stats: w.prog.stats }), now, now, w.car || null, Math.max(0, Math.floor(w.sessionCoins || 0)),
            w.prog.score, w.prog.level, w.prog.tankType, w.prog.statPoints, cx, cy, ca, w.job?.co || null, Math.floor(w.jobLast || 0), Math.floor(w.playMs || 0), Math.floor(w.jobCd || 0));
    db.prepare('UPDATE world_houses SET last_seen=? WHERE owner_id=?').run(now, client.dbId);
    w.lastSave = now;
}
function worldBankCoins(client) { return db.prepare('SELECT coins FROM users WHERE id=?').get(client.dbId)?.coins || 0; }
function worldPushProfile(client) { sendWorld(client, 'profile_update', { profile: db.prepare('SELECT * FROM users WHERE id=?').get(client.dbId) }); }
function worldFirstHouse(uid) { return db.prepare('SELECT id FROM world_houses WHERE owner_id=? ORDER BY purchased_at LIMIT 1').get(uid)?.id || null; }
function worldPushState(client) {
    const w = client.world; if (!w) return;
    const co = w.job ? W_COMPANIES.find(c => c.id === w.job.co) : null, pc = parkedCars.get(client.dbId);
    sendWorld(client, 'world_state', {
        sessionCoins: Math.floor(w.sessionCoins || 0), bank: w.bankCoins || 0, scene: w.scene,
        job: co ? { co: co.id, name: co.name, role: co.role, pay: co.pay, left: Math.max(0, WORLD_FIRE_MS - (w.playMs - w.jobLast)) } : null,
        car: w.car ? { model: w.car, driven: !!client.player?.vehicle, x: pc?.x ?? null, y: pc?.y ?? null, a: pc?.a ?? 0 } : null,
        house: worldFirstHouse(client.dbId)
    });
}

// ---- interiors ------------------------------------------------------------------------------
function worldInteriorDef(scene) {
    let d = interiorDefs.get(scene); if (d) return d;
    const [kind, key] = scene.split(':');
    if (kind === 'work') { const b = WL.buildingById.get(Number(key)); const co = W_COMPANIES.find(c => c.id === b?.work) || W_COMPANIES[0]; d = buildOfficeInterior(co); d.coId = co.id; d.bid = b ? b.id : 0; }
    else { const h = WL.houseById.get(key); d = buildHouseInterior(h ? h.tier : 0); d.hid = key; }
    d.colliders = interiorColliders(d);
    interiorDefs.set(scene, d); return d;
}
function worldGetInterior(scene) {
    let room = interiorRooms[scene];
    if (room) { room.emptySince = null; return room; }
    const def = worldInteriorDef(scene);
    room = new Room('INT:' + scene, 'WORLD', { shapeCount: 0, botCount: 0, shapeRespawn: false });
    room.worldKind = 'interior'; room.worldExtent = INT_EXT; room.grid = new SpatialGrid(INT_EXT, 250);
    room.noCombat = true; room.def = def; room.colliders = def.colliders; room.scene = scene; room.emptySince = null;
    interiorRooms[scene] = room; return room;
}
function worldPublicInterior(def) { const { colliders, ...rest } = def; return rest; }

// ---- scene changes -----------------------------------------------------------------------
function worldDetach(client) {
    const room = client.room, p = client.player;
    if (p) { p.markedForDeletion = true; if (room) { room.entities = room.entities.filter(e => e !== p); room.drones = room.drones.filter(d => d.owner !== p); } client.player = null; }
    if (room) { room.clients = room.clients.filter(c => c !== client); if (room.worldKind === 'interior' && !room.clients.length) room.emptySince = Date.now(); }
    client.room = null;
}
function worldGoto(client, scene, x, y) {
    const w = client.world; if (!w) return;
    if (client.player) worldSnapshot(client);
    worldDetach(client);
    const room = scene === 'ext' ? worldRoom : worldGetInterior(scene);
    const user = db.prepare('SELECT username, selected_color FROM users WHERE id=?').get(client.dbId);
    const ent = new Entity(room, x, y, 'tank', user?.username || 'Player', 0, true, client.ws);
    ent.nameColor = user?.selected_color || '#ffffff';
    worldApplyProgress(ent, w.prog);
    if (scene === 'ext' && WL) { const pos = { x, y }; layoutPushOut(WL, pos, ent.radius); ent.x = pos.x; ent.y = pos.y; }
    room.entities.push(ent); room.clients.push(client);
    client.room = room; client.player = ent; client.spectatingId = null;
    w.scene = scene; w.dead = false; w.task = null; w.promptKey = null; w.invulnerableUntil = Date.now() + 2500;
    if (scene === 'ext') w.ext = { x: ent.x, y: ent.y };
    sendWorld(client, 'world_scene', { scene: scene === 'ext' ? 'ext' : 'int', key: scene, interior: scene === 'ext' ? null : worldPublicInterior(room.def), x: ent.x, y: ent.y });
    client.ws.send(JSON.stringify({ type: 'init', id: ent.id, team: 0, nc: ent.nameColor, name1: ent.name }));
    w.bankCoins = worldBankCoins(client);
    worldPushState(client);
    if (scene === 'ext') worldStreamChunks(client, true);
}
function worldGotoExterior(client, x, y) { worldGoto(client, 'ext', x, y); }
// Standing point just outside a building door.
function worldOutsideDoor(b, extra = 46) {
    const d = b.door; return { x: d.x + (d.dir === 'E' ? extra : d.dir === 'W' ? -extra : 0), y: d.y + (d.dir === 'S' ? extra : d.dir === 'N' ? -extra : 0) };
}
function worldHomeSpawn(uid) {
    const hid = worldFirstHouse(uid); if (!hid || !WL.houseById.has(hid)) return null;
    return { scene: 'house:' + hid, def: worldInteriorDef('house:' + hid) };
}
function worldSpawnNewlyOrAfterDeath(client) {
    const home = worldHomeSpawn(client.dbId);
    if (home) worldGoto(client, home.scene, home.def.spawn.x, home.def.spawn.y);
    else worldGoto(client, 'ext', WL.spawn.x + (Math.random() - 0.5) * 60, WL.spawn.y);
}

// ---- chunk streaming ---------------------------------------------------------------------------
function worldViewScale(p) { return Math.max(1, (1 + ((p.level || 1) - 1) * 0.011) * (p.vehicle ? 1.5 : 1) * (p.getPowerupActive('fov') ? 1.3 : 1)); }
function worldStreamChunks(client, force) {
    const w = client.world, p = client.player; if (!w || !p || w.scene !== 'ext' || !WL) return;
    const cx = clamp(Math.floor(p.x / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor(p.y / W_CHUNK), 0, W_NCH - 1);
    const R = worldViewScale(p) > 1.35 ? 2 : 1;
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W_NCH || y >= W_NCH) continue;
        const key = x + y * W_NCH; if (w.sentChunks.has(key)) continue;
        w.sentChunks.add(key);
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send('{"type":"world_chunk","c":' + layoutChunkJson(WL, x, y) + '}');
    }
}
function worldSendStatic(client) {
    const bld = b => b && { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, door: b.door };
    sendWorld(client, 'world_static', {
        center: W_C, extent: W_EXT, chunk: W_CHUNK, nch: W_NCH, roads: WL.allRoads, cities: W_CITIES, cars: WORLD_CARS, carColors: WORLD_CAR_COLORS,
        companies: W_COMPANIES, spawn: WL.spawn, bank: bld(WL.bank), dealer: bld(WL.dealer), fireMs: WORLD_FIRE_MS, taskMs: WORLD_TASK_MS
    });
    sendWorld(client, 'world_houses', { list: [...houseOwner].map(([hid, o]) => [hid, o.name, o.owner_id === client.dbId ? 1 : 0]) });
}

// ---- jobs / banking / houses / cars -------------------------------------------------------------
function worldEmployer(w) { return w.job ? W_COMPANIES.find(c => c.id === w.job.co) : null; }
function worldFire(client, reason) {
    const w = client.world, co = worldEmployer(w); if (!co) return;
    w.job = null; w.task = null; w.jobCd = Date.now() + WORLD_REHIRE_MS;
    worldNotice(client, reason || `You were fired from ${co.name} for not working.`, { level: 'bad' });
    worldPushState(client); worldSave(client);
}
function worldPayToll(client, amt) {
    const w = client.world, cash = Math.floor(w.sessionCoins || 0);
    if (cash >= amt) w.sessionCoins = cash - amt;
    else {
        const bank = worldBankCoins(client); if (cash + bank < amt) return false;
        db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(amt - cash, client.dbId); w.sessionCoins = 0; w.bankCoins = worldBankCoins(client); worldPushProfile(client);
    }
    worldPushState(client); return true;
}
function worldDeposit(client) {
    const w = client.world, amt = Math.max(0, Math.floor(w.sessionCoins || 0));
    if (!amt) { worldNotice(client, 'You have no unbanked cash to deposit.'); return; }
    db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(amt, client.dbId);
    w.sessionCoins = 0; w.bankCoins = worldBankCoins(client);
    worldSave(client); worldPushProfile(client); worldPushState(client);
    worldNotice(client, `Deposited ${fmtMoney(amt)} coins into your account.`, { level: 'good', sessionCoins: 0 });
}
function worldBuyHouse(client, b) {
    const w = client.world;
    if (houseOwner.has(b.hid)) { worldNotice(client, 'Someone already owns this house.'); return; }
    const price = b.price;
    let ok = false;
    try {
        db.transaction(() => {
            const u = db.prepare('SELECT coins FROM users WHERE id=?').get(client.dbId);
            if (!u || u.coins < price) throw new Error('funds');
            if (db.prepare('SELECT owner_id FROM world_houses WHERE id=? AND owner_id IS NOT NULL').get(b.hid)) throw new Error('taken');
            const now = Date.now();
            db.prepare('INSERT OR REPLACE INTO world_houses(id,owner_id,price,x,y,purchased_at,last_seen) VALUES(?,?,?,?,?,?,?)').run(b.hid, client.dbId, price, b.x + b.w / 2, b.y + b.h / 2, now, now);
            db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(price, client.dbId);
            ok = true;
        })();
    } catch (err) { worldNotice(client, err.message === 'funds' ? `You need ${fmtMoney(price)} coins in your account. Deposit your cash at the bank first.` : 'That house is no longer available.'); return; }
    if (!ok) return;
    const name = db.prepare('SELECT username FROM users WHERE id=?').get(client.dbId)?.username || 'Resident';
    houseOwner.set(b.hid, { owner_id: client.dbId, name, purchased_at: Date.now() });
    w.bankCoins = worldBankCoins(client);
    for (const c of worldClients) sendWorld(c, 'world_house', { hid: b.hid, o: name, m: c.dbId === client.dbId ? 1 : 0 });
    worldPushProfile(client); worldPushState(client);
    worldNotice(client, 'You bought a house! It is now your spawn point. Walk to the door and press F to go inside.', { level: 'good' });
}
function worldExpireHouses() {
    const cutoff = Date.now() - 7 * 86400000;
    const expired = db.prepare('SELECT * FROM world_houses WHERE owner_id IS NOT NULL AND COALESCE(last_seen,purchased_at)< ?').all(cutoff);
    for (const h of expired) {
        db.transaction(() => { db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(Math.floor(h.price / 2), h.owner_id); db.prepare('DELETE FROM world_houses WHERE id=?').run(h.id); })();
        houseOwner.delete(h.id);
        for (const c of worldClients) sendWorld(c, 'world_house', { hid: h.id, o: null, m: 0 });
    }
}
function worldBuyCar(client, model) {
    const w = client.world, spec = WORLD_CARS.find(c => c.id === model);
    if (!spec) return;
    if (w.car === spec.id) { worldNotice(client, `You already own a ${spec.name}.`); return; }
    const old = w.car ? WORLD_CARS.find(c => c.id === w.car) : null, cost = spec.price - (old ? Math.floor(old.price * 0.5) : 0);
    const u = db.prepare('SELECT coins FROM users WHERE id=?').get(client.dbId);
    if (!u || u.coins < cost) { worldNotice(client, `The ${spec.name} costs ${fmtMoney(cost)} coins${old ? ' after trade-in' : ''}. Deposit cash at the bank first.`); return; }
    db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(cost, client.dbId);
    const bay = worldFindFreeBay(client.dbId);
    w.car = spec.id; parkedCars.set(client.dbId, { uid: client.dbId, model: spec.id, x: bay.x, y: bay.y, a: bay.a, driven: false, pid: parkedCars.get(client.dbId)?.pid || worldPidSeq++ });
    w.bankCoins = worldBankCoins(client);
    worldSave(client); worldPushProfile(client); worldPushState(client);
    worldNotice(client, `Purchased ${spec.name}${old ? ' (old car traded in)' : ''}. It is parked in the dealership car park – walk to it and press F to drive.`, { level: 'good' });
}
function worldEnterCar(client) {
    const w = client.world, p = client.player, pc = parkedCars.get(client.dbId);
    if (!w || !p || !pc || pc.driven || w.scene !== 'ext') return;
    if (Math.hypot(pc.x - p.x, pc.y - p.y) > 95) { worldNotice(client, 'Walk up to your car first.'); return; }
    const spec = WORLD_CARS.find(c => c.id === pc.model);
    pc.driven = true; p.vehicle = { spec, a: pc.a, v: 0, model: spec.id }; p.ghost = true; p.x = pc.x; p.y = pc.y; p.vx = p.vy = 0;
    p.inputs = { up: false, down: false, left: false, right: false, shooting: false, angle: p.inputs?.angle || 0, repel: false };
    worldPushState(client);
}
function worldExitCar(client, force) {
    const w = client.world, p = client.player; if (!w || !p || !p.vehicle) return;
    const v = p.vehicle, pc = parkedCars.get(client.dbId);
    if (!force && Math.abs(v.v) > 3.5) { worldNotice(client, 'Slow down before getting out.'); return; }
    let cx = p.x, cy = p.y, ca = v.a;
    const bay = worldSnapToBay(cx, cy, client.dbId); if (bay) { cx = bay.x; cy = bay.y; ca = bay.a; }
    if (pc) { pc.x = cx; pc.y = cy; pc.a = ca; pc.driven = false; }
    else parkedCars.set(client.dbId, { uid: client.dbId, model: v.model, x: cx, y: cy, a: ca, driven: false, pid: worldPidSeq++ });
    p.vehicle = null; p.ghost = false; p.vx = p.vy = 0;
    const lx = Math.sin(ca), ly = -Math.cos(ca);
    for (const side of [1, -1]) { const pos = { x: cx + lx * 48 * side, y: cy + ly * 48 * side }; if (!layoutPushOut(WL, pos, p.radius + 2)) { p.x = pos.x; p.y = pos.y; break; } p.x = pos.x; p.y = pos.y; }
    w.ext = { x: p.x, y: p.y };
    worldPushState(client); worldSave(client);
}
function worldDoRest(client) {
    const p = client.player, w = client.world; if (!p || Date.now() < (w.restUntil || 0)) { worldNotice(client, 'You are already well rested.'); return; }
    w.restUntil = Date.now() + 20000; p.hp = p.getEffectiveMaxHp(); worldSave(client); worldNotice(client, 'You rest in bed. Health restored and progress saved.', { level: 'good' });
}

// ---- interaction prompts ----------------------------------------------------------------------
// A prompt is what the player can currently interact with. The client anchors the bubble to
// (ax, ay) – e.g. on top of the bank building – and F triggers the first enabled action.
function worldComputePrompt(client) {
    const w = client.world, p = client.player; if (!w || !p || !WL) return null;
    if (w.scene !== 'ext') return worldInteriorPrompt(client);
    if (p.vehicle) {
        const spec = p.vehicle.spec, slow = Math.abs(p.vehicle.v) <= 3.5;
        return { id: 'exitcar', kind: 'exitcar', ax: p.x, ay: p.y - 56, title: spec.name, lines: [slow ? 'Park up and get out' : 'Slow down to get out'], actions: [{ a: 'exit', label: 'Get out', on: slow }], mini: true };
    }
    let best = null, bd = Infinity;
    const consider = (d, pr) => { if (d < bd) { bd = d; best = pr; } };
    const bank = WL.bank, dlr = WL.dealer;
    const dist = (pt) => Math.hypot(pt.x - p.x, pt.y - p.y);
    const coins = w.bankCoins || 0, cash = Math.floor(w.sessionCoins || 0);
    if (dist(bank.door) < 130) consider(dist(bank.door), { id: 'bank', kind: 'bank', ax: bank.x + bank.w / 2, ay: bank.y + bank.h / 2, title: 'Central Bank', lines: [`Unbanked cash: ${fmtMoney(cash)}`, `Account balance: ${fmtMoney(coins)}`, cash > 0 ? 'Deposit it before you lose it!' : 'Nothing to deposit'], actions: [{ a: 'deposit', label: 'Deposit all', on: cash > 0 }] });
    if (dist(dlr.door) < 150) {
        const old = w.car ? WORLD_CARS.find(c => c.id === w.car) : null;
        consider(dist(dlr.door), { id: 'dealer', kind: 'dealer', ax: dlr.x + dlr.w / 2, ay: dlr.y + dlr.h / 2, title: 'Car Dealership', lines: [`Account balance: ${fmtMoney(coins)}`, old ? `Trade-in: ${old.name} for ${fmtMoney(old.price * 0.5)}` : 'Cars are parked in the car park next door'],
            actions: WORLD_CARS.map(c => { const cost = c.price - (old ? Math.floor(old.price * 0.5) : 0); return { a: 'buy:' + c.id, label: c.id === w.car ? c.name + ' (owned)' : `${c.name} – ${fmtMoney(cost)}`, on: c.id !== w.car && coins >= cost }; }) });
    }
    const cx = clamp(Math.floor(p.x / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor(p.y / W_CHUNK), 0, W_NCH - 1);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (!ch) continue;
        for (const b of ch.buildings) {
            if (!b.work && !b.hid) continue;
            const d = dist(b.door); if (d > 100 || d >= bd) continue;
            const ax = b.x + b.w / 2, ay = b.y + b.h / 2;
            if (b.work) {
                const co = W_COMPANIES.find(c => c.id === b.work), mine = w.job?.co === co.id;
                consider(d, { id: 'work:' + b.id, kind: 'work', ctx: b, ax, ay, title: co.name, lines: [mine ? `You work here as ${co.role}` : `Hiring: ${co.role} · ${worldPayFor(co, b.door)} coins per shift`, 'Staff entrance – office floor inside'], actions: [{ a: 'enter', label: 'Go inside', on: true }] });
            } else {
                const o = houseOwner.get(b.hid);
                if (!o) consider(d, { id: 'house:' + b.hid, kind: 'house', ctx: b, ax, ay, title: 'House for sale', lines: [`${['Cosy', 'Family', 'Large'][b.tier || 0]} home · ${fmtMoney(b.price)} coins`, `Account balance: ${fmtMoney(coins)}`], actions: [{ a: 'buy', label: `Buy for ${fmtMoney(b.price)}`, on: coins >= b.price }] });
                else if (o.owner_id === client.dbId) consider(d, { id: 'house:' + b.hid, kind: 'house', ctx: b, ax, ay, title: 'Your house', lines: ['Your private home – only you can enter'], actions: [{ a: 'enter', label: 'Go inside', on: true }] });
                else consider(d, { id: 'house:' + b.hid, kind: 'house', ctx: b, ax, ay, title: `${o.name}'s house`, lines: ['Locked'], actions: [] });
            }
        }
    }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (!ch) continue;
        for (const a of ch.props) {
            if (a.k !== 'atm') continue;
            const d = Math.hypot(a.x + 13 - p.x, a.y + 7 - p.y); if (d > 85) continue;
            consider(d, { id: 'atm:' + a.x + ',' + a.y, kind: 'atm', ax: a.x + 13, ay: a.y - 36, title: 'ATM', lines: [`Unbanked cash: ${fmtMoney(cash)}`, `Account balance: ${fmtMoney(coins)}`], actions: [{ a: 'deposit', label: cash > 0 ? `Deposit ${fmtMoney(cash)}` : 'Nothing to deposit', on: cash > 0 }], mini: true });
        }
    }
    if (!p.vehicle) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (!ch) continue;
        for (const m of ch.props) {
            if (m.k !== 'metro') continue;
            const d = Math.hypot(m.x + m.w / 2 - p.x, m.y + m.h / 2 - p.y); if (d > 85) continue;
            const st = WL.stationById.get(m.sid), cn = W_CITIES.find(c => c.id === st.city).name;
            consider(d, { id: 'metro:' + st.id, kind: 'metro', ctx: st, ax: st.x, ay: st.y - 40, title: st.name, lines: [`${cn} · Subway line ${st.line}${st.hub ? ' · Intercity express' : ''}`], actions: [{ a: 'ride', label: 'Buy a ticket', on: true }], mini: true });
        }
    }
    const pc = parkedCars.get(client.dbId);
    if (pc && !pc.driven) { const d = Math.hypot(pc.x - p.x, pc.y - p.y); if (d < 85) { const spec = WORLD_CARS.find(c => c.id === pc.model); consider(d - 40, { id: 'car', kind: 'car', ax: pc.x, ay: pc.y - 50, title: 'Your ' + spec.name, lines: ['Press F to get in'], actions: [{ a: 'drive', label: 'Get in', on: true }], mini: true }); } }
    return best;
}
function worldInteriorPrompt(client) {
    const w = client.world, p = client.player, room = client.room, def = room.def; if (!def) return null;
    const near = (o, r) => Math.hypot(o.x - p.x, o.y - p.y) < (r || o.r || 90);
    const exitD = Math.hypot(def.door.px - p.x, def.door.py - p.y);
    let best = null, bd = Infinity;
    const consider = (d, pr) => { if (d < bd) { bd = d; best = pr; } };
    if (exitD < def.door.r) consider(exitD, { id: 'exit', kind: 'exit', ax: def.door.px, ay: def.door.py - 40, title: def.kind === 'house' ? 'Front door' : 'Exit building', lines: ['Back to the street'], actions: [{ a: 'exit', label: 'Go outside', on: true }], mini: true });
    if (def.kind === 'office') {
        const co = W_COMPANIES.find(c => c.id === def.coId), emp = worldEmployer(w), mine = emp && emp.id === co.id, now = Date.now();
        if (near(def.reception)) {
            const lines = [co.name, `${co.role} · ${worldPayFor(co, w.ext)} coins per shift`]; const actions = [];
            if (mine) { lines.push(`Shift due in ${worldFmtMs(WORLD_FIRE_MS - (w.playMs - w.jobLast))}`); actions.push({ a: 'quit', label: 'Resign', on: true }); }
            else if (emp) lines.push(`Resign from ${emp.name} first`);
            else if (now < (w.jobCd || 0)) lines.push(`Recently fired – retry in ${worldFmtMs((w.jobCd || 0) - now)}`);
            else { lines.push(`Work a task every ${Math.round(WORLD_FIRE_MS / 60000)} min of play or you will be fired`); actions.push({ a: 'apply', label: 'Apply for the job', on: true }); }
            consider(Math.hypot(def.reception.x - p.x, def.reception.y - p.y) - 60, { id: 'reception', kind: 'reception', ax: def.reception.x, ay: def.reception.y - 90, title: 'Reception', lines, actions });
        }
        for (const s of def.stations) if (near(s)) {
            const t = w.task && w.task.desk === s.id;
            const lines = mine ? (t ? ['Working…'] : [`Earn ${worldPayFor(co, w.ext)} coins · takes ${WORLD_TASK_MS / 1000}s`, 'Stay at your desk until finished']) : ['You need a job here – apply at reception'];
            consider(Math.hypot(s.x - p.x, s.y - p.y) - 30, { id: s.id, kind: 'desk', ctx: s, ax: s.x, ay: s.y - 70, title: 'Work station', lines, actions: mine ? [t ? { a: 'cancel', label: 'Stop', on: true } : { a: 'work', label: 'Start work', on: true }] : [] });
        }
    } else {
        for (const s of def.stations) if (s.id === 'bed' && near(s)) consider(Math.hypot(s.x - p.x, s.y - p.y) - 30, { id: 'bed', kind: 'bed', ax: s.x, ay: s.y - 90, title: 'Bed', lines: ['Rest to restore health and save your progress'], actions: [{ a: 'rest', label: 'Rest', on: true }] });
    }
    return best;
}
function worldFmtMs(ms) { ms = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(ms / 60) + ':' + String(ms % 60).padStart(2, '0'); }
function worldPromptForSend(pr) { if (!pr) return null; const { ctx, ...rest } = pr; return rest; }

function worldInteract(client, d) {
    const w = client.world, p = client.player; if (!w || !p || w.dead) return;
    if (w.ride) return;
    const pr = worldComputePrompt(client); if (!pr || pr.id !== d.id) return;
    const act = (pr.actions || []).find(a => a.a === d.a); if (!act || act.on === false) return;
    switch (pr.kind) {
        case 'bank': case 'atm': worldDeposit(client); break;
        case 'metro': sendWorld(client, 'world_metro_open', { from: { id: pr.ctx.id, name: pr.ctx.name, city: pr.ctx.city, line: pr.ctx.line, hub: pr.ctx.hub }, dests: worldMetroDests(pr.ctx) }); break;
        case 'dealer': if (act.a.startsWith('buy:')) worldBuyCar(client, act.a.slice(4)); break;
        case 'work': { const def = worldInteriorDef('work:' + pr.ctx.id); worldGoto(client, 'work:' + pr.ctx.id, def.spawn.x, def.spawn.y); break; }
        case 'house':
            if (act.a === 'buy') worldBuyHouse(client, pr.ctx);
            else { const def = worldInteriorDef('house:' + pr.ctx.hid); w.homeDoor = worldOutsideDoor(pr.ctx); worldGoto(client, 'house:' + pr.ctx.hid, def.spawn.x, def.spawn.y); }
            break;
        case 'car': worldEnterCar(client); break;
        case 'exitcar': worldExitCar(client, false); break;
        case 'exit': {
            const def = client.room.def, b = def.kind === 'house' ? WL.houseById.get(def.hid) : WL.buildingById.get(def.bid);
            const pos = b ? worldOutsideDoor(b) : WL.spawn; worldGoto(client, 'ext', pos.x, pos.y); break;
        }
        case 'reception': {
            const def = client.room.def, co = W_COMPANIES.find(c => c.id === def.coId);
            if (act.a === 'apply') { w.job = { co: co.id }; w.jobLast = w.playMs; worldNotice(client, `You're hired at ${co.name}! Complete a task at any desk at least every ${Math.round(WORLD_FIRE_MS / 60000)} minutes of play.`, { level: 'good' }); }
            else if (act.a === 'quit') { w.job = null; w.task = null; worldNotice(client, `You resigned from ${co.name}.`); }
            worldPushState(client); worldSave(client); break;
        }
        case 'desk':
            if (act.a === 'work') { w.task = { desk: pr.id, start: Date.now(), x: p.x, y: p.y }; }
            else w.task = null;
            break;
        case 'bed': worldDoRest(client); break;
    }
    w.promptKey = null;
}

// ---- join / leave / message router ---------------------------------------------------------
function worldJoin(client) {
    if (!client.dbId) { sendWorld(client, 'world_error', { message: 'Log in to play World Mode.' }); return; }
    ensureWorld();
    if (client.world) { worldSave(client); worldDetach(client); worldClients.delete(client); }
    else {
        if (client.room) client.room.clients = client.room.clients.filter(c => c !== client);
        if (client.player) { const old = client.player; if (client.room) { client.room.entities = client.room.entities.filter(e => e !== old); client.room.drones = client.room.drones.filter(d => d.owner !== old); } old.markedForDeletion = true; client.player = null; }
    }
    const saved = db.prepare('SELECT * FROM world_players WHERE user_id=?').get(client.dbId);
    let stats = [0, 0, 0, 0, 0, 0, 0, 0];
    try { const u = JSON.parse(saved?.upgrades || '{}'); if (Array.isArray(u.stats) && u.stats.length === 8) stats = u.stats; } catch { }
    const car = saved?.owned_car && WORLD_CARS.find(c => c.id === saved.owned_car) ? saved.owned_car : null;
    client.world = {
        prog: { score: saved?.score || 0, level: saved?.level || 1, statPoints: saved?.stat_points || 0, stats, tankType: saved?.tank_type || 'Basic' },
        sessionCoins: saved?.session_coins || 0, car, playMs: saved?.play_ms || 0, jobLast: saved?.job_last || 0, jobCd: saved?.job_cd || 0,
        job: saved?.job && W_COMPANIES.find(c => c.id === saved.job) ? { co: saved.job } : null,
        ext: saved ? { x: W_C + saved.x, y: W_C + saved.y } : { x: WL.spawn.x, y: WL.spawn.y },
        scene: 'ext', sentChunks: new Set(), lastTick: Date.now(), lastSave: Date.now(), bankCoins: 0, task: null, dead: false
    };
    // a player who left mid-shift while far over their deadline gets the usual grace, never an instant firing
    if (client.world.job) client.world.jobLast = Math.max(client.world.jobLast, client.world.playMs - (WORLD_FIRE_MS - 2 * 60 * 1000));
    worldClients.add(client);
    worldSendStatic(client);
    const home = worldHomeSpawn(client.dbId);
    if (home) worldGoto(client, home.scene, home.def.spawn.x, home.def.spawn.y);
    else if (saved) worldGoto(client, 'ext', client.world.ext.x, client.world.ext.y);
    else worldGoto(client, 'ext', WL.spawn.x + (Math.random() - 0.5) * 60, WL.spawn.y);
    worldRoom.worldKind = 'exterior';
    db.prepare('UPDATE world_houses SET last_seen=? WHERE owner_id=?').run(Date.now(), client.dbId);
}
function worldOnDisconnect(client) {
    const w = client.world; if (!w) return;
    if (w.ride && client.player && WL) { const st = WL.stationById.get(w.ride.to); if (st) { client.player.x = st.ex; client.player.y = st.ey; w.ext = { x: st.ex, y: st.ey }; } w.ride = null; }   // finish the trip if you log off mid-ride
    if (client.player?.vehicle) worldExitCar(client, true);
    worldSave(client); worldClients.delete(client);
    worldDetach(client); client.world = null;
}
function worldHandle(client, d) {
    const w = client.world; if (!w || !client.dbId) return;
    if (d.type === 'world_interact') worldInteract(client, { id: String(d.id), a: String(d.a) });
    else if (d.type === 'world_leave') { worldOnDisconnect(client); }
    else if (d.type === 'world_nav') worldNav(client, String(d.t), d);
    else if (d.type === 'world_metro') worldMetroGo(client, d);
    else if (d.type === 'world_map' && WL) sendWorld(client, 'world_map', { p: worldMapPlaces() });
}
// Road graph for the satnav: nodes are junctions, edges join neighbouring junctions on the same road line.
function worldNavGraph() {
    if (WL.navG) return WL.navG;
    const nodes = [], byV = new Map(), byH = new Map(), segs = [];
    for (const j of WL.junctions.concat(WL.xjunctions || [])) {
        const n = { x: j.x, y: j.y, kx: Math.round((j.x - W_C) / W_S), ky: Math.round((j.y - W_C) / W_S), adj: [] };
        nodes.push(n);
        if (!byV.has(n.kx)) byV.set(n.kx, []); byV.get(n.kx).push(n);
        if (!byH.has(n.ky)) byH.set(n.ky, []); byH.get(n.ky).push(n);
    }
    const link = (arr, ax) => {
        arr.sort((a, b) => a[ax] - b[ax]);
        const hwa = ax === 'y' ? 'v' : 'h';
        for (let i = 0; i + 1 < arr.length; i++) {
            const a = arr[i], b = arr[i + 1], d = Math.hypot(a.x - b.x, a.y - b.y), line = ax === 'y' ? a.x : a.y;
            if (d > 3700 && !(WL.highways || []).some(h => h.a === hwa && Math.abs(h.p - line) < 1 && h.s0 - 1 <= a[ax] && b[ax] <= h.s1 + 1)) continue;   // no road there
            a.adj.push([b, d]); b.adj.push([a, d]); segs.push({ a, b }); }
    };
    for (const arr of byV.values()) link(arr, 'y');
    for (const arr of byH.values()) link(arr, 'x');
    return (WL.navG = { nodes, segs });
}
function navSnap(g, x, y) {
    let best = null, bd = Infinity;
    for (const sg of g.segs) {
        const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y, t = Math.max(0, Math.min(1, ((x - sg.a.x) * dx + (y - sg.a.y) * dy) / (dx * dx + dy * dy)));
        const px = sg.a.x + dx * t, py = sg.a.y + dy * t, d = Math.hypot(x - px, y - py);
        if (d < bd) { bd = d; best = { sg, x: px, y: py }; }
    }
    return best;
}
// Returns { pts: [[x,y]...], turns: ['', 'left', ..., 'arrive'], len } following the roads from `from` to `to`.
function worldRoute(from, to) {
    const g = worldNavGraph(), A = navSnap(g, from.x, from.y), B = navSnap(g, to.x, to.y); if (!A || !B) return null;
    let mid = [];
    if (A.sg !== B.sg) {
        const dist = new Map(), prev = new Map(), done = new Set(), heap = [];
        const hpush = it => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
        const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
        for (const n of [A.sg.a, A.sg.b]) { const d = Math.hypot(n.x - A.x, n.y - A.y); dist.set(n, d); hpush([d, n]); }
        const ends = [B.sg.a, B.sg.b].map(n => [n, Math.hypot(n.x - B.x, n.y - B.y)]);
        while (heap.length) {
            const [d, n] = hpop(); if (done.has(n)) continue; done.add(n);
            if (ends.every(e => done.has(e[0]))) break;
            for (const [m, w] of n.adj) { const nd = d + w; if (nd < (dist.get(m) ?? Infinity)) { dist.set(m, nd); prev.set(m, n); hpush([nd, m]); } }
        }
        let endN = null, bt = Infinity;
        for (const [n, e] of ends) { const t = (dist.get(n) ?? Infinity) + e; if (t < bt) { bt = t; endN = n; } }
        if (!endN) return null;
        for (let n = endN; n; n = prev.get(n)) mid.push(n);
        mid.reverse();
    }
    let poly = [[from.x, from.y], [A.x, A.y], ...mid.map(n => [n.x, n.y]), [B.x, B.y], [to.x, to.y]];
    poly = poly.filter((p, i) => !i || Math.hypot(p[0] - poly[i - 1][0], p[1] - poly[i - 1][1]) > 1);
    if (poly.length < 2) return null;
    const n = poly.length, turns = new Array(n).fill('');
    for (let i = 2; i < n - 2; i++) {                      // skip the join/leave points at either end
        const ax = poly[i][0] - poly[i - 1][0], ay = poly[i][1] - poly[i - 1][1], bx = poly[i + 1][0] - poly[i][0], by = poly[i + 1][1] - poly[i][1];
        const l = Math.hypot(ax, ay) * Math.hypot(bx, by) || 1, cr = (ax * by - ay * bx) / l, dt = (ax * bx + ay * by) / l;
        if (dt < -0.8) turns[i] = 'uturn'; else if (Math.abs(cr) >= 0.35 || dt < 0) turns[i] = cr > 0 ? 'right' : 'left';
    }
    turns[n - 1] = 'arrive';
    const pts = [], tn = []; let len = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        if (i <= 1 || i >= n - 2 || turns[i]) { pts.push([Math.round(poly[i][0]), Math.round(poly[i][1])]); tn.push(turns[i]); }
    }
    return { pts, turns: tn, len: Math.round(len) };
}
// Satnav: nearest workplace of your employer (any company if unemployed), your first house, or your parked car.
function worldMetroDests(from) {
    const out = [];
    for (const st of WL.stations) {
        if (st === from) continue;
        const same = st.city === from.city; if (!same && !(from.hub && st.hub)) continue;     // intercity express runs hub to hub
        const d = Math.hypot(st.x - from.x, st.y - from.y);
        out.push({ id: st.id, name: st.name, city: st.city, line: st.line, hub: st.hub, fare: same ? 8 + Math.round(d / 1500) : 60 + Math.round(d / 6000), secs: same ? Math.round(5 + d / 1800) : Math.round(20 + d / 3500) });
    }
    return out;
}
function worldMetroGo(client, d) {
    const w = client.world, p = client.player; if (!w || !p || w.dead || w.ride || p.vehicle || w.scene !== 'ext' || !WL) return;
    const pr = worldComputePrompt(client); if (!pr || pr.kind !== 'metro') return;
    const to = WL.stationById.get(String(d.to)), opt = to && worldMetroDests(pr.ctx).find(o => o.id === to.id); if (!opt) return;
    if (!worldPayToll(client, opt.fare)) { worldNotice(client, `A ticket to ${to.name} costs ${opt.fare} coins (cash or bank).`, { level: 'bad' }); return; }
    w.ride = { to: to.id, end: Date.now() + opt.secs * 1000, fx: p.x, fy: p.y };
    sendWorld(client, 'world_ride', { from: pr.ctx.name, to: to.name, line: to.line, secs: opt.secs, fare: opt.fare, intercity: to.city !== pr.ctx.city });
}
function worldMapPlaces() {
    if (WL.mapJ) return WL.mapJ;
    const P = [], names = { bank: 'Central Bank', dealer: 'Car Dealership', hall: 'City Hall', mall: 'Shopping Mall', school: 'School' };
    for (const b of WL.buildings) {
        if (b.work) P.push(['w', b.door.x, b.door.y, b.sign, b.col]);
        else if (names[b.k]) P.push([b.k, b.door.x, b.door.y, names[b.k]]);
    }
    for (const p of WL.props) if (p.k === 'atm') P.push(['a', p.x + 13, p.y + 7, 'ATM']);
    for (const st of WL.stations) P.push(['m', st.x, st.y, st.name, st.line, st.city, st.hub ? 1 : 0]);
    return (WL.mapJ = P);
}
function worldNav(client, t, d = {}) {
    const w = client.world, p = client.player; if (!w || !p || !WL || w.scene !== 'ext') return;
    let tgt = null;
    if (t === 'work') {
        const co = w.job?.co; let bd = Infinity;
        for (const b of WL.works) { if (co && b.work !== co) continue; const d = Math.hypot(b.door.x - p.x, b.door.y - p.y); if (d < bd) { bd = d; tgt = { x: b.door.x, y: b.door.y, label: b.sign || 'Workplace' }; } }
    } else if (t === 'atm' || t === 'bank' || t === 'dealer') {
        const list = t === 'atm' ? worldMapPlaces().filter(q => q[0] === 'a') : worldMapPlaces().filter(q => q[0] === t); let bd = Infinity;
        for (const q of list) { const dd = Math.hypot(q[1] - p.x, q[2] - p.y); if (dd < bd) { bd = dd; tgt = { x: q[1], y: q[2], label: q[3] }; } }
    } else if (t === 'pin') {
        const x = +d.x, y = +d.y; if (isFinite(x) && isFinite(y)) tgt = { x: Math.round(clamp(x, W_SHORE, W_EXT - W_SHORE)), y: Math.round(clamp(y, W_SHORE, W_EXT - W_SHORE)), label: String(d.label || 'Destination').slice(0, 40) };
    } else if (t === 'home') {
        const hid = worldFirstHouse(client.dbId), b = hid && WL.houseById.get(hid); if (b) tgt = { x: b.door.x, y: b.door.y, label: 'Home' };
    } else if (t === 'car') {
        const pc = parkedCars.get(client.dbId); if (pc && !pc.driven) tgt = { x: Math.round(pc.x), y: Math.round(pc.y), label: 'Your car' };
    }
    sendWorld(client, 'world_nav', { t, tgt, route: tgt ? worldRoute({ x: p.x, y: p.y }, tgt) : null });
}
function worldOnPlayerDeath(owner, e) {
    const w = owner.world; if (!w || w.dead) return;
    w.dead = true; w.task = null; w.sessionCoins = 0;
    if (e.vehicle) { e.vehicle = null; e.ghost = false; const pc = parkedCars.get(owner.dbId); if (pc) pc.driven = false; }
    // Progress resets on death (permanent stat upgrades are kept, as before); unbanked cash is lost.
    w.prog = { score: 0, level: 1, statPoints: 0, stats: [...e.stats], tankType: 'Basic' };
    w.respawnAt = Date.now() + 60;
    sendWorld(owner, 'world_death', { reason: 'Your tank was destroyed. Unbanked cash lost.' });
}

// ---- farms: shapes only exist inside designated fields ------------------------------------------
const FARM_SHAPE_WEIGHTS = { farm: [['square', 62], ['triangle', 28], ['pentagon', 9], ['hexagon', 1]], ranch: [['square', 40], ['triangle', 35], ['pentagon', 22], ['hexagon', 3]] };
function worldPickShape(kind) { const t = FARM_SHAPE_WEIGHTS[kind] || FARM_SHAPE_WEIGHTS.farm; let r = Math.random() * 100; for (const [n, wgt] of t) { if ((r -= wgt) < 0) return n; } return 'square'; }
const fieldLastActive = new Map();
function worldFarmTick() {
    if (!WL) return;
    const now = Date.now(), active = new Set();
    for (const c of worldClients) {
        const p = c.player; if (!p || c.world?.scene !== 'ext') continue;
        const cx = clamp(Math.floor(p.x / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor(p.y / W_CHUNK), 0, W_NCH - 1);
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
            const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (!ch) continue;
            for (const f of ch.fields) if ((f.kind === 'farm' || f.kind === 'ranch') && rectDist(p.x, p.y, f) < 2400) { active.add(f.id); fieldLastActive.set(f.id, now); }
        }
    }
    const counts = new Map(); let total = 0;
    for (const e of worldRoom.entities) if (e.fieldId) { counts.set(e.fieldId, (counts.get(e.fieldId) || 0) + 1); total++; }
    // spawn into active fields (a few per second so shapes appear gradually, never in a burst)
    for (const id of active) {
        const f = WL.fieldById.get(id), have = counts.get(id) || 0;
        for (let i = have, n = 0; i < f.target && n < 4 && total < 1600; i++, n++, total++) {
            const sx = f.x + 30 + Math.random() * Math.max(1, f.w - 60), sy = f.y + 30 + Math.random() * Math.max(1, f.h - 60);
            const shape = new Entity(worldRoom, sx, sy, worldPickShape(f.kind));
            if (Math.random() < POWERUP_SPAWN_CHANCE) { shape.type = 'powerup'; shape.powerupType = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)]; shape.hp = 550; shape.maxHp = 550; shape.radius = 30; shape.xpVal = 4000; }
            shape.fieldId = id; shape.noReward = true; shape.xpAwarded = true; worldRoom.entities.push(shape);
        }
    }
    // keep shapes inside their field (knock-back can push them out) and cull fields nobody is near
    for (const e of worldRoom.entities) {
        if (!e.fieldId) continue;
        const f = WL.fieldById.get(e.fieldId);
        if (!active.has(e.fieldId) && now - (fieldLastActive.get(e.fieldId) || 0) > 25000) { e.markedForDeletion = true; e.hp = 0; e.xpAwarded = true; e.noReward = true; continue; }
        const nx = clamp(e.x, f.x + 14, f.x + f.w - 14), ny = clamp(e.y, f.y + 14, f.y + f.h - 14);
        if (nx !== e.x || ny !== e.y) { e.x = nx; e.y = ny; e.vx = 0; e.vy = 0; }
    }
}

// ---- NPC traffic and pedestrians --------------------------------------------------------------------
function worldChunkList(x, y, R, name) {
    const cx = clamp(Math.floor(x / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor(y / W_CHUNK), 0, W_NCH - 1), out = [];
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) { const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (ch) for (const o of ch[name]) out.push(o); }
    return out;
}
function worldAssignRoad(car, road, dir, fromS) {
    car.road = road; car.dir = dir;
    const hv = road.hw, lane = road.ln === 4 ? (Math.random() < 0.5 ? 0.3 : 0.72) : 0.5; car.off = hv * lane;
    const nodes = roadNodes.get(road.a + road.k); let next = null;
    if (dir > 0) { for (let i = 0; i < nodes.length; i++) if (nodes[i] > fromS + 8) { next = nodes[i]; break; } }
    else for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i] < fromS - 8) { next = nodes[i]; break; }
    if (next != null && Math.abs(next - W_C) > W_C - W_SHORE - 100) next = null;   // traffic never drives into the sea
    car.nextS = next;
    if (next == null) return false;
    // plan the manoeuvre at the next junction now, so the car can slow for a turn
    const jx = road.a === 'v' ? road.k : Math.round((next - W_C) / W_S), jy = road.a === 'v' ? Math.round((next - W_C) / W_S) : road.k;
    const j = junctionMap.get(jx + ',' + jy); const opts = [];
    if (j) {
        const hx = road.a === 'v' ? 0 : dir, hy = road.a === 'v' ? dir : 0;
        const arms = [{ dx: 0, dy: -1, ok: j.n > 0 }, { dx: 0, dy: 1, ok: j.s > 0 }, { dx: -1, dy: 0, ok: j.w > 0 }, { dx: 1, dy: 0, ok: j.e > 0 }];
        for (const a of arms) { if (!a.ok || (a.dx === -hx && a.dy === -hy && (a.dx || a.dy))) continue; opts.push({ dx: a.dx, dy: a.dy, wgt: (a.dx === hx && a.dy === hy) ? 6 : 2 }); }
        if (!opts.length) opts.push({ dx: -hx, dy: -hy, wgt: 1 });
        let r = Math.random() * opts.reduce((s, o) => s + o.wgt, 0), pick = opts[0];
        for (const o of opts) { if ((r -= o.wgt) < 0) { pick = o; break; } }
        car.plan = pick; car.jx = jx; car.jy = jy; car.turning = !(pick.dx === hx && pick.dy === hy);
    } else car.plan = null;
    return true;
}
function worldSpawnTraffic(client) {
    const p = client.player; if (!p) return;
    const zone = worldZone(p.x, p.y), want = [18, 14, 8, 3][zone];
    let near = 0; for (const t of traffic) if (Math.abs(t.x - p.x) < 2800 && Math.abs(t.y - p.y) < 2800) near++;
    if (near >= want || traffic.length >= 110) return;
    const cands = worldChunkList(p.x, p.y, 2, 'junctions').filter(j => { const d = Math.hypot(j.x - p.x, j.y - p.y); return !j.f && d > 1500 && d < 2900; });
    if (!cands.length) return;
    const j = cands[Math.floor(Math.random() * cands.length)];
    const arms = [{ dx: 0, dy: -1, ok: j.n > 0 }, { dx: 0, dy: 1, ok: j.s > 0 }, { dx: -1, dy: 0, ok: j.w > 0 }, { dx: 1, dy: 0, ok: j.e > 0 }].filter(a => a.ok);
    if (!arms.length) return;
    const a = arms[Math.floor(Math.random() * arms.length)];
    const kx = Math.round((j.x - W_C) / W_S), ky = Math.round((j.y - W_C) / W_S);
    const road = a.dx ? WL.rh[ky] : WL.rv[kx], dir = a.dx ? a.dx : a.dy, fromS = a.dx ? j.x : j.y;
    const car = { id: worldNextDyn++, x: 0, y: 0, a: Math.atan2(a.dy, a.dx), v: 0, max: 3.4 + Math.random() * 1.9, c: Math.floor(Math.random() * WORLD_CAR_COLORS.length), t: Math.floor(Math.random() * 3), stuck: 0, lastHit: 0 };
    if (!worldAssignRoad(car, road, dir, fromS + dir * 150)) return;
    const hx = a.dx, hy = a.dy, off = car.off;
    car.x = j.x + hx * 150 + (-hy) * off; car.y = j.y + hy * 150 + hx * off;
    for (const t of traffic) if (Math.hypot(t.x - car.x, t.y - car.y) < 110) return;
    traffic.push(car);
}
function worldTrafficStep() {
    const clients = [...worldClients].filter(c => c.player && c.world && c.world.scene === 'ext');
    if (!clients.length) { traffic.length = 0; peds.length = 0; return; }
    if (Math.random() < 0.5) for (const c of clients) worldSpawnTraffic(c);
    const now = Date.now(), STEP = 3;
    // obstacles cars must brake for: tanks on foot, driven cars, other owners' parked cars
    const obs = [];
    for (const c of clients) { const p = c.player; obs.push({ x: p.x, y: p.y, r: p.vehicle ? 24 : p.radius + 4, tank: p.vehicle ? null : p }); }
    for (const pc of parkedCars.values()) if (!pc.driven) obs.push({ x: pc.x, y: pc.y, r: 22 });
    for (let i = traffic.length - 1; i >= 0; i--) {
        const car = traffic[i];
        if (!clients.some(c => Math.abs(c.player.x - car.x) < 3800 && Math.abs(c.player.y - car.y) < 3800) || car.stuck > 200 || car.nextS == null) { traffic.splice(i, 1); continue; }
        const road = car.road, axis = road.a, hx = axis === 'v' ? 0 : car.dir, hy = axis === 'v' ? car.dir : 0;
        // steer toward the lane centre-line a little way ahead
        const s = axis === 'v' ? car.y : car.x, ahead = s + car.dir * 80;
        const tx = axis === 'v' ? road.p + (-hy) * car.off : ahead, ty = axis === 'v' ? ahead : road.p + hx * car.off;
        const want = Math.atan2(ty - car.y, tx - car.x);
        car.a += clamp(angDiff(want, car.a), -0.16, 0.16);
        // speed: slow for turns and for anything in front
        let target = car.max; const distNode = Math.abs(car.nextS - s);
        if (car.turning && distNode < 150) target = Math.min(target, 1.6 + distNode * 0.012);
        const cs = Math.cos(car.a), sn = Math.sin(car.a);
        const check = (ox, oy, r) => {
            const dx = ox - car.x, dy = oy - car.y; if (dx * dx + dy * dy > 40000) return;
            const f = dx * cs + dy * sn, l = Math.abs(-dx * sn + dy * cs);
            if (f > 0 && f < 60 + car.v * 22 && l < r + 22) { const gap = f - (r + 26); target = Math.min(target, gap < 6 ? 0 : gap * 0.09); }
        };
        for (const o of obs) check(o.x, o.y, o.r);
        for (const t of traffic) if (t !== car) check(t.x, t.y, 20);
        car.v += (target - car.v) * (target < car.v ? 0.35 : 0.08);
        if (car.v < 0.05 && target < 0.1) car.stuck++; else car.stuck = 0;
        car.x += cs * car.v * STEP; car.y += sn * car.v * STEP;
        // hit someone on foot
        if (car.v > 1.2 && now - car.lastHit > 600) {
            for (const o of obs) if (o.tank && Math.hypot(o.x - car.x, o.y - car.y) < o.r + 22 && now > (o.tank.lastCarHit || 0) + 700) {
                o.tank.lastCarHit = now; o.tank.hp -= 14 + car.v * 5; o.tank.lastDamageTime = now; o.tank.vx += cs * car.v; o.tank.vy += sn * car.v; car.v = 0; car.lastHit = now;
            }
        }
        // reached the junction: commit to the planned manoeuvre
        const sNow = axis === 'v' ? car.y : car.x;
        if ((sNow - car.nextS) * car.dir >= 0) {
            const plan = car.plan;
            if (!plan) { traffic.splice(i, 1); continue; }
            const nroad = plan.dx ? WL.rh[car.jy] : WL.rv[car.jx];
            const ndir = plan.dx ? plan.dx : plan.dy, from = plan.dx ? car.nextS : car.nextS;
            const jxS = plan.dx ? (W_C + car.jx * W_S) : (W_C + car.jy * W_S);
            if (!nroad || !worldAssignRoad(car, nroad, ndir, jxS)) traffic.splice(i, 1);
        }
    }
    // pedestrians walk along pavements
    for (let i = peds.length - 1; i >= 0; i--) {
        const pd = peds[i];
        if (!clients.some(c => Math.abs(c.player.x - pd.x) < 2800 && Math.abs(c.player.y - pd.y) < 2800)) { peds.splice(i, 1); continue; }
        pd.t += pd.dir * pd.sp * STEP; if (Math.random() < 0.004) pd.dir *= -1;
        const q = worldLoopPos(pd.blk, pd.t); pd.x = q[0]; pd.y = q[1];
    }
    if (Math.random() < 0.6) for (const c of clients) worldSpawnPed(c);
}
function worldLoopPos(b, t) {
    const o = b.sw / 2, x0 = b.x + o, y0 = b.y + o, w = b.w - 2 * o, h = b.h - 2 * o, P = 2 * (w + h);
    t = ((t % P) + P) % P;
    if (t < w) return [x0 + t, y0]; t -= w; if (t < h) return [x0 + w, y0 + t]; t -= h; if (t < w) return [x0 + w - t, y0 + h]; t -= w; return [x0, y0 + h - t];
}
function worldSpawnPed(client) {
    const p = client.player, zone = worldZone(p.x, p.y), want = [20, 14, 8, 0][zone];
    if (!want || peds.length >= 160) return;
    let near = 0; for (const q of peds) if (Math.abs(q.x - p.x) < 2200 && Math.abs(q.y - p.y) < 2200) near++;
    if (near >= want) return;
    const blocks = worldChunkList(p.x, p.y, 1, 'blocks').filter(b => b.sw > 0 && b.g !== 'farm' && Math.hypot(b.x + b.w / 2 - p.x, b.y + b.h / 2 - p.y) > 700);
    if (!blocks.length) return;
    const blk = blocks[Math.floor(Math.random() * blocks.length)], P = 2 * (blk.w + blk.h - 2 * blk.sw), t = Math.random() * P, q = worldLoopPos(blk, t);
    peds.push({ id: worldNextDyn++, blk, t, dir: Math.random() < 0.5 ? 1 : -1, sp: 0.35 + Math.random() * 0.4, skin: Math.floor(Math.random() * 8), x: q[0], y: q[1] });
}
function worldBroadcastDyn() {
    for (const c of worldClients) {
        const p = c.player; if (!p || !c.world || c.world.scene !== 'ext' || c.ws.readyState !== WebSocket.OPEN) continue;
        const R = 2600 * Math.max(1, worldViewScale(p) / 1.5 + 0.35), cars = [], pd = [];
        for (const t of traffic) if (Math.abs(t.x - p.x) < R && Math.abs(t.y - p.y) < R) cars.push([t.id, Math.round(t.x), Math.round(t.y), Math.round(t.a * 100) / 100, t.c, t.t]);
        for (const pc of parkedCars.values()) if (!pc.driven && Math.abs(pc.x - p.x) < R && Math.abs(pc.y - p.y) < R)
            cars.push([-pc.pid, Math.round(pc.x), Math.round(pc.y), Math.round(pc.a * 100) / 100, WORLD_CARS.findIndex(m => m.id === pc.model), 3 + (pc.uid === c.dbId ? 1 : 0)]);
        for (const q of peds) if (Math.abs(q.x - p.x) < R && Math.abs(q.y - p.y) < R) pd.push([q.id, Math.round(q.x), Math.round(q.y), q.skin]);
        c.ws.send(JSON.stringify({ type: 'world_dyn', cars, peds: pd }));
    }
}

// ---- main world loop (20 Hz) ------------------------------------------------------------------------
let worldTickN = 0;
setInterval(() => {
    if (!WL) return;
    worldTickN++;
    const now = Date.now();
    worldTrafficStep();
    if (worldTickN % 2 === 0) worldBroadcastDyn();
    if (worldTickN % 20 === 0) { worldFarmTick(); }
    if (worldTickN % 1200 === 0) worldExpireHouses();
    if (worldTickN % 100 === 0) for (const [k, r] of Object.entries(interiorRooms)) if (!r.clients.length && r.emptySince && now - r.emptySince > 20000) delete interiorRooms[k];
    for (const c of [...worldClients]) {
        const w = c.world; if (!w) continue;
        const dt = now - w.lastTick; w.lastTick = now; w.playMs += dt;
        if (w.dead && now >= w.respawnAt) { worldSpawnNewlyOrAfterDeath(c); worldSave(c); continue; }
        const p = c.player; if (!p) continue;
        if (w.ride) {                                                   // on the train: held at the station until the ride ends
            const r = w.ride; w.invulnerableUntil = now + 1500; p.x = r.fx; p.y = r.fy; p.vx = p.vy = 0;
            if (now >= r.end) {
                const st = WL.stationById.get(r.to), pos = { x: st.ex, y: st.ey }; layoutPushOut(WL, pos, p.radius);
                w.ride = null; p.x = pos.x; p.y = pos.y; w.ext = { x: p.x, y: p.y }; w.invulnerableUntil = now + 2500;
                sendWorld(c, 'world_ride_end', {}); worldNotice(c, `Arrived at ${st.name}.`, { level: 'good' }); worldSave(c);
            }
            continue;
        }
        // work task progress
        if (w.task) {
            const def = c.room.def, st = def?.stations.find(s => s.id === w.task.desk), co = worldEmployer(w);
            if (!st || !co || Math.hypot(st.x - p.x, st.y - p.y) > st.r + 30) { w.task = null; worldNotice(c, 'You left your desk – task cancelled.'); sendWorld(c, 'world_task', { p: -1 }); }
            else {
                const prog = (now - w.task.start) / WORLD_TASK_MS;
                if (prog >= 1) { w.task = null; const pay = worldPayFor(co, w.ext); w.sessionCoins += pay; w.jobLast = w.playMs; sendWorld(c, 'world_task', { p: -1 }); worldNotice(c, `Task complete: +${pay} coins (unbanked)`, { level: 'good', sessionCoins: w.sessionCoins }); worldPushState(c); worldSave(c); }
                else if (worldTickN % 2 === 0) sendWorld(c, 'world_task', { p: Math.round(prog * 100) / 100 });
            }
        }
        // prompts
        if (worldTickN % 3 === 0) {
            const pr = worldPromptForSend(worldComputePrompt(c)), key = pr ? JSON.stringify(pr) : '';
            if (key !== (w.promptKey || '')) { w.promptKey = key; sendWorld(c, 'world_prompt', { p: pr }); }
        }
        // job deadline
        const co = worldEmployer(w);
        if (co && worldTickN % 20 === 0) {
            const left = WORLD_FIRE_MS - (w.playMs - w.jobLast);
            if (left <= 0) worldFire(c);
            else for (const th of WORLD_WARN_MS) if (left <= th && (w.warned || Infinity) > th) { w.warned = th; worldNotice(c, `Warning: you will be fired from ${co.name} in ${worldFmtMs(left)} unless you complete a task at your desk.`, { level: 'warn' }); }
            if (left > WORLD_WARN_MS[0]) w.warned = Infinity;
        }
        if (worldTickN % 20 === 0) { w.bankCoins = worldBankCoins(c); worldPushState(c); }
        if (w.scene === 'ext' && !p.vehicle) w.ext = { x: p.x, y: p.y };
        if (w.scene === 'ext' && worldTickN % 10 === 0) worldStreamChunks(c);
        if (now - w.lastSave > WORLD_SAVE_MS) worldSave(c);
    }
}, 50);
ensureWorld();

// ===================== WEBSOCKET CONNECTION HANDLER =====================

wss.on('connection', (ws, req) => {
    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = rawIp

    const isBanned = db.prepare("SELECT * FROM banned_ips_v2 WHERE ip_hash = ?").get(ipHash);
    if (isBanned) {
        ws.close(4000, "Banned");
        return;
    }

    let client = { ws: ws, player: null, room: null, spectatingId: null, ipHash: ipHash, country: 'xx' };

    if (rawIp && !rawIp.includes('127.0.0.1') && !rawIp.includes('::1') && !rawIp.startsWith('192.168.')) {
        fetch(`http://ip-api.com/json/${rawIp}?fields=status,countryCode`)
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    client.country = data.countryCode.toLowerCase();
                }
            })
            .catch(err => console.error("GeoIP lookup failed:", err));
    }

    ws.on('message', (message, isBinary) => {
    let data;

    try {
        if (isBinary) {
            const buffer = Buffer.from(message);
            const view = new DataView(
                buffer.buffer,
                buffer.byteOffset,
                buffer.byteLength
            );

            const messageType = view.getUint8(0);

            switch (messageType) {
                case 1: {
                    const flags = view.getUint8(1);

                    data = {
                        type: 'input',
                        up: !!(flags & 1),
                        down: !!(flags & 2),
                        left: !!(flags & 4),
                        right: !!(flags & 8),
                        shooting: !!(flags & 16),
                        repel: !!(flags & 32),
                        angle: view.getFloat32(2, true),
                        mouseX: view.getFloat32(6, true),
                        mouseY: view.getFloat32(10, true)
                    };

                    break;
                }

                default:
                    return;
            }
        } else {
            data = JSON.parse(message.toString());
        }
    } catch (err) {
        console.error('Malformed packet:', err);
        return;
    }

    if (!data) return;


        if (data.type === 'world_join') { worldJoin(client); return; }
        if (data.type && data.type.startsWith('world_') && data.type !== 'world_join') { worldHandle(client,data); return; }
        if(data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', time: data.time, locationl: SERVER_LOCATION }));
            client.lastPingTime = data.time;
        }
        else if (data.type === 'spectate') {
            if (client.room) {
                client.room.clients = client.room.clients.filter(c => c !== client);
            }
            const roomId = `${data.mode}-${data.region}`;
            client.room = rooms[roomId];
            const roomToJoin = rooms[roomId];
            if (!roomToJoin || roomToJoin.status === 'stopped') return;
            client.room.clients.push(client);
        }
        else if (data.type === 'spawn') {
            const room = client.room;
            if (!room || room.status === 'stopped') return;
            let team;
            if (room.mode === "2TDM") team = Math.random() > 0.5 ? 1 : 2;
            else if (room.mode === "4TDM") team = Math.floor(Math.random() * 4) + 1;
            else team = room.nextEntityId + 100;

            let px, py;
            if (room.mode === "2TDM") {
                px = team === 1 ? 200 : WORLD_SIZE - 200;
                py = Math.random() * WORLD_SIZE;
            } else if (room.mode === "4TDM") {
                let offset = 300;
                if (team === 1) { px = offset; py = offset; }
                else if (team === 2) { px = WORLD_SIZE - offset; py = WORLD_SIZE - offset; }
                else if (team === 3) { px = WORLD_SIZE - offset; py = offset; }
                else if (team === 4) { px = offset; py = WORLD_SIZE - offset; }
            } else {
                do {
                    px = Math.random() * WORLD_SIZE;
                    py = Math.random() * WORLD_SIZE;
                } while (Math.abs(px - WORLD_SIZE/2) < 800 && Math.abs(py - WORLD_SIZE/2) < 800);
            }
            
            client.player = new Entity(room, px, py, 'tank', data.name || "Unnamed", team, true, ws);
            if (sandboxMode) {
                client.player.addXP(SANDBOX_SPAWN_SCORE);
            }
            client.spectatingId = null;
            if (client.dbId) {
                let user = db.prepare("SELECT selected_color FROM users WHERE id = ?").get(client.dbId);
                if (user) {
                    client.player.nameColor = user.selected_color;
                }
            }
            room.entities.push(client.player);
            
            ws.send(JSON.stringify({ type: 'init', id: client.player.id, team: team, nc: client.player.nameColor, name1: client.player.name }));
        }
        else if (data.type === 'input' && client.player && !client.player.markedForDeletion) {
            client.player.inputs = data;
        }
        else if (data.type === 'upgradeStat' && client.player && !client.player.markedForDeletion) {
            let i = data.statIndex;
            if(Number.isInteger(i) && i >= 0 && i < 8 && client.player.statPoints > 0 && client.player.stats[i] < 7) {
                client.player.stats[i]++; client.player.statPoints--;
                if(client.room?.mode === 'WORLD' && client.world) worldSave(client);
            }
        }
        else if (data.type === 'upgradeTank' && client.player && !client.player.markedForDeletion) {
            const player = client.player;
            if (player.level < 15 && data.tank !== 'Basic') return;
            if (player.level < 30 && (data.tank === 'Overlord' || data.tank === 'Manager')) return;
            const current = player.tankType;
            const possible = UPGRADE_TREE[current] || [];
            if (!possible.includes(data.tank)) return;
            
            player.tankType = data.tank;
            player.barrelTimers = [];
            if (client.room?.mode === 'WORLD' && client.world) worldSave(client);
        }
        if (data.type === 'auth_login') {
            let user = db.prepare("SELECT * FROM users WHERE session_token = ?").get(data.token);
            if (user) {
                client.dbId = user.id;
                if (client.player) client.player.nameColor = user.selected_color;
                client.ws.send(JSON.stringify({ type: 'profile_update', profile: user }));
            }
        }

        if (data.type === 'buy_item') {
            if (!client.dbId) return;
            let user = db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId);
            let unlocked = JSON.parse(user.unlocked_colors);
            
            if (data.category === 'colors') {
                let item = SHOP_ITEMS.colors.find(i => i.id === data.itemId);
                if (item && user.coins >= item.cost && !unlocked.includes(item.id)) {
                    unlocked.push(item.id);
                    db.prepare("UPDATE users SET coins = coins - ?, unlocked_colors = ? WHERE id = ?")
                      .run(item.cost, JSON.stringify(unlocked), client.dbId);
                    client.ws.send(JSON.stringify({ type: 'profile_update', profile: db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId) }));
                }
            }
        }

        if (data.type === 'equip_item') {
            if (!client.dbId) return;
            let user = db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId);
            let unlocked = JSON.parse(user.unlocked_colors);
            
            if (data.category === 'colors' && unlocked.includes(data.itemId)) {
                db.prepare("UPDATE users SET selected_color = ? WHERE id = ?").run(data.itemId, client.dbId);
                if (client.player) client.player.nameColor = data.itemId;
                client.ws.send(JSON.stringify({ type: 'profile_update', profile: db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId) }));
            }
        }
    });

    ws.on('close', () => {
        if (client.world) { worldOnDisconnect(client); }
        if (client.player) {
            // Immediately remove the player entity from the room so it leaves no hitbox
            // and doesn't appear in broadcasts or the room-players API
            if (client.room) {
                client.room.entities = client.room.entities.filter(e => e !== client.player);
                // Also clean up any drones owned by this player
                client.room.drones = client.room.drones.filter(d => {
                    if (d.owner === client.player) {
                        if (client.player.activeDrones > 0) client.player.activeDrones--;
                        return false;
                    }
                    return true;
                });
            }
            client.player.markedForDeletion = true;
            client.player = null;
        }
        if (client.room) client.room.clients = client.room.clients.filter(c => c !== client);
    });
});

// ===================== BROADCAST INTERVAL =====================

let tickCount = 0;

setInterval(() => {
    tickCount++;
    let shouldSend = (tickCount % 2 === 0);

    if (!shouldSend) return;

    allRooms().forEach(room => {
        if (room.status === 'stopped') return;
        room.clients.forEach(c => {
            if(c.ws.readyState === WebSocket.OPEN) {
                
                let focalX = room.mode === 'WORLD' ? W_C : WORLD_SIZE / 2;
                let focalY = room.mode === 'WORLD' ? W_C : WORLD_SIZE / 2;

                if (c.player && !c.player.markedForDeletion) {
                    focalX = c.player.x; focalY = c.player.y;
                } else if (c.spectatingId) {
                    let specTarget = room.entities.find(en => en.id === c.spectatingId);
                    if (specTarget) { focalX = specTarget.x; focalY = specTarget.y; }
                }

                let payloadEntities = [], payloadBullets = [], payloadDrones = [];
                // World mode zooms out as you grow / drive, so the area we send grows with it (and is square).
                const VD = VIEW_DISTANCE * ((room.mode === 'WORLD' && c.player) ? worldViewScale(c.player) : 1);
                const VDY = room.mode === 'WORLD' ? VD : VD / 1.8;

                let nearby = room.grid.getNearby(focalX, focalY, VD);
                let processedEntities = new Set();

                for (let i = 0; i < room.entities.length; i++) {
                    let e = room.entities[i];
                    if (e.markedForDeletion) continue;
                    if (['tank', 'ai'].includes(e.type)) {
                        processedEntities.add(e.id);
                        let isVisible = Math.abs(e.x - focalX) < VD && 
                                        Math.abs(e.y - focalY) < VDY;

                        // Invisible Manager: hide coordinates from everyone except the player themselves.
                        // This prevents scripted clients from tracking the manager's position.
                        const isSelf = (c.player === e);
                        const isInvisible = !isSelf && e.tankType === 'Manager' && e.opacity < 0.15;

                        payloadEntities.push({
                            id: e.id, 
                            x: (isVisible && !isInvisible) ? Math.round(e.x) : null, 
                            y: (isVisible && !isInvisible) ? Math.round(e.y) : null, 
                            powerupType: e.powerupType || null,
                            type: e.type, team: e.team, hp: e.hp, maxHp: e.maxHp, 
                            radius: e.radius, angle: Math.round(e.angle * 100) / 100, tankType: e.tankType, 
                            name: e.name, score: e.score, nameColor: e.nameColor,
                            inView: isVisible && !isInvisible,
                            opacity: (e.opacity !== undefined) ? Math.round(e.opacity * 100) / 100 : 1,
                            powerups: getActivePowerups(e),
                            veh: e.vehicle ? { a: Math.round(e.vehicle.a * 100) / 100, v: Math.round(e.vehicle.v * 10) / 10, m: e.vehicle.model } : undefined
                        });
                    }
                }

                for (let i = 0; i < nearby.entities.length; i++) {
                    let e = nearby.entities[i];
                    if (!processedEntities.has(e.id)) { 
                        payloadEntities.push({
    id: e.id,
    x: Math.round(e.x),
    y: Math.round(e.y),
    type: e.type,
    team: e.team,
    hp: e.hp,
    maxHp: e.maxHp,
    radius: e.radius,
    angle: Math.round(e.angle * 100) / 100,
    inView: true,
    powerupType: e.powerupType || null,

    // Active tank powerups
    powerups: getActivePowerups(e)
});
                    }
                }

                for(let i=0; i<nearby.bullets.length; i++) {
                    let b = nearby.bullets[i];
                    if (Math.abs(b.y - focalY) < VDY) {
                        payloadBullets.push({
    id: b.id,
    x: Math.round(b.x),
    y: Math.round(b.y),
    r: b.r,
    team: b.team,
    powerupEffects: b.powerupEffects || []
});
                    }
                }

                for(let i=0; i<nearby.drones.length; i++) {
                    let d = nearby.drones[i];
                    if (Math.abs(d.y - focalY) < VDY) {
                        let droneData = { 
                            id: d.id, 
                            x: Math.round(d.x), 
                            y: Math.round(d.y), 
                            radius: d.radius, 
                            angle: Math.round(d.angle * 100) / 100, 
                            team: d.team 
                        };
                        
                        if (d.owner && d.owner.tankType === 'Necromancer') {
                            droneData.square = true;
                        }
                        
                        payloadDrones.push(droneData);
                    }
                }

                c.ws.send(JSON.stringify({ type: 'state', entities: payloadEntities, bullets: payloadBullets, drones: payloadDrones }));
                
                if(c.player && !c.player.markedForDeletion) {
                    c.ws.send(JSON.stringify({
                        type: 'playerStats', xp: c.player.xp, level: c.player.level, statPoints: c.player.statPoints, 
                        stats: c.player.stats, tankType: c.player.tankType, score: c.player.score
                    }));
                } else {
                    if (!c.spectatingId) {
                        let top = room.entities.filter(en => ['tank','ai'].includes(en.type)).sort((a,b) => b.score - a.score)[0];
                        c.spectatingId = top ? top.id : null;
                    }
                    if (c.spectatingId) c.ws.send(JSON.stringify({ type: 'spectate_update', id: c.spectatingId }));
                }
            }
        });
    });
}, 1000 / TICK_RATE);

// ===================== DISCORD BOT =====================

const discordClient = new Client({ 
    intents: [GatewayIntentBits.Guilds] 
});
// ======================
// EMBED CONFIG
// ======================

const EMBED_COLOR = '#5865F2';

// ======================
// DATABASE BACKUP
// ======================
const commands = [
    {
        name: 'account',
        description: 'View your game account details, coins, and cosmetics',
    },
    {
        name: 'lobbies',
        description: 'View active game servers and their live leaderboards',
    },
    { name: 'world-regenerate', description: 'ADMIN: regenerate the persistent World Mode terrain' },
    {
        name: 'z-importbackup',
        description: 'Restore the database from a backup zip',
        options: [
            {
                name: 'file',
                description: 'Backup zip exported by the bot',
                type: 11,
                required: true
            }
        ]
    }
];
async function updateLeaderboard() {
    if (!discordClient.isReady()) return;
    try {
        const channel = await discordClient.channels.fetch(LEADERBOARD_CHANNEL_ID);
        if (!channel) return;

        const topUsers = db.prepare(`
            SELECT id, username, high_score 
            FROM users 
            WHERE provider = 'discord' AND high_score > 0 
            ORDER BY high_score DESC 
            LIMIT 10
        `).all();

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🏆 All-Time Highest Scores')
            .setDescription('The top 10 highest scores achieved!')
            .setTimestamp();

        if (topUsers.length === 0) {
            embed.addFields({ name: 'No scores yet!', value: 'Play the game and set a record!' });
        } else {
            let boardText = topUsers.map((u, i) => {
                const rawDiscordId = u.id.replace('discord_', '');
                return `**${i + 1}.** <@${rawDiscordId}> - ${Math.floor(u.high_score).toLocaleString()} pts`;
            }).join('\n\n');
            embed.addFields({ name: 'Top 10 Players', value: boardText });
        }

        const msgRecord = "1494846178263568547" || db.prepare("SELECT value FROM bot_config WHERE key = 'leaderboard_msg_id'").get();
        
        if (msgRecord) {
            try {
                const msg = await channel.messages.fetch(msgRecord);
                await msg.edit({ embeds: [embed] });
                return;
            } catch (err) {
                console.log('could not edit old leaderboard message');
            }
        }

        const newMsg = await channel.send({ embeds: [embed] });
        db.prepare("INSERT OR REPLACE INTO bot_config (key, value) VALUES ('leaderboard_msg_id', ?)").run(newMsg.id);

    } catch (err) {
        console.error('failed to update leaderboard ', err);
    }
}
async function createDatabaseBackup() {
    try {
        if (!discordClient.isReady()) return;

        const channel = await discordClient.channels.fetch(BACKUP_CHANNEL_ID);
        if (!channel) return;

        db.pragma('wal_checkpoint(FULL)');

        const backupFolder = path.join(__dirname, 'backups');

        if (!fs.existsSync(backupFolder)) {
            fs.mkdirSync(backupFolder);
        }

        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-');

        const tempDbPath = path.join(
            backupFolder,
            `game-${timestamp}.db`
        );

        const zipPath = path.join(
            backupFolder,
            `backup-${timestamp}.zip`
        );

        fs.copyFileSync(dbPath, tempDbPath);

        const zip = new AdmZip();
        zip.addLocalFile(tempDbPath);
        zip.writeZip(zipPath);

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle('Datasave Created')
            .addFields(
                {
                    name: 'Timestamp',
                    value: `<t:${Math.floor(Date.now() / 1000)}:F>`
                }
            )
            .setTimestamp();

        await channel.send({
            embeds: [embed],
            files: [zipPath]
        });

        fs.unlinkSync(tempDbPath);
        fs.unlinkSync(zipPath);

        console.log('Backup uploaded successfully');

    } catch (err) {
        console.error('fail backup ', err);
    }
}

// ======================
// CLIENT READY
// ======================

discordClient.once('clientReady', async () => {
    try {
        await discordClient.application.commands.set(commands);

        updateLeaderboard();

        createDatabaseBackup();

        setInterval(createDatabaseBackup, BACKUP_INTERVAL);

    } catch (error) {
        console.error('cant register commands', error);
    }
});

// ======================
// INTERACTIONS
// ======================

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'world-regenerate') {
        const allowed=(process.env.ADMIN_DISCORD_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);
        if (!allowed.includes(interaction.user.id)) return interaction.reply({content:'Not authorized.',ephemeral:true});
        db.prepare('DELETE FROM world_meta WHERE id=1').run();
        db.prepare('DELETE FROM world_houses').run();
        worldRegenerate();
        return interaction.reply({content:'World regenerated with a new seed. Player progress, levels and balances were preserved; all house ownership was cleared. Connected players were told to reload.',ephemeral:true});
    }

    // ======================
    // ACCOUNT COMMAND
    // ======================

    if (interaction.commandName === 'account') {

        const dbId = `discord_${interaction.user.id}`;

        const user = db.prepare(
            "SELECT * FROM users WHERE id = ?"
        ).get(dbId);

        if (!user) {

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setDescription(
                    "You don't have a linked game discord account yet!\n\nPlease log in via Discord on the game's web interface first to create your profile."
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        const unlockedColors = JSON.parse(
            user.unlocked_colors || '["#ffffff"]'
        );

        const embed = new EmbedBuilder()
            .setColor(user.selected_color || EMBED_COLOR)
            .setTitle(`🎮 ${user.username}'s Profile`)
            .setThumbnail(user.pfp)
            .addFields(
                {
                    name: '🪙 Coins',
                    value: user.coins.toString(),
                    inline: true
                },
                {
                    name: '🏆 High Score',
                    value: Math.floor(user.high_score || 0).toLocaleString(),
                    inline: true
                },
                {
                    name: '🎨 Unlocked Colors',
                    value: unlockedColors.length.toString(),
                    inline: true
                }
            )
            .setFooter({
                text: `Account Provider: ${user.provider}`
            })
            .setTimestamp();

        await interaction.reply({
            embeds: [embed]
        });
    }

    // ======================
    // LOBBIES COMMAND
    // ======================

    if (interaction.commandName === 'lobbies') {

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle('Active Game Lobbies & Leaderboards')
            .setTimestamp();

        let activeLobbies = 0;

        for (const roomId in rooms) {

            const room = rooms[roomId];

            if (room.status === 'stopped') continue;

            activeLobbies++;

            const topPlayers = room.entities
                .filter(e => ['tank', 'ai'].includes(e.type))
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);

            let leaderboardStr = '';

            if (topPlayers.length === 0) {

                leaderboardStr = '*No players or bots in this lobby.*';

            } else {

                leaderboardStr = topPlayers
                    .map((p, index) => {
                        const icon = '👤';

                        return `**${index + 1}.** ${icon} ${p.name || 'Unnamed'} - ${Math.floor(p.score)} pts`;
                    })
                    .join('\n');
            }

            const humanCount = room.clients.filter(
                c => c.player
            ).length;

            embed.addFields({
                name: `🟢 ${roomId} | Mode: ${room.mode} | Human Players: ${humanCount}`,
                value: leaderboardStr + '\n\u200B',
                inline: false
            });
        }

        if (activeLobbies === 0) {
            embed.setDescription(
                'No active game servers at the moment.'
            );
        }

        await interaction.reply({
            embeds: [embed]
        });
    }

    // ======================
    // IMPORT BACKUP COMMAND
    // ======================

    if (interaction.commandName === 'z-importbackup') {

        if (!interaction.memberPermissions.has('Administrator')) {

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setDescription(
                    'You do not have permission to run this command.'
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        const attachment = interaction.options.getAttachment('file');

        if (!attachment) {

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setDescription('No file was attached.')
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        if (!attachment.name.endsWith('.zip')) {

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setDescription('You must upload a `.zip` backup file.')
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }

        const loadingEmbed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setDescription('Please wait while the backup is restored...')
            .setTimestamp();

        await interaction.reply({
            embeds: [loadingEmbed],
            ephemeral: true
        });

        try {

            const tempFolder = path.join(__dirname, 'temp_restore');

            if (!fs.existsSync(tempFolder)) {
                fs.mkdirSync(tempFolder);
            }

            const zipFilePath = path.join(
                tempFolder,
                attachment.name
            );

            const response = await fetch(attachment.url);

            fs.writeFileSync(
                zipFilePath,
                Buffer.from(await response.arrayBuffer())
            );

            const zip = new AdmZip(zipFilePath);

            zip.extractAllTo(tempFolder, true);

            const dbFile = fs.readdirSync(tempFolder)
                .find(f => f.endsWith('.db'));

            if (!dbFile) {
                throw new Error(
                    'No .db file found inside zip'
                );
            }

            const extractedDbPath = path.join(
                tempFolder,
                dbFile
            );

            const sourceDb = new Database(
                extractedDbPath,
                { readonly: true }
            );

            await sourceDb.backup(dbPath);

            sourceDb.close();

            fs.rmSync(tempFolder, {
                recursive: true,
                force: true
            });

            const successEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('Backup Restored')
                .setDescription(
                    'The live database has been updated successfully.'
                )
                .setTimestamp();

            await interaction.editReply({
                embeds: [successEmbed]
            });

            console.log(
                '[Backup] Database restored successfully'
            );

        } catch (err) {

            console.error(
                'Backup Restore Error',
                err
            );

            const errorEmbed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('Restore Failed')
                .setDescription(
                    `\`\`\`${err.message}\`\`\``
                )
                .setTimestamp();

            await interaction.editReply({
                embeds: [errorEmbed]
            });
        }
    }
});

// ======================
// LOGIN
// ======================

if (process.env.DISCORD_BOT_TOKEN) {

    discordClient.login(
        process.env.DISCORD_BOT_TOKEN
    ).catch(err => {

        console.error(
            'login failed',
            err
        );
    });
}

// ===================== SERVER LISTEN =====================

server.listen(8000, '0.0.0.0', () => {
    const protocol = process.env.RAILWAY_STATIC_URL ? 'wss' : 'ws';
    const httpProtocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';

    console.log(`server is live`);
});
