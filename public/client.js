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

            btnHtml = `<button class="shop-btn btn-equip" onclick="ws.send(JSON.stringify({type:'equip_item', category:'${category}', itemId:'${item.id}'}))">Equip</button>`;

        } else {

            let canAfford = myProfile.coins >= item.cost;

            btnHtml = `<button class="shop-btn btn-buy" ${!canAfford ? 'disabled' : ''} onclick="ws.send(JSON.stringify({type:'buy_item', category:'${category}', itemId:'${item.id}'}))">Buy (🪙 ${item.cost})</button>`;

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
    fov = baseFov * (isWorldMode ? 0.74 : 1) * (powerupActive(myStats, "fov") ? 1.3 : 1);
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



ws.send(JSON.stringify({

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
        isWorldMode=false; worldState=null; worldView=null;
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

        d.onclick = () => { if(ws) ws.send(JSON.stringify({ type: 'upgradeStat', statIndex: i })); };

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
let isWorldMode=false, pendingWorldJoin=false, worldState=null, worldView=null, worldLastView=0;
function worldSend(type,extra={}){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type,...extra}));}
function enterWorldMode(){
 if(!sessionToken){alert('World Mode requires a logged-in Google or Discord account.');return;}
 if(!ws||ws.readyState!==1){const region=document.getElementById('regionInput').value;const mode=document.getElementById('gameModeInput').value;pendingWorldJoin=true;connectWS(region,mode);return;}
 pendingWorldJoin=true;worldSend('world_join');
}
function beginWorldMode(data){
 isWorldMode=true;worldState=data.world;worldView=data.view;gameMode='WORLD';
 // World is an ordinary FFA Room. Keep the real server Entity id so the
 // shared camera, tank renderer, minimap, aim and interpolation all target it.
 myId=data.playerId??myId;myTeam=0;spectateId=null;isSpectating=false;
 gameState={entities:[],bullets:[],drones:[]};renderEntities.clear();lastBullets.clear();lastDrones.clear();
 myStats={...myStats,level:1,xp:0,score:0,statPoints:0,stats:[...(data.world?.stats||[0,0,0,0,0,0,0,0])],tankType:'Basic'};
 updateVisualFov();updateUI();checkUpgrades();
 document.getElementById('menu-overlay').style.display='none';document.getElementById('account-panel').style.display='none';document.getElementById('changelog-panel').style.display='none';
 document.getElementById('game-ui').style.display='block';document.getElementById('exit-btn').style.display='flex';document.getElementById('world-hud').style.display='grid';
 document.getElementById('death-screen').style.display='none';
 const extent=worldView?.extent||50400, px=extent/2+(worldState?.x||180), py=extent/2+(worldState?.y||180);
 camera.x=px-(canvas.width*fov)/2;camera.y=py-(canvas.height*fov)/2;
 worldLastView=performance.now();updateWorldHud();if(!window.drawing){window.drawing=true;requestAnimationFrame(draw);}
}
function updateWorldHud(){
 if(!worldState)return;
 const cash=document.getElementById('world-session-coins'),points=document.getElementById('world-stat-points'),coords=document.getElementById('world-coordinates');
 if(cash)cash.innerText=numberWithCommas(worldState.sessionCoins||0);
 if(points)points.innerText=myStats.statPoints||0;
 const me=gameState.entities.find(e=>e.id===myId),extent=worldView?.extent||50400;
 if(coords)coords.innerText=me?`X ${Math.round(me.x-extent/2)}  ·  Y ${Math.round(me.y-extent/2)}`:`X ${Math.round(worldState.x||0)}  ·  Y ${Math.round(worldState.y||0)}`;
 ['compact','sedan','sport'].forEach(id=>{const b=document.getElementById('world-car-'+id);if(!b)return;const owned=worldState.car===id;b.disabled=!!worldState.car;b.style.opacity=owned?'1':(worldState.car?'0.42':'1');b.innerHTML=owned?`${id.toUpperCase()}<small>OWNED</small>`:`${id.toUpperCase()}<small>${id==='compact'?'2,500':id==='sedan'?'6,500':'18,000'}</small>`;});
}
function worldWork(job){worldSend('world_work',{job});}
function worldBank(){worldSend('world_bank');}
function worldBuyCar(carId){worldSend('world_buy_car',{carId});}
function worldBuyHouse(id){if(confirm('Purchase this property for the listed price?'))worldSend('world_buy_house',{houseId:id});}
function drawWorldEnvironment(){
    if (!worldView?.cells) return;
    const toX = x => worldToScreenX((worldView.extent || 50400)/2 + x);
    const toY = y => worldToScreenY((worldView.extent || 50400)/2 + y);
    const tile = worldView.tile || 420;
    const visible = (x,y,w=0,h=0) => x < canvas.width+180 && y < canvas.height+180 && x+w > -180 && y+h > -180;
    ctx.save();
    // A restrained, game-like palette and crisp tile edges; no oversized UI-style blocks.
    worldView.cells.forEach(cell => {
        const ox=(cell.gx-60)*tile, oy=(cell.gy-60)*tile;
        const x=toX(ox), y=toY(oy), size=scaleSize(tile);
        if(!visible(x,y,size,size)) return;
        const palette={city:'#858b8e',suburb:'#86a875',park:'#61925a',farmland:'#b5a064'};
        ctx.fillStyle=palette[cell.biome]||palette.suburb;ctx.fillRect(x,y,size+1,size+1);
        // subtle ground grain and parcel seams
        ctx.strokeStyle='rgba(255,255,255,.075)';ctx.lineWidth=1;
        for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(x+size*i/4,y+3);ctx.lineTo(x+size*i/4,y+size-3);ctx.stroke();}
        if(cell.biome==='farmland'){
            ctx.fillStyle='#a98e4e';ctx.fillRect(x+scaleSize(12),y+scaleSize(12),size-scaleSize(24),size-scaleSize(24));
            ctx.strokeStyle='rgba(235,213,139,.72)';ctx.lineWidth=Math.max(1,scaleSize(4));
            for(let q=24;q<tile-12;q+=24){ctx.beginPath();ctx.moveTo(toX(ox+q),toY(oy+16));ctx.lineTo(toX(ox+q),toY(oy+tile-16));ctx.stroke();}
        }
        (cell.roads||[]).forEach(r=>{
            const rw=r.w||88;
            if(r.axis==='horizontal'){
                const ry=toY(r.y), roadH=scaleSize(rw), shoulder=scaleSize(22);
                ctx.fillStyle='#c5c2b6';ctx.fillRect(x,ry-roadH/2-shoulder,size,roadH+shoulder*2);
                ctx.fillStyle='#343b40';ctx.fillRect(x,ry-roadH/2,size,roadH);
                ctx.strokeStyle='#e7d9a1';ctx.lineWidth=Math.max(1,scaleSize(3));ctx.setLineDash([scaleSize(26),scaleSize(20)]);ctx.beginPath();ctx.moveTo(x,ry);ctx.lineTo(x+size,ry);ctx.stroke();ctx.setLineDash([]);
                ctx.strokeStyle='rgba(255,255,255,.42)';ctx.lineWidth=Math.max(1,scaleSize(2));ctx.beginPath();ctx.moveTo(x,ry-roadH/2+scaleSize(8));ctx.lineTo(x+size,ry-roadH/2+scaleSize(8));ctx.moveTo(x,ry+roadH/2-scaleSize(8));ctx.lineTo(x+size,ry+roadH/2-scaleSize(8));ctx.stroke();
            }else{
                const rx=toX(r.x),roadW=scaleSize(rw),shoulder=scaleSize(22);
                ctx.fillStyle='#c5c2b6';ctx.fillRect(rx-roadW/2-shoulder,y,roadW+shoulder*2,size);
                ctx.fillStyle='#343b40';ctx.fillRect(rx-roadW/2,y,roadW,size);
                ctx.strokeStyle='#e7d9a1';ctx.lineWidth=Math.max(1,scaleSize(3));ctx.setLineDash([scaleSize(26),scaleSize(20)]);ctx.beginPath();ctx.moveTo(rx,y);ctx.lineTo(rx,y+size);ctx.stroke();ctx.setLineDash([]);
                ctx.strokeStyle='rgba(255,255,255,.42)';ctx.lineWidth=Math.max(1,scaleSize(2));ctx.beginPath();ctx.moveTo(rx-roadW/2+scaleSize(8),y);ctx.lineTo(rx-roadW/2+scaleSize(8),y+size);ctx.moveTo(rx+roadW/2-scaleSize(8),y);ctx.lineTo(rx+roadW/2-scaleSize(8),y+size);ctx.stroke();
            }
        });
        (cell.buildings||[]).forEach(b=>{
            const bx=toX(b.x),by=toY(b.y),bw=scaleSize(b.w),bh=scaleSize(b.h);
            if(!visible(bx,by,bw,bh))return;
            if(b.kind==='tower'){
                // Layered city tower: cast shadow, side elevation, roof slab,
                // facade panels, recessed window bays and rooftop machinery.
                const d=scaleSize(18),tone=b.tone||0;
                const walls=['#526978','#657d89','#596b80','#71838a','#4f6575','#687b86'];
                const wall=walls[tone%walls.length],side=['#344955','#405663','#354958','#4a5b63'][tone%4];
                ctx.fillStyle='rgba(8,16,22,.34)';ctx.beginPath();ctx.moveTo(bx+scaleSize(8),by+scaleSize(10));ctx.lineTo(bx+bw+d+scaleSize(10),by+scaleSize(10));ctx.lineTo(bx+bw+d+scaleSize(10),by+bh+d);ctx.lineTo(bx+scaleSize(8),by+bh+d);ctx.closePath();ctx.fill();
                ctx.fillStyle=side;ctx.beginPath();ctx.moveTo(bx+bw,by);ctx.lineTo(bx+bw+d,by-scaleSize(8));ctx.lineTo(bx+bw+d,by+bh-scaleSize(8));ctx.lineTo(bx+bw,by+bh);ctx.closePath();ctx.fill();
                ctx.fillStyle='#273c49';ctx.beginPath();ctx.moveTo(bx,by);ctx.lineTo(bx+d,by-scaleSize(8));ctx.lineTo(bx+bw+d,by-scaleSize(8));ctx.lineTo(bx+bw,by);ctx.closePath();ctx.fill();
                ctx.fillStyle=wall;ctx.fillRect(bx,by,bw,bh);
                const floors=Math.max(5,b.floors||10),cols=Math.max(3,Math.floor(b.w/19)),fw=bw/cols,fh=bh/floors;
                for(let row=0;row<floors;row++){
                    ctx.fillStyle=row%4===0?'rgba(13,30,41,.18)':'rgba(255,255,255,.045)';ctx.fillRect(bx,by+row*fh,bw,fh);
                    for(let col=0;col<cols;col++){
                        const wx=bx+col*fw+fw*.18,wy=by+row*fh+fh*.19,ww=fw*.64,wh=fh*.58;
                        ctx.fillStyle='#263f50';ctx.fillRect(wx-scaleSize(2),wy-scaleSize(2),ww+scaleSize(4),wh+scaleSize(4));
                        ctx.fillStyle=((row*7+col+(b.seed||0))%13===0)?'#e9cb82':'#9fc6d4';ctx.fillRect(wx,wy,ww,wh);
                        ctx.fillStyle='rgba(255,255,255,.28)';ctx.fillRect(wx,wy,Math.max(1,ww*.13),wh);
                    }
                }
                ctx.fillStyle='#263a45';ctx.fillRect(bx-scaleSize(3),by+bh-scaleSize(8),bw+scaleSize(3),scaleSize(9));
                ctx.fillStyle='#91a9b4';ctx.fillRect(bx+scaleSize(6),by+bh-scaleSize(5),bw-scaleSize(12),scaleSize(2));
                // Rooftop plant room and mechanical vents.
                ctx.fillStyle='#344b58';ctx.fillRect(bx+bw*.58,by-scaleSize(15),bw*.28,scaleSize(15));
                ctx.fillStyle='#9eafb5';ctx.fillRect(bx+bw*.62,by-scaleSize(19),bw*.18,scaleSize(4));
                for(let vent=0;vent<3;vent++){ctx.fillStyle='#243a46';ctx.fillRect(bx+scaleSize(9+vent*15),by+scaleSize(8),scaleSize(8),scaleSize(5));}
                ctx.strokeStyle='rgba(15,27,34,.7)';ctx.lineWidth=Math.max(1,scaleSize(1.5));ctx.strokeRect(bx,by,bw,bh);
            }else if(b.kind==='house'){
                // Residential lot with lawn, driveway, front wall, roof planes,
                // chimney, porch, garage and garden/fence details.
                const roofPalette=['#8f5140','#6e4b42','#a56a4b','#566a78','#745a49','#8a6847'];
                const wallPalette=['#e1d5bd','#d5c6a8','#d5d9d1','#e2cdb7','#c9d1d0'];
                const roof=roofPalette[(b.roof||0)%roofPalette.length],wall=wallPalette[(b.style||0)%wallPalette.length];
                ctx.fillStyle='rgba(0,0,0,.22)';ctx.beginPath();ctx.ellipse(bx+bw*.54,by+bh*.88,bw*.62,bh*.28,0,0,Math.PI*2);ctx.fill();
                ctx.fillStyle='#668653';ctx.fillRect(bx-scaleSize(9),by+bh-scaleSize(8),bw+scaleSize(18),scaleSize(15));
                // Yard path and driveway to the street-facing edge.
                ctx.fillStyle='#b9b5a6';ctx.fillRect(bx+bw*.68,by+bh*.48,bw*.24,bh*.58);
                ctx.fillStyle='#d1cbb9';ctx.fillRect(bx+bw*.70,by+bh*.5,bw*.2,bh*.54);
                // Main wall and right-side shaded elevation.
                ctx.fillStyle=wall;ctx.fillRect(bx+scaleSize(4),by+scaleSize(17),bw-scaleSize(8),bh-scaleSize(20));
                ctx.fillStyle='rgba(55,48,42,.18)';ctx.beginPath();ctx.moveTo(bx+bw*.5,by+scaleSize(20));ctx.lineTo(bx+bw-scaleSize(4),by+scaleSize(20));ctx.lineTo(bx+bw-scaleSize(4),by+bh-scaleSize(4));ctx.lineTo(bx+bw*.5,by+bh-scaleSize(4));ctx.closePath();ctx.fill();
                // Roof ridge and two roof planes.
                ctx.fillStyle='#4b3a34';ctx.beginPath();ctx.moveTo(bx-scaleSize(8),by+scaleSize(23));ctx.lineTo(bx+bw*.5,by-scaleSize(13));ctx.lineTo(bx+bw+scaleSize(8),by+scaleSize(23));ctx.lineTo(bx+bw+scaleSize(3),by+scaleSize(31));ctx.lineTo(bx+bw*.5,by+scaleSize(1));ctx.lineTo(bx-scaleSize(3),by+scaleSize(31));ctx.closePath();ctx.fill();
                ctx.fillStyle=roof;ctx.beginPath();ctx.moveTo(bx-scaleSize(7),by+scaleSize(22));ctx.lineTo(bx+bw*.5,by-scaleSize(12));ctx.lineTo(bx+bw*.5,by+scaleSize(4));ctx.lineTo(bx+scaleSize(1),by+scaleSize(30));ctx.closePath();ctx.fill();
                ctx.fillStyle=roofPalette[((b.roof||0)+1)%roofPalette.length];ctx.beginPath();ctx.moveTo(bx+bw*.5,by-scaleSize(12));ctx.lineTo(bx+bw+scaleSize(7),by+scaleSize(22));ctx.lineTo(bx+bw-scaleSize(2),by+scaleSize(30));ctx.lineTo(bx+bw*.5,by+scaleSize(4));ctx.closePath();ctx.fill();
                // Chimney and front windows.
                ctx.fillStyle='#6b6258';ctx.fillRect(bx+bw*.72,by-scaleSize(9),scaleSize(9),scaleSize(21));ctx.fillStyle='#a99c8d';ctx.fillRect(bx+bw*.7,by-scaleSize(11),scaleSize(13),scaleSize(4));
                [bx+scaleSize(10),bx+bw-scaleSize(28)].forEach(wx=>{
                    ctx.fillStyle='#594b40';ctx.fillRect(wx,by+scaleSize(34),scaleSize(18),scaleSize(19));
                    ctx.fillStyle='#8fc0d0';ctx.fillRect(wx+scaleSize(2),by+scaleSize(36),scaleSize(14),scaleSize(15));
                    ctx.fillStyle='#dce5df';ctx.fillRect(wx+scaleSize(8),by+scaleSize(36),scaleSize(2),scaleSize(15));ctx.fillRect(wx+scaleSize(2),by+scaleSize(43),scaleSize(14),scaleSize(2));
                });
                // Porch, front door and garage.
                if(b.porch){ctx.fillStyle='#d2c3a8';ctx.fillRect(bx+bw*.34,by+bh-scaleSize(24),bw*.34,scaleSize(8));ctx.fillStyle='#5d5044';ctx.fillRect(bx+bw*.36,by+bh-scaleSize(32),scaleSize(4),scaleSize(13));ctx.fillRect(bx+bw*.65,by+bh-scaleSize(32),scaleSize(4),scaleSize(13));}
                ctx.fillStyle='#684a38';ctx.fillRect(bx+bw*.43,by+bh-scaleSize(31),scaleSize(17),scaleSize(31));ctx.fillStyle='#d8bd78';ctx.beginPath();ctx.arc(bx+bw*.43+scaleSize(12),by+bh-scaleSize(16),scaleSize(2),0,Math.PI*2);ctx.fill();
                if(b.garage){ctx.fillStyle='#d7d8d2';ctx.fillRect(bx+bw-scaleSize(27),by+bh-scaleSize(31),scaleSize(23),scaleSize(25));ctx.strokeStyle='#7d8888';ctx.lineWidth=1;ctx.strokeRect(bx+bw-scaleSize(27),by+bh-scaleSize(31),scaleSize(23),scaleSize(25));for(let gy=0;gy<3;gy++){ctx.beginPath();ctx.moveTo(bx+bw-scaleSize(26),by+bh-scaleSize(25-gy*7));ctx.lineTo(bx+bw-scaleSize(5),by+bh-scaleSize(25-gy*7));ctx.stroke();}}
                // Optional low garden fence and hedges.
                ctx.fillStyle='#47734a';ctx.fillRect(bx-scaleSize(8),by+bh+scaleSize(5),bw+scaleSize(16),scaleSize(5));
                if(b.fence){ctx.strokeStyle='#e5ddc9';ctx.lineWidth=Math.max(1,scaleSize(2));ctx.beginPath();ctx.moveTo(bx-scaleSize(10),by+bh+scaleSize(13));ctx.lineTo(bx+bw+scaleSize(10),by+bh+scaleSize(13));ctx.stroke();for(let fx=0;fx<=6;fx++){ctx.beginPath();ctx.moveTo(bx-scaleSize(10)+fx*bw/6,by+bh+scaleSize(8));ctx.lineTo(bx-scaleSize(10)+fx*bw/6,by+bh+scaleSize(17));ctx.stroke();}}
            }else if(b.kind==='trees'){
                for(let i=0;i<7;i++){const tx=bx+scaleSize((i%4)*42-35),ty=by+scaleSize(Math.floor(i/4)*48-24);ctx.fillStyle='rgba(0,0,0,.18)';ctx.beginPath();ctx.ellipse(tx+scaleSize(5),ty+scaleSize(13),scaleSize(22),scaleSize(11),0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#604a35';ctx.fillRect(tx-scaleSize(3),ty+scaleSize(2),scaleSize(6),scaleSize(23));ctx.fillStyle=['#2e6d3e','#3c8048','#4b914f'][i%3];ctx.beginPath();ctx.arc(tx,ty,scaleSize(21),0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(255,255,255,.13)';ctx.beginPath();ctx.arc(tx-scaleSize(6),ty-scaleSize(7),scaleSize(7),0,Math.PI*2);ctx.fill();}
            }else if(b.kind==='bench'){
                ctx.fillStyle='rgba(0,0,0,.22)';ctx.fillRect(bx+scaleSize(2),by+scaleSize(4),bw,bh);
                ctx.fillStyle='#674b32';ctx.fillRect(bx,by,bw,bh);ctx.fillStyle='#a47b4f';ctx.fillRect(bx,by-scaleSize(5),bw,scaleSize(6));ctx.fillStyle='#44372b';ctx.fillRect(bx+scaleSize(5),by+bh-scaleSize(1),scaleSize(4),scaleSize(8));ctx.fillRect(bx+bw-scaleSize(9),by+bh-scaleSize(1),scaleSize(4),scaleSize(8));
            }else if(b.kind==='field'){
                ctx.fillStyle='#a98e4e';ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle='#dfc87e';ctx.lineWidth=Math.max(1,scaleSize(4));for(let q=12;q<b.w;q+=22){ctx.beginPath();ctx.moveTo(bx+scaleSize(q),by+scaleSize(4));ctx.lineTo(bx+scaleSize(q),by+bh-scaleSize(4));ctx.stroke();}
            }
        });
        // Lamp posts and roadside trees are deterministic decorative props.
        if(cell.biome==='park'||cell.biome==='suburb')for(let i=0;i<2;i++){
            const lx=toX(ox+70+i*245),ly=toY(oy+100+i*175);
            if(!visible(lx-12,ly-40,24,45))continue;
            ctx.strokeStyle='#384346';ctx.lineWidth=Math.max(1,scaleSize(4));ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(lx,ly-scaleSize(31));ctx.lineTo(lx+scaleSize(8),ly-scaleSize(36));ctx.stroke();ctx.fillStyle='#f5dfa0';ctx.beginPath();ctx.arc(lx+scaleSize(8),ly-scaleSize(36),scaleSize(5),0,Math.PI*2);ctx.fill();
        }
    });
    // Bank / city landmark is anchored in world coordinates, not screen coordinates.
    const bx=toX(-95),by=toY(-105),bw=scaleSize(190),bh=scaleSize(150);
    if(visible(bx,by,bw,bh)){
        ctx.fillStyle='rgba(0,0,0,.25)';ctx.fillRect(bx+scaleSize(8),by+scaleSize(10),bw,bh);
        ctx.fillStyle='#d6d9d5';ctx.fillRect(bx,by,bw,bh);ctx.fillStyle='#345b77';ctx.fillRect(bx+scaleSize(10),by+scaleSize(10),bw-scaleSize(20),scaleSize(42));
        ctx.fillStyle='#fff';ctx.font=`bold ${Math.max(8,scaleSize(19))}px Ubuntu`;ctx.textAlign='center';ctx.fillText('BANK',bx+bw/2,by+scaleSize(38));
        for(let i=0;i<4;i++){ctx.fillStyle='#9ac4d1';ctx.fillRect(bx+scaleSize(15+i*42),by+scaleSize(67),scaleSize(27),scaleSize(73));ctx.strokeStyle='#b7b4a8';ctx.strokeRect(bx+scaleSize(15+i*42),by+scaleSize(67),scaleSize(27),scaleSize(73));}
        ctx.fillStyle='#78573d';ctx.fillRect(bx+bw/2-scaleSize(15),by+bh-scaleSize(62),scaleSize(30),scaleSize(62));
    }
    // Detailed top-down traffic vehicles: wheel arches, bumpers, hood, roof,
    // glazing, mirrors, lamps and specular highlights. These are props only;
    // they never replace or alter the player's arena tank entity.
    (worldView.cars||[]).forEach(car=>{
        const x=toX(car.x),y=toY(car.y);if(!visible(x-scaleSize(34),y-scaleSize(22),scaleSize(68),scaleSize(44)))return;
        const sc=scaleSize;ctx.save();ctx.translate(x,y);ctx.rotate(car.dir===1?0:Math.PI/2);
        ctx.fillStyle='rgba(0,0,0,.32)';ctx.beginPath();ctx.ellipse(sc(1),sc(3),sc(31),sc(17),0,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#11171c';[[-20,-16],[12,-16],[-20,10],[12,10]].forEach(([wx,wy])=>{ctx.beginPath();ctx.roundRect(sc(wx),sc(wy),sc(10),sc(7),sc(2));ctx.fill();});
        ctx.fillStyle='#202a31';ctx.beginPath();ctx.roundRect(sc(-29),sc(-15),sc(58),sc(30),sc(9));ctx.fill();
        ctx.fillStyle=car.color||'#c7d1d8';ctx.beginPath();ctx.roundRect(sc(-27),sc(-14),sc(54),sc(28),sc(8));ctx.fill();
        ctx.fillStyle='rgba(255,255,255,.26)';ctx.beginPath();ctx.roundRect(sc(-23),sc(-12),sc(44),sc(4),sc(2));ctx.fill();
        ctx.fillStyle='#263c4a';ctx.beginPath();ctx.roundRect(sc(-12),sc(-11),sc(25),sc(22),sc(5));ctx.fill();
        ctx.fillStyle='#8bb7c9';ctx.beginPath();ctx.moveTo(sc(-9),sc(-9));ctx.lineTo(sc(-1),sc(-9));ctx.lineTo(sc(-1),sc(9));ctx.lineTo(sc(-9),sc(9));ctx.closePath();ctx.fill();
        ctx.fillStyle='#a9d0dc';ctx.beginPath();ctx.moveTo(sc(2),sc(-9));ctx.lineTo(sc(10),sc(-8));ctx.lineTo(sc(10),sc(8));ctx.lineTo(sc(2),sc(9));ctx.closePath();ctx.fill();
        ctx.strokeStyle='rgba(13,24,31,.65)';ctx.lineWidth=Math.max(1,sc(1.5));ctx.beginPath();ctx.moveTo(sc(0),sc(-10));ctx.lineTo(sc(0),sc(10));ctx.stroke();
        ctx.fillStyle='#dce6e8';ctx.fillRect(sc(14),sc(-5),sc(8),sc(10));
        ctx.fillStyle='#fff0bf';ctx.beginPath();ctx.roundRect(sc(25),sc(-10),sc(3),sc(6),sc(1));ctx.roundRect(sc(25),sc(4),sc(3),sc(6),sc(1));ctx.fill();
        ctx.fillStyle='#d64d46';ctx.fillRect(sc(-28),sc(-10),sc(3),sc(6));ctx.fillRect(sc(-28),sc(4),sc(3),sc(6));
        ctx.fillStyle='#26333a';ctx.fillRect(sc(-29),sc(-4),sc(3),sc(8));ctx.fillRect(sc(26),sc(-4),sc(3),sc(8));
        ctx.restore();
    });
    (worldView.citizens||[]).forEach(n=>{
        const x=toX(n.x),y=toY(n.y);if(!visible(x-10,y-10,20,20))return;
        ctx.fillStyle='rgba(0,0,0,.2)';ctx.beginPath();ctx.ellipse(x,y+scaleSize(5),scaleSize(6),scaleSize(3),0,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#40586b';ctx.beginPath();ctx.roundRect(x-scaleSize(4),y-scaleSize(1),scaleSize(8),scaleSize(10),scaleSize(3));ctx.fill();ctx.fillStyle='#e4b995';ctx.beginPath();ctx.arc(x,y-scaleSize(5),scaleSize(4),0,Math.PI*2);ctx.fill();
    });
    // Unowned property markers are map props; the tank and all combat entities are drawn later by draw().
    (worldView.houses||[]).forEach(h=>{
        const x=toX(h.x),y=toY(h.y);if(!visible(x-20,y-20,40,40))return;
        ctx.fillStyle=h.owner_id?'#778078':'#ffe39a';ctx.fillRect(x-scaleSize(10),y-scaleSize(6),scaleSize(20),scaleSize(12));
        ctx.fillStyle='#8c5142';ctx.beginPath();ctx.moveTo(x-scaleSize(13),y-scaleSize(6));ctx.lineTo(x,y-scaleSize(18));ctx.lineTo(x+scaleSize(13),y-scaleSize(6));ctx.fill();
    });
    ctx.restore();
}



function connectWS(regionStr, modeStr) {

    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';

    ws = new WebSocket(protocol + window.location.host);

    ws.binaryType = 'arraybuffer'

    function sendPing() {

        if (ws && ws.readyState === 1) {

            ws.send(JSON.stringify({ type: 'ping', time: performance.now() }));

        }

    }

    ws.onopen = () => {

        ws.send(JSON.stringify({ type: 'spectate', mode: modeStr, region: regionStr }));

        document.getElementById('playBtn').innerText = "Play";

        document.getElementById('playBtn').disabled = false;

        if (sessionToken) {
            ws.send(JSON.stringify({ type: 'auth_login', token: sessionToken }));
        }
        if (pendingWorldJoin) { pendingWorldJoin=false; ws.send(JSON.stringify({type:'world_join'})); }

        sendPing();

        if (window.inputInterval) clearInterval(window.inputInterval);

        window.inputInterval = setInterval(() => {

    if (isWorldMode && performance.now()-worldLastView>1400) { worldLastView=performance.now(); worldSend('world_refresh'); }
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

            ws.send(JSON.stringify({ type: 'auth_login', token: token }));

            window.history.replaceState({}, document.title, "/"); 

        }

    };



    ws.onmessage = (e) => {

        const data = JSON.parse(e.data);
        if(data.type==='world_joined'){beginWorldMode(data);return;}
        if(data.type==='world_position'){worldState={...worldState,...data};updateWorldHud();return;}
        if(data.type==='world_view'){worldView=data.view;return;}
        if(data.type==='world_notice'){if(data.sessionCoins!==undefined)worldState.sessionCoins=data.sessionCoins;if(data.statPoints!==undefined)worldState.statPoints=data.statPoints;document.getElementById('world-message').innerText=data.message||'';updateWorldHud();return;}
        if(data.type==='world_death'){worldState=data.world;worldView=data.view;document.getElementById('world-message').innerText=`${data.reason}. Fresh FFA spawn; permanent stat upgrades kept.`;updateWorldHud();return;}
        if(data.type==='world_house_prompt'){if(confirm(`Available house plot: ${data.price.toLocaleString()} coins. Buy it?`))worldBuyHouse(data.houseId);return;}
        if(data.type==='world_error'){pendingWorldJoin=false;alert(data.message);return;}

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

            ws.send(JSON.stringify({ type: 'upgradeTank', tank: c }));

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

    const activeWorldExtent = isWorldMode ? (worldView?.extent || 50400) : WORLD_SIZE;
    let targetCamX = activeWorldExtent/2 - (canvas.width * fov) / 2;

    let targetCamY = activeWorldExtent/2 - (canvas.height * fov) / 2;



    if (myId) {

        let me = gameState.entities.find(e => e.id === myId);

        if(me) {

            if (!renderEntities.has(me.id)) renderEntities.set(me.id, { ...me, renderX: me.x, renderY: me.y });

            let rMe = renderEntities.get(me.id);

            targetCamX = rMe.renderX - (canvas.width * fov) / 2;

            targetCamY = rMe.renderY - (canvas.height * fov) / 2;



            if (myStats.tankType === 'Sniper' && (mouse.rightDown || keys.shift)) {

                let mouseAngle = Math.atan2(mouse.ry - rMe.renderY, mouse.rx - rMe.renderX);

                targetCamX += Math.cos(mouseAngle) * (450 * fov);

                targetCamY += Math.sin(mouseAngle) * (450 * fov);

            }

        } else if (isWorldMode && worldState) {
            const wx=activeWorldExtent/2+(worldState.x||180),wy=activeWorldExtent/2+(worldState.y||180);
            targetCamX=wx-(canvas.width*fov)/2;targetCamY=wy-(canvas.height*fov)/2;
        }

    } else if (isWorldMode && worldState) {
        const wx=activeWorldExtent/2+(worldState.x||180),wy=activeWorldExtent/2+(worldState.y||180);
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



    const cameraEase=isWorldMode?0.22:0.1;
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

        let rx = rPos.renderX; 

        let ry = rPos.renderY; 

        let ra = rPos.renderAngle !== undefined ? rPos.renderAngle : en.angle;

        

        Object.assign(rPos, en);

        

        // Apply Lerping (adjusted to 0.2 to compensate for the slower server tick)

        rPos.renderX = lerp(rx, en.x, 0.2);

        rPos.renderY = lerp(ry, en.y, 0.2);



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

            

            ctx.strokeText(en.name, sx, sy - en.radius - 25);

            ctx.fillText(en.name, sx, sy - en.radius - 25);

            

            fontSize = Math.max(5.5, 11 / fov); 

            ctx.font = `bold ${fontSize}px Ubuntu`;

            ctx.fillStyle = "white";

            ctx.strokeStyle = "black";

            const displayScore = formatScore(Math.floor(en.score));

            ctx.strokeText(displayScore, sx, sy - en.radius- 12);

            ctx.fillText(displayScore, sx, sy - en.radius - 12);



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

        drawEntityBody(ctx, rPos);

        ctx.globalAlpha = 1;

        ctx.restore();

    });

    if (drawCounter % 10 === 0) {

        updateLeaderboard();

        if (isSpectating) updateSpectateLabel();

    }

    mCtx.clearRect(0,0,150,150);
    if (isWorldMode) {
        const tile=worldView?.tile||420,cells=worldView?.cells||[],extent=worldView?.extent||50400;
        mCtx.fillStyle='#202b31';mCtx.fillRect(0,0,150,150);
        if(cells.length){
            const minGX=Math.min(...cells.map(c=>c.gx)),maxGX=Math.max(...cells.map(c=>c.gx));
            const minGY=Math.min(...cells.map(c=>c.gy)),maxGY=Math.max(...cells.map(c=>c.gy));
            const cols=maxGX-minGX+1,rows=maxGY-minGY+1,cellW=150/cols,cellH=150/rows;
            const point=(wx,wy)=>({x:((wx/tile+60)-minGX)*cellW,y:((wy/tile+60)-minGY)*cellH});
            const biomeColors={city:'#59666f',suburb:'#73966c',park:'#3f794d',farmland:'#aa9255'};
            cells.forEach(cell=>{
                const x=(cell.gx-minGX)*cellW,y=(cell.gy-minGY)*cellH;
                mCtx.fillStyle=biomeColors[cell.biome]||'#73966c';mCtx.fillRect(x,y,cellW+.4,cellH+.4);
                (cell.roads||[]).forEach(r=>{
                    mCtx.fillStyle='#313b42';
                    if(r.axis==='horizontal'){
                        const road=Math.max(1,(r.w||80)/tile*cellH),ry=((r.y/tile+60)-minGY)*cellH;
                        mCtx.fillRect(x,ry-road*.5,cellW,road);
                    }else{
                        const road=Math.max(1,(r.w||80)/tile*cellW),rx=((r.x/tile+60)-minGX)*cellW;
                        mCtx.fillRect(rx-road*.5,y,road,cellH);
                    }
                });
            });
            // Shape dots are the same server-side arena shapes that award score/XP.
            gameState.entities.forEach(en=>{
                if(!['square','triangle','pentagon','hexagon','powerup'].includes(en.type))return;
                const q=point(en.x-extent/2,en.y-extent/2);if(q.x<0||q.y<0||q.x>150||q.y>150)return;
                mCtx.fillStyle=en.type==='square'?'#f8de4d':en.type==='triangle'?'#fc6868':en.type==='pentagon'?'#7b83ff':en.type==='powerup'?'#f5a6ff':'#72eff4';
                mCtx.beginPath();mCtx.arc(q.x,q.y,1.15,0,Math.PI*2);mCtx.fill();
            });
            (worldView.cars||[]).forEach(car=>{const q=point(car.x,car.y);if(q.x>=0&&q.y>=0&&q.x<=150&&q.y<=150){mCtx.fillStyle='#e8a15b';mCtx.fillRect(q.x-1,q.y-1,2,2);}});
            (worldView.houses||[]).forEach(h=>{const q=point(h.x,h.y);if(q.x>=0&&q.y>=0&&q.x<=150&&q.y<=150){mCtx.fillStyle=h.owner_id?'#89958b':'#ffe19a';mCtx.fillRect(q.x-1.5,q.y-1.5,3,3);}});
            const me=gameState.entities.find(en=>en.id===myId);
            const px=me?me.x-extent/2:(worldState?.x||0),py=me?me.y-extent/2:(worldState?.y||0),q=point(px,py);
            // Current camera footprint, clipped to the local minimap window.
            const viewW=Math.min(150,canvas.width*fov/tile*cellW),viewH=Math.min(150,canvas.height*fov/tile*cellH);
            mCtx.strokeStyle='rgba(255,255,255,.32)';mCtx.lineWidth=.8;mCtx.strokeRect(q.x-viewW/2,q.y-viewH/2,viewW,viewH);
            mCtx.fillStyle='#fff';mCtx.strokeStyle='#142027';mCtx.lineWidth=1.6;mCtx.beginPath();mCtx.arc(q.x,q.y,3.5,0,Math.PI*2);mCtx.fill();mCtx.stroke();
        }
        mCtx.strokeStyle='rgba(255,255,255,.85)';mCtx.lineWidth=1;mCtx.strokeRect(.5,.5,149,149);
    }else {
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

    if (key === 'g' && isWorldMode) { worldSend('world_enter_car'); return; }
    if (key === 'e') autoFire = !autoFire;

    if (key === 'c') autoSpin = !autoSpin;



    // Stat Upgrades (1-8)

    if (key >= '1' && key <= '8') {

        if (ws && ws.readyState === 1) { 

            ws.send(JSON.stringify({ 

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
