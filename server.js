// node --env-file=C:\Users\chris\OneDrive\Documents\ditanks.gg\.env C:\Users\chris\OneDrive\Documents\ditanks.gg\server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const app = express();
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
    const url = `https://discord.com/oauth2/authorize?client_id=1487399148566089828&response_type=code&redirect_uri=https%3A%2F%2Fditanksgg.up.railway.app%2Fauth%2Fdiscord%2Fcallback&scope=identify`;
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
                redirect_uri: `https://ditanksgg.up.railway.app/auth/discord/callback`
            })
        });

        const tokenData = await tokenRes.json();
        
        // If the token exchange failed, log the Discord error message
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

app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// Check if Railway provided a volume path, otherwise use local 'game.db'
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'game.db') 
    : 'game.db';

const db = new Database(dbPath);

console.log(`[Database] Mounted at: ${dbPath}`); // Helpful for debugging in Railway logs
const crypto = require('crypto'); 
// 1. Create the basic table if it's a brand new database
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

// 2. MIGRATIONS: Add columns to existing databases safely
const migrations = [
    "ALTER TABLE users ADD COLUMN high_score INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN session_token TEXT"
];

migrations.forEach(query => {
    try {
        db.prepare(query).run();
        console.log(`[Database] Migration successful: ${query}`);
    } catch (err) {
        // We expect an error if the column already exists, so we just ignore it
        if (!err.message.includes("duplicate column name")) {
            console.error(`[Database] Migration failed: ${err.message}`);
        }
    }
});

db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_config (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`).run();
const SHOP_ITEMS = {
    colors: [
        { id: '#ff0000', name: 'Red', cost: 5000 },
        { id: '#00ff00', name: 'Green', cost: 5000 },
        { id: '#0000ff', name: 'Blue', cost: 5000 },
        { id: '#ff00ff', name: 'Pink', cost: 5000 },
        { id: '#ffff00', name: 'Yellow', cost: 5000 }
    ]
};

// --- Add this table creation block ---
db.prepare(`
    CREATE TABLE IF NOT EXISTS banned_ips_v2 (
        ip_hash TEXT PRIMARY KEY,
        timestamp INTEGER,
        reason TEXT
    )
`).run();
// -------------------------------------

try { db.prepare("ALTER TABLE banned_ips_v2 ADD COLUMN reason TEXT").run(); } catch(e) {}
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

app.use(express.json());

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

// Added Create Server Endpoint
app.post('/api/admin/server_instances/create', requireAdmin, (req, res) => {
    const { id, mode } = req.body;
    if (!id || !mode) return res.status(400).json({ error: "Invalid parameters" });
    if (rooms[id]) return res.status(400).json({ error: "Server already exists" });
    
    rooms[id] = new Room(id, mode);
    res.json({ success: true });
});

// Updated Server Action Endpoint
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
app.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
const GAME_SPEED = 1; 
const VIEW_DISTANCE = 1000; 
const WORLD_SIZE = 4000;
const BASE_SIZE = 600;
const MAX_LEVEL = 30;
const TICK_RATE = 60; 
const SERVER_LOCATION = process.env.SERVER_LOCATION;
const LEVEL_REQUIREMENTS = [ 0, 0, 22, 100, 210, 355, 480, 620, 780, 950, 1130, 1320, 1500, 1650, 1780, 1900, 2500, 3200, 4100, 5000, 6100, 7000, 8000, 9000, 10000, 11100, 12200, 13300, 14400, 15600, 16800 ];
let BOT_NAMES = [];
try {
    const namesPath = path.join(__dirname, 'names.json');
    if (fs.existsSync(namesPath)) {
        const rawData = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
        BOT_NAMES = Array.isArray(rawData[0]) ? rawData.flat() : rawData; 
    }
} catch (err) {}

const TANK_SPECS = {
    'Basic': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0, spread: 0}], dmg: 1, spd: 1, rel: 1, maxDrones: 0 },
    'Twin': { barrels: [{x:0, y:-10, w:16, l:1.8, angle:0, spread: 0}, {x:0, y:10, w:16, l:1.8, angle:0, spread: 0}], dmg: 0.64, spd: 1, rel: 1, maxDrones: 0 },
    'Sniper': { barrels: [{x:0, y:0, w:18, l:2.4, angle:0, spread: 0}], dmg: 1.1, spd: 2, rel: 1.66, maxDrones: 0 },
    'Machine Gun': { barrels: [{x:0, y:0, w:22, w2: 32, l:1.6, angle:0, spread: 0.5}], dmg: 0.71, spd: 1, rel: 0.5, maxDrones: 0 },
    'Flank Guard': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0, spread: 0}, {x:0, y:0, w:18, l:1.5, angle:Math.PI, spread: 0}], dmg: 1, spd: 1, rel: 1, maxDrones: 0 },
    'Overseer': { barrels: [{x:0, y:0, w:30, w2:40, l:1.3, angle:Math.PI/2, spread:0}, {x:0, y:0, w:30, w2:40, l:1.3, angle:-Math.PI/2, spread:0}], dmg: 1.5, spd: 0.8, rel: 1.5, maxDrones: 7, isDroneSpawner: true },
    'Destroyer': { barrels: [{x:0, y:0, w:35, l:1.9, angle:0, spread: 0}], dmg: 7.8, spd: 0.8, rel: 3, maxDrones: 0 },
    'Octo Tank': { barrels: [
        {x:0, y:0, w:16, l:1.8, angle:0, spread: 0}, {x:0, y:0, w:16, l:1.8, angle:Math.PI/4, spread: 0},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI/2, spread: 0}, {x:0, y:0, w:16, l:1.8, angle:3*Math.PI/4, spread: 0},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI, spread: 0}, {x:0, y:0, w:16, l:1.8, angle:-3*Math.PI/4, spread: 0},
        {x:0, y:0, w:16, l:1.8, angle:-Math.PI/2, spread: 0}, {x:0, y:0, w:16, l:1.8, angle:-Math.PI/4, spread: 0}
    ], dmg: 0.5, spd: 1, rel: 1.1, maxDrones: 0 },
    'Triplet': { barrels: [
        {x:0, y:-12, w:14, l:1.6, angle:0, spread: 0}, {x:0, y:12, w:14, l:1.6, angle:0, spread: 0},
        {x:0, y:0, w:14, l:1.8, angle:0, spread: 0}
    ], dmg: 0.5, spd: 1, rel: 0.8, maxDrones: 0 },
    'Tri-angle': { barrels: [
        {x:0, y:0, w:18, l:1.8, angle:0, spread: 0},
        {x:0, y:0, w:16, l:1.6, angle:5*Math.PI/6, spread: 0, recoilMult: 2.5},
        {x:0, y:0, w:16, l:1.6, angle:-5*Math.PI/6, spread: 0, recoilMult: 2.5}
    ], dmg: 0.8, spd: 0.9, rel: 1, maxDrones: 0 }
};

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

class Room {
    constructor(id, mode) {
        this.id = id;
        this.mode = mode;
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
        for(let i=0; i<200; i++) this.spawnShape();
        for(let i=0; i<20; i++) this.spawnBot(i);
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
                // Added a chance for pentagons to spawn in the outer areas
                : ['square','square','square','triangle','pentagon'][Math.floor(Math.random()*5)]; 
        }
        this.entities.push(new Entity(this, x, y, type));
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
        if (startScore > 0) bot.addXP(startScore); 
        this.entities.push(bot);
    }
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
        this.radius = 20; this.angle = 0;
        this.vx = 0; this.vy = 0;
        this.reloadTimer = 0; this.activeDrones = 0;
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
        if(type === 'square') { this.hp = 14; this.maxHp = 14; this.radius = 15; this.xpVal = 60; }
        if(type === 'triangle') { this.hp = 35; this.maxHp = 35; this.radius = 18; this.xpVal = 150; }
        if(type === 'pentagon') { this.hp = 140; this.maxHp = 140; this.radius = 30; this.xpVal = 600; }
        if(type === 'hexagon') { this.hp = 750; this.maxHp = 750; this.radius = 45; this.xpVal = 2000; }
        if(type === 'ai') { this.name = BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] || "Bot"; }
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
    }

    update() {
        this.vx *= 0.85; this.vy *= 0.85;
        this.x += this.vx; this.y += this.vy;
        this.x = Math.max(0, Math.min(WORLD_SIZE, this.x));
        this.y = Math.max(0, Math.min(WORLD_SIZE, this.y));

        if(this.reloadTimer > 0) this.reloadTimer--;
        let effectiveMaxHp = this.maxHp + (this.stats[1] * 20); 

        if (this.hp < effectiveMaxHp) {
            let timeSinceDamage = Date.now() - this.lastDamageTime;
            
            if (timeSinceDamage >= 30000) {
                this.hp += effectiveMaxHp * 0.05; 
            } else {
                this.hp += 0.1 * (1 + this.stats[0] * 1); 
            }
            if (this.hp > effectiveMaxHp) this.hp = effectiveMaxHp;
        }
        let moveSpeed = (0.5 * 0.998) + (this.stats[7] * (0.04 * 0.995)); 

        if(this.isPlayer) {
            let inputX = 0; let inputY = 0;
            if(this.inputs.left) inputX -= 1;
            if(this.inputs.right) inputX += 1;
            if(this.inputs.up) inputY -= 1;
            if(this.inputs.down) inputY += 1;
            if (inputX !== 0 || inputY !== 0) {
                let length = Math.sqrt(inputX * inputX + inputY * inputY);
                this.vx += (inputX / length) * moveSpeed;
                this.vy += (inputY / length) * moveSpeed;
            }

            this.angle = this.inputs.angle;
            if(this.inputs.shooting) shoot(this);
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

                nearby.drones.forEach(d => {
                    if (d.owner === this || d.markedForDeletion) return;
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
                    if (isSameTeam && !isShape) return;

                    let distSq = (this.x - e.x)**2 + (this.y - e.y)**2;

                    if (!isShape && !isSameTeam && isTank) {
                        // Base detection of 300, maxes out at 1000 distance for 17,000+ score
                        let detectionDist = 300 + (Math.min(e.score, 17000) / 17000) * 700;
                        let detectionSq = detectionDist * detectionDist;
                        
                        if(distSq < detectionSq && distSq < minEnemyDistSq) { 
                            minEnemyDistSq = distSq; 
                            enemyTarget = e; 
                        }
                   } else if (isShape) {
                        if(distSq < minShapeDistSq) { minShapeDistSq = distSq; shapeTarget = e; }
                   }
                });

                this.aiTarget = droneTarget || enemyTarget || shapeTarget;
                this.targetId = this.aiTarget ? (this.aiTarget.id || null) : null;
                this.isFleeing = (this.hp / this.maxHp) < 0.25;
            }
            this.vx += this.evadeVx;
            this.vy += this.evadeVy;
            let target = this.aiTarget;
            if (target && target.markedForDeletion) {
                target = null;
                this.aiTarget = null;
            }

            if(target) {
                let isDrone = target.owner !== undefined;
                let predX = target.x;
                let predY = target.y;
                if (!isDrone) {
                    let dx = target.x - this.x;
                    let dy = target.y - this.y;
                    let dTargetSq = dx*dx + dy*dy;
                    let dTarget = Math.sqrt(dTargetSq);
                    let bSpd = ((6 * 0.998) + (this.stats[3] * (0.4 * 0.995))) * (TANK_SPECS[this.tankType].spd || 1);
                    let timeToHit = dTarget / (bSpd || 1);
                    predX += (target.vx || 0) * timeToHit;
                    predY += (target.vy || 0) * timeToHit;
                }              
                
                if (this.isFleeing && !target.isShape) {
                    // NEW: Fleeing recoil jump! Turn backwards and shoot to escape faster.
                    this.angle = Math.atan2(this.y - predY, this.x - predX);
                    shoot(this);
                    
                    if (this.tankType === 'Tri-angle') {
                        // Tri-angle runs faster forward
                        this.angle = Math.atan2(predY - this.y, predX - this.x);
                        this.vx -= Math.cos(this.angle) * moveSpeed;
                        this.vy -= Math.sin(this.angle) * moveSpeed;
                    } else {
                        // Regular tanks run faster by shooting backward
                        this.vx += Math.cos(this.angle) * moveSpeed;
                        this.vy += Math.sin(this.angle) * moveSpeed;
                    }
                } else {
                    // Normal chase & shoot
                    this.angle = Math.atan2(predY - this.y, predX - this.x);
                    shoot(this);

                    if (isDrone && target.owner) {
                        let evadeAngle = Math.atan2(target.owner.y - this.y, target.owner.x - this.x);
                        this.vx -= Math.cos(evadeAngle) * moveSpeed;
                        this.vy -= Math.sin(evadeAngle) * moveSpeed;
                    } else {
                        let keepDist = this.tankType === 'Overseer' ? 450 : (this.tankType === 'Sniper' ? 300 : (target.isShape ? 50 : 150));
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
                let centerX = WORLD_SIZE / 2;
                let centerY = WORLD_SIZE / 2;
                let distToCenterSq = (this.x - centerX)**2 + (this.y - centerY)**2;
                
                if (distToCenterSq > 1000000) { // If far from center
                    let centerAngle = Math.atan2(centerY - this.y, centerX - this.x);
                    // Smoothly turn towards the middle
                    let angleDiff = centerAngle - this.angle;
                    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                    this.angle += angleDiff * 0.05; 
                } else if(this.thinkTimer === 0 && Math.random() < 0.2) {
                    this.angle += (Math.random() - 0.5);
                }
                
                this.vx += Math.cos(this.angle) * (moveSpeed * 0.4);
                this.vy += Math.sin(this.angle) * (moveSpeed * 0.4);

                // Occasionally shoot at nothing to farm off-screen shapes
                if (Math.random() < 0.03) {
                    shoot(this);
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
                        if (this.tankType === 'Sniper') opts = ['Overseer'];
                        else if (this.tankType === 'Twin') opts = ['Octo Tank', 'Triplet'];
                        else if (this.tankType === 'Flank Guard') opts = ['Tri-angle', 'Octo Tank'];
                        
                        if (opts.length > 0) {
                            this.tankType = opts[Math.floor(Math.random() * opts.length)];
                        }
                    }
                }
            }
        }
        
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

class Drone {
    constructor(room, x, y, owner) {
        this.room = room;
        this.id = room.nextDroneId++;
        this.x = x; this.y = y; this.owner = owner;
        this.vx = 0; this.vy = 0; this.radius = 12;
        this.hp = (20 + (owner.stats[4] * 5)) * 2.5;
        this.dmg = 15 + (owner.stats[5] * 5);
        this.team = owner.team; this.angle = 0;
        this.markedForDeletion = false;
        owner.activeDrones++;
    }

    update() {
        if (!this.owner || this.owner.hp <= 0 || this.owner.markedForDeletion) {
            this.markedForDeletion = true;
            return;
        }

        let speed = 4 + (this.owner.stats[3] * 0.5); 
        let tx = this.x, ty = this.y, moving = false;

        if (this.owner.isPlayer) {
            tx = this.owner.inputs.mouseX; ty = this.owner.inputs.mouseY; moving = true;
            if(this.owner.inputs.repel) {
                let ang = Math.atan2(this.y - ty, this.x - tx);
                tx = this.x + Math.cos(ang) * 500; ty = this.y + Math.sin(ang) * 500;
            }
        } else {
            let target = null; 
            
            // AI Drone coordination: Sync with owner's brain
            if (this.owner.aiTarget && !this.owner.aiTarget.markedForDeletion) {
                if (this.owner.isFleeing) {
                    // Repel behavior when AI is low HP
                    let ang = Math.atan2(this.y - this.owner.y, this.x - this.owner.x);
                    tx = this.x + Math.cos(ang) * 500; 
                    ty = this.y + Math.sin(ang) * 500; 
                    moving = true;
                } else {
                    // Attack owner's primary target
                    target = this.owner.aiTarget;
                }
            } else {
                // Idle scanning behavior if owner has no target
                let minDistSq = Infinity;
                let nearby = this.room.grid.getNearby(this.x, this.y, 800); 
                nearby.entities.forEach(e => {
                    if(e === this.owner || e.markedForDeletion) return;
                    if(this.room.mode.includes("TDM") && e.team === this.owner.team && ['ai','tank'].includes(e.type)) return;
                    let distSq = (this.x - e.x)**2 + (this.y - e.y)**2;
                    if(distSq < 640000 && distSq < minDistSq) { minDistSq = distSq; target = e; }
                });
            }

            if(target) { tx = target.x; ty = target.y; moving = true; }
            else if (!moving) { tx = this.owner.x; ty = this.owner.y; moving = true; }
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
                if(dx*dx + dy*dy < (this.radius * 2)**2) {
                    let pushAngle = Math.atan2(dy, dx);
                    this.x += Math.cos(pushAngle) * 1; this.y += Math.sin(pushAngle) * 1;
                }
            }
        });
    }
}

const rooms = {
    "FFA-S1": new Room("FFA-S1", "FFA"),
    "FFA-S2": new Room("FFA-S2", "FFA"),
    "2TDM-S1": new Room("2TDM-S1", "2TDM"),
    "4TDM-S1": new Room("4TDM-S1", "4TDM"),
};
const UPGRADE_TREE = {
    'Basic': ['Twin', 'Sniper', 'Machine Gun', 'Flank Guard'],
    'Sniper': ['Overseer'],
    'Twin': ['Triplet', 'Octo Tank'],
    'Flank Guard': ['Tri-angle', 'Octo Tank']
};
function shoot(who) {
    if(who.reloadTimer > 0 || who.markedForDeletion) return;
    const specs = TANK_SPECS[who.tankType];
    const room = who.room;

    if(specs.isDroneSpawner) {
        if(who.activeDrones < specs.maxDrones) {
            room.drones.push(new Drone(room, who.x, who.y, who));
            who.reloadTimer = Math.max(10, ((40 * 1.002) - (who.stats[6] * (4 * 0.995))) * specs.rel);
        }
        return;
    }

    let bSpeed = ((6 * 0.998) + (who.stats[3] * (0.4 * 0.995))) * specs.spd; 
    let bDmg = (8 + (who.stats[5]*3)) * specs.dmg;
    let bPen = 1 + (who.stats[4]*0.5);

    specs.barrels.forEach(b => {
        let spreadAngle = (Math.random() - 0.5) * b.spread;
        let finalAngle = who.angle + b.angle + spreadAngle;
        let bx = who.x + Math.cos(who.angle + b.angle) * b.l * who.radius - Math.sin(who.angle) * b.y;
        let by = who.y + Math.sin(who.angle + b.angle) * b.l * who.radius + Math.cos(who.angle) * b.y;

        let recoilMult = b.recoilMult || 1;
        let recoilForce = (1.5 + bDmg * 0.05) * specs.dmg * recoilMult;
        
        who.vx -= Math.cos(finalAngle) * recoilForce * 0.25;
        who.vy -= Math.sin(finalAngle) * recoilForce * 0.25;

        room.bullets.push({ 
            id: room.nextBulletId++, 
            x: bx, y: by, vx: Math.cos(finalAngle)*bSpeed, vy: Math.sin(finalAngle)*bSpeed, 
            r: 8 + (who.stats[5]*0.5), life: 100 * (1 + who.stats[3]*0.1), dmg: bDmg, pen: bPen, 
            owner: who, team: who.team 
        });
    });

    who.reloadTimer = Math.max(5, ((30 * 1.002) - (who.stats[6] * (3 * 0.995))) * specs.rel);
}

function updateRoom(room) {
    if (room.status === 'stopped') return;
    const BASE_SIZE_4 = 600;
    const BASE_WIDTH_2 = 400; 
    const PROX = 350; 
    const REPEL_FORCE = 2.5; 

   function applyRepel(obj) {
        let team = obj.team || 0;
        const FAN_FORCE = 0.8; // Softer push
        const MAX_PUSH = 15;   // Prevents hyper-speed bouncebacks

        if (room.mode === "2TDM" && team !== 0) {
            if (team !== 1 && obj.x < BASE_WIDTH_2 + PROX) { 
                obj.vx += FAN_FORCE; if (obj.vx > MAX_PUSH) obj.vx = MAX_PUSH; 
            }
            if (team !== 2 && obj.x > WORLD_SIZE - BASE_WIDTH_2 - PROX) { 
                obj.vx -= FAN_FORCE; if (obj.vx < -MAX_PUSH) obj.vx = -MAX_PUSH; 
            }
        } else if (room.mode === "4TDM" && team !== 0) {
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
    room.drones.forEach(applyRepel);

    room.bullets.forEach(b => {
        b.x += b.vx; b.y += b.vy; b.life--;
    });
    room.grid.clear();
    room.entities.forEach(e => { if(!e.markedForDeletion) room.grid.insert(e, 'entities'); });
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
                    
                    if (en.hp <= 0 && b.owner && typeof b.owner.addXP === 'function') {
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
                
                if (en.hp <= 0 && d.owner && typeof d.owner.addXP === 'function') {
                    let xpGain = ['tank','ai'].includes(en.type) ? Math.max(en.xpVal||100, en.score) : (en.xpVal || 100);
                    d.owner.addXP(Math.min(xpGain, 24700)); 
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
                
                if (!isSameTeam) {
                    let damageRate = 2; 
                    let dmgE = (1 + (other.stats ? other.stats[2]*2 : 0)) * damageRate;
                    let dmgO = (1 + (en.stats ? en.stats[2]*2 : 0)) * damageRate;
                    
                    en.hp -= dmgE; 
                    other.hp -= dmgO;
                    
                    en.lastDamageTime = Date.now();
                    other.lastDamageTime = Date.now(); 
                    en.lastDamagedBy = other.id; 
                    other.lastDamagedBy = en.id;
                    
                    if(en.hp <= 0 && typeof other.addXP === 'function') other.addXP(['tank','ai'].includes(en.type) ? Math.max(en.xpVal||100, en.score) : (en.xpVal || 100));
                    if(other.hp <= 0 && typeof en.addXP === 'function') en.addXP(['tank','ai'].includes(other.type) ? Math.max(other.xpVal||100, other.score) : (other.xpVal || 100));
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
    let respawningBots = [];
    room.entities = room.entities.filter(e => {
        if(e.hp <= 0) {
            if(e.isPlayer && e.ws) {
                let timeAlive = Math.floor((Date.now() - e.spawnTime) / 1000);
                e.ws.send(JSON.stringify({ type: 'death', score: e.score, level: e.level, timeAlive: timeAlive, tank: e.tankType, killerId: e.lastDamagedBy }));
                
                let client = room.clients.find(c => c.player === e);
                if (client && client.dbId) {
                    let earnedCoins = Math.floor(e.score / 1000); 
                    
                    // -- NEW: High Score Tracking --
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
                    
                    // -- NEW: Trigger Discord Leaderboard Update --
                    if (isNewHighScore && userRecord.provider === 'discord') {
                        updateLeaderboard();
                    }
                }
                if (client) {
                    client.player = null;
                    client.spectatingId = e.lastDamagedBy;
                }
            }
            if(e.type === 'ai') respawningBots.push(Math.min(e.score / 5, 6124));

            room.clients.forEach(c => {
                if (c.spectatingId === e.id) c.spectatingId = e.lastDamagedBy || null; 
            });
            return false;
        }
        return true;
    });

    respawningBots.forEach(score => room.spawnBot(Math.floor(Math.random()*100), score));

    let shapes = room.entities.filter(e => !['ai','tank'].includes(e.type)).length;
    if(shapes < 200) room.spawnShape();
}

setInterval(() => { Object.values(rooms).forEach(updateRoom); }, 1000 / (TICK_RATE * GAME_SPEED));

wss.on('connection', (ws, req) => {
    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 10);

    const isBanned = db.prepare("SELECT * FROM banned_ips_v2 WHERE ip_hash = ?").get(ipHash);
    if (isBanned) {
        ws.close(4000, "Banned");
        return;
    }

    let client = { ws: ws, player: null, room: null, spectatingId: null, ipHash: ipHash, country: 'xx' };

    if (rawIp && !rawIp.includes('127.0.0.1') && !rawIp.includes('::1') && !rawIp.startsWith('192.168.')) {
        fetch(`https://1.1.1.1/cdn-cgi/trace`)
    .then(res => res.text())
    .then(data => {
        const countryMatch = data.match(/loc=([A-Z]{2})/);
        if (countryMatch) client.country = countryMatch[1].toLowerCase();
    });
    }

    ws.on('message', (message) => {
        const data = JSON.parse(message);

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
            client.spectatingId = null;
            if (client.dbId) {
                let user = db.prepare("SELECT selected_color FROM users WHERE id = ?").get(client.dbId);
                if (user) {
                    client.player.nameColor = user.selected_color;
                }
            }
            room.entities.push(client.player);
            
            ws.send(JSON.stringify({ type: 'init', id: client.player.id, team: team }));
        }
        else if (data.type === 'input' && client.player && !client.player.markedForDeletion) {
            client.player.inputs = data;
        }
        else if (data.type === 'upgradeStat' && client.player && !client.player.markedForDeletion) {
            let i = data.statIndex;
            if(client.player.statPoints > 0 && client.player.stats[i] < 7) {
                client.player.stats[i]++; client.player.statPoints--;
            }
        }
        else if (data.type === 'upgradeTank' && client.player && !client.player.markedForDeletion) {
    const player = client.player;
    if (player.level < 15 && data.tank !== 'Basic') return;
    if (player.level < 30 && data.tank === 'Overseer') return;
    const current = player.tankType;
    const possible = UPGRADE_TREE[current] || [];
    if (!possible.includes(data.tank)) return;
    player.tankType = data.tank;
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
        if (client.player) client.player.markedForDeletion = true;
        if (client.room) client.room.clients = client.room.clients.filter(c => c !== client);
    });
});

setInterval(() => {
    Object.values(rooms).forEach(room => {
        if (room.status === 'stopped') return;
        room.clients.forEach(c => {
            if(c.ws.readyState === WebSocket.OPEN) {
                
                let focalX = WORLD_SIZE / 2;
                let focalY = WORLD_SIZE / 2;

                if (c.player && !c.player.markedForDeletion) {
                    focalX = c.player.x; focalY = c.player.y;
                } else if (c.spectatingId) {
                    let specTarget = room.entities.find(en => en.id === c.spectatingId);
                    if (specTarget) { focalX = specTarget.x; focalY = specTarget.y; }
                }

                let payloadEntities = [], payloadBullets = [], payloadDrones = [];

                let nearby = room.grid.getNearby(focalX, focalY, VIEW_DISTANCE);
                let processedEntities = new Set();

                for (let i = 0; i < room.entities.length; i++) {
                    let e = room.entities[i];
                    if (['tank', 'ai'].includes(e.type)) {
                        processedEntities.add(e.id);
                        let isVisible = Math.abs(e.x - focalX) < VIEW_DISTANCE && 
                                        Math.abs(e.y - focalY) < (VIEW_DISTANCE / 1.8);
                        
                        payloadEntities.push({
                            id: e.id, 
                            x: isVisible ? Math.round(e.x) : null, 
                            y: isVisible ? Math.round(e.y) : null, 
                            type: e.type, team: e.team, hp: e.hp, maxHp: e.maxHp, 
                            radius: e.radius, angle: e.angle, tankType: e.tankType, 
                            name: e.name, score: e.score, nameColor: e.nameColor, inView: isVisible
                        });
                    }
                }

                for (let i = 0; i < nearby.entities.length; i++) {
                    let e = nearby.entities[i];
                    if (!processedEntities.has(e.id)) { 
                        payloadEntities.push({
                            id: e.id, x: Math.round(e.x), y: Math.round(e.y), 
                            type: e.type, team: e.team, hp: e.hp, maxHp: e.maxHp, 
                            radius: e.radius, angle: e.angle, inView: true
                        });
                    }
                }

                for(let i=0; i<nearby.bullets.length; i++) {
                    let b = nearby.bullets[i];
                    if (Math.abs(b.y - focalY) < VIEW_DISTANCE/1.8) {
                        payloadBullets.push({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), r: b.r, team: b.team });
                    }
                }

                for(let i=0; i<nearby.drones.length; i++) {
                    let d = nearby.drones[i];
                    if (Math.abs(d.y - focalY) < VIEW_DISTANCE/1.8) {
                        payloadDrones.push({ id: d.id, x: Math.round(d.x), y: Math.round(d.y), radius: d.radius, angle: d.angle, team: d.team });
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

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const discordClient = new Client({ 
    intents: [GatewayIntentBits.Guilds] 
});

const LEADERBOARD_CHANNEL_ID = '1470498877168812062';

async function updateLeaderboard() {
    if (!discordClient.isReady()) return;
    try {
        const channel = await discordClient.channels.fetch(LEADERBOARD_CHANNEL_ID);
        if (!channel) return;

        // Fetch top 10 Discord players by high score
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

        // Check if we already have a message ID saved
        const msgRecord = db.prepare("SELECT value FROM bot_config WHERE key = 'leaderboard_msg_id'").get();
        
        if (msgRecord && msgRecord.value) {
            try {
                const msg = await channel.messages.fetch(msgRecord.value);
                await msg.edit({ embeds: [embed] });
                return; // Successfully edited, exit function
            } catch (err) {
                console.log('could not edit old leaderboard message');
            }
        }

        // Send a new message and save its ID
        const newMsg = await channel.send({ embeds: [embed] });
        db.prepare("INSERT OR REPLACE INTO bot_config (key, value) VALUES ('leaderboard_msg_id', ?)").run(newMsg.id);

    } catch (err) {
        console.error('failed to update leaderboard ', err);
    }
}
const commands = [
    {
        name: 'account',
        description: 'View your game account details, coins, and cosmetics',
    },
    {
        name: 'lobbies',
        description: 'View active game servers and their live leaderboards',
    }
];

discordClient.once('clientReady', async () => {
    try {
        await discordClient.application.commands.set(commands);
        updateLeaderboard();
        
    } catch (error) {
        console.error('cant register commands', error);
    }
});

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // --- /account Command ---
    if (interaction.commandName === 'account') {
        const dbId = `discord_${interaction.user.id}`;
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(dbId);

        if (!user) {
            return interaction.reply({ 
                content: "You don't have a linked game discord account yet! Please log in via Discord on the game's web interface first to create your profile.", 
                ephemeral: true 
            });
        }

        const unlockedColors = JSON.parse(user.unlocked_colors || '["#ffffff"]');

        const embed = new EmbedBuilder()
            .setColor(user.selected_color || '#ffffff')
            .setTitle(`🎮 ${user.username}'s Profile`)
            .setThumbnail(user.pfp)
            .addFields(
                { name: '🪙 Coins', value: user.coins.toString(), inline: true },
                { name: '🏆 High Score', value: Math.floor(user.high_score || 0).toLocaleString(), inline: true },
                { name: '🎨 Unlocked Colors', value: unlockedColors.length.toString(), inline: true },
            )
            .setFooter({ text: `Account Provider: ${user.provider}` });

        await interaction.reply({ embeds: [embed] });
    }

    // --- /lobbies Command ---
    if (interaction.commandName === 'lobbies') {
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🌐 Active Game Lobbies & Leaderboards');

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
                leaderboardStr = topPlayers.map((p, index) => {
                    const icon = p.isPlayer ? '👤' : '👤'; 
                    return `**${index + 1}.** ${icon} ${p.name || 'Unnamed'} - ${Math.floor(p.score)} pts`;
                }).join('\n');
            }

            const humanCount = room.clients.filter(c => c.player).length;

            embed.addFields({
                name: `🟢 ${roomId} | Mode: ${room.mode} | Human Players: ${humanCount}`,
                value: leaderboardStr + '\n\u200B', 
                inline: false
            });
        }

        if (activeLobbies === 0) {
            embed.setDescription('No active game servers at the moment.');
        }

        await interaction.reply({ embeds: [embed] });
    }
});
if (process.env.DISCORD_BOT_TOKEN) {
    discordClient.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
        console.error('login failed', err);
    });
}
// ==========================================
const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.RAILWAY_STATIC_URL || `localhost:${PORT}`;

server.listen(PORT, '0.0.0.0', () => {
    const protocol = process.env.RAILWAY_STATIC_URL ? 'wss' : 'ws';
    const httpProtocol = process.env.RAILWAY_STATIC_URL ? 'https' : 'http';

    console.log(`server is live:`);
    console.log(` port: ${PORT}`);
    console.log(` WS:     ${protocol}://${PUBLIC_URL}`);
});
