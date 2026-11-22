require('dotenv').config();//
// ===================== BINARY WIRE FORMAT (shared by server.js and client.js – keep both copies identical) =====================
// Every WebSocket message is binary. Inputs keep their fixed 14-byte layout (first byte 1); everything else is a compact
// self-describing encoding of the same objects that used to be JSON (first byte 0xC5):
//   0x00 null · 0x01 false · 0x02 true · 0x10–0x7F small int 0..111 (one byte) · 0x03 uint varint · 0x04 negative int varint
//   0x05 float32 (only for values that survive it exactly to 7 significant digits) · 0x06 float64 · 0x07 new string (varint length + UTF-8; remembered) · 0x08 repeated string (varint index)
//   0x09 array (varint count + values) · 0x0A object (varint count + key/value pairs; keys are strings, so they are remembered too)
// Repeated keys and values ("type", "entities", "square", a player's name…) cost one or two bytes after their first use.
const DTB_MAGIC = 0xC5;
const DTB = (() => {
    const te = new TextEncoder(), td = new TextDecoder();
    let buf = new Uint8Array(1 << 16), dv = new DataView(buf.buffer), n = 0, strs = new Map();
    const need = k => { if (n + k <= buf.length) return; let m = buf.length * 2; while (m < n + k) m *= 2; const nb = new Uint8Array(m); nb.set(buf.subarray(0, n)); buf = nb; dv = new DataView(buf.buffer); };
    const uv = v => { need(10); while (v >= 128) { buf[n++] = (v % 128) | 128; v = Math.floor(v / 128); } buf[n++] = v; };
    const str = s => {
        const i = strs.get(s); if (i !== undefined) { need(1); buf[n++] = 8; uv(i); return; }
        strs.set(s, strs.size);
        if (s.length < 64 && !/[^\x00-\x7f]/.test(s)) { need(s.length + 6); buf[n++] = 7; uv(s.length); for (let k = 0; k < s.length; k++) buf[n++] = s.charCodeAt(k); return; }
        const b = te.encode(s); need(b.length + 6); buf[n++] = 7; uv(b.length); need(b.length); buf.set(b, n); n += b.length;
    };
    const val = v => {
        if (v === null || v === undefined) { need(1); buf[n++] = 0; return; }
        switch (typeof v) {
            case 'boolean': need(1); buf[n++] = v ? 2 : 1; return;
            case 'number':
                if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) { if (v >= 0 && v < 112) { need(1); buf[n++] = 0x10 + v; } else if (v >= 0) { need(1); buf[n++] = 3; uv(v); } else { need(1); buf[n++] = 4; uv(-v); } return; }
                if (Number.isFinite(v) && +Math.fround(v).toPrecision(7) === v) { need(5); buf[n++] = 5; dv.setFloat32(n, v, true); n += 4; return; }
                if (!Number.isFinite(v)) { need(1); buf[n++] = 0; return; }
                need(9); buf[n++] = 6; dv.setFloat64(n, v, true); n += 8; return;
            case 'string': str(v); return;
            case 'object':
                if (Array.isArray(v)) { need(1); buf[n++] = 9; uv(v.length); for (let i = 0; i < v.length; i++) val(v[i]); return; }
                if (v instanceof Set) return val([...v]);
                if (v instanceof Map) return val([...v]);
                { const ks = Object.keys(v); let c = 0; for (const k of ks) if (v[k] !== undefined && typeof v[k] !== 'function') c++; need(1); buf[n++] = 10; uv(c); for (const k of ks) { const x = v[k]; if (x === undefined || typeof x === 'function') continue; str(k); val(x); } }
                return;
            default: need(1); buf[n++] = 0;
        }
    };
    function encode(obj) { n = 0; strs.clear(); need(1); buf[n++] = DTB_MAGIC; val(obj); return buf.slice(0, n); }
    function decode(u8) {
        const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), tab = []; let p = 1;
        const ru = () => { let v = 0, mul = 1, b; do { b = u8[p++]; v += (b & 127) * mul; mul *= 128; } while (b & 128); return v; };
        const rd = () => {
            const t = u8[p++];
            if (t >= 0x10) return t - 0x10;
            switch (t) {
                case 0: return null; case 1: return false; case 2: return true;
                case 3: return ru(); case 4: return -ru();
                case 5: { const v = +d.getFloat32(p, true).toPrecision(7); p += 4; return v; }
                case 6: { const v = d.getFloat64(p, true); p += 8; return v; }
                case 7: { const l = ru(); let s; if (l < 64) { s = ''; let ascii = true; for (let k = 0; k < l; k++) { if (u8[p + k] > 127) { ascii = false; break; } } if (ascii) { for (let k = 0; k < l; k++) s += String.fromCharCode(u8[p + k]); } else s = td.decode(u8.subarray(p, p + l)); } else s = td.decode(u8.subarray(p, p + l)); p += l; tab.push(s); return s; }
                case 8: return tab[ru()];
                case 9: { const l = ru(), a = new Array(l); for (let i = 0; i < l; i++) a[i] = rd(); return a; }
                case 10: { const l = ru(), o = {}; for (let i = 0; i < l; i++) { const k = rd(); o[k] = rd(); } return o; }
            }
            throw new Error('DTB: bad tag ' + t);
        };
        if (u8[0] !== DTB_MAGIC) throw new Error('DTB: bad magic');
        return rd();
    }
    return { encode, decode };
})();
function wsSendObj(sock, obj) { if (sock && sock.readyState === 1) sock.send(DTB.encode(obj)); }

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
                wsSendObj(client.ws, ({ type: 'broadcast', msgType: type || 'announcement', message }));
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

// Sparse spatial hash with the SpatialGrid interface, for the World exterior (far too large for a dense grid).
class HashGrid {
    constructor(cellSize) { this.cellSize = cellSize; this.map = new Map(); this.pool = []; }
    clear() { for (const c of this.map.values()) { c.entities.length = 0; c.bullets.length = 0; c.drones.length = 0; this.pool.push(c); } this.map.clear(); }
    insert(obj, type) {
        const k = Math.floor(obj.x / this.cellSize) + Math.floor(obj.y / this.cellSize) * 100000;
        let c = this.map.get(k); if (!c) { c = this.pool.pop() || { entities: [], bullets: [], drones: [] }; this.map.set(k, c); }
        c[type].push(obj);
    }
    getNearby(x, y, range) {
        if (this.wrap && (x - range < 0 || x + range > this.wrap)) {      // the world wraps: look on the far side of the date line too
            const a = this._near(x, y, range), b = this._near(x - range < 0 ? x + this.wrap : x - this.wrap, y, range);
            return { entities: a.entities.concat(b.entities), bullets: a.bullets.concat(b.bullets), drones: a.drones.concat(b.drones) };
        }
        return this._near(x, y, range);
    }
    _near(x, y, range) {
        const result = { entities: [], bullets: [], drones: [] }, cs = this.cellSize;
        for (let c = Math.floor((x - range) / cs); c <= Math.floor((x + range) / cs); c++) for (let r = Math.floor((y - range) / cs); r <= Math.floor((y + range) / cs); r++) {
            const cell = this.map.get(c + r * 100000); if (!cell) continue;
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
        wsSendObj(ws, ({
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
        this.vehicle = null; this.flight = null; this.taxiRide = null; this.ghost = false;
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
    return (this.getPowerupActive('movementSpeed') ? 1.5 : 1) * (this.worldSpeedUntil > Date.now() ? 1.25 : 1);
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
        if (this.room.worldKind === 'exterior') {          // the ground stays in the land zone, which never reaches the date line; flights fly the sphere
            if (!this.flight) { this.x = clamp(this.x, W_LAND.x0 - 12000, W_LAND.x1 + 12000); this.y = clamp(this.y, W_LAND.y0 - 12000, W_LAND.y1 + 12000); }
        }
        else {
            const arenaExtent = this.room.mode === 'WORLD' ? (this.room.worldExtent || WORLD_SIZE) : WORLD_SIZE;
            this.x = Math.max(0, Math.min(arenaExtent, this.x));
            this.y = Math.max(0, Math.min(arenaExtent, this.y));
        }
        // World mode: solid buildings/trees/benches/walls/cars for tanks on foot, car physics when driving,
        // and flights, where the plane carries the tank through the open world (and across the date line).
        if (this.room.worldKind && this.isPlayer) {
            if (this.flight) worldStepFlight(this);
            else if (this.taxiRide) worldStepTaxiRide(this);
            else {
                if (this.vehicle) worldStepVehicle(this); else worldCollideEntity(this);
                if (this.room.worldKind !== 'interior') { this.x = Math.max(W_LAND.x0, Math.min(W_LAND.x1, this.x)); this.y = Math.max(W_LAND.y0, Math.min(W_LAND.y1, this.y)); }
            }
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
            if ((inputX !== 0 || inputY !== 0) && !this.vehicle && !this.flight && !this.taxiRide) {
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

        if (this.vehicle || this.flight || this.taxiRide || (this.room && this.room.noCombat)) isShooting = false;   // no shooting from a car, a plane or indoors
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
worldRoom.worldExtent = WORLD_EXTENT;      // replaced by the real (wrapping) size once the layout constants exist; see W_CIRC / W_EXTY
worldRoom.grid = new HashGrid(500); worldRoom.grid.wrap = 2700000;   // = W_CIRC (declared further down)
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
                wsSendObj(e.ws, ({ type: 'death', score: e.score, level: e.level, timeAlive: timeAlive, tank: e.tankType, killerId: e.lastDamagedBy }));
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
                    wsSendObj(client.ws, ({ type: 'profile_update', profile: updatedUser }));
                    
                    if (isNewHighScore && userRecord.provider === 'discord') {
                        updateLeaderboard();
                    }
                }
                if (client) {
                    client.player = null;
                    client.spectatingId = e.lastDamagedBy;
                }
            }
            if (room.mode === 'WORLD' && e.fieldId && !e.culled && e.lastDamagedBy) {
                const shooter = room.entities.find(p => p.id === e.lastDamagedBy && p.isPlayer), owner = shooter && room.clients.find(c => c.player === shooter);
                if (owner?.world) worldFarmHarvest(owner, e);
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
// ---- world geometry ------------------------------------------------------------------------------
// The world is a cylinder: it wraps east-west like the real globe. Four 6-hour time-zone columns
// (CT-6, CT, CT+6, CT+12) make up the full 24 hours, so x = 0 and x = W_CIRC are the same meridian.
// The seam (the date line) runs through open ocean between the CT+12 and CT-6 columns, which is why
// a flight from a CT+12 city to a CT-6 city is shorter – and operated – eastbound.
// Every city centre is a multiple of W_S from every other, so all cities share one global road grid.
const W_S = 600;
const W_GAP = 675000;                       // distance between neighbouring city centres = one 6-hour time zone
const W_COLS = 4;                           // CT-6, CT, CT+6, CT+12
const W_CIRC = W_COLS * W_GAP;              // east-west circumference of the world
const W_MARGIN = 75600;                     // land between the outermost city centres and the coast
const W_SHORE = 1800;                       // width of the beach strip that ends the land
const W_EXTY = 2 * W_MARGIN + W_GAP;        // north-south size of the world
const W_EXT = Math.max(W_CIRC, W_EXTY);     // index size (chunks / collision buckets)
const W_CX = W_GAP / 2 + W_GAP;             // Central City centre: column 1 (CT)
const W_CY = W_MARGIN;                      //                      row 0
const W_LAND = { x0: W_GAP / 2 - W_MARGIN + W_SHORE, x1: W_GAP / 2 + (W_COLS - 1) * W_GAP + W_MARGIN - W_SHORE, y0: W_SHORE, y1: W_EXTY - W_SHORE };
const W_NB = Math.ceil(W_EXT / 600);        // collision-bucket row stride
const W_SW = 26;                            // pavement width inside a block
const W_BORDER_N = 96;                      // samples of each city's (organic) city-limit outline
// Signed east-west offset from a to b the short way round the globe.
function wrapDx(d) { d = ((d % W_CIRC) + W_CIRC) % W_CIRC; return d > W_CIRC / 2 ? d - W_CIRC : d; }
function wrapX(x) { return ((x % W_CIRC) + W_CIRC) % W_CIRC; }
// ---- the globe -------------------------------------------------------------------------------------------------
// The world is a true sphere of radius W_R (circumference W_CIRC). The land is laid onto it with the Mercator
// projection, which is conformal: every city keeps its exact shape and street grid, and one chart unit on the ground is
// cos(latitude) sphere units. The chart (x, y) is only an address book for the ground: x is longitude and y is
// Mercator latitude (W_YEQ is the equator). Anything that leaves the ground – flights – moves as a 3D unit vector q on
// the sphere with a tangent heading h, so there is no seam anywhere: not at the date line and not at the poles.
// Ground entities stay inside the land zone (which never touches the date line), so chart physics never meets a seam.
const W_R = W_CIRC / (2 * Math.PI), W_YEQ = W_EXTY / 2, W_LATMAX = 85 * Math.PI / 180;
const FL_SPH = 0.82;                                     // cruise speed on the sphere relative to the chart cruise number
function wLat(y) { return 2 * Math.atan(Math.exp((W_YEQ - y) / W_R)) - Math.PI / 2; }
function wLon(x) { return x / W_CIRC * Math.PI * 2; }
function wYofLat(lat) { lat = Math.max(-W_LATMAX, Math.min(W_LATMAX, lat)); return W_YEQ - W_R * Math.log(Math.tan(Math.PI / 4 + lat / 2)); }
function wSec(y) { return 1 / Math.cos(wLat(y)); }       // chart units per sphere unit at chart row y
function wVec(x, y) { const la = wLat(y), lo = wLon(x), c = Math.cos(la); return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)]; }
function wDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function wCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function wNorm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function wChart(q) { return { x: wrapX(Math.atan2(q[1], q[0]) / (Math.PI * 2) * W_CIRC), y: wYofLat(Math.asin(Math.max(-1, Math.min(1, q[2])))) }; }
// local east / north at q (at the pole itself east is undefined: any horizontal direction will do)
function wEN(q) { const r = Math.hypot(q[0], q[1]); const e = r > 1e-9 ? [-q[1] / r, q[0] / r, 0] : [0, 1, 0]; return { e, n: wCross(q, e) }; }
// chart angle a (x right, y down = south) <-> tangent unit vector; Mercator is conformal so angles carry over exactly
function wTan(q, a) { const { e, n } = wEN(q), c = Math.cos(a), s = Math.sin(a); return [c * e[0] - s * n[0], c * e[1] - s * n[1], c * e[2] - s * n[2]]; }
function wAng(q, h) { const { e, n } = wEN(q); return Math.atan2(-wDot(h, n), wDot(h, e)); }
function wAngle(a, b) { return Math.atan2(Math.hypot(...wCross(a, b)), wDot(a, b)); }
function wDistV(a, b) { return wAngle(a, b) * W_R; }    // great-circle distance, sphere units
function wSlerp(a, b, t) {
    const c = wAngle(a, b), s = Math.sin(c);
    if (s < 1e-9) return a.slice();
    const k1 = Math.sin((1 - t) * c) / s, k2 = Math.sin(t * c) / s;
    return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}
function wGC(x1, y1, x2, y2) {                       // central angle, great-circle length (sphere units) and initial bearing (0 = north, π/2 = east)
    const a = wVec(x1, y1), b = wVec(x2, y2), c = wAngle(a, b), { e, n } = wEN(a), d = wNorm([b[0] - a[0] * wDot(a, b), b[1] - a[1] * wDot(a, b), b[2] - a[2] * wDot(a, b)]);
    return { c, d: c * W_R, brg: Math.atan2(wDot(d, e), wDot(d, n)) };
}
// Does the great circle between two chart points pass near a pole? 'N', 'S' or ''.
function wGCPole(x1, y1, x2, y2, deg = 82) {
    const a = wVec(x1, y1), b = wVec(x2, y2), lim = Math.sin(deg * Math.PI / 180);
    for (let i = 1; i < 48; i++) { const z = wSlerp(a, b, i / 48)[2]; if (z > lim) return 'N'; if (z < -lim) return 'S'; }
    return '';
}
// Cities: col = time-zone column (CT-6 .. CT+12), row = 0 north / 1 south. `size` is the base radius
// of the organic outline (the old cities were 18 000-unit squares). The first four keep their order.
// style: 'cyber' (the capital: neon financial district, skyscrapers, multi-level malls, highest wages and prices),
//        'oldtown' (historic quarter: terraces, galleries, cobbled streets, markets – touristy, not poor),
//        'rural' (small, cheap, poor farming town: low wages, low prices, not much to do), 'generic' (the rest).
// Four (invented) cultures, one per time-zone column. Crossroads towns belong to the column they lean towards.
function W_CULTURE_COL(col) { col = ((col % 4) + 4) % 4; return col >= 3.75 || col < 0.75 ? 'west' : col < 1.75 ? 'central' : col < 2.75 ? 'sun' : 'isles'; }
const W_CULTURES = {
    west:    { name: 'Westreach',          greet: 'Well met, traveller!', lang: 'Westreach',  lht: 0, open: 7, close: 21, fest: 'Dust Fair',       spec: ['brisket', 'peachpie'],       idx: 0 },
    central: { name: 'Central Federation', greet: 'Welcome!',             lang: 'Federal',    lht: 0, open: 0, close: 24, fest: "Founders' Night", spec: ['neonbao', 'synthshake'],     idx: 1 },
    sun:     { name: 'Sunward Coast',      greet: 'Bonsól!',              lang: 'Solanese',   lht: 0, open: 8, close: 23, siesta: [13, 16], fest: 'Lantern Tide', spec: ['saffronrice', 'orangepastry'], idx: 2 },
    isles:   { name: 'Kaimana Isles',      greet: "Ma'ora!",              lang: 'Kaimanan',   lht: 1, open: 6, close: 24, fest: 'Blossom Moon',   spec: ['coconutfish', 'ricecake'],   idx: 3 }
};
const W_CITIES = [
    { id: 'central',  name: 'Central City', code: 'CTC', col: 1, row: 0, home: true, style: 'cyber', theme: 'cyber', size: 30600, wageMul: 1.9,  priceMul: 2.2,  toll: 30 },
    { id: 'port',     name: 'Port Aldren',  code: 'PAL', col: 2, row: 0, seedAdd: 101, style: 'generic', theme: 'port',    size: 25800, wageMul: 1.2,  priceMul: 1.1,  toll: 25 },
    { id: 'highmoor', name: 'Highmoor',     code: 'HMR', col: 1, row: 1, seedAdd: 202, style: 'oldtown', theme: 'old',     size: 22800, wageMul: 1.15, priceMul: 1.35, toll: 15 },
    { id: 'solana',   name: 'Solana',       code: 'SOL', col: 2, row: 1, seedAdd: 303, style: 'generic', theme: 'sun',     size: 27000, wageMul: 1.3,  priceMul: 1.3,  toll: 30 },
    { id: 'redmesa',  name: 'Redmesa',      code: 'RMS', col: 0, row: 0, seedAdd: 404, style: 'generic', theme: 'mesa',    size: 25200, wageMul: 1.0,  priceMul: 0.9,  toll: 20 },
    { id: 'cedar',    name: 'Cedar Hollow', code: 'CDH', col: 0, row: 1, seedAdd: 505, style: 'rural',   theme: 'pine',    size: 15600, wageMul: 0.55, priceMul: 0.4,  toll: 5 },
    { id: 'kaimana',  name: 'Kaimana Bay',  code: 'KMB', col: 3, row: 0, seedAdd: 606, style: 'generic', theme: 'tropic',  size: 26400, wageMul: 1.25, priceMul: 1.2,  toll: 25 },
    { id: 'hanami',   name: 'Hanami Ridge', code: 'HNR', col: 3, row: 1, seedAdd: 707, style: 'generic', theme: 'blossom', size: 24600, wageMul: 1.35, priceMul: 1.45, toll: 30 },
    // the interior of the continent: four towns half-way between the northern and southern cities, and three crossroads
    // towns between the time-zone columns (those keep their local solar offset: CT-3, CT+3, CT+9)
    { id: 'dustwater', name: 'Dustwater',   code: 'DSW', col: 0,   row: 0.5, seedAdd: 808,  style: 'rural',   theme: 'mesa',   size: 14400, wageMul: 0.6,  priceMul: 0.45, toll: 5 },
    { id: 'lakemont',  name: 'Lakemont',    code: 'LKM', col: 1,   row: 0.5, seedAdd: 909,  style: 'generic', theme: 'port',   size: 17400, wageMul: 1.05, priceMul: 1.0,  toll: 15 },
    { id: 'amberfield', name: 'Amberfield', code: 'AMB', col: 2,   row: 0.5, seedAdd: 1010, style: 'rural',   theme: 'sun',    size: 15000, wageMul: 0.65, priceMul: 0.5,  toll: 5 },
    { id: 'palmhaven', name: 'Palmhaven',   code: 'PLH', col: 3,   row: 0.5, seedAdd: 1111, style: 'generic', theme: 'tropic', size: 16800, wageMul: 1.1,  priceMul: 1.05, toll: 15 },
    { id: 'junction',  name: 'Junction Falls', code: 'JNF', col: 0.5, row: 0.5, seedAdd: 1212, tz: -3, style: 'generic', theme: 'pine', size: 13800, wageMul: 0.9, priceMul: 0.8, toll: 10 },
    { id: 'meridian',  name: 'Meridian Crossing', code: 'MRX', col: 1.5, row: 0.5, seedAdd: 1313, tz: 3, style: 'generic', theme: 'hill', size: 15600, wageMul: 1.0, priceMul: 0.95, toll: 10 },
    { id: 'saffron',   name: 'Saffron Vale', code: 'SFV', col: 2.5, row: 0.5, seedAdd: 1414, tz: 9, style: 'oldtown', theme: 'old', size: 14400, wageMul: 1.0, priceMul: 1.1, toll: 10 }
];
// Centres snap to the shared 600-unit road grid (relative to Central City), so every town's roads line up with the highways.
for (const c of W_CITIES) {
    c.cx = W_CX + Math.round((c.col - 1) * W_GAP / W_S) * W_S; c.cy = W_CY + Math.round(c.row * W_GAP / W_S) * W_S;
    if (c.tz === undefined) c.tz = (c.col - 1) * 6;
    c.border = c.size * 1.4; c.bp = null;
    c.culture = W_CULTURE_COL(c.col);
}
// City limit test. bp = outline radius sampled at W_BORDER_N angles (filled in when the layout is built).
function cityBorderAt(c, ang) {
    if (!c.bp) return c.size;
    const t = ((ang / (Math.PI * 2)) % 1 + 1) % 1 * W_BORDER_N, i = Math.floor(t) % W_BORDER_N, f = t - Math.floor(t);
    return c.bp[i] * (1 - f) + c.bp[(i + 1) % W_BORDER_N] * f;
}
function cityContains(c, x, y) {
    const dx = wrapDx(x - c.cx), dy = y - c.cy;
    if (Math.abs(dx) > c.border || Math.abs(dy) > c.border) return false;
    return Math.hypot(dx, dy) < cityBorderAt(c, Math.atan2(dy, dx));
}
function worldCityAt(x, y) { for (const c of W_CITIES) if (cityContains(c, x, y)) return c; return null; }
function worldPayFor(co, pos) { const c = (pos && worldCityAt(pos.x, pos.y)) || W_CITIES[0]; return Math.max(1, Math.round(co.pay * c.wageMul)); }
function worldOnHighway(x, y) {
    if (!WL || !WL.highways) return false;
    for (const h of WL.highways) { const along = h.a === 'h' ? x : y, perp = h.a === 'h' ? y : x; if (Math.abs(perp - h.p) < 125 && along > h.s0 - 50 && along < h.s1 + 50) return true; }
    return false;
}
const W_CHUNK = 1800;                  // streaming chunk size
const W_NCH = Math.ceil(W_EXT / W_CHUNK);
const ROAD_CLASSES = { avenue: { hw: 105, lanes: 4 }, street: { hw: 60, lanes: 2 }, lane: { hw: 46, lanes: 2 } };
// Employers. kind: desk (tasks at a work station inside), courier (pick-up / drop-off runs), taxi (drive NPC fares in your
// own car), guide (walk tour groups round the sights), farm (harvest crops = shapes in fields). task = seconds per desk task,
// strict = minutes of play you may go without working before you are fired, perk = what makes the job nicer (see WORLD_PERKS).
// styles = the kinds of city that have its offices; companies also grow and open branches (see company expansion).
const W_COMPANIES = [
    { id: 'meridian',  name: 'Meridian Finance',   pay: 76, color: '#2f6fb0', role: 'Analyst',      kind: 'desk',    task: 8,  strict: 15, perk: 'bonus',  styles: ['cyber', 'generic'] },
    { id: 'atlas',     name: 'Atlas Digital',      pay: 88, color: '#7a4fd0', role: 'Developer',    kind: 'desk',    task: 10, strict: 20, perk: 'flex',   styles: ['cyber', 'generic'] },
    { id: 'northgate', name: 'Northgate Legal',    pay: 104, color: '#9a3544', role: 'Paralegal',    kind: 'desk',    task: 12, strict: 12, perk: null,     styles: ['generic', 'oldtown'] },
    { id: 'helix',     name: 'Helix Media',        pay: 68, color: '#d0782f', role: 'Producer',     kind: 'desk',    task: 6,  strict: 18, perk: 'tips',   styles: ['generic', 'cyber'] },
    { id: 'pinnacle',  name: 'Pinnacle Insurance', pay: 96, color: '#b8962b', role: 'Underwriter',  kind: 'desk',    task: 9,  strict: 15, perk: 'meal',   styles: ['generic'] },
    { id: 'neoncore',  name: 'NeonCore Systems',   pay: 124, color: '#ff2bd6', role: 'Netrunner',    kind: 'desk',    task: 10, strict: 10, perk: 'bonus',  styles: ['cyber'] },
    { id: 'quantum',   name: 'Quantum Exchange',   pay: 160, color: '#00b8d4', role: 'Quant Trader', kind: 'desk',    task: 14, strict: 8,  perk: 'bonus',  styles: ['cyber'] },
    { id: 'gallery',   name: 'Old Quarter Gallery', pay: 72, color: '#8e5b3a', role: 'Curator',     kind: 'desk',    task: 7,  strict: 25, perk: 'tips',   styles: ['oldtown'] },
    { id: 'museum',    name: 'Heritage Museum',    pay: 80, color: '#6b4f8a', role: 'Archivist',    kind: 'desk',    task: 9,  strict: 25, perk: 'meal',   styles: ['oldtown'] },
    { id: 'sawmill',   name: 'Timberline Sawmill', pay: 60, color: '#7a5a2a', role: 'Mill Hand',    kind: 'desk',    task: 6,  strict: 30, perk: 'hazard', styles: ['rural'] },
    { id: 'orion',     name: 'Orion Logistics',    pay: 80, color: '#2f9c78', role: 'Courier',      kind: 'courier', task: 0,  strict: 20, perk: 'fuel',   styles: ['generic', 'cyber', 'rural'] },
    { id: 'swift',     name: 'SwiftParcel',        pay: 68, color: '#e05a2a', role: 'Bike Courier', kind: 'courier', task: 0,  strict: 25, perk: 'tips',   styles: ['generic', 'oldtown'] },
    { id: 'citycab',   name: 'CityCab',            pay: 60, color: '#d9a800', role: 'Taxi Driver',  kind: 'taxi',    task: 0,  strict: 25, perk: 'fuel',   styles: ['cyber', 'generic', 'oldtown'] },
    { id: 'tours',     name: 'Old Town Tours',     pay: 60, color: '#c0392b', role: 'Tour Guide',   kind: 'guide',   task: 0,  strict: 30, perk: 'tips',   styles: ['oldtown'] },
    { id: 'coop',      name: 'Green Valley Co-op', pay: 6,  color: '#4f9a3a', role: 'Farm Hand',    kind: 'farm',    task: 0,  strict: 30, perk: 'meal',   styles: ['rural'] }
];
const MALL_NAMES = ['Skyline Galleria', 'Arcadia Plaza', 'Neon Bazaar', 'Meridian Mall', 'Aurora Centre', 'Grand Arcade', 'Vertex Mall', 'Crystal Court'];
const HOTEL_NAMES = ['Grand Meridian', 'The Aurora', 'Skyline Suites', 'Hotel Lumen', 'The Regent', 'Hotel Vantage', 'Starlight Hotel'];
const INN_NAMES = ['The Crooked Lantern', 'Old Bell Inn', 'The Gilded Goose', 'Kings Arms', 'The Willow Inn', 'Miller\'s Rest'];
const FUEL_BRANDS = ['VOLT', 'PETROX', 'NOVA', 'SUNOIL'];
// Things for sale. heal = % of max health restored, speed = seconds of +25% move speed, fuel = litres put in your car,
// souvenir = one collectable per city (all 8 pays a bonus), xp = score. Prices are multiplied by the city's price level.
const WORLD_ITEMS = {
    sandwich: { name: 'Sandwich', price: 8, heal: 35 },
    fruit:    { name: 'Fruit basket', price: 14, heal: 60 },
    drink:    { name: 'Energy drink', price: 10, speed: 60 },
    fuelcan:  { name: 'Fuel can (20 L)', price: 25, fuel: 20 },
    souvenir: { name: 'Souvenir', price: 60, souvenir: true },
    postcard: { name: 'Postcard', price: 3, xp: 60 },
    coffee:   { name: 'Coffee', price: 6, heal: 15, speed: 30 },
    meal:     { name: 'Hot meal', price: 22, heal: 100 },
    noodles:  { name: 'Neon noodles', price: 12, heal: 50, speed: 20 },
    pastry:   { name: 'Pastry', price: 5, heal: 20 },
    skewer:   { name: 'Street skewer', price: 4, heal: 20 },
    lemonade: { name: 'Lemonade', price: 3, heal: 10, speed: 20 },
    craft:    { name: 'Handmade trinket', price: 18, xp: 250 },
    // ---- round 4: a lot more to buy. pu = [powerup, seconds] (fov = wider view, forceField = shield, reload, damage, healthRegen, bulletSpeed)
    sushi:     { name: 'Sushi platter', price: 26, heal: 80, ic: '🍣' },
    pizza:     { name: 'Pizza slice', price: 7, heal: 30, ic: '🍕' },
    burger:    { name: 'Burger & fries', price: 11, heal: 45, ic: '🍔' },
    soda:      { name: 'Fizzy soda', price: 3, speed: 15, ic: '🥤' },
    bubbletea: { name: 'Bubble tea', price: 7, heal: 10, speed: 45, ic: '🧋' },
    icecream:  { name: 'Ice-cream cone', price: 5, heal: 15, speed: 15, ic: '🍦' },
    sundae:    { name: 'Triple sundae', price: 12, heal: 35, speed: 30, ic: '🍨' },
    donut:     { name: 'Glazed doughnut', price: 3, heal: 12, ic: '🍩' },
    taco:      { name: 'Street tacos', price: 9, heal: 40, ic: '🌮' },
    bandage:   { name: 'Bandages', price: 12, heal: 40, ic: '🩹' },
    vitamins:  { name: 'Vitamins', price: 20, pu: ['healthRegen', 120], ic: '💊' },
    medkit:    { name: 'First-aid kit', price: 45, heal: 100, pu: ['healthRegen', 60], ic: '⛑' },
    binoculars:{ name: 'Binoculars', price: 90, pu: ['fov', 180], ic: '🔭' },
    headphones:{ name: 'Noise-cancelling headphones', price: 140, xp: 900, ic: '🎧' },
    phone:     { name: 'New smartphone', price: 420, xp: 3200, ic: '📱' },
    drone:     { name: 'Camera drone', price: 650, pu: ['fov', 600], xp: 1500, ic: '🛸' },
    console:   { name: 'Games console', price: 380, xp: 2900, ic: '🎮' },
    sunglasses:{ name: 'Designer sunglasses', price: 60, xp: 380, ic: '🕶' },
    jacket:    { name: 'Armoured leather jacket', price: 160, pu: ['forceField', 60], ic: '🧥' },
    sneakers:  { name: 'Running shoes', price: 120, speed: 300, ic: '👟' },
    handbag:   { name: 'Luxury handbag', price: 520, xp: 4000, ic: '👜' },
    ring:      { name: 'Silver ring', price: 250, xp: 1800, ic: '💍' },
    watch:     { name: 'Gold watch', price: 900, xp: 7000, ic: '⌚' },
    diamond:   { name: 'Diamond necklace', price: 3000, xp: 26000, ic: '💎' },
    perfume:   { name: 'Perfume', price: 85, xp: 650, ic: '🧴' },
    novel:     { name: 'Paperback novel', price: 9, xp: 90, ic: '📕' },
    guidebook: { name: 'City guidebook', price: 15, xp: 150, ic: '🗺' },
    manual:    { name: 'Tank tactics manual', price: 120, pu: ['reload', 120], ic: '📘' },
    comic:     { name: 'Comic book', price: 6, xp: 60, ic: '📗' },
    bouquet:   { name: 'Bouquet of roses', price: 25, xp: 220, ic: '💐' },
    potplant:  { name: 'Potted cactus', price: 18, xp: 160, ic: '🌵' },
    toytank:   { name: 'Toy tank', price: 30, xp: 260, ic: '🧸' },
    puzzle:    { name: 'Jigsaw puzzle', price: 14, xp: 120, ic: '🧩' },
    kite:      { name: 'Kite', price: 22, speed: 60, xp: 80, ic: '🪁' },
    sportsdrink:{ name: 'Sports drink', price: 6, speed: 60, heal: 10, ic: '🧃' },
    gloves:    { name: 'Training gloves', price: 110, pu: ['damage', 90], ic: '🥊' },
    scope:     { name: 'Target scope', price: 140, pu: ['bulletSpeed', 120], ic: '🎯' },
    vinyl:     { name: 'Vinyl record', price: 28, xp: 260, ic: '💿' },
    guitar:    { name: 'Electric guitar', price: 480, xp: 3700, ic: '🎸' },
    pettreats: { name: 'Pet treats', price: 6, xp: 50, ic: '🦴' },
    goldfish:  { name: 'Goldfish', price: 35, xp: 330, ic: '🐠' },
    puppy:     { name: 'Plush puppy', price: 55, xp: 480, ic: '🐶' },
    jerrycan:  { name: 'Jerry can (40 L)', price: 46, fuel: 40, ic: '⛽' },
    toolkit:   { name: 'Repair kit', price: 60, heal: 100, pu: ['forceField', 15], ic: '🧰' },
    cocktail:  { name: 'Signature cocktail', price: 18, xp: 140, speed: 20, ic: '🍸' },
    mocktail:  { name: 'Virgin mojito', price: 8, heal: 15, speed: 20, ic: '🍹' },
    champagne: { name: 'Champagne', price: 60, xp: 500, ic: '🍾' },
    popcorn:   { name: 'Popcorn', price: 6, heal: 15, ic: '🍿' },
    candy:     { name: 'Pick & mix', price: 4, heal: 8, speed: 20, ic: '🍬' },
    cheese:    { name: 'Artisan cheese', price: 16, heal: 50, ic: '🧀' },
    wine:      { name: 'Bottle of wine', price: 30, xp: 240, ic: '🍷' },
    // regional specialities: only sold in their own culture's food shops and stalls
    brisket:      { name: 'Smokehouse brisket', price: 14, heal: 60, ic: '🍖', cult: 'west' },
    peachpie:     { name: 'Prairie peach pie', price: 6, heal: 25, speed: 20, ic: '🥧', cult: 'west' },
    neonbao:      { name: 'Neon bao bun', price: 8, heal: 35, ic: '🥟', cult: 'central' },
    synthshake:   { name: 'Synth-berry shake', price: 6, speed: 40, ic: '🥤', cult: 'central' },
    saffronrice:  { name: 'Saffron rice pan', price: 13, heal: 55, ic: '🥘', cult: 'sun' },
    orangepastry: { name: 'Orange-blossom pastry', price: 5, heal: 20, speed: 15, ic: '🥐', cult: 'sun' },
    coconutfish:  { name: 'Coconut fish parcel', price: 12, heal: 55, ic: '🐟', cult: 'isles' },
    ricecake:     { name: 'Blossom rice cake', price: 4, heal: 15, speed: 20, ic: '🍡', cult: 'isles' }
};
const SHOP_KINDS = {
    grocery:  { name: 'Grocery', items: ['sandwich', 'fruit', 'drink', 'fuelcan'] },
    souvenir: { name: 'Souvenirs', items: ['souvenir', 'postcard', 'craft'] },
    cafe:     { name: 'Café', items: ['coffee', 'meal', 'pastry'] },
    noodle:   { name: 'Noodle Bar', items: ['noodles', 'drink'] },
    bakery:   { name: 'Bakery', items: ['pastry', 'coffee', 'sandwich'] },
    general:  { name: 'General Store', items: ['sandwich', 'fruit', 'fuelcan', 'lemonade'] },
    pharmacy:    { name: 'Pharmacy', items: ['bandage', 'vitamins', 'medkit', 'drink'], ic: '💊' },
    electronics: { name: 'Electronics', items: ['binoculars', 'headphones', 'phone', 'drone', 'console'], ic: '📱' },
    fashion:     { name: 'Fashion Boutique', items: ['sunglasses', 'jacket', 'sneakers', 'handbag'], ic: '👗' },
    jewelry:     { name: 'Jeweller', items: ['ring', 'watch', 'diamond'], ic: '💎' },
    perfume:     { name: 'Perfumery', items: ['perfume', 'bouquet'], ic: '🧴' },
    books:       { name: 'Bookshop', items: ['novel', 'guidebook', 'comic', 'manual', 'coffee'], ic: '📚' },
    florist:     { name: 'Florist', items: ['bouquet', 'potplant'], ic: '💐' },
    toys:        { name: 'Toy Store', items: ['toytank', 'puzzle', 'kite', 'puppy'], ic: '🧸' },
    sports:      { name: 'Sports Store', items: ['sportsdrink', 'sneakers', 'gloves', 'scope'], ic: '⚽' },
    music:       { name: 'Music Store', items: ['vinyl', 'headphones', 'guitar'], ic: '🎵' },
    games:       { name: 'Game Store', items: ['console', 'comic', 'candy'], ic: '🎮' },
    pets:        { name: 'Pet Shop', items: ['pettreats', 'goldfish', 'puppy'], ic: '🐾' },
    sushi:       { name: 'Sushi Bar', items: ['sushi', 'soda'], ic: '🍣' },
    pizza:       { name: 'Pizzeria', items: ['pizza', 'soda', 'icecream'], ic: '🍕' },
    burger:      { name: 'Burger Joint', items: ['burger', 'soda', 'sundae'], ic: '🍔' },
    tacos:       { name: 'Taqueria', items: ['taco', 'soda'], ic: '🌮' },
    bubbletea:   { name: 'Bubble Tea', items: ['bubbletea', 'donut'], ic: '🧋' },
    icecream:    { name: 'Gelato', items: ['icecream', 'sundae'], ic: '🍦' },
    donut:       { name: 'Doughnut Shop', items: ['donut', 'coffee'], ic: '🍩' },
    candy:       { name: 'Sweet Shop', items: ['candy', 'popcorn', 'lemonade'], ic: '🍬' },
    deli:        { name: 'Deli & Wine', items: ['cheese', 'wine', 'sandwich'], ic: '🧀' },
    hardware:    { name: 'Hardware & Auto', items: ['jerrycan', 'toolkit', 'fuelcan'], ic: '🧰' },
    bar:         { name: 'Cocktail Bar', items: ['cocktail', 'mocktail', 'champagne'], ic: '🍸' },
    cinema:      { name: 'Cinema Kiosk', items: ['popcorn', 'soda', 'candy'], ic: '🍿' }
};
for (const [k, v] of Object.entries(SHOP_KINDS)) if (!v.ic) v.ic = { grocery: '🛒', souvenir: '🎁', cafe: '☕', noodle: '🍜', bakery: '🥐', general: '🏪' }[k] || '🛍';
const STALL_KINDS = {
    food:   { name: 'Food stall', items: ['skewer', 'lemonade'] },
    noodle: { name: 'Night-market noodles', items: ['noodles', 'skewer', 'drink'] },
    craft:  { name: 'Craft stall', items: ['craft', 'souvenir', 'pastry'] },
    farm:   { name: 'Farm stand', items: ['fruit', 'lemonade'] }
};

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
// Road class from the line index: every 6th line is an avenue, other even lines streets, odd lines lanes.
// Which stretch of a line actually exists is decided by the blocks it borders (see buildCityLayout).
function lineClass(k) { return k % 6 === 0 ? 'avenue' : k % 2 === 0 ? 'street' : 'lane'; }

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

// Organic city outline: radius multiplier f(angle) built from a few seeded harmonics (no two cities alike).
function cityShape(seed) {
    const r = wRng((seed ^ 0x5eed1e) >>> 0);
    const H = [[1, 0.04 + r() * 0.07], [2, 0.08 + r() * 0.09], [3, 0.05 + r() * 0.06], [4, 0.02 + r() * 0.04], [5, 0.01 + r() * 0.03], [7, r() * 0.03]].map(([n, a]) => [n, a, r() * Math.PI * 2]);
    const arms = [0, 1, 2, 3].map(i => [i * Math.PI / 2, 0.05 + r() * 0.2]);          // suburbs sprawl out along the main avenues
    return th => {
        let f = 1; for (const [n, a, p] of H) f += a * Math.sin(n * th + p);
        for (const [ax, a] of arms) { const c = Math.cos(th - ax); if (c > 0) f += a * c ** 30; }
        return Math.max(0.6, Math.min(1.5, f));
    };
}
// Makes a boolean grid orthogonally convex (every row and column is one unbroken run), so that each
// road line borders one continuous stretch of blocks and can be stored as a single segment.
function orthoConvex(g, N) {
    for (let changed = true; changed;) {
        changed = false;
        for (let j = 0; j < N; j++) { let a = -1, b = -1; for (let i = 0; i < N; i++) if (g[i + j * N]) { if (a < 0) a = i; b = i; } for (let i = a + 1; i < b; i++) if (!g[i + j * N]) { g[i + j * N] = 1; changed = true; } }
        for (let i = 0; i < N; i++) { let a = -1, b = -1; for (let j = 0; j < N; j++) if (g[i + j * N]) { if (a < 0) a = j; b = j; } for (let j = a + 1; j < b; j++) if (!g[i + j * N]) { g[i + j * N] = 1; changed = true; } }
    }
}

// One city, built directly in world coordinates around (city.cx, city.cy).
//   1. A macro grid of 3600-unit cells (6 road lines) is classified by the organic distance nd = d / R(angle):
//      developed (nd < 1), rural fringe (farms / forest) or empty land. One rural cell becomes the airport.
//   2. Developed macro cells split into 1200-unit cells; the core near the centre splits again into 600-unit cells.
//   3. Every road line exists exactly along the cells it borders, so roads never cross a block and every
//      block is enclosed by roads – the same guarantees as before, without the square outline.
function buildCityLayout(seed, city, idx) {
    const CX = city.cx, CY = city.cy, S = W_S, R0 = city.size, home = !!city.home;
    const shape = cityShape(seed), ndRel = (dx, dy) => Math.hypot(dx, dy) / (R0 * shape(Math.atan2(dy, dx)));
    const ndAt = (x, y) => ndRel(x - CX, y - CY);
    const L = {
        seed, roads: [], junctions: [], blocks: [], buildings: [], props: [], lots: [], fields: [], pcars: [],
        colliders: [], houses: [], works: [], bank: null, dealer: null, spawn: { x: CX + 300, y: CY + 470 }, airport: null,
        nid: (idx + 1) * 1000000, rv: {}, rh: {}
    };
    const nid = () => L.nid++;
    const style = city.style || 'generic';
    const RURAL = style === 'rural' ? (R0 > 15000 ? 1.9 : 1.45) : home ? 1.3 : 1.24, CORE = { cyber: 0.34, oldtown: 0.28, rural: 0.12 }[style] || 0.2;

    // ---- 1. macro cells -----------------------------------------------------------------------------
    const M = Math.ceil(R0 * 1.36 * RURAL / 3600) + 1, MN = 2 * M;         // macro index I in [-M, M)
    const mIdx = (I, J) => (I + M) + (J + M) * MN;
    const all = new Uint8Array(MN * MN), dev = new Uint8Array(MN * MN);
    for (let I = -M; I < M; I++) for (let J = -M; J < M; J++) {
        const d = ndRel((I + 0.5) * 3600, (J + 0.5) * 3600);
        const mx0 = CX + I * 3600 - 200, my0 = CY + J * 3600 - 200;       // never build into the sea
        if (mx0 < W_LAND.x0 + 600 || my0 < W_LAND.y0 + 600 || mx0 + 4000 > W_LAND.x1 - 600 || my0 + 4000 > W_LAND.y1 - 600) continue;
        if (d < RURAL) all[mIdx(I, J)] = 1;
        if (d < 1) dev[mIdx(I, J)] = 1;
    }
    for (let I = -1; I <= 0; I++) for (let J = -1; J <= 0; J++) { dev[mIdx(I, J)] = 1; all[mIdx(I, J)] = 1; }
    orthoConvex(all, MN); orthoConvex(dev, MN);
    for (let i = 0; i < dev.length; i++) if (dev[i]) all[i] = 1;
    orthoConvex(all, MN);
    // airport: the rural cell next to the developed area that lies closest to a seeded bearing
    const prefA = wHash(seed, 4242, 17) * Math.PI * 2;
    let air = null, airScore = Infinity;
    for (let I = -M + 1; I < M - 1; I++) for (let J = -M + 1; J < M - 1; J++) {
        const k = mIdx(I, J); if (!all[k] || dev[k]) continue;
        if (!(dev[mIdx(I - 1, J)] || dev[mIdx(I + 1, J)] || dev[mIdx(I, J - 1)] || dev[mIdx(I, J + 1)])) continue;
        const mx = (I + 0.5) * 3600, my = (J + 0.5) * 3600;
        let da = Math.abs(Math.atan2(my, mx) - prefA) % (Math.PI * 2); if (da > Math.PI) da = Math.PI * 2 - da;
        const sc = ndRel(mx, my) + da * 0.45;
        if (sc < airScore) { airScore = sc; air = { I, J }; }
    }
    // ---- 2. cell list ---------------------------------------------------------------------------------
    // core 1200-cells (index i2 = 3I + a): nd < CORE, plus the landmark cells around the centre
    const N2 = MN * 3, c2 = (i, j) => (i + 3 * M) + (j + 3 * M) * N2, core = new Uint8Array(N2 * N2);
    for (let i = -3 * M; i < 3 * M; i++) for (let j = -3 * M; j < 3 * M; j++) {
        if (!dev[mIdx(Math.floor(i / 3), Math.floor(j / 3))]) continue;
        if (ndRel((i + 0.5) * 1200, (j + 0.5) * 1200) < CORE) core[c2(i, j)] = 1;
    }
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 0; j++) core[c2(i, j)] = 1;
    orthoConvex(core, N2);
    const cells = [];                                                        // [k0, m0, k1, m1, kind, zone]
    for (let I = -M; I < M; I++) for (let J = -M; J < M; J++) {
        const k = mIdx(I, J); if (!all[k]) continue;
        if (air && I === air.I && J === air.J) { cells.push([6 * I, 6 * J, 6 * I + 6, 6 * J + 6, 'airport', 3]); continue; }
        if (!dev[k]) { cells.push([6 * I, 6 * J, 6 * I + 6, 6 * J + 6, 'rural', 3]); continue; }
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
            const i2 = 3 * I + a, j2 = 3 * J + b;
            if (core[c2(i2, j2)]) { for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) cells.push([2 * i2 + p, 2 * j2 + q, 2 * i2 + p + 1, 2 * j2 + q + 1, 'core', 0]); }
            else cells.push([2 * i2, 2 * j2, 2 * i2 + 2, 2 * j2 + 2, 'mid', ndRel((i2 + 0.5) * 1200, (j2 + 0.5) * 1200) < 0.5 ? 1 : 2]);
        }
    }
    // ---- 3. roads: each line spans exactly the cells it borders ----------------------------------------
    const ext = { v: new Map(), h: new Map() };
    const grow = (ax, k, a, b) => { const m = ext[ax], e = m.get(k); if (!e) m.set(k, [a, b]); else { if (a < e[0]) e[0] = a; if (b > e[1]) e[1] = b; } };
    for (const [k0, m0, k1, m1] of cells) { grow('v', k0, m0, m1); grow('v', k1, m0, m1); grow('h', m0, k0, k1); grow('h', m1, k0, k1); }
    for (const axis of ['v', 'h']) for (const [k, [lo, hi]] of [...ext[axis]].sort((p, q) => p[0] - q[0])) {
        const cls = lineClass(k), rc = ROAD_CLASSES[cls];
        const road = { a: axis, k, p: (axis === 'v' ? CX : CY) + k * S, c: cls[0], hw: rc.hw, ln: rc.lanes, e: (hi - lo) * S / 2, o: (axis === 'v' ? CY : CX) + (lo + hi) * S / 2 };
        if (style === 'cyber') road.st = 'neon'; else if (style === 'oldtown' && cls !== 'avenue') road.st = 'cobble'; else if (style === 'rural' && cls !== 'avenue') road.st = 'dirt';
        L.roads.push(road); (axis === 'v' ? L.rv : L.rh)[k] = road;
    }
    for (const v of L.roads) {
        if (v.a !== 'v') continue;
        for (const h of L.roads) {
            if (h.a !== 'h') continue;
            if (Math.abs(h.p - v.o) > v.e + 1 || Math.abs(v.p - h.o) > h.e + 1) continue;
            L.junctions.push({
                id: nid(), x: v.p, y: h.p,
                n: h.p > v.o - v.e + 1 ? v.hw : 0, s: h.p < v.o + v.e - 1 ? v.hw : 0,
                w: v.p > h.o - h.e + 1 ? h.hw : 0, e: v.p < h.o + h.e - 1 ? h.hw : 0, hv: v.hw, hh: h.hw
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
    const addTree = (x, y, v, r = 9) => { const t = { k: 'tree', t: 1, x: Math.round(x), y: Math.round(y), v: v | 0, r }; L.props.push(t); L.colliders.push(t); };   // a tree is its own collider
    const addBench = (x, y, horiz = true) => { const w = horiz ? 56 : 20, h = horiz ? 20 : 56, b = { k: 'bench', t: 0, x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h }; L.props.push(b); L.colliders.push(b); };
    const addLamp = (x, y) => { const l = { k: 'lamp', t: 1, x: Math.round(x), y: Math.round(y), r: 5 }; L.props.push(l); L.colliders.push(l); };   // props double as their own colliders
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
        if (wHash(seed, Math.round(B.x), Math.round(B.y)) < 0.55) { const ax = Math.round(B.x + B.w * 0.27), ay = Math.round(B.y + 6), atm = { k: 'atm', t: 0, x: ax, y: ay, w: 26, h: 14 }; L.props.push(atm); L.colliders.push(atm); }
    }
    const inset = (r, d) => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });

    const localCos = W_COMPANIES.filter(c => c.styles.includes(style) && c.kind !== 'farm' && !['gallery', 'museum', 'sawmill'].includes(c.id));
    function companyFor(b) { return localCos[Math.floor(wHash(seed, b.id, 77) * localCos.length)]; }
    function makeWork(b, id) { const co = id ? W_COMPANIES.find(c => c.id === id) : companyFor(b); b.work = co.id; b.sign = co.name; b.col = co.color; L.works.push(b); }

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
        for (let i = 0; i < n; i++) addBuilding('shop', Lr.x + i * sw + 6, Lr.y, sw - 12, sh, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), aw: Math.floor(rng() * 6), shop: pickShop(rng) });
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
        const D = ndAt(B.x + B.w / 2, B.y + B.h / 2);
        const basePrice = D < 0.62 ? 30000 : D < 0.82 ? 17000 : 10000;
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
        for (let i = 0; i < n; i++) addBuilding('shop', Lr.x + i * sw + 6, Lr.y + 10, sw - 12, 110, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), aw: Math.floor(rng() * 6), shop: pickShop(rng) });
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
                const barn = addBuilding('barn', tx + 330, ty + 90, 250, 170, { s: Math.floor(rng() * 9999), door: { dir: 'S' } });
                if (style === 'rural' && rng() < 0.45) makeWork(barn, 'coop');
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
        let mill = null;
        if (style === 'rural' && rng() < 0.4) {                       // a sawmill in the woods
            mill = { x: B.x + 70, y: B.y + 70, w: 460, h: 260 };
            makeWork(addBuilding('mill', mill.x, mill.y, mill.w, mill.h, { s: Math.floor(rng() * 9999), door: { dir: 'S' } }), 'sawmill');
            addDeco('yard', mill.x - 20, mill.y + mill.h + 10, mill.w + 40, 160);
        }
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            if (rng() > density) continue;
            const tx = B.x + 40 + (i + 0.5) * step, ty = B.y + 40 + (j + 0.5) * step;
            if (mill && tx < mill.x + mill.w + 90 && ty < mill.y + mill.h + 230) continue;
            addTree(B.x + 40 + (i + 0.5) * step + (rng() - 0.5) * 60, B.y + 40 + (j + 0.5) * step + (rng() - 0.5) * 60, Math.floor(rng() * 8), 10);
        }
    }


    // ---- city-style blocks ------------------------------------------------------------------------------------
    // shops: every shop sells something; what kind depends on the city's character
    const SHOP_MIX = {
        cyber: ['grocery', 'noodle', 'souvenir', 'cafe', 'electronics', 'sushi', 'bubbletea', 'games', 'pharmacy', 'fashion', 'bar', 'tacos', 'noodle', 'grocery'],
        oldtown: ['souvenir', 'bakery', 'cafe', 'souvenir', 'grocery', 'books', 'florist', 'deli', 'icecream', 'jewelry', 'music', 'perfume'],
        rural: ['general', 'general', 'hardware', 'bakery', 'pharmacy'],
        generic: ['grocery', 'cafe', 'souvenir', 'grocery', 'pizza', 'burger', 'pharmacy', 'hardware', 'books', 'pets', 'toys', 'sports', 'donut', 'florist', 'bakery'] };
    const pickShop = rng => { const m = SHOP_MIX[style] || SHOP_MIX.generic; return m[Math.floor(rng() * m.length)]; };
    const addStall = (x, y, sk, col) => { const s = { k: 'stall', x: Math.round(x), y: Math.round(y), w: 64, h: 40, sk, col: col | 0, id: nid() }; L.props.push(s); rectCol(s.x, s.y, s.w, s.h); return s; };
    const addHolo = (x, y, txt, col) => { L.props.push({ k: 'holo', x: Math.round(x), y: Math.round(y), w: 12, h: 12, txt, col }); circCol(x + 6, y + 6, 7); };
    const HOLO_TXT = ['NEON CORE', 'QUANTUM EX', 'SYNTH-MART', 'ZERO DAY', 'HYPERLOOP', 'NOODLE 24/7', 'CHROME', 'DATA HAVEN'];
    const HOLO_COL = ['#ff2bd6', '#00e5ff', '#9dff00', '#ffb000', '#7a5cff'];
    // the financial core gets supertalls: setback tiers, a spire and 250-400 floors (decided by a hash, so the rng stream is untouched)
    function supertall(b) {
        const d = Math.hypot(b.x + b.w / 2 - CX, b.y + b.h / 2 - CY) / R0, hsh = wHash(seed ^ 0x51a7, b.x | 0, b.y | 0);
        if (d < 0.14 ? hsh < 0.7 : d < 0.3 ? hsh < 0.22 : hsh < 0.03) { b.f = 250 + Math.floor(wHash(seed ^ 0x2f, b.y | 0, b.x | 0) * 150); b.st = 1; }
    }
    function cyberTowerBlock(B, rng) {
        const Lr = inset(B, W_SW + 12);
        if (rng() < 0.38 && Lr.w > 300) {
            const gap = 40, w = (Lr.w - gap) / 2;
            for (let i = 0; i < 2; i++) { const bw = w * (0.8 + rng() * 0.15), bh = Lr.h * (0.75 + rng() * 0.2); const b = addBuilding('tower', Lr.x + i * (w + gap) + (w - bw) / 2, Lr.y + (Lr.h - bh) / 2, bw, bh, { s: Math.floor(rng() * 9999), f: 70 + Math.floor(rng() * 90), t: Math.floor(rng() * 6), r: Math.floor(rng() * 4) }); supertall(b); if (rng() < 0.45) makeWork(b); }
        } else {
            const w = Lr.w * (0.72 + rng() * 0.2), h = Lr.h * (0.72 + rng() * 0.2);
            const b = addBuilding('tower', Lr.x + (Lr.w - w) * (0.3 + rng() * 0.4), Lr.y + (Lr.h - h) * (0.3 + rng() * 0.4), w, h, { s: Math.floor(rng() * 9999), f: 100 + Math.floor(rng() * 120), t: Math.floor(rng() * 6), r: Math.floor(rng() * 4) });
            supertall(b); if (rng() < 0.6) makeWork(b);
        }
        addHolo(B.x + 6, B.y + B.h - 18, HOLO_TXT[Math.floor(rng() * HOLO_TXT.length)], HOLO_COL[Math.floor(rng() * HOLO_COL.length)]);
        cornerLamps(B);
    }
    // multi-level shopping mall: the inside has several floors joined by escalators, with shops on every floor
    function megaMallBlock(B, rng) {
        const Lr = inset(B, W_SW + 10), big = Lr.w > 700;
        const bw = Lr.w - 24, bh = Lr.h * (big ? 0.7 : 0.78);
        const sd = Math.floor(rng() * 9999), lr = rng(); addBuilding('megamall', Lr.x + 12, Lr.y + 6, bw, bh, { s: sd, lv: style === 'cyber' ? (big && lr > 0.3 ? 6 : 4 + Math.floor(lr * 2)) : 3 + Math.floor(lr * (big ? 4 : 2)), nm: MALL_NAMES[Math.floor(rng() * MALL_NAMES.length)] });
        const py = Lr.y + bh + 30;
        if (big) { const lot = addLot(Lr.x, py + 30, Lr.w, Lr.y + Lr.h - py - 30, false); fillLotWithCars(lot, rng, 0.6); }
        else for (let i = 0; i < 3; i++) addTree(Lr.x + Lr.w * (0.2 + i * 0.3), py + 20, i, 8);
        if (style === 'cyber') addHolo(B.x + B.w / 2 - 6, B.y + 6, HOLO_TXT[Math.floor(rng() * HOLO_TXT.length)], HOLO_COL[Math.floor(rng() * HOLO_COL.length)]);
        cornerLamps(B);
    }
    function hotelBlock(B, rng, kind) {
        const Lr = inset(B, W_SW + 14);
        if (kind === 'hotel') {
            const w = Lr.w * 0.66, h = Lr.h * 0.6;
            addBuilding('hotel', Lr.x + (Lr.w - w) / 2, Lr.y + 10, w, h, { s: Math.floor(rng() * 9999), f: 18 + Math.floor(rng() * 30), stars: style === 'cyber' ? 5 : 4, nm: HOTEL_NAMES[Math.floor(rng() * HOTEL_NAMES.length)] });
            addDeco('path', Lr.x + Lr.w / 2 - 30, Lr.y + 10 + h, 60, Lr.h - h - 10);
            for (let i = 0; i < 4; i++) addTree(Lr.x + 40 + i * (Lr.w - 80) / 3, Lr.y + Lr.h - 40, i, 8);
        } else {
            const w = Math.min(Lr.w * 0.7, 360), h = Math.min(Lr.h * 0.42, 200);
            addBuilding('inn', Lr.x + (Lr.w - w) / 2, Lr.y + Lr.h - h - 20, w, h, { s: Math.floor(rng() * 9999), r: Math.floor(rng() * 6), nm: INN_NAMES[Math.floor(rng() * INN_NAMES.length)], door: { dir: 'S' } });
            for (let i = 0; i < 6; i++) if (rng() < 0.8) addTree(Lr.x + 40 + rng() * (Lr.w - 80), Lr.y + 30 + rng() * Math.max(10, Lr.h - h - 110), i, 8);
            addBench(Lr.x + Lr.w / 2, Lr.y + 40, true);
        }
        cornerLamps(B);
    }
    // fuel station: canopy over three pump islands, a shop to pay / buy snacks, all open to drive through
    function fuelBlock(B, rng) {
        const Lr = inset(B, W_SW + 6);
        addDeco('pave', Lr.x, Lr.y, Lr.w, Lr.h);
        const cw = Math.min(Lr.w * 0.62, 420), ch = Math.min(Lr.h * 0.5, 220), cx = Lr.x + 30, cy = Lr.y + (Lr.h - ch) / 2;
        addFuelStation(cx, cy, cw, ch, Lr.x + 30 + cw + 40, Lr.y + 30, Lr.w - cw - 100, Lr.h - 60, 'S');
    }
    function addFuelStation(cx, cy, cw, ch, sx, sy, sw, sh, door) {
        addDeco('canopy', cx, cy, cw, ch, { brand: FUEL_BRANDS[Math.floor(wHash(seed, Math.round(cx), Math.round(cy)) * FUEL_BRANDS.length)] });
        const n = 3, step = cw / n;
        for (let i = 0; i < n; i++) { const px = cx + step * (i + 0.5) - 10, py = cy + ch / 2 - 34; L.props.push({ k: 'pump', x: Math.round(px), y: Math.round(py), w: 20, h: 68, id: nid() }); rectCol(px, py, 20, 68); }
        if (sw > 60 && sh > 60) addBuilding('shop', sx, sy, Math.min(sw, 260), Math.min(sh, 170), { s: 7, t: 2, aw: 1, shop: 'grocery', fuel: 1, door: { dir: door } });
    }
    // old town: terraced houses round a courtyard, with galleries and souvenir shops on the street
    function oldBlock(B, rng) {
        const Lr = inset(B, W_SW + 4), d = Math.min(118, Lr.h * 0.3), side = Math.min(118, Lr.w * 0.3);
        const unit = (x, y, w, h, dir) => {
            const r = rng(), extra = { s: Math.floor(rng() * 9999), f: 2 + Math.floor(rng() * 3), r: Math.floor(rng() * 6), door: { dir } };
            if (r < 0.04) { const b = addBuilding('gallery', x, y, w, h, extra); makeWork(b, rng() < 0.6 ? 'gallery' : 'museum'); b.attr = 1; }
            else if (r < 0.1) makeWork(addBuilding('old', x, y, w, h, extra));
            else if (r < 0.3) addBuilding('shop', x, y, w, h, Object.assign(extra, { old: 1, shop: pickShop(rng), aw: Math.floor(rng() * 6) }));
            else addBuilding('old', x, y, w, h, extra);
        };
        for (const north of [true, false]) {
            const n = Math.max(2, Math.floor(Lr.w / 130)), uw = Lr.w / n;
            for (let i = 0; i < n; i++) unit(Lr.x + i * uw + 3, north ? Lr.y : Lr.y + Lr.h - d, uw - 6, d, north ? 'N' : 'S');
        }
        const y0 = Lr.y + d + 24, y1 = Lr.y + Lr.h - d - 24;
        if (y1 - y0 > 90) for (const west of [true, false]) {
            const n = Math.max(1, Math.floor((y1 - y0) / 130)), uh = (y1 - y0) / n;
            for (let i = 0; i < n; i++) unit(west ? Lr.x : Lr.x + Lr.w - side, y0 + i * uh + 3, side, uh - 6, west ? 'W' : 'E');
        }
        const cx = Lr.x + Lr.w / 2, cy = Lr.y + Lr.h / 2;                  // courtyard
        if (Lr.w - 2 * side > 120 && y1 - y0 > 120) { addTree(cx - 40, cy, 3, 9); addTree(cx + 40, cy + 10, 5, 9); }
        for (const x of [B.x + 13, B.x + B.w - 13]) for (const y of [B.y + 13, B.y + B.h - 13]) addLamp(x, y);
    }
    // market square: rows of stalls round a fountain (old town craft market / cyberpunk night market)
    function marketBlock(B, rng) {
        L.blocks[L.blocks.length - 1].g = 'plaza';
        const Lr = inset(B, W_SW + 10), cx = Lr.x + Lr.w / 2, cy = Lr.y + Lr.h / 2;
        addDeco('fountain', cx - 36, cy - 36, 72, 72); circCol(cx, cy, 36);
        const sk = style === 'cyber' ? 'noodle' : style === 'oldtown' ? 'craft' : style === 'rural' ? 'farm' : 'food';
        const cols = Math.max(2, Math.floor(Lr.w / 120)), rows = Math.max(2, Math.floor(Lr.h / 130));
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
            const x = Lr.x + (i + 0.5) * Lr.w / cols - 32, y = Lr.y + (j + 0.5) * Lr.h / rows - 20;
            if (Math.abs(x + 32 - cx) < 110 && Math.abs(y + 20 - cy) < 90) continue;
            if (rng() < 0.75) addStall(x, y, rng() < 0.25 ? 'food' : sk, Math.floor(rng() * 6));
        }
        cornerLamps(B);
        if (style === 'cyber') addHolo(Lr.x + 10, Lr.y + 10, 'NIGHT MARKET', '#ff2bd6');
    }
    function cathedralBlock(B, rng) {
        const Lr = inset(B, W_SW + 20), w = Lr.w * 0.62, h = Lr.h * 0.8;
        const b = addBuilding('cathedral', Lr.x + (Lr.w - w) / 2, Lr.y + 6, w, h, { s: 21, door: { dir: 'S' }, nm: 'Cathedral of ' + city.name });
        b.attr = 1;
        for (let i = 0; i < 4; i++) addBench(Lr.x + 40 + i * (Lr.w - 80) / 3, Lr.y + Lr.h - 20, true);
        cornerLamps(B);
    }

    // ---- airport: one macro cell with runway, taxiway, apron, terminal, tower, hangar and car parks ---------------
    // Laid out in a local frame with the terminal on the south side, mirrored when the airport lies south of the
    // centre so the terminal always faces the city. Two stands on the apron: A keeps a parked airliner, B is the
    // boarding gate where your flight waits and where arriving flights park.
    function airportBlock(B, rng, termTop) {
        const X0 = B.x + 20, W = B.w - 40, Y0 = B.y + 20, H = B.h - 40, cx = W / 2;
        const ry = (y, h = 0) => termTop ? Y0 + H - y - h : Y0 + y;
        const R = (x, y, w, h) => ({ x: Math.round(X0 + x), y: Math.round(ry(y, h)), w: Math.round(w), h: Math.round(h) });
        const P = (x, y) => ({ x: Math.round(X0 + x), y: Math.round(ry(y)) });
        const deco = (k, r, extra) => addDeco(k, r.x, r.y, r.w, r.h, extra);
        const rw = R(160, 1185, W - 320, 130);
        deco('runway', rw, { code: city.code });
        deco('taxiway', R(230, 1520, W - 460, 80));
        for (const x of [270, W - 270]) deco('taxiway', R(x - 40, 1250, 80, 350));
        for (const x of [cx - 380, cx + 380]) deco('taxiway', R(x - 40, 1560, 80, 520));
        deco('apron', R(cx - 820, 2050, 1640, 570), { flip: termTop ? 1 : 0 });
        deco('path', R(cx - 70, 2960, 140, H - 2960));
        const term = addBuilding('terminal', X0 + cx - 560, ry(2700, 260), 1120, 260, { door: { dir: termTop ? 'N' : 'S' }, s: Math.floor(rng() * 9999), code: city.code, nm: city.name, flip: termTop ? 1 : 0 });
        addBuilding('ctower', X0 + cx + 680, ry(2720, 120), 120, 120, { s: 3 });
        addBuilding('hangar', X0 + cx + 980, ry(2080, 400), 520, 400, { door: { dir: termTop ? 'S' : 'N' }, s: Math.floor(rng() * 9999) });
        for (const lx of [cx - 560, cx + 90]) { const r = R(lx, 3010, 470, 300); const lot = addLot(r.x, r.y, r.w, r.h, false); fillLotWithCars(lot, rng, 0.45); }
        const sa = P(cx - 380, 2330), sb = P(cx + 380, 2330);
        for (const [st, gate] of [[sa, 0], [sb, 1]]) {
            addDeco('plane', st.x - 125, st.y - 115, 250, 230, { a: 0, liv: gate ? 0 : 1 + idx % 5, gate, cx: st.x, cy: st.y });
            for (let o = -100; o <= 100; o += 50) circCol(st.x + o, st.y, 18);
        }
        for (let i = 0; i < 14; i++) { const p = P(120 + rng() * (W - 240), 120 + rng() * 820); addTree(p.x, p.y, Math.floor(rng() * 8), 9); }
        for (let i = 0; i < 8; i++) { const p = P(rng() < 0.5 ? 60 + rng() * 300 : W - 360 + rng() * 300, 1800 + rng() * 1100); addTree(p.x, p.y, Math.floor(rng() * 8), 9); }
        L.airport = {
            city: city.id, name: city.name + ' Airport', code: city.code, x0: rw.x, x1: rw.x + rw.w, ry: P(0, 1250).y, ty: P(0, 1560).y,
            endW: Math.round(X0 + 270), endE: Math.round(X0 + W - 270), cb: sb.x, sa, sb, off: P(cx + 380, 2480),
            door: { x: term.door.x, y: term.door.y }, term: { id: term.id, x: term.x, y: term.y, w: term.w, h: term.h, dir: term.door.dir }, flip: termTop ? 1 : 0
        };
    }

    // ---- per-cell content --------------------------------------------------------------------------------------
    const hwAt = (axis, k) => (axis === 'v' ? L.rv[k] : L.rh[k]).hw;
    function cell(k0, m0, k1, m1, sizeKind, zone) {
        const x = CX + k0 * S + hwAt('v', k0), y = CY + m0 * S + hwAt('h', m0);
        const w = (k1 - k0) * S - hwAt('v', k0) - hwAt('v', k1), h = (m1 - m0) * S - hwAt('h', m0) - hwAt('h', m1);
        const B = { x, y, w, h };
        const rng = wRng(Math.floor(wHash(seed, k0 * 131 + 7, m0 * 197 + 3) * 4294967296));
        const blk = { id: nid(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), z: zone, g: zone === 3 ? 'grass' : 'pav', sw: zone === 3 ? 0 : W_SW };
        L.blocks.push(blk);
        if (sizeKind === 'airport') { blk.g = 'airport'; airportBlock(B, rng, m0 >= 0); return; }
        const r = rng();
        if (sizeKind === 'core') {
            // landmarks at fixed cells around the central avenue crossing
            const key = k0 + ',' + m0;
            if (key === '0,0') {                                       // central plaza (spawn)
                if (style === 'oldtown') marketBlock(B, rng); else parkBlock(B, rng, false);
                blk.g = 'plaza';
                L.spawn = { x: Math.round(B.x + B.w / 2), y: Math.round(B.y + B.h - 52) };
                return;
            }
            if (home && key === '-1,0') { const Lr = inset(B, W_SW + 10); L.bank = addBuilding('bank', Lr.x, Lr.y + 8, Lr.w, Lr.h - 16, { door: { dir: 'S' }, s: 11 }); cornerLamps(B); return; }
            if (home && key === '1,0') { const Lr = inset(B, W_SW + 10); L.dealer = addBuilding('dealer', Lr.x, Lr.y + 8, Lr.w, Lr.h * 0.62, { door: { dir: 'S' }, s: 12 }); const lot = addLot(Lr.x, Lr.y + 8 + Lr.h * 0.62 + 24, Lr.w, Lr.h - Lr.h * 0.62 - 40, true); lot.showroom = true; cornerLamps(B); return; }
            if (home && key === '2,0') { L.dealerLot = carparkBlock(B, rng, true); return; }
            if (key === '0,-1') { if (style === 'oldtown') cathedralBlock(B, rng); else { const Lr = inset(B, W_SW + 12); addBuilding('hall', Lr.x, Lr.y + 20, Lr.w, Lr.h - 40, { door: { dir: 'S' }, s: 13 }); cornerLamps(B); } return; }
            if (key === '1,1') { hotelBlock(B, rng, style === 'oldtown' || style === 'rural' ? 'inn' : 'hotel'); return; }
            if (key === '-1,1') { if (style === 'rural') shopStripBlock(B, rng); else if (style === 'cyber') marketBlock(B, rng); else fuelBlock(B, rng); return; }
            if (key === '0,1' || key === '-1,-1') { carparkBlock(B, rng, false); return; }
            if (key === '1,-1') { if (style === 'cyber') megaMallBlock(B, rng); else parkBlock(B, rng, false); return; }
            if (style === 'cyber') {
                if (r < 0.5) cyberTowerBlock(B, rng); else if (r < 0.62) megaMallBlock(B, rng); else if (r < 0.7) twinBlock(B, rng);
                else if (r < 0.77) carparkBlock(B, rng, false); else if (r < 0.83) marketBlock(B, rng); else if (r < 0.91) shopsBlock(B, rng); else if (r < 0.96) hotelBlock(B, rng, 'hotel'); else parkBlock(B, rng, false);
            } else if (style === 'oldtown') {
                if (r < 0.58) oldBlock(B, rng); else if (r < 0.7) marketBlock(B, rng); else if (r < 0.8) parkBlock(B, rng, false); else if (r < 0.88) hotelBlock(B, rng, 'inn'); else if (r < 0.95) shopsBlock(B, rng); else carparkBlock(B, rng, false);
            } else if (style === 'rural') {
                if (r < 0.35) shopStripBlock(B, rng); else if (r < 0.65) housingBlock(B, rng); else if (r < 0.8) parkBlock(B, rng, false); else allotmentBlock(B, rng);
            } else {
                if (r < 0.42) towerBlock(B, rng, false); else if (r < 0.58) twinBlock(B, rng); else if (r < 0.68) carparkBlock(B, rng, false);
                else if (r < 0.76) parkBlock(B, rng, false); else if (r < 0.86) shopsBlock(B, rng); else if (r < 0.9) marketBlock(B, rng); else if (r < 0.95) hotelBlock(B, rng, 'hotel'); else megaMallBlock(B, rng);
            }
        } else if (zone <= 1) {
            if (style === 'cyber') {
                if (r < 0.36) cyberTowerBlock(B, rng); else if (r < 0.5) megaMallBlock(B, rng); else if (r < 0.62) aptBlock(B, rng); else if (r < 0.7) carparkBlock(B, rng, false);
                else if (r < 0.78) parkBlock(B, rng, true); else if (r < 0.86) shopsBlock(B, rng); else if (r < 0.91) fuelBlock(B, rng); else if (r < 0.96) hotelBlock(B, rng, 'hotel'); else marketBlock(B, rng);
            } else if (style === 'oldtown') {
                if (r < 0.5) oldBlock(B, rng); else if (r < 0.62) housingBlock(B, rng); else if (r < 0.72) parkBlock(B, rng, true); else if (r < 0.8) marketBlock(B, rng);
                else if (r < 0.87) hotelBlock(B, rng, 'inn'); else if (r < 0.93) shopStripBlock(B, rng); else if (r < 0.97) fuelBlock(B, rng); else carparkBlock(B, rng, false);
            } else if (style === 'rural') {
                if (r < 0.6) housingBlock(B, rng); else if (r < 0.78) allotmentBlock(B, rng); else if (r < 0.88) shopStripBlock(B, rng); else if (r < 0.94) fuelBlock(B, rng); else hotelBlock(B, rng, 'inn');
            } else {
                if (r < 0.26) midriseBlock(B, rng); else if (r < 0.42) aptBlock(B, rng); else if (r < 0.54) mallBlock(B, rng); else if (r < 0.6) megaMallBlock(B, rng);
                else if (r < 0.68) carparkBlock(B, rng, false); else if (r < 0.77) parkBlock(B, rng, true); else if (r < 0.84) towerBlock(B, rng, true);
                else if (r < 0.9) shopsBlock(B, rng); else if (r < 0.94) fuelBlock(B, rng); else hotelBlock(B, rng, 'hotel');
            }
        } else if (zone === 2) {
            if (style === 'rural') {
                if (r < 0.5) housingBlock(B, rng); else if (r < 0.75) allotmentBlock(B, rng); else if (r < 0.92) farmBlock(B, rng, 1, 1, 'farm'); else if (r < 0.96) shopStripBlock(B, rng); else fuelBlock(B, rng);
            } else {
                if (r < 0.66) housingBlock(B, rng); else if (r < 0.75) allotmentBlock(B, rng); else if (r < 0.84) parkBlock(B, rng, true);
                else if (r < 0.89) schoolBlock(B, rng); else if (r < 0.95) shopStripBlock(B, rng); else if (r < 0.98) fuelBlock(B, rng); else hotelBlock(B, rng, style === 'oldtown' ? 'inn' : 'hotel');
            }
        } else {
            if (r < 0.5) farmBlock(B, rng, 3, 3, 'farm');
            else if (r < 0.68) farmBlock(B, rng, 2, 2, 'ranch');
            else if (r < 0.9) forestBlock(B, rng, 0.62);
            else forestBlock(B, rng, 0.14);
        }
    }
    for (const c of cells) cell(c[0], c[1], c[2], c[3], c[4], c[5]);
    for (const b of L.buildings) {
        b.city = city.id;
        if (b.price) b.price = Math.max(500, Math.round(b.price * city.priceMul / 500) * 500);
        if (style === 'cyber' && ['tower', 'mid', 'megamall', 'hotel', 'shop', 'apt', 'mall'].includes(b.k)) b.neon = 1;
        if (b.shop) { const sk = SHOP_KINDS[b.shop] || SHOP_KINDS.grocery; b.sn = sk.ic + ' ' + sk.name; }
    }
    if (style === 'cyber') L.buildings.filter(b => b.k === 'megamall').sort((p, q) => Math.hypot(p.x - CX, p.y - CY) - Math.hypot(q.x - CX, q.y - CY)).slice(0, 4).forEach(b => { b.lv = 6; });   // downtown always has casinos
    for (const p of L.props) if (p.k === 'stall') p.city = city.id;
    // used for the city-limit outline: developed cells and the airport count as "inside"
    L.devAt = (x, y) => { const I = Math.floor((x - CX) / 3600), J = Math.floor((y - CY) / 3600); if (I < -M || J < -M || I >= M || J >= M) return false; return !!dev[mIdx(I, J)] || (air && I === air.I && J === air.J); };
    return L;
}
function indexLayout(L) {
    L.dealerLot = L.dealerLot || L.lots.find(l => l.dealer);
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
    const put = (name, o, w, h) => {
        const x0 = Math.max(0, Math.floor(o.x / W_CHUNK)), x1 = Math.min(W_NCH - 1, Math.floor((o.x + (w || 0)) / W_CHUNK));
        const y0 = Math.max(0, Math.floor(o.y / W_CHUNK)), y1 = Math.min(W_NCH - 1, Math.floor((o.y + (h || 0)) / W_CHUNK));
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) chunkList(cx + cy * W_NCH)[name].push(o);
    };
    L.blocks.forEach(o => put('blocks', o, o.w, o.h));
    L.buildings.forEach(o => put('buildings', o, o.w, o.h));
    L.lots.forEach(o => put('lots', o, o.w, o.h));
    L.fields.forEach(o => put('fields', o, o.w, o.h));
    L.props.forEach(o => put('props', o, o.w || 0, o.h || 0));
    L.pcars.forEach(o => put('pcars', o, 0, 0));
    L.junctions.forEach(o => put('junctions', o, 0, 0));
    (L.xjunctions || []).forEach(o => put('junctions', o, 0, 0));
    L.chunkJson = new Map();
    return L;
}
// City-limit outline: on each ray, just past the last developed block (or airport), then smoothed.
function cityBorderOutline(C, city) {
    const N = W_BORDER_N, raw = [];
    for (let i = 0; i < N; i++) {
        const a = i / N * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        let last = 0;
        for (let r = 0; r < city.size * 2.2; r += 150) if (C.devAt(city.cx + c * r, city.cy + s * r)) last = r;
        raw.push(last + 500);
    }
    const win = (arr, i, f) => f([-2, -1, 0, 1, 2].map(o => arr[(i + o + N) % N]));
    const mx = raw.map((_, i) => win(raw, i, v => Math.max(...v)));
    return mx.map((_, i) => Math.round(win(mx, i, v => v.reduce((p, q) => p + q, 0) / v.length)));
}

// ---- the countryside: service areas along every highway, and forests, farms, villages, orchards, wind farms, lakes and
// rocks both beside the highways and across the open interior of the continent. An occupancy grid keeps features from
// overlapping each other, the roads and the towns.
function addCountryside(L, seed) {
    let id = 50000000;
    const OC = 400, occ = new Set(), key = (i, j) => i * 100000 + j;
    const cellsOf = (r, fn) => { for (let i = Math.floor(r.x / OC); i <= Math.floor((r.x + r.w) / OC); i++) for (let j = Math.floor(r.y / OC); j <= Math.floor((r.y + r.h) / OC); j++) if (fn(key(i, j)) === false) return false; return true; };
    const mark = r => cellsOf(r, k => { occ.add(k); });
    const nearCity = (x, y, m) => W_CITIES.some(c => Math.abs(x - c.cx) < c.extR + m && Math.abs(y - c.cy) < c.extR + m && Math.hypot(x - c.cx, y - c.cy) < c.extR + m);   // extR covers the farm/forest ring too
    const free = (r, m = 2200) => {
        if (r.x < W_LAND.x0 + 600 || r.y < W_LAND.y0 + 600 || r.x + r.w > W_LAND.x1 - 600 || r.y + r.h > W_LAND.y1 - 600) return false;
        for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h / 2]]) if (nearCity(px, py, m)) return false;
        return cellsOf(r, k => !occ.has(k));
    };
    // highways and their junctions are off limits
    for (const h of L.highways) mark(h.a === 'h' ? { x: h.s0, y: h.p - 340, w: h.s1 - h.s0, h: 680 } : { x: h.p - 340, y: h.s0, w: 680, h: h.s1 - h.s0 });
    for (const j of L.xjunctions) if (j.tj) mark({ x: j.x - 900, y: j.y - 900, w: 1800, h: 1800 });
    const tree = (x, y, v, check = true) => {
        const r = { x: x - 30, y: y - 30, w: 60, h: 60 }; if (check && !free(r, 400)) return false;
        const t = { k: 'tree', t: 1, x: Math.round(x), y: Math.round(y), v, r: 10 }; L.props.push(t); L.colliders.push(t); return true;
    };
    const bld = (kind, r, extra) => {
        const b = Object.assign({ id: id++, k: kind, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, extra || {}), d = b.door || (b.door = { dir: 'S' });
        d.x = Math.round(d.dir === 'E' ? b.x + b.w : d.dir === 'W' ? b.x : b.x + b.w / 2); d.y = Math.round(d.dir === 'S' ? b.y + b.h : d.dir === 'N' ? b.y : b.y + b.h / 2);
        L.buildings.push(b); L.colliders.push({ t: 0, x: b.x, y: b.y, w: b.w, h: b.h }); return b;
    };
    const deco = (k, r, extra, solid) => { L.props.push(Object.assign({ k, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, extra || {})); if (solid) L.colliders.push({ t: 0, x: r.x, y: r.y, w: r.w, h: r.h }); };
    const house = (r, dir, rng, price) => {
        const hid = 'v' + id, b = bld('house', r, { s: Math.floor(rng() * 9999), t: Math.floor(rng() * 6), r: Math.floor(rng() * 6), door: { dir }, tier: rng() < 0.3 ? 1 : 0, price, hid, gar: rng() > 0.5, por: rng() > 0.4, fen: rng() > 0.4, lot: [Math.round(r.x - 30), Math.round(r.y - 30), Math.round(r.w + 60), Math.round(r.h + 60)] });
        L.houses.push(b); return b;
    };
    const stats = { trees: 0, farms: 0, villages: 0, forests: 0, turbines: 0, lakes: 0 };

    // ---- features (each returns false if it does not fit) ----
    function forest(cx, cy, rad, rng, dens = 1) {
        if (!free({ x: cx - rad * 0.4, y: cy - rad * 0.4, w: rad * 0.8, h: rad * 0.8 }, 1500)) return false;
        const n = Math.floor(rad * rad / 70000 * dens); let k = 0;
        for (let i = 0; i < n; i++) { const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * rad * (0.85 + 0.15 * Math.sin(a * 3 + cx)); if (tree(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng() < 0.75 ? Math.floor(rng() * 4) * 2 : Math.floor(rng() * 8))) k++; }
        mark({ x: cx - rad, y: cy - rad, w: 2 * rad, h: 2 * rad });
        stats.forests++; stats.trees += k; return k > 0;
    }
    function farm(cx, cy, rng) {
        const nx = 2 + Math.floor(rng() * 2), ny = 2, fw = 520, fh = 420, gap = 40, W = nx * (fw + gap) + 420, H = ny * (fh + gap);
        const R = { x: cx - W / 2, y: cy - H / 2, w: W, h: H }; if (!free({ x: R.x - 80, y: R.y - 80, w: R.w + 160, h: R.h + 160 })) return false;
        mark({ x: R.x - 80, y: R.y - 80, w: R.w + 160, h: R.h + 160 });
        const crop = Math.floor(rng() * 5);
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
            const f = { id: id++, x: Math.round(R.x + i * (fw + gap)), y: Math.round(R.y + j * (fh + gap)), w: fw, h: fh, kind: 'farm', crop: (crop + i + j) % 5, target: 12 };
            L.fields.push(f); deco('fence', { x: f.x - 14, y: f.y - 14, w: f.w + 28, h: f.h + 28 });
        }
        const sx = R.x + nx * (fw + gap) + 30;                    // farmstead to the east of the fields
        house({ x: sx, y: R.y + 40, w: 150, h: 110 }, 'S', rng, 6500).k = 'farmhouse';
        bld('barn', { x: sx + 10, y: R.y + 300, w: 240, h: 160 }, { s: Math.floor(rng() * 9999), door: { dir: 'S' } });
        deco('silo', { x: sx + 280, y: R.y + 60, w: 84, h: 84 }); L.colliders.push({ t: 1, x: sx + 322, y: R.y + 102, r: 42 });
        for (let q = 0; q < 5; q++) { const hx = sx + 40 + rng() * 280, hy = R.y + 500 + rng() * Math.max(40, H - 560); if (hy < R.y + H - 30) { deco('hay', { x: hx - 18, y: hy - 18, w: 36, h: 36 }); L.colliders.push({ t: 1, x: hx, y: hy, r: 16 }); } }
        stats.farms++; return true;
    }
    function orchard(cx, cy, rng) {
        const nx = 6 + Math.floor(rng() * 4), ny = 4 + Math.floor(rng() * 3), sp = 130, R = { x: cx - nx * sp / 2, y: cy - ny * sp / 2, w: nx * sp, h: ny * sp };
        if (!free(R)) return false; mark(R); const v = rng() < 0.5 ? 1 : 5;
        deco('meadow', { x: R.x - 30, y: R.y - 30, w: R.w + 60, h: R.h + 60 });
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) tree(R.x + (i + 0.5) * sp, R.y + (j + 0.5) * sp, v, false);
        stats.trees += nx * ny; return true;
    }
    function windfarm(cx, cy, rng, horiz) {
        const n = 3 + Math.floor(rng() * 4), sp = 320, R = horiz ? { x: cx - n * sp / 2, y: cy - 120, w: n * sp, h: 240 } : { x: cx - 120, y: cy - n * sp / 2, w: 240, h: n * sp };
        if (!free(R)) return false; mark(R);
        for (let i = 0; i < n; i++) { const x = horiz ? R.x + (i + 0.5) * sp : cx, y = horiz ? cy : R.y + (i + 0.5) * sp; L.props.push({ k: 'turbine', x: Math.round(x - 12), y: Math.round(y - 12), w: 24, h: 24, ph: Math.round(rng() * 628) / 100 }); L.colliders.push({ t: 1, x, y, r: 13 }); }
        stats.turbines += n; return true;
    }
    function lake(cx, cy, rng) {
        const rx = 500 + rng() * 900, ry = 300 + rng() * 500, R = { x: cx - rx - 60, y: cy - ry - 60, w: 2 * rx + 120, h: 2 * ry + 120 };
        if (!free(R)) return false; mark(R);
        L.props.push({ k: 'lake', x: Math.round(R.x), y: Math.round(R.y), w: Math.round(R.w), h: Math.round(R.h), rx: Math.round(rx), ry: Math.round(ry) });
        for (let i = 0; i < 10; i++) { const a = rng() * Math.PI * 2; tree(cx + Math.cos(a) * (rx + 140 + rng() * 200), cy + Math.sin(a) * (ry + 140 + rng() * 200), Math.floor(rng() * 8)); }
        stats.lakes++; return true;
    }
    function rocks(cx, cy, rng) {
        const R = { x: cx - 300, y: cy - 300, w: 600, h: 600 }; if (!free(R)) return false; mark(R);
        const n = 4 + Math.floor(rng() * 6);
        for (let i = 0; i < n; i++) { const x = cx + (rng() - 0.5) * 520, y = cy + (rng() - 0.5) * 520, r = 14 + rng() * 26; L.props.push({ k: 'rock', x: Math.round(x - r), y: Math.round(y - r), w: Math.round(2 * r), h: Math.round(2 * r), v: Math.floor(rng() * 4) }); L.colliders.push({ t: 1, x, y, r: r * 0.85 }); }
        return true;
    }
    function meadow(cx, cy, rng) {
        const R = { x: cx - 450, y: cy - 300, w: 900, h: 600 }; if (!free(R)) return false; mark(R);
        deco('meadow', R);
        for (let i = 0; i < 7; i++) { const x = R.x + 60 + rng() * (R.w - 120), y = R.y + 60 + rng() * (R.h - 120); deco('hay', { x: x - 18, y: y - 18, w: 36, h: 36 }); L.colliders.push({ t: 1, x, y, r: 16 }); }
        return true;
    }
    // a hamlet: houses round a small green with a general store and a well; the houses can be bought
    function village(cx, cy, rng) {
        const R = { x: cx - 760, y: cy - 760, w: 1520, h: 1520 }; if (!free(R, 3000)) return false; mark(R);
        deco('green', { x: cx - 320, y: cy - 320, w: 640, h: 640 });
        deco('well', { x: cx - 26, y: cy - 26, w: 52, h: 52 }); L.colliders.push({ t: 1, x: cx, y: cy, r: 24 });
        const spots = [];
        for (let i = 0; i < 4; i++) spots.push(['N', cx - 560 + i * 300, cy - 620]), spots.push(['S', cx - 560 + i * 300, cy + 500]);
        spots.push(['W', cx - 640, cy - 220], ['W', cx - 640, cy + 120], ['E', cx + 510, cy - 220], ['E', cx + 510, cy + 120]);
        const store = Math.floor(rng() * spots.length);
        spots.forEach(([side, x, y], i) => {
            const dir = { N: 'S', S: 'N', W: 'E', E: 'W' }[side], r = side === 'N' || side === 'S' ? { x, y, w: 170, h: 120 } : { x, y, w: 130, h: 160 };
            if (i === store) bld('shop', r, { s: 4, t: 2, aw: 2, shop: 'general', sn: 'General Store', door: { dir } });
            else if (rng() < 0.85) house(r, dir, rng, 9000);
        });
        for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; tree(cx + Math.cos(a) * 250, cy + Math.sin(a) * 250, Math.floor(rng() * 8), false); }
        stats.villages++; return true;
    }

    // ---- along the highways ----
    const hwRoads = L.xroads.filter(r => r.c === 'x');
    L.services = [];
    const pt = (h, s, side, v) => { const E = 130 + 30; return h.a === 'h' ? { x: s, y: h.p + side * (E + v) } : { x: h.p + side * (E + v), y: s }; };
    L.highways.forEach((h, hi) => {
        const road = hwRoads[hi], len = h.s1 - h.s0, rng = wRng((seed ^ (hi * 7919 + 13)) >>> 0), stops = [];
        const nSvc = len > 300000 ? 3 : len > 120000 ? 2 : 1;
        for (let i = 0; i < nSvc; i++) {
            const s = Math.round(h.s0 + len * (i + 1) / (nSvc + 1)), side = (hi + i) % 2 ? 1 : -1;
            if (addServiceArea(L, road, h, s, side, hi, i, () => id++, mark, free)) stops.push(s);
        }
        for (let s = h.s0 + 3000; s < h.s1 - 3000; s += 3600) {
            if (stops.some(q => Math.abs(q - s) < 1800)) continue;
            for (const side of [-1, 1]) {
                const r = rng(), off = (lo, hi2) => lo + rng() * (hi2 - lo);
                if (r < 0.24) { const n = 6 + Math.floor(rng() * 10), v = Math.floor(rng() * 4) * 2, o = off(250, 300); for (let q = 0; q < n; q++) { const c = pt(h, s + q * 75 - n * 37, side, o); if (tree(c.x, c.y, v)) stats.trees++; } const a = pt(h, s - n * 37 - 40, side, o - 40), b = pt(h, s + n * 37 + 40, side, o + 40); mark({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }); }
                else if (r < 0.46) { const c = pt(h, s, side, off(800, 2600)); forest(c.x, c.y, off(600, 1500), rng); }
                else if (r < 0.6) { const c = pt(h, s, side, off(1400, 2600)); farm(c.x, c.y, rng); }
                else if (r < 0.66) { const c = pt(h, s, side, off(900, 2000)); orchard(c.x, c.y, rng); }
                else if (r < 0.7) { const c = pt(h, s, side, off(700, 1600)); windfarm(c.x, c.y, rng, h.a === 'h'); }
                else if (r < 0.725) { const c = pt(h, s, side, off(1800, 2600)); village(c.x, c.y, rng); }
                else if (r < 0.75) { const c = pt(h, s, side, off(1500, 3000)); lake(c.x, c.y, rng); }
                else if (r < 0.8) { const c = pt(h, s, side, off(600, 1800)); rocks(c.x, c.y, rng); }
                else if (r < 0.85) { const c = pt(h, s, side, off(800, 1800)); meadow(c.x, c.y, rng); }
                else if (r < 0.88) {
                    const c = pt(h, s, side, 120), co = W_COMPANIES[Math.floor(rng() * W_COMPANIES.length)];
                    const pr = h.a === 'h' ? { x: Math.round(c.x - 90), y: Math.round(c.y - 8), w: 180, h: 16 } : { x: Math.round(c.x - 8), y: Math.round(c.y - 90), w: 16, h: 180 };
                    if (free(pr, 1500)) { mark(pr); L.props.push({ k: 'billboard', ...pr, txt: co.name, col: co.color }); L.colliders.push({ t: 0, ...pr }); }
                }
            }
        }
    });
    // ---- the open interior of the continent ----
    const rng = wRng((seed ^ 0xc0ffee) >>> 0), CELL = 36000;
    const distHw = (x, y) => { let m = Infinity; for (const h of L.highways) { const al = h.a === 'h' ? x : y, pe = h.a === 'h' ? y : x, c = Math.max(h.s0, Math.min(h.s1, al)); m = Math.min(m, Math.hypot(al - c, pe - h.p)); } return m; };
    for (let x = W_LAND.x0 + CELL / 2; x < W_LAND.x1; x += CELL) for (let y = W_LAND.y0 + CELL / 2; y < W_LAND.y1; y += CELL) {
        const cx = x + (rng() - 0.5) * CELL * 0.6, cy = y + (rng() - 0.5) * CELL * 0.6, r = rng();
        if (distHw(cx, cy) < 4000 || nearCity(cx, cy, 5000)) continue;
        if (r < 0.32) forest(cx, cy, 1800 + rng() * 2000, rng, 0.85);
        else if (r < 0.52) { for (let q = 0; q < 2 + Math.floor(rng() * 2); q++) farm(cx + (rng() - 0.5) * 6000, cy + (rng() - 0.5) * 6000, rng); }
        else if (r < 0.59) lake(cx, cy, rng);
        else if (r < 0.66) village(cx, cy, rng);
        else if (r < 0.71) windfarm(cx, cy, rng, rng() < 0.5);
        else if (r < 0.77) orchard(cx, cy, rng);
        else if (r < 0.82) rocks(cx, cy, rng);
        else if (r < 0.88) meadow(cx, cy, rng);
    }
    L.countryStats = stats;
}
// Service area next to a highway: fuel station (canopy, pumps, shop), diner, motel and its car park.
function addServiceArea(L, road, h, s, side, hi, i, nextId, mark, free) {
    const rect = (u0, v0, w, hh) => {
        const E = road.hw + 30;
        if (h.a === 'h') return { x: Math.round(s + u0), y: Math.round(side > 0 ? h.p + E + v0 : h.p - E - v0 - hh), w: Math.round(w), h: Math.round(hh) };
        return { x: Math.round(side > 0 ? h.p + E + v0 : h.p - E - v0 - hh), y: Math.round(s + u0), w: Math.round(hh), h: Math.round(w) };
    };
    const pt = (u, v) => { const E = road.hw + 30; return h.a === 'h' ? { x: s + u, y: h.p + side * (E + v) } : { x: h.p + side * (E + v), y: s + u }; };
    const dd = h.a === 'h' ? (side > 0 ? 'N' : 'S') : (side > 0 ? 'W' : 'E');
    const bld = (kind, r, extra) => {
        const b = Object.assign({ id: nextId(), k: kind, x: r.x, y: r.y, w: r.w, h: r.h }, extra || {}), d = b.door;
        d.x = Math.round(d.dir === 'E' ? b.x + b.w : d.dir === 'W' ? b.x : b.x + b.w / 2); d.y = Math.round(d.dir === 'S' ? b.y + b.h : d.dir === 'N' ? b.y : b.y + b.h / 2);
        L.buildings.push(b); L.colliders.push({ t: 0, x: b.x, y: b.y, w: b.w, h: b.h }); return b;
    };
    const pave = rect(-780, 0, 1820, 900);
    // must not touch any other highway (its own lies right next to it) or a town
    for (const o of L.highways) { if (o === h) continue; const r = o.a === 'h' ? { x: o.s0, y: o.p - 400, w: o.s1 - o.s0, h: 800 } : { x: o.p - 400, y: o.s0, w: 800, h: o.s1 - o.s0 }; if (pave.x < r.x + r.w && pave.x + pave.w > r.x && pave.y < r.y + r.h && pave.y + pave.h > r.y) return false; }
    if (W_CITIES.some(c => Math.hypot(pave.x + pave.w / 2 - c.cx, pave.y + pave.h / 2 - c.cy) < c.extR + 1500)) return false;
    mark({ x: pave.x - 300, y: pave.y - 300, w: pave.w + 600, h: pave.h + 600 });
    L.props.push({ k: 'pave', ...pave });
    const can = rect(-740, 150, 460, 240);
    L.props.push({ k: 'canopy', ...can, brand: FUEL_BRANDS[(hi + i) % FUEL_BRANDS.length] });
    for (let q = 0; q < 3; q++) {
        const c = pt(-740 + 460 * (q + 0.5) / 3, 270);
        const pr = h.a === 'h' ? { x: Math.round(c.x - 10), y: Math.round(c.y - 34), w: 20, h: 68 } : { x: Math.round(c.x - 34), y: Math.round(c.y - 10), w: 68, h: 20 };
        L.props.push({ k: 'pump', ...pr, id: nextId() }); L.colliders.push({ t: 0, ...pr });
    }
    bld('shop', rect(-760, 520, 300, 190), { s: 5, t: 1, aw: 3, shop: 'grocery', sn: 'Grocery', fuel: 1, door: { dir: dd } });
    bld('shop', rect(-420, 520, 260, 190), { s: 9, t: 3, aw: 0, shop: 'cafe', sn: 'Diner', door: { dir: dd } });
    bld('motel', rect(0, 500, 680, 230), { s: 3 + i, r: (hi + i) % 6, nm: ['Starlite Motel', 'Highway Rest', 'Sunset Motor Inn', 'Pine Lodge Motel'][(hi + i) % 4], door: { dir: dd } });
    if (h.a === 'h') L.lots.push({ id: nextId(), ...rect(0, 130, 680, 300), dealer: false });
    const c = pt(0, 400); L.services.push({ x: Math.round(c.x), y: Math.round(c.y), name: 'Service area' });
    return true;
}

function buildWorldLayout(seed) {
    const L = { seed, roads: [], xroads: [], junctions: [], xjunctions: [], blocks: [], buildings: [], props: [], lots: [], fields: [], pcars: [], colliders: [], houses: [], works: [], highways: [], airports: [], cities: W_CITIES, rv: {}, rh: {} };
    const ends = new Map();
    W_CITIES.forEach((city, idx) => {
        const C = buildCityLayout((seed + (city.seedAdd || 0)) | 0, city, idx);
        if (city.home) { L.roads = C.roads; L.junctions = C.junctions; L.rv = C.rv; L.rh = C.rh; L.bank = C.bank; L.dealer = C.dealer; L.dealerLot = C.dealerLot; L.spawn = C.spawn; }
        else { for (const r of C.roads) { r.f = 1; L.xroads.push(r); } for (const j of C.junctions) { j.f = 1; L.xjunctions.push(j); } }
        for (const k of ['blocks', 'buildings', 'props', 'lots', 'fields', 'pcars', 'colliders', 'houses', 'works']) { const src = C[k], dst = L[k]; for (let i = 0; i < src.length; i++) dst.push(src[i]); }
        if (C.airport) L.airports.push(C.airport);
        city.bp = cityBorderOutline(C, city); city.border = Math.max(...city.bp);
        let ext = 0; for (const bl of C.blocks) ext = Math.max(ext, Math.hypot(Math.max(Math.abs(bl.x - city.cx), Math.abs(bl.x + bl.w - city.cx)), Math.max(Math.abs(bl.y - city.cy), Math.abs(bl.y + bl.h - city.cy))));
        Object.defineProperty(city, 'extR', { value: ext + 400, writable: true, configurable: true, enumerable: false });
        const h0 = C.rh[0], v0 = C.rv[0];                         // the avenues through the centre carry the highways
        ends.set(city.id, { w: h0.o - h0.e, e: h0.o + h0.e, n: v0.o - v0.e, s: v0.o + v0.e });
    });
    // Highway grid: along each row of cities (north, middle, south) and down each time-zone column. The crossroads towns
    // between the columns also link north and south with T-junctions onto the row highways. No road crosses the ocean.
    const add = (a, p, s0, s1) => {
        L.xroads.push({ a, k: 'hw' + L.highways.length, p, c: 'x', hw: 130, ln: 4, e: (s1 - s0) / 2, o: (s0 + s1) / 2, f: 1 }); L.highways.push({ a, p, s0, s1 });
    };
    const rows = [...new Set(W_CITIES.map(c => c.row))].sort((p, q) => p - q);
    for (const row of rows) {
        const cs = W_CITIES.filter(c => c.row === row).sort((p, q) => p.cx - q.cx);
        for (let i = 0; i + 1 < cs.length; i++) add('h', cs[i].cy, ends.get(cs[i].id).e, ends.get(cs[i + 1].id).w);
    }
    for (const col of [...new Set(W_CITIES.map(c => c.col))]) {
        const cs = W_CITIES.filter(c => c.col === col).sort((p, q) => p.cy - q.cy);
        if (Number.isInteger(col)) { for (let i = 0; i + 1 < cs.length; i++) add('v', cs[i].cx, ends.get(cs[i].id).s, ends.get(cs[i + 1].id).n); continue; }
        for (const t of cs) {                                       // crossroads town: spurs up and down to the row highways
            const north = W_CITIES.filter(c => c.row < t.row).reduce((m, c) => Math.max(m, c.cy), -Infinity), south = W_CITIES.filter(c => c.row > t.row).reduce((m, c) => Math.min(m, c.cy), Infinity);
            if (isFinite(north)) { add('v', t.cx, north, ends.get(t.id).n); L.xjunctions.push({ id: 60000000 + L.xjunctions.length, x: t.cx, y: north, n: 0, s: 130, e: 130, w: 130, hv: 130, hh: 130, f: 1, tj: 1 }); }
            if (isFinite(south)) { add('v', t.cx, ends.get(t.id).s, south); L.xjunctions.push({ id: 60000000 + L.xjunctions.length, x: t.cx, y: south, n: 130, s: 0, e: 130, w: 130, hv: 130, hh: 130, f: 1, tj: 1 }); }
        }
    }
    addCountryside(L, seed);
    for (const b of L.buildings) if (b.shop && !b.sn) b.sn = SHOP_KINDS[b.shop].ic + ' ' + SHOP_KINDS[b.shop].name;
    L.allRoads = L.roads.concat(L.xroads);
    indexLayout(L);
    return L;
}

// ---- flights -------------------------------------------------------------------------------------------------
// A flight is a small state machine that moves a plane (and the tank riding in it) through the open world:
// taxi from gate B to the runway end, take-off roll, climb, a straight cruise towards the destination's
// approach fix (the short way round the globe, so it may cross the date line), final approach, landing roll,
// taxi to gate B. Pure functions of plain data so they can be simulated without a server.
const FL_TAXI = 5, FL_VR = 26, FL_FINAL = 22000, FL_CLIMB = 14000, FL_DESC = 42000;
function flAng(a) { a = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a; }
function flTurn(a, b, rate) { const d = flAng(b - a); return flAng(a + Math.max(-rate, Math.min(rate, d))); }
function flightCreate(A, B, cruise) {
    const g = wGC(A.sb.x, A.sb.y, B.sb.x, B.sb.y), gB = wGC(B.sb.x, B.sb.y, A.sb.x, A.sb.y), dx = wrapDx(B.sb.x - A.sb.x);
    const east = Math.abs(Math.sin(g.brg)) > 0.2 ? Math.sin(g.brg) > 0 : dx >= 0;
    const arrE = -Math.sin(gB.brg), landDir = Math.abs(arrE) > 0.25 ? (arrE > 0 ? 1 : -1) : (dx >= 0 ? 1 : -1);   // land in the direction we arrive from
    const tdx = landDir > 0 ? B.x0 + 220 : B.x1 - 220, startX = east ? A.endW : A.endE, ifx = tdx - landDir * FL_FINAL;
    const cb = Math.cos(g.brg), head = cb > 0.7 ? 'north' : cb < -0.7 ? 'south' : east ? 'east' : 'west';
    return {
        from: A.city, to: B.city, dir: east ? 'east' : 'west', head, cruise, cs: cruise * FL_SPH, dist: Math.round(g.d), poles: 0, viaPole: wGCPole(A.sb.x, A.sb.y, B.sb.x, B.sb.y) || null,
        x: A.sb.x, y: A.sb.y, a: 0, v: 0, vs: 0, q: null, h: null, pz: 0, polar: false, alt: 0, ph: 'taxi', t: 0, climb: 0, wraps: 0, prevDI: Infinity, kA: wSec(A.ry),
        wp: [[A.cb, A.ty], [startX, A.ty], [startX, A.ry]],
        roll: { a: east ? 0 : Math.PI, y: A.ry },
        land: { tx: tdx, ty: B.ry, dir: landDir, ifx, exitX: landDir > 0 ? B.endE : B.endW, taxiY: B.ty, cb: B.cb, sb: B.sb, T: wVec(ifx, B.ry), kT: wSec(B.ry) }
    };
}
// Distance still to fly in true (sphere) units: great circle to the approach fix + final + landing roll, for the HUD / ETA.
function flightRemaining(f) {
    const L = f.land, tail = (FL_FINAL + 3000) / L.kT;
    if (f.ph === 'air' && f.q) return wDistV(f.q, L.T) + tail;
    if (f.ph === 'taxi' || f.ph === 'lineup' || f.ph === 'roll' || f.ph === 'air') return wDistV(wVec(f.x, f.y), L.T) + tail;
    if (f.ph === 'final') return (Math.max(0, -wrapDx(f.x - L.tx) * L.dir) + 3000) / L.kT;
    return 0;
}
function flightSpeed(f) { return f.ph === 'air' && f.q ? f.vs : f.v / f.land.kT; }   // true ground speed, sphere units per tick
// Advances one tick. Returns 'wrap' (date line), 'pole' (just passed over a pole) or 'done' (parked at the gate).
function flightStep(f) {
    f.t++;
    const L = f.land; let ev = null;
    const move = () => { f.x = wrapX(f.x + Math.cos(f.a) * f.v); f.y += Math.sin(f.a) * f.v; };   // on the ground / near the runways: the chart is exact
    switch (f.ph) {
        case 'taxi': case 'taxiin': {
            const w = f.wp[0];
            if (!w) { f.ph = f.ph === 'taxi' ? 'lineup' : 'park'; break; }
            const dx = w[0] - f.x, dy = w[1] - f.y, d = Math.hypot(dx, dy), last = f.wp.length === 1 && f.ph === 'taxiin';
            const want = last ? Math.min(FL_TAXI, Math.max(0.8, d * 0.03)) : FL_TAXI;
            f.v += Math.max(-0.25, Math.min(0.12, want - f.v));
            if (d > 2) f.a = flTurn(f.a, Math.atan2(dy, dx), 0.1);
            if (d <= Math.max(3, f.v)) { f.x = w[0]; f.y = w[1]; f.wp.shift(); }
            else { f.x += dx / d * f.v; f.y += dy / d * f.v; }        // the wheels follow the taxi line exactly; the nose turns smoothly
            break;
        }
        case 'lineup':
            f.v = Math.max(0, f.v - 0.3); f.a = flTurn(f.a, f.roll.a, 0.05);
            if (Math.abs(flAng(f.a - f.roll.a)) < 0.002) { f.a = f.roll.a; f.ph = 'roll'; }
            break;
        case 'roll':
            f.v += 0.22; f.a = f.roll.a; f.y += (f.roll.y - f.y) * 0.2; move();
            if (f.v >= FL_VR) f.ph = 'air';
            break;
        case 'air': {
            // Airborne the plane is a point q on the sphere with heading h (unit vectors). Each tick it turns h towards
            // the great circle to the approach fix and moves along its own great circle; the chart x/y/a are derived from
            // q and h. Close to the destination (always well inside the land zone) it flies the conformal chart directly.
            if (!f.q) { f.q = wVec(f.x, f.y); f.h = wTan(f.q, f.a); f.vs = f.v / wSec(f.y); }
            f.climb += f.vs * f.kA;
            const dxI = wrapDx(L.ifx - f.x), dyI = L.ty - f.y, dLoc = Math.hypot(dxI, dyI);
            const rem = wDistV(f.q, L.T) * L.kT + FL_FINAL;                                    // in destination chart units
            f.alt = Math.max(0, Math.min(1, f.climb / FL_CLIMB, rem / FL_DESC));
            const vr = FL_VR / L.kT, tv = Math.min(f.cs, vr + (f.cs - vr) * Math.max(0, Math.min(1, (rem - 9000) / 38000)));
            f.vs += Math.max(-0.04, Math.min(0.04, tv - f.vs));
            const rate = f.climb < 2500 ? 0 : rem < 70000 ? 0.012 : 0.02;
            if (dLoc < 60000) {
                f.a = flTurn(f.a, Math.atan2(dyI, dxI), rate);
                f.v = f.vs * wSec(f.y); move();
                f.q = wVec(f.x, f.y); f.h = wTan(f.q, f.a);
            } else {
                const q = f.q, T = L.T, qt = wDot(q, T);
                let d = [T[0] - q[0] * qt, T[1] - q[1] * qt, T[2] - q[2] * qt];
                d = Math.hypot(d[0], d[1], d[2]) < 1e-7 ? wEN(q).n : wNorm(d);                     // dead antipode: any way works, go north
                const s = Math.atan2(wDot(q, wCross(f.h, d)), wDot(f.h, d)), tr = Math.max(-rate, Math.min(rate, s));
                const qh = wCross(q, f.h), ct = Math.cos(tr), st = Math.sin(tr);
                const h = [f.h[0] * ct + qh[0] * st, f.h[1] * ct + qh[1] * st, f.h[2] * ct + qh[2] * st];
                const th = f.vs / W_R, c = Math.cos(th), sn = Math.sin(th);                         // along our own great circle
                const nq = wNorm([q[0] * c + h[0] * sn, q[1] * c + h[1] * sn, q[2] * c + h[2] * sn]);
                let nh = [h[0] * c - q[0] * sn, h[1] * c - q[1] * sn, h[2] * c - q[2] * sn]; const r = wDot(nh, nq);
                nh = wNorm([nh[0] - nq[0] * r, nh[1] - nq[1] * r, nh[2] - nq[2] * r]);
                f.q = nq; f.h = nh;
                const p = wChart(nq), ox = f.x; f.x = p.x; f.y = p.y; f.a = wAng(nq, nh); f.v = f.vs * Math.min(8, wSec(f.y));
                if (Math.abs(p.x - ox) > W_CIRC * 0.75) { f.wraps++; f.wrapEast = p.x < ox; ev = 'wrap'; }
            }
            const az = Math.abs(f.q[2]);
            if (az > 0.9903 && az < f.pz && !f.polar) { f.polar = true; f.poles++; f.poleKm = Math.round((Math.PI / 2 - Math.asin(f.pz)) * W_R / 1000); ev = 'pole'; }   // just passed closest to a pole (within 8°)
            if (az < 0.985) f.polar = false;
            f.pz = az;
            if (dLoc < 2600 || (dLoc < 9000 && dLoc > f.prevDI)) { f.ph = 'final'; f.q = f.h = null; f.v = f.vs * wSec(f.y); }
            f.prevDI = dLoc;
            break;
        }
        case 'final': {
            const s = wrapDx(f.x - L.tx) * L.dir, cross = f.y - L.ty;
            if (s < -FL_FINAL * 1.6 || Math.abs(cross) > 12000) { f.ph = 'air'; f.prevDI = Infinity; break; }   // too wide: fly the approach again
            const tgx = L.tx + L.dir * (s + 2600);
            f.a = flTurn(f.a, Math.atan2(L.ty - f.y, wrapDx(tgx - f.x)), 0.018);
            if (s > -7000) { f.y += (L.ty - f.y) * 0.05; f.a = flTurn(f.a, L.dir > 0 ? 0 : Math.PI, 0.01); }
            f.alt = Math.min(f.alt, Math.max(0, -s / FL_DESC));
            f.v += Math.max(-0.05, Math.min(0.05, FL_VR - f.v));
            move();
            if (wrapDx(f.x - L.tx) * L.dir >= 0) { f.ph = 'rollout'; f.alt = 0; f.y = L.ty; f.a = L.dir > 0 ? 0 : Math.PI; }
            break;
        }
        case 'rollout':
            f.v = Math.max(FL_TAXI, f.v - 0.15); f.a = L.dir > 0 ? 0 : Math.PI; f.y = L.ty; move();
            if ((f.x - L.exitX) * L.dir >= 0) { f.x = L.exitX; f.ph = 'taxiin'; f.wp = [[L.exitX, L.taxiY], [L.cb, L.taxiY], [L.sb.x, L.sb.y]]; }
            break;
        case 'park':
            f.v = 0; f.a = flTurn(f.a, 0, 0.04);
            if (Math.abs(f.a) < 0.002) { f.a = 0; f.ph = 'done'; ev = 'done'; }
            break;
    }
    return ev;
}
// Chunks are encoded once (binary, as a complete world_chunk message) and the same bytes are sent to every client.
function layoutChunkBin(L, cx, cy) {
    const key = cx + cy * W_NCH; L.chunkBin = L.chunkBin || new Map();
    let b = L.chunkBin.get(key); if (b) return b;
    b = DTB.encode({ type: 'world_chunk', c: JSON.parse(layoutChunkJson(L, cx, cy)) }); L.chunkJson.delete(key);
    L.chunkBin.set(key, b); return b;
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
worldRoom.grid.wrap = W_CIRC;

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
// ---- interactive interiors ----------------------------------------------------------------------------------------------
// Furniture with a `use` gets a station in front of it. Toggles (TV, lamps, fireplace, radio, the lights) are shared by
// everyone in the room (room.fstate, broadcast as world_furn); the rest give you something (snack, shower, banking…).
function intUse(D, f, use, sx, sy, r = 80) { f.use = use; f.ui = D.furn.indexOf(f); D.stations.push({ id: 'u' + f.ui, use, fi: f.ui, x: Math.round(sx), y: Math.round(sy), r }); return f; }
function intAdd(D, f) { D.furn.push(f); return f; }
const INT_TOGGLES = { tv: ['TV', 'Turn on', 'Turn off'], lamp: ['Lamp', 'Switch on', 'Switch off'], fire: ['Fireplace', 'Light the fire', 'Put it out'], radio: ['Radio', 'Play music', 'Stop the music'], lights: ['Light switch', 'Lights on', 'Lights off'] };
function furnishHouse(D, tier) {
    const fl = D.floor, X0 = fl.x, Y0 = fl.y, W = fl.w, H = fl.h, f = D.furn;
    const tv = f.find(q => q.k === 'tv'); if (tv) intUse(D, tv, 'tv', tv.x + tv.w / 2, tv.y + tv.h + 70);
    const sofa = f.find(q => q.k === 'sofa');
    if (sofa) intUse(D, intAdd(D, { k: 'lamp', x: sofa.x - 34, y: sofa.y + 20, r: 14, solid: 1 }), 'lamp', sofa.x - 34, sofa.y + 70, 70);
    const dining = f.find(q => q.k === 'dining');
    if (dining) intUse(D, intAdd(D, { k: 'radio', x: dining.x + dining.w / 2 - 20, y: dining.y + 10, w: 40, h: 22 }), 'radio', dining.x + dining.w / 2, dining.y + dining.h + 50, 70);
    const counter = f.find(q => q.k === 'counter');
    if (counter) {
        intUse(D, intAdd(D, { k: 'fridge', x: counter.x + counter.w - 70, y: counter.y + counter.h + 6, w: 64, h: 56, solid: 1 }), 'fridge', counter.x + counter.w - 38, counter.y + counter.h + 110, 75);
        intUse(D, intAdd(D, { k: 'coffee', x: counter.x + 14, y: counter.y + 10, w: 30, h: 28 }), 'coffee', counter.x + 30, counter.y + counter.h + 50, 70);
    }
    if (tier >= 1) intUse(D, intAdd(D, { k: 'fireplace', x: X0 + 6, y: Y0 + 150, w: 34, h: 120, solid: 1 }), 'fire', X0 + 90, Y0 + 210, 80);
    if (tier >= 2) intAdd(D, { k: 'aquarium', x: X0 + 24, y: Y0 + H - 330, w: 150, h: 46, solid: 1 });
    const bath = f.find(q => q.k === 'bath');
    if (bath) intUse(D, bath, 'bath', bath.x + bath.w / 2, bath.y + bath.h + 50, 80);
    else intUse(D, intAdd(D, { k: 'shower', x: X0 + W - 110, y: Y0 + Math.round(H * 0.42) + 30, w: 90, h: 90, solid: 1 }), 'bath', X0 + W - 170, Y0 + Math.round(H * 0.42) + 75, 70);
    const desk = f.find(q => q.k === 'desk');
    if (desk) { intAdd(D, { k: 'laptop', x: desk.x + desk.w / 2 - 18, y: desk.y + 8, w: 36, h: 24 }); intUse(D, desk, 'pc', desk.x + desk.w / 2, desk.y + desk.h + 60, 75); }
    intUse(D, intAdd(D, { k: 'switch', x: D.door.px + 76, y: fl.y + fl.h - 10, w: 16, h: 10 }), 'lights', D.door.px + 84, fl.y + fl.h - 60, 55);
}
// Bottom strip of each mall level: elevator, directory, ATM and vending everywhere, then things that fit the floor's theme.
function furnishMall(D, b) {
    const fl = D.floor, X0 = fl.x, Y0 = fl.y, W = fl.w, H = fl.h, doorX = D.door.px, ft = D.theme.ft;
    if (ft === 'casino') return;
    intUse(D, intAdd(D, { k: 'elevator', x: X0 + 20, y: Y0 + 880, w: 140, h: 140, solid: 1 }), 'elevator', X0 + 210, Y0 + 950, 80);
    intUse(D, intAdd(D, { k: 'directory', x: doorX - 190, y: Y0 + H - 290, w: 56, h: 64, solid: 1 }), 'directory', doorX - 162, Y0 + H - 190, 70);
    intUse(D, intAdd(D, { k: 'vending', x: X0 + W - 330, y: Y0 + H - 70, w: 64, h: 56, solid: 1 }), 'vending', X0 + W - 298, Y0 + H - 120, 50);
    intUse(D, intAdd(D, { k: 'atmi', x: X0 + W - 410, y: Y0 + H - 64, w: 50, h: 50, solid: 1 }), 'atm', X0 + W - 385, Y0 + H - 115, 50);
    const fountain = () => intUse(D, intAdd(D, { k: 'fountain', x: doorX + 300, y: Y0 + H - 250, r: 62, solid: 1 }), 'fountain', doorX + 300, Y0 + H - 150, 70);
    const photo = () => intUse(D, intAdd(D, { k: 'photobooth', x: X0 + W - 170, y: Y0 + H - 170, w: 140, h: 130, solid: 1 }), 'photo', X0 + W - 230, Y0 + H - 105, 70);
    const cart = (i, shop) => { const x = X0 + 250 + i * 130, c = intAdd(D, { k: 'cart', x, y: Y0 + H - 190, w: 100, h: 48, solid: 1, shop, label: SHOP_KINDS[shop].name, ic: SHOP_KINDS[shop].ic, col: i + 2 }); D.stations.push({ id: 'cart' + i, shop, x: x + 50, y: Y0 + H - 90, r: 70 }); return c; };
    switch (ft) {
        case 'market': fountain(); cart(0, 'florist'); cart(1, 'candy'); intAdd(D, { k: 'floorart', x: doorX - 150, y: Y0 + 225, w: 300, h: 110, v: 0 }); break;
        case 'fashion':
            photo(); for (let i = 0; i < 3; i++) intAdd(D, { k: 'mannequin', x: X0 + 280 + i * 80, y: Y0 + H - 150, r: 18, solid: 1, col: i + (D.lv || 0) });
            intAdd(D, { k: 'runway', x: doorX - 300, y: Y0 + 240, w: 600, h: 90 }); break;
        case 'tech':
            for (let i = 0; i < 6; i++) intUse(D, intAdd(D, { k: 'arcade', x: X0 + 240 + i * 76, y: Y0 + H - 70, w: 60, h: 56, solid: 1, col: i }), 'arcade', X0 + 270 + i * 76, Y0 + H - 120, 45);
            intAdd(D, { k: 'ledwall', x: doorX + 30, y: Y0 + H - 34, w: 220, h: 28, solid: 1 });
            intUse(D, intAdd(D, { k: 'vrbooth', x: X0 + W - 160, y: Y0 + H - 220, w: 120, h: 110, solid: 1 }), 'vr', X0 + W - 210, Y0 + H - 140, 60);
            intAdd(D, { k: 'neonfloor', x: doorX - 300, y: Y0 + 240, w: 600, h: 90 }); break;
        case 'life':
            fountain(); intUse(D, intAdd(D, { k: 'petpen', x: X0 + 260, y: Y0 + H - 200, w: 200, h: 110, solid: 1 }), 'petpen', X0 + 360, Y0 + H - 245, 70);
            intAdd(D, { k: 'shelf', x: X0 + W - 290, y: Y0 + H - 220, w: 200, h: 30, solid: 1 });
            intAdd(D, { k: 'rugbig', x: doorX - 250, y: Y0 + 240, w: 500, h: 90 }); break;
        case 'gifts':
            photo(); fountain(); intAdd(D, { k: 'statue', x: X0 + 360, y: Y0 + H - 140, r: 34, solid: 1 });
            intAdd(D, { k: 'floorart', x: doorX - 150, y: Y0 + 225, w: 300, h: 110, v: 1 }); break;
        case 'food':
            for (const tx of [280, 400, 660, 780, 900]) for (const ty of [H - 180, H - 75]) {
                const x = X0 + tx, y = Y0 + ty; intAdd(D, { k: 'foodtable', x, y, r: 26, solid: 1, col: (tx + ty) % 5 });
                for (let q = 0; q < 4; q++) intAdd(D, { k: 'stool', x: x + Math.cos(q * Math.PI / 2 + 0.6) * 40, y: y + Math.sin(q * Math.PI / 2 + 0.6) * 40, r: 9 });
            }
            break;
    }
}
// Airport terminal: check-in hall (buy a boarding pass), security, departure lounge with shops, and the gate.
function buildTerminalInterior(ap) {
    const X0 = 150, Y0 = 300, W = 1500, H = 1200, fl = { x: X0, y: Y0, w: W, h: H }, doorX = X0 + W / 2, secY = Y0 + 520, T = 22;
    const city = W_CITIES.find(c => c.id === ap.city);
    const D = {
        kind: 'terminal', ext: INT_EXT, floor: fl, theme: { accent: '#1d4f7a', name: `${ap.name} (${ap.code})`, code: ap.code, city: ap.city },
        walls: intWallsAround(fl, doorX, 180), furn: [], stations: [], rooms: [{ x: X0, y: secY, w: W, h: H - (secY - Y0), c: 'hall' }, { x: X0, y: Y0, w: W, h: secY - Y0, c: 'lounge' }],
        door: { x: doorX - 90, y: Y0 + H, w: 180, h: INT_WALL, px: doorX, py: Y0 + H - 36, r: 120 },
        spawn: { x: doorX, y: Y0 + H - 110 }, ap: ap.city
    };
    // security line: a wall with two scanner lanes
    const lanes = [doorX - 260, doorX + 260];
    D.walls.push({ x: X0, y: secY, w: lanes[0] - 70 - X0, h: T }, { x: lanes[0] + 70, y: secY, w: lanes[1] - 70 - (lanes[0] + 70), h: T }, { x: lanes[1] + 70, y: secY, w: X0 + W - (lanes[1] + 70), h: T });
    for (const lx of lanes) { intAdd(D, { k: 'arch', x: lx - 60, y: secY - 14, w: 120, h: 50 }); intAdd(D, { k: 'scanner', x: lx + 74, y: secY + 30, w: 46, h: 170, solid: 1 }); }
    // check-in desks (each sells boarding passes)
    const cols = ['#1d6fa5', '#c0392b', '#2c7a5b', '#7a3f8f'];
    for (let i = 0; i < 4; i++) {
        const x = X0 + 130 + i * 330, y = Y0 + H - 420;
        intUse(D, intAdd(D, { k: 'checkin', x, y, w: 220, h: 54, solid: 1, col: cols[i], n: i + 1 }), 'tickets', x + 110, y + 120, 95);
        for (let q = 0; q < 4; q++) intAdd(D, { k: 'post', x: x + 20 + q * 60, y: y + 190, r: 6, solid: 1 });
    }
    intUse(D, intAdd(D, { k: 'board', x: doorX - 150, y: secY + 40, w: 300, h: 46, solid: 1 }), 'board', doorX, secY + 150, 110);   // between the two security lanes
    for (const [x, y] of [[X0 + 50, Y0 + H - 60], [X0 + W - 50, Y0 + H - 60], [X0 + 50, secY + 70], [X0 + W - 50, secY + 70]]) intAdd(D, { k: 'plant', x, y, r: 22, solid: 1 });
    // departure lounge: seats, café, duty free, panoramic window onto the apron, gate desk
    intAdd(D, { k: 'window', x: X0 + 40, y: Y0 + 6, w: W - 80, h: 26, solid: 1 });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) intAdd(D, { k: 'seats', x: X0 + 140 + c * 330, y: Y0 + 230 + r * 130, w: 230, h: 40, solid: 1 });
    intUse(D, intAdd(D, { k: 'kiosk', x: X0 + 20, y: Y0 + 80, w: 200, h: 110, solid: 1, shop: 'cafe', label: 'Café', col: 3 }), 'shop:cafe', X0 + 120, Y0 + 230, 80);
    intUse(D, intAdd(D, { k: 'kiosk', x: X0 + W - 220, y: Y0 + 80, w: 200, h: 110, solid: 1, shop: 'souvenir', label: 'Duty Free', col: 4 }), 'shop:souvenir', X0 + W - 120, Y0 + 230, 80);
    intUse(D, intAdd(D, { k: 'gatedesk', x: doorX - 110, y: Y0 + 60, w: 220, h: 50, solid: 1 }), 'gate', doorX, Y0 + 170, 100);
    intAdd(D, { k: 'jetway', x: doorX - 60, y: Y0 - 22, w: 120, h: 30 });
    return D;
}
function worldFurnPush(room) { for (const c of room.clients) sendWorld(c, 'world_furn', { key: room.scene, s: room.fstate || {} }); }
function worldUsePrompt(client, def, s) {
    const w = client.world, p = client.player, room = client.room, st = room.fstate || {}, f = def.furn[s.fi], d = Math.hypot(s.x - p.x, s.y - p.y);
    const cash = Math.floor(w.sessionCoins || 0), bank = w.bankCoins || 0, base = { id: s.id, kind: 'use', ctx: s, ax: s.x, ay: s.y - 80 };
    const T = INT_TOGGLES[s.use];
    if (T) { const on = s.use === 'lights' ? !st.off : !!st[s.fi]; return [d, { ...base, title: T[0], lines: [s.use === 'lights' ? (on ? 'The lights are on' : 'The lights are off') : on ? 'On' : 'Off'], actions: [{ a: 'toggle', label: on ? T[2] : T[1], on: true }], mini: true }]; }
    switch (s.use) {
        case 'fridge': return [d, { ...base, title: 'Fridge', lines: ['Grab a snack: +30% health'], actions: [{ a: 'go', label: 'Have a snack', on: true }], mini: true }];
        case 'coffee': return [d, { ...base, title: 'Coffee machine', lines: ['+25% speed for 30 s'], actions: [{ a: 'go', label: 'Make a coffee', on: true }], mini: true }];
        case 'bath': return [d, { ...base, title: f.k === 'bath' ? 'Bath' : 'Shower', lines: ['Freshen up: +20% health, +25% speed for 45 s'], actions: [{ a: 'go', label: f.k === 'bath' ? 'Take a bath' : 'Take a shower', on: true }], mini: true }];
        case 'pc': case 'atm': return [d, { ...base, title: s.use === 'pc' ? 'Laptop · online banking' : 'ATM', lines: [`Unbanked cash: ${fmtMoney(cash)}`, `Account balance: ${fmtMoney(bank)}`], actions: [{ a: 'deposit', label: cash > 0 ? `Deposit ${fmtMoney(cash)}` : 'Nothing to deposit', on: cash > 0 }], mini: true }];
        case 'arcade': return [d, { ...base, title: ['Neon Racer', 'Tank Blaster', 'Pixel Claw'][f.col % 3] + ' arcade', lines: ['5 coins a game · win up to 120'], actions: [{ a: 'go', label: 'Play (5)', on: cash + bank >= 5 }], mini: true }];
        case 'photo': return [d, { ...base, title: 'Photo booth', lines: ['A strip of 4 photos: +150 score'], actions: [{ a: 'go', label: 'Take photos (8)', on: cash + bank >= 8 }], mini: true }];
        case 'fountain': return [d, { ...base, title: 'Wishing fountain', lines: ['Toss a coin for luck'], actions: [{ a: 'go', label: 'Toss a coin (1)', on: cash + bank >= 1 }], mini: true }];
        case 'vending': { const b = WL.buildingById.get(def.bid), city = b && W_CITIES.find(c => c.id === b.city); return [d, { ...base, title: 'Vending machine', lines: [def.theme.name], actions: worldShopActions(client, ['drink', 'lemonade'], city), mini: true }]; }
        case 'directory': {
            const b = WL.buildingById.get(def.bid), lines = [];
            for (let lv = 1; lv <= def.levels; lv++) { const L2 = worldInteriorDef('mall:' + def.bid + ':' + lv); lines.push(L2.casino ? `Level ${lv} · 🎰 Casino: roulette, blackjack, slots, cocktail bar` : `Level ${lv} · ${MALL_FLOORS[L2.theme.ft].name}: ` + [...new Set(L2.stations.filter(q => q.shop).map(q => SHOP_KINDS[q.shop].ic + ' ' + SHOP_KINDS[q.shop].name))].join(', ')); }
            return [d, { ...base, title: (b && b.nm || 'Mall') + ' directory', lines, actions: [] }];
        }
        case 'roulette': return [d, { ...base, title: `🎡 Roulette · table ${f.n}`, lines: ['Bet on a number, red or black, odd/even, highs, lows, dozens or columns', 'A single number pays 35 to 1', `Cash ${fmtMoney(cash)} · bank ${fmtMoney(bank)}`], actions: [{ a: 'play', label: '🎡 Take a seat', on: cash + bank > 0 }] }];
        case 'blackjack': return [d, { ...base, title: `🃏 Blackjack · table ${f.n}`, lines: ['Beat the dealer without going over 21', 'Blackjack pays 3 to 2 · dealer stands on all 17s', `Cash ${fmtMoney(cash)} · bank ${fmtMoney(bank)}`], actions: [{ a: 'play', label: '🃏 Take a seat', on: cash + bank > 0 }] }];
        case 'slots': return [d, { ...base, title: `🎰 ${f.nm}`, lines: ['Three reels, one payline · 💎💎💎 pays 400×', `Cash ${fmtMoney(cash)} · bank ${fmtMoney(bank)}`], actions: [{ a: 'play', label: '🎰 Play', on: cash + bank > 0 }], mini: true }];
        case 'vr': return [d, { ...base, title: 'VR Arena', lines: ['Five minutes in a virtual dogfight: +400 score, +25% speed for 60 s'], actions: [{ a: 'go', label: 'Put on the headset (15)', on: cash + bank >= 15 }], mini: true }];
        case 'petpen': return [d, { ...base, title: 'Puppy pen', lines: ['Cuddle the puppies: +20% health'], actions: [{ a: 'go', label: 'Pet the puppies', on: true }], mini: true }];
        case 'elevator': return [d, { ...base, title: 'Glass elevator', lines: [`You are on level ${def.lv}`], actions: Array.from({ length: def.levels }, (_, i) => ({ a: 'lv' + (i + 1), label: i + 1 === def.lv ? `Level ${i + 1} (here)` : `Level ${i + 1}`, on: i + 1 !== def.lv })) }];
        case 'board': {
            const A = WL.airportByCity.get(def.ap), lines = [...airItins(A)].slice(0, 7).map(([dest, list]) => { const o = list[0], B = WL.airportByCity.get(dest); return `${o.legs[0].fn.padEnd(6)} ${B.code} ${W_CITIES.find(c => c.id === dest).name.padEnd(18)} ${o.stops ? o.stops + ' stop' : 'nonstop'} · ~${o.mins} min · ${fmtMoney(o.fare)}`; });
            return [d, { ...base, title: '✈ Departures', lines: [...lines, 'Buy a boarding pass at any check-in desk'], actions: [] }];
        }
        case 'tickets': {
            const A = WL.airportByCity.get(def.ap), l = worldTicketLeg(w, A), it = w.itin;
            return [d, { ...base, kind: 'tickets', title: `✈ ${A.code} check-in · all airlines · desk ${f.n}`, cards: true, pick: true,
                lines: [l ? `Your ticket: ${AIRLINES[l.al].name} ${l.fn} ${A.code} → ${WL.airportByCity.get(l.to).code}${it.legs.length > 1 ? ` (then ${it.legs.slice(it.i + 1).map(q => q.fn).join(', ')})` : ''}. Go through security to the gate.` : 'Choose a flight. Direct, or change planes at a hub on one ticket. Pay with cash or from the bank.'],
                actions: airItinActions(client, A) }];
        }
        case 'gate': {
            const A = WL.airportByCity.get(def.ap), l = worldTicketLeg(w, A), B = l && WL.airportByCity.get(l.to), cB = B && W_CITIES.find(c => c.id === B.city);
            return [d, { ...base, title: `Gate 2 · ${A.code}`, lines: l ? [`${AIRLINES[l.al].name} ${l.fn} · ${A.code} → ${B.code} ${cB.name}`, `${AIRCRAFT[l.ac].name} · ${w.itin.cls === 'J' ? 'Business' : 'Economy'} · boarding now`] : ['No boarding pass – buy one at check-in or on your phone'], actions: l ? [{ a: 'board', label: `Board ${l.fn} to ${cB.name}`, on: true }] : [] }];
        }
    }
    if (s.use.startsWith('shop:')) {
        const kind = s.use.slice(5), A = def.ap && WL.airportByCity.get(def.ap), city = W_CITIES.find(c => c.id === def.ap) || null;
        return [d, { ...base, kind: 'shop', ctx: { city, items: SHOP_KINDS[kind].items }, title: (kind === 'souvenir' ? 'Duty Free' : SHOP_KINDS[kind].name) + (A ? ' · ' + A.code : ''), lines: ['Airport prices'], actions: worldShopActions(client, SHOP_KINDS[kind].items, city), pick: true }];
    }
    return null;
}
// ---- casino: server-authoritative roulette, blackjack and slots ------------------------------------------------------
// Bets come out of cash first, then the bank (like any purchase). Winnings are paid into the bank, so they can't be lost on death.
const CASINO_MAX_BET = 100000;
const ROUL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const SLOT_W = [28, 24, 18, 14, 9, 5, 2], SLOT_3 = [6, 8, 15, 20, 40, 100, 400];     // cherry lemon bell melon star seven diamond; RTP about 95%
function casinoSlotSym() { let r = crypto.randomInt(100); for (let i = 0; i < SLOT_W.length; i++) { if (r < SLOT_W[i]) return i; r -= SLOT_W[i]; } return 0; }
function casinoSlotPay(l) {
    if (l[0] === l[1] && l[1] === l[2]) return SLOT_3[l[0]];
    const two = i => l.filter(x => x === i).length === 2;
    return two(6) ? 25 : two(5) ? 10 : two(0) ? 2 : two(2) ? 1 : 0;
}
function casinoRoulMul(t, k, n) {
    switch (t) {
        case 'num': return k === n ? 36 : 0;
        case 'red': return n && ROUL_RED.has(n) ? 2 : 0;
        case 'black': return n && !ROUL_RED.has(n) ? 2 : 0;
        case 'odd': return n && n % 2 ? 2 : 0;
        case 'even': return n && n % 2 === 0 ? 2 : 0;
        case 'low': return n >= 1 && n <= 18 ? 2 : 0;
        case 'high': return n >= 19 ? 2 : 0;
        case 'dozen': return n && Math.ceil(n / 12) === k ? 3 : 0;
        case 'col': return n && ((n - 1) % 3) + 1 === k ? 3 : 0;
    }
    return 0;
}
function bjVal(cards) { let t = 0, a = 0; for (const c of cards) { const r = c % 13; t += r === 0 ? 11 : r >= 9 ? 10 : r + 1; if (!r) a++; } while (t > 21 && a) { t -= 10; a--; } return { t, soft: a > 0 }; }
function bjDraw(w) {
    if (!w.bjShoe || w.bjShoe.length < 60) { const s = []; for (let d = 0; d < 6; d++) for (let c = 0; c < 52; c++) s.push(c); for (let i = s.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [s[i], s[j]] = [s[j], s[i]]; } w.bjShoe = s; }
    return w.bjShoe.pop();
}
function casinoStation(client, g, tid) {
    const def = client.room && client.room.def, p = client.player; if (!def || !def.casino || !p) return null;
    const s = def.stations.find(q => q.id === tid && q.use === g); if (!s) return null;
    return Math.hypot(s.x - p.x, s.y - p.y) < s.r + 90 ? s : null;
}
function casinoBalance(client) { const w = client.world; w.bankCoins = worldBankCoins(client); return { cash: Math.floor(w.sessionCoins || 0), bank: w.bankCoins }; }
function casinoPayout(client, amt) {
    if (amt <= 0) return; db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(Math.round(amt), client.dbId);
    client.world.bankCoins = worldBankCoins(client); worldPushProfile(client); worldPushState(client);
}
function casinoFx(client, s, g, extra) {
    const room = client.room; if (!room) return;
    for (const c of room.clients) sendWorld(c, 'world_casino_fx', { key: room.scene, fi: s.fi, g, name: client.player ? client.player.name : '', ...extra });
}
function casinoOpen(client, s) {
    const room = client.room, f = room.def.furn[s.fi]; room.casinoHist = room.casinoHist || {};
    if (s.use === 'blackjack' && client.world.bj && !client.world.bj.done) { client.world.bj = null; }   // walking away forfeits a hand in play
    sendWorld(client, 'casino_open', { g: s.use, tid: s.id, name: s.use === 'slots' ? f.nm : (s.use === 'roulette' ? 'Roulette' : 'Blackjack') + ' · table ' + f.n, max: CASINO_MAX_BET, hist: room.casinoHist[s.id] || [], ...casinoBalance(client) });
}
function worldCasino(client, d) {
    const w = client.world, g = String(d.g || ''), s = casinoStation(client, g, String(d.tid || '')), now = Date.now();
    if (!s) { sendWorld(client, 'casino_res', { g, err: 'Walk back to the table to keep playing.' }); return; }
    w.casinoT = w.casinoT || {};
    const gap = { roulette: 2500, slots: 700, blackjack: 200 }[g] || 500;
    if (now - (w.casinoT[g] || 0) < gap) return; w.casinoT[g] = now;
    const room = client.room; room.casinoHist = room.casinoHist || {};
    const takeBet = amt => { if (!(amt >= 1) || amt > CASINO_MAX_BET) { sendWorld(client, 'casino_res', { g, err: `Bets are 1 to ${fmtMoney(CASINO_MAX_BET)} coins.` }); return false; } if (!worldPayToll(client, amt)) { sendWorld(client, 'casino_res', { g, err: "You don't have that much.", ...casinoBalance(client) }); return false; } return true; };
    if (g === 'roulette') {
        const OK = { num: [0, 36], red: 0, black: 0, odd: 0, even: 0, low: 0, high: 0, dozen: [1, 3], col: [1, 3] };
        const bets = (Array.isArray(d.bets) ? d.bets : []).slice(0, 60).map(b => ({ t: String(b.t), k: b.k | 0, amt: Math.floor(+b.amt || 0) })).filter(b => b.t in OK && b.amt >= 1 && (!Array.isArray(OK[b.t]) || (b.k >= OK[b.t][0] && b.k <= OK[b.t][1])));
        const total = bets.reduce((a, b) => a + b.amt, 0); if (!bets.length) return;
        if (!takeBet(total)) return;
        const n = crypto.randomInt(37); let win = 0; const res = bets.map(b => { const m = casinoRoulMul(b.t, b.k, n); win += b.amt * m; return m; });
        casinoPayout(client, win);
        const h = room.casinoHist[s.id] = [n, ...(room.casinoHist[s.id] || [])].slice(0, 14);
        sendWorld(client, 'casino_res', { g, n, res, win, total, hist: h, ...casinoBalance(client) });
        casinoFx(client, s, g, { n, win, big: win >= Math.max(500, total * 8) ? 1 : 0 });
        w.prog && client.player && client.player.addXP(Math.min(500, 5 + Math.floor(total / 20)));
    } else if (g === 'slots') {
        const bet = Math.floor(+d.bet || 0); if (!takeBet(bet)) return;
        const l = [casinoSlotSym(), casinoSlotSym(), casinoSlotSym()], mul = casinoSlotPay(l), win = bet * mul;
        casinoPayout(client, win);
        sendWorld(client, 'casino_res', { g, l, mul, win, bet, ...casinoBalance(client) });
        casinoFx(client, s, g, { l, win, big: mul >= 40 ? 1 : 0 });
        client.player && client.player.addXP(Math.min(300, 2 + Math.floor(bet / 25)));
    } else if (g === 'blackjack') {
        const act = String(d.act || ''); let bj = w.bj;
        const view = () => { const pv = bjVal(bj.p), dv = bjVal(bj.d); return { g, act, p: bj.p, d: bj.done ? bj.d : [bj.d[0], -1], pt: pv.t, psoft: pv.soft, dt: bj.done ? dv.t : bjVal([bj.d[0]]).t, done: bj.done ? 1 : 0, res: bj.res || '', bet: bj.bet, win: bj.win || 0, canDouble: !bj.done && bj.p.length === 2 ? 1 : 0, ...casinoBalance(client) }; };
        const finish = () => {
            const pv = bjVal(bj.p).t; let dv = bjVal(bj.d).t;
            if (pv > 21) bj.res = 'bust';
            else { while (dv < 17) { bj.d.push(bjDraw(w)); dv = bjVal(bj.d).t; } bj.res = dv > 21 ? 'dbust' : pv > dv ? 'win' : pv < dv ? 'lose' : 'push'; }
            bj.win = bj.res === 'win' || bj.res === 'dbust' ? bj.bet * 2 : bj.res === 'push' ? bj.bet : 0; bj.done = true;
            casinoPayout(client, bj.win);
            casinoFx(client, s, g, { win: bj.win, res: bj.res, big: bj.win >= Math.max(1000, bj.bet * 2) && bj.bet >= 500 ? 1 : 0 });
        };
        if (act === 'deal') {
            if (bj && !bj.done) return;
            const bet = Math.floor(+d.bet || 0); if (!takeBet(bet)) return;
            bj = w.bj = { bet, p: [bjDraw(w)], d: [bjDraw(w)], done: false, tid: s.id }; bj.p.push(bjDraw(w)); bj.d.push(bjDraw(w));
            const pb = bjVal(bj.p).t === 21, db = bjVal(bj.d).t === 21;
            if (pb || db) { bj.done = true; bj.res = pb && db ? 'push' : pb ? 'bj' : 'dbj'; bj.win = bj.res === 'push' ? bet : bj.res === 'bj' ? Math.floor(bet * 2.5) : 0; casinoPayout(client, bj.win); casinoFx(client, s, g, { win: bj.win, res: bj.res, big: bj.res === 'bj' && bet >= 200 ? 1 : 0 }); }
            client.player && client.player.addXP(Math.min(300, 3 + Math.floor(bet / 25)));
        } else {
            if (!bj || bj.done || bj.tid !== s.id) return;
            if (act === 'hit') { bj.p.push(bjDraw(w)); const t = bjVal(bj.p).t; if (t >= 21) finish(); }
            else if (act === 'stand') finish();
            else if (act === 'double') { if (bj.p.length !== 2) return; if (!takeBet(bj.bet)) return; bj.bet *= 2; bj.p.push(bjDraw(w)); finish(); }
            else return;
        }
        sendWorld(client, 'casino_res', view());
    }
}
function worldTicketValid(w, A) { return !!worldTicketLeg(w, A); }
function worldUse(client, s, a, extra) {
    const w = client.world, p = client.player, room = client.room, def = room.def, now = Date.now(), max = p.getEffectiveMaxHp();
    w.useCd = w.useCd || {};
    const cd = (k, ms) => { if (now - (w.useCd[k] || 0) < ms) { worldNotice(client, `Not yet – try again in ${Math.ceil((ms - (now - w.useCd[k])) / 1000)} s.`); return false; } w.useCd[k] = now; return true; };
    if (INT_TOGGLES[s.use]) {
        room.fstate = room.fstate || {};
        if (s.use === 'lights') room.fstate.off = room.fstate.off ? 0 : 1; else room.fstate[s.fi] = room.fstate[s.fi] ? 0 : 1;
        worldFurnPush(room); return;
    }
    switch (s.use) {
        case 'fridge': if (cd('fridge', 45000)) { p.hp = Math.min(max, p.hp + max * 0.3); worldNotice(client, '🥪 You grab a snack from the fridge: +30% health.', { level: 'good' }); } break;
        case 'coffee': if (cd('coffee', 60000)) { p.worldSpeedUntil = Math.max(now, p.worldSpeedUntil || 0) + 30000; worldNotice(client, '☕ Fresh coffee: +25% speed for 30 s.', { level: 'good' }); } break;
        case 'bath': if (cd('bath', 90000)) { p.hp = Math.min(max, p.hp + max * 0.2); p.worldSpeedUntil = Math.max(now, p.worldSpeedUntil || 0) + 45000; worldNotice(client, '🚿 Refreshed: +20% health, +25% speed for 45 s.', { level: 'good' }); } break;
        case 'pc': case 'atm': worldDeposit(client); break;
        case 'arcade': {
            if (!worldPayToll(client, 5)) return;
            const r = Math.random(), win = r < 0.05 ? 120 : r < 0.2 ? 25 + Math.floor(Math.random() * 16) : r < 0.5 ? 5 + Math.floor(Math.random() * 11) : 0;
            p.addXP(30); if (win) { w.sessionCoins += win; worldNotice(client, win >= 120 ? `🎰 JACKPOT! +${win} coins!` : `🕹 You win ${win} coins!`, { level: 'good', sessionCoins: w.sessionCoins }); } else worldNotice(client, '🕹 GAME OVER. Insert coin to continue…');
            worldPushState(client); break;
        }
        case 'photo': if (worldPayToll(client, 8)) { p.addXP(150); worldNotice(client, '📸 Flash! Flash! Flash! Flash! A photo strip to remember: +150 score.', { level: 'good' }); } break;
        case 'fountain': if (worldPayToll(client, 1)) { p.worldSpeedUntil = Math.max(now, p.worldSpeedUntil || 0) + 30000; worldNotice(client, ['🪙 Plop. You feel lucky: +25% speed for 30 s.', '🪙 Your wish is safe with the fountain (+25% speed for 30 s).'][Math.floor(Math.random() * 2)], { level: 'good' }); } break;
        case 'vending': if (a.startsWith('buy:')) { const b = WL.buildingById.get(def.bid); worldBuyItem(client, a.slice(4), b && W_CITIES.find(c => c.id === b.city)); } break;
        case 'elevator': { const lv = Number(a.slice(2)); if (lv >= 1 && lv <= def.levels && lv !== def.lv) { const key = 'mall:' + def.bid + ':' + lv, nd = worldInteriorDef(key), st = nd.stations.find(q => q.use === 'elevator'); worldGoto(client, key, st.x, st.y); } break; }
        case 'tickets': if (a.startsWith('tix:')) worldBuyItin(client, WL.airportByCity.get(def.ap), a.slice(4), extra && extra.cls === 'J' ? 'J' : 'Y'); break;
        case 'roulette': case 'blackjack': case 'slots': casinoOpen(client, s); break;
        case 'vr': if (cd('vr', 20000) && worldPayToll(client, 15)) { p.addXP(400); p.worldSpeedUntil = Math.max(now, p.worldSpeedUntil || 0) + 60000; worldNotice(client, '🥽 You shot down five drones in VR: +400 score, +25% speed for 60 s.', { level: 'good' }); } break;
        case 'petpen': if (cd('petpen', 45000)) { p.hp = Math.min(max, p.hp + max * 0.2); worldNotice(client, '🐶 The puppies love you: +20% health.', { level: 'good' }); } break;
        case 'gate': if (a === 'board') worldBoardWithTicket(client, WL.airportByCity.get(def.ap)); break;
        default: if (s.use.startsWith('shop:') && a.startsWith('buy:')) worldBuyItem(client, a.slice(4), W_CITIES.find(c => c.id === def.ap) || null);
    }
}
function worldBoardWithTicket(client, A) {
    const w = client.world, leg = worldTicketLeg(w, A); if (!leg) return;
    if (w.scene !== 'ext') worldGoto(client, 'ext', A.sb.x, A.sb.y + 60);
    worldBoardFlight(client, A, leg);
}
// ---- in-flight service (long-haul screen menu) ----
const INFLIGHT_MENU = {
    meal:      { name: 'In-flight meal', price: 28, heal: 100 },
    snack:     { name: 'Snack box', price: 9, heal: 30 },
    coffee:    { name: 'Coffee', price: 6, heal: 15, speed: 30 },
    champagne: { name: 'Glass of champagne', price: 35, xp: 300 },
    souvenir:  { name: 'Duty-free souvenir (destination)', price: 70, souvenir: true }
};
function worldInflightOrder(client, id) {
    const w = client.world, p = client.player, f = p && p.flight, it = INFLIGHT_MENU[id]; if (!f || !it) return;
    const city = W_CITIES.find(c => c.id === f.to);
    if (it.souvenir && w.souv.has(city.id)) { worldNotice(client, `You already have a ${city.name} souvenir.`); return; }
    const biz = f.cls === 'J', price = biz ? 0 : it.price;
    if (price && !worldPayToll(client, price)) { worldNotice(client, `That costs ${it.price} coins.`, { level: 'bad' }); return; }
    const max = p.getEffectiveMaxHp(), msg = [];
    if (it.heal) { p.hp = Math.min(max, p.hp + max * it.heal / 100); msg.push(`+${it.heal}% health`); }
    if (it.speed) { p.worldSpeedUntil = Math.max(Date.now(), p.worldSpeedUntil || 0) + it.speed * 1000; msg.push('+25% speed after landing'); }
    if (it.xp) { p.addXP(it.xp); msg.push(`+${it.xp} score`); }
    if (it.souvenir) { w.souv.add(city.id); msg.push(`souvenir ${w.souv.size}/${W_CITIES.length}`); }
    worldNotice(client, `🛎 ${it.name} served (${price ? '-' + price : 'complimentary in Business'})${msg.length ? ': ' + msg.join(', ') : ''}`, { level: 'good' });
    worldPushState(client);
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
const WORLD_LAYOUT_VERSION = 5;              // v4: city styles; v5: 1.5x larger continent, interior towns, highway grid, countryside
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
    'job_last INTEGER NOT NULL DEFAULT 0', 'play_ms INTEGER NOT NULL DEFAULT 0', 'job_cd INTEGER NOT NULL DEFAULT 0',
    'car_fuel REAL', 'souv TEXT', 'stay_bid INTEGER', 'stay_until INTEGER', 'job_tasks INTEGER NOT NULL DEFAULT 0']) {
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
const junctionMap = new Map(), roadNodes = new Map(), pcarKeys = new Set(), lineRoads = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function sendWorld(client, type, extra = {}) { if (client.ws.readyState === WebSocket.OPEN) wsSendObj(client.ws, ({ type, ...extra })); }
function worldNotice(client, message, extra = {}) { sendWorld(client, 'world_notice', { message, ...extra }); }
function fmtMoney(n) { return Math.floor(n).toLocaleString('en-US'); }
function angDiff(a, b) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function worldZone(x, y) {
    const c = worldCityAt(x, y); if (!c) return 3;
    const dx = wrapDx(x - c.cx), dy = y - c.cy, nd = Math.hypot(dx, dy) / cityBorderAt(c, Math.atan2(dy, dx));
    return nd < 0.2 ? 0 : nd < 0.5 ? 1 : nd < 0.95 ? 2 : 3;
}
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
    const t0 = Date.now();
    WL = buildWorldLayout(WSEED);
    console.log(`[World] Built ${W_CITIES.length} cities, ${WL.airports.length} airports, ${WL.buildings.length} buildings in ${Date.now() - t0} ms.`);
    WL.dealerLots = WL.lots.filter(l => l.dealer);
    WL.airportByCity = new Map(WL.airports.map(a => [a.city, a]));
    // Road network for NPC traffic, in every city: junctions keyed by their global grid position, roads found by line + position.
    junctionMap.clear(); roadNodes.clear(); pcarKeys.clear(); lineRoads.clear();
    for (const r of WL.allRoads) {
        if (r.c === 'x') continue;
        r.gk = Math.round((r.p - (r.a === 'v' ? W_CX : W_CY)) / W_S);
        const key = r.a + r.gk; if (!lineRoads.has(key)) lineRoads.set(key, []); lineRoads.get(key).push(r);
        roadNodes.set(r, []);
    }
    for (const j of WL.junctions.concat(WL.xjunctions)) {
        const kx = Math.round((j.x - W_CX) / W_S), ky = Math.round((j.y - W_CY) / W_S);
        junctionMap.set(kx + ',' + ky, j);
        const v = worldRoadFor('v', kx, j.y), h = worldRoadFor('h', ky, j.x);
        if (v) roadNodes.get(v).push(j.y); if (h) roadNodes.get(h).push(j.x);
    }
    for (const a of roadNodes.values()) a.sort((p, q) => p - q);
    for (const c of WL.pcars) pcarKeys.add(Math.round(c.x) + ',' + Math.round(c.y));
    if (row.layout_version < WORLD_LAYOUT_VERSION) worldMigrateLayout(row.layout_version);
    worldLoadCompanies();
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
// The road (city street, not highway) on grid line `k` of `axis` that passes position `s` along it.
function worldRoadFor(axis, k, s) {
    const list = lineRoads.get(axis + k); if (!list) return null;
    for (const r of list) if (Math.abs(s - r.o) <= r.e + 1) return r;
    return null;
}
// Layout v3 (bigger organic cities, 8 cities on a wrapping globe): every coordinate changed. Saved players are
// moved to the same relative spot in their city, owned houses to the nearest free house there, and parked
// cars back to the dealership car park (they could otherwise end up inside a new building).
function worldMigrateLayout(fromVersion) {
    const OLD_C = 25200, OLD = { central: [25200, 25200], port: [475200, 25200], highmoor: [25200, 475200], solana: [475200, 475200] };
    const mapOld = (x, y) => {
        if (fromVersion >= 3) {                                        // v3/v4 continent (450 000-unit spacing): keep the offset from the nearest city
            let best = null, bd = Infinity;
            for (const c of W_CITIES) { if (!Number.isInteger(c.col) || !Number.isInteger(c.row)) continue; const ox = 225000 + c.col * 450000, oy = 50400 + c.row * 450000, d = Math.hypot(x - ox, y - oy); if (d < bd) { bd = d; best = [c, ox, oy]; } }
            const [c, ox, oy] = best; return { x: c.cx + (x - ox), y: c.cy + (y - oy) };
        }
        let best = 'central', bd = Infinity;
        for (const [id, [ox, oy]] of Object.entries(OLD)) { const d = Math.hypot(x - ox, y - oy); if (d < bd) { bd = d; best = id; } }
        const c = W_CITIES.find(q => q.id === best), o = OLD[best], k = c.size / 18000;
        return { x: c.cx + (x - o[0]) * k, y: c.cy + (y - o[1]) * k };
    };
    const players = db.prepare('SELECT user_id, x, y FROM world_players').all();
    const oldHouses = db.prepare('SELECT * FROM world_houses WHERE owner_id IS NOT NULL ORDER BY purchased_at').all();
    const taken = new Set();
    const ins = db.prepare('INSERT OR REPLACE INTO world_houses(id,owner_id,price,x,y,purchased_at,last_seen) VALUES(?,?,?,?,?,?,?)');
    const upd = db.prepare('UPDATE world_players SET x=?, y=? WHERE user_id=?');
    db.transaction(() => {
        for (const p of players) {
            if (p.x == null || p.y == null) continue;
            const n = fromVersion >= 3 ? mapOld(450000 / 2 + 450000 + p.x, 50400 + p.y) : mapOld(OLD_C + p.x, OLD_C + p.y);   // v3/v4 stored positions relative to the old Central City
            upd.run(Math.round(n.x - W_CX), Math.round(n.y - W_CY), p.user_id);
        }
        db.prepare('UPDATE world_players SET car_x=NULL, car_y=NULL, car_a=NULL').run();
        db.prepare('DELETE FROM world_houses').run();
        for (const h of oldHouses) {
            const t = fromVersion < 2 ? mapOld(OLD_C + h.x, OLD_C + h.y) : mapOld(h.x, h.y);   // v2+ store absolute positions
            let best = null, bd = Infinity;
            for (const b of WL.houses) { if (taken.has(b.hid)) continue; const d = (b.x + b.w / 2 - t.x) ** 2 + (b.y + b.h / 2 - t.y) ** 2; if (d < bd) { bd = d; best = b; } }
            if (!best) continue;
            taken.add(best.hid);
            ins.run(best.hid, h.owner_id, h.price || best.price, best.x + best.w / 2, best.y + best.h / 2, h.purchased_at, h.last_seen);
        }
        db.prepare('UPDATE world_meta SET layout_version=? WHERE id=1').run(WORLD_LAYOUT_VERSION);
    })();
    console.log(`[World] Migrated to layout v${WORLD_LAYOUT_VERSION}: ${players.length} player(s), ${taken.size} owned house(s); parked cars returned to the dealership.`);
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
    const fc = e.room.clients.find(c => c.player === e), fw = fc && fc.world;
    if (fw) {                                                       // fuel: burns with distance; an empty tank only lets you coast
        fw.fuel = Math.max(0, (fw.fuel ?? 100) - Math.abs(v.v) * (FUEL_RATE[spec.id] || 0.0002));
        if (fw.fuel <= 0 && inp.up) { inp.up = false; worldNoticeOnce(fc, 'nofuel', '⛽ Out of fuel! Buy a fuel can at a grocery, or hail a taxi (map).'); }
        else if (fw.fuel < 12 && fw.fuel > 0) worldNoticeOnce(fc, 'lowfuel', `⛽ Low fuel (${Math.round(fw.fuel)}%) – find a fuel station (map: ⛽).`);
    }
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
    e.x = clamp(nx, W_LAND.x0, W_LAND.x1); e.y = clamp(ny, W_LAND.y0, W_LAND.y1); e.vx = 0; e.vy = 0;
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
    const { maxHealth, ...pu } = p.powerups || {}; w.buff = { su: p.worldSpeedUntil || 0, pu, hpf: Math.max(0.05, Math.min(1, p.hp / Math.max(1, p.getEffectiveMaxHp()))) };
}
function worldSave(client) {
    const w = client.world; if (!client.dbId || !w) return;
    worldSnapshot(client);
    const now = Date.now(), p = client.player;
    let ex = w.ext; if (p && w.scene === 'ext' && !p.vehicle) ex = { x: p.x, y: p.y };
    if (p && p.flight) { const B = WL.airportByCity.get(p.flight.to); if (B) ex = { x: B.off.x, y: B.off.y }; }   // leaving mid-flight: you arrive
    const pc = parkedCars.get(client.dbId); let cx = pc?.x ?? null, cy = pc?.y ?? null, ca = pc?.a ?? null;
    if (p?.vehicle) { cx = p.x; cy = p.y; ca = p.vehicle.a; if (w.scene === 'ext') ex = { x: p.x, y: p.y }; }
    w.ext = ex;
    db.prepare(`INSERT INTO world_players(user_id,x,y,upgrades,updated_at,last_seen,owned_car,session_coins,score,level,tank_type,stat_points,car_x,car_y,car_a,job,job_last,play_ms,job_cd)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET x=excluded.x,y=excluded.y,upgrades=excluded.upgrades,updated_at=excluded.updated_at,last_seen=excluded.last_seen,owned_car=excluded.owned_car,
        session_coins=excluded.session_coins,score=excluded.score,level=excluded.level,tank_type=excluded.tank_type,stat_points=excluded.stat_points,car_x=excluded.car_x,car_y=excluded.car_y,car_a=excluded.car_a,
        job=excluded.job,job_last=excluded.job_last,play_ms=excluded.play_ms,job_cd=excluded.job_cd`)
        .run(client.dbId, ex.x - W_CX, ex.y - W_CY, JSON.stringify({ stats: w.prog.stats }), now, now, w.car || null, Math.max(0, Math.floor(w.sessionCoins || 0)),
            w.prog.score, w.prog.level, w.prog.tankType, w.prog.statPoints, cx, cy, ca, w.job?.co || null, Math.floor(w.jobLast || 0), Math.floor(w.playMs || 0), Math.floor(w.jobCd || 0));
    db.prepare('UPDATE world_players SET car_fuel=?, souv=?, stay_bid=?, stay_until=?, job_tasks=? WHERE user_id=?')
        .run(w.fuel ?? 100, JSON.stringify([...(w.souv || [])]), w.stay?.bid ?? null, w.stay?.until ?? null, w.jobTasks || 0, client.dbId);
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
        job: co ? { co: co.id, name: co.name, role: co.role, pay: co.pay, kind: co.kind, rank: WORLD_RANKS[worldRank(w)], tasks: w.jobTasks || 0, next: worldRank(w) < WORLD_RANKS.length - 1 ? WORLD_RANK_TASKS - (w.jobTasks || 0) % WORLD_RANK_TASKS : 0, perk: co.perk ? WORLD_PERKS[co.perk] : null, level: worldCoLevel(co), left: Math.max(0, worldFireMs(co) - (w.playMs - w.jobLast)) } : null,
        car: w.car ? { model: w.car, driven: !!client.player?.vehicle, x: pc?.x ?? null, y: pc?.y ?? null, a: pc?.a ?? 0, fuel: Math.round((w.fuel ?? 100) * 10) / 10 } : null,
        souv: [...(w.souv || [])], souvTotal: W_CITIES.length, stay: worldStayValid(w) ? { name: WL.buildingById.get(w.stay.bid).nm || 'Room', left: w.stay.until - Date.now() } : null,
        house: worldFirstHouse(client.dbId)
    });
}

// ---- interiors ------------------------------------------------------------------------------
function worldInteriorDef(scene) {
    let d = interiorDefs.get(scene); if (d) return d;
    const [kind, key, lvs] = scene.split(':');
    if (kind === 'work') {
        const b = WL.buildingById.get(Number(key)); const co = W_COMPANIES.find(c => c.id === (b && worldWorkOf(b))) || W_COMPANIES[0]; d = buildOfficeInterior(co); d.coId = co.id; d.bid = b ? b.id : 0;
        if (b && (b.f || 0) > 3) { const fl = 2 + (b.id * 7) % Math.max(1, b.f - 2); d.theme.name += ' · Floor ' + fl; d.theme.alt = +Math.min(3.6, 1 + fl * 0.03).toFixed(2); d.theme.eh = Math.round(fl * 5.7); }
    }
    else if (kind === 'mall') { const b = WL.buildingById.get(Number(key)); d = buildMallInterior(b || { id: 0, lv: 3 }, Math.max(1, Math.min(b?.lv || 3, Number(lvs) || 1))); furnishMall(d, b); }
    else if (kind === 'stay') { const b = WL.buildingById.get(Number(key)); const tier = b?.k === 'hotel' ? 2 : b?.k === 'inn' ? 1 : 0; d = buildHouseInterior(tier); furnishHouse(d, tier); d.bid = b ? b.id : 0; d.stay = 1; d.theme.name = b?.nm || 'Room'; if (b && b.k === 'hotel') { const fl = 3 + (b.id * 5) % Math.max(1, (b.f || 10) - 3); d.theme.name += ' · Room ' + fl + String(b.id % 40 + 1).padStart(2, '0'); d.theme.alt = +Math.min(3, 1 + fl * 0.05).toFixed(2); d.theme.eh = Math.round(fl * 6.6); } }
    else if (kind === 'term') { const ap = WL.airportByCity.get(key) || WL.airports[0]; d = buildTerminalInterior(ap); d.bid = ap.term.id; }
    else { const h = WL.houseById.get(key); const tier = h ? h.tier : 0; d = buildHouseInterior(tier); furnishHouse(d, tier); d.hid = key; }
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
    if (w.buff && !w.dead) { ent.worldSpeedUntil = w.buff.su; Object.assign(ent.powerups, w.buff.pu); if (w.buff.hpf != null) ent.hp = ent.getEffectiveMaxHp() * w.buff.hpf; }
    if (scene === 'ext' && WL) { const pos = { x, y }; layoutPushOut(WL, pos, ent.radius); ent.x = pos.x; ent.y = pos.y; }
    room.entities.push(ent); room.clients.push(client);
    client.room = room; client.player = ent; client.spectatingId = null;
    w.scene = scene; w.dead = false; w.task = null; w.promptKey = null; w.invulnerableUntil = Date.now() + 2500;
    if (scene === 'ext') w.ext = { x: ent.x, y: ent.y };
    sendWorld(client, 'world_scene', { scene: scene === 'ext' ? 'ext' : 'int', key: scene, interior: scene === 'ext' ? null : worldPublicInterior(room.def), fs: room.fstate || {}, x: ent.x, y: ent.y });
    wsSendObj(client.ws, ({ type: 'init', id: ent.id, team: 0, nc: ent.nameColor, name1: ent.name }));
    w.bankCoins = worldBankCoins(client);
    worldPushState(client);
    if (scene === 'ext') worldStreamChunks(client, true); else worldStreamView(client, room.def);
}
// Interiors look out over the real city, so the chunks round the building are sent while you're inside.
function worldStreamView(client, def) {
    const w = client.world; if (!w || !def || !WL) return;
    const b = def.hid ? WL.houseById.get(def.hid) : def.bid ? WL.buildingById.get(def.bid) : null; if (!b) return;
    const cx = clamp(Math.floor((b.x + b.w / 2) / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor((b.y + b.h / 2) / W_CHUNK), 0, W_NCH - 1), R = (def.theme && def.theme.alt > 1.6) ? 2 : 1;
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W_NCH || y >= W_NCH) continue;
        const key = x + y * W_NCH; if (w.sentChunks.has(key)) continue; w.sentChunks.add(key);
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(layoutChunkBin(WL, x, y));
    }
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
    const home = worldHomeSpawn(client.dbId), w = client.world;
    if (w && worldStayValid(w)) { const def = worldInteriorDef('stay:' + w.stay.bid); worldGoto(client, 'stay:' + w.stay.bid, def.spawn.x, def.spawn.y); }   // a booked room beats home
    else if (home) worldGoto(client, home.scene, home.def.spawn.x, home.def.spawn.y);
    else worldGoto(client, 'ext', WL.spawn.x + (Math.random() - 0.5) * 60, WL.spawn.y);
}

// ---- chunk streaming ---------------------------------------------------------------------------
function worldViewScale(p) { return Math.max(1, (1 + ((p.level || 1) - 1) * 0.011) * (p.flight ? 1.4 + 1.6 * p.flight.alt : p.vehicle ? 1.5 : 1) * (p.getPowerupActive('fov') ? 1.3 : 1)); }
function worldStreamChunks(client, force) {
    const w = client.world, p = client.player; if (!w || !p || w.scene !== 'ext' || !WL) return;
    if (Math.abs(p.y - W_YEQ) > W_EXTY * 0.62) return;                     // out over the polar oceans: there is nothing to stream
    const NX = Math.round(W_CIRC / W_CHUNK), cx = Math.floor(wrapX(p.x) / W_CHUNK) % NX, cy = clamp(Math.floor(p.y / W_CHUNK), 0, W_NCH - 1);
    const vs = worldViewScale(p), R = vs > 2.2 ? 3 : vs > 1.35 ? 2 : 1;
    // forget chunks far behind (the client drops them too), so long flights don't pile up memory on either side
    if (w.sentChunks.size > 120) for (const key of w.sentChunks) { const kx = key % W_NCH, ky = Math.floor(key / W_NCH), ddx = Math.abs(kx - cx), wdx = Math.min(ddx, NX - ddx); if (Math.max(wdx, Math.abs(ky - cy)) > 7) w.sentChunks.delete(key); }
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        const x = ((cx + dx) % NX + NX) % NX, y = cy + dy; if (y < 0 || y >= W_NCH) continue;          // columns wrap round the date line
        const key = x + y * W_NCH; if (w.sentChunks.has(key)) continue;
        w.sentChunks.add(key);
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(layoutChunkBin(WL, x, y));
    }
}
function worldSendStatic(client) {
    const bld = b => b && { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, door: b.door };
    sendWorld(client, 'world_static', {
        globe: { R: W_R, yEq: W_YEQ, latMax: W_LATMAX, sph: FL_SPH }, cultures: W_CULTURES, dayMs: WORLD_DAY_MS,
        air: { airlines: AIRLINES, aircraft: AIRCRAFT, legs: airNet().legs.map(l => ({ al: l.al, ac: l.ac, fn: l.fn, from: l.from, to: l.to, mins: l.mins, per: l.per, off: l.off })) },
        center: W_CX, centerY: W_CY, extent: W_CIRC, extentY: W_EXTY, circ: W_CIRC, gap: W_GAP, land: W_LAND, chunk: W_CHUNK, nch: W_NCH, roads: WL.allRoads,
        cities: W_CITIES.map(c => ({ id: c.id, name: c.name, code: c.code, cx: c.cx, cy: c.cy, tz: c.tz, theme: c.theme, style: c.style, culture: c.culture, toll: c.toll, home: !!c.home, size: c.size, border: c.border, bp: c.bp })),
        airports: WL.airports.map(a => ({ city: a.city, name: a.name, code: a.code, x0: a.x0, x1: a.x1, ry: a.ry, sb: a.sb, door: a.door })),
        cars: WORLD_CARS, carColors: WORLD_CAR_COLORS,
        companies: W_COMPANIES, spawn: WL.spawn, bank: bld(WL.bank), dealer: bld(WL.dealer), fireMs: WORLD_FIRE_MS, taskMs: WORLD_TASK_MS, items: WORLD_ITEMS, shopKinds: SHOP_KINDS, stallKinds: STALL_KINDS, ranks: WORLD_RANKS, inflight: INFLIGHT_MENU
    });
    sendWorld(client, 'world_houses', { list: [...houseOwner].map(([hid, o]) => [hid, o.name, o.owner_id === client.dbId ? 1 : 0]) });
    sendWorld(client, 'world_branches', { list: [...(WL.branch || [])] });
}

// ---- jobs / banking / houses / cars -------------------------------------------------------------
function worldEmployer(w) { return w.job ? W_COMPANIES.find(c => c.id === w.job.co) : null; }
function worldFire(client, reason) {
    const w = client.world, co = worldEmployer(w); if (!co) return;
    w.job = null; w.task = null; w.mission = null; w.jobTasks = 0; w.jobCd = Date.now() + WORLD_REHIRE_MS; worldPushMission(client);
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
// ---- flights ---------------------------------------------------------------------------------------------------
// Planes cruise at 3x a sport car's top speed on a highway (highways double a car's top speed).
const PLANE_CRUISE = 3 * WORLD_CARS.find(c => c.id === 'sport').speed * 2;
const WORLD_DAY_MS = 12 * 60 * 1000;                     // same shared day as the client's day/night cycle
const WORLD_HEAD_LABEL = { east: 'Eastbound ➜', west: '⬅ Westbound', north: '⬆ Northbound', south: '⬇ Southbound' };
function worldTzLabel(tz) { return tz === 0 ? 'CT' : 'CT' + (tz > 0 ? '+' : '') + tz; }
function worldLocalClock(tz) { const h = ((6 + (Date.now() % WORLD_DAY_MS) / WORLD_DAY_MS * 24 + tz) % 24 + 24) % 24; return String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0'); }
// ---- airlines -------------------------------------------------------------------------------------------------------
// Four flag carriers fly from their region's hub to the other hubs (wide-bodies on the long trunks) and out to every town
// in their region (turboprops to the small ones). Prairie Link flies turboprops between small towns and their nearest
// neighbour abroad; Hopper is the budget airline linking the big non-hub cities point to point. Everything else is a
// connection: one ticket, change planes airside at the hub.
const AIRLINES = {
    CA: { name: 'Central Air',       kind: 'flag',     hub: 'central', c1: '#c0392b', c2: '#f5c518', tail: '#14213d' },
    WR: { name: 'Westreach Airways', kind: 'flag',     hub: 'redmesa', c1: '#9a5b2a', c2: '#e8c53a', tail: '#4a2c14' },
    SJ: { name: 'Sunward Jet',       kind: 'flag',     hub: 'solana',  c1: '#f39c12', c2: '#1f6fd1', tail: '#0b3d91' },
    KW: { name: 'Kaimana Wings',     kind: 'flag',     hub: 'kaimana', c1: '#16a085', c2: '#ff7f50', tail: '#0b4f4a' },
    HP: { name: 'Hopper',            kind: 'budget',   c1: '#ff6f00', c2: '#ffd54f', tail: '#ff6f00' },
    PL: { name: 'Prairie Link',      kind: 'regional', c1: '#2e8b57', c2: '#f1f1f1', tail: '#1e5631' }
};
const AIRCRAFT = { prop: { name: 'Turboprop', speed: 0.62 }, narrow: { name: 'Narrow-body jet', speed: 1 }, wide: { name: 'Wide-body jet', speed: 1.12 } };
const AIR_HUB = { west: 'redmesa', central: 'central', sun: 'solana', isles: 'kaimana' }, AIR_FLAG = { west: 'WR', central: 'CA', sun: 'SJ', isles: 'KW' };
let AIR_NET = null;
function airSmall(c) { return c.style === 'rural' || c.size < 16000; }
function airHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function airNet() {
    if (AIR_NET) return AIR_NET;
    const legs = [], from = new Map(), seen = new Set(), ap = c => WL.airportByCity.get(c), city = id => W_CITIES.find(c => c.id === id);
    const len = (a, b) => { const A = ap(a), B = ap(b); return wGC(A.sb.x, A.sb.y, B.sb.x, B.sb.y).d; };     // true great-circle distance
    const add = (al, a, b, ac) => {
        for (const [x, y] of [[a, b], [b, a]]) {
            const k = al + x + '>' + y; if (x === y || seen.has(k) || !ap(x) || !ap(y)) continue; seen.add(k);
            const L0 = len(x, y), AL = AIRLINES[al], h = airHash(k), mul = AL.kind === 'budget' ? 0.62 : AL.kind === 'regional' ? 0.85 : 1;
            const fare = Math.round((30 + L0 / 6000) * mul), per = (ac === 'wide' ? 9 : ac === 'prop' ? 7 : 6) * 60000;
            const A = ap(x), B = ap(y), pole = wGCPole(A.sb.x, A.sb.y, B.sb.x, B.sb.y);
            const leg = { al, ac, pole, fn: al + (100 + h % 880), from: x, to: y, len: Math.round(L0), mins: Math.max(1, Math.round((L0 / (PLANE_CRUISE * FL_SPH * AIRCRAFT[ac].speed) + 2500) / 360) / 10), fare, fareJ: Math.round(fare * 2.8 + 60), per, off: h % per };
            legs.push(leg); (from.get(x) || from.set(x, []).get(x)).push(leg);
        }
    };
    const hubs = Object.values(AIR_HUB);
    for (const [cu, hub] of Object.entries(AIR_HUB)) {
        const al = AIR_FLAG[cu];
        for (const h2 of hubs) if (h2 !== hub) add(al, hub, h2, len(hub, h2) > 600000 ? 'wide' : 'narrow');
        for (const c of W_CITIES) if (c.culture === cu && c.id !== hub) add(al, hub, c.id, airSmall(c) ? 'prop' : 'narrow');
    }
    for (const c of W_CITIES) if (airSmall(c)) {                 // Prairie Link: each small town to its nearest airport in another region
        const o = W_CITIES.filter(q => q.culture !== c.culture).sort((p, q) => len(c.id, p.id) - len(c.id, q.id))[0]; if (o) add('PL', c.id, o.id, 'prop');
    }
    const big = W_CITIES.filter(c => !airSmall(c) && !hubs.includes(c.id));
    for (const c of big) for (const o of big.filter(q => q.culture !== c.culture).sort((p, q) => len(c.id, p.id) - len(c.id, q.id)).slice(0, 2)) add('HP', c.id, o.id, len(c.id, o.id) > 700000 ? 'wide' : 'narrow');
    AIR_NET = { legs, from };
    return AIR_NET;
}
// Every way to fly from airport A: direct, one stop, or (only where needed) two stops. Up to three choices per destination.
function airItins(A) {
    if (A._itins) return A._itins;
    const net = airNet(), byDest = new Map(), legsFrom = c => net.from.get(c) || [];
    const push = legs => {
        const cities = [A.city, ...legs.map(l => l.to)]; if (new Set(cities).size !== cities.length) return;
        const dest = legs[legs.length - 1].to, k = legs.length > 1 ? 0.85 : 1;
        const o = { key: legs.map(l => l.fn).join('+'), legs, stops: legs.length - 1, mins: Math.round((legs.reduce((t, l) => t + l.mins, 0) + (legs.length - 1) * 2) * 10) / 10,
            fare: Math.round(legs.reduce((t, l) => t + l.fare, 0) * k), fareJ: Math.round(legs.reduce((t, l) => t + l.fareJ, 0) * k) };
        (byDest.get(dest) || byDest.set(dest, []).get(dest)).push(o);
    };
    for (const l1 of legsFrom(A.city)) { push([l1]); for (const l2 of legsFrom(l1.to)) push([l1, l2]); }
    const reached = new Set(byDest.keys());
    for (const l1 of legsFrom(A.city)) for (const l2 of legsFrom(l1.to)) for (const l3 of legsFrom(l2.to)) if (!reached.has(l3.to)) push([l1, l2, l3]);
    const out = new Map();
    for (const [dest, list] of byDest) {
        if (dest === A.city) continue;
        list.sort((p, q) => p.mins - q.mins || p.fare - q.fare);
        const best = list[0].mins, keep = [], add = o => { if (o && !keep.includes(o) && keep.length < 3) keep.push(o); };
        list.filter(o => !o.stops).forEach(add);
        add(list[0]); add(list.slice().sort((p, q) => p.fare - q.fare)[0]);
        for (const o of list) if (o.mins <= best * 1.8 + 3 && !keep.some(k => k.legs[0].al === o.legs[0].al)) add(o);
        out.set(dest, keep.sort((p, q) => p.mins - q.mins));
    }
    return (A._itins = out);
}
function airFindItin(A, key) { for (const list of airItins(A).values()) for (const o of list) if (o.key === key) return o; return null; }
// The check-in / phone list: one entry per option, grouped by destination on the client.
function airItinActions(client, A) {
    const w = client.world, money = Math.floor(w.sessionCoins || 0) + (w.bankCoins || 0), out = [];
    const dests = [...airItins(A)].sort((p, q) => p[1][0].mins - q[1][0].mins);
    for (const [dest, list] of dests) {
        const B = WL.airportByCity.get(dest), cB = W_CITIES.find(c => c.id === dest), g = wGC(A.sb.x, A.sb.y, B.sb.x, B.sb.y), cb = Math.cos(g.brg);
        const head = cb > 0.7 ? 'north' : cb < -0.7 ? 'south' : Math.sin(g.brg) > 0 ? 'east' : 'west';
        for (const o of list) out.push({ a: 'tix:' + o.key, on: money >= o.fare, onJ: money >= o.fareJ, city: dest, code: B.code, name: cB.name, tz: cB.tz, head, km: Math.round(o.legs.reduce((t, l) => t + l.len, 0) / 1000),
            mins: o.mins, fare: o.fare, fareJ: o.fareJ, stops: o.stops, pole: (o.legs.find(l => l.pole) || {}).pole || '', via: o.legs.slice(0, -1).map(l => WL.airportByCity.get(l.to).code), legs: o.legs.map(l => ({ al: l.al, fn: l.fn, ac: l.ac, from: WL.airportByCity.get(l.from).code, to: WL.airportByCity.get(l.to).code })), label: `${B.code} · ${cB.name}` });
    }
    return out;
}
function worldBuyItin(client, A, key, cls, remote) {
    const w = client.world, o = A && airFindItin(A, key); if (!o) return false;
    const price = cls === 'J' ? o.fareJ : o.fare, l0 = o.legs[0], B = WL.airportByCity.get(o.legs[o.legs.length - 1].to), cB = W_CITIES.find(c => c.id === B.city);
    if (!worldPayToll(client, price)) { worldNotice(client, `That ticket costs ${fmtMoney(price)} coins.`, { level: 'bad' }); return false; }
    w.itin = { key, legs: o.legs.map(l => ({ from: l.from, to: l.to, al: l.al, fn: l.fn, ac: l.ac })), i: 0, cls, fare: price, until: Date.now() + (remote ? 60 : 30) * 60000 };
    const via = o.stops ? ` via ${o.legs.slice(0, -1).map(l => WL.airportByCity.get(l.to).code).join(', ')}` : ' nonstop';
    worldNotice(client, `🎫 ${cls === 'J' ? 'Business' : 'Economy'} ticket ${A.code} → ${B.code} (${cB.name})${via}. First flight: ${AIRLINES[l0.al].name} ${l0.fn}. ${remote ? `Head to ${A.name} – your mobile boarding pass works at the gate.` : 'Go through security to the gate.'}`, { level: 'good' });
    w.promptKey = '\u0000'; worldPushState(client);
    return true;
}
function worldTicketLeg(w, A) { const it = w.itin; if (!it || it.until < Date.now()) return null; const l = it.legs[it.i]; return l && (!A || l.from === A.city) ? l : null; }
function worldBoardFlight(client, A, leg) {
    const w = client.world, p = client.player, B = leg && WL.airportByCity.get(leg.to);
    if (!w || !p || !B || B === A || p.vehicle || p.flight || w.scene !== 'ext') return;
    const ac = AIRCRAFT[leg.ac] || AIRCRAFT.narrow, AL = AIRLINES[leg.al], f = flightCreate(A, B, PLANE_CRUISE * ac.speed);
    f.al = leg.al; f.ac = leg.ac; f.fn = leg.fn; f.cls = w.itin ? w.itin.cls : 'Y'; f.liv = 0;
    if (client.room) client.room.drones = client.room.drones.filter(d => d.owner !== p);
    p.activeDrones = 0; w.task = null;
    p.flight = f; p.ghost = true; p.x = f.x; p.y = f.y; p.vx = p.vy = 0;
    p.inputs = { up: false, down: false, left: false, right: false, shooting: false, angle: p.inputs?.angle || 0, repel: false };
    const fromCity = W_CITIES.find(c => c.id === A.city), toCity = W_CITIES.find(c => c.id === B.city), it = w.itin, last = !it || it.i >= it.legs.length - 1;
    worldNotice(client, `${AL.name} ${leg.fn} · ${A.code} → ${B.code} (${toCity.name}) · ${ac.name}${f.viaPole ? ` · over the ${f.viaPole === 'N' ? 'North' : 'South'} Pole` : ''}. ${f.cls === 'J' ? 'Welcome to Business – the menu is on us. ' : ''}Taxiing to the runway.`, { level: 'good' });
    w.flightInfo = { from: A.city, to: B.city, fromName: fromCity.name, toName: toCity.name, fromCode: A.code, toCode: B.code, dir: f.head, tz: toCity.tz, fromTz: fromCity.tz, total: flightRemaining(f), dist: f.dist,
        long: leg.ac === 'wide' || f.dist > W_GAP * 0.9 ? 1 : 0, east: f.dir === 'east' ? 1 : 0, al: leg.al, alName: AL.name, fn: leg.fn, ac: leg.ac, acName: ac.name, cls: f.cls, pole: f.viaPole || '',
        next: !last ? (() => { const n = it.legs[it.i + 1]; return `${AIRLINES[n.al].name} ${n.fn} to ${WL.airportByCity.get(n.to).code}`; })() : '' };
    worldPushFlight(client);
    worldPushState(client);
}
function worldPushFlight(client) {
    const w = client.world, f = client.player?.flight;
    if (!w || !f || !w.flightInfo) { sendWorld(client, 'world_flight', { f: null }); return; }
    const rem = flightRemaining(f), gs = flightSpeed(f), sp = Math.max(FL_VR / f.land.kT, f.ph === 'air' ? gs : 0) * 60;
    sendWorld(client, 'world_flight', { f: { ...w.flightInfo, ph: f.ph, rem: Math.round(rem), eta: Math.round(rem / sp + 25), alt: Math.round(f.alt * 100) / 100, kmh: Math.round(gs * 60 * 3.6 / 10) } });
}
function worldStepFlight(e) {
    const f = e.flight, ev = flightStep(f);
    e.x = f.x; e.y = f.y; e.vx = 0; e.vy = 0;
    const c = e.room.clients.find(q => q.player === e);
    const north = e.flight && e.flight.q ? e.flight.q[2] > 0 : f.y < W_YEQ;
    if (ev === 'pole' && c && c.world && c.world.flightInfo) { c.world.flightInfo.dir = north ? 'south' : 'north'; worldPushFlight(c); }
    if (ev === 'pole' && c) worldNotice(c, `🧭 ${f.poleKm < 25 ? `Over the ${north ? 'North' : 'South'} Pole` : `Passing the ${north ? 'North' : 'South'} Pole, ${f.poleKm} km off the wing`} – every time zone meets there. You're heading ${north ? 'south' : 'north'} now, down the far side of the world.`, { level: 'warn' });
    if (ev === 'wrap' && c) worldNotice(c, f.wrapEast ? '✈ Crossing the International Date Line eastbound – calendars go back one day.' : '✈ Crossing the International Date Line westbound – calendars jump forward one day.', { level: 'warn' });
    if (ev === 'done') worldEndFlight(e, c);
}
function worldEndFlight(e, client) {
    const f = e.flight, B = WL.airportByCity.get(f.to), city = W_CITIES.find(q => q.id === f.to);
    e.flight = null; e.ghost = false; e.vx = e.vy = 0;
    const pos = { x: B.off.x, y: B.off.y }; layoutPushOut(WL, pos, e.radius); e.x = pos.x; e.y = pos.y;
    if (!client || !client.world) return;
    client.world.ext = { x: e.x, y: e.y }; client.world.flightInfo = null;
    sendWorld(client, 'world_flight', { f: null });
    const it = client.world.itin;
    if (it && it.legs[it.i] && it.legs[it.i].to === f.to) {
        it.i++;
        if (it.i < it.legs.length) {                                     // a connection: straight to the gate, airside, without going through the city
            const n = it.legs[it.i], key = 'term:' + B.city, def = worldInteriorDef(key), gs = def.stations.find(q => q.use === 'gate');
            it.until = Math.max(it.until, Date.now() + 30 * 60000);
            worldGoto(client, key, gs.x, gs.y + 70);
            worldNotice(client, `🔁 Welcome to ${city.name} (${worldTzLabel(city.tz)}). Your connection ${AIRLINES[n.al].name} ${n.fn} to ${WL.airportByCity.get(n.to).code} boards at Gate 2 – it's right here.`, { level: 'good' });
            worldPushState(client); return;
        }
        client.world.itin = null;
    }
    worldNotice(client, `Welcome to ${city.name}! Local time ${worldLocalClock(city.tz)} (${worldTzLabel(city.tz)}).`, { level: 'good' });
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
    if (p.flight) return null;
    if (p.taxiRide) { const r = p.taxiRide; return { id: 'taxiride', kind: 'taxiride', ax: p.x, ay: p.y - 60, title: '🚕 Taxi to ' + r.dest.label, lines: [`Meter: ${worldTaxiFare(r)} coins`], actions: [{ a: 'stop', label: 'Stop here and pay', on: true }], mini: true }; }
    if (p.vehicle) {
        const spec = p.vehicle.spec, slow = Math.abs(p.vehicle.v) <= 3.5, fuel = Math.round(w.fuel ?? 100);
        if (Math.abs(p.vehicle.v) < 1.5) for (const q of worldChunkList(p.x, p.y, 1, 'props')) {
            if (q.k !== 'pump' || Math.hypot(q.x + q.w / 2 - p.x, q.y + q.h / 2 - p.y) > 140) continue;
            const per = worldFuelPrice(p), need = Math.max(0, 100 - fuel);
            return { id: 'pump', kind: 'pump', ax: p.x, ay: p.y - 60, title: '⛽ Fuel pump', lines: [`Tank ${fuel}% · ${per.toFixed(2)} coins / L`], actions: [{ a: 'fill', label: need >= 1 ? `Fill up (${Math.round(need)} L · ${Math.round(need * per)})` : 'Tank is full', on: need >= 1 }, { a: 'exit', label: 'Get out', on: true }] };
        }
        return { id: 'exitcar', kind: 'exitcar', ax: p.x, ay: p.y - 56, title: spec.name, lines: [slow ? `Park up and get out · fuel ${fuel}%` : `Slow down to get out · fuel ${fuel}%`], actions: [{ a: 'exit', label: 'Get out', on: slow }], mini: true };
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
    for (const ap of WL.airports) {                                  // airport: departures board at the terminal, boarding at gate 2
        if (Math.abs(ap.sb.x - p.x) > 2500 || Math.abs(ap.sb.y - p.y) > 2500) continue;
        const dg = Math.hypot(ap.sb.x - p.x, ap.sb.y - p.y), dd = dist(ap.door), city = W_CITIES.find(c => c.id === ap.city);
        if (dg < 210) {
            const t = worldTicketLeg(w, ap), B = t && WL.airportByCity.get(t.to), cB = B && W_CITIES.find(c => c.id === B.city);
            consider(dg - 60, { id: 'gate:' + ap.city, kind: 'gate', ctx: ap, ax: ap.sb.x, ay: ap.sb.y - 130, title: `✈ ${ap.code} · Gate 2`,
                lines: t ? [`${AIRLINES[t.al].name} ${t.fn} · ${ap.code} → ${B.code} ${cB.name}`, `${city.name} · ${worldTzLabel(city.tz)}`] : ['Check in inside the terminal, or book on your phone', `${city.name} · ${worldTzLabel(city.tz)}`],
                actions: t ? [{ a: 'board', label: `Board ${t.fn} to ${cB.name}`, on: true }] : [{ a: 'enter', label: 'Go to the terminal', on: true }] });
        } else if (dd < 160) {
            consider(dd, { id: 'terminal:' + ap.city, kind: 'terminal', ctx: ap, ax: ap.term.x + ap.term.w / 2, ay: ap.term.y + ap.term.h / 2, title: ap.name, lines: ['Check-in · security · departure lounge · Gate 2', `${airItins(ap).size} destinations`], actions: [{ a: 'enter', label: 'Enter the terminal', on: true }] });
        }
    }
    const cx = clamp(Math.floor(p.x / W_CHUNK), 0, W_NCH - 1), cy = clamp(Math.floor(p.y / W_CHUNK), 0, W_NCH - 1);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const ch = WL.chunks.get((cx + dx) + (cy + dy) * W_NCH); if (!ch) continue;
        for (const b of ch.buildings) {
            const work = worldWorkOf(b);
            if (!work && !b.hid && !b.shop && !b.attr && b.k !== 'hotel' && b.k !== 'inn' && b.k !== 'motel' && b.k !== 'megamall' && b.k !== 'cathedral') continue;
            const d = dist(b.door); if (d > 110 || d >= bd) continue;
            const ax = b.x + b.w / 2, ay = b.y + b.h / 2, city = W_CITIES.find(c => c.id === b.city) || null;
            if (b.attr || b.k === 'cathedral') {
                const co = work && W_COMPANIES.find(c => c.id === work), price = worldItemPrice({ price: b.k === 'cathedral' ? 4 : 9 }, city);
                consider(d, { id: 'attr:' + b.id, kind: 'attraction', ctx: b, ax, ay, title: b.nm || (co ? co.name : 'Gallery'), lines: [b.k === 'cathedral' ? 'Historic cathedral · open to visitors' : 'Exhibition open to the public', co ? `Hiring: ${co.role} (staff entrance)` : ''].filter(Boolean),
                    actions: [{ a: 'visit', label: `Visit (${price})`, on: true }, ...(co ? [{ a: 'enter', label: 'Staff entrance', on: true }] : [])] });
            } else if (work) {
                const co = W_COMPANIES.find(c => c.id === work), mine = w.job?.co === co.id, branch = !b.work;
                consider(d, { id: 'work:' + b.id, kind: 'work', ctx: b, ax, ay, title: co.name + (branch ? ' (branch)' : ''), lines: [mine ? `You work here as ${WORLD_RANKS[worldRank(w)]} ${co.role}` : `Hiring: ${co.role} · ~${worldPayFor(co, b.door)} coins per ${co.kind === 'desk' ? 'task' : co.kind === 'farm' ? '5 crops' : 'job'}`, co.perk ? 'Perk: ' + WORLD_PERKS[co.perk] : 'Staff entrance – reception inside'], actions: [{ a: 'enter', label: 'Go inside', on: true }] });
            } else if (b.shop) {
                const sk = SHOP_KINDS[b.shop], sp = worldShopPrompt(client, b.shop, sk.items, city, b.fuel ? 'airport' : 'street');
                consider(d, { id: 'shop:' + b.id, kind: 'shop', ctx: { city, items: worldCultureItems(b.shop, sk.items, city) }, ax, ay, title: (b.fuel ? '⛽ ' : '') + (b.sn || sk.name), lines: [`${city ? city.name + ' prices' : 'Roadside prices'} · cash ${fmtMoney(cash)} · bank ${fmtMoney(coins)}`, ...(sp.greet ? [sp.greet] : [])], actions: sp.actions, pick: true });
            } else if (b.k === 'megamall') {
                consider(d, { id: 'mall:' + b.id, kind: 'mallenter', ctx: b, ax, ay, title: b.nm || 'Shopping mall', lines: [`${b.lv || 3} levels of shops, cafés and souvenirs`], actions: [{ a: 'enter', label: 'Go inside', on: true }] });
            } else if (b.k === 'hotel' || b.k === 'inn' || b.k === 'motel') {
                const mine = worldStayValid(w) && w.stay.bid === b.id, price = worldStayPrice(b), stars = b.k === 'hotel' ? '★'.repeat(b.stars || 4) : b.k === 'inn' ? 'Inn' : 'Motel';
                consider(d, { id: 'hotel:' + b.id, kind: 'hotel', ctx: b, ax, ay, title: `${b.nm || 'Hotel'} · ${stars}`, lines: mine ? [`Your room is booked for ${worldFmtMs(w.stay.until - Date.now())} more`] : [`A room for 30 min: rest, heal and respawn here`, `Price ${fmtMoney(price)} (cash or bank)`],
                    actions: mine ? [{ a: 'room', label: 'Go to your room', on: true }] : [{ a: 'book', label: `Book a room · ${fmtMoney(price)}`, on: cash + coins >= price }] });
            } else if (b.hid) {
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
            if (a.k === 'stall') {
                const d = Math.hypot(a.x + 32 - p.x, a.y + 20 - p.y); if (d > 90) continue;
                const sk = STALL_KINDS[a.sk] || STALL_KINDS.food, city = W_CITIES.find(c => c.id === a.city) || null, sp = worldShopPrompt(client, a.sk || 'food', sk.items, city, 'street');
                consider(d, { id: 'stall:' + a.id, kind: 'stall', ctx: { city, items: worldCultureItems(a.sk || 'food', sk.items, city) }, ax: a.x + 32, ay: a.y - 30, title: sk.name, lines: [city ? city.name : '', ...(sp.greet ? [sp.greet] : [])], actions: sp.actions, pick: true });
                continue;
            }
            if (a.k !== 'atm') continue;
            const d = Math.hypot(a.x + 13 - p.x, a.y + 7 - p.y); if (d > 85) continue;
            consider(d, { id: 'atm:' + a.x + ',' + a.y, kind: 'atm', ax: a.x + 13, ay: a.y - 36, title: 'ATM', lines: [`Unbanked cash: ${fmtMoney(cash)}`, `Account balance: ${fmtMoney(coins)}`], actions: [{ a: 'deposit', label: cash > 0 ? `Deposit ${fmtMoney(cash)}` : 'Nothing to deposit', on: cash > 0 }], mini: true });
        }
    }
    const tr = taxiRides.get(client);
    if (tr && tr.phase === 'waiting') { const d = Math.hypot(tr.x - p.x, tr.y - p.y); if (d < 140) consider(d - 50, { id: 'taxi', kind: 'taxi', ax: tr.x, ay: tr.y - 50, title: '🚕 Your taxi', lines: [`To ${tr.dest.label}`], actions: [{ a: 'board', label: 'Get in', on: true }, { a: 'cancel', label: 'Cancel', on: true }], mini: true }); }
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
    for (const s of def.stations) if (s.use && near(s)) { const r = worldUsePrompt(client, def, s); if (r) consider(r[0] - 10, r[1]); }
    if (exitD < def.door.r) consider(exitD, { id: 'exit', kind: 'exit', ax: def.door.px, ay: def.door.py - 40, title: def.stay ? 'Leave your room' : def.kind === 'house' ? 'Front door' : 'Exit building', lines: ['Back to the street'], actions: [{ a: 'exit', label: 'Go outside', on: true }], mini: true });
    if (def.kind === 'office') {
        const co = W_COMPANIES.find(c => c.id === def.coId), emp = worldEmployer(w), mine = emp && emp.id === co.id, now = Date.now();
        if (near(def.reception)) {
            const lines = [co.name, `${co.role} · ${worldPayFor(co, w.ext)} coins per shift`]; const actions = [];
            const how = { desk: `Desk tasks take ${co.task}s`, courier: 'Pick up and deliver parcels around town (J: next job)', taxi: 'Drive passengers in your own car (J: next fare)', guide: 'Lead tour groups round the sights (J: next tour)', farm: 'Harvest crops: shoot the shapes in farm fields' }[co.kind];
            lines.push(how); if (co.perk) lines.push('Perk: ' + WORLD_PERKS[co.perk]);
            lines.push(`Company level ${worldCoLevel(co)} · promotion every ${WORLD_RANK_TASKS} tasks (+15% pay each)`);
            if (mine) { lines.push(`${WORLD_RANKS[worldRank(w)]} · shift due in ${worldFmtMs(worldFireMs(co) - (w.playMs - w.jobLast))}`); actions.push({ a: 'quit', label: 'Resign', on: true }); }
            else if (emp) lines.push(`Resign from ${emp.name} first`);
            else if (now < (w.jobCd || 0)) lines.push(`Recently fired – retry in ${worldFmtMs((w.jobCd || 0) - now)}`);
            else { lines.push(`Work at least every ${Math.round(worldFireMs(co) / 60000)} min of play or you will be fired`); actions.push({ a: 'apply', label: 'Apply for the job', on: true }); }
            consider(Math.hypot(def.reception.x - p.x, def.reception.y - p.y) - 60, { id: 'reception', kind: 'reception', ax: def.reception.x, ay: def.reception.y - 90, title: 'Reception', lines, actions });
        }
        for (const s of def.stations) if (!s.use && near(s)) {
            const t = w.task && w.task.desk === s.id;
            const desk = co.kind === 'desk', lines = !mine ? ['You need a job here – apply at reception'] : !desk ? ['Your work is out in the city – press J for the next job'] : (t ? ['Working…'] : [`Earn ~${Math.round(worldPayFor(co, w.ext) * (1 + 0.15 * worldRank(w)))} coins · takes ${co.task}s`, 'Stay at your desk until finished']);
            consider(Math.hypot(s.x - p.x, s.y - p.y) - 30, { id: s.id, kind: 'desk', ctx: s, ax: s.x, ay: s.y - 70, title: 'Work station', lines, actions: mine && desk ? [t ? { a: 'cancel', label: 'Stop', on: true } : { a: 'work', label: 'Start work', on: true }] : [] });
        }
    } else if (def.kind === 'mall') {
        const b = WL.buildingById.get(def.bid), city = b && W_CITIES.find(c => c.id === b.city);
        for (const s of def.stations) if (!s.use && near(s)) {
            if (s.shop) { const sp = worldShopPrompt(client, s.shop, SHOP_KINDS[s.shop].items, city, def.casino ? 'casino' : 'mall'); consider(Math.hypot(s.x - p.x, s.y - p.y), { id: s.id, kind: 'shop', ctx: { city, items: worldCultureItems(s.shop, SHOP_KINDS[s.shop].items, city) }, ax: s.x, ay: s.y - 80, title: SHOP_KINDS[s.shop].name, lines: [def.theme.name, ...(sp.greet ? [sp.greet] : [])], actions: sp.actions, pick: true }); }
            else consider(Math.hypot(s.x - p.x, s.y - p.y), { id: s.id, kind: 'escalator', ax: s.x, ay: s.y - 70, title: 'Escalator', lines: [s.id === 'up' ? `Up to level ${def.lv + 1}` : `Down to level ${def.lv - 1}`], actions: [{ a: s.id, label: s.id === 'up' ? '⬆ Go up' : '⬇ Go down', on: true }], mini: true });
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
    const pr = worldComputePrompt(client); if (!pr || pr.id !== d.id) return;
    const act = (pr.actions || []).find(a => a.a === d.a); if (!act || act.on === false) return;
    switch (pr.kind) {
        case 'bank': case 'atm': worldDeposit(client); break;
        case 'dealer': if (act.a.startsWith('buy:')) worldBuyCar(client, act.a.slice(4)); break;
        case 'work': { const def = worldInteriorDef('work:' + pr.ctx.id); worldGoto(client, 'work:' + pr.ctx.id, def.spawn.x, def.spawn.y); break; }
        case 'house':
            if (act.a === 'buy') worldBuyHouse(client, pr.ctx);
            else { const def = worldInteriorDef('house:' + pr.ctx.hid); w.homeDoor = worldOutsideDoor(pr.ctx); worldGoto(client, 'house:' + pr.ctx.hid, def.spawn.x, def.spawn.y); }
            break;
        case 'car': worldEnterCar(client); break;
        case 'exitcar': worldExitCar(client, false); break;
        case 'exit': {
            const def = client.room.def, b = def.hid ? WL.houseById.get(def.hid) : WL.buildingById.get(def.bid);
            const pos = b ? worldOutsideDoor(b) : WL.spawn; worldGoto(client, 'ext', pos.x, pos.y); break;
        }
        case 'reception': {
            const def = client.room.def, co = W_COMPANIES.find(c => c.id === def.coId);
            if (act.a === 'apply') { w.job = { co: co.id }; w.jobLast = w.playMs; w.jobTasks = 0; w.mission = null; worldNotice(client, `You're hired as ${WORLD_RANKS[0]} ${co.role} at ${co.name}! ${co.kind === 'desk' ? 'Complete a task at any desk' : co.kind === 'farm' ? 'Harvest crops in the fields' : 'Press J outside for your next job'} at least every ${Math.round(worldFireMs(co) / 60000)} minutes of play.`, { level: 'good' }); }
            else if (act.a === 'quit') { w.job = null; w.task = null; w.mission = null; w.jobTasks = 0; worldNotice(client, `You resigned from ${co.name}.`); worldPushMission(client); }
            worldPushState(client); worldSave(client); break;
        }
        case 'desk':
            if (act.a === 'work') { w.task = { desk: pr.id, start: Date.now(), x: p.x, y: p.y }; }
            else w.task = null;
            break;
        case 'bed': worldDoRest(client); break;
        case 'gate': if (act.a === 'board') worldBoardWithTicket(client, pr.ctx); else if (act.a === 'enter') { const def = worldInteriorDef('term:' + pr.ctx.city); worldGoto(client, 'term:' + pr.ctx.city, def.spawn.x, def.spawn.y); } break;
        case 'terminal': if (act.a === 'enter') { const def = worldInteriorDef('term:' + pr.ctx.city); worldGoto(client, 'term:' + pr.ctx.city, def.spawn.x, def.spawn.y); } break;
        case 'use': case 'tickets': worldUse(client, pr.ctx, act.a, d); break;
        case 'shop': case 'stall': if (act.a.startsWith('buy:')) worldBuyItem(client, act.a.slice(4), pr.ctx.city); break;
        case 'attraction': if (act.a === 'visit') worldVisit(client, pr.ctx); else if (act.a === 'enter') { const def = worldInteriorDef('work:' + pr.ctx.id); worldGoto(client, 'work:' + pr.ctx.id, def.spawn.x, def.spawn.y); } break;
        case 'hotel':
            if (act.a === 'book') worldBookStay(client, pr.ctx);
            else if (act.a === 'room') { const def = worldInteriorDef('stay:' + pr.ctx.id); worldGoto(client, 'stay:' + pr.ctx.id, def.spawn.x, def.spawn.y); }
            break;
        case 'mallenter': { const def = worldInteriorDef('mall:' + pr.ctx.id + ':1'); worldGoto(client, 'mall:' + pr.ctx.id + ':1', def.spawn.x, def.spawn.y); break; }
        case 'escalator': {
            const def = client.room.def, lv = def.lv + (act.a === 'up' ? 1 : -1), key = 'mall:' + def.bid + ':' + lv, nd = worldInteriorDef(key), st = nd.stations.find(q => q.id === (act.a === 'up' ? 'down' : 'up'));
            worldGoto(client, key, st ? st.x : nd.spawn.x, st ? st.y - 40 : nd.spawn.y); break;
        }
        case 'pump': if (act.a === 'fill') worldRefuel(client); else if (act.a === 'exit') worldExitCar(client, false); break;
        case 'taxi': if (act.a === 'board') worldBoardTaxi(client); else if (act.a === 'cancel') { taxiRides.delete(client); worldPushTaxi(client); } break;
        case 'taxiride': if (act.a === 'stop') worldEndTaxi(client, false); break;
    }
    w.promptKey = '\u0000';                       // force the next prompt (even "none") to be sent
}

// ===================== JOBS, SHOPS, HOTELS, FUEL, TAXIS ======================================================
// ---- employment: ranks, perks, per-company conditions ----------------------------------------------------------
const WORLD_RANKS = ['Trainee', 'Junior', 'Senior', 'Lead', 'Manager'];
const WORLD_RANK_TASKS = 8;                                   // tasks per promotion
const WORLD_PERKS = {
    bonus: '15% chance of a double-pay task', tips: 'Tips: up to +40% on each task', meal: 'Free meal: each task restores 25% health',
    hazard: 'Hazard pay +30% (each task costs a little health)', flex: 'Flexible hours: twice as long before you are fired', fuel: 'Fuel card: +8 L in your car per task'
};
const COMPANY_LEVEL_XP = [0, 20, 60, 150, 350, 800];       // xp needed for levels 1..6; each level: +6% pay and 2 more branch offices
function worldRank(w) { return Math.min(WORLD_RANKS.length - 1, Math.floor((w.jobTasks || 0) / WORLD_RANK_TASKS)); }
function worldFireMs(co) { return (co ? co.strict : 15) * 60000 * (co && co.perk === 'flex' ? 2 : 1); }
function worldCoLevel(co) { return companyState.get(co.id)?.level || 1; }
function worldCityMul(pos) { return ((pos && worldCityAt(pos.x, pos.y)) || null); }
// One completed unit of work of any kind: pays, applies perks, counts towards promotion and the company's expansion.
function worldCompleteWork(client, co, basePay, what, xpGain = 1) {
    const w = client.world, p = client.player, rankBefore = worldRank(w);
    let pay = basePay * (1 + 0.15 * rankBefore) * (1 + 0.06 * (worldCoLevel(co) - 1)), extra = '';
    if (co.perk === 'bonus' && Math.random() < 0.15) { pay *= 2; extra = ' · double-pay bonus!'; }
    if (co.perk === 'tips') { const t = Math.random() * 0.4; pay *= 1 + t; if (t > 0.05) extra = ` · tips +${Math.round(t * 100)}%`; }
    if (co.perk === 'hazard') { pay *= 1.3; if (p) p.hp = Math.max(1, p.hp - p.getEffectiveMaxHp() * 0.06); }
    if (co.perk === 'meal' && p) p.hp = Math.min(p.getEffectiveMaxHp(), p.hp + p.getEffectiveMaxHp() * 0.25);
    if (co.perk === 'fuel' && w.car) w.fuel = Math.min(100, (w.fuel ?? 100) + 8);
    pay = Math.max(1, Math.round(pay));
    w.sessionCoins += pay; w.jobLast = w.playMs; w.jobTasks = (w.jobTasks || 0) + 1;
    worldNotice(client, `${what}: +${pay} coins (unbanked)${extra}`, { level: 'good', sessionCoins: w.sessionCoins });
    const rank = worldRank(w);
    if (rank > rankBefore) worldNotice(client, `Promoted to ${WORLD_RANKS[rank]} ${co.role} at ${co.name}! Pay +${rank * 15}%.`, { level: 'good' });
    worldCompanyXp(co, xpGain);
    worldPushState(client); worldSave(client);
}

// ---- company expansion: shared progress of every player's work; growing companies open branch offices -------------
const companyState = new Map();                            // id -> { xp, level }
function worldLoadCompanies() {
    db.prepare('CREATE TABLE IF NOT EXISTS world_companies (id TEXT PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1)').run();
    companyState.clear();
    for (const r of db.prepare('SELECT * FROM world_companies').all()) companyState.set(r.id, { xp: r.xp, level: r.level });
    for (const co of W_COMPANIES) if (!companyState.has(co.id)) companyState.set(co.id, { xp: 0, level: 1 });
    worldAssignBranches();
}
function worldCompanyXp(co, n) {
    const st = companyState.get(co.id); st.xp += n;
    let lv = 1; while (lv < COMPANY_LEVEL_XP.length && st.xp >= COMPANY_LEVEL_XP[lv]) lv++;
    db.prepare('INSERT INTO world_companies(id,xp,level) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET xp=excluded.xp, level=excluded.level').run(co.id, st.xp, lv);
    if (lv > st.level) {
        st.level = lv; worldAssignBranches();
        const list = [...WL.branch];
        for (const c of worldClients) { sendWorld(c, 'world_branches', { list }); worldNotice(c, `📈 ${co.name} expanded to level ${lv}: pay +${(lv - 1) * 6}% and ${(lv - 1) * 2} branch offices around the world.`, { level: 'good' }); }
    }
}
// Deterministic: each company has its own ordering of suitable buildings; the first (level-1)*2 free ones become branches.
function worldAssignBranches() {
    if (!WL) return;
    WL.branch = new Map(); WL.mapJ = null;
    const okKinds = { desk: ['tower', 'mid', 'apt'], courier: ['mid', 'apt', 'shop'], taxi: ['mid', 'apt', 'tower'], guide: ['old'], farm: ['barn'] };
    W_COMPANIES.forEach((co, ci) => {
        const n = (worldCoLevel(co) - 1) * 2; if (!n) return;
        const style = id => (W_CITIES.find(c => c.id === id) || {}).style;
        const cand = WL.buildings.filter(b => !b.work && !b.shop && !b.hid && (okKinds[co.kind] || okKinds.desk).includes(b.k) && co.styles.includes(style(b.city)));
        cand.sort((a, b) => wHash(WSEED, a.id, ci + 1) - wHash(WSEED, b.id, ci + 1));
        let k = 0; for (const b of cand) { if (k >= n) break; if (WL.branch.has(b.id)) continue; WL.branch.set(b.id, co.id); k++; }
    });
}
function worldWorkOf(b) { return b.work || (WL.branch && WL.branch.get(b.id)) || null; }

// ---- gigs: courier runs, taxi fares, guided tours (point-to-point missions in the open world) ------------------
function worldDoorsNear(x, y, rmin, rmax, filter) {
    const out = [];
    for (const b of WL.buildings) { if (!filter(b)) continue; const d = Math.hypot(wrapDx(b.door.x - x), b.door.y - y); if (d >= rmin && d <= rmax) out.push(b); }
    return out;
}
function worldGigLabel(b) { const c = W_CITIES.find(q => q.id === b.city); return (b.sn || b.nm || b.sign || ({ house: 'a house', old: 'a townhouse', apt: 'an apartment block', farmhouse: 'a farmhouse', mid: 'an office block', tower: 'a tower', terminal: 'the airport' }[b.k]) || 'an address') + (c ? ' (' + c.name + ')' : ''); }
function worldStartGig(client) {
    const w = client.world, p = client.player, co = worldEmployer(w);
    if (!w || !p || w.scene !== 'ext') { worldNotice(client, 'Go outside to take a job.'); return; }
    if (!co || !['courier', 'taxi', 'guide'].includes(co.kind)) { worldNotice(client, 'Your job has no gigs – work at your desk instead.'); return; }
    if (w.mission) { worldNotice(client, 'Finish (or cancel) your current job first.'); return; }
    const city = worldCityAt(p.x, p.y), mul = city ? city.wageMul : 0.8, now = Date.now(), pick = a => a[Math.floor(Math.random() * a.length)];
    let m = null;
    if (co.kind === 'courier') {
        const depots = WL.buildings.filter(b => worldWorkOf(b) === co.id).sort((a, b) => Math.hypot(a.door.x - p.x, a.door.y - p.y) - Math.hypot(b.door.x - p.x, b.door.y - p.y));
        const depot = depots[0]; if (!depot) return;
        const drops = worldDoorsNear(depot.door.x, depot.door.y, 1500, 9000, b => ['house', 'shop', 'old', 'apt', 'mid', 'farmhouse'].includes(b.k));
        const drop = drops.length ? pick(drops) : null; if (!drop) { worldNotice(client, 'No deliveries right now.'); return; }
        const d = Math.hypot(depot.door.x - p.x, depot.door.y - p.y) + Math.hypot(drop.door.x - depot.door.x, drop.door.y - depot.door.y);
        m = { kind: 'courier', title: `Deliver a parcel for ${co.name}`, stops: [{ ...worldOutsideDoor(depot), label: 'Pick up at ' + co.name }, { ...worldOutsideDoor(drop), label: 'Deliver to ' + worldGigLabel(drop) }], pay: co.pay * mul * (0.8 + d / 3000), deadline: now + (75 + d / 110) * 1000 };
    } else if (co.kind === 'taxi') {
        if (!p.vehicle) { worldNotice(client, 'Get in your car first – CityCab drivers use their own car.'); return; }
        const js = worldChunkList(p.x, p.y, 2, 'junctions').filter(j => { const d = Math.hypot(j.x - p.x, j.y - p.y); return d > 700 && d < 3400; });
        if (!js.length) { worldNotice(client, 'No fares around here – drive into town.'); return; }
        const j = pick(js), pu = { x: j.x + 150, y: j.y + j.hh + 34 };
        const drops = worldDoorsNear(pu.x, pu.y, 2500, 12000, b => ['house', 'shop', 'old', 'hotel', 'inn', 'megamall', 'mall', 'tower', 'terminal'].includes(b.k));
        const drop = drops.length ? pick(drops) : null; if (!drop) return;
        const d = Math.hypot(drop.door.x - pu.x, drop.door.y - pu.y);
        m = { kind: 'taxi', title: 'CityCab fare', stops: [{ ...pu, label: 'Pick up the passenger', car: 1, pax: 1 }, { ...worldOutsideDoor(drop, 90), label: 'Drop off at ' + worldGigLabel(drop), car: 1 }], pay: co.pay * mul * (0.6 + d / 2500), deadline: now + (90 + d / 220) * 1000 };
    } else if (co.kind === 'guide') {
        const sights = WL.buildings.filter(b => (b.attr || b.k === 'cathedral' || b.k === 'hall') && Math.hypot(b.door.x - p.x, b.door.y - p.y) < 9000);
        if (sights.length < 2) { worldNotice(client, 'Tours run in the old town – head to Highmoor.'); return; }
        sights.sort(() => Math.random() - 0.5);
        const stops = sights.slice(0, 3).map(b => ({ ...worldOutsideDoor(b, 70), label: 'Show the group ' + (b.nm || b.sign || 'the gallery') }));
        let d = 0, q = p; for (const s of stops) { d += Math.hypot(s.x - q.x, s.y - q.y); q = s; }
        m = { kind: 'guide', title: 'Guided tour', stops, pay: co.pay * mul * (1.2 + d / 4000), deadline: now + (90 + d / 90) * 1000, group: 1 };
    }
    if (!m) return;
    m.co = co.id; m.i = 0; m.pay = Math.round(m.pay);
    w.mission = m;
    worldNotice(client, `${m.title}: ${m.stops[0].label}. Pays ~${m.pay}.`);
    worldPushMission(client);
}
function worldPushMission(client) {
    const m = client.world?.mission;
    sendWorld(client, 'world_mission', { m: m ? { kind: m.kind, title: m.title, i: m.i, n: m.stops.length, label: m.stops[m.i].label, x: Math.round(m.stops[m.i].x), y: Math.round(m.stops[m.i].y), pay: m.pay, left: Math.max(0, m.deadline - Date.now()), pax: m.kind === 'taxi' && m.i === 0 ? 1 : 0, rider: m.kind === 'taxi' && m.i > 0 ? 1 : 0, group: m.group || 0 } : null });
}
function worldMissionTick(client) {
    const w = client.world, p = client.player, m = w.mission; if (!m || !p) return;
    if (Date.now() > m.deadline) { w.mission = null; worldNotice(client, `Too slow – the ${m.kind === 'taxi' ? 'passenger got another cab' : m.kind === 'guide' ? 'tour group wandered off' : 'parcel was re-assigned'}.`, { level: 'bad' }); worldPushMission(client); return; }
    if (w.scene !== 'ext') return;
    const s = m.stops[m.i], d = Math.hypot(wrapDx(s.x - p.x), s.y - p.y);
    if (s.car && !(p.vehicle && Math.abs(p.vehicle.v) < 2.6)) { if (d < 160 && !p.vehicle) worldNoticeOnce(client, 'gigcar', 'Do this in your car.'); return; }
    if (d > (s.car ? 170 : 130)) return;
    m.i++;
    if (m.i >= m.stops.length) {
        const co = W_COMPANIES.find(c => c.id === m.co); w.mission = null; worldPushMission(client);
        if (co && worldEmployer(w) === co) worldCompleteWork(client, co, m.pay, { courier: 'Parcel delivered', taxi: 'Fare complete', guide: 'Tour finished' }[m.kind], 2);
        return;
    }
    worldNotice(client, m.kind === 'taxi' && m.i === 1 ? 'Passenger on board – ' + m.stops[1].label : m.stops[m.i].label);
    worldPushMission(client);
}
function worldNoticeOnce(client, key, msg) { const w = client.world; w._once = w._once || {}; if (Date.now() - (w._once[key] || 0) > 6000) { w._once[key] = Date.now(); worldNotice(client, msg); } }
// Farm hands: harvesting crops (shapes in fields) pays per crop; every 5 counts as a task.
function worldFarmHarvest(owner, e) {
    const w = owner.world, co = worldEmployer(w); if (!co || co.kind !== 'farm') return;
    const f = WL.fieldById.get(e.fieldId), city = f && worldCityAt(f.x, f.y), mul = city ? city.wageMul : 0.6;
    const val = { square: 1, triangle: 2, pentagon: 5, hexagon: 12 }[e.type] || 1;
    const pay = Math.max(1, Math.round(co.pay * val * mul * (1 + 0.15 * worldRank(w))));
    w.sessionCoins += pay; w.harvest = (w.harvest || 0) + 1;
    sendWorld(owner, 'world_notice', { message: `Harvest +${pay}`, sessionCoins: w.sessionCoins });
    if (w.harvest % 5 === 0) worldCompleteWork(owner, co, 0, 'Harvest quota', 1);
}

// ---- shops, stalls, attractions ---------------------------------------------------------------------------------
function worldItemPrice(it, city) { return Math.max(1, Math.round(it.price * (city ? city.priceMul : 1))); }
const WORLD_PU_NAMES = { fov: '🔭 wider view', forceField: '🛡 shield', reload: '⚡ faster reload', damage: '💥 +50% damage', healthRegen: '❤ health regen', bulletSpeed: '🎯 faster shots', movementSpeed: '+50% speed' };
const W_FOOD_SHOPS = new Set(['cafe', 'bakery', 'noodle', 'grocery', 'general', 'sushi', 'pizza', 'burger', 'tacos', 'bubbletea', 'icecream', 'donut', 'deli', 'candy', 'food', 'farm']);
function worldLocalHour(tz) { return ((6 + (Date.now() % WORLD_DAY_MS) / WORLD_DAY_MS * 24 + tz) % 24 + 24) % 24; }
// Opening hours follow the local culture: Central never sleeps, the Sunward Coast closes for siesta, farm towns shut early.
function worldShopClosed(city, where) {
    const cu = city && W_CULTURES[city.culture]; if (!cu || where === 'airport' || where === 'casino') return null;
    let open = cu.open, close = cu.close; if (city.style === 'rural') close = Math.min(close, 19);
    if (where === 'mall' && city.culture !== 'central') { open = Math.max(open, 9); close = Math.min(close, 23); }
    const h = worldLocalHour(city.tz), hh = v => String(v).padStart(2, '0') + ':00';
    if (!(open === 0 && close === 24) && (h < open || h >= close)) return `Closed · opens ${hh(open)} local time`;
    if (cu.siesta && where !== 'mall' && h >= cu.siesta[0] && h < cu.siesta[1]) return `Closed for siesta · back at ${hh(cu.siesta[1])}`;
    return null;
}
function worldCultureItems(kind, items, city) { const cu = city && W_CULTURES[city.culture]; return cu && W_FOOD_SHOPS.has(kind) ? items.concat(cu.spec) : items; }
function worldShopPrompt(client, kind, items, city, where) {          // greeting line + actions (or the closed sign)
    const cu = city && W_CULTURES[city.culture], closed = worldShopClosed(city, where);
    return { greet: cu ? `${cu.greet} · ${cu.name}` : '', actions: closed ? [{ a: 'closed', label: '🔒 ' + closed, on: false }] : worldShopActions(client, worldCultureItems(kind, items, city), city) };
}
function worldShopActions(client, items, city) {
    const w = client.world, money = Math.floor(w.sessionCoins || 0) + (w.bankCoins || 0);
    return items.map(id => {
        const it = WORLD_ITEMS[id], price = worldItemPrice(it, city);
        if (it.souvenir) { const have = city && w.souv.has(city.id); return { a: 'buy:' + id, label: have ? `${city ? city.name : ''} souvenir (collected)` : `🎁 ${city ? city.name : ''} souvenir · ${price}`, on: !!city && !have && money >= price }; }
        return { a: 'buy:' + id, label: `${it.ic ? it.ic + ' ' : ''}${it.name} · ${price}`, on: money >= price };
    });
}
function worldBuyItem(client, id, city) {
    const w = client.world, p = client.player, it = WORLD_ITEMS[id]; if (!it || !p) return;
    if (it.souvenir && (!city || w.souv.has(city.id))) return;
    if (it.fuel && !w.car) { worldNotice(client, 'You have no car to put fuel in.'); return; }
    const price = worldItemPrice(it, city);
    if (!worldPayToll(client, price)) { worldNotice(client, `That costs ${price} coins.`, { level: 'bad' }); return; }
    const max = p.getEffectiveMaxHp(), msg = [];
    if (it.heal) { p.hp = Math.min(max, p.hp + max * it.heal / 100); msg.push(`+${it.heal}% health`); }
    if (it.speed) { p.worldSpeedUntil = Math.max(Date.now(), p.worldSpeedUntil || 0) + it.speed * 1000; msg.push(`+25% speed for ${it.speed}s`); }
    if (it.fuel) { w.fuel = Math.min(100, (w.fuel ?? 100) + it.fuel); msg.push(`+${it.fuel} L in your car (${Math.round(w.fuel)}%)`); }
    if (it.xp) { p.addXP(it.xp); msg.push(`+${it.xp} score`); }
    if (it.pu) { const [t, secs] = it.pu; p.powerups[t] = Math.max(Date.now(), p.powerups[t] || 0) + secs * 1000; msg.push(`${WORLD_PU_NAMES[t] || t} for ${secs >= 120 ? Math.round(secs / 60) + ' min' : secs + 's'}`); }
    if (it.souvenir) {
        w.souv.add(city.id); msg.push(`souvenir ${w.souv.size}/${W_CITIES.length}`);
        if (w.souv.size === W_CITIES.length && !w.souvDone) { w.souvDone = true; db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(2500, client.dbId); worldPushProfile(client); worldNotice(client, '🏆 World traveller! You collected a souvenir from every city: +2,500 coins in the bank.', { level: 'good' }); }
    }
    worldNotice(client, `Bought ${it.souvenir ? city.name + ' souvenir' : it.name} (-${price})${msg.length ? ': ' + msg.join(', ') : ''}`, { level: 'good' });
    worldPushState(client); worldSave(client);
}
function worldVisit(client, b) {
    const w = client.world, p = client.player, city = W_CITIES.find(c => c.id === b.city), price = worldItemPrice({ price: b.k === 'cathedral' ? 4 : 9 }, city);
    w.visited = w.visited || new Map();
    if (Date.now() - (w.visited.get(b.id) || 0) < 10 * 60000) { worldNotice(client, 'You visited here recently – come back later.'); return; }
    if (!worldPayToll(client, price)) { worldNotice(client, `Tickets cost ${price}.`, { level: 'bad' }); return; }
    w.visited.set(b.id, Date.now());
    const xp = 200 + 30 * (p.level || 1); p.addXP(xp);
    worldNotice(client, b.k === 'cathedral' ? `You admire the vaulted ceiling and stained glass: +${xp} score.` : `You tour the exhibition: +${xp} score.`, { level: 'good' });
}

// ---- hotels, inns, motels -----------------------------------------------------------------------------------------
const STAY_MS = 30 * 60 * 1000;
function worldStayPrice(b) { const city = W_CITIES.find(c => c.id === b.city); return Math.round((b.k === 'hotel' ? (b.stars >= 5 ? 150 : 110) : b.k === 'inn' ? 55 : 35) * (city ? city.priceMul : 1)); }
function worldStayValid(w) { return w.stay && w.stay.until > Date.now() && WL.buildingById.has(w.stay.bid); }
function worldBookStay(client, b) {
    const w = client.world, price = worldStayPrice(b);
    if (!worldPayToll(client, price)) { worldNotice(client, `A room costs ${price} coins.`, { level: 'bad' }); return; }
    w.stay = { bid: b.id, until: Date.now() + STAY_MS };
    worldNotice(client, `Room booked at ${b.nm || 'the ' + b.k} for 30 minutes. Until it runs out you'll wake up here when you log in or respawn, even if you own a house.`, { level: 'good' });
    worldSave(client); worldPushState(client);
    const def = worldInteriorDef('stay:' + b.id); worldGoto(client, 'stay:' + b.id, def.spawn.x, def.spawn.y);
}

// ---- the phone ---------------------------------------------------------------------------------------------------
// Book flights and hotels from anywhere, see your trip, message other players. Everything the phone can do is also
// possible in person; the phone just saves the walk.
function worldWhere(client) { const w = client.world, p = client.player; return w.scene === 'ext' && p ? { x: p.x, y: p.y } : (w.ext || WL.spawn); }
function worldPhoneTrip(client) {
    const it = client.world.itin, ok = it && it.until > Date.now();
    sendWorld(client, 'phone', { act: 'trip', trip: ok ? { cls: it.cls, i: it.i, left: it.until - Date.now(), legs: it.legs.map(l => ({ fn: l.fn, al: l.al, alName: AIRLINES[l.al].name, ac: AIRCRAFT[l.ac].name, from: WL.airportByCity.get(l.from).code, to: WL.airportByCity.get(l.to).code, fromName: W_CITIES.find(c => c.id === l.from).name, toName: W_CITIES.find(c => c.id === l.to).name })) } : null });
}
function worldPhone(client, d) {
    const w = client.world, p = client.player; if (!w || !p || !WL) return;
    const now = Date.now(); if (now - (w.phoneT || 0) < 150) return; w.phoneT = now;
    const at = worldWhere(client);
    switch (String(d.act || '')) {
        case 'flights': {
            let A = d.from && WL.airportByCity.get(String(d.from));
            if (!A) { let bd = Infinity; for (const a of WL.airports) { const dd = Math.hypot(wrapDx(a.door.x - at.x), a.door.y - at.y); if (dd < bd) { bd = dd; A = a; } } }
            sendWorld(client, 'phone', { act: 'flights', from: A.city, fromCode: A.code, fromName: A.name, list: airItinActions(client, A), airports: WL.airports.map(a => ({ city: a.city, code: a.code })) });
            break;
        }
        case 'buy': { const A = WL.airportByCity.get(String(d.from)); if (A && worldBuyItin(client, A, String(d.key), d.cls === 'J' ? 'J' : 'Y', true)) worldPhoneTrip(client); break; }
        case 'trip': worldPhoneTrip(client); break;
        case 'hotels': {
            const list = WL.buildings.filter(b => b.k === 'hotel' || b.k === 'inn' || b.k === 'motel').map(b => ({ b, d: Math.hypot(wrapDx(b.door.x - at.x), b.door.y - at.y) })).sort((a, b) => a.d - b.d).slice(0, 10);
            sendWorld(client, 'phone', { act: 'hotels', list: list.map(({ b, d }) => ({ bid: b.id, name: b.nm || (b.k === 'inn' ? 'Inn' : b.k === 'motel' ? 'Motel' : 'Hotel'), k: b.k, stars: b.stars || 0, price: worldStayPrice(b), km: Math.round(d / 100) / 10, x: Math.round(b.door.x), y: Math.round(b.door.y), city: (W_CITIES.find(c => c.id === b.city) || {}).name || 'Roadside' })), stay: worldStayValid(w) ? w.stay.bid : 0 });
            break;
        }
        case 'book': {
            const b = WL.buildingById.get(Number(d.bid)); if (!b || !['hotel', 'inn', 'motel'].includes(b.k)) return;
            const price = worldStayPrice(b); if (!worldPayToll(client, price)) { worldNotice(client, `A room there costs ${price} coins.`, { level: 'bad' }); return; }
            w.stay = { bid: b.id, until: Date.now() + STAY_MS }; worldSave(client); worldPushState(client);
            worldNotice(client, `🏨 Booked ${b.nm || 'a room'} for 30 minutes (-${price}). Until it runs out you'll wake up there. Tap "Navigate" to get directions.`, { level: 'good' });
            break;
        }
        case 'players': {
            const list = [...worldRoom.clients, ...Object.values(interiorRooms).flatMap(r => r.clients || [])].filter(c => c.world && c.player).map(c => { const q = worldWhere(c), city = worldCityAt(wrapX(q.x), q.y); return { name: c.player.name, city: city ? city.name : 'On the road', me: c === client ? 1 : 0 }; });
            sendWorld(client, 'phone', { act: 'players', list });
            break;
        }
        case 'dm': {
            const to = String(d.to || '').slice(0, 40), text = String(d.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200); if (!to || !text) return;
            if (now - (w.dmT || 0) < 1500) { worldNotice(client, 'Slow down a little.'); return; } w.dmT = now;
            const all = [...worldRoom.clients, ...Object.values(interiorRooms).flatMap(r => r.clients || [])], tgt = all.filter(c => c.player && c.player.name === to && c !== client);
            if (!tgt.length) { sendWorld(client, 'phone', { act: 'msg', from: 'System', to: p.name, text: `${to} isn't online.`, t: now }); return; }
            for (const c of tgt) sendWorld(c, 'phone', { act: 'msg', from: p.name, to, text, t: now });
            sendWorld(client, 'phone', { act: 'msg', from: p.name, to, text, t: now, mine: 1 });
            break;
        }
    }
}

// ---- fuel -----------------------------------------------------------------------------------------------------
const FUEL_RATE = { compact: 0.00016, sedan: 0.0002, sport: 0.00028 };      // litres per world unit driven
function worldFuelPrice(pos) { const c = worldCityAt(pos.x, pos.y); return 1.2 * (c ? c.priceMul : 1); }
function worldRefuel(client) {
    const w = client.world, p = client.player, need = Math.max(0, 100 - (w.fuel ?? 100)); if (need < 0.5) return;
    const per = worldFuelPrice(p), cash = Math.floor(w.sessionCoins || 0) + worldBankCoins(client);
    const litres = Math.min(need, Math.floor(cash / per)); if (litres < 1) { worldNotice(client, 'Not enough money for fuel.', { level: 'bad' }); return; }
    const cost = Math.max(1, Math.round(litres * per));
    if (!worldPayToll(client, cost)) return;
    w.fuel = Math.min(100, (w.fuel ?? 100) + litres);
    worldNotice(client, `Refuelled ${Math.round(litres)} L for ${cost} coins. Tank ${Math.round(w.fuel)}%.`, { level: 'good' });
    worldPushState(client); worldSave(client);
}

// ---- taxi hailing: an NPC cab drives to you along the roads, then drives you to your destination --------------------
const taxiRides = new Map();                               // client -> ride
let taxiSeq = 1;
function worldTaxiFare(ride) { return Math.max(5, Math.round((12 + ride.dist * 0.0025) * ride.mul)); }
// The cab keeps to the road: it stops at the kerb nearest the target (the last leg of a route is the walk to the door).
function worldTaxiPath(from, to) {
    const r = worldRoute(from, to); if (!r || r.pts.length < 2) return [[from.x, from.y], [to.x, to.y]];
    const pts = r.pts.map(q => [q[0], q[1]]); if (pts.length > 2) pts.pop();
    return pts;
}
function worldHailTaxi(client, tgt) {
    const w = client.world, p = client.player;
    if (!w || !p || w.scene !== 'ext' || p.vehicle || p.flight || p.taxiRide) { worldNotice(client, 'You can only hail a taxi on foot, outside.'); return; }
    if (!tgt) { worldNotice(client, 'Pick a destination for the taxi first.'); return; }
    taxiRides.delete(client);
    const js = worldChunkList(p.x, p.y, 2, 'junctions').filter(j => { const d = Math.hypot(j.x - p.x, j.y - p.y); return d > 600 && d < 2600; });
    const j = js.length ? js[Math.floor(Math.random() * js.length)] : { x: p.x + 500, y: p.y };
    const pts = worldTaxiPath({ x: j.x, y: j.y }, { x: p.x, y: p.y });
    const city = worldCityAt(p.x, p.y);
    const ride = { client, id: taxiSeq++, phase: 'coming', pts, i: 0, x: pts[0][0], y: pts[0][1], a: 0, v: 0, dest: tgt, dist: 0, mul: city ? city.priceMul : 1, t0: Date.now() };
    taxiRides.set(client, ride);
    worldNotice(client, `🚕 Taxi hailed to ${tgt.label}. It's on its way – wait nearby.`);
    worldPushTaxi(client);
}
// Moves a ride along its polyline; returns true at the end of the path.
function worldTaxiAdvance(r, step) {
    let left = step;
    while (left > 0 && r.i < r.pts.length - 1) {
        const a = r.pts[r.i], b = r.pts[r.i + 1], dx = b[0] - r.x, dy = b[1] - r.y, d = Math.hypot(dx, dy);
        if (d < 0.5) { r.i++; continue; }
        r.a = flTurn(r.a, Math.atan2(dy, dx), 0.35);
        const m = Math.min(left, d); r.x += dx / d * m; r.y += dy / d * m; left -= m; if (r.phase === 'riding') r.dist += m;
        if (m >= d) r.i++;
    }
    r.v = step / 3;
    return r.i >= r.pts.length - 1;
}
function worldTaxiStep() {                                  // 20 Hz
    for (const [client, r] of taxiRides) {
        const p = client.player, w = client.world;
        if (!p || !w || !worldClients.has(client)) { taxiRides.delete(client); continue; }
        if (r.phase === 'coming') {
            if (worldTaxiAdvance(r, 9 * 3 * (worldOnHighway(r.x, r.y) ? 2.5 : 1))) { r.phase = 'waiting'; r.waitUntil = Date.now() + 75000; worldNotice(client, '🚕 Your taxi is here – walk up to it and press F.'); worldPushTaxi(client); }
        } else if (r.phase === 'waiting') {
            if (Date.now() > r.waitUntil || w.scene !== 'ext' || Math.hypot(r.x - p.x, r.y - p.y) > 3000) { taxiRides.delete(client); worldNotice(client, 'The taxi gave up waiting and left.', { level: 'bad' }); worldPushTaxi(client); }
        }
        if (worldTickN % 10 === 0) worldPushTaxi(client);
    }
}
function worldBoardTaxi(client) {
    const r = taxiRides.get(client), p = client.player; if (!r || r.phase !== 'waiting' || !p) return;
    r.phase = 'riding'; r.pts = worldTaxiPath({ x: r.x, y: r.y }, r.dest); r.i = 0; r.dist = 0;
    p.taxiRide = r; p.ghost = true; p.x = r.x; p.y = r.y; p.vx = p.vy = 0;
    p.inputs = { up: false, down: false, left: false, right: false, shooting: false, angle: p.inputs?.angle || 0, repel: false };
    worldNotice(client, `🚕 "${r.dest.label}? Sure thing." The meter is running.`);
    worldPushTaxi(client);
}
function worldStepTaxiRide(e) {                             // 60 Hz while riding
    const r = e.taxiRide, done = worldTaxiAdvance(r, 9 * (worldOnHighway(r.x, r.y) ? 2.5 : 1));
    e.x = r.x; e.y = r.y; e.vx = e.vy = 0;
    if (done) worldEndTaxi(r.client, true);
}
function worldEndTaxi(client, arrived) {
    const r = taxiRides.get(client), p = client.player; if (!r) return;
    taxiRides.delete(client);
    if (p && p.taxiRide) {
        p.taxiRide = null; p.ghost = false;
        const side = { x: r.x - Math.sin(r.a) * 50, y: r.y + Math.cos(r.a) * 50 }; layoutPushOut(WL, side, p.radius + 2); p.x = side.x; p.y = side.y;
        client.world.ext = { x: p.x, y: p.y };
        const fare = worldTaxiFare(r);
        if (worldPayToll(client, fare)) worldNotice(client, `🚕 ${arrived ? 'Arrived at ' + r.dest.label : 'Dropped off'}. Fare: ${fare} coins.`, { level: 'good' });
        else worldNotice(client, `🚕 You couldn't pay the ${fare}-coin fare. The driver sighs and lets it go this time.`, { level: 'warn' });
        worldSave(client);
    }
    worldPushTaxi(client);
}
function worldPushTaxi(client) {
    const r = taxiRides.get(client);
    sendWorld(client, 'world_taxi', { r: r ? { phase: r.phase, label: r.dest.label, fare: worldTaxiFare(r), x: Math.round(r.x), y: Math.round(r.y), eta: r.phase === 'coming' ? Math.round(worldTaxiRemaining(r) / (27 * 20)) : r.phase === 'riding' ? Math.round(worldTaxiRemaining(r) / (9 * 60)) : 0, wait: r.waitUntil ? Math.max(0, Math.round((r.waitUntil - Date.now()) / 1000)) : 0 } : null });
}
function worldTaxiRemaining(r) { let d = 0, q = [r.x, r.y]; for (let i = r.i + 1; i < r.pts.length; i++) { d += Math.hypot(r.pts[i][0] - q[0], r.pts[i][1] - q[1]); q = r.pts[i]; } return d; }

// ---- interiors: multi-level malls ------------------------------------------------------------------------------
// Every level of a mall has a theme: market hall at the entrance, a food court near the top, and in between fashion,
// tech & play, home & lifestyle or gifts. Six-level malls put a casino on the top floor.
const MALL_FLOORS = {
    market:  { name: 'Market Hall',       floor: 'market', shops: ['grocery', 'bakery', 'pharmacy', 'deli', 'icecream', 'donut', 'souvenir', 'hardware'] },
    fashion: { name: 'Fashion Avenue',    floor: 'marble', shops: ['fashion', 'jewelry', 'perfume', 'sports', 'fashion', 'jewelry', 'cafe'] },
    tech:    { name: 'Tech & Play',       floor: 'tech',   shops: ['electronics', 'games', 'toys', 'music', 'electronics', 'cinema', 'bubbletea'] },
    life:    { name: 'Home & Lifestyle',  floor: 'wood',   shops: ['books', 'pets', 'florist', 'music', 'cafe', 'perfume', 'toys'] },
    gifts:   { name: 'Gifts & Souvenirs', floor: 'marble', shops: ['souvenir', 'souvenir', 'candy', 'florist', 'books', 'jewelry', 'cafe'] },
    food:    { name: 'Food Court',        floor: 'food',   shops: ['noodle', 'sushi', 'pizza', 'burger', 'bubbletea', 'tacos', 'icecream', 'cafe'] },
    casino:  { name: 'Casino',            floor: 'casino', shops: [] }
};
const CASINO_NAMES = ['The Golden Ace', 'Lucky Neon', 'Velvet Jackpot', 'Diamond Dunes', 'Royal Flush Club', 'High Roller Lounge'];
function mallFloorTheme(b, lv) {
    const n = b.lv || 3;
    if (lv === 1) return 'market';
    if (n >= 6 && lv === n) return 'casino';
    if (lv === (n >= 6 ? n - 1 : n)) return 'food';
    const mids = ['fashion', 'tech', 'life', 'gifts'];
    return mids[(lv - 2 + (b.id || 0)) % mids.length];
}
function buildMallInterior(b, lv) {
    const X0 = 200, Y0 = 200, W = 1400, H = 1100, fl = { x: X0, y: Y0, w: W, h: H }, doorX = X0 + W / 2, levels = b.lv || 3, ft = mallFloorTheme(b, lv), FT = MALL_FLOORS[ft];
    const D = {
        kind: 'mall', ext: INT_EXT, floor: fl,
        theme: { accent: ft === 'casino' ? '#d4a017' : b.neon ? '#ff2bd6' : '#c9a227', name: (b.nm || 'Mall') + ' · Level ' + lv + ' · ' + (ft === 'casino' ? '🎰 ' + CASINO_NAMES[(b.id || 0) % CASINO_NAMES.length] : FT.name), neon: b.neon ? 1 : 0, ft, floor: FT.floor, alt: +(1 + 0.45 * (lv - 1)).toFixed(2), eh: (lv - 1) * 40 },
        walls: intWallsAround(fl, doorX, lv === 1 ? 160 : 0), furn: [], stations: [], rooms: [{ x: X0, y: Y0, w: W, h: H, c: 'mall' }],
        door: { x: doorX - 80, y: Y0 + H, w: lv === 1 ? 160 : 0, h: INT_WALL, px: doorX, py: Y0 + H - 36, r: lv === 1 ? 120 : 0 },
        spawn: { x: doorX, y: Y0 + H - 110 }, lv, levels, bid: b.id
    };
    if (ft === 'casino') { buildCasinoFloor(D, b); return D; }
    const f = D.furn, cx = X0 + W / 2, cy = Y0 + H / 2 - 40;
    f.push({ k: 'atrium', x: cx - 220, y: cy - 150, w: 440, h: 300, solid: 1 });
    const rng = wRng((b.id * 31 + lv * 7) >>> 0), pool = FT.shops.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    // shop units round the walls: 3 along the top, 2 on each side
    const units = [[X0 + 60, Y0 + 20], [X0 + W / 2 - 150, Y0 + 20], [X0 + W - 360, Y0 + 20], [X0 + 20, Y0 + 300], [X0 + W - 320, Y0 + 300], [X0 + 20, Y0 + 640], [X0 + W - 320, Y0 + 640]];
    units.forEach(([x, y], i) => {
        const kind = pool[i % pool.length], top = y === Y0 + 20, w = 300, h = top ? 130 : 200, sk = SHOP_KINDS[kind];
        f.push({ k: 'kiosk', x, y, w, h, solid: 1, shop: kind, label: sk.name, ic: sk.ic, col: Math.floor(rng() * 6) });
        D.stations.push({ id: 'shop' + i, shop: kind, x: top ? x + w / 2 : (x < cx ? x + w + 40 : x - 40), y: top ? y + h + 40 : y + h / 2, r: 95 });
    });
    if (lv < levels) { f.push({ k: 'escalator', x: cx - 330, y: cy - 60, w: 90, h: 200, dir: 1 }); D.stations.push({ id: 'up', x: cx - 285, y: cy + 160, r: 90 }); }
    if (lv > 1) { f.push({ k: 'escalator', x: cx + 240, y: cy - 60, w: 90, h: 200, dir: -1 }); D.stations.push({ id: 'down', x: cx + 285, y: cy + 160, r: 90 }); }
    for (const x of [cx - 130, cx + 10]) f.push({ k: 'sofa', x, y: cy + 152, w: 120, h: 40, solid: 1 });   // against the atrium railing, out of the walkways
    for (const [x, y] of [[cx - 250, cy - 200], [cx + 250, cy - 200], [cx - 250, cy + 200], [cx + 250, cy + 200]]) f.push({ k: 'plant', x, y, r: 20, solid: 1 });
    return D;
}
// The casino: slot banks on the north wall and by the lifts, blackjack to the west, roulette to the east,
// a round cocktail bar where the atrium would be and a lounge stage. Regulars sit at a few machines and tables.
function buildCasinoFloor(D, b) {
    const fl = D.floor, X0 = fl.x, Y0 = fl.y, W = fl.w, H = fl.h, cx = X0 + W / 2, cy = Y0 + H / 2 - 40, f = D.furn;
    D.casino = 1; D.spawn = { x: X0 + 210, y: Y0 + 950 };
    f.push({ k: 'escalator', x: cx + 240, y: cy - 60, w: 90, h: 200, dir: -1 }); D.stations.push({ id: 'down', x: cx + 285, y: cy + 160, r: 90 });
    intUse(D, intAdd(D, { k: 'elevator', x: X0 + 20, y: Y0 + 880, w: 140, h: 140, solid: 1 }), 'elevator', X0 + 210, Y0 + 950, 80);
    intUse(D, intAdd(D, { k: 'atmi', x: X0 + W - 410, y: Y0 + H - 64, w: 50, h: 50, solid: 1 }), 'atm', X0 + W - 385, Y0 + H - 115, 50);
    const SN = ['Lucky 7s', 'Diamond Rush', 'Neon Nights', 'Fruit Fiesta', 'Golden Bell', 'Star Burst'];
    for (let i = 0; i < 12; i++) {
        const x = X0 + 40 + i * 108, m = intAdd(D, { k: 'slot', x, y: Y0 + 12, w: 64, h: 66, solid: 1, col: i % 6, nm: SN[i % 6] });
        if (i === 2 || i === 5 || i === 9) f.push({ k: 'patron', x: x + 32, y: Y0 + 112, r: 15, solid: 1, col: i, sit: 'slot' });
        else intUse(D, m, 'slots', x + 32, Y0 + 128, 50);
    }
    for (let i = 0; i < 3; i++) { const x = X0 + 250 + i * 80, m = intAdd(D, { k: 'slot', x, y: Y0 + H - 78, w: 64, h: 66, solid: 1, col: (i + 3) % 6, nm: SN[(i + 3) % 6], flip: 1 }); intUse(D, m, 'slots', x + 32, Y0 + H - 128, 46); }
    [Y0 + 220, Y0 + 560].forEach((y, i) => {
        const t = intAdd(D, { k: 'bjtable', x: X0 + 40, y, w: 250, h: 160, solid: 1, n: i + 1 });
        intUse(D, t, 'blackjack', X0 + 340, y + 80, 80);
        f.push({ k: 'patron', x: X0 + 312, y: y + 18, r: 14, solid: 1, col: 7 + i, sit: 'bj' });
    });
    [Y0 + 200, Y0 + 680].forEach((y, i) => {
        const t = intAdd(D, { k: 'roulette', x: X0 + W - 330, y, w: 300, h: 170, solid: 1, n: i + 1 });
        intUse(D, t, 'roulette', X0 + W - 380, y + 85, 80);
        f.push({ k: 'patron', x: X0 + W - 180, y: y + 192, r: 14, solid: 1, col: 9 + i, sit: 'roulette' });
    });
    intAdd(D, { k: 'casinobar', x: cx, y: cy - 20, r: 120, solid: 1 });
    D.stations.push({ id: 'bar', shop: 'bar', x: cx, y: cy + 165, r: 80 });
    for (const a of [-2.4, -0.75]) f.push({ k: 'patron', x: cx + Math.cos(a) * 150, y: cy - 20 + Math.sin(a) * 150, r: 14, solid: 1, col: Math.round(a * 10) & 15, sit: 'bar' });
    intAdd(D, { k: 'stage', x: cx - 180, y: Y0 + H - 130, w: 360, h: 118, solid: 1 });
    for (const [x, y] of [[X0 + 40, Y0 + 830], [X0 + W - 40, Y0 + 830]]) f.push({ k: 'plant', x, y, r: 20, solid: 1 });
    D.theme.chand = [[cx - 330, Y0 + 420], [cx + 330, Y0 + 420], [cx - 330, Y0 + 840], [cx + 330, Y0 + 840], [cx, Y0 + 160]];
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
        ext: saved ? { x: W_CX + saved.x, y: W_CY + saved.y } : { x: WL.spawn.x, y: WL.spawn.y },
        scene: 'ext', sentChunks: new Set(), lastTick: Date.now(), lastSave: Date.now(), bankCoins: 0, task: null, dead: false,
        fuel: saved?.car_fuel ?? 100, jobTasks: saved?.job_tasks || 0, stay: saved?.stay_bid ? { bid: saved.stay_bid, until: saved.stay_until || 0 } : null,
        souv: new Set((() => { try { return JSON.parse(saved?.souv || '[]'); } catch { return []; } })().filter(id => W_CITIES.some(c => c.id === id)))
    };
    client.world.souvDone = client.world.souv.size === W_CITIES.length;
    // a player who left mid-shift while far over their deadline gets the usual grace, never an instant firing
    if (client.world.job) client.world.jobLast = Math.max(client.world.jobLast, client.world.playMs - (worldFireMs(worldEmployer(client.world)) - 2 * 60 * 1000));
    worldClients.add(client);
    worldSendStatic(client);
    const home = worldHomeSpawn(client.dbId), w0 = client.world;
    if (worldStayValid(w0)) { const def = worldInteriorDef('stay:' + w0.stay.bid); worldGoto(client, 'stay:' + w0.stay.bid, def.spawn.x, def.spawn.y); }   // a booked room beats home
    else if (home) worldGoto(client, home.scene, home.def.spawn.x, home.def.spawn.y);
    else if (saved) worldGoto(client, 'ext', client.world.ext.x, client.world.ext.y);
    else worldGoto(client, 'ext', WL.spawn.x + (Math.random() - 0.5) * 60, WL.spawn.y);
    worldRoom.worldKind = 'exterior';
    db.prepare('UPDATE world_houses SET last_seen=? WHERE owner_id=?').run(Date.now(), client.dbId);
}
function worldOnDisconnect(client) {
    const w = client.world; if (!w) return;
    if (client.player?.vehicle) worldExitCar(client, true);
    if (client.player?.taxiRide) worldEndTaxi(client, false); else taxiRides.delete(client);
    worldSave(client); worldClients.delete(client);
    worldDetach(client); client.world = null;
}
function worldHandle(client, d) {
    const w = client.world; if (!w || !client.dbId) return;
    if (d.type === 'world_interact') worldInteract(client, { id: String(d.id), a: String(d.a), cls: d.cls === 'J' ? 'J' : 'Y' });
    else if (d.type === 'world_leave') { worldOnDisconnect(client); }
    else if (d.type === 'world_nav') worldNav(client, String(d.t), d);
    else if (d.type === 'world_inflight') worldInflightOrder(client, String(d.item || ''));
    else if (d.type === 'world_casino') worldCasino(client, d);
    else if (d.type === 'world_phone') worldPhone(client, d);
    else if (d.type === 'world_gig') { if (d.act === 'cancel') { if (w.mission) { w.mission = null; worldNotice(client, 'Job cancelled.'); worldPushMission(client); } } else worldStartGig(client); }
    else if (d.type === 'world_taxi') { if (d.act === 'cancel') { if (client.player?.taxiRide) worldEndTaxi(client, false); else { taxiRides.delete(client); worldPushTaxi(client); } } else worldHailTaxi(client, worldResolveTarget(client, String(d.t || 'pin'), d)); }
    else if (d.type === 'world_map' && WL) sendWorld(client, 'world_map', { p: worldMapPlaces() });
}
// Road graph for the satnav: nodes are junctions, edges join neighbouring junctions on the same road line.
function worldNavGraph() {
    if (WL.navG) return WL.navG;
    const nodes = [], byV = new Map(), byH = new Map(), segs = [];
    for (const j of WL.junctions.concat(WL.xjunctions || [])) {
        const n = { x: j.x, y: j.y, kx: Math.round((j.x - W_CX) / W_S), ky: Math.round((j.y - W_CY) / W_S), adj: [] };
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
function worldMapPlaces() {
    if (WL.mapJ) return WL.mapJ;
    const P = [], names = { bank: 'Central Bank', dealer: 'Car Dealership', hall: 'City Hall', mall: 'Shopping Mall', school: 'School' };
    for (const b of WL.buildings) {
        if (b.work) P.push(['w', b.door.x, b.door.y, b.sign, b.col]);
        else if (names[b.k]) P.push([b.k, b.door.x, b.door.y, names[b.k]]);
    }
    for (const p of WL.props) if (p.k === 'atm') P.push(['a', p.x + 13, p.y + 7, 'ATM']);
    for (const a of WL.airports) P.push(['airport', a.door.x, a.door.y, a.name]);
    for (const [id, co] of WL.branch || []) { const b = WL.buildingById.get(id), c = W_COMPANIES.find(q => q.id === co); if (b && c) P.push(['w', b.door.x, b.door.y, c.name + ' (branch)', c.color]); }
    for (const b of WL.buildings) {
        if (b.k === 'hotel' || b.k === 'inn' || b.k === 'motel') P.push(['hotel', b.door.x, b.door.y, b.nm || 'Hotel']);
        else if (b.fuel) P.push(['fuel', b.door.x, b.door.y, 'Fuel station']);
        else if (b.k === 'megamall') P.push(['megamall', b.door.x, b.door.y, b.nm || 'Mall']);
        else if (b.k === 'cathedral' || b.k === 'gallery') P.push(['attr', b.door.x, b.door.y, b.nm || b.sign || 'Gallery']);
    }
    return (WL.mapJ = P);
}
function worldResolveTarget(client, t, d = {}) {
    const w = client.world, p = client.player; if (!w || !p || !WL) return null;
    let tgt = null;
    const nearestB = (f, label) => { let bd = Infinity; for (const b of WL.buildings) { if (!f(b)) continue; const dd = Math.hypot(wrapDx(b.door.x - p.x), b.door.y - p.y); if (dd < bd) { bd = dd; tgt = { x: b.door.x, y: b.door.y, label: label(b) }; } } };
    if (t === 'mission') { const m = w.mission; if (m) tgt = { x: Math.round(m.stops[m.i].x), y: Math.round(m.stops[m.i].y), label: m.stops[m.i].label }; return tgt; }
    if (t === 'fuel') { nearestB(b => b.fuel, () => 'Fuel station'); return tgt; }
    if (t === 'hotel') { if (worldStayValid(w)) { const b = WL.buildingById.get(w.stay.bid); return { x: b.door.x, y: b.door.y, label: b.nm || 'Your hotel' }; } nearestB(b => b.k === 'hotel' || b.k === 'inn' || b.k === 'motel', b => b.nm || 'Hotel'); return tgt; }
    if (t === 'shop') { nearestB(b => b.shop === 'grocery' || b.shop === 'general', b => b.sn || 'Shop'); return tgt; }
    if (t === 'mall') { nearestB(b => b.k === 'megamall', b => b.nm || 'Mall'); return tgt; }
    if (t === 'work') {
        const co = w.job?.co; let bd = Infinity;
        for (const b of WL.works.concat([...(WL.branch || [])].map(([id]) => WL.buildingById.get(id)))) { if (co && worldWorkOf(b) !== co) continue; const d = Math.hypot(b.door.x - p.x, b.door.y - p.y); if (d < bd) { bd = d; tgt = { x: b.door.x, y: b.door.y, label: b.sign || 'Workplace' }; } }
    } else if (t === 'atm' || t === 'bank' || t === 'dealer') {
        const list = t === 'atm' ? worldMapPlaces().filter(q => q[0] === 'a') : worldMapPlaces().filter(q => q[0] === t); let bd = Infinity;
        for (const q of list) { const dd = Math.hypot(q[1] - p.x, q[2] - p.y); if (dd < bd) { bd = dd; tgt = { x: q[1], y: q[2], label: q[3] }; } }
    } else if (t === 'pin') {
        const x = +d.x, y = +d.y; if (isFinite(x) && isFinite(y)) tgt = { x: Math.round(clamp(wrapX(x), W_LAND.x0, W_LAND.x1)), y: Math.round(clamp(y, W_LAND.y0, W_LAND.y1)), label: String(d.label || 'Destination').slice(0, 40) };
    } else if (t === 'airport') {
        let bd = Infinity;
        for (const a of WL.airports) { const dd = Math.hypot(wrapDx(a.door.x - p.x), a.door.y - p.y); if (dd < bd) { bd = dd; tgt = { x: a.door.x, y: a.door.y, label: a.name }; } }
    } else if (t === 'home') {
        const hid = worldFirstHouse(client.dbId), b = hid && WL.houseById.get(hid); if (b) tgt = { x: b.door.x, y: b.door.y, label: 'Home' };
    } else if (t === 'car') {
        const pc = parkedCars.get(client.dbId); if (pc && !pc.driven) tgt = { x: Math.round(pc.x), y: Math.round(pc.y), label: 'Your car' };
    }
    return tgt;
}
function worldNav(client, t, d = {}) {
    const w = client.world, p = client.player; if (!w || !p || !WL || w.scene !== 'ext') return;
    const tgt = worldResolveTarget(client, t, d);
    sendWorld(client, 'world_nav', { t, tgt, route: tgt ? worldRoute({ x: p.x, y: p.y }, tgt) : null });
}
function worldOnPlayerDeath(owner, e) {
    const w = owner.world; if (!w || w.dead) return;
    w.dead = true; w.task = null; w.sessionCoins = 0; w.buff = null;
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
        const p = c.player; if (!p || p.flight || c.world?.scene !== 'ext') continue;
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
        if (!active.has(e.fieldId) && now - (fieldLastActive.get(e.fieldId) || 0) > 25000) { e.culled = true; e.markedForDeletion = true; e.hp = 0; e.xpAwarded = true; e.noReward = true; continue; }
        const nx = clamp(e.x, f.x + 14, f.x + f.w - 14), ny = clamp(e.y, f.y + 14, f.y + f.h - 14);
        if (nx !== e.x || ny !== e.y) { e.x = nx; e.y = ny; e.vx = 0; e.vy = 0; }
    }
}

// ---- NPC traffic and pedestrians --------------------------------------------------------------------
function worldChunkList(x, y, R, name) {
    const NX = Math.round(W_CIRC / W_CHUNK), cx = Math.floor(wrapX(x) / W_CHUNK) % NX, cy = clamp(Math.floor(y / W_CHUNK), 0, W_NCH - 1), out = [];
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) { const ch = WL.chunks.get(((cx + dx) % NX + NX) % NX + (cy + dy) * W_NCH); if (ch) for (const o of ch[name]) out.push(o); }
    return out;
}
function worldAssignRoad(car, road, dir, fromS) {
    car.road = road; car.dir = dir;
    const hv = road.hw, lane = road.ln === 4 ? (Math.random() < 0.5 ? 0.3 : 0.72) : 0.5; car.off = hv * lane;
    const rx = road.a === 'v' ? road.p : fromS, cu = W_CULTURES[W_CULTURE_COL((rx - (W_CX - W_GAP)) / W_GAP)];
    if (cu && cu.lht) car.off = -car.off;                                       // the Kaimana Isles drive on the left
    const nodes = roadNodes.get(road); let next = null;
    if (!nodes) return false;
    if (dir > 0) { for (let i = 0; i < nodes.length; i++) if (nodes[i] > fromS + 8) { next = nodes[i]; break; } }
    else for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i] < fromS - 8) { next = nodes[i]; break; }
    car.nextS = next;
    if (next == null) return false;
    // plan the manoeuvre at the next junction now, so the car can slow for a turn
    const jx = road.a === 'v' ? road.gk : Math.round((next - W_CX) / W_S), jy = road.a === 'v' ? Math.round((next - W_CY) / W_S) : road.gk;
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
    const p = client.player; if (!p || p.flight) return;
    const zone = worldZone(p.x, p.y), want = [18, 14, 8, 3][zone];
    let near = 0; for (const t of traffic) if (Math.abs(t.x - p.x) < 2800 && Math.abs(t.y - p.y) < 2800) near++;
    if (near >= want || traffic.length >= 110) return;
    const cands = worldChunkList(p.x, p.y, 2, 'junctions').filter(j => { const d = Math.hypot(j.x - p.x, j.y - p.y); return d > 1500 && d < 2900; });
    if (!cands.length) return;
    const j = cands[Math.floor(Math.random() * cands.length)];
    const arms = [{ dx: 0, dy: -1, ok: j.n > 0 }, { dx: 0, dy: 1, ok: j.s > 0 }, { dx: -1, dy: 0, ok: j.w > 0 }, { dx: 1, dy: 0, ok: j.e > 0 }].filter(a => a.ok);
    if (!arms.length) return;
    const a = arms[Math.floor(Math.random() * arms.length)];
    const kx = Math.round((j.x - W_CX) / W_S), ky = Math.round((j.y - W_CY) / W_S);
    const road = a.dx ? worldRoadFor('h', ky, j.x) : worldRoadFor('v', kx, j.y), dir = a.dx ? a.dx : a.dy, fromS = a.dx ? j.x : j.y;
    if (!road) return;
    const car = { id: worldNextDyn++, x: 0, y: 0, a: Math.atan2(a.dy, a.dx), v: 0, max: 3.4 + Math.random() * 1.9, c: Math.floor(Math.random() * WORLD_CAR_COLORS.length), t: Math.random() < 0.12 ? 5 : Math.floor(Math.random() * 3), stuck: 0, lastHit: 0 };
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
    for (const c of clients) { const p = c.player; if (p.flight || p.taxiRide) continue; obs.push({ x: p.x, y: p.y, r: p.vehicle ? 24 : p.radius + 4, tank: p.vehicle ? null : p }); }
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
            const jX = W_CX + car.jx * W_S, jY = W_CY + car.jy * W_S;
            const nroad = plan.dx ? worldRoadFor('h', car.jy, jX) : worldRoadFor('v', car.jx, jY);
            const ndir = plan.dx ? plan.dx : plan.dy;
            const jxS = plan.dx ? jX : jY;
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
    const p = client.player; if (p.flight) return;
    const zone = worldZone(p.x, p.y), want = [20, 14, 8, 0][zone];
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
        for (const r of taxiRides.values()) if (r.phase !== 'riding' && Math.abs(r.x - p.x) < R && Math.abs(r.y - p.y) < R) cars.push([-(1000000 + r.id), Math.round(r.x), Math.round(r.y), Math.round(r.a * 100) / 100, 0, r.client === c ? 6 : 5]);
        wsSendObj(c.ws, ({ type: 'world_dyn', cars, peds: pd }));
    }
}

// ---- main world loop (20 Hz) ------------------------------------------------------------------------
let worldTickN = 0;
setInterval(() => {
    if (!WL) return;
    worldTickN++;
    const now = Date.now();
    worldTrafficStep();
    worldTaxiStep();
    if (worldTickN % 2 === 0) worldBroadcastDyn();
    if (worldTickN % 20 === 0) { worldFarmTick(); }
    if (worldTickN % 1200 === 0) worldExpireHouses();
    if (worldTickN % 100 === 0) for (const [k, r] of Object.entries(interiorRooms)) if (!r.clients.length && r.emptySince && now - r.emptySince > 20000) delete interiorRooms[k];
    for (const c of [...worldClients]) {
        const w = c.world; if (!w) continue;
        const dt = now - w.lastTick; w.lastTick = now; w.playMs += dt;
        if (w.dead && now >= w.respawnAt) { worldSpawnNewlyOrAfterDeath(c); worldSave(c); continue; }
        const p = c.player; if (!p) continue;
        // work task progress
        if (w.task) {
            const def = c.room.def, st = def?.stations.find(s => s.id === w.task.desk), co = worldEmployer(w);
            if (!st || !co || Math.hypot(st.x - p.x, st.y - p.y) > st.r + 30) { w.task = null; worldNotice(c, 'You left your desk – task cancelled.'); sendWorld(c, 'world_task', { p: -1 }); }
            else {
                const prog = (now - w.task.start) / ((co.task || 8) * 1000);
                if (prog >= 1) { w.task = null; sendWorld(c, 'world_task', { p: -1 }); worldCompleteWork(c, co, worldPayFor(co, w.ext), 'Task complete'); }
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
            const left = worldFireMs(co) - (w.playMs - w.jobLast);
            if (left <= 0) worldFire(c);
            else for (const th of WORLD_WARN_MS) if (left <= th && (w.warned || Infinity) > th) { w.warned = th; worldNotice(c, `Warning: you will be fired from ${co.name} in ${worldFmtMs(left)} unless you ${co.kind === 'desk' ? 'complete a task at your desk' : co.kind === 'farm' ? 'harvest some crops' : 'finish a job (press J)'}.`, { level: 'warn' }); }
            if (left > WORLD_WARN_MS[0]) w.warned = Infinity;
        }
        if (worldTickN % 20 === 0) { w.bankCoins = worldBankCoins(c); worldPushState(c); }
        if (w.scene === 'ext' && !p.vehicle && !p.flight) w.ext = { x: p.x, y: p.y };
        if (w.scene === 'ext' && worldTickN % (p.flight ? 2 : 10) === 0) worldStreamChunks(c);
        if (p.flight && worldTickN % 10 === 0) worldPushFlight(c);
        if (w.mission && worldTickN % 4 === 0) { worldMissionTick(c); if (w.mission && worldTickN % 20 === 0) worldPushMission(c); }
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

                case DTB_MAGIC:
                    data = DTB.decode(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
                    break;

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
            wsSendObj(ws, ({ type: 'pong', time: data.time, locationl: SERVER_LOCATION }));
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
            
            wsSendObj(ws, ({ type: 'init', id: client.player.id, team: team, nc: client.player.nameColor, name1: client.player.name }));
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
                wsSendObj(client.ws, ({ type: 'profile_update', profile: user }));
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
                    wsSendObj(client.ws, ({ type: 'profile_update', profile: db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId) }));
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
                wsSendObj(client.ws, ({ type: 'profile_update', profile: db.prepare("SELECT * FROM users WHERE id = ?").get(client.dbId) }));
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
                
                let focalX = room.mode === 'WORLD' ? W_CX : WORLD_SIZE / 2;
                let focalY = room.mode === 'WORLD' ? W_CY : WORLD_SIZE / 2;

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
                const vq = room.worldKind === 'exterior' && c.player && c.player.flight && c.player.flight.q, vk = vq ? Math.min(8, wSec(focalY)) : 1;   // flying: compare on the sphere

                for (let i = 0; i < room.entities.length; i++) {
                    let e = room.entities[i];
                    if (e.markedForDeletion) continue;
                    if (['tank', 'ai'].includes(e.type)) {
                        processedEntities.add(e.id);
                        let isVisible = Math.abs(room.worldKind === 'exterior' ? wrapDx(e.x - focalX) : e.x - focalX) < VD && 
                                        Math.abs(e.y - focalY) < VDY;
                        if (vq && e.flight && e.flight.q) isVisible = wDistV(vq, e.flight.q) * vk < VD;     // chart x/y mean nothing near a pole

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
                            veh: e.vehicle ? { a: Math.round(e.vehicle.a * 100) / 100, v: Math.round(e.vehicle.v * 10) / 10, m: e.vehicle.model } : e.taxiRide ? { a: Math.round(e.taxiRide.a * 100) / 100, v: Math.round(e.taxiRide.v * 10) / 10, m: 'taxi' } : undefined,
                            fl: e.flight ? { a: Math.round(e.flight.a * 1000) / 1000, alt: Math.round(e.flight.alt * 1000) / 1000, v: Math.round(e.flight.v * 10) / 10, liv: e.flight.liv, al: e.flight.al, ac: e.flight.ac, vs: e.flight.q ? Math.round(e.flight.vs * 10) / 10 : undefined, q: e.flight.q ? e.flight.q.map(v => Math.round(v * 1e6) / 1e6) : undefined, h: e.flight.h ? e.flight.h.map(v => Math.round(v * 1e6) / 1e6) : undefined } : undefined
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

                wsSendObj(c.ws, ({ type: 'state', entities: payloadEntities, bullets: payloadBullets, drones: payloadDrones }));
                
                if(c.player && !c.player.markedForDeletion) {
                    const ps = { type: 'playerStats', xp: c.player.xp, level: c.player.level, statPoints: c.player.statPoints, stats: c.player.stats, tankType: c.player.tankType, score: c.player.score };
                    const psKey = ps.xp + '|' + ps.level + '|' + ps.statPoints + '|' + ps.stats.join(',') + '|' + ps.tankType + '|' + ps.score;
                    if (psKey !== c.lastStatsKey || tickCount - (c.lastStatsTick || 0) > 120) { c.lastStatsKey = psKey; c.lastStatsTick = tickCount; wsSendObj(c.ws, ps); }   // only when something changed (plus a 2 s refresh)
                } else {
                    if (!c.spectatingId) {
                        let top = room.entities.filter(en => ['tank','ai'].includes(en.type)).sort((a,b) => b.score - a.score)[0];
                        c.spectatingId = top ? top.id : null;
                    }
                    if (c.spectatingId) wsSendObj(c.ws, ({ type: 'spectate_update', id: c.spectatingId }));
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
