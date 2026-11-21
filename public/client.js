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
function wsSendObj(obj) { if (ws && ws.readyState === 1) ws.send(DTB.encode(obj)); }

const canvas = document.getElementById('gameCanvas');

const ctx = canvas.getContext('2d');

const mCanvas = document.getElementById('minimapCanvas');

const mCtx = mCanvas.getContext('2d');



const style = document.createElement('style');

style.innerHTML = `

    #upgrades-panel {

        display: flex;

        flex-direction: column;

        gap: 8px;

        position: fixed;

        left: 20px;

        top: 20px;

        transform: translateX(-150%);

        transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);

        z-index: 100;

    }

    .square-upgrade {

        width: 85px;

        height: 85px;

        background: rgba(160, 190, 210, 0.8);

        border: 3px solid #555;

        border-radius: 6px;

        display: flex;

        flex-direction: column;

        align-items: center;

        justify-content: center;

        cursor: pointer;

        transition: transform 0.1s, background 0.2s;

    }

    .square-upgrade:hover {

        background: rgba(180, 210, 230, 0.9);

        transform: scale(1.05);

    }

    .square-upgrade span {

        font-family: 'Ubuntu', sans-serif;

        font-size: 11px;

        font-weight: bold;

        color: white;

        text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;

        margin-top: -2px;

        text-align: center;

    }

    #stats-panel {

        position: fixed;

        bottom: 20px;

        left: 20px;

        transform: translateY(150%);

        transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);

        z-index: 100;

    }

    #stats-panel.show-panel {

        transform: translateY(0);

    }

    #xp-bar {

        transition: width 0.2s ease-out, background-color 0.2s;

    }

    #upgrade-hover-zone {

        position: fixed;

        left: 0; top: 0; bottom: 0;

        width: 6px;

        background: linear-gradient(to right, rgba(160,200,255,0.18), transparent);

        z-index: 99;

        pointer-events: none;

        opacity: 0;

        transition: opacity 0.3s;

    }

    #upgrade-hover-zone.active {

        opacity: 1;

    }

`;

document.head.appendChild(style);



// Left-edge hover-zone element (shows a subtle glow when upgrades are ignored)

const upgradeHoverZone = document.createElement('div');

upgradeHoverZone.id = 'upgrade-hover-zone';

document.body.appendChild(upgradeHoverZone);



const WORLD_SIZE = 5500;

const BASE_SIZE = 600;

const TICK_RATE = 60;

const entryCount = 7

let myProfile = null;

const shopItems = { 

    colors: [

        { id: '#ff0000', name: 'Red', cost: 5000 },

        { id: '#00ff00', name: 'Green', cost: 5000 },

        { id: '#0000ff', name: 'Blue', cost: 5000 },

        { id: '#ff00ff', name: 'Pink', cost: 5000 },

        { id: '#ffff00', name: 'Yellow', cost: 5000 }

    ],

    skins: [] 

};



function updateAccountUI() {

    if (!myProfile) return;

    document.getElementById('view-logged-out').style.display = 'none';

    document.getElementById('view-logged-in').style.display = 'block';

    document.getElementById('ui-pfp').src = myProfile.pfp;

    document.getElementById('ui-username').innerText = myProfile.username;

    document.getElementById('ui-coins').innerText = myProfile.coins;

    if (document.getElementById('shop-modal').style.display === 'block') renderShopContent('colors');

}



function openShop() {

    document.getElementById('shop-modal').style.display = 'block';

    switchTab('colors');

}



function openLibrary() { openShop(); }



function switchTab(tab, btnElement = null) {

    document.querySelectorAll('.shop-tab').forEach(b => b.classList.remove('active'));

    if (btnElement) {

        btnElement.classList.add('active');

    } else {

        const matchingBtn = Array.from(document.querySelectorAll('.shop-tab')).find(b => b.getAttribute('onclick').includes(tab));

        if (matchingBtn) matchingBtn.classList.add('active');

    }

    renderShopContent(tab);

}



function renderShopContent(category) {

    const container = document.getElementById('shop-content');

    container.innerHTML = '';

    

    if (shopItems[category].length === 0) {

        container.innerHTML = '<p style="text-align:center; color:#888; font-weight:bold;">Coming Soon!</p>';

        return;

    }



    let unlocked = [];

    try {

        unlocked = Array.isArray(myProfile.unlocked_colors)

            ? myProfile.unlocked_colors

            : JSON.parse(myProfile.unlocked_colors);

    } catch (err) {

        console.error('Failed to parse unlocked_colors:', err);

    }

    

    // Build the whole list once and assign it a single time. The old version

    // did container.innerHTML += '...' inside the loop, which forces the

    // browser to re-parse and re-render the entire (growing) HTML string on

    // every iteration - O(n^2) work for n shop items instead of O(n).

    container.innerHTML = shopItems[category].map(item => {

        let isUnlocked = unlocked.includes(item.id);

        let isEquipped = myProfile.selected_color === item.id;

        

        let btnHtml = '';

        if (isEquipped) {

            btnHtml = `<button class="shop-btn btn-equipped" disabled>Equipped</button>`;

        } else if (isUnlocked) {

            btnHtml = `<button class="shop-btn btn-equip" onclick="wsSendObj(({type:'equip_item', category:'${category}', itemId:'${item.id}'}))">Equip</button>`;

        } else {

            let canAfford = myProfile.coins >= item.cost;

            btnHtml = `<button class="shop-btn btn-buy" ${!canAfford ? 'disabled' : ''} onclick="wsSendObj(({type:'buy_item', category:'${category}', itemId:'${item.id}'}))">Buy (🪙 ${item.cost})</button>`;

        }



        return `

            <div class="shop-item">

                <span style="color: ${item.id}; font-weight:bold; font-size: 16px;">${item.name}</span>

                ${btnHtml}

            </div>

        `;

    }).join('');

}



let ws;

let myId = null;

let spectateId = null; 

let myTeam = null;

let myName = null;

let gameMode = "FFA";

let camera = { x: WORLD_SIZE/2, y: WORLD_SIZE/2 };

let mouse = { x: 0, y: 0, rx: 0, ry: 0, pressed: false, rightDown: false, repel: false };

let keys = { w:false, a:false, s:false, d:false, shift: false };

// Drives aiming from the mobile fire-joystick instead of a mouse position -

// see getAimAngle() and the MOBILE TOUCH CONTROLS section at the bottom.

let mobileAim = { active: false, angle: 0, firing: false };



let autoFire = false;

let autoSpin = false;

let spinAngle = 0;

let renderEntities = new Map(); 

let lastBullets = new Map();

let lastDrones = new Map();

let dyingEntities = [];



const REF_WIDTH = 1536;

const BASE_FOV = 1.2;

let baseFov = BASE_FOV;
let fov = BASE_FOV;

function updateVisualFov() {
    // World Mode is closer-in than the normal arena, but uses the same camera math.
    fovTarget = baseFov * (isWorldMode ? 0.74 * worldFovMultiplier() : 1) * (powerupActive(myStats, "fov") ? 1.3 : 1);
    if (!isWorldMode) fov = fovTarget;        // World Mode eases toward the target in draw()
}

function worldToScreenX(x) {

    return (x - camera.x) / fov;

}

function worldToScreenY(y) {

    return (y - camera.y) / fov;

}

function screenToWorldX(x) {

    return camera.x + (x * fov);

}

function screenToWorldY(y) {

    return camera.y + (y * fov);

}

function scaleSize(v) {

    return v / fov;

}

const deathCanvas = document.createElement('canvas');

deathCanvas.width = 300;

deathCanvas.height = 300;

const deathCtx = deathCanvas.getContext('2d');



let gameState = { entities: [], bullets: [], drones: [] };

let myStats = { xp: 0, level: 1, statPoints: 0, stats: [0,0,0,0,0,0,0,0], tankType: 'Basic', score: 0, powerups: {} };

let myNameColor = '#fff'

const DEFAULT_COLORS = { 

    bg: "#cdcdcd", team1: "#0099ff", team2: "#fb3c42", 

    team3: "#be7ff5", team4: "#00e16e", // Purple & Green

    square: "#f8de4d", triangle: "#fc6868", pentagon: "#6d77fb", hexagon: "#6df5f5" 

};

let COLORS = { ...DEFAULT_COLORS };



function getTeamColor(team) {

    if(team === 0) return "#fff";

    if(gameMode === "FFA") return team === myTeam ? COLORS.team1 : COLORS.team2;

    if(team === 1) return COLORS.team1;

    if(team === 2) return COLORS.team2;

    if(team === 3) return COLORS.team3 || "#be7ff5";

    if(team === 4) return COLORS.team4 || "#00e16e";

    return COLORS.team2;

}



function formatScore(num) {

    if (num < 1000) return num.toString();

    if (num < 1000000) return (num / 1000).toFixed(1) + "k";

    return (num / 1000000).toFixed(2).replace(/\.00$/, '') + "m";

}



const STAT_INFO = [

    { name: "Health Regen", color: "#e8b08d" }, { name: "Max Health", color: "#e88dd6" },

    { name: "Body Damage", color: "#988de8" }, { name: "Bullet Speed", color: "#8daae8" },

    { name: "Bullet Penetration", color: "#e8db8d" }, { name: "Bullet Damage", color: "#e88d8d" },

    { name: "Reload", color: "#ade88d" }, { name: "Movement Speed", color: "#8de8e1" }

];




// Powerup visuals intentionally reuse the corresponding stat palette.
const POWERUP_COLORS = {
    movementSpeed: STAT_INFO[7].color,
    reload: STAT_INFO[6].color,
    damage: STAT_INFO[5].color,
    fov: STAT_INFO[4].color,
    bulletSpeed: STAT_INFO[3].color,
    forceField: STAT_INFO[2].color,
    maxHealth: STAT_INFO[1].color,
    healthRegen: STAT_INFO[0].color
};

const POWERUP_NAMES = {
    movementSpeed: "Movement Speed",
    reload: "Reload",
    damage: "Damage",
    fov: "FOV",
    bulletSpeed: "Bullet Speed",
    forceField: "Force Field",
    maxHealth: "Max Health",
    healthRegen: "Health Regen"
};

let powerupParticles = [];
let bulletParticles = [];
let powerupParticleClock = 0;

function powerupColor(type) {
    return POWERUP_COLORS[type] || "#ffffff";
}

function powerupActive(source, type) {
    if (!source || !source.powerups) return false;
    const value = source.powerups[type];
    if (typeof value === "number") {
        if (value <= 0) return false;
        return value > Date.now() || value <= 30000;
    }
    return !!value;
}

function activePowerupTypes(source) {
    if (!source || !source.powerups) return [];
    return Object.keys(POWERUP_COLORS).filter(type => powerupActive(source, type));
}

function spawnPowerupParticle(x, y, type, scale = 1) {
    const a = Math.random() * Math.PI * 2;
    const speed = (0.25 + Math.random() * 0.9) * scale;
    powerupParticles.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 350 + Math.random() * 450, maxLife: 800,
        size: (1.2 + Math.random() * 2.5) * scale, type
    });
}

function spawnBulletParticle(x, y, type, scale = 1) {
    const a = Math.random() * Math.PI * 2;
    const speed = (0.15 + Math.random() * 0.45) * scale;
    bulletParticles.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 180 + Math.random() * 220, maxLife: 400,
        size: (0.8 + Math.random() * 1.8) * scale, type
    });
}

function updateAndDrawPowerupParticles() {
    const dt = 16.67;

    powerupParticles = powerupParticles.filter(p => {
        p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy *= 0.985; p.life -= dt;
        if (p.life <= 0) return false;
        const sx = worldToScreenX(p.x), sy = worldToScreenY(p.y);
        if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) return true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = powerupColor(p.type);
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = scaleSize(5);
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.8, scaleSize(p.size)), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        return true;
    });

    bulletParticles = bulletParticles.filter(p => {
        p.x += p.vx; p.y += p.vy; p.life -= dt;
        if (p.life <= 0) return false;
        const sx = worldToScreenX(p.x), sy = worldToScreenY(p.y);
        if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) return true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = powerupColor(p.type);
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = scaleSize(4);
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.7, scaleSize(p.size)), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        return true;
    });
}

function drawPowerupCore(context, en, alpha = 1) {
    const radius = scaleSize(en.radius || 18);
    const color = powerupColor(en.powerupType);

    context.save();
    context.globalAlpha *= alpha;
    context.shadowColor = color; context.shadowBlur = scaleSize(14);

    context.fillStyle = color;
    context.globalAlpha *= 0.18;
    context.beginPath(); context.arc(0, 0, radius * 1.45, 0, Math.PI * 2); context.fill();

    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.strokeStyle = darkenColor(color, 35);
    context.lineWidth = Math.max(1.5, 3 / fov);
    context.beginPath();
    context.moveTo(0, -radius * 1.05);
    context.lineTo(radius * 0.72, 0);
    context.lineTo(0, radius * 1.05);
    context.lineTo(-radius * 0.72, 0);
    context.closePath(); context.fill(); context.stroke();

    context.globalAlpha = alpha * 0.85;
    context.fillStyle = "#ffffff";
    context.beginPath(); context.arc(-radius * 0.22, -radius * 0.22, radius * 0.22, 0, Math.PI * 2); context.fill();
    context.restore();
}

function drawTankPowerupEffects(context, en) {
    const active = activePowerupTypes(en);
    if (!active.length) return;
    const radius = scaleSize(en.radius || 20);

    if (active.includes('forceField')) {
        const t = performance.now() * 0.004;
        const pulse = 1 + Math.sin(t) * 0.08;
        const auraR = radius * 3.1 * pulse;
        const color = powerupColor('forceField');
        context.save();
        context.globalAlpha = 0.16; context.fillStyle = color;
        context.beginPath(); context.arc(0, 0, auraR, 0, Math.PI * 2); context.fill();
        context.globalAlpha = 0.55; context.strokeStyle = color;
        context.lineWidth = Math.max(1.5, 2 / fov);
        context.setLineDash([scaleSize(8), scaleSize(5)]);
        context.beginPath(); context.arc(0, 0, auraR, t * 0.25, t * 0.25 + Math.PI * 1.75); context.stroke();
        context.setLineDash([]); context.restore();
    }

    const time = performance.now() * 0.002;
    active.forEach((type, index) => {
        const angle = time * (0.65 + index * 0.07) + index * Math.PI * 0.9;
        const orbit = radius * (1.25 + (index % 3) * 0.18);
        context.save();
        context.fillStyle = powerupColor(type);
        context.shadowColor = context.fillStyle; context.shadowBlur = scaleSize(8);
        context.globalAlpha = 0.9;
        context.beginPath();
        context.arc(Math.cos(angle) * orbit, Math.sin(angle) * orbit,
            Math.max(1.2, radius * 0.10), 0, Math.PI * 2);
        context.fill(); context.restore();
    });
}

// Updated TANK_SPECS with Smasher removed

const TANK_SPECS = {

    'Basic': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0}] },

    'Twin': { barrels: [{x:0, y:-10, w:16, l:1.8, angle:0}, {x:0, y:10, w:16, l:1.8, angle:0}] },

    'Sniper': { barrels: [{x:0, y:0, w:18, l:2.4, angle:0}] },

    'Machine Gun': { barrels: [{x:0, y:0, w:22, w2: 32, l:1.6, angle:0}] },

    'Flank Guard': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0}, {x:0, y:0, w:18, l:1.5, angle:Math.PI}] },

    'Overlord': { 

    barrels: [

        {x:0, y:0, w:17, w2:33, l:1.4, angle:0},

        {x:0, y:0, w:17, w2:33, l:1.4, angle:Math.PI/2},

        {x:0, y:0, w:17, w2:33, l:1.4, angle:Math.PI},

        {x:0, y:0, w:17, w2:33, l:1.4, angle:-Math.PI/2}

    ]

},

    'Destroyer': { barrels: [{x:0, y:0, w:30, l:1.9, angle:0}] },

    'Octo Tank': { barrels: [

        {x:0, y:0, w:16, l:1.8, angle:0}, {x:0, y:0, w:16, l:1.8, angle:Math.PI/4},

        {x:0, y:0, w:16, l:1.8, angle:Math.PI/2}, {x:0, y:0, w:16, l:1.8, angle:3*Math.PI/4},

        {x:0, y:0, w:16, l:1.8, angle:Math.PI}, {x:0, y:0, w:16, l:1.8, angle:-3*Math.PI/4},

        {x:0, y:0, w:16, l:1.8, angle:-Math.PI/2}, {x:0, y:0, w:16, l:1.8, angle:-Math.PI/4}

    ] },

    'Necromancer': {barrels: [{x:0, y:0, w:20, w2:30, l:1.25, angle:Math.PI/2, spread:0, dmg:0, spd:0.8, rel:Infinity, size:1, delay:0},

            {x:0, y:0, w:20, w2:30, l:1.25, angle:-Math.PI/2, spread:0, dmg:0, spd:0.8, rel:Infinity, size:1, delay:0},], square: true },

    'Triplet': { barrels: [

        {x:0, y:-12, w:12, l:1.65, angle:0}, {x:0, y:12, w:12, l:1.65, angle:0},

        {x:0, y:0, w:12, l:1.9, angle:0},

    ] },

    'Tri-angle': { barrels: [

        {x:0, y:0, w:18, l:1.8, angle:0},

        {x:0, y:0, w:16, l:1.6, angle:5*Math.PI/6},

        {x:0, y:0, w:16, l:1.6, angle:-5*Math.PI/6},

    ] },

    'Twin Flank': { barrels: [

        {x:0, y:-10, w:16, l:1.8, angle:0},

        {x:0, y:10, w:16, l:1.8, angle:0},

        {x:0, y:-10, w:16, l:1.8, angle:Math.PI},

        {x:0, y:10, w:16, l:1.8, angle:Math.PI},

    ] },

    'Pentashot': { barrels: [

        {x:0, y:0, w:14, l:1.6, angle:Math.PI/5},

        {x:0, y:0, w:14, l:1.6, angle:-Math.PI/5},

        {x:0, y:0, w:16, l:1.7, angle:Math.PI/10},

        {x:0, y:0, w:16, l:1.7, angle:-Math.PI/10},

        {x:0, y:0, w:18, l:1.8, angle:0},

    ] },

    'Predator': { barrels: [

        {x:0, y:0, w:10, l:2.5, angle:0},

        {x:0, y:0, w:17, l:2.0, angle:0},

        {x:0, y:0, w:24,  l:1.5, angle:0}, // Widest and shortest (bottom layer)  // Medium width and length (middle layer)

         // Thinnest and longest (top layer)

    ] },

    'Sprayer': { barrels: [

        {x:0, y:0, w:10, l:1.75, angle:0},

        {x:0, y:0, w:22, w2:32, l:1.6, angle:0},

    ] },

    'Railgun': { barrels: [

        {x:0, y:-16, w:9, l:1.6, angle:0},

        {x:0, y:16, w:9, l:1.6, angle:0},

        {x:0, y:-8, w:7, l:1.7, angle:0},

        {x:0, y:8, w:7, l:1.7, angle:0},

    ] },

    'Manager': { barrels: [

        {x:0, y:0, w:17, w2:33, l:1.4, angle:0}

    ] }

};

const ACHIEVEMENT_BADGES = {

    millionaire: `

        <svg viewBox="0 0 64 64">

            <circle cx="32" cy="32" r="26" fill="#f4c542"/>

            <path d="M32 18 L38 30 L50 32 L38 34 L32 46 L26 34 L14 32 L26 30 Z"

            fill="#fff3b0"/>

        </svg>

    `,



    blood: `

        <svg viewBox="0 0 64 64">

            <path d="M32 10 C40 22 48 30 48 40 A16 16 0 1 1 16 40 C16 30 24 22 32 10Z"

            fill="#ff4b4b"/>

        </svg>

    `,



    destroyer: `

        <svg viewBox="0 0 64 64">

            <polygon points="32,8 56,32 32,56 8,32"

            fill="#8f5cff"/>

        </svg>

    `,



    fire: `

        <svg viewBox="0 0 64 64">

            <path d="M32 8 C42 22 52 30 52 44 A20 20 0 1 1 12 44

            C12 28 22 20 32 8Z"

            fill="#ff9933"/>

        </svg>

    `,



    shield: `

        <svg viewBox="0 0 64 64">

            <path d="M32 8 L52 16 V30 C52 44 44 54 32 58

            C20 54 12 44 12 30 V16 Z"

            fill="#4bc0ff"/>

        </svg>

    `

};

let achievementsData = [];

let unlockedAchievements = [];

const iconCache = {};

async function loadAchievements() {



    const all = await fetch('/api/achievements');

    achievementsData = await all.json();



    if (!sessionToken) return;



    const unlocked = await fetch('/api/me/achievements', {

        headers: {

            Authorization: `Bearer ${sessionToken}`

        }

    });



    unlockedAchievements = await unlocked.json();

}

function openAchievements() {



    const modal = document.getElementById('achievements-modal');

    const list = document.getElementById('achievement-list');



    const unlockedIds = unlockedAchievements.map(a => a.id);



    // Same fix as renderShopContent: build once with map/join instead of

    // innerHTML += per item, avoiding repeated re-parse of a growing string.

    list.innerHTML = achievementsData.map(a => {

        const unlocked = unlockedIds.includes(a.id);

        return `

            <div class="achievement-card ${unlocked ? 'unlocked' : ''}">

                

                <div class="achievement-badge">

                    ${ACHIEVEMENT_BADGES[a.badge]}

                </div>



                <div class="achievement-info">

                    <div class="achievement-name">

                        ${a.name}

                    </div>



                    <div class="achievement-desc">

                        ${a.description}

                    </div>

                </div>



            </div>

        `;

    }).join('');



    modal.style.display = 'flex';

}



function closeAchievements() {

    document.getElementById('achievements-modal').style.display = 'none';

}

function showAchievementPopup(achievement) {



    const feed = document.getElementById('achievement-feed');



    const popup = document.createElement('div');

    popup.className = 'achievement-popup';



    popup.innerHTML = `

        <div class="achievement-badge">

            ${ACHIEVEMENT_BADGES[achievement.badge]}

        </div>



        <div>

            <div style="

                color:#ffd54a;

                font-weight:bold;

                font-size:18px;

            ">

                Achievement Unlocked

            </div>



            <div style="

                color:white;

                font-size:16px;

                margin-top:4px;

            ">

                ${achievement.name}

            </div>



            <div style="

                color:#aaa;

                font-size:13px;

                margin-top:2px;

            ">

                ${achievement.description}

            </div>

        </div>

    `;



    feed.appendChild(popup);



    setTimeout(() => {

        popup.remove();

    }, 5000);

} loadAchievements();

function getCachedTankIcon(tankType, color) {

    let key = tankType + "_" + color;

    if (iconCache[key]) return iconCache[key];

    

    let tc = document.createElement('canvas');

    tc.width = 36; tc.height = 36; 

    let tctx = tc.getContext('2d');

    tctx.translate(18, 18);

    tctx.rotate(-Math.PI/4); 

    

    let specs = TANK_SPECS[tankType] || TANK_SPECS['Basic'];

    let r = 8.5;

    tctx.lineWidth = 2;



    specs.barrels.forEach(b => {

        tctx.save(); tctx.rotate(b.angle);

        tctx.fillStyle = "#999"; tctx.strokeStyle = darkenColor("#999", 30);

        

        let bw = b.w * (r/24); 

        let bw2 = b.w2 ? b.w2 * (r/24) : 0;

        let by = (b.y || 0) * (r/24);



        if(b.w2) {

            tctx.beginPath(); tctx.moveTo(0, -bw/2); tctx.lineTo(r * b.l, -bw2/2);

            tctx.lineTo(r * b.l, bw2/2); tctx.lineTo(0, bw/2); tctx.closePath();

            tctx.fill(); tctx.stroke();

        } else {

            tctx.fillRect(0, -bw/2 + by, r * b.l, bw);

            tctx.strokeRect(0, -bw/2 + by, r * b.l, bw);

        }

        tctx.restore();

    });



    tctx.fillStyle = color; tctx.strokeStyle = darkenColor(color, 30);

if (specs.square) {

    const squareSize = r * 0.8142;

    tctx.fillRect(-squareSize, -squareSize, squareSize * 2, squareSize * 2);

    tctx.strokeRect(-squareSize, -squareSize, squareSize * 2, squareSize * 2);

} else {

    tctx.beginPath(); tctx.arc(0, 0, r, 0, Math.PI*2); tctx.fill(); tctx.stroke();

}

    

    iconCache[key] = tc.toDataURL();

    return iconCache[key];

}

function lerp(start, end, t) {

    return start + (end - start) * t;

}



function lerpAngle(a, b, t) {

    let d = b - a;

    while (d > Math.PI) d -= Math.PI * 2;

    while (d < -Math.PI) d += Math.PI * 2;

    return a + d * t;

}



// Single source of truth for "what direction is the player aiming", used both

// for the angle we send the server and the angle we draw our own barrel at.

// Priority: autoSpin > mobile fire-joystick > mouse position.

function getAimAngle(originX, originY) {

    if (autoSpin) return spinAngle;

    if (mobileAim.active) return mobileAim.angle;

    return Math.atan2(mouse.ry - originY, mouse.rx - originX);

}

function darkenColor(hex, percent) {

    hex = hex.replace('#', '');

    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];

    let r = parseInt(hex.substring(0, 2), 16);

    let g = parseInt(hex.substring(2, 4), 16);

    let b = parseInt(hex.substring(4, 6), 16);

    r = Math.max(0, Math.floor(r * (100 - percent) / 100));

    g = Math.max(0, Math.floor(g * (100 - percent) / 100));

    b = Math.max(0, Math.floor(b * (100 - percent) / 100));

    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);

}



function loadColors() {

    let saved = localStorage.getItem('diepColors');

    if(saved) {

        COLORS = JSON.parse(saved);

        document.getElementById('color-bg').value = COLORS.bg;

        document.getElementById('color-t1').value = COLORS.team1;

        document.getElementById('color-t2').value = COLORS.team2;

        document.getElementById('color-square').value = COLORS.square;

        document.getElementById('color-triangle').value = COLORS.triangle;

        document.getElementById('color-pentagon').value = COLORS.pentagon;

        document.getElementById('color-hexagon').value = COLORS.hexagon || "#6df5b9";

    }

}



function saveColors() {

    COLORS.bg = document.getElementById('color-bg').value;

    COLORS.team1 = document.getElementById('color-t1').value;

    COLORS.team2 = document.getElementById('color-t2').value;

    COLORS.square = document.getElementById('color-square').value;

    COLORS.triangle = document.getElementById('color-triangle').value;

    COLORS.pentagon = document.getElementById('color-pentagon').value;

    COLORS.hexagon = document.getElementById('color-hexagon').value;

    localStorage.setItem('diepColors', JSON.stringify(COLORS));

}



function resetColors() {

    COLORS = { ...DEFAULT_COLORS };

    localStorage.removeItem('diepColors');

    document.getElementById('color-bg').value = COLORS.bg;

    document.getElementById('color-t1').value = COLORS.team1;

    document.getElementById('color-t2').value = COLORS.team2;

    document.getElementById('color-square').value = COLORS.square;

    document.getElementById('color-triangle').value = COLORS.triangle;

    document.getElementById('color-pentagon').value = COLORS.pentagon;

    document.getElementById('color-hexagon').value = COLORS.hexagon;

}



function exportColors() {

    saveColors();

    navigator.clipboard.writeText(JSON.stringify(COLORS)).then(() => alert("Colors successfully copied!")).catch(err => alert("Failed to copy colors."));

}



function importColors() {

    let input = prompt("Paste your color settings JSON string here:");

    if (input) {

        try {

            let parsed = JSON.parse(input);

            COLORS = { ...DEFAULT_COLORS, ...parsed };

            document.getElementById('color-bg').value = COLORS.bg;

            document.getElementById('color-t1').value = COLORS.team1;

            document.getElementById('color-t2').value = COLORS.team2;

            document.getElementById('color-square').value = COLORS.square;

            document.getElementById('color-triangle').value = COLORS.triangle;

            document.getElementById('color-pentagon').value = COLORS.pentagon;

            document.getElementById('color-hexagon').value = COLORS.hexagon;

            saveColors();

            alert("Colors imported successfully!");

        } catch (e) { alert("Invalid color data format!"); }

    }

}



loadColors(); 



function toggleSettings() {

    let m = document.getElementById('color-menu');

    m.style.display = m.style.display === 'block' ? 'none' : 'block';

}



let serverData = {};



async function fetchServersAndInit() {

    try {

        const res = await fetch('/api/servers');

        serverData = await res.json();

        populateModes();

    } catch (e) {

        console.error("Failed to load servers", e);

        document.getElementById('playBtn').innerText = "Servers Unreachable";

    }

}



function populateModes() {

    const modeSelect = document.getElementById('gameModeInput');

    modeSelect.innerHTML = '';



    for (let mode in serverData) {

        let opt = document.createElement('option');

        opt.value = mode;

        opt.innerText =

            mode === "2TDM"

                ? "🔵 2 Teams"

                : mode === "4TDM"

                ? "🟪 4 Teams"

                : "⚔️ Free For All";



        modeSelect.appendChild(opt);

    }



    // Restore saved mode if it still exists

    const savedMode = localStorage.getItem('preferredGameMode');



    if (savedMode && serverData[savedMode]) {

        modeSelect.value = savedMode;

    } else {

        // Fallback to FFA

        modeSelect.value = serverData.FFA ? "FFA" : modeSelect.options[0]?.value;



        // Clean up invalid saved mode

        localStorage.removeItem('preferredGameMode');

    }



    populateRegions();

}



function populateRegions() {

    const mode = document.getElementById('gameModeInput').value;

    const regionSelect = document.getElementById('regionInput');

    regionSelect.innerHTML = ''; // Clear options

    

    if (serverData[mode]) {

        serverData[mode].forEach(srv => {

            let opt = document.createElement('option');

            opt.value = srv.id;

            opt.innerText = `🌐 ${srv.name} (${srv.players} Players)`;

            regionSelect.appendChild(opt);

        });

    }

    

    initConnection(); // Automatically connect to the selected room

}



function initConnection() {

    gameMode = document.getElementById('gameModeInput').value;

    const region = document.getElementById('regionInput').value;

    

    const playBtn = document.getElementById('playBtn');

    

    // Reset Play Button styling & setup tweening transition

    playBtn.style.transition = "background 0.3s ease, border-bottom-color 0.3s ease, transform 0.1s";

    playBtn.style.background = ""; 

    playBtn.style.borderBottomColor = "";

    playBtn.innerText = "Connecting...";

    playBtn.disabled = true;

    

    // Switch the click action back to spawning

    playBtn.onclick = spawnPlayer; 

    

    document.getElementById('disconnect-reason').style.display = 'none';



    if (ws) { ws.onclose = null; ws.close(); }

    connectWS(region, gameMode);

}

// Map the new listeners

document.getElementById('gameModeInput').addEventListener('change', () => {

    populateRegions(); // changing mode repopulates regions AND reconnects

});

document.getElementById('regionInput').addEventListener('change', initConnection);

window.onload = fetchServersAndInit;

// Restore saved nickname

const savedName = localStorage.getItem('playerName');

if (savedName) {

    document.getElementById('nameInput').value = savedName;

}

// Locate these functions in client.js and update them:



function spawnPlayer() {

    saveColors();

    gameMode = document.getElementById('gameModeInput').value;

    document.getElementById('sb-title').innerText = gameMode === "2TDM" ? "2 Teams" : (gameMode === "4TDM" ? "4 Teams" : "FFA");

    const playerName = document.getElementById('nameInput').value;



// Save nickname

localStorage.setItem('playerName', playerName);



wsSendObj(({

    type: 'spawn',

    name: playerName

}));

    document.getElementById('menu-overlay').style.display = 'none';

    document.getElementById('account-panel').style.display = 'none';

    document.getElementById('changelog-panel').style.display = 'none'; 



    document.getElementById('game-ui').style.display = 'block';

    document.getElementById('exit-btn').style.display = 'flex';

    document.getElementById('death-screen').style.display = 'none';

    initUI();

}



function continueToMenu() {

    isSpectating = false;

    const spectateBar = document.getElementById('spectate-bar');

    if (spectateBar) spectateBar.style.display = 'none';

    spectateId = null;



    document.getElementById('death-screen').style.display = 'none';

    document.getElementById('game-ui').style.display = 'none';

    document.getElementById('exit-btn').style.display = 'none';

    document.getElementById('menu-overlay').style.display = 'flex';

    document.getElementById('account-panel').style.display = 'block';

    // Add this line to show the changelog again:

    document.getElementById('changelog-panel').style.display = 'block'; 

}



// --- SPECTATE UI ---

// spectateId itself is already driven by the server ('death' sets it to the

// killer, 'spectate_update' can move it elsewhere) and draw()/camera already

// follow it whenever myId is null. These just control whether the death

// screen overlay is covering the game while that happens.

let isSpectating = false;



function startSpectating() {

    isSpectating = true;

    document.getElementById('death-screen').style.display = 'none';

    const bar = document.getElementById('spectate-bar');

    if (bar) bar.style.display = 'flex';

    updateSpectateLabel();

}



function stopSpectating() {

    isSpectating = false;

    const bar = document.getElementById('spectate-bar');

    if (bar) bar.style.display = 'none';

    // Bring the death screen back so Continue/Spectate are reachable again.

    document.getElementById('death-screen').style.display = 'flex';

}



function updateSpectateLabel() {

    const label = document.getElementById('spectate-label');

    if (!label) return;

    const target = gameState.entities.find(en => en.id === spectateId);

    label.innerText = target ? `Spectating ${target.name || 'Unknown'}` : 'Spectating';

}

function exitGame() {
    if(confirm("Are you sure you want to disconnect and return to the menu?")) {
        if(isWorldMode) worldSend('world_leave');
        isWorldMode=false;
        location.reload();
    }
}



function initUI() {

    const container = document.getElementById('stats-container');

    if (!container) return; // Safety check

    container.innerHTML = '';

    STAT_INFO.forEach((s, i) => {

        const d = document.createElement('div');

        d.className = 'stat-bar';

        d.innerHTML = `<span class="stat-name" style="color:${s.color}">${s.name}</span><div class="slots" id="slots-${i}">${Array(7).fill('<div class="slot"></div>').join('')}</div>`;

        d.onclick = () => { if(ws) wsSendObj(({ type: 'upgradeStat', statIndex: i })); };

        container.appendChild(d);

    });

}

// Shows the stat distribution + tank type you had at the moment you died.

// myStats isn't reset on death, so myStats.stats still holds your last known

// build (the death packet itself carries the tank type, which is the more

// authoritative source for that field at this exact moment).

function renderDeathBuild() {

    const container = document.getElementById('ds-build');

    if (!container) return;

    container.innerHTML = STAT_INFO.map((s, i) => {

        const val = myStats.stats[i] || 0;

        const slots = Array.from({ length: 7 }, (_, j) =>

            `<div class="slot" style="background:${j < val ? s.color : '#555'}"></div>`

        ).join('');

        return `<div class="stat-bar"><span class="stat-name" style="color:${s.color}">${s.name}</span><div class="slots">${slots}</div></div>`;

    }).join('');

}



const urlParams = new URLSearchParams(window.location.search);

let sessionToken = urlParams.get('token');

if (sessionToken) {

    localStorage.setItem('sessionToken', sessionToken);

    document.cookie = `sessionToken=${sessionToken}; max-age=604800; path=/`;

    window.history.replaceState({}, document.title, "/");

} else {

    sessionToken = localStorage.getItem('sessionToken');

    if (!sessionToken) {

        const cookieValue = document.cookie

            .split('; ')

            .find(row => row.startsWith('sessionToken='))

            ?.split('=')[1];

        if (cookieValue) {

            sessionToken = cookieValue;

            localStorage.setItem('sessionToken', sessionToken);

        }

    }

}

function logout() {

    localStorage.removeItem('sessionToken');

    document.cookie = "sessionToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";

    window.location.href = '/';

}

function numberWithCommas(x) {

    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

}



// ===================== PROTOCOL CONSTANTS =====================



const MSG = {

    STATE:        0x01,

    PLAYERSTAT:   0x02,

    INIT:         0x03,

    SPECTATE_UPD: 0x04,

};



const ENTITY_TYPE_INV = ['tank', 'ai', 'obstacle'];

const ANGLE_SCALE     = 1000;

const _td             = new TextDecoder();



// ===================== BINARY READERS =====================



function readStatePacket(dv, u8) {

    let o = 1;

    const entityCount = dv.getUint16(o, true); o += 2;

    const bulletCount = dv.getUint16(o, true); o += 2;

    const droneCount  = dv.getUint16(o, true); o += 2;



    const entities = [];

    for (let i = 0; i < entityCount; i++) {

        const id     = dv.getUint16(o, true); o += 2;

        const x      = dv.getInt16(o, true);  o += 2;

        const y      = dv.getInt16(o, true);  o += 2;

        const angle  = dv.getInt16(o, true) / ANGLE_SCALE; o += 2;

        const hp     = dv.getUint16(o, true); o += 2;

        const maxHp  = dv.getUint16(o, true); o += 2;

        const radius = dv.getUint8(o++);

        const team   = dv.getUint8(o++);

        const typeId = dv.getUint8(o++);

        const flags  = dv.getUint8(o++);

        const score  = dv.getUint32(o, true); o += 4;

        const nl     = dv.getUint8(o++);

        const name   = _td.decode(u8.subarray(o, o + nl)); o += nl;



        entities.push({

            id, x, y, angle, hp, maxHp, radius, team, score, name,

            type:   ENTITY_TYPE_INV[typeId] ?? 'tank',

            inView: !!(flags & 1),

        });

    }



    const bullets = [];

    for (let i = 0; i < bulletCount; i++) {

        const id   = dv.getUint16(o, true); o += 2;

        const x    = dv.getInt16(o, true);  o += 2;

        const y    = dv.getInt16(o, true);  o += 2;

        const r    = dv.getUint8(o++);

        const team = dv.getUint8(o++);

        bullets.push({ id, x, y, r, team });

    }



    const drones = [];

    for (let i = 0; i < droneCount; i++) {

        const id     = dv.getUint16(o, true); o += 2;

        const x      = dv.getInt16(o, true);  o += 2;

        const y      = dv.getInt16(o, true);  o += 2;

        const radius = dv.getUint8(o++);

        const angle  = dv.getInt16(o, true) / ANGLE_SCALE; o += 2;

        const team   = dv.getUint8(o++);

        const df     = dv.getUint8(o++);

        drones.push({ id, x, y, radius, angle, team, square: !!(df & 1) });

    }



    gameState = { entities, bullets, drones };

    if (!window.drawing) { window.drawing = true; requestAnimationFrame(draw); }

}



function readPlayerStats(dv, u8) {

    let o = 1;

    const xp         = dv.getUint32(o, true); o += 4;

    const level      = dv.getUint8(o++);

    const statPoints = dv.getUint8(o++);

    const stats      = Array.from({ length: 7 }, () => dv.getUint8(o++));

    const score      = dv.getUint32(o, true); o += 4;

    const tl         = dv.getUint8(o++);

    const tankType   = _td.decode(u8.subarray(o, o + tl));

    myStats = { xp, level, statPoints, stats, score, tankType };

    updateUI();

    checkUpgrades();
    if (isWorldMode) updateWorldHud();

}



function readBinaryMessage(ab) {

    const dv  = new DataView(ab);

    const u8  = new Uint8Array(ab);

    const msg = dv.getUint8(0);



    if      (msg === MSG.STATE)        readStatePacket(dv, u8);

    else if (msg === MSG.PLAYERSTAT)   readPlayerStats(dv, u8);

    else if (msg === MSG.INIT) {

        myId   = dv.getUint16(1, true);

        myTeam = dv.getUint8(3);

        spectateId = null;

    }

    else if (msg === MSG.SPECTATE_UPD) {

        spectateId = dv.getUint16(1, true);

    }

}



// ===================== CONNECTION =====================

// ===================== WORLD MODE CLIENT =====================
// The server owns the world (layout, houses, cars, jobs, interiors). The client only streams the static
// layout in chunks, draws it, and sends inputs / "interact" requests.
let isWorldMode = false, pendingWorldJoin = false;
let worldState = { sessionCoins: 0, bank: 0, job: null, car: null, house: null, scene: 'ext' };
const WC = {
    center: 25200, extent: 50400, chunk: 1800, nch: 28, roads: [], cars: [], carColors: [], companies: [], spawn: null, bank: null, dealer: null,
    fireMs: 900000, taskMs: 8000, chunks: new Map(), houses: new Map(), dyn: new Map(), scene: 'ext', interior: null, intKey: null,
    prompt: null, task: -1, pos: { x: 0, y: 0 }, allBld: new Map(), shapeDots: []
};
// Car-park bay layout: identical to the server's lotBays() so painted bays match where cars really park.
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
const WC_PAD = 40;                       // sprite padding (shadows, porches, awnings)
function worldSend(type, extra = {}) { if (ws && ws.readyState === 1) wsSendObj(({ type, ...extra })); }
function enterWorldMode() {
    if (!sessionToken) { alert('World Mode requires a logged-in Google or Discord account.'); return; }
    if (!ws || ws.readyState !== 1) { const region = document.getElementById('regionInput').value; const mode = document.getElementById('gameModeInput').value; pendingWorldJoin = true; connectWS(region, mode); return; }
    pendingWorldJoin = true; worldSend('world_join');
}
function wcExtent() { return WC.scene === 'ext' ? WC.extent : (WC.interior?.ext || 1800); }
// The world wraps east-west at the date line: when a plane crosses it the server x jumps by the circumference.
// Shift the interpolated position (and the camera, for our own plane) by the same amount so nothing sweeps across the map.
function wcWrapFix(rPos, en) {
    if (!isWorldMode || !WC.circ || en.x == null || rPos.renderX == null) return;
    const d = en.x - rPos.renderX;
    if (Math.abs(d) > WC.circ / 2) { const sh = Math.sign(d) * WC.circ; rPos.renderX += sh; if (en.id === myId) { camera.x += sh; } }
}
function beginWorldMode() {
    isWorldMode = true; gameMode = 'WORLD'; pendingWorldJoin = false;
    myTeam = 0; spectateId = null; isSpectating = false;
    gameState = { entities: [], bullets: [], drones: [] }; renderEntities.clear(); lastBullets.clear(); lastDrones.clear();
    WC.chunks.clear(); WC.allBld.clear(); WC.dyn.clear(); wcSpriteCache.clear();
    document.getElementById('menu-overlay').style.display = 'none'; document.getElementById('account-panel').style.display = 'none'; document.getElementById('changelog-panel').style.display = 'none';
    document.getElementById('game-ui').style.display = 'block'; document.getElementById('exit-btn').style.display = 'flex';
    document.getElementById('death-screen').style.display = 'none';
    const chip = document.getElementById('world-chip'); if (chip) chip.style.display = 'flex';
    initUI(); updateVisualFov(); fov = fovTarget; updateWorldHud();
    if (!window.drawing) { window.drawing = true; requestAnimationFrame(draw); }
}
function handleWorldMessage(d) {
    switch (d.type) {
        case 'world_static':
            Object.assign(WC, { center: d.center, centerY: d.centerY, extent: d.extent, extentY: d.extentY, circ: d.circ, gap: d.gap, land: d.land, airports: d.airports || [], chunk: d.chunk, nch: d.nch, roads: d.roads, cities: d.cities, cars: d.cars, carColors: d.carColors, companies: d.companies, spawn: d.spawn, bank: d.bank, dealer: d.dealer, fireMs: d.fireMs, taskMs: d.taskMs });
            wcBuildGates();
            beginWorldMode(); if (!wcMapEl) wcMapBuild(); return true;
        case 'world_houses': WC.houses = new Map(d.list.map(([h, o, m]) => [h, { o, m }])); return true;
        case 'world_house': if (d.o) WC.houses.set(d.hid, { o: d.o, m: d.m }); else WC.houses.delete(d.hid); wcSpriteCache.delete('hs' + d.hid); return true;
        case 'world_chunk': wcIngestChunk(d.c); return true;
        case 'world_scene': {
            WC.scene = d.scene; WC.intKey = d.key; WC.interior = d.interior; WC.pos = { x: d.x, y: d.y }; wcIntCache = null; WC.prompt = null; wcRenderPrompt(); WC.task = -1; wcRenderTask();
            gameState = { entities: [], bullets: [], drones: [] }; renderEntities.clear(); lastBullets.clear(); lastDrones.clear(); dyingEntities = [];
            myId = null; camera.x = d.x - (canvas.width * fov) / 2; camera.y = d.y - (canvas.height * fov) / 2; return true;
        }
        case 'world_state': worldState = { ...worldState, ...d }; updateWorldHud(); return true;
        case 'world_notice':
            if (d.sessionCoins !== undefined) worldState.sessionCoins = d.sessionCoins;
            if (d.message) wcToast(d.message, d.level); updateWorldHud(); return true;
        case 'world_map': WC.mapPlaces = d.p; wcMapDraw(); return true;
        case 'world_nav': WC.nav = d.tgt ? { t: d.t, ...d.tgt, route: d.route } : null; if (!d.tgt) wcToast({ work: 'No workplace found.', home: 'You do not own a house yet.', car: 'Your car is not parked anywhere.', pin: 'Cannot route there.' }[d.t] || 'No destination.', 'bad'); return true;
        case 'world_death': wcToast(d.reason || 'You died.', 'bad'); return true;
        case 'world_flight': wcFlight = d.f; wcRenderFlight(); return true;
        case 'world_branches': WC.branch = new Map(d.list); for (const b of WC.allBld.values()) wcApplyBranch(b); return true;
        case 'world_mission': {
            const had = wcMission; wcMission = d.m; wcMissionT = performance.now(); WC._trail = [];
            if (d.m && (!had || had.i !== d.m.i || had.label !== d.m.label)) wcSetNav('mission');
            if (!d.m && had && WC.navMode === 'mission') { WC.navMode = 'off'; WC.nav = null; }
            wcRenderBanners(); return true;
        }
        case 'world_taxi': wcTaxi = d.r; wcRenderBanners(); return true;
        case 'world_prompt': WC.prompt = d.p; wcRenderPrompt(); return true;
        case 'world_task': WC.task = d.p; wcRenderTask(); return true;
        case 'world_dyn': wcIngestDyn(d); return true;
        case 'world_reload': location.reload(); return true;
        case 'world_error': pendingWorldJoin = false; alert(d.message); return true;
    }
    return false;
}
function wcIngestChunk(c) {
    WC.chunks.set(c.cx + c.cy * WC.nch, c);
    if (WC.chunks.size > 260) {                         // drop chunks far behind (the server forgets them first and re-sends on return)
        const kx = Math.floor((camera.x + canvas.width * fov / 2) / WC.chunk), ky = Math.floor((camera.y + canvas.height * fov / 2) / WC.chunk);
        for (const [k, ch] of WC.chunks) if (Math.max(Math.abs(ch.cx - kx), Math.abs(ch.cy - ky)) > 10) { WC.chunks.delete(k); for (const b of ch.buildings) WC.allBld.delete(b.id); }
    }
    for (const b of c.buildings) { if (!WC.allBld.has(b.id)) WC.allBld.set(b.id, b); if (WC.branch.size) wcApplyBranch(b); }
}
function wcIngestDyn(d) {
    const seen = new Set();
    for (const c of d.cars) {
        const id = 'c' + c[0]; seen.add(id); let o = WC.dyn.get(id);
        if (!o) { o = { x: c[1], y: c[2], a: c[3], rx: c[1], ry: c[2], ra: c[3] }; WC.dyn.set(id, o); }
        o.x = c[1]; o.y = c[2]; o.a = c[3]; o.c = c[4]; o.t = c[5]; o.kind = 'car';
    }
    for (const p of d.peds) {
        const id = 'p' + p[0]; seen.add(id); let o = WC.dyn.get(id);
        if (!o) { o = { x: p[1], y: p[2], a: 0, rx: p[1], ry: p[2], ra: 0 }; WC.dyn.set(id, o); }
        o.x = p[1]; o.y = p[2]; o.skin = p[3]; o.kind = 'ped';
    }
    for (const k of [...WC.dyn.keys()]) if (!seen.has(k)) WC.dyn.delete(k);
}

// ---- HUD: compact status chip (top-left), toasts, task bar, anchored interaction bubble ----------
function wcFmtMs(ms) { ms = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(ms / 60) + ':' + String(ms % 60).padStart(2, '0'); }
let wcJobBase = { t: 0, left: 0 };
function updateWorldHud() {
    const chip = document.getElementById('world-chip'); if (!chip || !isWorldMode) return;
    const j = worldState.job;
    if (j) wcJobBase = { t: performance.now(), left: j.left };
    wcJobBase.st = performance.now();
    wcRenderChip();
}
function wcRenderChip() {
    const chip = document.getElementById('world-chip'); if (!chip) return;
    const j = worldState.job, left = j ? Math.max(0, wcJobBase.left - (performance.now() - wcJobBase.t)) : 0;
    let html = `<div class="wc-row"><span class="wc-ico">🪙</span><span><small>UNBANKED</small><b>${numberWithCommas(Math.floor(worldState.sessionCoins || 0))}</b></span></div>`;
    if (j) html += `<div class="wc-row${left < 180000 ? ' wc-warn' : ''}"><span class="wc-ico">💼</span><span><small>${escapeHTML(j.name)} · ${escapeHTML(j.rank || '')} ${escapeHTML(j.role || '')}</small><b>Shift due ${wcFmtMs(left)}</b></span>${['courier', 'taxi', 'guide'].includes(j.kind) ? `<button class="wc-btn" data-act="gig">${wcMission ? '✖ Cancel job' : '▶ Next job'} <kbd>J</kbd></button>` : ''}</div>`;
    if (worldState.car) { const fu = worldState.car.fuel ?? 100; html += `<div class="wc-row${fu < 15 ? ' wc-warn' : ''}"><span class="wc-ico">🚗</span><span><small>CAR · FUEL</small><b>${worldState.car.driven ? 'Driving' : 'Parked'} · ${Math.round(fu)}%</b><i class="wc-fuel"><i style="width:${Math.max(0, Math.min(100, fu))}%;background:${fu < 15 ? '#ff6b5a' : fu < 35 ? '#ffb000' : '#5fd38a'}"></i></i></span></div>`; }
    if (worldState.souv) html += `<div class="wc-row"><span class="wc-ico">🎁</span><span><small>SOUVENIRS</small><b>${worldState.souv.length}/${worldState.souvTotal || 8}</b></span></div>`;
    if (worldState.stay) html += `<div class="wc-row"><span class="wc-ico">🏨</span><span><small>${escapeHTML(worldState.stay.name)}</small><b>Room ${wcFmtMs(worldState.stay.left - (performance.now() - (wcJobBase.st || performance.now())))}</b></span></div>`;
    html += `<div class="wc-row"><button class="wc-btn" data-act="taxi">🚕 Taxi</button><button class="wc-btn" data-act="map">🗺 Map</button></div>`;
    if (chip.dataset.h !== html) {
        chip.dataset.h = html; chip.innerHTML = html;
        chip.querySelectorAll('.wc-btn').forEach(b => b.addEventListener('click', ev => { ev.stopPropagation(); const a = b.dataset.act; if (a === 'gig') wcGigKey(); else if (a === 'taxi') wcMapToggle(true, 'taxi'); else wcMapToggle(true); }));
    }
}
function wcToast(msg, level) {
    const box = document.getElementById('world-toast'); if (!box) return;
    const el = document.createElement('div'); el.className = 'wt ' + (level || ''); el.textContent = msg; box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 4200);
}
function wcRenderTask() {
    const el = document.getElementById('world-task'); if (!el) return;
    if (WC.task < 0) { el.style.display = 'none'; return; }
    el.style.display = 'block'; el.querySelector('i').style.width = Math.round(WC.task * 100) + '%'; el.querySelector('span').textContent = 'Working… ' + Math.round(WC.task * 100) + '%';
}
function wcRenderPrompt() {
    const el = document.getElementById('world-prompt'); if (!el) return;
    const p = WC.prompt;
    if (!p) { el.style.display = 'none'; el.dataset.id = ''; return; }
    let firstOn = true;
    const acts = (p.actions || []).map(a => {
        const key = (a.on !== false && firstOn && !p.pick) ? '<kbd>F</kbd>' : ''; if (a.on !== false) firstOn = false;
        return `<button class="wp-btn" ${a.on === false ? 'disabled' : ''} data-a="${escapeHTML(a.a)}">${key}${escapeHTML(a.label)}</button>`;
    }).join('');
    el.className = p.mini ? 'mini' : p.pick ? 'wide' : '';
    el.innerHTML = `<div class="wp-title">${escapeHTML(p.title || '')}</div>${(p.lines || []).map(l => `<div class="wp-line">${escapeHTML(l)}</div>`).join('')}${acts ? `<div class="wp-actions">${acts}</div>` : ''}`;
    el.dataset.id = p.id; el.style.display = 'block';
    el.querySelectorAll('.wp-btn').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); worldSend('world_interact', { id: p.id, a: b.dataset.a }); }));
}
function worldInteractPrimary() {
    const p = WC.prompt; if (!p || p.pick) return;              // pick-lists (flight destinations) need an explicit click
    const a = (p.actions || []).find(x => x.on !== false); if (a) worldSend('world_interact', { id: p.id, a: a.a });
}
function wcPositionPrompt() {
    const el = document.getElementById('world-prompt'); if (!el || !WC.prompt) return;
    let sx = worldToScreenX(WC.prompt.ax), sy = worldToScreenY(WC.prompt.ay);
    const w = el.offsetWidth || 220, h = el.offsetHeight || 80;
    sx = Math.max(w / 2 + 10, Math.min(canvas.width - w / 2 - 10, sx)); sy = Math.max(h + 16, Math.min(canvas.height - 20, sy));
    el.style.transform = `translate(${Math.round(sx - w / 2)}px, ${Math.round(sy - h - 8)}px)`;
}

// ---- field of view: zooms out as the tank grows and as the car speeds up --------------------------
let fovTarget = BASE_FOV;
function worldFovMultiplier() {
    let m = 1 + ((myStats.level || 1) - 1) * 0.011;
    const me = myId != null ? gameState.entities.find(e => e.id === myId) : null;
    if (me && me.veh) m *= 1 + Math.min(0.5, Math.abs(me.veh.v) * 0.05);
    if (me && me.fl) m *= 1.4 + 1.6 * me.fl.alt;                    // planes: the view opens up as you climb
    return m;
}

// ---- procedural textures (world-anchored patterns) ----------------------------------------------------
let wcTex = null;
function wcMakeTex() {
    const mk = (size, fn) => { const c = document.createElement('canvas'); c.width = c.height = size; fn(c.getContext('2d'), size); return c; };
    let seed = 1337; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const speckle = (g, s, n, cols, rmin, rmax) => { for (let i = 0; i < n; i++) { g.fillStyle = cols[Math.floor(rnd() * cols.length)]; const r = rmin + rnd() * (rmax - rmin); g.fillRect(rnd() * s, rnd() * s, r, r); } };
    wcTex = {
        asphalt: mk(128, (g, s) => { g.fillStyle = '#3b4146'; g.fillRect(0, 0, s, s); speckle(g, s, 900, ['#444a50', '#33393e', '#4b5157', '#30363a'], 1, 2.4); }),
        pave: mk(104, (g, s) => { g.fillStyle = '#cbc8bd'; g.fillRect(0, 0, s, s); speckle(g, s, 160, ['#c2bfb4', '#d3d0c5'], 1, 3); g.strokeStyle = 'rgba(120,116,104,.35)'; g.lineWidth = 1.2; for (let i = 0; i <= s; i += 26) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); } }),
        concrete: mk(128, (g, s) => { g.fillStyle = '#b6b5ab'; g.fillRect(0, 0, s, s); speckle(g, s, 500, ['#aeada3', '#bebdb3', '#a8a79e'], 1, 2.4); g.strokeStyle = 'rgba(90,90,82,.22)'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, s - 1, s - 1); }),
        grass: mk(128, (g, s) => { g.fillStyle = '#8bb06d'; g.fillRect(0, 0, s, s); speckle(g, s, 1100, ['#82a866', '#94b876', '#7ba061', '#9cbf80'], 1, 2.6); }),
        lawn: mk(128, (g, s) => { g.fillStyle = '#7fae66'; g.fillRect(0, 0, s, s); speckle(g, s, 1100, ['#76a55d', '#88b76f', '#6e9d56'], 1, 2.6); }),
        forest: mk(128, (g, s) => { g.fillStyle = '#5f8d52'; g.fillRect(0, 0, s, s); speckle(g, s, 900, ['#567f49', '#689659', '#4f7742'], 1, 3); }),
        dirt: mk(128, (g, s) => { g.fillStyle = '#a68a58'; g.fillRect(0, 0, s, s); speckle(g, s, 600, ['#9a7f4f', '#b09462', '#8f7548'], 1, 2.6); }),
        cobble: mk(96, (g, s) => { g.fillStyle = '#8c8275'; g.fillRect(0, 0, s, s); for (let y = 0; y < s; y += 12) for (let x = (y / 12 % 2) * 8; x < s + 16; x += 16) { g.fillStyle = ['#a39887', '#978c7c', '#ab9f8d', '#8f8473'][Math.floor(rnd() * 4)]; wcRR(g, x - 7, y + 1, 14, 10, 3); g.fill(); } }),
        plaza: mk(104, (g, s) => { g.fillStyle = '#d8d2c0'; g.fillRect(0, 0, s, s); g.strokeStyle = 'rgba(140,130,108,.4)'; g.lineWidth = 1.2; for (let i = 0; i <= s; i += 52) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); } speckle(g, s, 90, ['#cfc8b4', '#e0dac8'], 1, 3); })
    };
    for (const k of Object.keys(wcTex)) wcTex[k] = { canvas: wcTex[k], size: wcTex[k].width, pat: null };
}
function wcTexPattern(name) { const t = wcTex[name]; if (!t.pat) t.pat = ctx.createPattern(t.canvas, 'repeat'); return t; }
// fill a world rect with a pattern that stays pinned to the world (does not slide while the camera moves)
function wcFillTex(name, x, y, w, h, worldTile = 96) {
    const t = wcTexPattern(name), s = 1 / fov, k = s * worldTile / t.size;
    const per = worldTile;                                // pattern period in world units: keep the offset small for float precision far from the origin
    if (t.pat.setTransform) t.pat.setTransform(new DOMMatrix([k, 0, 0, k, -(((camera.x % per) + per) % per) * s, -(((camera.y % per) + per) % per) * s]));
    ctx.fillStyle = t.pat; ctx.fillRect(worldToScreenX(x), worldToScreenY(y), w * s, h * s);
}

// ---- sprite cache ---------------------------------------------------------------------------------------------
const wcSpriteCache = new Map();
let wcSPR = 1.25;
function worldOnResize() { wcSPR = Math.max(1, Math.min(2.2, Math.round(2 / (baseFov * 0.74)) / 2)); wcSpriteCache.clear(); wcIntCache = null; }
function wcSprite(key, w, h, paint) {
    let s = wcSpriteCache.get(key);
    if (s) return s;
    const c = document.createElement('canvas'); c.width = Math.ceil((w + WC_PAD * 2) * wcSPR); c.height = Math.ceil((h + WC_PAD * 2) * wcSPR);
    const g = c.getContext('2d'); g.scale(wcSPR, wcSPR); g.translate(WC_PAD, WC_PAD); paint(g);
    if (wcSpriteCache.size > 700) wcSpriteCache.delete(wcSpriteCache.keys().next().value);
    wcSpriteCache.set(key, c); return c;
}
function wcBlit(spr, x, y) { const s = 1 / fov; ctx.drawImage(spr, worldToScreenX(x) - WC_PAD * s, worldToScreenY(y) - WC_PAD * s, spr.width / wcSPR * s, spr.height / wcSPR * s); }
const wcRR = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
function wcShade(hex, amt) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(v + amt))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }
function wcRng(seed) { let a = (seed | 0) + 0x6D2B79F5; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---- vehicles ----------------------------------------------------------------------------------------------------
const WC_CAR_DIMS = [[52, 29], [60, 31], [62, 30]];     // owned models: compact, sedan, sport
function wcDrawCarBody(g, w, h, color, style) {
    // top-down: shadow, wheels, body, glass, lights. Car faces +x.
    g.fillStyle = 'rgba(0,0,0,.3)'; wcRR(g, -w / 2 + 3, -h / 2 + 4, w, h, 9); g.fill();
    g.fillStyle = '#12171b'; for (const [wx, wy] of [[-w * .32, -h / 2 - 1], [w * .2, -h / 2 - 1], [-w * .32, h / 2 - 5], [w * .2, h / 2 - 5]]) { wcRR(g, wx - 5, wy, 11, 6, 2); g.fill(); }
    g.fillStyle = wcShade(color, -50); wcRR(g, -w / 2, -h / 2 + 1, w, h - 2, 9); g.fill();
    g.fillStyle = color; wcRR(g, -w / 2 + 1.5, -h / 2 + 2, w - 3, h - 4, 8); g.fill();
    g.fillStyle = 'rgba(255,255,255,.22)'; wcRR(g, -w / 2 + 6, -h / 2 + 3.5, w - 16, 3.5, 2); g.fill();
    if (style === 4) { g.fillStyle = '#1b1b1b'; for (let i = -w / 2 + 6; i < w / 2 - 6; i += 8) { g.fillRect(i, h / 2 - 5, 4, 3); g.fillRect(i + 4, -h / 2 + 2, 4, 3); } }
    if (style === 2) { g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(-w / 2 + 6, -2.2, w - 12, 1.8); g.fillRect(-w / 2 + 6, 1, w - 12, 1.8); }
    const cabW = style === 3 ? w * .72 : w * .46, cabX = style === 3 ? -w * .36 : -w * .2;
    g.fillStyle = '#26323a'; wcRR(g, cabX, -h / 2 + 4.5, cabW, h - 9, 5); g.fill();
    g.fillStyle = '#8db8c9'; g.beginPath(); g.moveTo(cabX + cabW - 2, -h / 2 + 6); g.lineTo(cabX + cabW + 5, -h / 2 + 8.5); g.lineTo(cabX + cabW + 5, h / 2 - 8.5); g.lineTo(cabX + cabW - 2, h / 2 - 6); g.closePath(); g.fill();
    g.fillStyle = '#6f98aa'; g.fillRect(cabX + 2, -h / 2 + 6, 3, h - 12);
    g.fillStyle = color; wcRR(g, cabX + 6, -h / 2 + 6.5, cabW - 11, h - 13, 3); g.fill();
    if (style === 4) { g.fillStyle = '#fff6c9'; wcRR(g, -8, -6, 16, 12, 2); g.fill(); g.fillStyle = '#222'; g.font = 'bold 5px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('TAXI', 0, 0.5); }
    g.fillStyle = '#fff3c4'; g.fillRect(w / 2 - 4, -h / 2 + 4, 3, 5); g.fillRect(w / 2 - 4, h / 2 - 9, 3, 5);
    g.fillStyle = '#d4443d'; g.fillRect(-w / 2 + 1, -h / 2 + 4, 3, 5); g.fillRect(-w / 2 + 1, h / 2 - 9, 3, 5);
}
function wcCarSprite(color, style, w, h) {
    const key = 'car' + color + style + w;
    let s = wcSpriteCache.get(key); if (s) return s;
    const c = document.createElement('canvas'); c.width = Math.ceil((w + 14) * wcSPR); c.height = Math.ceil((h + 14) * wcSPR);
    const g = c.getContext('2d'); g.scale(wcSPR, wcSPR); g.translate((w + 14) / 2, (h + 14) / 2); wcDrawCarBody(g, w, h, color, style);
    c._w = w + 14; c._h = h + 14; wcSpriteCache.set(key, c); return c;
}
function wcBlitCar(spr, x, y, a) {
    const s = 1 / fov, sx = worldToScreenX(x), sy = worldToScreenY(y);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(a); ctx.drawImage(spr, -spr._w / 2 * s, -spr._h / 2 * s, spr._w * s, spr._h * s); ctx.restore();
}
function wcDrawVehicleEntity(context, rPos, en) {
    const m = WC.cars.findIndex(c => c.id === en.veh.m), spec = WC.cars[m] || { color: '#cccccc' }, dim = WC_CAR_DIMS[Math.max(0, m)];
    rPos.vehA = lerpAngle(rPos.vehA !== undefined ? rPos.vehA : en.veh.a, en.veh.a, 0.35);
    const spr = en.veh.m === 'taxi' ? wcCarSprite('#f2c014', 4, 58, 30) : wcCarSprite(spec.color, m === 2 ? 2 : 0, dim[0], dim[1]), s = 1 / fov;
    context.save(); context.rotate(rPos.vehA); context.drawImage(spr, -spr._w / 2 * s, -spr._h / 2 * s, spr._w * s, spr._h * s); context.restore();
}

// ---- building painters (drawn once into cached sprites, in world units; origin = building top-left) -------------------
const WC_ROOF = ['#76828d', '#85919a', '#6d7986', '#8a9692', '#68767f', '#7c8691'];
const WC_HOUSE_ROOF = ['#8f5140', '#6e4b42', '#a56a4b', '#566a78', '#745a49', '#8a6847'];
const WC_AWN = [['#c0392b', '#f4efe4'], ['#2c7a5b', '#f4efe4'], ['#2f5f9e', '#f4efe4'], ['#d68a1c', '#f4efe4'], ['#7a3f8f', '#f4efe4'], ['#1f7f8c', '#f4efe4']];
function wcShadow(g, w, h, len) {
    g.fillStyle = 'rgba(8,12,16,.30)'; g.beginPath(); g.moveTo(len * .35, len * .45); g.lineTo(w + len, len * .45); g.lineTo(w + len, h + len); g.lineTo(len * .35, h + len); g.closePath(); g.fill();
}
function wcDoorMark(g, b, accent) {
    const d = b.door, dx = d.x - b.x, dy = d.y - b.y;
    g.save(); g.translate(dx, dy);
    const rot = { S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[d.dir] || 0; g.rotate(rot);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(-22, 1, 44, 17);
    g.fillStyle = accent || '#3a4650'; wcRR(g, -22, -2, 44, 15, 3); g.fill();
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(-20, -1, 40, 3);
    g.fillStyle = '#1d252b'; g.fillRect(-13, -9, 26, 9); g.fillStyle = '#7fb1c4'; g.fillRect(-11, -7.5, 10, 6); g.fillRect(1, -7.5, 10, 6);
    g.restore();
}
function wcBanner(g, text, cx, cy, maxW, h, color, txt = '#fff') {
    g.save(); g.font = `bold ${h * 0.62}px Ubuntu, Arial`; const tw = Math.min(maxW, g.measureText(text).width + h);
    g.fillStyle = 'rgba(0,0,0,.28)'; wcRR(g, cx - tw / 2 + 2, cy - h / 2 + 3, tw, h, 5); g.fill();
    g.fillStyle = color; wcRR(g, cx - tw / 2, cy - h / 2, tw, h, 5); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.4; wcRR(g, cx - tw / 2 + 2, cy - h / 2 + 2, tw - 4, h - 4, 4); g.stroke();
    g.fillStyle = txt; g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = h * 0.62; while (fs > 6 && g.measureText(text).width > tw - 8) { fs -= 1; g.font = `bold ${fs}px Ubuntu, Arial`; }
    g.fillText(text, cx, cy + 1); g.restore();
}
function wcRoofClutter(g, b, rnd, inset) {
    const w = b.w, h = b.h;
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
        const rw = 24 + rnd() * 36, rh = 18 + rnd() * 26, x = inset + rnd() * Math.max(1, w - 2 * inset - rw), y = inset + rnd() * Math.max(1, h - 2 * inset - rh);
        g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + 3, y + 3, rw, rh);
        g.fillStyle = '#4c5963'; g.fillRect(x, y, rw, rh); g.fillStyle = '#6b7a85'; g.fillRect(x + 2, y + 2, rw - 4, 3);
        if (rnd() < 0.7) { g.fillStyle = '#2c353c'; g.beginPath(); g.arc(x + rw / 2, y + rh / 2 + 2, Math.min(rw, rh) * 0.28, 0, 7); g.fill(); g.strokeStyle = '#8c9aa4'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + rw / 2 - 5, y + rh / 2 + 2); g.lineTo(x + rw / 2 + 5, y + rh / 2 + 2); g.moveTo(x + rw / 2, y + rh / 2 - 3); g.lineTo(x + rw / 2, y + rh / 2 + 7); g.stroke(); }
    }
    if (rnd() < 0.3) { const px = w * 0.5, py = h * 0.5, r = Math.min(w, h) * 0.2; g.fillStyle = '#3e4750'; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill(); g.strokeStyle = '#e6c94a'; g.lineWidth = 3; g.beginPath(); g.arc(px, py, r - 3, 0, 7); g.stroke(); g.fillStyle = '#e6c94a'; g.font = `bold ${r}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', px, py + 1); }
    else if (rnd() < 0.5) { for (let i = 0; i < 6; i++) { g.fillStyle = '#27465e'; g.fillRect(inset + 4 + (i % 3) * 30, h - inset - 34 + Math.floor(i / 3) * 16, 26, 12); g.fillStyle = 'rgba(160,200,230,.4)'; g.fillRect(inset + 4 + (i % 3) * 30, h - inset - 34 + Math.floor(i / 3) * 16, 26, 3); } }
}
function wcPaintTower(g, b, low) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), base = WC_ROOF[(b.t || 0) % 6];
    wcShadow(g, w, h, Math.min(36, (b.f || 8) * 1.5));
    g.fillStyle = wcShade(base, -46); g.fillRect(0, 0, w, h);
    g.fillStyle = wcShade(base, -20); g.fillRect(3, 3, w - 6, h - 6);
    g.fillStyle = base; g.fillRect(7, 7, w - 14, h - 14);
    g.strokeStyle = 'rgba(255,255,255,.2)'; g.lineWidth = 1.4; g.strokeRect(10, 10, w - 20, h - 20);
    g.strokeStyle = 'rgba(0,0,0,.07)'; g.lineWidth = 1; for (let x = 10; x < w - 10; x += 24) { g.beginPath(); g.moveTo(x, 10); g.lineTo(x, h - 10); g.stroke(); } for (let y = 10; y < h - 10; y += 24) { g.beginPath(); g.moveTo(10, y); g.lineTo(w - 10, y); g.stroke(); }
    wcRoofClutter(g, b, rnd, 14);
    if (b.work) { wcBanner(g, b.sign.toUpperCase(), w / 2, h * 0.5, w - 22, Math.min(30, h * 0.16), b.col); }
    wcDoorMark(g, b, b.work ? b.col : null);
}
function wcPaintShop(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), aw = WC_AWN[(b.aw || 0) % 6];
    wcShadow(g, w, h, 12);
    g.fillStyle = '#8d8a80'; g.fillRect(0, 0, w, h); g.fillStyle = '#cfcabb'; g.fillRect(4, 4, w - 8, h - 8);
    g.strokeStyle = 'rgba(0,0,0,.1)'; for (let x = 12; x < w - 4; x += 16) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }
    wcRoofClutter(g, { w, h }, rnd, 10);
    // striped awning over the door side
    const dd = b.door, dx = dd.x - b.x, dy = dd.y - b.y; g.save(); g.translate(dx, dy); g.rotate({ S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[dd.dir] || 0);
    const aw2 = Math.min(w - 10, 70); for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? aw[1] : aw[0]; g.fillRect(-aw2 / 2 + i * aw2 / 10, -6, aw2 / 10 + .5, 22); }
    g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(-aw2 / 2, 16, aw2, 3); g.restore();
}
function wcPaintApt(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), base = ['#b7ab98', '#a9a597', '#bbb1a2', '#a8aeb0', '#b5a9a0', '#a7a79b'][(b.t || 0) % 6];
    wcShadow(g, w, h, 18);
    g.fillStyle = wcShade(base, -50); g.fillRect(0, 0, w, h); g.fillStyle = base; g.fillRect(4, 4, w - 8, h - 8);
    g.fillStyle = wcShade(base, 14); g.fillRect(4, 4, w - 8, (h - 8) / 2);
    g.strokeStyle = 'rgba(0,0,0,.12)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(4, h / 2); g.lineTo(w - 4, h / 2); g.stroke();
    for (let x = 30; x < w - 30; x += 60 + rnd() * 30) { g.fillStyle = '#6e5e50'; g.fillRect(x, h / 2 - 11, 22, 22); g.fillStyle = '#8c7b6b'; g.fillRect(x + 2, h / 2 - 9, 18, 4); }
    wcRoofClutter(g, b, rnd, 12); wcDoorMark(g, b);
}
function wcPaintMall(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1);
    wcShadow(g, w, h, 20); g.fillStyle = '#7a7d80'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8c9c3'; g.fillRect(5, 5, w - 10, h - 10);
    for (let i = 0; i < 5; i++) { const sx = 24 + i * (w - 48) / 5; g.fillStyle = '#7fb3c6'; g.fillRect(sx, h * 0.3, (w - 48) / 5 - 14, h * 0.4); g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.3; g.strokeRect(sx, h * 0.3, (w - 48) / 5 - 14, h * 0.4); for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(sx + k * ((w - 48) / 5 - 14) / 4, h * 0.3); g.lineTo(sx + k * ((w - 48) / 5 - 14) / 4, h * 0.7); g.stroke(); } }
    wcBanner(g, 'CENTRAL MALL', w / 2, 24, w * 0.5, 26, '#c0392b'); wcRoofClutter(g, { w, h: h * 0.9 }, rnd, 12); wcDoorMark(g, b, '#c0392b');
}
function wcPaintBank(g, b) {
    const w = b.w, h = b.h;
    wcShadow(g, w, h, 24);
    g.fillStyle = '#9fa49f'; g.fillRect(0, 0, w, h); g.fillStyle = '#e4e0d3'; g.fillRect(5, 5, w - 10, h - 10);
    g.strokeStyle = 'rgba(120,110,90,.35)'; g.lineWidth = 1.2; for (let i = 14; i < w - 10; i += 28) { g.beginPath(); g.moveTo(i, 5); g.lineTo(i, h - 5); g.stroke(); }
    const r = Math.min(w, h) * 0.26, cx = w / 2, cy = h * 0.46;
    const gr = g.createRadialGradient(cx - r * .3, cy - r * .3, r * .1, cx, cy, r); gr.addColorStop(0, '#bfe0ec'); gr.addColorStop(1, '#3d7a96');
    g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(cx + 5, cy + 6, r, 0, 7); g.fill(); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2; for (let a = 0; a < 8; a++) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a * Math.PI / 4) * r, cy + Math.sin(a * Math.PI / 4) * r); g.stroke(); }
    g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
    wcBanner(g, 'BANK', w / 2, h * 0.14, w * 0.46, 36, '#1f4e79');
    for (let i = 0; i < 8; i++) { g.fillStyle = '#f2efe6'; g.beginPath(); g.arc(30 + i * (w - 60) / 7, h - 16, 6, 0, 7); g.fill(); g.strokeStyle = '#9a9588'; g.lineWidth = 1; g.stroke(); }
    wcDoorMark(g, b, '#1f4e79');
}
function wcPaintDealer(g, b) {
    const w = b.w, h = b.h;
    wcShadow(g, w, h, 16);
    g.fillStyle = '#58656e'; g.fillRect(0, 0, w, h); g.fillStyle = '#a9cfdc'; g.fillRect(5, 5, w - 10, h - 10);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(5, 5); g.lineTo(w * .55, 5); g.lineTo(5, h * .6); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(40,70,90,.45)'; g.lineWidth = 1.3; for (let x = 5; x < w - 5; x += 40) { g.beginPath(); g.moveTo(x, 5); g.lineTo(x, h - 5); g.stroke(); } for (let y = 5; y < h - 5; y += 40) { g.beginPath(); g.moveTo(5, y); g.lineTo(w - 5, y); g.stroke(); }
    const cols = ['#e4e7eb', '#2684d9', '#e84d4d'], dims = [[52, 29], [60, 31], [62, 30]];
    for (let i = 0; i < 3; i++) { g.save(); g.translate(w * (0.2 + i * 0.3), h * 0.52); g.rotate(-0.5 + i * 0.5); wcDrawCarBody(g, dims[i][0], dims[i][1], cols[i], i === 2 ? 2 : 0); g.restore(); }
    wcBanner(g, 'MOTORS', w / 2, 24, w * 0.5, 28, '#c0392b'); wcDoorMark(g, b, '#c0392b');
}
function wcPaintHall(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 26);
    g.fillStyle = '#8c897f'; g.fillRect(0, 0, w, h); g.fillStyle = '#d6d1c2'; g.fillRect(5, 5, w - 10, h - 10);
    g.fillStyle = '#c4bfae'; g.fillRect(5, h * 0.62, w - 10, h * 0.2);
    const r = Math.min(w, h) * 0.28, cx = w / 2, cy = h * 0.38, gr = g.createRadialGradient(cx - r * .3, cy - r * .35, 2, cx, cy, r); gr.addColorStop(0, '#9fd6c6'); gr.addColorStop(1, '#3a7c6a');
    g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(cx + 5, cy + 6, r, 0, 7); g.fill(); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    g.fillStyle = '#e8e3d3'; g.beginPath(); g.arc(cx, cy, r * 0.22, 0, 7); g.fill();
    wcBanner(g, 'CITY HALL', w / 2, h * 0.84, w * 0.5, 26, '#4a4a52');
    for (let i = 0; i < 7; i++) { g.fillStyle = '#f2efe6'; g.beginPath(); g.arc(34 + i * (w - 68) / 6, h - 14, 5.5, 0, 7); g.fill(); }
    wcDoorMark(g, b, '#4a4a52');
}
function wcPaintHouse(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), col = WC_HOUSE_ROOF[(b.r || 0) % 6], horiz = w >= h;
    wcShadow(g, w, h, 14);
    g.fillStyle = '#e6dcc8'; g.fillRect(-3, -3, w + 6, h + 6);
    const light = wcShade(col, 18), dark = wcShade(col, -20);
    if (horiz) { g.fillStyle = light; g.fillRect(0, 0, w, h / 2); g.fillStyle = dark; g.fillRect(0, h / 2, w, h / 2); g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1; for (let y = 6; y < h; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); }
    else { g.fillStyle = light; g.fillRect(0, 0, w / 2, h); g.fillStyle = dark; g.fillRect(w / 2, 0, w / 2, h); g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1; for (let x = 6; x < w; x += 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke(); }
    if (b.gar) { const left = (b.s || 0) % 2 === 0, gw = w * 0.3; g.fillStyle = '#b5b1a6'; g.fillRect(left ? 0 : w - gw, 0, gw, h); g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1.2; g.strokeRect(left ? 1 : w - gw + 1, 1, gw - 2, h - 2); }
    g.fillStyle = '#6e6458'; g.fillRect(w * (0.3 + rnd() * 0.3), h * 0.18, 9, 12); g.fillStyle = '#a99c8d'; g.fillRect(w * 0.3 - 1, h * 0.18 - 1, 11, 2);
    if (b.por || b.k === 'farmhouse') { const d = b.door, dx = d.x - b.x, dy = d.y - b.y; g.save(); g.translate(dx, dy); g.rotate({ S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[d.dir] || 0); g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(-17, 1, 38, 15); g.fillStyle = '#d9cdb2'; g.fillRect(-18, -1, 36, 14); g.fillStyle = '#6d5d4a'; g.fillRect(-16, 9, 3, 4); g.fillRect(13, 9, 3, 4); g.restore(); }
    wcDoorMark(g, { door: b.door, x: b.x, y: b.y }, '#6d4a38');
}
function wcPaintBarn(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 20);
    g.fillStyle = '#7a2d26'; g.fillRect(0, 0, w, h); g.fillStyle = '#a63d33'; g.fillRect(4, 4, w - 8, h / 2 - 4); g.fillStyle = '#8f332b'; g.fillRect(4, h / 2, w - 8, h / 2 - 4);
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1; for (let x = 10; x < w; x += 10) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }
    g.strokeStyle = '#efe7d6'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); wcDoorMark(g, b, '#efe7d6');
}
function wcPaintShed(g, b) { const w = b.w, h = b.h; wcShadow(g, w, h, 8); g.fillStyle = '#6c7378'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a9298'; g.fillRect(3, 3, w - 6, h - 6); g.strokeStyle = 'rgba(0,0,0,.2)'; for (let x = 8; x < w; x += 8) { g.beginPath(); g.moveTo(x, 3); g.lineTo(x, h - 3); g.stroke(); } wcDoorMark(g, b); }
function wcPaintSchool(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 16);
    g.fillStyle = '#7d4637'; g.fillRect(0, 0, w, h); g.fillStyle = '#b0674d'; g.fillRect(5, 5, w - 10, h - 10);
    g.fillStyle = '#8fa67a'; g.fillRect(w * 0.32, h * 0.3, w * 0.36, h * 0.4); g.strokeStyle = '#d9d2bd'; g.lineWidth = 3; g.strokeRect(w * 0.32, h * 0.3, w * 0.36, h * 0.4);
    wcBanner(g, 'SCHOOL', w / 2, h * 0.14, w * 0.3, 24, '#2f5f9e'); wcDoorMark(g, b, '#2f5f9e');
}

// ---- airports: terminal / control tower / hangar painters, runway decals and airliners ---------------------------
function wcPaintTerminal(g, b) {
    const w = b.w, h = b.h, glassTop = b.door.dir === 'N';
    wcShadow(g, w, h, 22);
    g.fillStyle = '#7f8a92'; g.fillRect(0, 0, w, h); g.fillStyle = '#d7dde0'; g.fillRect(5, 5, w - 10, h - 10);
    // saw-tooth skylights across the roof
    for (let x = 30; x < w - 40; x += 70) { g.fillStyle = '#9fc4d6'; g.fillRect(x, h * 0.28, 34, h * 0.44); g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x, h * 0.28, 34, 5); }
    // glass curtain wall on the landside (door) face, airside piers on the other
    const gy = glassTop ? 5 : h - 23; g.fillStyle = '#4f86a3'; g.fillRect(5, gy, w - 10, 18); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1; for (let x = 12; x < w - 10; x += 18) { g.beginPath(); g.moveTo(x, gy); g.lineTo(x, gy + 18); g.stroke(); }
    const py = glassTop ? h - 5 : 5, dir = glassTop ? 1 : -1;
    for (const px of [w / 2 - 380, w / 2 + 380]) { g.fillStyle = '#b9c2c7'; g.fillRect(px - 16, Math.min(py, py + dir * 40), 32, 40); g.strokeStyle = 'rgba(0,0,0,.25)'; g.strokeRect(px - 16, Math.min(py, py + dir * 40), 32, 40); }
    wcBanner(g, `✈ ${b.nm || ''} AIRPORT · ${b.code || ''}`, w / 2, h / 2, w * 0.62, 40, '#1d4f7a');
    wcDoorMark(g, b, '#1d4f7a');
}
function wcPaintCTower(g, b) {
    const r = Math.min(b.w, b.h) / 2;
    g.fillStyle = 'rgba(8,12,16,.3)'; g.beginPath(); g.ellipse(r + 34, r + 40, r, r * 0.9, 0, 0, 7); g.fill();
    g.fillStyle = '#e9ecef'; g.beginPath(); g.arc(r, r, r, 0, 7); g.fill();
    g.fillStyle = '#2b4f66'; g.beginPath(); g.arc(r, r, r * 0.82, 0, 7); g.fill();
    g.strokeStyle = 'rgba(160,220,255,.6)'; g.lineWidth = 2; for (let a = 0; a < 12; a++) { g.beginPath(); g.moveTo(r, r); g.lineTo(r + Math.cos(a / 12 * 6.283) * r * 0.82, r + Math.sin(a / 12 * 6.283) * r * 0.82); g.stroke(); }
    g.fillStyle = '#d9dde0'; g.beginPath(); g.arc(r, r, r * 0.42, 0, 7); g.fill(); g.fillStyle = '#c0392b'; g.beginPath(); g.arc(r, r, 6, 0, 7); g.fill();
}
function wcPaintHangar(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 20);
    g.fillStyle = '#5f6b73'; g.fillRect(0, 0, w, h);
    const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#8d99a1'); gr.addColorStop(0.5, '#c9d1d6'); gr.addColorStop(1, '#8d99a1');
    g.fillStyle = gr; g.fillRect(4, 4, w - 8, h - 8);
    g.strokeStyle = 'rgba(0,0,0,.16)'; g.lineWidth = 1.2; for (let x = 16; x < w - 6; x += 16) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }
    const dy = b.door.dir === 'N' ? 0 : h - 10; g.fillStyle = '#e1b53a'; g.fillRect(20, dy, w - 40, 10);
    wcBanner(g, 'HANGAR', w / 2, h / 2, w * 0.5, 30, '#3a4650');
}
const WC_LIVERY = [['#1d6fa5', '#f2b233', 'DITANKS AIR'], ['#c0392b', '#f4efe4', 'REDLINE'], ['#2c7a5b', '#e9e2c9', 'EVERGREEN'], ['#7a3f8f', '#f1c40f', 'VIOLET JET'], ['#d68a1c', '#2b3138', 'SUNWING'], ['#1f7f8c', '#f4efe4', 'TEAL SKY']];
// Top-down airliner facing +x, centred on (0,0): 230 long, 210 wingspan.
function wcPlanePath(g) {
    g.beginPath();
    g.moveTo(-104, -40); g.lineTo(-90, -40); g.lineTo(-80, -10); g.lineTo(-34, -12); g.lineTo(-62, -104); g.lineTo(-40, -104); g.lineTo(30, -14);
    g.lineTo(98, -12); g.quadraticCurveTo(122, -9, 122, 0); g.quadraticCurveTo(122, 9, 98, 12);
    g.lineTo(30, 14); g.lineTo(-40, 104); g.lineTo(-62, 104); g.lineTo(-34, 12); g.lineTo(-80, 10); g.lineTo(-90, 40); g.lineTo(-104, 40); g.lineTo(-100, 9); g.lineTo(-112, 6); g.lineTo(-112, -6); g.lineTo(-100, -9);
    g.closePath();
}
function wcPlaneSprite(liv, shadow) {
    const key = (shadow ? 'plS' : 'pl') + liv;
    let c = wcSpriteCache.get(key); if (c) return c;
    c = document.createElement('canvas'); c.width = Math.ceil(260 * wcSPR); c.height = Math.ceil(230 * wcSPR);
    const g = c.getContext('2d'); g.scale(wcSPR, wcSPR); g.translate(125, 115);
    if (shadow) { g.fillStyle = 'rgba(6,10,16,.32)'; wcPlanePath(g); g.fill(); }
    else {
        const L = WC_LIVERY[liv % WC_LIVERY.length];
        // engines under the wings
        g.fillStyle = '#59636b'; for (const y of [-46, 46]) { wcRR(g, 2, y - 8, 34, 16, 7); g.fill(); }
        g.fillStyle = '#eef1f3'; wcPlanePath(g); g.fill(); g.strokeStyle = 'rgba(40,50,60,.45)'; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = 'rgba(0,0,0,.08)'; g.beginPath(); g.moveTo(30, 14); g.lineTo(-40, 104); g.lineTo(-62, 104); g.lineTo(-34, 12); g.closePath(); g.fill();
        g.fillStyle = L[0]; g.fillRect(-100, -3.5, 196, 7);                       // livery stripe
        g.fillStyle = L[0]; g.beginPath(); g.moveTo(-112, -3); g.lineTo(-86, -3); g.lineTo(-78, 0); g.lineTo(-86, 3); g.lineTo(-112, 3); g.closePath(); g.fill();   // fin
        g.fillStyle = L[1]; for (const y of [-92, 92]) { g.beginPath(); g.arc(-52, y, 5, 0, 7); g.fill(); }
        g.fillStyle = '#1e2a33'; g.beginPath(); g.moveTo(104, -7); g.quadraticCurveTo(116, -5, 116, 0); g.quadraticCurveTo(116, 5, 104, 7); g.closePath(); g.fill();   // cockpit
        g.fillStyle = '#2d3e4a'; for (let x = -76; x < 94; x += 9) { g.fillRect(x, -11, 4, 2.4); g.fillRect(x, 8.6, 4, 2.4); }
        g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(-90, -9, 180, 2);
    }
    c._w = 260; c._h = 230; wcSpriteCache.set(key, c); return c;
}
// Draws an airliner at world (x, y) or, with `screen`, at the current context origin (entity renderer).
function wcDrawPlane(context, sx, sy, a, alt, liv) {
    const s = 1 / fov, k = 1 + 0.8 * alt, body = wcPlaneSprite(liv, false), sh = wcPlaneSprite(liv, true);
    context.save(); context.translate(sx + alt * 260 * s, sy + alt * 320 * s); context.rotate(a); context.scale(0.95, 0.95);
    context.globalAlpha = 1 - alt * 0.45; context.drawImage(sh, -125 * s, -115 * s, 260 * s, 230 * s); context.restore();
    context.save(); context.translate(sx, sy); context.rotate(a); context.scale(k, k);
    context.drawImage(body, -125 * s, -115 * s, 260 * s, 230 * s); context.restore();
}
// A player's flight: the plane, with the tank riding on top of the fuselage.
function wcDrawFlightEntity(context, rPos, en) {
    const f = en.fl;
    rPos.flA = lerpAngle(rPos.flA !== undefined ? rPos.flA : f.a, f.a, 0.3);
    rPos.flAlt = rPos.flAlt !== undefined ? rPos.flAlt + (f.alt - rPos.flAlt) * 0.2 : f.alt;
    wcDrawPlane(context, 0, 0, rPos.flA, rPos.flAlt, f.liv || 0);
    const k = (1 + 0.8 * rPos.flAlt) * 1.0;
    context.save(); context.scale(k, k); drawEntityBody(context, rPos); context.restore();
}
function wcDrawAirProp(p, s) {
    const X = v => worldToScreenX(v), Y = v => worldToScreenY(v), night = wcNightLevel();
    if (p.k === 'runway') {
        wcFillTex('asphalt', p.x, p.y, p.w, p.h, 110);
        const x0 = X(p.x), y0 = Y(p.y), w = p.w * s, h = p.h * s, cy = y0 + h / 2;
        ctx.fillStyle = 'rgba(245,245,240,.9)'; ctx.fillRect(x0, y0 + 6 * s, w, 3 * s); ctx.fillRect(x0, y0 + h - 9 * s, w, 3 * s);
        for (let x = 260; x < p.w - 260; x += 110) ctx.fillRect(X(p.x + x), cy - 2 * s, 60 * s, 4 * s);                     // centreline
        for (const end of [0, 1]) {                                                                                       // threshold bars + numbers
            const ex = end ? p.x + p.w - 70 : p.x + 20;
            for (let i = 0; i < 6; i++) { ctx.fillRect(X(ex), y0 + (14 + i * 18) * s, 50 * s, 9 * s); }
            if (s > 0.2) { ctx.save(); ctx.translate(X(end ? p.x + p.w - 120 : p.x + 120), cy); ctx.rotate(end ? -Math.PI / 2 : Math.PI / 2); ctx.font = `bold ${Math.max(6, 34 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(end ? '27' : '09', 0, 0); ctx.restore(); }
        }
        const lc = night > 0.15 ? `rgba(255,236,160,${0.6 + night * 0.4})` : 'rgba(255,240,190,.75)', lr = Math.max(1.2, (night > 0.15 ? 5 : 3) * s);
        ctx.fillStyle = lc; for (let x = 0; x <= p.w; x += 120) for (const yy of [y0 + 2 * s, y0 + h - 2 * s]) { ctx.beginPath(); ctx.arc(X(p.x + x), yy, lr, 0, 7); ctx.fill(); }
        if (s > 0.15) { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = `bold ${Math.max(7, 22 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText(p.code || '', X(p.x + p.w / 2), cy + 32 * s); }
    } else if (p.k === 'taxiway') {
        wcFillTex('asphalt', p.x, p.y, p.w, p.h, 110);
        const horiz = p.w >= p.h; ctx.strokeStyle = '#e6c23a'; ctx.lineWidth = Math.max(1, 3 * s); ctx.beginPath();
        if (horiz) { ctx.moveTo(X(p.x), Y(p.y + p.h / 2)); ctx.lineTo(X(p.x + p.w), Y(p.y + p.h / 2)); } else { ctx.moveTo(X(p.x + p.w / 2), Y(p.y)); ctx.lineTo(X(p.x + p.w / 2), Y(p.y + p.h)); }
        ctx.stroke();
        ctx.fillStyle = night > 0.15 ? 'rgba(90,150,255,.95)' : 'rgba(60,110,220,.8)';
        const len = horiz ? p.w : p.h; for (let t = 0; t <= len; t += 100) for (const side of [0, 1]) { const px = horiz ? p.x + t : p.x + side * p.w, py = horiz ? p.y + side * p.h : p.y + t; ctx.beginPath(); ctx.arc(X(px), Y(py), Math.max(1, 3 * s), 0, 7); ctx.fill(); }
    } else if (p.k === 'apron') {
        wcFillTex('concrete', p.x, p.y, p.w, p.h, 128);
        ctx.strokeStyle = 'rgba(60,60,55,.5)'; ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeRect(X(p.x), Y(p.y), p.w * s, p.h * s);
        const cy = p.y + p.h / 2 + (p.flip ? 5 : -5);
        ctx.strokeStyle = '#e6c23a'; ctx.lineWidth = Math.max(1, 3 * s);
        for (const [i, sx] of [[1, p.x + p.w / 2 - 380], [2, p.x + p.w / 2 + 380]]) {
            ctx.beginPath(); ctx.moveTo(X(sx), Y(p.flip ? p.y + p.h : p.y)); ctx.lineTo(X(sx), Y(cy)); ctx.moveTo(X(sx - 140), Y(cy)); ctx.lineTo(X(sx + 140), Y(cy)); ctx.stroke();
            if (s > 0.2) { ctx.fillStyle = '#e6c23a'; ctx.font = `bold ${Math.max(7, 30 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText(String(i), X(sx + 170), Y(cy + 10)); }
        }
    }
}
function wcDrawStaticPlane(p, s) {
    if (p.gate) for (const en of gameState.entities) if (en.fl && en.x != null && Math.abs(en.x - p.cx) < 400 && Math.abs(en.y - p.cy) < 400) return;   // the flight using this gate is drawn instead
    wcDrawPlane(ctx, worldToScreenX(p.cx), worldToScreenY(p.cy), p.a || 0, 0, p.liv || 0);
}
// Clouds between you and the ground while flying (they slide past faster than the ground: parallax).
function wcDrawClouds(W, H, alt) {
    if (alt < 0.05) return;
    const ccx = camera.x + W * fov / 2, ccy = camera.y + H * fov / 2, par = 1 + 0.5 * alt, CELL = 1500;
    const halfW = W * fov / 2 / par + CELL, halfH = H * fov / 2 / par + CELL, a0 = Math.min(1, alt * 1.4);
    ctx.save();
    for (let i = Math.floor((ccx - halfW) / CELL); i <= Math.floor((ccx + halfW) / CELL); i++) for (let j = Math.floor((ccy - halfH) / CELL); j <= Math.floor((ccy + halfH) / CELL); j++) {
        const r = wcRng(Math.imul(i, 73856093) ^ Math.imul(j + 7919, 19349663)); r(); if (r() > 0.62) continue;
        const wx = (i + r()) * CELL, wy = (j + r()) * CELL, size = 120 + r() * 220, n = 6 + Math.floor(r() * 6), stretch = 1.4 + r() * 1.2;
        const sx = W / 2 + (wx - ccx) * par / fov, sy = H / 2 + (wy - ccy) * par / fov, rr = size * par / fov;
        if (sx < -rr * 5 || sx > W + rr * 5 || sy < -rr * 3 || sy > H + rr * 3) continue;
        for (let q = 0; q < n; q++) {                                 // overlapping soft puffs: denser where they stack up
            const ox = (r() - 0.5) * rr * 2 * stretch, oy = (r() - 0.5) * rr * 0.9, pr = rr * (0.45 + r() * 0.55);
            const gr = ctx.createRadialGradient(sx + ox - pr * 0.25, sy + oy - pr * 0.3, pr * 0.1, sx + ox, sy + oy, pr);
            gr.addColorStop(0, `rgba(255,255,255,${0.42 * a0})`); gr.addColorStop(0.7, `rgba(244,247,250,${0.26 * a0})`); gr.addColorStop(1, 'rgba(235,240,245,0)');
            ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx + ox, sy + oy, pr, 0, 7); ctx.fill();
        }
    }
    ctx.restore();
}
// ---- flight HUD -----------------------------------------------------------------------------------------------------
let wcFlight = null, wcFlightEl = null;
function wcTzLabel(tz) { return tz === 0 ? 'CT' : 'CT' + (tz > 0 ? '+' : '') + tz; }
function wcRenderFlight() {
    if (!wcFlightEl) {
        wcFlightEl = document.createElement('div');
        wcFlightEl.style.cssText = 'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:61;min-width:320px;max-width:92vw;background:rgba(10,22,40,.9);border:1px solid #2fa8f0;border-radius:12px;padding:9px 14px;color:#fff;font:13px Ubuntu,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.45);display:none;pointer-events:none';
        document.body.appendChild(wcFlightEl);
    }
    const f = wcFlight;
    if (!f || !isWorldMode) { wcFlightEl.style.display = 'none'; return; }
    const PH = { taxi: 'Taxiing to the runway', lineup: 'Lining up', roll: 'Take-off roll', final: 'Final approach', rollout: 'Landing', taxiin: 'Taxiing to the gate', park: 'Arriving at the gate' };
    const ph = f.ph === 'air' ? (f.alt >= 0.99 ? 'Cruising' : f.rem > f.total * 0.5 ? 'Climbing' : 'Descending') : PH[f.ph] || '';
    const prog = Math.max(0, Math.min(1, 1 - f.rem / (f.total || 1)));
    const eta = Math.max(0, f.eta), m = Math.floor(eta / 60), sec = String(eta % 60).padStart(2, '0');
    wcFlightEl.innerHTML = `<div style="display:flex;justify-content:space-between;gap:14px;font-weight:700;font-size:15px"><span>✈ ${escapeHTML(f.fromCode)} → ${escapeHTML(f.toCode)} · ${{ east: 'Eastbound', west: 'Westbound', north: 'Northbound', south: 'Southbound' }[f.dir] || ''}</span><span style="color:#9fd8ff">${m}:${sec}</span></div>`
        + `<div style="color:#9fd8ff;margin:3px 0 6px">${escapeHTML(ph)} · to ${escapeHTML(f.toName)} (${wcTzLabel(f.tz)}) · ${Math.round(f.alt * 11000).toLocaleString()} m · ${f.kmh.toLocaleString()} km/h</div>`
        + `<div style="height:6px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden"><div style="height:100%;width:${(prog * 100).toFixed(1)}%;background:linear-gradient(90deg,#2fa8f0,#7fe0ff)"></div></div>`;
    wcFlightEl.style.display = 'block';
}

const WC_PAINTERS = { tower: (g, b) => wcPaintTower(g, b, false), mid: (g, b) => wcPaintTower(g, b, true), shop: wcPaintShop, apt: wcPaintApt, mall: wcPaintMall, bank: wcPaintBank, dealer: wcPaintDealer, hall: wcPaintHall, house: wcPaintHouse, farmhouse: wcPaintHouse, barn: wcPaintBarn, shed: wcPaintShed, school: wcPaintSchool, terminal: wcPaintTerminal, ctower: wcPaintCTower, hangar: wcPaintHangar };

// ===================== CITY STYLES, SHOPS, HOTELS, FUEL, GIGS, TAXIS (client) =====================
const WC_NEON = ['#ff2bd6', '#00e5ff', '#9dff00', '#ffb000', '#7a5cff'];
const WC_OLD_ROOF = ['#b5563a', '#a24b33', '#c4693f', '#9b5a3c', '#b8633f', '#8f4a36'];
function wcPaintMegaMall(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), neon = !!b.neon;
    wcShadow(g, w, h, 30);
    g.fillStyle = neon ? '#1b1d2e' : '#7d878f'; g.fillRect(0, 0, w, h);
    g.fillStyle = neon ? '#26293f' : '#c7ccd0'; g.fillRect(6, 6, w - 12, h - 12);
    // stepped roof terraces: one ring per level
    const lv = b.lv || 3;
    for (let i = 1; i < lv; i++) { const ins = i * Math.min(w, h) * 0.07; g.strokeStyle = neon ? WC_NEON[i % WC_NEON.length] : 'rgba(0,0,0,.18)'; g.lineWidth = neon ? 2.5 : 2; g.strokeRect(6 + ins, 6 + ins, w - 12 - ins * 2, h - 12 - ins * 2); }
    // glass atrium dome
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.18, gr = g.createRadialGradient(cx - r * .3, cy - r * .3, 2, cx, cy, r);
    gr.addColorStop(0, neon ? '#e8b8ff' : '#d6f0fa'); gr.addColorStop(1, neon ? '#5a2a8c' : '#5b8fa8'); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    for (let i = 0; i < 4; i++) { g.fillStyle = neon ? '#0e0f1a' : '#9aa3a9'; g.fillRect(14 + rnd() * (w - 60), 14 + rnd() * (h - 50), 26, 18); }
    wcBanner(g, (b.nm || 'MALL').toUpperCase() + ` · ${lv} LEVELS`, w / 2, h - 30, w * 0.7, 30, neon ? '#ff2bd6' : '#c9a227', neon ? '#fff' : '#2a2412');
    wcDoorMark(g, b, neon ? '#00e5ff' : '#c9a227');
}
function wcPaintHotel(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), neon = !!b.neon;
    wcShadow(g, w, h, 34);
    g.fillStyle = neon ? '#22223a' : '#5d6874'; g.fillRect(0, 0, w, h); g.fillStyle = neon ? '#2f3050' : '#e6e1d4'; g.fillRect(5, 5, w - 10, h - 10);
    g.fillStyle = neon ? '#3fd0ff' : '#5c9bb5'; g.fillRect(w * 0.3, h * 0.25, w * 0.4, h * 0.3);           // rooftop pool
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(w * 0.3, h * 0.25, w * 0.4, 3);
    g.fillStyle = neon ? '#14142a' : '#b0aa9b'; g.beginPath(); g.arc(w * 0.82, h * 0.2, Math.min(w, h) * 0.08, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = `bold ${Math.min(w, h) * 0.09}px Ubuntu`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', w * 0.82, h * 0.2 + 1);
    wcBanner(g, (b.nm || 'HOTEL').toUpperCase() + ' ' + '★'.repeat(b.stars || 4), w / 2, h * 0.75, w * 0.86, Math.min(30, h * 0.16), neon ? '#7a5cff' : '#7a1f2b');
    wcDoorMark(g, b, '#c9a227');
}
function wcPaintInn(g, b) {
    const w = b.w, h = b.h, col = WC_OLD_ROOF[(b.r || 0) % 6]; wcShadow(g, w, h, 14);
    g.fillStyle = '#efe4cc'; g.fillRect(-3, -3, w + 6, h + 6);
    g.fillStyle = wcShade(col, 14); g.fillRect(0, 0, w, h / 2); g.fillStyle = wcShade(col, -18); g.fillRect(0, h / 2, w, h / 2);
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1; for (let x = 6; x < w; x += 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    for (const fx of [0.2, 0.8]) { g.fillStyle = '#6e6458'; g.fillRect(w * fx - 6, h * 0.2, 12, 14); }
    wcBanner(g, (b.nm || (b.k === 'motel' ? 'MOTEL' : 'INN')).toUpperCase(), w / 2, h * 0.5, w * 0.85, Math.min(26, h * 0.2), b.k === 'motel' ? '#c0392b' : '#4a3520');
    wcDoorMark(g, b, '#6d4a38');
}
function wcPaintMotel(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 12);
    g.fillStyle = '#8c8f86'; g.fillRect(0, 0, w, h); g.fillStyle = '#d9d2bd'; g.fillRect(4, 4, w - 8, h - 8);
    const n = Math.floor(w / 70); for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#2f6f8f' : '#b84e46'; g.fillRect(8 + i * (w - 16) / n, h - 24, (w - 16) / n - 6, 16); }
    wcBanner(g, '🛏 ' + (b.nm || 'MOTEL').toUpperCase() + ' · VACANCY', w / 2, h * 0.38, w * 0.8, 28, '#c0392b');
    wcDoorMark(g, b, '#c0392b');
}
function wcPaintOld(g, b) {
    const w = b.w, h = b.h, rnd = wcRng(b.s || 1), col = WC_OLD_ROOF[(b.r || 0) % 6], horiz = w >= h;
    wcShadow(g, w, h, 10 + (b.f || 2) * 4);
    g.fillStyle = '#e8dcc0'; g.fillRect(-2, -2, w + 4, h + 4);
    const light = wcShade(col, 16), dark = wcShade(col, -22);
    if (horiz) { g.fillStyle = light; g.fillRect(0, 0, w, h / 2); g.fillStyle = dark; g.fillRect(0, h / 2, w, h / 2); }
    else { g.fillStyle = light; g.fillRect(0, 0, w / 2, h); g.fillStyle = dark; g.fillRect(w / 2, 0, w / 2, h); }
    g.strokeStyle = 'rgba(60,20,10,.22)'; g.lineWidth = 1; for (let t = 4; t < (horiz ? h : w); t += 5) { g.beginPath(); if (horiz) { g.moveTo(0, t); g.lineTo(w, t); } else { g.moveTo(t, 0); g.lineTo(t, h); } g.stroke(); }
    g.strokeStyle = 'rgba(40,15,5,.5)'; g.lineWidth = 2; g.beginPath(); if (horiz) { g.moveTo(0, h / 2); g.lineTo(w, h / 2); } else { g.moveTo(w / 2, 0); g.lineTo(w / 2, h); } g.stroke();
    for (let i = 0; i < 2; i++) { g.fillStyle = '#7a6656'; g.fillRect(w * (0.2 + rnd() * 0.6), h * (0.15 + rnd() * 0.6), 8, 10); }
    if (b.k === 'shop') { const aw = WC_AWN[(b.aw || 0) % 6], d = b.door; g.save(); g.translate(d.x - b.x, d.y - b.y); g.rotate({ S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[d.dir] || 0); for (let i = -3; i < 3; i++) { g.fillStyle = aw[(i + 3) % 2]; g.fillRect(i * 12, -12, 12, 12); } g.restore(); if (b.sn) wcBanner(g, b.sn.toUpperCase(), w / 2, h / 2, w - 10, Math.min(20, h * 0.25), '#4a3520'); }
    wcDoorMark(g, b, b.k === 'shop' ? '#7a3b1f' : '#5a3a28');
}
function wcPaintGallery(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 18);
    g.fillStyle = '#b9ad94'; g.fillRect(0, 0, w, h); g.fillStyle = '#efe7d3'; g.fillRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#d8ccae'; g.beginPath(); g.moveTo(4, 4); g.lineTo(w / 2, h * 0.35); g.lineTo(w - 4, 4); g.closePath(); g.fill();   // pediment
    const d = b.door; g.save(); g.translate(d.x - b.x, d.y - b.y); g.rotate({ S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 }[d.dir] || 0);
    for (let i = -2; i <= 2; i++) { g.fillStyle = '#fbf6ea'; g.beginPath(); g.arc(i * 14, -9, 4.5, 0, 7); g.fill(); g.strokeStyle = '#a89a7c'; g.lineWidth = 1; g.stroke(); }
    g.restore();
    wcBanner(g, (b.sign || 'GALLERY').toUpperCase(), w / 2, h * 0.62, w - 12, Math.min(18, h * 0.22), b.col || '#6b4f8a');
    wcDoorMark(g, b, b.col || '#6b4f8a');
}
function wcPaintCathedral(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 40);
    g.fillStyle = '#8a8170'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#5e6f78'; g.fillRect(w * 0.3, 4, w * 0.4, h - 8);                            // nave roof (lead)
    g.fillStyle = '#6b7d86'; g.fillRect(4, h * 0.3, w - 8, h * 0.18);                            // transept
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 1; for (let y = 8; y < h - 8; y += 9) { g.beginPath(); g.moveTo(w * 0.3, y); g.lineTo(w * 0.7, y); g.stroke(); }
    const cx = w / 2, cy = h * 0.39, r = Math.min(w, h) * 0.15, gr = g.createRadialGradient(cx - r * .3, cy - r * .3, 2, cx, cy, r);
    gr.addColorStop(0, '#d9e7c4'); gr.addColorStop(1, '#4e7b58'); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();   // copper dome
    for (const tx of [w * 0.3, w * 0.7]) { g.fillStyle = '#9b927f'; g.fillRect(tx - 22, h - 70, 44, 44); g.fillStyle = '#5e6f78'; g.beginPath(); g.moveTo(tx - 22, h - 70); g.lineTo(tx, h - 48); g.lineTo(tx + 22, h - 70); g.closePath(); g.fill(); }
    const rr = Math.min(w, h) * 0.06; g.fillStyle = '#c94c6b'; g.beginPath(); g.arc(cx, h - 40, rr, 0, 7); g.fill(); g.fillStyle = '#4c78c9'; g.beginPath(); g.arc(cx, h - 40, rr * 0.55, 0, 7); g.fill();   // rose window
    wcDoorMark(g, b, '#5a3a28');
}
function wcPaintMill(g, b) {
    const w = b.w, h = b.h; wcShadow(g, w, h, 16);
    g.fillStyle = '#5a4630'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a6a44'; g.fillRect(4, 4, w - 8, h / 2 - 4); g.fillStyle = '#7a5c3a'; g.fillRect(4, h / 2, w - 8, h / 2 - 4);
    g.strokeStyle = 'rgba(0,0,0,.2)'; for (let x = 10; x < w; x += 12) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }
    for (let i = 0; i < 6; i++) { g.fillStyle = '#a5824f'; g.beginPath(); g.ellipse(w + 30, 20 + i * 16, 22, 7, 0, 0, 7); g.fill(); g.fillStyle = '#d8b98a'; g.beginPath(); g.arc(w + 8, 20 + i * 16, 6, 0, 7); g.fill(); }
    wcBanner(g, 'TIMBERLINE SAWMILL', w / 2, h / 2, w * 0.8, 26, '#7a5a2a'); wcDoorMark(g, b, '#7a5a2a');
}
// Cyberpunk overlay for neon buildings: glowing edge strips, holo panels, lit window grid.
function wcNeonOverlay(g, b) {
    const w = b.w, h = b.h, rnd = wcRng((b.s || 1) * 7 + 3), c1 = WC_NEON[(b.s || 0) % 5], c2 = WC_NEON[((b.s || 0) + 2) % 5];
    g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(20,10,45,.45)'; g.fillRect(-50, -50, w + 100, h + 100); g.restore();
    g.save(); g.shadowColor = c1; g.shadowBlur = 10; g.strokeStyle = c1; g.lineWidth = 2.4; g.strokeRect(3, 3, w - 6, h - 6);
    g.shadowColor = c2; g.strokeStyle = c2; g.lineWidth = 1.6; g.strokeRect(10, 10, w - 20, h - 20); g.restore();
    g.fillStyle = 'rgba(120,230,255,.5)'; for (let i = 0; i < Math.min(40, w * h / 1600); i++) g.fillRect(14 + rnd() * (w - 30), 14 + rnd() * (h - 30), 3, 2);
    if (w > 140 && h > 90 && rnd() < 0.7) { const pw = Math.min(90, w * 0.4), ph = 22, px = 16 + rnd() * (w - pw - 32), py = 16 + rnd() * (h - ph - 32); g.save(); g.shadowColor = c2; g.shadowBlur = 12; g.fillStyle = 'rgba(10,0,30,.75)'; g.fillRect(px, py, pw, ph); g.strokeStyle = c2; g.lineWidth = 1.5; g.strokeRect(px, py, pw, ph); g.fillStyle = c2; g.font = 'bold 11px Ubuntu, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(['ネオン', 'SYNTH', 'DATA', '24/7', 'CYBER', 'ゼロ', 'NODE'][Math.floor(rnd() * 7)], px + pw / 2, py + ph / 2 + 1); g.restore(); }
}
Object.assign(WC_PAINTERS, { megamall: wcPaintMegaMall, hotel: wcPaintHotel, inn: wcPaintInn, motel: wcPaintMotel, old: wcPaintOld, gallery: wcPaintGallery, cathedral: wcPaintCathedral, mill: wcPaintMill });
// shops get a sign saying what they sell (old-town shops use the terrace look)
const _wcPaintShop0 = WC_PAINTERS.shop;
WC_PAINTERS.shop = (g, b) => { if (b.old) return wcPaintOld(g, b); _wcPaintShop0(g, b); if (b.sn) wcBanner(g, (b.fuel ? '⛽ ' : '') + b.sn.toUpperCase(), b.w / 2, b.h * 0.62, b.w - 10, Math.min(22, b.h * 0.2), b.fuel ? '#1d6f3a' : '#3a4650'); };

// ---- street props: stalls, holo-signs, fuel canopies & pumps, lakes, billboards, paved aprons ------------------------------
const WC_STALL_COL = [['#c0392b', '#f4efe4'], ['#2c7a5b', '#f4efe4'], ['#2f5f9e', '#f4efe4'], ['#d68a1c', '#fff4d6'], ['#7a3f8f', '#f4efe4'], ['#1f7f8c', '#f4efe4']];
function wcDrawStreetProp(p, s, night) {
    const X = v => worldToScreenX(v), Y = v => worldToScreenY(v);
    if (p.k === 'stall') {
        const c = WC_STALL_COL[(p.col || 0) % 6], x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s, neon = p.sk === 'noodle';
        ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 3 * s, y + 4 * s, w, h);
        ctx.fillStyle = '#6b4a30'; ctx.fillRect(x, y + h * 0.55, w, h * 0.45);
        for (let i = 0; i < 6; i++) { ctx.fillStyle = c[i % 2]; ctx.fillRect(x + i * w / 6, y, w / 6 + 0.5, h * 0.6); }
        if (neon) { ctx.save(); ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 8; ctx.strokeStyle = '#ff2bd6'; ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeRect(x, y, w, h); ctx.restore(); }
        if (night > 0.2) { ctx.fillStyle = `rgba(255,220,140,${0.35 * night})`; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 70 * s, 0, 7); ctx.fill(); }
    } else if (p.k === 'holo') {
        const x = X(p.x + 6), y = Y(p.y + 6), t = performance.now() / 1000, col = p.col || '#ff2bd6';
        ctx.fillStyle = '#20232b'; ctx.beginPath(); ctx.arc(x, y, 5 * s, 0, 7); ctx.fill();
        if (s > 0.2) {
            ctx.save(); ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 3 + p.x); ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.font = `bold ${Math.max(7, 18 * s)}px Ubuntu, monospace`; ctx.textAlign = 'center';
            const tw = ctx.measureText(p.txt || '').width + 16 * s; ctx.fillStyle = 'rgba(10,0,30,.55)'; ctx.fillRect(x - tw / 2, y - 46 * s, tw, 26 * s);
            ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, 1.5 * s); ctx.strokeRect(x - tw / 2, y - 46 * s, tw, 26 * s); ctx.fillStyle = col; ctx.fillText(p.txt || '', x, y - 27 * s); ctx.restore();
        }
    } else if (p.k === 'pump') {
        const x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s;
        ctx.fillStyle = '#7b8288'; ctx.fillRect(x - 3 * s, y - 3 * s, w + 6 * s, h + 6 * s); ctx.fillStyle = '#e8ecef'; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#1d8a4f'; ctx.fillRect(x + 2 * s, y + 2 * s, w - 4 * s, Math.min(h, w) * 0.5);
    } else if (p.k === 'canopy') {
        const x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s;
        ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(x + 10 * s, y + 14 * s, w, h);
        ctx.fillStyle = 'rgba(236,240,243,.55)'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#1d8a4f'; ctx.lineWidth = Math.max(2, 7 * s); ctx.strokeRect(x, y, w, h);
        if (s > 0.18) { ctx.fillStyle = '#1d8a4f'; ctx.font = `bold ${Math.max(8, 26 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText('⛽ ' + (p.brand || 'FUEL'), x + w / 2, y + 30 * s); }
    } else if (p.k === 'billboard') {
        const x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s, horiz = p.w > p.h;
        ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 6 * s, y + 8 * s, w, h); ctx.fillStyle = p.col || '#3a4650'; ctx.fillRect(x, y, w, h);
        if (s > 0.2) { ctx.save(); ctx.translate(x + w / 2, y + h / 2); if (!horiz) ctx.rotate(Math.PI / 2); ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(6, 11 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((p.txt || '').toUpperCase(), 0, 1); ctx.restore(); }
    }
}
function wcDrawGroundProp(p, s) {
    if (p.k === 'pave') wcFillTex('concrete', p.x, p.y, p.w, p.h, 128);
    else if (p.k === 'lake') {
        const cx = worldToScreenX(p.x + p.w / 2), cy = worldToScreenY(p.y + p.h / 2);
        ctx.fillStyle = '#d8c995'; ctx.beginPath(); ctx.ellipse(cx, cy, (p.rx + 40) * s, (p.ry + 40) * s, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#3f7fa8'; ctx.beginPath(); ctx.ellipse(cx, cy, p.rx * s, p.ry * s, 0, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.ellipse(cx - p.rx * 0.2 * s, cy - p.ry * 0.25 * s, p.rx * 0.5 * s, p.ry * 0.3 * s, 0, 0, 7); ctx.fill();
    }
}
// ---- branches (company expansion) ---------------------------------------------------------------------------------
WC.branch = new Map();
function wcApplyBranch(b) {
    const co = WC.branch.get(b.id); if (!co || b.work) return;
    const c = (WC.companies || []).find(q => q.id === co); if (!c) return;
    b.work = co; b.sign = c.name; b.col = c.color; b._branch = 1; wcSpriteCache.delete('b' + b.id);
}

// ---- HUD: mission (gig) banner, taxi banner, tour group / passenger ---------------------------------------------------
let wcMission = null, wcMissionT = 0, wcTaxi = null, wcBannerEl = null;
function wcRenderBanners() {
    if (!wcBannerEl) { wcBannerEl = document.createElement('div'); wcBannerEl.style.cssText = 'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:61;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;font:13px Ubuntu,sans-serif'; document.body.appendChild(wcBannerEl); }
    if (!isWorldMode) { wcBannerEl.innerHTML = ''; return; }
    let html = '';
    const box = (border, inner) => `<div style="min-width:300px;max-width:92vw;background:rgba(10,22,40,.9);border:1px solid ${border};border-radius:12px;padding:8px 14px;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.45)">${inner}</div>`;
    if (wcMission) {
        const left = Math.max(0, wcMission.left - (performance.now() - wcMissionT)), icon = { courier: '📦', taxi: '🚖', guide: '🗺' }[wcMission.kind] || '💼';
        html += box('#e8c53a', `<div style="display:flex;justify-content:space-between;gap:12px;font-weight:700"><span>${icon} ${escapeHTML(wcMission.title)} · stop ${wcMission.i + 1}/${wcMission.n}</span><span style="color:${left < 20000 ? '#ff8a7a' : '#ffe08a'}">${wcFmtMs(left)}</span></div><div style="color:#ffe9a8;margin-top:2px">${escapeHTML(wcMission.label)} · pays ~${wcMission.pay}</div><div style="color:#9fb3c4;font-size:11px;margin-top:2px">Follow the satnav · press J to cancel</div>`);
    }
    if (wcTaxi) {
        const t = wcTaxi, ph = t.phase === 'coming' ? `On its way · ~${t.eta}s` : t.phase === 'waiting' ? `Waiting for you (${t.wait}s) – walk up and press F` : `Riding · ~${t.eta}s to go`;
        html += box('#f2c014', `<div style="display:flex;justify-content:space-between;gap:12px;font-weight:700"><span>🚕 Taxi to ${escapeHTML(t.label)}</span><span style="color:#ffe08a">${t.fare} coins</span></div><div style="color:#ffe9a8">${ph}</div>`);
    }
    if (wcBannerEl.dataset.h !== html) { wcBannerEl.dataset.h = html; wcBannerEl.innerHTML = html; }
    wcBannerEl.style.top = (wcFlight ? 130 : 54) + 'px';
}
setInterval(() => { if (isWorldMode) wcRenderBanners(); }, 250);
function wcDrawMissionExtras(s) {
    const m = wcMission; if (!m || WC.scene !== 'ext') return;
    const t = performance.now() / 1000;
    if (m.pax) {                                                       // passenger waving at the kerb
        const x = worldToScreenX(m.x), y = worldToScreenY(m.y);
        ctx.fillStyle = 'rgba(242,192,20,.35)'; ctx.beginPath(); ctx.arc(x, y, (40 + 8 * Math.sin(t * 4)) * s, 0, 7); ctx.fill();
        ctx.fillStyle = '#c94c4c'; ctx.beginPath(); ctx.ellipse(x, y, 5 * s, 8 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#e4b995'; ctx.beginPath(); ctx.arc(x, y - 2 * s, 5 * s, 0, 7); ctx.fill();
        ctx.strokeStyle = '#e4b995'; ctx.lineWidth = Math.max(1, 2.5 * s); ctx.beginPath(); ctx.moveTo(x + 4 * s, y - 2 * s); ctx.lineTo(x + (10 + 3 * Math.sin(t * 8)) * s, y - 14 * s); ctx.stroke();
    }
    if (m.group) {                                                     // tour group trailing behind you
        const me = gameState.entities.find(e => e.id === myId), r = me && renderEntities.get(me.id); if (!r) return;
        WC._trail = WC._trail || []; WC._trail.push([r.renderX, r.renderY]); if (WC._trail.length > 120) WC._trail.shift();
        const cols = ['#4c78c9', '#c9a64c', '#4cc98a', '#8b4cc9', '#c94c9a'];
        for (let i = 0; i < 5; i++) { const q = WC._trail[Math.max(0, WC._trail.length - 1 - (i + 2) * 9)]; if (!q) continue; const x = worldToScreenX(q[0] + Math.sin(i * 2.1) * 26), y = worldToScreenY(q[1] + Math.cos(i * 1.7) * 26); ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.ellipse(x, y, 4 * s, 7 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#e4b995'; ctx.beginPath(); ctx.arc(x, y, 4 * s, 0, 7); ctx.fill(); }
        if (s > 0.25) { const x = worldToScreenX(r.renderX), y = worldToScreenY(r.renderY); ctx.fillStyle = '#c0392b'; ctx.fillRect(x + 18 * s, y - 40 * s, 2 * s, 30 * s); ctx.fillRect(x + 20 * s, y - 40 * s, 16 * s, 10 * s); }
    }
}
function wcGigKey() {
    if (!isWorldMode) return;
    if (wcMission) worldSend('world_gig', { act: 'cancel' });
    else worldSend('world_gig', { act: 'next' });
}
// Each foreign city has its own colour wash on buildings and ground, its own weather and its own time zone.
const WC_THEME = {
    port: { bld: 'rgba(60,110,160,.24)', grass: 'rgba(70,110,140,.22)' }, hill: { bld: 'rgba(170,95,30,.24)', grass: 'rgba(190,120,30,.26)' }, sun: { bld: 'rgba(255,170,70,.22)', grass: 'rgba(235,190,90,.30)' },
    mesa: { bld: 'rgba(190,90,50,.22)', grass: 'rgba(205,120,70,.30)' }, pine: { bld: 'rgba(40,90,60,.22)', grass: 'rgba(30,80,50,.26)' },
    tropic: { bld: 'rgba(40,170,170,.18)', grass: 'rgba(60,190,150,.22)' }, blossom: { bld: 'rgba(230,140,180,.20)', grass: 'rgba(240,170,200,.24)' },
    cyber: { bld: 'rgba(70,40,140,.12)', grass: 'rgba(40,20,90,.22)' }, old: { bld: 'rgba(200,140,80,.12)', grass: 'rgba(210,170,110,.20)' }
};
function wcCityTheme(id) { const c = WC.cities && WC.cities.find(q => q.id === id); return c && WC_THEME[c.theme]; }
function wcBuildingSprite(b) {
    return wcSprite('b' + b.id, b.w, b.h, g => {
        (WC_PAINTERS[b.k] || wcPaintTower)(g, b);
        if (b.neon) wcNeonOverlay(g, b);
        const th = b.city && !b.neon && wcCityTheme(b.city);
        if (th) { g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = th.bld; g.fillRect(-5000, -5000, 10000, 10000); g.restore(); }
    });
}

// lot-level house furniture: front hedge, driveway, path, mailbox and the for-sale / owner sign (drawn live: ownership changes)
function wcHouseLot(b, s) {
    if (!b.lot) return;
    const [lx, ly, lw, ld] = b.lot, north = b.door.dir === 'N', fy = north ? ly : ly + ld;
    const X = v => worldToScreenX(v), Y = v => worldToScreenY(v), r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(X(x), Y(y), w * s, h * s); };
    if (b.k === 'house') {
        r(lx + 4, north ? ly + 3 : ly + ld - 11, lw - 8, 8, '#4f7f46');
        if (b.fen) { ctx.strokeStyle = 'rgba(240,233,214,.9)'; ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeRect(X(lx + 2), Y(ly + 2), (lw - 4) * s, (ld - 4) * s); }
        const gx = b.x + (b.gar ? (((b.s || 0) % 2 === 0) ? 0 : b.w * 0.7) : b.w * 0.35), gw = b.gar ? b.w * 0.3 : 0;
        if (b.gar) { const y0 = north ? ly : b.y + b.h, len = north ? b.y - ly : ly + ld - (b.y + b.h); r(gx, y0, gw, len, '#aaa89e'); }
        const py0 = north ? ly : b.door.y, plen = north ? b.door.y - ly : ly + ld - b.door.y; r(b.door.x - 7, py0, 14, plen, '#cbc4b0');
        const stakeX = b.door.x + 26, stakeY = north ? ly + 14 : ly + ld - 30; r(stakeX + 8, stakeY + 8, 3, 14, '#6b5a44');
        const o = WC.houses.get(b.hid);
        if (!o) { r(stakeX, stakeY, 26, 14, '#fdfbf4'); r(stakeX, stakeY, 26, 4, '#d6453b'); ctx.fillStyle = '#d6453b'; ctx.font = `bold ${Math.max(6, 6 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText('SALE', X(stakeX + 13), Y(stakeY + 11)); }
        else { r(stakeX, stakeY, 26, 14, o.m ? '#e2b33a' : '#e5e0d2'); ctx.fillStyle = o.m ? '#4a3510' : '#4a463c'; ctx.font = `bold ${Math.max(6, 5.5 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText(o.m ? 'HOME' : o.o.slice(0, 5).toUpperCase(), X(stakeX + 13), Y(stakeY + 10)); }
    }
}

// ---- trees, lamps, benches ----------------------------------------------------------------------------------------------
function wcTreeSprite(v) {
    return wcSprite('t' + v, 96, 96, g => {
        const r = 24 + (v % 4) * 6, rnd = wcRng(v * 977 + 5), fam = (v >> 2) & 1, cols = fam ? ['#2f6d3c', '#3a7e46', '#48904f'] : ['#4a8a3a', '#5a9c46', '#6aae52'];
        g.translate(48, 48); g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(r * .3, r * .34, r * 1.02, r * .86, 0, 0, 7); g.fill();
        g.fillStyle = '#5b4632'; g.beginPath(); g.arc(0, 0, 4, 0, 7); g.fill();
        for (let i = 0; i < 6; i++) { const a = i / 6 * 6.283 + rnd(), d = r * 0.42; g.fillStyle = cols[i % 3]; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.62, 0, 7); g.fill(); }
        g.fillStyle = cols[1]; g.beginPath(); g.arc(0, 0, r * 0.62, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.arc(-r * .25, -r * .28, r * .32, 0, 7); g.fill();
    });
}
function wcDrawTree(p, s) {
    const spr = wcTreeSprite(p.v), sx = worldToScreenX(p.x), sy = worldToScreenY(p.y);
    ctx.drawImage(spr, sx - 88 * s, sy - 88 * s, spr.width / wcSPR * s, spr.height / wcSPR * s);   // sprite centre = (96 + 2*pad) / 2
}

// ---- the exterior scene ---------------------------------------------------------------------------------------------------
const WC_CROPS = [['#6aa84f', '#92cf68'], ['#d9bf5b', '#efdc8a'], ['#7fae3f', '#a5d05c'], ['#3f8f57', '#68b87b'], ['#a2693f', '#c79067']];
function wcLine(x0, y0, x1, y1, color, w, dash, phase) {
    ctx.strokeStyle = color; ctx.lineWidth = w; if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = phase || 0; }
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); if (dash) ctx.setLineDash([]);
}
function wcDrawRoads(vx0, vy0, vx1, vy1, s) {
    const C = WC.center;
    for (const r of WC.roads) {
        const v = r.a === 'v', C = r.o ?? WC.center;
        const aMin = Math.max(C - r.e, v ? vy0 : vx0), aMax = Math.min(C + r.e, v ? vy1 : vx1);
        if (aMax <= aMin) continue;
        if (v ? (r.p + r.hw < vx0 || r.p - r.hw > vx1) : (r.p + r.hw < vy0 || r.p - r.hw > vy1)) continue;
        const tex = r.st === 'cobble' ? 'cobble' : r.st === 'dirt' ? 'dirt' : 'asphalt';
        if (v) wcFillTex(tex, r.p - r.hw, aMin, 2 * r.hw, aMax - aMin, tex === 'cobble' ? 96 : 110); else wcFillTex(tex, aMin, r.p - r.hw, aMax - aMin, 2 * r.hw, tex === 'cobble' ? 96 : 110);
        if (r.st === 'dirt') continue;
        const A0 = (a) => v ? [worldToScreenX(r.p + a), worldToScreenY(aMin), worldToScreenX(r.p + a), worldToScreenY(aMax)] : [worldToScreenX(aMin), worldToScreenY(r.p + a), worldToScreenX(aMax), worldToScreenY(r.p + a)];
        const phase = ((aMin - (C - r.e)) / fov);
        const line = (off, color, w, dash) => { const q = A0(off); wcLine(q[0], q[1], q[2], q[3], color, Math.max(1, w * s), dash ? dash.map(d => d * s) : null, dash ? phase % ((dash[0] + dash[1]) * s) : 0); };
        if (r.st === 'cobble') { line(-r.hw + 4, 'rgba(70,60,50,.6)', 3); line(r.hw - 4, 'rgba(70,60,50,.6)', 3); continue; }
        if (r.st === 'neon') { ctx.save(); ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 8; line(-r.hw + 5, '#00e5ff', 2.6); line(r.hw - 5, '#ff2bd6', 2.6); ctx.restore(); if (r.ln === 4) { line(-2.6, '#ffb000', 2.4); line(2.6, '#ffb000', 2.4); line(-r.hw / 2, 'rgba(0,229,255,.6)', 2, [26, 30]); line(r.hw / 2, 'rgba(255,43,214,.6)', 2, [26, 30]); } else line(0, 'rgba(0,229,255,.75)', 2.6, [30, 26]); continue; }
        line(-r.hw + 5, 'rgba(240,240,232,.8)', 2.4); line(r.hw - 5, 'rgba(240,240,232,.8)', 2.4);
        if (r.ln === 4) { line(-2.6, '#e6c23a', 2.4); line(2.6, '#e6c23a', 2.4); line(-r.hw / 2, 'rgba(240,240,232,.7)', 2, [26, 30]); line(r.hw / 2, 'rgba(240,240,232,.7)', 2, [26, 30]); }
        else line(0, '#e3c43e', 2.6, [30, 26]);
    }
}
function wcDrawJunction(j, s) {
    if (j._st === undefined) { const q = wcCityHere(j.x, j.y); j._st = q && q.theme === 'old' && j.hv < 100 && j.hh < 100 ? 'cobble' : q && q.theme === 'pine' && j.hv < 100 && j.hh < 100 ? 'dirt' : ''; }
    if (j._st) { wcFillTex(j._st, j.x - j.hv, j.y - j.hh, 2 * j.hv, 2 * j.hh, j._st === 'cobble' ? 96 : 110); return; }
    wcFillTex('asphalt', j.x - j.hv, j.y - j.hh, 2 * j.hv, 2 * j.hh, 110);
    const X = v => worldToScreenX(v), Y = v => worldToScreenY(v), R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(X(x), Y(y), w * s, h * s); };
    const Z = 'rgba(244,244,236,.92)';
    // zebra crossings on every arm that exists + a stop line on the approach lane (right-hand traffic)
    if (j.n) { for (let x = j.x - j.n + 8; x < j.x + j.n - 8; x += 13) R(x, j.y - j.hh - 21, 7, 16, Z); R(j.x - j.n + 3, j.y - j.hh - 28, j.n - 3, 4, Z); }
    if (j.s) { for (let x = j.x - j.s + 8; x < j.x + j.s - 8; x += 13) R(x, j.y + j.hh + 5, 7, 16, Z); R(j.x, j.y + j.hh + 24, j.s - 3, 4, Z); }
    if (j.w) { for (let y = j.y - j.w + 8; y < j.y + j.w - 8; y += 13) R(j.x - j.hv - 21, y, 16, 7, Z); R(j.x - j.hv - 28, j.y, 4, j.w - 3, Z); }
    if (j.e) { for (let y = j.y - j.e + 8; y < j.y + j.e - 8; y += 13) R(j.x + j.hv + 5, y, 16, 7, Z); R(j.x + j.hv + 24, j.y - j.e + 3, 4, j.e - 3, Z); }
}
function wcDrawLot(l, s) {
    wcFillTex('asphalt', l.x, l.y, l.w, l.h, 110); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(worldToScreenX(l.x), worldToScreenY(l.y), l.w * s, l.h * s);
    if (!l._bays) l._bays = lotBays(l);
    ctx.strokeStyle = l.dealer ? 'rgba(245,197,66,.95)' : 'rgba(240,240,232,.8)'; ctx.lineWidth = Math.max(1, 1.8 * s); ctx.beginPath();
    for (const b of l._bays) {
        const x0 = worldToScreenX(b.x - 27), x1 = worldToScreenX(b.x + 27), ya = worldToScreenY(b.y - 48), yb = worldToScreenY(b.y + 48), cl = b.a < 0 ? ya : yb;
        ctx.moveTo(x0, ya); ctx.lineTo(x0, yb); ctx.moveTo(x1, ya); ctx.lineTo(x1, yb); ctx.moveTo(x0, cl); ctx.lineTo(x1, cl);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,60,55,.6)'; ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeRect(worldToScreenX(l.x), worldToScreenY(l.y), l.w * s, l.h * s);
    if (l.dealer && l.w * s > 120) { ctx.fillStyle = 'rgba(245,197,66,.75)'; ctx.font = `bold ${Math.max(8, 14 * s)}px Ubuntu`; ctx.textAlign = 'center'; ctx.fillText('DEALERSHIP PARKING', worldToScreenX(l.x + l.w / 2), worldToScreenY(l.y + l.h / 2 + 5)); }
}
function wcDrawField(f, s) {
    if (f.kind === 'pitch') { wcFillTex('lawn', f.x, f.y, f.w, f.h); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, 3 * s); ctx.strokeRect(worldToScreenX(f.x + 12), worldToScreenY(f.y + 12), (f.w - 24) * s, (f.h - 24) * s); wcLine(worldToScreenX(f.x + f.w / 2), worldToScreenY(f.y + 12), worldToScreenX(f.x + f.w / 2), worldToScreenY(f.y + f.h - 12), 'rgba(255,255,255,.85)', Math.max(1, 3 * s)); return; }
    if (f.kind === 'ranch') { wcFillTex('lawn', f.x, f.y, f.w, f.h); ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = Math.max(2, 5 * s); ctx.strokeRect(worldToScreenX(f.x), worldToScreenY(f.y), f.w * s, f.h * s); ctx.strokeStyle = 'rgba(210,180,130,.9)'; ctx.lineWidth = Math.max(1, 2 * s); ctx.strokeRect(worldToScreenX(f.x), worldToScreenY(f.y), f.w * s, f.h * s); return; }
    wcFillTex('dirt', f.x, f.y, f.w, f.h);
    const cr = WC_CROPS[f.crop % 5], step = 26, sx0 = worldToScreenX(f.x), sx1 = worldToScreenX(f.x + f.w);
    const y0 = worldToScreenY(f.y + 8), y1 = worldToScreenY(f.y + f.h - 8);
    const first = Math.max(0, Math.floor((camera.x - f.x) / step)), last = Math.min(Math.floor(f.w / step), Math.ceil((camera.x + canvas.width * fov - f.x) / step));
    ctx.lineCap = 'round';
    for (let i = first; i <= last; i++) { const x = worldToScreenX(f.x + 14 + i * step); if (x < sx0 || x > sx1) continue; ctx.strokeStyle = cr[0]; ctx.lineWidth = Math.max(2, 13 * s); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.strokeStyle = cr[1]; ctx.lineWidth = Math.max(1, 4 * s); ctx.beginPath(); ctx.moveTo(x - 2 * s, y0); ctx.lineTo(x - 2 * s, y1); ctx.stroke(); }
    ctx.lineCap = 'butt'; ctx.strokeStyle = 'rgba(70,52,30,.55)'; ctx.lineWidth = Math.max(1, 3 * s); ctx.strokeRect(sx0, worldToScreenY(f.y), f.w * s, f.h * s);
}
function wcDrawBlock(b, s) {
    if (b.sw > 0) {
        wcFillTex('pave', b.x, b.y, b.w, b.h, 104);
        const lx = b.x + b.sw, ly = b.y + b.sw, lw = b.w - 2 * b.sw, lh = b.h - 2 * b.sw;
        const tex = b.g === 'plaza' ? 'plaza' : (b.g === 'park' || b.z >= 2) ? 'lawn' : 'concrete';
        wcFillTex(tex, lx, ly, lw, lh, 104);
        ctx.strokeStyle = 'rgba(60,60,54,.55)'; ctx.lineWidth = Math.max(1, 2.4 * s); ctx.strokeRect(worldToScreenX(b.x), worldToScreenY(b.y), b.w * s, b.h * s);
        ctx.strokeStyle = 'rgba(90,88,80,.4)'; ctx.lineWidth = Math.max(1, 1.2 * s); ctx.strokeRect(worldToScreenX(lx), worldToScreenY(ly), lw * s, lh * s);
    } else wcFillTex(b.g === 'forest' ? 'forest' : 'grass', b.x, b.y, b.w, b.h, 110);
}
function wcDrawProp(p, s, pass) {
    const X = v => worldToScreenX(v), Y = v => worldToScreenY(v);
    if (pass === 0) {
        if (p.k === 'path') { ctx.fillStyle = '#d9d0b6'; ctx.fillRect(X(p.x), Y(p.y), p.w * s, p.h * s); ctx.strokeStyle = 'rgba(120,108,80,.4)'; ctx.lineWidth = Math.max(1, 1.5 * s); ctx.strokeRect(X(p.x), Y(p.y), p.w * s, p.h * s); }
        else if (p.k === 'yard') wcFillTex('dirt', p.x, p.y, p.w, p.h);
        else if (p.k === 'fountain') {
            const cx = X(p.x + p.w / 2), cy = Y(p.y + p.h / 2), r = p.w / 2 * s;
            ctx.fillStyle = '#b9b3a2'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.fillStyle = '#5ea6c4'; ctx.beginPath(); ctx.arc(cx, cy, r * .82, 0, 7); ctx.fill();
            const t = performance.now() / 700; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(1, 1.5 * s); for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(cx, cy, r * (0.25 + ((t + i / 3) % 1) * 0.55), 0, 7); ctx.stroke(); }
            ctx.fillStyle = '#c9c3b2'; ctx.beginPath(); ctx.arc(cx, cy, r * .2, 0, 7); ctx.fill();
        } else if (p.k === 'silo') { const cx = X(p.x + p.w / 2), cy = Y(p.y + p.h / 2), r = p.w / 2 * s; ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.arc(cx + 5 * s, cy + 6 * s, r, 0, 7); ctx.fill(); const gr = ctx.createRadialGradient(cx - r * .3, cy - r * .3, r * .1, cx, cy, r); gr.addColorStop(0, '#e9ecef'); gr.addColorStop(1, '#8a949c'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = Math.max(1, 1.5 * s); ctx.stroke(); }
    } else if (pass === 1) {
        if (p.k === 'atm') { const x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s; ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 2 * s, y + 3 * s, w, h); ctx.fillStyle = '#2d6a4f'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#9fe8c4'; ctx.fillRect(x + w * .12, y + h * .18, w * .5, h * .38); ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(6, 7 * s)}px sans-serif`; ctx.fillText('ATM', x + w * .66, y + h * .62); }
        else if (p.k === 'lamp') { const x = X(p.x), y = Y(p.y); ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(x + 3 * s, y + 4 * s, 5 * s, 3 * s, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#2f383d'; ctx.beginPath(); ctx.arc(x, y, 3.4 * s, 0, 7); ctx.fill(); ctx.fillStyle = '#f6e3a4'; ctx.beginPath(); ctx.arc(x, y, 1.8 * s, 0, 7); ctx.fill(); }
        else if (p.k === 'bench') { const x = X(p.x), y = Y(p.y), w = p.w * s, h = p.h * s; ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(x + 2 * s, y + 3 * s, w, h); ctx.fillStyle = '#5e432c'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#a47b4f'; if (p.w > p.h) { for (let i = 0; i < 4; i++) ctx.fillRect(x + 2 * s, y + (1.5 + i * 4.5) * s, w - 4 * s, 3 * s); } else { for (let i = 0; i < 4; i++) ctx.fillRect(x + (1.5 + i * 4.5) * s, y + 2 * s, 3 * s, h - 4 * s); } }
    }
}
function wcUpdateDyn() {
    for (const o of WC.dyn.values()) {
        o.rx += (o.x - o.rx) * 0.3; o.ry += (o.y - o.ry) * 0.3;
        if (o.kind === 'car') { o.ra = lerpAngle(o.ra, o.a, 0.25); }
        else { const dx = o.x - o.rx, dy = o.y - o.ry; if (dx * dx + dy * dy > 0.4) o.ra = Math.atan2(dy, dx); }
    }
}
function wcDrawDyn(vx0, vy0, vx1, vy1, s) {
    const t = performance.now() / 1000;
    for (const o of WC.dyn.values()) {
        if (o.rx < vx0 - 80 || o.rx > vx1 + 80 || o.ry < vy0 - 80 || o.ry > vy1 + 80) continue;
        if (o.kind === 'car') {
            let spr;
            if (o.t >= 5) { spr = wcCarSprite('#f2c014', 4, 58, 30); if (o.t === 6) { ctx.strokeStyle = `rgba(242,192,20,${0.5 + 0.35 * Math.sin(t * 4)})`; ctx.lineWidth = Math.max(2, 3 * s); ctx.beginPath(); ctx.arc(worldToScreenX(o.rx), worldToScreenY(o.ry), 46 * s, 0, 7); ctx.stroke(); } }
            else if (o.t >= 3) { const m = o.c, spec = WC.cars[m] || { color: '#ccc' }, dim = WC_CAR_DIMS[Math.max(0, m)]; spr = wcCarSprite(spec.color, m === 2 ? 2 : 0, dim[0], dim[1]); if (o.t === 4) { ctx.strokeStyle = `rgba(255,214,90,${0.5 + 0.35 * Math.sin(t * 4)})`; ctx.lineWidth = Math.max(2, 3 * s); ctx.beginPath(); ctx.arc(worldToScreenX(o.rx), worldToScreenY(o.ry), 44 * s, 0, 7); ctx.stroke(); } }
            else spr = wcCarSprite(WC.carColors[o.c % WC.carColors.length] || '#ccc', o.t === 2 ? 3 : o.t === 1 ? 1 : 0, o.t === 2 ? 66 : o.t === 1 ? 50 : 56, o.t === 2 ? 32 : 29);
            wcBlitCar(spr, o.rx, o.ry, o.ra);
        } else {
            const x = worldToScreenX(o.rx), y = worldToScreenY(o.ry), sk = o.skin || 0, shirts = ['#c94c4c', '#4c78c9', '#4cc98a', '#c9a64c', '#8b4cc9', '#4cc9c2', '#c94c9a', '#7a8a96'], skins = ['#e4b995', '#c68e63', '#8d5a3b', '#f0cfae'];
            ctx.save(); ctx.translate(x, y); ctx.rotate(o.ra || 0);
            ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(1.5 * s, 2 * s, 6 * s, 5 * s, 0, 0, 7); ctx.fill();
            ctx.fillStyle = shirts[sk % 8]; ctx.beginPath(); ctx.ellipse(0, 0, 3.6 * s, 6 * s, 0, 0, 7); ctx.fill();
            ctx.fillStyle = skins[sk % 4]; ctx.beginPath(); ctx.arc(1 * s, 0, 3.6 * s, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(40,30,25,.8)'; ctx.beginPath(); ctx.arc(0, 0, 3.6 * s, 1.2, 5.1); ctx.fill();
            ctx.restore();
        }
    }
}
function wcDrawBuildingLod(b, s) {
    const x = worldToScreenX(b.x), y = worldToScreenY(b.y), w = b.w * s, h = b.h * s;
    ctx.fillStyle = 'rgba(8,12,16,.3)'; ctx.fillRect(x + 3, y + 4, w, h);
    ctx.fillStyle = b.k === 'house' || b.k === 'farmhouse' ? WC_HOUSE_ROOF[(b.r || 0) % 6] : b.work ? b.col : b.k === 'terminal' ? '#d7dde0' : b.k === 'barn' ? '#a63d33' : WC_ROOF[(b.t || 0) % 6];
    ctx.fillRect(x, y, w, h);
}
// ---- organic city outlines ------------------------------------------------------------------------------------------
function wcWrapD(d) { const C = WC.circ || 1800000; d = ((d % C) + C) % C; return d > C / 2 ? d - C : d; }
function wcCityR(q, ang) {
    if (!q.bp) return q.border; const N = q.bp.length, t = ((ang / (Math.PI * 2)) % 1 + 1) % 1 * N, i = Math.floor(t) % N, f = t - Math.floor(t);
    return q.bp[i] * (1 - f) + q.bp[(i + 1) % N] * f;
}
function wcInCity(q, x, y) { const dx = wcWrapD(x - q.cx), dy = y - q.cy; if (Math.abs(dx) > q.border || Math.abs(dy) > q.border) return false; return Math.hypot(dx, dy) < wcCityR(q, Math.atan2(dy, dx)); }
function wcCityPath(q, mx, my, scale) {                    // path of the city limit; screen space by default, or through (mx, my) mapping
    const N = q.bp ? q.bp.length : 64; ctx.beginPath();
    for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2, r = q.bp ? q.bp[i % N] : q.border, x = q.cx + Math.cos(a) * r, y = q.cy + Math.sin(a) * r; const sx = mx ? mx(x) : worldToScreenX(x), sy = my ? my(y) : worldToScreenY(y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }
    ctx.closePath();
}
// Toll gates: wherever an avenue or highway crosses a city limit (computed once from the outline).
function wcBuildGates() {
    WC.gates = [];
    for (const q of WC.cities || []) {
        const N = q.bp ? q.bp.length : 0; if (!N) continue;
        const P = []; for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2; P.push([q.cx + Math.cos(a) * q.bp[i], q.cy + Math.sin(a) * q.bp[i]]); }
        for (const r of WC.roads) {
            if (r.c !== 'a' && r.c !== 'x') continue;
            const vert = r.a === 'v', o = r.o ?? WC.center;
            if (Math.abs(r.p - (vert ? q.cx : q.cy)) > q.border) continue;
            for (let i = 0; i < N; i++) {
                const A = P[i], B = P[(i + 1) % N], ua = vert ? A[0] : A[1], ub = vert ? B[0] : B[1];
                if ((ua - r.p) * (ub - r.p) > 0 || ua === ub) continue;
                const t = (r.p - ua) / (ub - ua), along = vert ? A[1] + (B[1] - A[1]) * t : A[0] + (B[0] - A[0]) * t;
                if (along < o - r.e || along > o + r.e) continue;
                WC.gates.push({ x: vert ? r.p : along, y: vert ? along : r.p, vert, hw: r.hw, name: q.name, toll: q.toll });
            }
        }
    }
}
function wcDrawExterior() {
    const s = 1 / fov, W = canvas.width, H = canvas.height;
    const vx0 = camera.x - 100, vy0 = camera.y - 100, vx1 = camera.x + W * fov + 100, vy1 = camera.y + H * fov + 100;
    wcFillTex('grass', camera.x, camera.y, W * fov, H * fov, 110);
    for (const q of WC.cities || []) {                                    // ground wash inside each foreign city (its organic outline)
        const th = WC_THEME[q.theme]; if (!th) continue;
        if (q.cx + q.border < vx0 || q.cx - q.border > vx1 || q.cy + q.border < vy0 || q.cy - q.border > vy1) continue;
        ctx.fillStyle = th.grass; wcCityPath(q); ctx.fill();
    }
    const lod = s < 0.4;                                                  // seen from a plane: cheaper detail
    const cx0 = Math.max(0, Math.floor(vx0 / WC.chunk)), cx1 = Math.min(WC.nch - 1, Math.floor(vx1 / WC.chunk)), cy0 = Math.max(0, Math.floor(vy0 / WC.chunk)), cy1 = Math.min(WC.nch - 1, Math.floor(vy1 / WC.chunk));
    const list = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const c = WC.chunks.get(cx + cy * WC.nch); if (c) list.push(c); }
    const seen = new Set(), vis = (x, y, w, h) => x < vx1 && y < vy1 && x + w > vx0 && y + h > vy0;
    const once = (k) => { if (seen.has(k)) return false; seen.add(k); return true; };
    for (const c of list) for (const b of c.blocks) if (vis(b.x, b.y, b.w, b.h) && once('b' + b.id)) wcDrawBlock(b, s);
    for (const c of list) for (const f of c.fields) if (vis(f.x, f.y, f.w, f.h) && once('f' + f.id)) wcDrawField(f, s);
    wcDrawRoads(vx0, vy0, vx1, vy1, s);
    if (s > 0.3) for (const c of list) for (const j of c.junctions) if (vis(j.x - 140, j.y - 140, 280, 280) && once('j' + j.id)) wcDrawJunction(j, s);
    for (const c of list) for (const l of c.lots) if (vis(l.x, l.y, l.w, l.h) && once('l' + l.id)) wcDrawLot(l, s);
    for (const c of list) for (const p of c.props) if (p.k === 'pave' || p.k === 'lake') { if (vis(p.x, p.y, p.w, p.h) && once('g' + p.k + p.x + ',' + p.y)) wcDrawGroundProp(p, s); }
    for (const c of list) for (const p of c.props) if (p.k === 'apron' || p.k === 'taxiway' || p.k === 'runway') { if (vis(p.x, p.y, p.w, p.h) && once('p' + p.k + p.x + ',' + p.y)) wcDrawAirProp(p, s); }
    for (const c of list) for (const p of c.props) if (p.k === 'path' || p.k === 'yard' || p.k === 'fountain') { if (vis(p.x, p.y, p.w, p.h) && once('p' + p.k + p.x + ',' + p.y)) wcDrawProp(p, s, 0); }
    if (!lod) for (const c of list) for (const q of c.pcars) {
        if (!vis(q.x - 40, q.y - 40, 80, 80)) continue;
        const van = q.t === 1; wcBlitCar(wcCarSprite(WC.carColors[q.c % WC.carColors.length] || '#ccc', van ? 3 : 0, van ? 66 : 56, van ? 32 : 29), q.x, q.y, q.a);
    }
    for (const c of list) for (const b of c.buildings) {
        if (!vis(b.x - WC_PAD, b.y - WC_PAD, b.w + 2 * WC_PAD, b.h + 2 * WC_PAD) || !once('B' + b.id)) continue;
        if (lod) { wcDrawBuildingLod(b, s); continue; }
        if (b.k === 'house') wcHouseLot(b, s);
        wcBlit(wcBuildingSprite(b), b.x, b.y);
    }
    for (const c of list) for (const p of c.props) if (p.k === 'plane' && vis(p.x - 60, p.y - 60, p.w + 120, p.h + 120) && once('pl' + p.cx + ',' + p.cy)) wcDrawStaticPlane(p, s);
    for (const c of list) for (const p of c.props) if (p.k === 'silo' && vis(p.x, p.y, p.w, p.h) && once('s' + p.x + ',' + p.y)) wcDrawProp(p, s, 0);
    const nightL = wcNightLevel();
    for (const c of list) for (const p of c.props) if ((p.k === 'pump' || p.k === 'stall' || p.k === 'billboard') && vis(p.x - 20, p.y - 20, p.w + 40, p.h + 40) && once('sp' + p.k + p.x + ',' + p.y)) wcDrawStreetProp(p, s, nightL);
    wcUpdateDyn(); wcDrawDyn(vx0, vy0, vx1, vy1, s);
    for (const c of list) for (const p of c.props) if ((p.k === 'canopy' || p.k === 'holo') && vis(p.x - 60, p.y - 60, p.w + 120, p.h + 120) && once('cp' + p.k + p.x + ',' + p.y)) wcDrawStreetProp(p, s, nightL);
    wcDrawMissionExtras(s);
    if (!lod) for (const c of list) for (const p of c.props) if ((p.k === 'lamp' || p.k === 'bench' || p.k === 'atm') && vis(p.x - 10, p.y - 10, (p.w || 0) + 20, (p.h || 0) + 20) && once('q' + p.k + p.x + ',' + p.y)) wcDrawProp(p, s, 1);
    for (const c of list) for (const p of c.props) if (p.k === 'tree' && p.x > vx0 - 60 && p.x < vx1 + 60 && p.y > vy0 - 60 && p.y < vy1 + 60) { if (s < 0.22) { ctx.fillStyle = (p.v >> 2) & 1 ? '#3a7e46' : '#5a9c46'; ctx.fillRect(worldToScreenX(p.x) - p.r * s, worldToScreenY(p.y) - p.r * s, 2 * p.r * s, 2 * p.r * s); } else wcDrawTree(p, s); }
    wcDrawBorder(s, W, H); wcDrawWater(s, W, H);
    const meF = myId != null ? gameState.entities.find(e => e.id === myId) : null;
    if (meF && meF.fl) wcDrawClouds(W, H, renderEntities.get(meF.id)?.flAlt ?? meF.fl.alt);
    wcDrawDayNight(W, H); wcDrawNav(s, W, H);
}
// Water beyond the shoreline (server keeps everything inside WC_SHORE) and a shared-clock day/night cycle.
const WC_SHORE = 1800, WC_DAY_MS = 12 * 60 * 1000;
function wcDrawWater(s, W, H) {
    const Ld = WC.land || { x0: WC_SHORE, x1: WC.extent - WC_SHORE, y0: WC_SHORE, y1: WC.extent - WC_SHORE }, wob = Math.sin(Date.now() / 900) * 6;
    const rect = (x0, y0, x1, y1, col) => {
        const ax = Math.max(x0, camera.x), ay = Math.max(y0, camera.y), bx = Math.min(x1, camera.x + W * fov), by = Math.min(y1, camera.y + H * fov);
        if (bx <= ax || by <= ay) return;
        ctx.fillStyle = col; ctx.fillRect(worldToScreenX(ax), worldToScreenY(ay), (bx - ax) * s, (by - ay) * s);
    };
    const B = -1e9, E = 1e9, a = Ld.x0, z = Ld.x1, t = Ld.y0, u = Ld.y1, sand = 70;
    for (const [x0, y0, x1, y1] of [[B, B, E, t], [B, u, E, E], [B, t, a, u], [z, t, E, u]]) rect(x0, y0, x1, y1, '#2b6a94');
    for (const [x0, y0, x1, y1] of [[B, t - 90 + wob, E, t], [B, u, E, u + 90 - wob], [a - 90 + wob, t, a, u], [z, t, z + 90 - wob, u]]) rect(x0, y0, x1, y1, 'rgba(120,200,225,.45)');
    for (const [x0, y0, x1, y1] of [[a, t, z, t + sand], [a, u - sand, z, u], [a, t, a + sand, u], [z - sand, t, z, u]]) rect(x0, y0, x1, y1, 'rgba(222,205,150,.55)');
    // open ocean: a few slow swells so the long Pacific crossing isn't a flat blue screen
    if (camera.x + W * fov < a || camera.x > z || camera.y + H * fov < t || camera.y > u) {
        const now = Date.now() / 1000, CELL = 900; ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = Math.max(1, 3 * s); ctx.beginPath();
        for (let i = Math.floor(camera.x / CELL); i <= Math.floor((camera.x + W * fov) / CELL); i++) for (let j = Math.floor(camera.y / CELL); j <= Math.floor((camera.y + H * fov) / CELL); j++) {
            const r = wcRng(i * 92821 ^ j * 68917), wx = (i + r()) * CELL + Math.sin(now * 0.6 + r() * 6) * 30, wy = (j + r()) * CELL; if ((wx > a && wx < z && wy > t && wy < u)) continue;
            const sx = worldToScreenX(wx), sy = worldToScreenY(wy); ctx.moveTo(sx - 60 * s, sy); ctx.quadraticCurveTo(sx, sy - 14 * s, sx + 60 * s, sy);
        }
        ctx.stroke();
    }
}
setInterval(() => { if (isWorldMode && WC.scene === 'ext' && WC.navMode && WC.navMode !== 'off') worldSend('world_nav', { t: WC.navMode, ...(WC.navPin || {}) }); }, 1200);
function wcDrawNav(s, W, H) {
    const n = WC.nav; if (!n || !WC.navMode || WC.navMode === 'off') return;
    const cx = camera.x + W * fov / 2, cy = camera.y + H * fov / 2, r = n.route, X = worldToScreenX, Y = worldToScreenY;
    const chain = [[cx, cy]]; let man = null;
    if (r && r.pts.length > 1) {
        let st = 1;                                          // drop route points the player has already passed
        while (st < r.pts.length - 1) {
            const a = r.pts[st], b = r.pts[st + 1], dx = b[0] - a[0], dy = b[1] - a[1], t = ((cx - a[0]) * dx + (cy - a[1]) * dy) / (dx * dx + dy * dy || 1);
            const tc = Math.max(0, Math.min(1, t));
            if (t > 0 && Math.hypot(cx - (a[0] + dx * tc), cy - (a[1] + dy * tc)) < 90) st++; else break;
        }
        for (let i = st; i < r.pts.length; i++) chain.push(r.pts[i]);
        let acc = 0;
        for (let i = 1; i < chain.length; i++) { acc += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]); const tn = r.turns[st + i - 1]; if (tn) { man = { turn: tn, d: acc }; break; } }
    } else chain.push([n.x, n.y]);
    const lw = Math.max(6, 22 * s);
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const trace = () => { ctx.beginPath(); chain.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))); };
    trace(); ctx.strokeStyle = 'rgba(8,36,76,.8)'; ctx.lineWidth = lw * 1.5; ctx.stroke();
    trace(); ctx.strokeStyle = '#2fa8f0'; ctx.lineWidth = lw; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = Math.max(2, lw * 0.22); ctx.setLineDash([lw * 0.9, lw * 1.6]); ctx.lineDashOffset = -performance.now() / 25; ctx.stroke(); ctx.setLineDash([]);
    // destination pin / off-screen arrow
    const tx = X(n.x), ty = Y(n.y), px = X(cx), py = Y(cy), ang = Math.atan2(ty - py, tx - px), on = tx > 20 && tx < W - 20 && ty > 20 && ty < H - 20;
    const mx = on ? tx : Math.max(40, Math.min(W - 40, px + Math.cos(ang) * Math.min(W, H) * 0.42)), my = on ? ty : Math.max(40, Math.min(H - 40, py + Math.sin(ang) * Math.min(W, H) * 0.42));
    ctx.translate(mx, my); if (!on) ctx.rotate(ang);
    ctx.fillStyle = '#ffcf3a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath();
    if (on) ctx.arc(0, 0, 14, 0, 7); else { ctx.moveTo(18, 0); ctx.lineTo(-12, -13); ctx.lineTo(-6, 0); ctx.lineTo(-12, 13); ctx.closePath(); }
    ctx.fill(); ctx.stroke(); ctx.restore();
    // turn-by-turn banner
    const fmt = d => { const m = Math.round(d / 10 / 10) * 10; return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : (m < 10 ? 'now' : m + ' m'); };
    const ICON = { left: '⬅', right: '➡', uturn: '↩', arrive: '🏁' }, WORD = { left: 'Turn left', right: 'Turn right', uturn: 'Make a U-turn', arrive: 'Arrive at ' + n.label };
    let line1, line2;
    if (man) { line1 = `${ICON[man.turn]}  ${man.d < 120 ? '' : 'In ' + fmt(man.d) + ': '}${WORD[man.turn]}`; line2 = `${n.label} · ${fmt(r && r.len ? Math.hypot(n.x - cx, n.y - cy) : Math.hypot(n.x - cx, n.y - cy))} to go`; }
    else { line1 = `⬆  Continue to ${n.label}`; line2 = fmt(Math.hypot(n.x - cx, n.y - cy)) + ' to go'; }
    ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold 22px sans-serif'; const bw = Math.max(260, ctx.measureText(line1).width + 50);
    ctx.fillStyle = 'rgba(10,22,40,.88)'; ctx.fillRect(W / 2 - bw / 2, 64, bw, 62); ctx.strokeStyle = '#2fa8f0'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - bw / 2, 64, bw, 62);
    ctx.fillStyle = '#fff'; ctx.fillText(line1, W / 2, 94); ctx.font = '14px sans-serif'; ctx.fillStyle = '#9fd8ff'; ctx.fillText(line2 + '   (N: change)', W / 2, 115); ctx.restore();
}
// ---- city limit + toll gates (the server charges the toll; see W_BORDER / W_TOLL) ------------------------------
const WC_BORDER = 19500, WC_TOLL = 20;
function wcDrawBorder(s, W, H) {
    if (!WC.roads || !WC.cities) return;
    const X = worldToScreenX, Y = worldToScreenY, vx0 = camera.x - 200, vy0 = camera.y - 200, vx1 = camera.x + W * fov + 200, vy1 = camera.y + H * fov + 200;
    ctx.save(); ctx.lineWidth = Math.max(2, 8 * s); ctx.strokeStyle = '#e8c53a'; ctx.setLineDash([40 * s, 40 * s]);
    for (const q of WC.cities) { if (q.cx + q.border < vx0 || q.cx - q.border > vx1 || q.cy + q.border < vy0 || q.cy - q.border > vy1) continue; wcCityPath(q); ctx.stroke(); }
    ctx.setLineDash([]); ctx.restore();
    for (const g of WC.gates || []) {
        if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
        const hw = g.hw, px = X(g.x), py = Y(g.y);
        ctx.save(); ctx.translate(px, py); if (!g.vert) ctx.rotate(Math.PI / 2);
        ctx.fillStyle = '#2b3138'; ctx.fillRect(-hw * s - 14 * s, -9 * s, (hw * 2 + 28) * s, 18 * s);
        ctx.fillStyle = '#e8c53a'; for (let i = -hw; i < hw; i += 30) ctx.fillRect(i * s, -9 * s, 15 * s, 4 * s);
        ctx.fillStyle = '#cfd6dc'; ctx.fillRect(-14 * s, -34 * s, 28 * s, 68 * s);
        ctx.fillStyle = '#c0392b'; ctx.fillRect(-14 * s, -34 * s, 28 * s, 8 * s);
        for (const lane of [-0.5, 0.5]) { ctx.fillStyle = '#fff'; ctx.fillRect((lane * hw - 30) * s, 14 * s, 60 * s, 6 * s); ctx.fillStyle = '#d63a2a'; for (let i = 0; i < 3; i++) ctx.fillRect((lane * hw - 30 + i * 20 + 10) * s, 14 * s, 10 * s, 6 * s); }
        ctx.restore();
        if (s > 0.25) { ctx.fillStyle = '#103a6b'; ctx.fillRect(px - 62 * s, py - 62 * s, 124 * s, 22 * s); ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, 12 * s)}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(g.name + ' · TOLL ' + g.toll, px, py - 46 * s); }
    }
}
// ---- world map: pick any place (or click anywhere) and the satnav routes there --------------------------------
function wcSetNav(mode, pin) {
    WC.navMode = mode; WC.nav = null; WC.navPin = pin || null;
    if (mode === 'off') { wcToast('Satnav off'); return; }
    worldSend('world_nav', { t: mode, ...(pin || {}) });
    wcToast('Satnav: ' + (pin ? pin.label : { work: 'nearest workplace', home: 'home', car: 'your car', atm: 'nearest ATM', bank: 'Central Bank', dealer: 'Car Dealership', airport: 'nearest airport', mission: 'your job', fuel: 'nearest fuel station', hotel: 'hotel', shop: 'nearest grocery', mall: 'nearest mall' }[mode]));
}
let wcMapEl = null, wcMapSel = null;
function wcMapBuild() {
    const btn = document.createElement('button'); btn.textContent = '🗺 Map';
    btn.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:60;padding:8px 20px;border:0;border-radius:20px;background:#1d6fa5;color:#fff;font:bold 15px sans-serif;cursor:pointer;display:none;box-shadow:0 2px 8px rgba(0,0,0,.45)';
    btn.onclick = () => wcMapToggle(true); document.body.appendChild(btn);
    const ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(5,10,20,.78);display:none;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;font-family:sans-serif';
    ov.innerHTML = '<canvas id="wc-map-cv" style="border:3px solid #fff;border-radius:8px;cursor:crosshair;background:#2b6a94"></canvas><div id="wc-map-side" style="display:flex;flex-direction:column;gap:6px;min-width:200px;max-height:94vh;overflow-y:auto;padding-right:4px"></div>';
    document.body.appendChild(ov);
    const side = ov.querySelector('#wc-map-side'), mk = (t, f) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'padding:9px 12px;border:0;border-radius:8px;background:#26496b;color:#fff;font:bold 14px sans-serif;cursor:pointer;text-align:left'; b.onclick = f; side.appendChild(b); return b; };
    side.innerHTML = '<div style="color:#fff;font:bold 18px sans-serif">World map</div><div style="color:#9fd8ff;font-size:13px">Click anywhere to set a destination.</div>';
    for (const [t, m] of [['🏠 Home', 'home'], ['🚗 My car', 'car'], ['💼 Nearest workplace', 'work'], ['🏧 Nearest ATM', 'atm'], ['🏦 Central Bank', 'bank'], ['🚘 Car Dealership', 'dealer'], ['✈ Nearest airport', 'airport'], ['⛽ Nearest fuel', 'fuel'], ['🏨 Hotel', 'hotel'], ['🛒 Grocery', 'shop'], ['🛍 Mall', 'mall']]) mk(t, () => { if (wcMapEl.taxi) { worldSend('world_taxi', { act: 'hail', t: m }); wcMapToggle(false); } else { wcSetNav(m); wcMapToggle(false); } });
    mk('🧭 Navigate to selected point', () => { if (wcMapSel) { wcSetNav('pin', wcMapSel); wcMapToggle(false); } else wcToast('Click the map first.'); }).style.background = '#1d8a4f';
    mk('🚕 Taxi to selected point', () => { if (wcMapSel) { worldSend('world_taxi', { act: 'hail', t: 'pin', ...wcMapSel }); wcMapToggle(false); } else wcToast('Click the map first.'); }).style.background = '#a07a00';
    mk('✖ Cancel taxi', () => { worldSend('world_taxi', { act: 'cancel' }); wcMapToggle(false); });
    mk('✖ Stop satnav', () => { wcSetNav('off'); wcMapToggle(false); }); mk('Close', () => wcMapToggle(false));
    const cv = ov.querySelector('#wc-map-cv');
    const view = { x: WC.extent / 2, y: (WC.extentY || WC.extent) / 2, half: WC.extent / 2 }; let drag = null;
    const toWorld = ev => { const r = cv.getBoundingClientRect(), u = (ev.clientX - r.left) / r.width, w = (ev.clientY - r.top) / r.height; return [view.x - view.half + u * 2 * view.half, view.y - view.half + w * 2 * view.half]; };
    cv.onmousedown = ev => { drag = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false }; };
    window.addEventListener('mouseup', () => { drag = null; });
    cv.onmousemove = ev => { if (!drag) return; const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true; if (!drag.moved) return; const r = cv.getBoundingClientRect(), wpp = 2 * view.half / r.width; const C = WC.circ || WC.extent; view.x = ((drag.vx - dx * wpp) % C + C) % C; view.y = drag.vy - dy * wpp; wcMapDraw(); };
    cv.onwheel = ev => { ev.preventDefault(); const [wx, wy] = toWorld(ev), f = ev.deltaY < 0 ? 0.8 : 1.25, nh = Math.max(1500, Math.min((WC.circ || WC.extent) / 2, view.half * f)); view.x = wx - (wx - view.x) * nh / view.half; view.y = wy - (wy - view.y) * nh / view.half; view.half = nh; wcMapDraw(); };
    cv.onclick = ev => {
        if (drag && drag.moved) return;
        let [mx, my] = toWorld(ev); const C = WC.circ || WC.extent; mx = ((mx % C) + C) % C; let best = null, bd = (14 * 2 * view.half / cv.width) ** 2;
        for (const q of WC.mapPlaces || []) { const d = wcWrapD(q[1] - mx) ** 2 + (q[2] - my) ** 2; if (d < bd) { bd = d; best = q; } }
        wcMapSel = best ? { x: best[1], y: best[2], label: best[3] } : { x: Math.round(mx), y: Math.round(my), label: 'Selected point' };
        wcMapDraw();
    };
    mk('🌍 Whole world', () => wcMapFocus(null));
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px'; side.appendChild(grid);
    for (const q of WC.cities) { const b = mk(`📍 ${q.name} ${wcTzLabel(q.tz)}`, () => wcMapFocus(q)); b.style.fontSize = '12px'; b.style.padding = '7px 8px'; grid.appendChild(b); }
    wcMapEl = { btn, ov, cv, view };
    setInterval(() => { const bx = camera.x + canvas.width * fov / 2, by = camera.y + canvas.height * fov / 2, hc = wcCityHere(bx, by); const Ld = WC.land, sea = Ld && (bx < Ld.x0 || bx > Ld.x1 || by < Ld.y0 || by > Ld.y1); btn.textContent = `🗺 Map · ${hc ? hc.name : sea ? 'Open ocean' : 'Open road'} · ${wcClock(bx)}`; btn.style.display = isWorldMode && WC.scene === 'ext' ? 'block' : 'none'; if (!(isWorldMode && WC.scene === 'ext')) ov.style.display = 'none'; }, 400);
}
function wcMapFocus(city) {
    const v = wcMapEl.view;
    if (!city) { const L = WC.land; v.x = L ? (L.x0 + L.x1) / 2 : WC.extent / 2; v.y = (WC.extentY || WC.extent) / 2; v.half = (WC.circ || WC.extent) / 2; v.x = (WC.circ || WC.extent) / 2; }
    else { v.x = city.cx; v.y = city.cy; v.half = city.border * 1.2; }
    wcMapDraw();
}
function wcMapToggle(on, mode) {
    if (!wcMapEl) wcMapBuild();
    wcMapEl.ov.style.display = on ? 'flex' : 'none';
    wcMapEl.taxi = mode === 'taxi';
    const hint = wcMapEl.ov.querySelector('#wc-map-side div:nth-child(2)'); if (hint) hint.textContent = wcMapEl.taxi ? '🚕 Taxi mode: pick a place below, or click the map then “Taxi to selected point”.' : 'Click anywhere to set a destination.';
    if (on) {
        const sz = Math.floor(Math.min(innerWidth - 260, innerHeight - 40, 820)); wcMapEl.cv.width = wcMapEl.cv.height = Math.max(300, sz); wcMapEl.cv.style.width = wcMapEl.cv.style.height = wcMapEl.cv.width + 'px';
        const px = camera.x + canvas.width * fov / 2, py = camera.y + canvas.height * fov / 2;
        wcMapFocus(wcCityHere(px, py)); worldSend('world_map');
    }
}
// The map wraps east-west like the globe: drag past the date line and the other side comes round again.
function wcMapDraw() {
    if (!wcMapEl || wcMapEl.ov.style.display === 'none' || !WC.roads) return;
    const cv = wcMapEl.cv, g = cv.getContext('2d'), N = cv.width, v = wcMapEl.view, k = N / (2 * v.half), C = WC.center, CIRC = WC.circ || WC.extent, EY = WC.extentY || WC.extent;
    const S = n => n * k, MY = y => (y - v.y + v.half) * k;
    g.fillStyle = '#2b6a94'; g.fillRect(0, 0, N, N);
    const offs = [-CIRC, 0, CIRC].filter(o => o + CIRC > v.x - v.half && o < v.x + v.half);
    const Ld = WC.land || { x0: 1800, x1: WC.extent - 1800, y0: 1800, y1: EY - 1800 };
    for (const o of offs) {
        const MX = x => (x + o - v.x + v.half) * k;
        g.fillStyle = '#7fae66'; g.fillRect(MX(Ld.x0), MY(Ld.y0), S(Ld.x1 - Ld.x0), S(Ld.y1 - Ld.y0));
        // time-zone bands (each column is 6 hours)
        if (WC.gap) for (let c = 0; c < Math.round(CIRC / WC.gap); c++) {
            const x0 = c * WC.gap, tz = Math.round(wcWrapD(x0 + WC.gap / 2 - C) / WC.gap) * 6;
            if (c % 2) { g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(MX(x0), 0, S(WC.gap), N); }
            g.fillStyle = 'rgba(255,255,255,.75)'; g.font = 'bold 13px sans-serif'; g.textAlign = 'center'; g.fillText(wcTzLabel(tz <= -12 ? tz + 24 : tz), MX(x0 + WC.gap / 2), N - 12);
        }
        for (const q of WC.cities) {
            const mx = x => MX(x), cs = (q.border * k);
            if (mx(q.cx) + cs < 0 || mx(q.cx) - cs > N) continue;
            const path = (sc) => { const P = q.bp || []; g.beginPath(); for (let i = 0; i <= P.length; i++) { const a = i / P.length * Math.PI * 2, r = P[i % P.length] * sc; i ? g.lineTo(mx(q.cx + Math.cos(a) * r), MY(q.cy + Math.sin(a) * r)) : g.moveTo(mx(q.cx + Math.cos(a) * r), MY(q.cy + Math.sin(a) * r)); } g.closePath(); };
            g.fillStyle = '#b8b7ac'; path(1); g.fill(); g.fillStyle = '#d4d0c2'; path(0.5); g.fill(); g.fillStyle = '#e6e2d4'; path(0.2); g.fill();
            g.setLineDash([6, 5]); g.strokeStyle = '#e8c53a'; g.lineWidth = 2; path(1); g.stroke(); g.setLineDash([]);
        }
        for (const r of WC.roads) {
            const ro = r.o ?? C, vert = r.a === 'v'; if (S(r.e) < 0.6 && r.c !== 'x') continue;
            if (vert ? (MX(r.p) < -5 || MX(r.p) > N + 5) : (MX(ro + r.e) < 0 || MX(ro - r.e) > N)) continue;
            g.strokeStyle = r.c === 'x' ? '#d98a1f' : r.c === 'a' ? '#6d7680' : r.c === 's' ? '#8d949b' : '#a5abb0';
            g.lineWidth = r.c === 'x' ? 3.5 : r.c === 'a' ? 2.2 : 1; g.beginPath();
            if (vert) { g.moveTo(MX(r.p), MY(ro - r.e)); g.lineTo(MX(r.p), MY(ro + r.e)); } else { g.moveTo(MX(ro - r.e), MY(r.p)); g.lineTo(MX(ro + r.e), MY(r.p)); }
            g.stroke();
        }
        // the date line, mid-ocean between the CT+12 and CT-6 columns
        g.save(); g.setLineDash([10, 8]); g.strokeStyle = 'rgba(255,120,120,.85)'; g.lineWidth = 2; g.beginPath(); g.moveTo(MX(0), 0); g.lineTo(MX(0), N - 30); g.stroke(); g.restore();
        g.save(); g.translate(MX(0) + 14, N / 2); g.rotate(-Math.PI / 2); g.fillStyle = 'rgba(255,190,190,.95)'; g.font = 'bold 12px sans-serif'; g.textAlign = 'center'; g.fillText('INTERNATIONAL DATE LINE', 0, 0); g.restore();
        g.textAlign = 'center'; g.font = 'bold 14px sans-serif';
        for (const q of WC.cities) { const x = MX(q.cx), y = MY(q.cy); if (x > -50 && x < N + 50 && y > -50 && y < N + 50) { const t = `${q.name} · ${wcTzLabel(q.tz)}`; g.fillStyle = '#000'; g.fillText(t, x + 1, y + 1); g.fillStyle = '#fff'; g.fillText(t, x, y); } }
        const showA = v.half < 40000, showW = v.half < 150000; g.font = '15px sans-serif';
        for (const q of WC.mapPlaces || []) {
            const x = MX(q[1]), y = MY(q[2]); if (x < -10 || y < -10 || x > N + 10 || y > N + 10) continue;
            if (q[0] === 'w') { if (!showW) continue; g.fillStyle = q[4] || '#c33'; g.fillRect(x - 2.5, y - 2.5, 5, 5); }
            else if (q[0] === 'a') { if (!showA) continue; g.fillStyle = '#1b7a3d'; g.fillRect(x - 1.5, y - 1.5, 3, 3); }
            else if (q[0] === 'airport') { g.font = '18px sans-serif'; g.fillText('✈', x, y + 6); g.font = '15px sans-serif'; }
            else if (showW) g.fillText({ bank: '🏦', dealer: '🚘', hall: '🏛', mall: '🛍', megamall: '🛍', school: '🏫', hotel: '🏨', fuel: '⛽', attr: '🖼' }[q[0]] || '•', x, y + 5);
        }
        if (!WC.mapPlaces) for (const a of WC.airports || []) { g.font = '18px sans-serif'; g.fillText('✈', MX(a.door.x), MY(a.door.y) + 6); }
        const n = WC.nav;
        if (n && n.route) { g.strokeStyle = '#18a0ff'; g.lineWidth = 3; g.beginPath(); n.route.pts.forEach((p, i) => i ? g.lineTo(MX(p[0]), MY(p[1])) : g.moveTo(MX(p[0]), MY(p[1]))); g.stroke(); }
        const pin = wcMapSel || (n && { x: n.x, y: n.y, label: n.label });
        if (pin) { g.font = '22px sans-serif'; g.fillText('📍', MX(pin.x), MY(pin.y)); g.font = 'bold 13px sans-serif'; g.fillStyle = '#000'; g.fillText(pin.label || '', MX(pin.x) + 1, MY(pin.y) - 22); g.fillStyle = '#fff'; g.fillText(pin.label || '', MX(pin.x), MY(pin.y) - 23); }
        const px = camera.x + canvas.width * fov / 2, py = camera.y + canvas.height * fov / 2;
        g.fillStyle = '#fff'; g.strokeStyle = '#e22'; g.lineWidth = 3; g.beginPath(); g.arc(MX(px), MY(py), 6, 0, 7); g.fill(); g.stroke();
    }
}
// Sunlight follows longitude continuously (one full day round the globe); clocks show zone time, 6 hours per column.
function wcDayPhase(px) { return (((Date.now() % WC_DAY_MS) / WC_DAY_MS + wcWrapD(px - WC.center) / (WC.circ || 1800000)) % 1 + 1) % 1; }
function wcTzAt(px) { const c = wcCityHere(px, camera.y + canvas.height * fov / 2); if (c) return c.tz; let tz = Math.round(wcWrapD(px - WC.center) / (WC.gap || 450000)) * 6; if (tz <= -12) tz += 24; return tz; }
function wcClock(px) { const tz = wcTzAt(px), h = ((6 + (Date.now() % WC_DAY_MS) / WC_DAY_MS * 24 + tz) % 24 + 24) % 24; return String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0') + ' ' + wcTzLabel(tz); }
function wcCityHere(px, py) { return (WC.cities || []).find(q => wcInCity(q, px, py)) || null; }
function wcNightLevel() { const t = wcDayPhase(camera.x + canvas.width * fov / 2), sun = Math.sin(t * Math.PI * 2); return Math.max(0, Math.min(1, (0.2 - sun) / 0.7)); }
function wcWeather(px, py) {                                             // 0..1 strength, fading in over 3 km outside the city limit
    const out = { rain: 0, fog: 0, heat: 0, petals: 0 };
    for (const q of WC.cities || []) {
        const dx = wcWrapD(px - q.cx), dy = py - q.cy; if (Math.abs(dx) > q.border + 3000 || Math.abs(dy) > q.border + 3000) continue;
        const k = Math.max(0, Math.min(1, (wcCityR(q, Math.atan2(dy, dx)) + 3000 - Math.hypot(dx, dy)) / 3000));
        if (q.theme === 'hill') out.rain = Math.max(out.rain, k); else if (q.theme === 'tropic') out.rain = Math.max(out.rain, k * 0.75);
        else if (q.theme === 'port') out.fog = Math.max(out.fog, k); else if (q.theme === 'pine') out.fog = Math.max(out.fog, k * 0.55);
        else if (q.theme === 'sun') out.heat = Math.max(out.heat, k); else if (q.theme === 'mesa') out.heat = Math.max(out.heat, k * 0.8);
        else if (q.theme === 'blossom') out.petals = Math.max(out.petals, k);
    }
    return out;
}
function wcDrawDayNight(W, H) {
    const px = camera.x + W * fov / 2, py = camera.y + H * fov / 2, t = wcDayPhase(px), sun = Math.sin(t * Math.PI * 2);
    const night = Math.max(0, Math.min(1, (0.2 - sun) / 0.7)) * 0.58, dusk = Math.max(0, 0.3 - Math.abs(sun)) / 0.3 * 0.16, wx = wcWeather(px, py);
    if (dusk > 0.005) { ctx.fillStyle = `rgba(255,140,60,${dusk})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (wx.heat > 0.02) { ctx.fillStyle = `rgba(255,190,90,${0.12 * wx.heat * Math.max(0, sun + 0.3)})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (wx.fog > 0.02) { ctx.fillStyle = `rgba(210,220,230,${0.34 * wx.fog})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (night > 0.005) { ctx.fillStyle = `rgba(8,14,52,${night})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (wx.rain > 0.02) {
        ctx.fillStyle = `rgba(40,55,80,${0.2 * wx.rain})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const now = performance.now(), n = Math.floor(220 * wx.rain); ctx.strokeStyle = 'rgba(190,210,240,.55)'; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let i = 0; i < n; i++) { const sx = (i * 7919) % canvas.width, sy = (i * 104729 + now * (0.7 + (i % 5) * 0.12)) % canvas.height; ctx.moveTo(sx, sy); ctx.lineTo(sx - 4, sy + 15); }
        ctx.stroke();
    }
    if (wx.petals > 0.02) {                                              // cherry-blossom petals drifting across Hanami Ridge
        const now = performance.now(), n = Math.floor(90 * wx.petals); ctx.fillStyle = 'rgba(255,190,215,.85)';
        for (let i = 0; i < n; i++) { const sx = ((i * 7919 + now * (0.05 + (i % 7) * 0.012)) % (canvas.width + 40)) - 20, sy = (i * 104729 + now * (0.04 + (i % 5) * 0.01)) % canvas.height; ctx.beginPath(); ctx.ellipse(sx, sy, 4, 2.4, (now / 600 + i) % 6.28, 0, 7); ctx.fill(); }
    }
}
// ---- interiors (static; rendered once into an offscreen canvas) ------------------------------------------------------------------
let wcIntCache = null;
function wcPaintFurniture(g, f, D) {
    const x = f.x, y = f.y, w = f.w, h = f.h, k = f.k, acc = D.theme.accent || '#5b7fa8';
    const sh = () => { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + 3, y + 4, w, h); };
    switch (k) {
        case 'rug': g.fillStyle = D.kind === 'house' ? '#8a4a4a' : '#44566c'; wcRR(g, x, y, w, h, 10); g.fill(); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 3; wcRR(g, x + 7, y + 7, w - 14, h - 14, 7); g.stroke(); break;
        case 'desk': sh(); g.fillStyle = '#9b7248'; g.fillRect(x, y, w, h); g.fillStyle = '#b88b5a'; g.fillRect(x + 2, y + 2, w - 4, h - 4); g.fillStyle = '#2a3036'; g.fillRect(x + w / 2 - 22, y + h - 20, 44, 11); g.fillStyle = '#4a5560'; g.fillRect(x + w / 2 - 20, y + h - 18, 40, 7); g.fillStyle = '#f1f1f1'; g.fillRect(x + 12, y + 12, 18, 12); break;
        case 'monitor': g.fillStyle = '#15191d'; g.fillRect(x, y, w, h); g.fillStyle = '#5aa6d8'; g.fillRect(x + 2, y + 1.5, w - 4, h - 3); break;
        case 'chair': g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(x + 2, y + 3, f.r, 0, 7); g.fill(); g.fillStyle = '#2f3b46'; g.beginPath(); g.arc(x, y, f.r, 0, 7); g.fill(); g.fillStyle = '#44566a'; g.beginPath(); g.arc(x, y, f.r * .7, 0, 7); g.fill(); break;
        case 'reception': sh(); g.fillStyle = '#5b4330'; g.fillRect(x, y, w, h); g.fillStyle = '#e3d6b8'; g.fillRect(x + 3, y + 3, w - 6, h - 12); g.fillStyle = acc; g.fillRect(x + 3, y + h - 8, w - 6, 5); g.fillStyle = '#e4b995'; g.beginPath(); g.arc(x + w / 2, y - 16, 9, 0, 7); g.fill(); g.fillStyle = '#4c5d70'; g.beginPath(); g.ellipse(x + w / 2, y - 3, 17, 8, 0, 0, 7); g.fill(); break;
        case 'sofa': sh(); g.fillStyle = '#3d556e'; wcRR(g, x, y, w, h, 10); g.fill(); g.fillStyle = '#4f6d8a'; wcRR(g, x + 8, y + 14, w - 16, h - 20, 7); g.fill(); g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1.5; for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo(x + 8 + i * (w - 16) / 3, y + 14); g.lineTo(x + 8 + i * (w - 16) / 3, y + h - 6); g.stroke(); } break;
        case 'plant': g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.arc(x + 3, y + 4, f.r, 0, 7); g.fill(); g.fillStyle = '#7a5538'; g.beginPath(); g.arc(x, y, f.r * .7, 0, 7); g.fill(); for (let i = 0; i < 7; i++) { g.fillStyle = i % 2 ? '#3d8a48' : '#58a85a'; g.beginPath(); g.arc(x + Math.cos(i * .9) * f.r * .5, y + Math.sin(i * .9) * f.r * .5, f.r * .55, 0, 7); g.fill(); } break;
        case 'cabinet': sh(); g.fillStyle = '#7d8790'; g.fillRect(x, y, w, h); g.fillStyle = '#a0abb3'; g.fillRect(x + 2, y + 2, w - 4, h - 4); g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + w / 2, y + 2); g.lineTo(x + w / 2, y + h - 2); g.stroke(); break;
        case 'cooler': g.fillStyle = '#cfd8de'; g.fillRect(x, y, w, h); g.fillStyle = '#6fb6e0'; g.beginPath(); g.arc(x + w / 2, y + h / 2, 10, 0, 7); g.fill(); break;
        case 'table': sh(); g.fillStyle = '#6b4a30'; wcRR(g, x, y, w, h, 6); g.fill(); g.fillStyle = '#8c6440'; wcRR(g, x + 3, y + 3, w - 6, h - 6, 5); g.fill(); break;
        case 'dining': sh(); g.fillStyle = '#6b4a30'; wcRR(g, x, y, w, h, 8); g.fill(); g.fillStyle = '#a07650'; wcRR(g, x + 3, y + 3, w - 6, h - 6, 6); g.fill(); g.fillStyle = '#f2efe6'; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(x + 25 + i * (w - 50) / 3, y + h / 2, 9, 0, 7); g.fill(); } break;
        case 'tv': sh(); g.fillStyle = '#14181c'; g.fillRect(x, y, w, h); g.fillStyle = '#3a5d78'; g.fillRect(x + 3, y + 3, w - 6, h - 9); break;
        case 'counter': case 'island': sh(); g.fillStyle = '#8a8f94'; g.fillRect(x, y, w, h); g.fillStyle = '#d9dcdc'; g.fillRect(x + 2, y + 2, w - 4, h - 4); if (k === 'counter') { g.fillStyle = '#7fa8bf'; wcRR(g, x + w * .2, y + 8, 42, h - 16, 6); g.fill(); g.fillStyle = '#2e3236'; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(x + w * .62 + (i % 2) * 22, y + 15 + Math.floor(i / 2) * 20, 7, 0, 7); g.fill(); } } else { g.fillStyle = '#c8a368'; g.fillRect(x + 6, y + h - 7, w - 12, 4); } break;
        case 'bed': sh(); g.fillStyle = '#5d3f2b'; wcRR(g, x, y, w, h, 8); g.fill(); g.fillStyle = '#efeae0'; wcRR(g, x + 6, y + 6, w - 12, h - 12, 6); g.fill(); g.fillStyle = '#fff'; wcRR(g, x + 14, y + 12, w / 2 - 20, 34, 8); g.fill(); wcRR(g, x + w / 2 + 6, y + 12, w / 2 - 20, 34, 8); g.fill(); g.fillStyle = '#5a7fa5'; wcRR(g, x + 6, y + 70, w - 12, h - 76, 6); g.fill(); break;
        case 'wardrobe': sh(); g.fillStyle = '#6c4d34'; g.fillRect(x, y, w, h); g.fillStyle = '#865f40'; g.fillRect(x + 2, y + 2, w - 4, h - 4); g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + w / 2, y + 2); g.lineTo(x + w / 2, y + h - 2); g.stroke(); break;
        case 'nightstand': sh(); g.fillStyle = '#7a5a3c'; g.fillRect(x, y, w, h); g.fillStyle = '#f6e3a4'; g.beginPath(); g.arc(x + w / 2, y + h / 2, 7, 0, 7); g.fill(); break;
        case 'kiosk': {
            const c = WC_STALL_COL[(f.col || 0) % 6]; sh(); g.fillStyle = D.theme.neon ? '#141225' : '#6b5a48'; g.fillRect(x, y, w, h);
            g.fillStyle = D.theme.neon ? '#231f3d' : '#f3efe6'; g.fillRect(x + 6, y + 6, w - 12, h - 30);
            for (let i = 0; i < 8; i++) { g.fillStyle = c[i % 2]; g.fillRect(x + i * w / 8, y + h - 24, w / 8 + 0.5, 24); }
            for (let i = 0; i < 6; i++) { g.fillStyle = ['#e0b04a', '#7fb46a', '#c95c4c', '#5a8fd0'][i % 4]; g.fillRect(x + 20 + i * (w - 40) / 6, y + 20, (w - 40) / 6 - 8, 14); }
            if (D.theme.neon) { g.save(); g.shadowColor = '#00e5ff'; g.shadowBlur = 10; g.strokeStyle = '#00e5ff'; g.lineWidth = 2; g.strokeRect(x + 2, y + 2, w - 4, h - 4); g.restore(); }
            wcBanner(g, (f.label || 'SHOP').toUpperCase(), x + w / 2, y + h / 2, w - 30, 24, D.theme.accent); break;
        }
        case 'escalator': { g.fillStyle = '#4c555d'; g.fillRect(x, y, w, h); g.fillStyle = '#9aa4ad'; for (let i = 8; i < h - 8; i += 12) g.fillRect(x + 8, y + i, w - 16, 6); g.fillStyle = '#fff'; g.font = 'bold 26px Ubuntu'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(f.dir > 0 ? '⬆' : '⬇', x + w / 2, y + h / 2); break; }
        case 'atrium': { g.fillStyle = 'rgba(10,14,20,.85)'; g.fillRect(x, y, w, h); g.strokeStyle = D.theme.neon ? '#ff2bd6' : '#c9a227'; g.lineWidth = 5; g.strokeRect(x, y, w, h); g.fillStyle = 'rgba(255,255,255,.06)'; for (let i = 0; i < 4; i++) g.fillRect(x + 20 + i * (w - 40) / 4, y + 20, (w - 40) / 4 - 14, h - 40); g.fillStyle = 'rgba(255,255,255,.55)'; g.font = 'bold 14px Ubuntu'; g.textAlign = 'center'; g.fillText('ATRIUM · LOWER FLOORS BELOW', x + w / 2, y + h / 2); break; }
        case 'bath': sh(); g.fillStyle = '#e9eef0'; wcRR(g, x, y, w, h, 12); g.fill(); g.fillStyle = '#9ccbe0'; wcRR(g, x + 8, y + 8, w - 16, h - 16, 10); g.fill(); g.fillStyle = '#b0b6ba'; g.beginPath(); g.arc(x + w - 14, y + h / 2, 4, 0, 7); g.fill(); break;
    }
}
function wcGetInterior() {
    if (wcIntCache && wcIntCache.key === WC.intKey) return wcIntCache;
    const D = WC.interior, fl = D.floor, M = 90, sc = Math.min(wcSPR, 1.25);
    const c = document.createElement('canvas'); c.width = Math.ceil((fl.w + 2 * M) * sc); c.height = Math.ceil((fl.h + 2 * M) * sc);
    const g = c.getContext('2d'); g.scale(sc, sc); g.translate(M - fl.x, M - fl.y);
    g.fillStyle = '#12171c'; g.fillRect(fl.x - M, fl.y - M, fl.w + 2 * M, fl.h + 2 * M);
    for (const r of D.rooms) {
        const col = { office: '#8d9aa8', lobby: '#d8d1c0', living: '#c9a070', kitchen: '#cfd3d0', bedroom: '#b9a7a0', mall: D.theme.neon ? '#2a2540' : '#e4dfd2' }[r.c] || '#bbb';
        if (r.c === 'mall') { g.fillStyle = col; g.fillRect(r.x, r.y, r.w, r.h); for (let x = r.x; x < r.x + r.w; x += 60) for (let y = r.y; y < r.y + r.h; y += 60) if (((x - r.x) / 60 + (y - r.y) / 60) % 2 === 0) { g.fillStyle = D.theme.neon ? 'rgba(255,43,214,.06)' : 'rgba(0,0,0,.04)'; g.fillRect(x, y, 60, 60); } continue; }
        g.fillStyle = col; g.fillRect(r.x, r.y, r.w, r.h); g.strokeStyle = 'rgba(0,0,0,.10)'; g.lineWidth = 1;
        if (r.c === 'living') { for (let y = r.y; y < r.y + r.h; y += 24) { g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke(); } }
        else if (r.c === 'office') { for (let x = r.x; x < r.x + r.w; x += 48) { g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); } for (let y = r.y; y < r.y + r.h; y += 48) { g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke(); } }
        else if (r.c === 'lobby' || r.c === 'kitchen') { for (let x = r.x; x < r.x + r.w; x += 40) for (let y = r.y; y < r.y + r.h; y += 40) { if (((x - r.x) / 40 + (y - r.y) / 40) % 2 === 0) { g.fillStyle = 'rgba(0,0,0,.05)'; g.fillRect(x, y, 40, 40); } } }
        else { g.fillStyle = 'rgba(255,255,255,.04)'; for (let i = 0; i < 300; i++) g.fillRect(r.x + (i * 97 % r.w), r.y + (i * 53 % r.h), 3, 3); }
    }
    if (D.kind === 'mall') { g.save(); g.fillStyle = D.theme.accent; g.fillRect(fl.x, fl.y - 26, fl.w, 26); g.fillStyle = '#fff'; g.font = 'bold 17px Ubuntu, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(D.theme.name.toUpperCase(), fl.x + fl.w / 2, fl.y - 12); g.restore(); }
    if (D.kind === 'office') { g.fillStyle = D.theme.accent; g.fillRect(fl.x, fl.y + fl.h - 304, fl.w, 5); g.save(); g.fillStyle = D.theme.accent; g.fillRect(fl.x, fl.y - 26, fl.w, 26); g.fillStyle = '#fff'; g.font = 'bold 17px Ubuntu, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(D.theme.name.toUpperCase(), fl.x + fl.w / 2, fl.y - 12); g.restore(); }
    for (const f of D.furn) wcPaintFurniture(g, f, D);
    for (const w of D.walls) { g.fillStyle = '#2a323b'; g.fillRect(w.x, w.y, w.w, w.h); g.fillStyle = '#566272'; g.fillRect(w.x + 2, w.y + 2, w.w - 4, Math.min(5, w.h - 4)); }
    const d = D.door; if (d.w > 0) { g.fillStyle = '#7a3b3b'; g.fillRect(d.x, d.y - 26, d.w, 26); g.fillStyle = 'rgba(255,255,255,.4)'; g.fillRect(d.x + 6, d.y - 22, d.w - 12, 3); g.fillStyle = '#e3d9b8'; g.fillRect(d.x, d.y, d.w, d.h);
    g.fillStyle = 'rgba(255,255,255,.7)'; g.font = 'bold 14px Ubuntu, Arial'; g.textAlign = 'center'; g.fillText('EXIT', d.x + d.w / 2, d.y - 8); }
    wcIntCache = { key: WC.intKey, c, M, sc, fl };
    return wcIntCache;
}
function wcDrawInterior() {
    if (!WC.interior) return;
    const I = wcGetInterior(), s = 1 / fov;
    ctx.fillStyle = '#0d1115'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(I.c, worldToScreenX(I.fl.x - I.M), worldToScreenY(I.fl.y - I.M), I.c.width / I.sc * s, I.c.height / I.sc * s);
    if (WC.interior.kind === 'office') {   // the desk you are at lights up when you work
        const me = gameState.entities.find(e => e.id === myId);
        for (const st of WC.interior.stations) if (me && Math.hypot(st.x - me.x, st.y - me.y) < st.r) { ctx.strokeStyle = 'rgba(255,230,120,.55)'; ctx.lineWidth = Math.max(2, 3 * s); ctx.beginPath(); ctx.arc(worldToScreenX(st.x), worldToScreenY(st.y), 26 * s, 0, 7); ctx.stroke(); }
    }
}
function drawWorldEnvironment() {
    if (!wcTex) wcMakeTex();
    ctx.save();
    if (WC.scene === 'ext') wcDrawExterior(); else wcDrawInterior();
    ctx.restore();
    wcPositionPrompt();                                                   // keep the bubble glued to its building / car
    const now = performance.now(); if (now - wcChipT > 400) { wcChipT = now; wcRenderChip(); }   // shift countdown
}
let wcChipT = 0;

// ---- minimap ----------------------------------------------------------------------------------------------------------------------------------
function drawWorldMinimap() {
    const me = gameState.entities.find(e => e.id === myId), px = me ? me.x : WC.pos.x, py = me ? me.y : WC.pos.y;
    mCtx.fillStyle = '#1b2228'; mCtx.fillRect(0, 0, 150, 150);
    if (WC.scene !== 'ext') {
        const D = WC.interior; if (!D) return; const fl = D.floor, k = 140 / Math.max(fl.w, fl.h), ox = 5 + (140 - fl.w * k) / 2, oy = 5 + (140 - fl.h * k) / 2;
        mCtx.fillStyle = '#7f8b94'; mCtx.fillRect(ox, oy, fl.w * k, fl.h * k);
        for (const w of D.walls) { mCtx.fillStyle = '#2b333b'; mCtx.fillRect(ox + (w.x - fl.x) * k, oy + (w.y - fl.y) * k, Math.max(1, w.w * k), Math.max(1, w.h * k)); }
        for (const f of D.furn) if (f.solid && f.w) { mCtx.fillStyle = '#5d6a74'; mCtx.fillRect(ox + (f.x - fl.x) * k, oy + (f.y - fl.y) * k, f.w * k, f.h * k); }
        mCtx.fillStyle = '#fff'; mCtx.strokeStyle = '#142027'; mCtx.lineWidth = 1.4; mCtx.beginPath(); mCtx.arc(ox + (px - fl.x) * k, oy + (py - fl.y) * k, 3.2, 0, 7); mCtx.fill(); mCtx.stroke();
        mCtx.strokeStyle = 'rgba(255,255,255,.85)'; mCtx.lineWidth = 1; mCtx.strokeRect(.5, .5, 149, 149); return;
    }
    const R = 2600, k = 150 / (2 * R), X = v => (v - px + R) * k, Y = v => (v - py + R) * k, C = WC.center;
    mCtx.save(); mCtx.beginPath(); mCtx.rect(0, 0, 150, 150); mCtx.clip();
    mCtx.fillStyle = '#2b6a94'; mCtx.fillRect(0, 0, 150, 150);
    const Ld = WC.land || { x0: -1e9, x1: 1e9, y0: -1e9, y1: 1e9 }; mCtx.fillStyle = '#7fa56a'; mCtx.fillRect(X(Ld.x0), Y(Ld.y0), (Ld.x1 - Ld.x0) * k, (Ld.y1 - Ld.y0) * k);
    const cx0 = Math.max(0, Math.floor((px - R) / WC.chunk)), cx1 = Math.min(WC.nch - 1, Math.floor((px + R) / WC.chunk)), cy0 = Math.max(0, Math.floor((py - R) / WC.chunk)), cy1 = Math.min(WC.nch - 1, Math.floor((py + R) / WC.chunk));
    const seen = new Set(), list = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const c = WC.chunks.get(cx + cy * WC.nch); if (c) list.push(c); }
    for (const c of list) for (const b of c.blocks) { if (seen.has('b' + b.id)) continue; seen.add('b' + b.id); mCtx.fillStyle = b.g === 'airport' ? '#9cc08a' : b.g === 'forest' ? '#4f7d47' : b.g === 'farm' ? '#9bb877' : b.g === 'park' || b.g === 'plaza' ? '#6fa062' : b.z <= 1 ? '#a9a99f' : b.z === 2 ? '#8db172' : '#8bb06d'; mCtx.fillRect(X(b.x), Y(b.y), b.w * k + .5, b.h * k + .5); }
    for (const c of list) for (const p of c.props) if ((p.k === 'runway' || p.k === 'taxiway' || p.k === 'apron') && !seen.has('r' + p.x + ',' + p.y)) { seen.add('r' + p.x + ',' + p.y); mCtx.fillStyle = p.k === 'apron' ? '#a9a99f' : '#3b4146'; mCtx.fillRect(X(p.x), Y(p.y), Math.max(1, p.w * k), Math.max(1, p.h * k)); }
    for (const c of list) for (const f of c.fields) { if (seen.has('f' + f.id)) continue; seen.add('f' + f.id); mCtx.fillStyle = f.kind === 'pitch' ? '#5c9a4e' : '#b89a55'; mCtx.fillRect(X(f.x), Y(f.y), f.w * k, f.h * k); }
    mCtx.fillStyle = '#39414a';
    for (const r of WC.roads) { const w = Math.max(1, 2 * r.hw * k); if (Math.abs((r.a === 'v' ? py : px) - (r.o ?? WC.center)) > r.e + R + 100) continue; if (r.a === 'v') { if (Math.abs(r.p - px) < R + 100) mCtx.fillRect(X(r.p) - w / 2, 0, w, 150); } else if (Math.abs(r.p - py) < R + 100) mCtx.fillRect(0, Y(r.p) - w / 2, 150, w); }
    for (const c of list) for (const l of c.lots) { if (seen.has('l' + l.id)) continue; seen.add('l' + l.id); mCtx.fillStyle = l.dealer ? '#c9a23a' : '#4b535b'; mCtx.fillRect(X(l.x), Y(l.y), l.w * k, l.h * k); }
    for (const c of list) for (const b of c.buildings) {
        if (seen.has('B' + b.id)) continue; seen.add('B' + b.id);
        let col = '#6d7a85'; const sz = b.k === 'house' || b.k === 'farmhouse' ? 3 : 0;
        if (b.k === 'bank') col = '#2f7cc4'; else if (b.k === 'dealer') col = '#e0592f'; else if (b.work) col = b.col; else if (sz) { const o = WC.houses.get(b.hid); col = !o ? '#f1e7a8' : o.m ? '#ffcc33' : '#a0856a'; } else if (b.k === 'barn') col = '#a63d33';
        mCtx.fillStyle = col;
        if (sz) mCtx.fillRect(X(b.x + b.w / 2) - 1.2, Y(b.y + b.h / 2) - 1.2, 2.4, 2.4); else mCtx.fillRect(X(b.x), Y(b.y), Math.max(1.5, b.w * k), Math.max(1.5, b.h * k));
    }
    for (const e of gameState.entities) { if (!['square', 'triangle', 'pentagon', 'hexagon', 'powerup'].includes(e.type)) continue; mCtx.fillStyle = e.type === 'square' ? '#f8de4d' : e.type === 'triangle' ? '#fc6868' : e.type === 'pentagon' ? '#7b83ff' : e.type === 'powerup' ? '#f5a6ff' : '#72eff4'; mCtx.fillRect(X(e.x) - 1, Y(e.y) - 1, 2, 2); }
    for (const e of gameState.entities) if (['tank', 'ai'].includes(e.type) && e.id !== myId && e.x != null) { mCtx.fillStyle = '#f0a0a0'; mCtx.fillRect(X(e.x) - 1.5, Y(e.y) - 1.5, 3, 3); }
    const myCar = worldState.car; if (myCar && myCar.x != null && !myCar.driven) { mCtx.fillStyle = '#ffb43a'; mCtx.strokeStyle = '#2a1d05'; mCtx.lineWidth = 1; mCtx.fillRect(X(myCar.x) - 2.5, Y(myCar.y) - 2.5, 5, 5); mCtx.strokeRect(X(myCar.x) - 2.5, Y(myCar.y) - 2.5, 5, 5); }
    mCtx.strokeStyle = 'rgba(255,255,255,.35)'; mCtx.lineWidth = .8; const vw = canvas.width * fov * k, vh = canvas.height * fov * k; mCtx.strokeRect(75 - vw / 2, 75 - vh / 2, vw, vh);
    mCtx.fillStyle = '#fff'; mCtx.strokeStyle = '#142027'; mCtx.lineWidth = 1.6; mCtx.beginPath(); mCtx.arc(75, 75, 3.5, 0, 7); mCtx.fill(); mCtx.stroke();
    mCtx.restore(); mCtx.strokeStyle = 'rgba(255,255,255,.85)'; mCtx.lineWidth = 1; mCtx.strokeRect(.5, .5, 149, 149);
}

function connectWS(regionStr, modeStr) {

    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';

    ws = new WebSocket(protocol + window.location.host);

    ws.binaryType = 'arraybuffer'

    function sendPing() {

        if (ws && ws.readyState === 1) {

            wsSendObj(({ type: 'ping', time: performance.now() }));

        }

    }

    ws.onopen = () => {

        wsSendObj(({ type: 'spectate', mode: modeStr, region: regionStr }));

        document.getElementById('playBtn').innerText = "Play";

        document.getElementById('playBtn').disabled = false;

        if (sessionToken) {
            wsSendObj(({ type: 'auth_login', token: sessionToken }));
        }
        if (pendingWorldJoin) { pendingWorldJoin=false; wsSendObj(({type:'world_join'})); }

        sendPing();

        if (window.inputInterval) clearInterval(window.inputInterval);

        window.inputInterval = setInterval(() => {

    
    if (myId) {

        let finalAngle = 0;

        let me = gameState.entities.find(e => e.id === myId);

        let myX, myY;



        if (autoSpin) spinAngle += 0.08;



        if (me) {

            myX = renderEntities.has(myId) ? renderEntities.get(myId).renderX : me.x;

            myY = renderEntities.has(myId) ? renderEntities.get(myId).renderY : me.y;

            finalAngle = getAimAngle(myX, myY);

        } else {

            myX = camera.x + canvas.width / 2;

            myY = camera.y + canvas.height / 2;

            finalAngle = getAimAngle(myX, myY);

        }



        // The protocol also carries a raw world-space aim point alongside the

        // angle. On mobile there's no real mouse position to report, so

        // synthesize one along the aim ray - keeps the two fields consistent

        // instead of sending a stale/zero mouse.rx/ry while aiming by touch.

        let sentRx = mouse.rx, sentRy = mouse.ry;

        if (mobileAim.active && !autoSpin) {

            sentRx = myX + Math.cos(finalAngle) * 1000;

            sentRy = myY + Math.sin(finalAngle) * 1000;

        }



        // 1. Allocate a 14-byte buffer:

        // Type (1B) + Flags (1B) + Angle (4B) + MouseX (4B) + MouseY (4B) = 14 Bytes

        const buffer = new ArrayBuffer(14);

        const view = new DataView(buffer);



        // 2. Set Message Type (1 = 'input')

        view.setUint8(0, 1);



        // 3. Pack booleans into a single byte using bitwise OR (|)

        let flags = 0;

        if (keys.w || keys.arrowup)                    flags |= (1 << 0); // Bit 0

        if (keys.s || keys.arrowdown)                   flags |= (1 << 1); // Bit 1

        if (keys.a || keys.arrowleft)                   flags |= (1 << 2); // Bit 2

        if (keys.d || keys.arrowright)                  flags |= (1 << 3); // Bit 3

        if (mouse.pressed || autoFire || mobileAim.firing) flags |= (1 << 4); // Bit 4

        if (mouse.repel)                                flags |= (1 << 5); // Bit 5

        

        view.setUint8(1, flags);



        // 4. Set the coordinates/angle as 32-bit floats (using little-endian: true)

        view.setFloat32(2, finalAngle, true);

        view.setFloat32(6, sentRx, true);

        view.setFloat32(10, sentRy, true);



        // 5. Send the raw binary buffer instead of a string

        ws.send(buffer);

    }

}, 1000 / 120); // Assuming a 120Hz tick rate or your custom interval

        const urlParams = new URLSearchParams(window.location.search);

        const token = urlParams.get('token');

        

        if (token) {

            wsSendObj(({ type: 'auth_login', token: token }));

            window.history.replaceState({}, document.title, "/"); 

        }

    };



    ws.onmessage = (e) => {

        const data = typeof e.data === 'string' ? JSON.parse(e.data) : DTB.decode(new Uint8Array(e.data));
        if (handleWorldMessage(data)) return;

        if(data.type === 'init') { myId = data.id; myTeam = data.team; spectateId = null; myNameColor = data.nc; myName = data.name1}

        else if (data.type === 'achievement_unlocked') {

            unlockedAchievements.push(data.achievement);

            showAchievementPopup(data.achievement);

        }

        else if(data.type === 'pong') {

            const latency = performance.now() - data.time;

            document.getElementById('ping-display').innerText = ` ${latency.toFixed(1)} ms ${data.locationl}`;

            setTimeout(sendPing, latency*2);

        }

        else if(data.type === 'state') { 

            gameState = data; 

            if (!window.drawing) { window.drawing = true; requestAnimationFrame(draw); }

        }

        else if(data.type === 'playerStats') { myStats = data; myStats.powerups = data.powerups || myStats.powerups || {}; updateVisualFov(); updateUI(); checkUpgrades(); if(isWorldMode) updateWorldHud(); }

        else if(data.type === 'spectate_update') { spectateId = data.id; }

        

        else if(data.type === 'death') {

            myId = null;

            spectateId = data.killerId; 

            isSpectating = false;

            const spectateBar = document.getElementById('spectate-bar');

            if (spectateBar) spectateBar.style.display = 'none';

            document.getElementById('death-screen').style.display = 'flex';

            document.getElementById('ds-level').innerText = data.level + " " + data.tank;

            document.getElementById('ds-score').innerText = numberWithCommas(Math.floor(data.score));

            let m = Math.floor(data.timeAlive / 60); let s = data.timeAlive % 60;

            document.getElementById('ds-time').innerText = `${m}m ${s}s`;

            renderDeathBuild();

            

            let dCanvas = document.getElementById('ds-tank-icon');

            let dctx = dCanvas.getContext('2d');

            dctx.clearRect(0,0,100,100);

            let col = getTeamColor(myTeam);

            

            dctx.fillStyle = col; dctx.strokeStyle = darkenColor(col, 30); dctx.lineWidth = 4;

            dctx.save(); dctx.translate(50, 50); dctx.rotate(-Math.PI/4); 

            

            let specs = TANK_SPECS[data.tank] || TANK_SPECS['Basic'];

            let r = 24; 



            specs.barrels.forEach(b => {

                dctx.save(); dctx.rotate(b.angle);

                dctx.fillStyle = "#999"; dctx.strokeStyle = darkenColor("#999", 30);

                if(b.w2) {

                    dctx.beginPath(); dctx.moveTo(0, -b.w/2); dctx.lineTo(r * b.l, -b.w2/2);

                    dctx.lineTo(r * b.l, b.w2/2); dctx.lineTo(0, b.w/2); dctx.closePath();

                    dctx.fill(); dctx.stroke();

                } else {

                    dctx.fillRect(0, -b.w/2 + (b.y||0), r * b.l, b.w);

                    dctx.strokeRect(0, -b.w/2 + (b.y||0), r * b.l, b.w);

                }

                dctx.restore();

            });



            if (specs.square) {

                const squareSize = r * 0.8142;

                dctx.fillRect(-squareSize, -squareSize, squareSize * 2, squareSize * 2);

                dctx.strokeRect(-squareSize, -squareSize, squareSize * 2, squareSize * 2);

            } else {

                dctx.beginPath(); dctx.arc(0, 0, r, 0, Math.PI*2); dctx.fill(); dctx.stroke();

            }

            dctx.restore();

        }

        if (data.type === 'profile_update') {

            myProfile = data.profile;

            updateAccountUI();

        }

    };



   ws.onclose = (e) => {

    isSpectating = false;

    const spectateBarEl = document.getElementById('spectate-bar');

    if (spectateBarEl) spectateBarEl.style.display = 'none';

    if(myId) {

        document.getElementById('death-screen').style.display = 'flex';

        document.querySelector('.ds-title').innerText = "Disconnected";

        document.getElementById('ds-level').innerText = "Connection lost.";

        document.getElementById('ds-score').innerText = "--";

        document.getElementById('ds-time').innerText = "--";

    }

    

    const btn = document.getElementById('playBtn');

    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> Disconnected`;

    btn.style.background = "#f14e54"; 

    btn.style.borderBottomColor = "#c83d42"; 

    btn.disabled = false;

    btn.onclick = initConnection;



    // Build a human-readable close reason

    const CLOSE_CODES = {

        1000: "Normal closure",

        1001: "Client navigated away",

        1006: "Connection lost",

        1011: "Server error",

        1012: "Server is restarting",

        4000: "Disconnected by server"

    };

    const codeLabel = CLOSE_CODES[e.code] || "Unknown reason";

    const reasonStr = e.reason ? ` — ${e.reason}` : "";

    

    const reasonDiv = document.getElementById('disconnect-reason');

    reasonDiv.innerText = `${e.code} - ${codeLabel}${reasonStr}`;

    reasonDiv.style.display = 'flex'; 

};

}

let currentUpgradesShown = "";

let upgradesIgnored = false;



// Bring upgrades back when hovering the left-edge trigger zone

window.addEventListener('mousemove', e => {

    // Show the subtle edge glow only when there are ignored upgrades waiting

    if (upgradesIgnored && currentUpgradesShown !== "") {

        upgradeHoverZone.classList.add('active');

    } else {

        upgradeHoverZone.classList.remove('active');

    }



    if (upgradesIgnored && e.clientX < 80 && currentUpgradesShown !== "") {

        upgradesIgnored = false;

        renderUpgradePanel(currentUpgradesShown.split(",").filter(Boolean));

    }

});



function renderUpgradePanel(options) {

    const upPanel = document.getElementById('upgrades-panel');

    upPanel.innerHTML = '';



    if (options.length === 0 || upgradesIgnored) {

        upPanel.style.transform = 'translateX(-150%)';

        return;

    }



    upPanel.style.transform = 'translateX(0)';



    options.forEach(c => {

        let btn = document.createElement('div');

        btn.className = 'upgrade-btn square-upgrade';

        let iconUrl = getCachedTankIcon(c, getTeamColor(myTeam));

        btn.innerHTML = `

            <img src="${iconUrl}" style="width:55px; height:55px; margin-bottom:4px;">

            <span>${c}</span>

        `;

        // Just send the upgrade — let checkUpgrades() handle panel state via the server response

        btn.onclick = () => {

            wsSendObj(({ type: 'upgradeTank', tank: c }));

        };

        upPanel.appendChild(btn);

    });



    // Ignore button

    const ignoreBtn = document.createElement('div');

    ignoreBtn.style.cssText = `

        margin-top: 4px;

        padding: 6px 10px;

        background: rgba(80,80,80,0.75);

        border: 2px solid #444;

        border-radius: 6px;

        cursor: pointer;

        text-align: center;

        font-family: 'Ubuntu', sans-serif;

        font-size: 11px;

        font-weight: bold;

        color: #ccc;

        text-shadow: -1px -1px 0 #000, 1px 1px 0 #000;

        transition: background 0.15s;

        user-select: none;

    `;

    ignoreBtn.innerText = '✕  Ignore';

    ignoreBtn.onmouseenter = () => ignoreBtn.style.background = 'rgba(110,50,50,0.85)';

    ignoreBtn.onmouseleave = () => ignoreBtn.style.background = 'rgba(80,80,80,0.75)';

    ignoreBtn.onclick = () => {

        upgradesIgnored = true;

        upPanel.style.transform = 'translateX(-150%)';

    };

    upPanel.appendChild(ignoreBtn);

}



function checkUpgrades() {

    let options = [];



    if (myStats.level >= 15 && myStats.tankType === 'Basic') {

        options = ['Twin', 'Sniper', 'Machine Gun', 'Flank Guard'];

    } else if (myStats.level >= 30) {

        if (myStats.tankType === 'Sniper')       options = ['Overlord', 'Necromancer', 'Predator', 'Manager'];

        else if (myStats.tankType === 'Machine Gun') options = ['Destroyer', 'Sprayer', 'Railgun'];

        else if (myStats.tankType === 'Twin')    options = ['Octo Tank', 'Triplet', 'Twin Flank', 'Pentashot'];

        else if (myStats.tankType === 'Flank Guard') options = ['Tri-angle', 'Octo Tank', 'Twin Flank'];

    }



    const neededStr = options.join(",");



    // When the available set genuinely changes (e.g. Basic→Sniper unlocks tier-3),

    // clear the ignore flag so the new tier's panel shows automatically.

    if (neededStr !== currentUpgradesShown && neededStr !== "") {

        upgradesIgnored = false;

    }



    if (neededStr === currentUpgradesShown) return;

    currentUpgradesShown = neededStr;



    renderUpgradePanel(options);

}



function updateUI() {

    let scoreText = document.getElementById('score-text-overlay');

    if(scoreText) scoreText.innerText = "Score: " + numberWithCommas(Math.floor(myStats.score));

    

    let xpBar = document.getElementById('xp-bar');

    if (xpBar) {

        xpBar.style.backgroundColor = getTeamColor(myTeam);

        xpBar.style.width = myStats.level >= 30 ? "100%" : ((myStats.xp / (myStats.level * 40)) * 100 + "%");

    }

    

    let levelText = document.getElementById('level-text');

    if (levelText) {

        levelText.innerHTML = `<span style="color:${myNameColor}">${myName}</span>`;

    }

    let levelText2 = document.getElementById('level-text-overlay')

    if (levelText2){

        levelText2.innerHTML = `

            <span style="color: white; font-weight: bold; font-family: Ubuntu, sans-serif; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;">

                Lvl ${myStats.level} ${myStats.tankType}

            </span>

        `;

    }

    let panel = document.getElementById('stats-panel');

    if (panel) {

        if (myStats.statPoints > 0) {

            panel.classList.add('show-panel');

            let statPointsEl = document.getElementById('stat-points');

            if(statPointsEl) statPointsEl.innerText = myStats.statPoints;

        } else { 

            panel.classList.remove('show-panel'); 

        }

    }



    // Wrapped in safe-checks to ensure no HTML absence breaks the function

    myStats.stats.forEach((val, i) => {

        let slotContainer = document.getElementById(`slots-${i}`);

        if (slotContainer) {

            let slots = slotContainer.children;

            for(let j=0; j<7; j++) { 

                if (slots[j]) {

                    slots[j].style.background = j < val ? STAT_INFO[i].color : '#555'; 

                }

            }

        }

    });

}





function drawPoly(context, sides, r){

    context.beginPath();

    for(let i=0; i<sides; i++){

        let a = (i * Math.PI * 2 / sides);

        context.lineTo(Math.cos(a)*r*1.2, Math.sin(a)*r*1.2);

    }

    context.closePath(); context.fill(); context.stroke();

}



function drawEntityBody(context, en) {

    context.lineWidth = 4 / fov;

    const radius = scaleSize(en.radius);

    if (en.type === 'powerup') {
        drawPowerupCore(context, en);
        return;
    }



    if (['tank', 'ai'].includes(en.type)) {

        let col = getTeamColor(en.team);

        context.fillStyle = col;

        context.strokeStyle = darkenColor(col, 30);



        let specs = TANK_SPECS[en.tankType] || TANK_SPECS['Basic'];



        // Draw barrels

        specs.barrels.forEach(b => {

            context.save();



            context.rotate(en.angle + (b.angle || 0));



            const offsetScale = radius / 20;



            context.translate(

                (b.x || 0) * offsetScale,

                (b.y || 0) * offsetScale

            );



            context.fillStyle = "#999";

            context.strokeStyle = darkenColor("#999", 30);



            const width = radius * (b.w ? b.w / 20 : 0.9);

            const length = radius * (b.l || 1.8);



            if (b.w2) {

                const width2 = radius * (b.w2 / 20);



                context.beginPath();

                context.moveTo(0, -width / 2);

                context.lineTo(length, -(width2 / 2));

                context.lineTo(length, (width2 / 2));

                context.lineTo(0, width / 2);

                context.closePath();



                context.fill();

                context.stroke();

            } else {

                context.fillRect(0, -width / 2, length, width);

                context.strokeRect(0, -width / 2, length, width);

            }



            context.restore();

        });



        // Tank body

context.save();

context.rotate(en.angle);



if (specs.square) {

    // Make square visually equal to circle size

    const squareSize = radius * 0.8142;



    context.fillRect(

        -squareSize,

        -squareSize,

        squareSize * 2,

        squareSize * 2

    );



    context.strokeRect(

        -squareSize,

        -squareSize,

        squareSize * 2,

        squareSize * 2

    );

} else {

    // Circle body

    context.beginPath();

    context.arc(0, 0, radius, 0, Math.PI * 2);

    context.fill();

    context.stroke();

}



context.restore();



    } else {



        if (en.type === 'square') {

            context.fillStyle = COLORS.square;

            context.strokeStyle = darkenColor(COLORS.square, 30);



            let s = scaleSize(12);



            context.fillRect(-s, -s, s * 2, s * 2);

            context.strokeRect(-s, -s, s * 2, s * 2);

        }



        if (en.type === 'triangle') {

            context.fillStyle = COLORS.triangle;

            context.strokeStyle = darkenColor(COLORS.triangle, 30);



            context.rotate(en.angle);

            drawPoly(context, 3, radius);

        }



        if (en.type === 'pentagon') {

            context.fillStyle = COLORS.pentagon;

            context.strokeStyle = darkenColor(COLORS.pentagon, 30);



            context.rotate(en.angle);

            drawPoly(context, 5, radius);

        }



        if (en.type === 'hexagon') {

            context.fillStyle = COLORS.hexagon;

            context.strokeStyle = darkenColor(COLORS.hexagon, 30);



            context.rotate(en.angle);

            drawPoly(context, 6, radius);

        }

    }

}

let lastFpsTime = 0;

let frames = 0;

let currentFps = 0;

const gridCanvas = document.createElement('canvas');

gridCanvas.width = 50; 

gridCanvas.height = 50;

const gCtx = gridCanvas.getContext('2d');

gCtx.strokeStyle = "rgba(0,0,0,0.06)";

gCtx.lineWidth = 1;

gCtx.beginPath();

gCtx.moveTo(0, 0); gCtx.lineTo(0, 50); 

gCtx.moveTo(0, 0); gCtx.lineTo(50, 0);

gCtx.stroke();

let gridPattern = null;

const escapeHTML = (str) => {

        const p = document.createElement('p'); p.textContent = str; return p.innerHTML;

    };

    

    const updateLeaderboard = () => {

        const entries = gameState.entities

            .filter(e => ['tank', 'ai'].includes(e.type))

            .sort((a, b) => b.score - a.score)

            .slice(0, 10);



        const leaderScore = entries.length > 0 ? Math.max(entries[0].score, 1) : 1;

        document.getElementById('score-list').innerHTML = entries.map(s => {

            let fillPct = Math.max(2, Math.min(100, (s.score / leaderScore) * 100));

            let barColor = gameMode === "FFA" ? "#f0a824" : getTeamColor(s.team); 

            let displayScore = formatScore(Math.floor(s.score));

            let tankColor = getTeamColor(s.team); 

            let iconUrl = getCachedTankIcon(s.tankType || 'Basic', tankColor);



            return `

                <div class="sb-entry" style="position: relative; height: 30px; margin-bottom: 2px;">

                    <div class="sb-fill" style="width: ${fillPct}%; background-color: ${barColor}; height: 100%; position: absolute; opacity: 0.8;"></div>

                    <div class="sb-text" style="position: relative; display: flex; align-items: center; padding: 0 6px; height: 100%; font-family: sans-serif; white-space: nowrap;">

                        <img src="${iconUrl}" style="width: 25px; height: 25px; margin-right: 8px; flex-shrink: 0;">

                        <span style="color: ${s.nameColor || '#fff'}; overflow: hidden; text-overflow: ellipsis; font-weight: bold;">

                            ${escapeHTML(s.name)}

                        </span>

                        <span style="color: white; font-weight: bold;"> - ${displayScore}</span>

                    </div>

                </div>

            `;

        }).join('');

    };

let drawCounter = 0;

function draw() {
    drawCounter++;

    let now = performance.now();

    frames++;

    if (now - lastFpsTime >= 1000) {

        currentFps = frames;

        frames = 0;

        lastFpsTime = now;

        let fpsEl = document.getElementById('fps-display');

        if (fpsEl) fpsEl.innerText = `FPS: ${currentFps}`;

    }



    // 2. Draw Solid Background

    ctx.fillStyle = COLORS.bg; 

    ctx.fillRect(0,0,canvas.width,canvas.height);



    // Camera targeting logic stays exactly the same...

    if (isWorldMode) { updateVisualFov(); fov += (fovTarget - fov) * 0.08; }
    const activeWorldExtent = isWorldMode ? wcExtent() : WORLD_SIZE;
    let targetCamX = activeWorldExtent/2 - (canvas.width * fov) / 2;

    let targetCamY = activeWorldExtent/2 - (canvas.height * fov) / 2;



    if (myId) {

        let me = gameState.entities.find(e => e.id === myId);

        if(me) {

            if (!renderEntities.has(me.id)) renderEntities.set(me.id, { ...me, renderX: me.x, renderY: me.y });

            let rMe = renderEntities.get(me.id);
            wcWrapFix(rMe, me);

            targetCamX = rMe.renderX - (canvas.width * fov) / 2;

            targetCamY = rMe.renderY - (canvas.height * fov) / 2;
            if (isWorldMode && me.veh) { targetCamX += Math.cos(me.veh.a) * me.veh.v * 22; targetCamY += Math.sin(me.veh.a) * me.veh.v * 22; }   // look ahead while driving
            if (isWorldMode && me.fl) { targetCamX += Math.cos(me.fl.a) * me.fl.v * 6; targetCamY += Math.sin(me.fl.a) * me.fl.v * 6; }



            if (myStats.tankType === 'Sniper' && (mouse.rightDown || keys.shift)) {

                let mouseAngle = Math.atan2(mouse.ry - rMe.renderY, mouse.rx - rMe.renderX);

                targetCamX += Math.cos(mouseAngle) * (450 * fov);

                targetCamY += Math.sin(mouseAngle) * (450 * fov);

            }

        } else if (isWorldMode) {
            const wx=WC.pos.x,wy=WC.pos.y;
            targetCamX=wx-(canvas.width*fov)/2;targetCamY=wy-(canvas.height*fov)/2;
        }

    } else if (isWorldMode) {
        const wx=WC.pos.x,wy=WC.pos.y;
        targetCamX=wx-(canvas.width*fov)/2;targetCamY=wy-(canvas.height*fov)/2;

    } else if (spectateId) {

        let spec = gameState.entities.find(e => e.id === spectateId);

        if(spec) {

            if (!renderEntities.has(spec.id)) renderEntities.set(spec.id, { ...spec, renderX: spec.x, renderY: spec.y });

            let rSpec = renderEntities.get(spec.id);

            targetCamX = rSpec.renderX - (canvas.width * fov) / 2;

            targetCamY = rSpec.renderY - (canvas.height * fov) / 2;

        }

    }



    const meFl = isWorldMode && myId != null && gameState.entities.find(e => e.id === myId)?.fl;
    const cameraEase = isWorldMode ? (meFl ? 0.45 : 0.22) : 0.1;
    camera.x += (targetCamX - camera.x) * cameraEase;

    camera.y += (targetCamY - camera.y) * cameraEase;



    mouse.rx = screenToWorldX(mouse.x);

    mouse.ry = screenToWorldY(mouse.y);

    if (!gridPattern) gridPattern = ctx.createPattern(gridCanvas, 'repeat');

    ctx.save();

    ctx.fillStyle = gridPattern;let scaledGridSize = 50 / fov; 

ctx.translate(-((camera.x / fov) % scaledGridSize), -((camera.y / fov) % scaledGridSize));



    ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);

    ctx.restore();

    // World geometry is only a backdrop layer. Arena entities and combat
    // continue through the exact same shared renderer below.
    if (isWorldMode) drawWorldEnvironment();

    // --- TDM BASE DRAWING ---

    if(gameMode === "2TDM") {

        // Left Base (Team 1 - Blue)

        ctx.fillStyle = COLORS.team1 + "26"; // Added 15% opacity (hex 26)

        ctx.fillRect(

            worldToScreenX(0),

            worldToScreenY(0),

            scaleSize(400),

            scaleSize(WORLD_SIZE)

        );

        // Right Base (Team 2 - Red)

        ctx.fillStyle = COLORS.team2 + "26";

        ctx.fillRect(

            worldToScreenX(WORLD_SIZE - 400),

            worldToScreenY(0),

            scaleSize(400),

            scaleSize(WORLD_SIZE)

        );

    } else if (gameMode === "4TDM") {

        let bs = scaleSize(BASE_SIZE);

        // TL (Team 1 - Blue)

        ctx.fillStyle = COLORS.team1 + "26"; 

        ctx.fillRect(worldToScreenX(0), worldToScreenY(0), bs, bs);

        

        // TR (Team 3 - Purple)

        ctx.fillStyle = (COLORS.team3 || "#be7ff5") + "26"; 

        ctx.fillRect(worldToScreenX(WORLD_SIZE-BASE_SIZE), worldToScreenY(0), bs, bs);

        

        // BL (Team 4 - Green)

        ctx.fillStyle = (COLORS.team4 || "#00e16e") + "26"; 

        ctx.fillRect(worldToScreenX(0), worldToScreenY(WORLD_SIZE-BASE_SIZE), bs, bs);

        

        // BR (Team 2 - Red)

        ctx.fillStyle = COLORS.team2 + "26"; 

        ctx.fillRect(worldToScreenX(WORLD_SIZE-BASE_SIZE), worldToScreenY(WORLD_SIZE-BASE_SIZE), bs, bs);

    }



    if (!isWorldMode) {
    ctx.fillStyle = "rgba(0,0,0,0.02)"; 

    ctx.fillRect(

    worldToScreenX(1700),

    worldToScreenY(1700),

    scaleSize(600),

    scaleSize(600)

);

    }


    // --- ENTITY (tank/ai/shape) DEATH DETECTION ---

    // renderEntities previously only ever grew: entries were added but never

    // removed once an entity died or permanently left the world, which leaked

    // memory over long sessions. This mirrors the bullet/drone diffing below -

    // anything we were tracking that's no longer in the latest state gets a

    // shrink/fade death animation (if it was on screen) and is dropped.

    const activeEntityIds = new Set(gameState.entities.map(en => en.id));

    for (let [id, rEn] of renderEntities.entries()) {

        if (!activeEntityIds.has(id)) {

            const sx = worldToScreenX(rEn.renderX);

            const sy = worldToScreenY(rEn.renderY);

            if (

                sx > -scaleSize(150) &&

                sx < canvas.width + scaleSize(150) &&

                sy > -scaleSize(150) &&

                sy < canvas.height + scaleSize(150)

            ) {

                dyingEntities.push({

                    ...rEn,

                    renderX: rEn.renderX,

                    renderY: rEn.renderY,

                    deathTime: Date.now()

                });

            }

            renderEntities.delete(id);

        }

    }



    // --- POWERUP / TANK PARTICLE FX ---
    powerupParticleClock++;
    if (powerupParticleClock % 3 === 0) {
        gameState.entities.forEach(en => {
            if (!['tank', 'ai'].includes(en.type) || !en.inView) return;
            const active = activePowerupTypes(en);
            if (!active.length) return;
            const count = Math.min(2, active.length);
            for (let i = 0; i < count; i++) {
                const type = active[(powerupParticleClock + i) % active.length];
                spawnPowerupParticle(en.x, en.y, type, Math.max(0.7, en.radius / 20));
            }
        });
    }
    updateAndDrawPowerupParticles();

    // --- BULLET LERPING ---

    const activeBulletIds = new Set(gameState.bullets.map(b => b.id));

    for (let [id, b] of lastBullets.entries()) {

        if (!activeBulletIds.has(id)) {

            const sx = worldToScreenX(b.renderX);

            const sy = worldToScreenY(b.renderY);

            if (

                sx > -scaleSize(50) &&

                sx < canvas.width + scaleSize(50) &&

                sy > -scaleSize(50) &&

                sy < canvas.height + scaleSize(50)

              ){

                dyingEntities.push({

                    ...b,

                    renderX: b.renderX,

                    renderY: b.renderY,

                    deathType: 'bullet',

                    deathTime: Date.now()

                });

            }

            lastBullets.delete(id);

        }

    }

    // Update targets

    gameState.bullets.forEach(b => {

        if (!lastBullets.has(b.id)) {

            lastBullets.set(b.id, { ...b, renderX: b.x, renderY: b.y });

        } else {

            let existing = lastBullets.get(b.id);

            existing.x = b.x; existing.y = b.y; existing.r = b.r; existing.powerupEffects = b.powerupEffects || [];

        }

    });



    // Draw & Lerp Bullets

    lastBullets.forEach(b => {

        b.renderX = lerp(b.renderX, b.x, 0.2);

        b.renderY = lerp(b.renderY, b.y, 0.2);

        const bulletX = worldToScreenX(b.renderX);
        const bulletY = worldToScreenY(b.renderY);
        const bulletR = scaleSize(b.r);
        const effects = b.powerupEffects || [];

        if (effects.length) {
            effects.forEach((type, idx) => {
                ctx.save();
                ctx.globalAlpha = 0.25;
                ctx.fillStyle = powerupColor(type);
                ctx.shadowColor = ctx.fillStyle;
                ctx.shadowBlur = scaleSize(8);
                ctx.beginPath();
                ctx.arc(bulletX, bulletY, bulletR * (1.45 + idx * 0.18), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                if (Math.random() < 0.45) {
                    spawnBulletParticle(b.renderX, b.renderY, type, Math.max(0.6, b.r / 8));
                }
            });
        }

        ctx.fillStyle = getTeamColor(b.team);
        ctx.strokeStyle = darkenColor(ctx.fillStyle, 30);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bulletX, bulletY, bulletR, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();

        if (effects.length) {
            ctx.save();
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = powerupColor(effects[0]);
            ctx.beginPath();
            ctx.arc(bulletX, bulletY, Math.max(1, bulletR * 0.32), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

    });



    // --- DRONE LERPING ---

    const activeDroneIds = new Set(gameState.drones.map(d => d.id));

    for (let [id, d] of lastDrones.entries()) {

        if (!activeDroneIds.has(id)) {

            const sx = worldToScreenX(d.renderX);

const sy = worldToScreenY(d.renderY);

            if (

    sx > -scaleSize(100) &&

    sx < canvas.width + scaleSize(100) &&

    sy > -scaleSize(100) &&

    sy < canvas.height + scaleSize(100)

) {

    dyingEntities.push({

        ...d,

        renderX: d.renderX,

        renderY: d.renderY,

        deathType: 'drone',

        deathTime: Date.now()

    });

}

            lastDrones.delete(id);

        }

    }

    // Update targets

    gameState.drones.forEach(d => {

        if (!lastDrones.has(d.id)) {

            lastDrones.set(d.id, { ...d, renderX: d.x, renderY: d.y, renderAngle: d.angle });

        } else {

            let existing = lastDrones.get(d.id);

            existing.x = d.x; existing.y = d.y; existing.angle = d.angle;

        }

    });



    // Draw & Lerp Drones

    lastDrones.forEach(d => {

        d.renderX = lerp(d.renderX, d.x, 0.2);

        d.renderY = lerp(d.renderY, d.y, 0.2);

        d.renderAngle = lerpAngle(d.renderAngle !== undefined ? d.renderAngle : d.angle, d.angle, 0.2);



        const sx = worldToScreenX(d.renderX);

        const sy = worldToScreenY(d.renderY);

        if (

    sx < -scaleSize(50) ||

    sx > canvas.width + scaleSize(50) ||

    sy < -scaleSize(50) ||

    sy > canvas.height + scaleSize(50)

) return;

        ctx.save(); ctx.translate(sx, sy); ctx.rotate(d.renderAngle);

        ctx.lineWidth = 3; ctx.fillStyle = getTeamColor(d.team); ctx.strokeStyle = darkenColor(ctx.fillStyle, 30);

        if (d.square) {

    // Square drone

    const size = scaleSize(d.radius * 1.6);



    ctx.beginPath();

    ctx.rect(

        -size / 2,

        -size / 2,

        size,

        size

    );

    ctx.fill();

    ctx.stroke();

} else {

    // Triangle drone

    ctx.beginPath();

    ctx.lineTo(scaleSize(d.radius), 0);

    ctx.lineTo(scaleSize(-d.radius) * 0.8, scaleSize(d.radius) * 0.8);

    ctx.lineTo(scaleSize(-d.radius) * 0.8, scaleSize(-d.radius) * 0.8);

    ctx.closePath();

    ctx.fill();

    ctx.stroke();}

    ctx.restore();

});

    

    dyingEntities = dyingEntities.filter(e => Date.now() - e.deathTime < 190);

    dyingEntities.forEach(e => {

        let progress = (Date.now() - e.deathTime) / 190;

        let scale = 1 + (progress * 0.45); 

        let alpha = 1 - progress;



        const sx = worldToScreenX(e.renderX);

        const sy = worldToScreenY(e.renderY);

        if (

    sx < -scaleSize(150) ||

    sx > canvas.width + scaleSize(150) ||

    sy < -scaleSize(150) ||

    sy > canvas.height + scaleSize(150)

) return;



        deathCtx.clearRect(0, 0, 300, 300);

        deathCtx.save();

        deathCtx.translate(150, 150);

        deathCtx.scale(scale, scale);

        

        if (e.deathType === 'bullet') {

            deathCtx.fillStyle = getTeamColor(e.team); 

            deathCtx.strokeStyle = darkenColor(deathCtx.fillStyle, 30); 

            deathCtx.lineWidth = 2;

            deathCtx.beginPath(); 

            deathCtx.arc(0, 0, scaleSize(e.r), 0, Math.PI*2); 

            deathCtx.fill(); 

            deathCtx.stroke();

        } else if (e.deathType === 'drone') {deathCtx.rotate(e.angle);

deathCtx.lineWidth = 3;

deathCtx.fillStyle = getTeamColor(e.team);

deathCtx.strokeStyle = darkenColor(deathCtx.fillStyle, 30);



if (e.square) {

    const size = e.radius * 1.6;



    deathCtx.beginPath();

    deathCtx.rect(

        -size / 2,

        -size / 2,

        size,

        size

    );

    deathCtx.fill();

    deathCtx.stroke();

} else {

    deathCtx.beginPath();

    deathCtx.lineTo(e.radius, 0);

    deathCtx.lineTo(-e.radius * 0.8, e.radius * 0.8);

    deathCtx.lineTo(-e.radius * 0.8, -e.radius * 0.8);

    deathCtx.closePath();



    deathCtx.fill();

    deathCtx.stroke();

}

        } else {

            drawEntityBody(deathCtx, e);

            

            if (['tank', 'ai'].includes(e.type)) {

    const isWhite = !e.nameColor || ["white", "#fff", "#ffffff"].includes(e.nameColor);

    

    // 1. Calculate scaled values once for this entity

    const sRadius = scaleSize(e.radius);

    const nameOffset = scaleSize(25);  // Scaled gap for name

    const scoreOffset = scaleSize(12); // Scaled gap for score

    

    // 2. Set Font Size (Already correctly scaled in your code)

    let fontSize = Math.max(7, 14 / fov); 

    ctx.font = `bold ${fontSize}px Ubuntu`;

    ctx.textAlign = "center";

    

    // 3. Render Name

    ctx.fillStyle = e.nameColor || "white";

    ctx.strokeStyle = isWhite ? "black" : (darkenColor(e.nameColor, 50) || "black");

    ctx.lineWidth = 3;

    // Use sx, sy (which are worldToScreen results) and subtract scaled offsets

    ctx.strokeText(e.name, sx, sy - sRadius - nameOffset);

    ctx.fillText(e.name, sx, sy - sRadius - nameOffset);

    

    // 4. Render Score

    fontSize = Math.max(5.5, 11 / fov); 

    ctx.font = `bold ${fontSize}px Ubuntu`;

    ctx.fillStyle = "white";

    ctx.strokeStyle = "black";

    const displayScore = formatScore(Math.floor(e.score));

    ctx.strokeText(displayScore, sx, sy - sRadius - scoreOffset);

    ctx.fillText(displayScore, sx, sy - sRadius - scoreOffset);

}

        }

        

        deathCtx.restore();



        ctx.save();

        ctx.globalAlpha = alpha;

        ctx.drawImage(deathCanvas, sx - 150, sy - 150);

        ctx.restore();

    });



    // --- ENTITY LERPING ---

    // Draw shapes first, tanks/ai on top. Previously this re-allocated and

    // fully re-sorted the entire entity array every single frame just to

    // separate two draw-order buckets - an O(n log n) comparator sort with a

    // constant return value. A single O(n) partition does the same job cheaper.

    const shapeEntities = [];

    const tankEntities = [];

    gameState.entities.forEach(en => {

        (en.type === 'tank' || en.type === 'ai' ? tankEntities : shapeEntities).push(en);

    });

    shapeEntities.concat(tankEntities).forEach(en => {

        if(!en.inView){ return; }

        

        // Initialize render positions if new

        if (!renderEntities.has(en.id)) {

            renderEntities.set(en.id, { ...en, renderX: en.x, renderY: en.y, renderAngle: en.angle });

        }

        

        let rPos = renderEntities.get(en.id);
        wcWrapFix(rPos, en);

        let rx = rPos.renderX; 

        let ry = rPos.renderY; 

        let ra = rPos.renderAngle !== undefined ? rPos.renderAngle : en.angle;

        

        Object.assign(rPos, en); if (!en.veh) rPos.veh = undefined;

        

        // Apply Lerping (adjusted to 0.2 to compensate for the slower server tick)

        const lk = en.fl ? 0.5 : 0.2;                // planes move fast: follow the server more tightly
        rPos.renderX = lerp(rx, en.x, lk);

        rPos.renderY = lerp(ry, en.y, lk);



        if (en.id === myId && (en.type === 'tank' || en.type === 'ai')) {

            // Own tank: point the barrel straight at the cursor every frame

            // instead of lerping toward whatever angle the last server state

            // said. The server angle already arrives a tick or two late and

            // then gets smoothed on top of that, so our own aim always felt

            // laggy even though nothing else about it needs server round-trip.

            // Everyone else's tank still uses the smoothed server angle below -

            // this only changes what we draw for ourselves, not what's sent

            // to (or authoritative on) the server.

            rPos.renderAngle = getAimAngle(rPos.renderX, rPos.renderY);

        } else {

            rPos.renderAngle = lerpAngle(ra, en.angle, 0.2);

        }

        

        // Feed the smoothed angle back into rPos so the draw function uses it

        rPos.angle = rPos.renderAngle; 



        const sx = worldToScreenX(rPos.renderX);

        const sy = worldToScreenY(rPos.renderY);

        

        if (

    sx < -scaleSize(100) ||

    sx > canvas.width + scaleSize(100) ||

    sy < -scaleSize(100) ||

    sy > canvas.height + scaleSize(100)

) return;



        if (['tank', 'ai'].includes(en.type)) {

            const isWhite = !en.nameColor || en.nameColor === "white" || en.nameColor === "#fff" || en.nameColor === "#ffffff";



            // Manager invisibility: fade name/score along with the body

            const drawOpacity = (en.tankType === 'Manager') ? (en.opacity ?? 1) : 1;

            // Always render yourself at full opacity so you can see your own position

            const isSelf = (en.id === myId);

            const effectiveOpacity = isSelf ? 1 : drawOpacity;

            ctx.globalAlpha = effectiveOpacity;



            ctx.fillStyle = en.nameColor || "white";

            ctx.lineJoin = "round"; 

            ctx.strokeStyle = isWhite ? "black" : (darkenColor(en.nameColor, 50) || "black");

            ctx.lineWidth = 3;

            // Instead of 14px constant:

            let fontSize = Math.max(7, 14 / fov); 

            ctx.font = `bold ${fontSize}px Ubuntu`;

            ctx.textAlign = "center";

            

            ctx.strokeText(en.name, sx, sy - scaleSize(en.fl ? 115 * (1 + 0.8 * en.fl.alt) : en.veh ? Math.max(en.radius, 30) : en.radius) - 25);

            ctx.fillText(en.name, sx, sy - scaleSize(en.fl ? 115 * (1 + 0.8 * en.fl.alt) : en.veh ? Math.max(en.radius, 30) : en.radius) - 25);

            

            fontSize = Math.max(5.5, 11 / fov); 

            ctx.font = `bold ${fontSize}px Ubuntu`;

            ctx.fillStyle = "white";

            ctx.strokeStyle = "black";

            const displayScore = formatScore(Math.floor(en.score));

            ctx.strokeText(displayScore, sx, sy - scaleSize(en.fl ? 115 * (1 + 0.8 * en.fl.alt) : en.veh ? Math.max(en.radius, 30) : en.radius) - 12);

            ctx.fillText(displayScore, sx, sy - scaleSize(en.fl ? 115 * (1 + 0.8 * en.fl.alt) : en.veh ? Math.max(en.radius, 30) : en.radius) - 12);



            ctx.globalAlpha = 1;

        }

        

       if(en.hp < en.maxHp) {

    const hpOpacity = (en.tankType === 'Manager' && en.id !== myId) ? (en.opacity ?? 1) : 1;

    ctx.globalAlpha = hpOpacity;

    let barWidth = scaleSize(40);

    let barHeight = scaleSize(6);

    // Use scaleSize for the gap between the tank and the bar (10)

    let barOffset = scaleSize(en.radius) + scaleSize(10); 

    

    ctx.fillStyle = '#555'; 

    ctx.fillRect(sx - barWidth / 2, sy + barOffset, barWidth, barHeight);

    

    ctx.fillStyle = '#85e37d'; 

    ctx.fillRect(sx - barWidth / 2, sy + barOffset, barWidth * (en.hp / en.maxHp), barHeight);

    ctx.globalAlpha = 1;

}

        

        ctx.save();

        ctx.translate(sx, sy);

        // Powerup effects sit behind the tank body.
        drawTankPowerupEffects(ctx, rPos);

        // Manager invisibility: body fades with the same opacity as name/score

        if (en.tankType === 'Manager' && en.id !== myId) {

            ctx.globalAlpha = en.opacity ?? 1;

        }

        if (en.fl) wcDrawFlightEntity(ctx, rPos, en); else if (en.veh) wcDrawVehicleEntity(ctx, rPos, en); else drawEntityBody(ctx, rPos);

        ctx.globalAlpha = 1;

        ctx.restore();

    });

    if (drawCounter % 10 === 0) {

        updateLeaderboard();

        if (isSpectating) updateSpectateLabel();

    }

    mCtx.clearRect(0,0,150,150);
    if (isWorldMode) { drawWorldMinimap(); } else {
        if(gameMode === "2TDM") {
            mCtx.fillStyle = "rgba(0, 178, 225, 0.3)"; mCtx.fillRect(0, 0, (400/WORLD_SIZE)*150, 150);
            mCtx.fillStyle = "rgba(241, 78, 84, 0.3)"; mCtx.fillRect(150-(400/WORLD_SIZE)*150, 0, (400/WORLD_SIZE)*150, 150);
        } else if(gameMode === "4TDM") {
            let bs = (BASE_SIZE/WORLD_SIZE)*150;
            mCtx.fillStyle = "rgba(0, 178, 225, 0.3)"; mCtx.fillRect(0, 0, bs, bs);
            mCtx.fillStyle = "rgba(190, 127, 245, 0.3)"; mCtx.fillRect(150-bs, 0, bs, bs);
            mCtx.fillStyle = "rgba(0, 225, 110, 0.3)"; mCtx.fillRect(0, 150-bs, bs, bs);
            mCtx.fillStyle = "rgba(241, 78, 84, 0.3)"; mCtx.fillRect(150-bs, 150-bs, bs, bs);
        }
        gameState.entities.forEach(en => {
            if(!['tank','ai'].includes(en.type)) return;
            mCtx.fillStyle = en.id === myId ? '#fff' : getTeamColor(en.team);
            let z = en.id === myId ? 4 : 2;
            mCtx.fillRect((en.x/WORLD_SIZE)*150-z/2,(en.y/WORLD_SIZE)*150-z/2,z,z);
        });
    }


    requestAnimationFrame(draw);

}



// Variables and State

let holdingM = false;



// Skip game hotkey handling while the user is focused on a text field (e.g.

// the name input) - otherwise typing "e"/"c"/a digit toggles autofire/autospin

// or fires off a stat-upgrade request instead of typing a name.

function isTypingInField(e) {

    const t = e.target;

    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

}



window.onkeydown = e => { 

    if (isTypingInField(e)) return;

    let key = e.key.toLowerCase();

    keys[key] = true; 



    // Shift Logic

    if (key === 'shift') { 

        mouse.repel = true; 

        keys.shift = true; 

    } 



    // Menu Logic (M key)

    if (key === 'm') { 

        holdingM = true; 

        const panel = document.getElementById('upgrades-panel');

        if (panel) panel.style.transform = 'translateX(0)'; 

    }



    // Toggles

    if (key === 'f' && isWorldMode) { worldInteractPrimary(); return; }
    if (key === 'j' && isWorldMode) { wcGigKey(); return; }
    if (key === 'n' && isWorldMode && WC.scene === 'ext') {
        const modes = ['off', 'work', 'home', 'car'], m = modes[(modes.indexOf(WC.navMode || 'off') + 1) % modes.length];
        WC.navMode = m; WC.nav = null; WC.navPin = null;
        if (m === 'off') wcToast('Satnav off'); else { wcToast('Satnav: ' + { work: 'nearest workplace', home: 'home', car: 'your car' }[m]); worldSend('world_nav', { t: m }); }
        return;
    }
    if (key === 'e') autoFire = !autoFire;

    if (key === 'c') autoSpin = !autoSpin;



    // Stat Upgrades (1-8)

    if (key >= '1' && key <= '8') {

        if (ws && ws.readyState === 1) { 

            wsSendObj(({ 

                type: 'upgradeStat', 

                statIndex: parseInt(key) - 1 

            })); 

        }

    }

};



window.onkeyup = e => { 

    if (isTypingInField(e)) return;

    let key = e.key.toLowerCase();

    keys[key] = false; 



    // Reset Shift

    if (key === 'shift') { 

        mouse.repel = false; 

        keys.shift = false; 

    } 



    // Reset M

    if (key === 'm') { 

        holdingM = false; 

    }

};



window.onmousemove = e => { 

    mouse.x = e.clientX; 

    mouse.y = e.clientY;



    mouse.rx = screenToWorldX(mouse.x);

    mouse.ry = screenToWorldY(mouse.y);

};



window.onmousedown = (e) => {

    if (e.button === 0) mouse.pressed = true;

    if (e.button === 2) mouse.rightDown = true;

};



window.onmouseup = (e) => {

    if (e.button === 0) mouse.pressed = false;

    if (e.button === 2) mouse.rightDown = false;

};



window.oncontextmenu = e => e.preventDefault(); function resizeGame() {

    // Set the actual internal resolution

    canvas.width = window.innerWidth;

    canvas.height = window.innerHeight;

    

    // Force the CSS layout to match the window exactly

    canvas.style.width = `${window.innerWidth}px`;

    canvas.style.height = `${window.innerHeight}px`;

    

    // Scale fov so every screen sees the same world coverage as 1536px wide at BASE_FOV

    baseFov = (REF_WIDTH * BASE_FOV) / canvas.width;
    worldOnResize();
    updateVisualFov();



    // Center the camera immediately to prevent visual stutter on resize

    // (must scale by fov too, or this only centers correctly at exactly

    // the 1536px reference width - see worldToScreenX/Y)

    if (!myId && camera) {

        camera.x = WORLD_SIZE/2 - (canvas.width * fov) / 2;

        camera.y = WORLD_SIZE/2 - (canvas.height * fov) / 2;

    }

}

window.addEventListener('resize', resizeGame);

resizeGame();



// ===================== MOBILE TOUCH CONTROLS =====================

// Only ever shown on touch-capable devices (see .touch-device #mobile-controls

// in the stylesheet) and only while in a match, since #mobile-controls lives

// inside #game-ui and inherits its display:none/block toggling for free.

const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

if (isTouchDevice) document.documentElement.classList.add('touch-device');



// Wires a circular joystick element up to Pointer Events (works for touch

// and, incidentally, mouse too - handy for testing on desktop). Uses pointer

// capture so a fast drag that leaves the small base element is still

// tracked, and tracks its own pointerId so the left/right sticks and the

// ability button never steal each other's touches.

function setupJoystick(baseId, { deadzone = 16, onStart, onMove, onEnd }) {

    const base = document.getElementById(baseId);

    if (!base) return;

    const knob = base.querySelector('.joystick-knob');

    let activePointerId = null;

    let centerX = 0, centerY = 0;



    function updateKnob(dx, dy) {

        const maxRadius = base.clientWidth / 2;

        const dist = Math.min(Math.hypot(dx, dy), maxRadius);

        const angle = Math.atan2(dy, dx);

        knob.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;

    }



    function handleMove(e) {

        const dx = e.clientX - centerX;

        const dy = e.clientY - centerY;

        updateKnob(dx, dy);

        onMove(dx, dy, Math.hypot(dx, dy));

    }



    base.addEventListener('pointerdown', e => {

        if (activePointerId !== null) return; // already tracking a touch

        activePointerId = e.pointerId;

        base.setPointerCapture(e.pointerId);

        const rect = base.getBoundingClientRect();

        centerX = rect.left + rect.width / 2;

        centerY = rect.top + rect.height / 2;

        if (onStart) onStart();

        handleMove(e);

        e.preventDefault();

    });



    base.addEventListener('pointermove', e => {

        if (e.pointerId !== activePointerId) return;

        handleMove(e);

        e.preventDefault();

    });



    function release(e) {

        if (e.pointerId !== activePointerId) return;

        activePointerId = null;

        knob.style.transform = 'translate(0px, 0px)';

        if (onEnd) onEnd();

    }

    base.addEventListener('pointerup', release);

    base.addEventListener('pointercancel', release);



    // Deadzone is exposed via closure so callers don't need to re-check it.

    return { deadzone };

}



// Left stick: discrete 8-direction movement (top = W, top-left = W+A, etc.)

// mirrors keys.w/a/s/d directly, so it plugs into the exact same input path

// the keyboard uses - no separate movement code needed.

setupJoystick('joy-left', {

    onMove: (dx, dy, dist) => {

        if (dist < 16) { keys.w = keys.a = keys.s = keys.d = false; return; }

        // Flip dy so "up" (screen-negative-y) maps to angle +90°, matching

        // the natural compass layout (top = 90°, right = 0°, going CCW).

        let angle = Math.atan2(-dy, dx);

        if (angle < 0) angle += Math.PI * 2;

        const octant = Math.round(angle / (Math.PI / 4)) % 8;

        const dirs = [

            { d: true },                // 0°:   right      -> D

            { w: true, d: true },       // 45°:  top-right  -> W+D

            { w: true },                // 90°:  top        -> W

            { w: true, a: true },       // 135°: top-left   -> W+A

            { a: true },                // 180°: left       -> A

            { a: true, s: true },       // 225°: bottom-left-> A+S

            { s: true },                // 270°: bottom     -> S

            { s: true, d: true },       // 315°: bottom-right->S+D

        ][octant];

        keys.w = !!dirs.w; keys.a = !!dirs.a; keys.s = !!dirs.s; keys.d = !!dirs.d;

    },

    onEnd: () => { keys.w = keys.a = keys.s = keys.d = false; }

});



// Right stick: continuous aim direction + fire-while-held, feeding mobileAim

// which getAimAngle() (see above) already prioritizes over the mouse.

setupJoystick('joy-right', {

    onStart: () => { mobileAim.active = true; mobileAim.firing = true; },

    onMove: (dx, dy, dist) => {

        // Ignore tiny movement right at the center so the aim angle doesn't

        // jitter/snap when the stick is barely nudged.

        if (dist < 10) return;

        mobileAim.angle = Math.atan2(dy, dx);

    },

    onEnd: () => { mobileAim.active = false; mobileAim.firing = false; }

});



// Ability button: mirrors holding Shift / right-click (repel + the Sniper

// zoom-out camera pull, which also keys off mouse.rightDown).

(function setupAbilityButton() {

    const btn = document.getElementById('ability-btn');

    if (!btn) return;

    const press = e => {

        mouse.repel = true;

        mouse.rightDown = true;

        btn.classList.add('pressed');

        e.preventDefault();

    };

    const release = () => {

        mouse.repel = false;

        mouse.rightDown = false;

        btn.classList.remove('pressed');

    };

    btn.addEventListener('pointerdown', press);

    btn.addEventListener('pointerup', release);

    btn.addEventListener('pointercancel', release);

    btn.addEventListener('pointerleave', release);

})();
