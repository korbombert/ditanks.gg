const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const mCanvas = document.getElementById('minimapCanvas');
const mCtx = mCanvas.getContext('2d');

// --- INJECT CUSTOM CSS FOR ANIMATIONS & UI ---
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
`;
document.head.appendChild(style);

const WORLD_SIZE = 4000;
const BASE_SIZE = 600;
const TICK_RATE = 45;
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

    let unlocked = JSON.parse(myProfile.unlocked_colors);
    
    shopItems[category].forEach(item => {
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

        container.innerHTML += `
            <div class="shop-item">
                <span style="color: ${item.id}; font-weight:bold; font-size: 16px;">${item.name}</span>
                ${btnHtml}
            </div>
        `;
    });
}

let ws;
let myId = null;
let spectateId = null; 
let myTeam = null;
let gameMode = "FFA";
let camera = { x: WORLD_SIZE/2, y: WORLD_SIZE/2 };
let mouse = { x: 0, y: 0, rx: 0, ry: 0, pressed: false, rightDown: false, repel: false };
let keys = { w:false, a:false, s:false, d:false, shift: false };

let autoFire = false;
let autoSpin = false;
let spinAngle = 0;
let renderEntities = new Map(); 
let lastBullets = new Map();
let lastDrones = new Map();
let dyingEntities = [];
const deathCanvas = document.createElement('canvas');
deathCanvas.width = 300;
deathCanvas.height = 300;
const deathCtx = deathCanvas.getContext('2d');

let gameState = { entities: [], bullets: [], drones: [] };
let myStats = { xp: 0, level: 1, statPoints: 0, stats: [0,0,0,0,0,0,0,0], tankType: 'Basic', score: 0 };

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

// Updated TANK_SPECS with Smasher removed
const TANK_SPECS = {
    'Basic': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0}] },
    'Twin': { barrels: [{x:0, y:-10, w:16, l:1.8, angle:0}, {x:0, y:10, w:16, l:1.8, angle:0}] },
    'Sniper': { barrels: [{x:0, y:0, w:18, l:2.4, angle:0}] },
    'Machine Gun': { barrels: [{x:0, y:0, w:22, w2: 32, l:1.6, angle:0}] },
    'Flank Guard': { barrels: [{x:0, y:0, w:18, l:1.8, angle:0}, {x:0, y:0, w:18, l:1.5, angle:Math.PI}] },
    'Overseer': { barrels: [{x:0, y:0, w:30, w2:40, l:1.3, angle:Math.PI/2}, {x:0, y:0, w:30, w2:40, l:1.3, angle:-Math.PI/2}] },
    'Destroyer': { barrels: [{x:0, y:0, w:35, l:1.9, angle:0}] },
    'Octo Tank': { barrels: [
        {x:0, y:0, w:16, l:1.8, angle:0}, {x:0, y:0, w:16, l:1.8, angle:Math.PI/4},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI/2}, {x:0, y:0, w:16, l:1.8, angle:3*Math.PI/4},
        {x:0, y:0, w:16, l:1.8, angle:Math.PI}, {x:0, y:0, w:16, l:1.8, angle:-3*Math.PI/4},
        {x:0, y:0, w:16, l:1.8, angle:-Math.PI/2}, {x:0, y:0, w:16, l:1.8, angle:-Math.PI/4}
    ] },
    'Triplet': { barrels: [
        {x:0, y:-12, w:14, l:1.6, angle:0}, {x:0, y:12, w:14, l:1.6, angle:0},
        {x:0, y:0, w:14, l:1.8, angle:0}
    ] },
    'Tri-angle': { barrels: [
        {x:0, y:0, w:18, l:1.8, angle:0},
        {x:0, y:0, w:16, l:1.6, angle:5*Math.PI/6},
        {x:0, y:0, w:16, l:1.6, angle:-5*Math.PI/6}
    ] }
};

const iconCache = {};
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
    tctx.beginPath(); tctx.arc(0, 0, r, 0, Math.PI*2); tctx.fill(); tctx.stroke();
    
    iconCache[key] = tc.toDataURL();
    return iconCache[key];
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
const REFERENCE_WIDTH = 1920;
let fovFactor = 1;
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
        opt.innerText = mode === "2TDM" ? "🔵 2 Teams" : (mode === "4TDM" ? "🟪 4 Teams" : "⚔️ Free For All");
        modeSelect.appendChild(opt);
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

// Locate these functions in client.js and update them:

function spawnPlayer() {
    saveColors();
    gameMode = document.getElementById('gameModeInput').value;
    document.getElementById('sb-title').innerText = gameMode === "2TDM" ? "2 Teams" : (gameMode === "4TDM" ? "4 Teams" : "FFA");

    ws.send(JSON.stringify({ type: 'spawn', name: document.getElementById('nameInput').value || "Unnamed" }));

    document.getElementById('menu-overlay').style.display = 'none';
    document.getElementById('account-panel').style.display = 'none';
    document.getElementById('changelog-panel').style.display = 'none'; 

    document.getElementById('game-ui').style.display = 'block';
    document.getElementById('exit-btn').style.display = 'flex';
    document.getElementById('death-screen').style.display = 'none';
    initUI();
}

function continueToMenu() {
    document.getElementById('death-screen').style.display = 'none';
    document.getElementById('game-ui').style.display = 'none';
    document.getElementById('exit-btn').style.display = 'none';
    document.getElementById('menu-overlay').style.display = 'flex';
    document.getElementById('account-panel').style.display = 'block';
    // Add this line to show the changelog again:
    document.getElementById('changelog-panel').style.display = 'block'; 
}
function exitGame() {
    if(confirm("Are you sure you want to disconnect and return to the menu?")) { location.reload(); }
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

function connectWS(regionStr, modeStr) {
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(protocol + window.location.host);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'spectate', mode: modeStr, region: regionStr }));
        document.getElementById('playBtn').innerText = "Play";
        document.getElementById('playBtn').disabled = false;
        if (sessionToken) {
            ws.send(JSON.stringify({ type: 'auth_login', token: sessionToken }));
        }
        if (window.pingInterval) clearInterval(window.pingInterval);
        window.pingInterval = setInterval(() => { if(ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', time: performance.now() })); }, 10);
        
        if (window.inputInterval) clearInterval(window.inputInterval);
        if (window.inputInterval) clearInterval(window.inputInterval);
        window.inputInterval = setInterval(() => {
            if(myId) {
                let finalAngle = 0;
                let me = gameState.entities.find(e => e.id === myId);
                
                if (me) {
                    let myX = renderEntities.has(myId) ? renderEntities.get(myId).renderX : me.x;
                    let myY = renderEntities.has(myId) ? renderEntities.get(myId).renderY : me.y;
                    
                    finalAngle = Math.atan2(mouse.ry - myY, mouse.rx - myX);
                } else {
                    finalAngle = Math.atan2(mouse.ry - (camera.y + canvas.height/2), mouse.rx - (camera.x + canvas.width/2));
                }

                if (autoSpin) { spinAngle += 0.08; finalAngle = spinAngle; }

                ws.send(JSON.stringify({
                    type: 'input', up: keys.w || keys.arrowup, down: keys.s || keys.arrowdown,
                    left: keys.a || keys.arrowleft, right: keys.d || keys.arrowright,
                    shooting: mouse.pressed || autoFire, angle: finalAngle,
                    repel: mouse.repel, mouseX: mouse.rx, mouseY: mouse.ry,
                }));
            }
        }, 1000 / TICK_RATE);
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');
        
        if (token) {
            ws.send(JSON.stringify({ type: 'auth_login', token: token }));
            window.history.replaceState({}, document.title, "/"); 
        }
    };

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if(data.type === 'init') { myId = data.id; myTeam = data.team; spectateId = null; }
        else if(data.type === 'pong') { document.getElementById('ping-display').innerText = ` ${(performance.now() - data.time).toFixed(1)} ms ${data.locationl}`; }
        else if(data.type === 'state') { 
            gameState = data; 
            if (!window.drawing) { window.drawing = true; requestAnimationFrame(draw); }
        }
        else if(data.type === 'playerStats') { myStats = data; updateUI(); checkUpgrades(); }
        else if(data.type === 'spectate_update') { spectateId = data.id; }
        else if(data.type === 'death') {
            myId = null;
            spectateId = data.killerId; 
            document.getElementById('death-screen').style.display = 'flex';
            document.getElementById('ds-level').innerText = data.level + " " + data.tank;
            document.getElementById('ds-score').innerText = numberWithCommas(Math.floor(data.score));
            let m = Math.floor(data.timeAlive / 60); let s = data.timeAlive % 60;
            document.getElementById('ds-time').innerText = `${m}m ${s}s`;
            
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

            dctx.beginPath(); dctx.arc(0, 0, r, 0, Math.PI*2); dctx.fill(); dctx.stroke();
            dctx.restore();
        }
        if (data.type === 'profile_update') {
            myProfile = data.profile;
            updateAccountUI();
        }
    };

    ws.onclose = (e) => {
        if(myId) {
            document.getElementById('death-screen').style.display = 'flex';
            document.querySelector('.ds-title').innerText = "Disconnected";
            document.getElementById('ds-level').innerText = "Connection lost.";
            document.getElementById('ds-score').innerText = "--";
            document.getElementById('ds-time').innerText = "--";
        }
        
        // Tween button to Red & Add Redo Icon
        const btn = document.getElementById('playBtn');
        btn.innerHTML = `<img src="" style="width: 20px; height: 20px; vertical-align: middle; margin-right: 8px; filter: brightness(0) invert(1);"> Disconnected`;
        btn.style.background = "#f14e54"; 
        btn.style.borderBottomColor = "#c83d42"; 
        btn.disabled = false;

        // Show Reason
        const reasonText = e.reason || "Connection lost to the server.";
        const reasonDiv = document.getElementById('disconnect-reason');
        reasonDiv.innerText = reasonText;
        reasonDiv.style.display = 'block';
    };
}

let currentUpgradesShown = "";
function checkUpgrades() {
    const upPanel = document.getElementById('upgrades-panel');
    let options = [];
    
    // Removed Smasher from the evolution pool
    if (myStats.level >= 15 && myStats.tankType === 'Basic') {
        options = ['Twin', 'Sniper', 'Machine Gun', 'Flank Guard']; 
    } else if (myStats.level >= 30) {
        if (myStats.tankType === 'Sniper') options = ['Overseer'];
        else if (myStats.tankType === 'Machine Gun') options = ['Destroyer'];
        else if (myStats.tankType === 'Twin') options = ['Octo Tank', 'Triplet'];
        else if (myStats.tankType === 'Flank Guard') options = ['Tri-angle', 'Octo Tank'];
    }

    let neededStr = options.join(",");
    if (currentUpgradesShown === neededStr) return;
    currentUpgradesShown = neededStr;
    
    upPanel.innerHTML = '';
    
    // Animate Upgrade Panel Left Slide
    if (options.length > 0) {
        upPanel.style.transform = 'translateX(0)';
    } else {
        upPanel.style.transform = 'translateX(-150%)';
    }

    options.forEach(c => {
        let btn = document.createElement('div'); 
        btn.className = 'upgrade-btn square-upgrade';
        
        let iconUrl = getCachedTankIcon(c, getTeamColor(myTeam));
        
        // Bigger icon size
        btn.innerHTML = `
            <img src="${iconUrl}" style="width:55px; height:55px; margin-bottom:4px;">
            <span>${c}</span>
        `;
        
        btn.onclick = () => { 
            ws.send(JSON.stringify({ type: 'upgradeTank', tank: c })); 
            currentUpgradesShown = "";
            upPanel.style.transform = 'translateX(-150%)';
            setTimeout(() => upPanel.innerHTML = '', 400); // Wait for anim
        };
        upPanel.appendChild(btn);
    });
}

function updateUI() {
    let scoreText = document.getElementById('score-text-overlay');
    if(scoreText) scoreText.innerText = "Score: " + Math.floor(myStats.score);
    
    let xpBar = document.getElementById('xp-bar');
    if (xpBar) {
        xpBar.style.backgroundColor = getTeamColor(myTeam);
        xpBar.style.width = myStats.level >= 30 ? "100%" : ((myStats.xp / (myStats.level * 40)) * 100 + "%");
    }
    
    let levelText = document.getElementById('level-text');
    if (levelText) {
        levelText.innerHTML = `
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


function drawPoly(context, sides, r) {
    context.beginPath();
    for(let i=0; i<sides; i++){
        let a = (i * Math.PI * 2 / sides);
        context.lineTo(Math.cos(a)*r*1.2, Math.sin(a)*r*1.2);
    }
    context.closePath(); context.fill(); context.stroke();
}

function drawEntityBody(context, en) {
    context.lineWidth = 4;
    if(['tank','ai'].includes(en.type)) {
        let col = getTeamColor(en.team);

        context.fillStyle = col; context.strokeStyle = darkenColor(col, 30); 
            
        let specs = TANK_SPECS[en.tankType] || TANK_SPECS['Basic'];
        specs.barrels.forEach(b => {
            context.save(); context.rotate(en.angle + b.angle);
            context.fillStyle = "#999"; context.strokeStyle = darkenColor("#999", 30); 

            if(b.w2) {
                context.beginPath(); context.moveTo(0, -b.w/2); context.lineTo(en.radius * b.l, -b.w2/2);
                context.lineTo(en.radius * b.l, b.w2/2); context.lineTo(0, b.w/2); context.closePath();
                context.fill(); context.stroke();
            } else {
                context.fillRect(0, -b.w/2 + (b.y||0), en.radius * b.l, b.w);
                context.strokeRect(0, -b.w/2 + (b.y||0), en.radius * b.l, b.w);
            }
            context.restore();
        });

        context.beginPath(); context.arc(0, 0, en.radius, 0, Math.PI*2); context.fill(); context.stroke();
    } else {
        if(en.type==='square'){ context.fillStyle=COLORS.square; context.strokeStyle=darkenColor(COLORS.square, 30); context.fillRect(-12,-12,24,24); context.strokeRect(-12,-12,24,24); }
        if(en.type==='triangle'){ context.fillStyle=COLORS.triangle; context.strokeStyle=darkenColor(COLORS.triangle, 30); context.rotate(en.angle); drawPoly(context, 3, en.radius); }
        if(en.type==='pentagon'){ context.fillStyle=COLORS.pentagon; context.strokeStyle=darkenColor(COLORS.pentagon, 30); context.rotate(en.angle); drawPoly(context, 5, en.radius); }
        if(en.type==='hexagon'){ context.fillStyle=COLORS.hexagon; context.strokeStyle=darkenColor(COLORS.hexagon, 30); context.rotate(en.angle); drawPoly(context, 6, en.radius); }
    }
}
let lastFpsTime = 0;
let frames = 0;
let currentFps = 0;
// --- Cache the Grid Pattern ---
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
function draw() {
    // 1. Calculate FPS
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
    let targetCamX = WORLD_SIZE/2 - canvas.width/2;
    let targetCamY = WORLD_SIZE/2 - canvas.height/2;

    if (myId) {
        let me = gameState.entities.find(e => e.id === myId);
        if(me) {
            if (!renderEntities.has(me.id)) renderEntities.set(me.id, { ...me, renderX: me.x, renderY: me.y });
            let rMe = renderEntities.get(me.id);
            targetCamX = rMe.renderX - canvas.width/2;
            targetCamY = rMe.renderY - canvas.height/2;

            if (myStats.tankType === 'Sniper' && (mouse.rightDown || keys.shift)) {
                let mouseAngle = Math.atan2(mouse.ry - rMe.renderY, mouse.rx - rMe.renderX);
                targetCamX += Math.cos(mouseAngle) * 450;
                targetCamY += Math.sin(mouseAngle) * 450;
            }
        }
    } else if (spectateId) {
        let spec = gameState.entities.find(e => e.id === spectateId);
        if(spec) {
            if (!renderEntities.has(spec.id)) renderEntities.set(spec.id, { ...spec, renderX: spec.x, renderY: spec.y });
            let rSpec = renderEntities.get(spec.id);
            targetCamX = rSpec.renderX - canvas.width/2;
            targetCamY = rSpec.renderY - canvas.height/2;
        }
    }

    camera.x += (targetCamX - camera.x) * 0.1;
    camera.y += (targetCamY - camera.y) * 0.1;

    mouse.rx = mouse.x + camera.x; 
    mouse.ry = mouse.y + camera.y;
    if (!gridPattern) gridPattern = ctx.createPattern(gridCanvas, 'repeat');
    ctx.save();
    ctx.fillStyle = gridPattern;
    ctx.translate(-(camera.x % 50), -(camera.y % 50));
    ctx.fillRect(-50, -50, canvas.width + 100, canvas.height + 100);
    ctx.restore();
    if(gameMode === "2TDM") {
        ctx.fillStyle = "rgba(0, 178, 225, 0.15)"; ctx.fillRect(-camera.x, -camera.y, 400, WORLD_SIZE); // Decreased width, full height
        ctx.fillStyle = "rgba(241, 78, 84, 0.15)"; ctx.fillRect(WORLD_SIZE-400-camera.x, -camera.y, 400, WORLD_SIZE);
    } else if (gameMode === "4TDM") {
        ctx.fillStyle = "rgba(0, 178, 225, 0.15)"; ctx.fillRect(-camera.x, -camera.y, BASE_SIZE, BASE_SIZE); // TL (Blue)
        ctx.fillStyle = "rgba(190, 127, 245, 0.15)"; ctx.fillRect(WORLD_SIZE-BASE_SIZE-camera.x, -camera.y, BASE_SIZE, BASE_SIZE); // TR (Purple)
        ctx.fillStyle = "rgba(0, 225, 110, 0.15)"; ctx.fillRect(-camera.x, WORLD_SIZE-BASE_SIZE-camera.y, BASE_SIZE, BASE_SIZE); // BL (Green)
        ctx.fillStyle = "rgba(241, 78, 84, 0.15)"; ctx.fillRect(WORLD_SIZE-BASE_SIZE-camera.x, WORLD_SIZE-BASE_SIZE-camera.y, BASE_SIZE, BASE_SIZE); // BR (Red)
    }

    ctx.fillStyle = "rgba(0,0,0,0.02)"; 
    ctx.fillRect(1700 - camera.x, 1700 - camera.y, 600, 600);

    const activeIds = gameState.entities.map(e => e.id);
    for (let [id, rEnt] of renderEntities.entries()) {
        if (!activeIds.includes(id)) {
            const sx = rEnt.renderX - camera.x;
            const sy = rEnt.renderY - camera.y;
            if (sx > -200 && sx < canvas.width + 200 && sy > -200 && sy < canvas.height + 200) {
                dyingEntities.push({ ...rEnt, deathType: 'entity', deathTime: Date.now() });
            }
            renderEntities.delete(id);
        }
    }

    const activeBulletIds = new Set(gameState.bullets.map(b => b.id));
    for (let [id, b] of lastBullets.entries()) {
        if (!activeBulletIds.has(id)) {
            const sx = b.x - camera.x; const sy = b.y - camera.y;
            if (sx > -50 && sx < canvas.width + 50 && sy > -50 && sy < canvas.height + 50) {
                dyingEntities.push({ ...b, renderX: b.x, renderY: b.y, deathType: 'bullet', deathTime: Date.now() });
            }
            lastBullets.delete(id);
        }
    }
    gameState.bullets.forEach(b => lastBullets.set(b.id, b));

    const activeDroneIds = new Set(gameState.drones.map(d => d.id));
    for (let [id, d] of lastDrones.entries()) {
        if (!activeDroneIds.has(id)) {
            const sx = d.x - camera.x; const sy = d.y - camera.y;
            if (sx > -100 && sx < canvas.width + 100 && sy > -100 && sy < canvas.height + 100) {
                dyingEntities.push({ ...d, renderX: d.x, renderY: d.y, deathType: 'drone', deathTime: Date.now() });
            }
            lastDrones.delete(id);
        }
    }
    gameState.drones.forEach(d => lastDrones.set(d.id, d));

    gameState.bullets.forEach(b => {
        ctx.fillStyle = getTeamColor(b.team); ctx.strokeStyle = darkenColor(ctx.fillStyle, 30); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x-camera.x, b.y-camera.y, b.r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    });

    gameState.drones.forEach(d => {
        const sx = d.x - camera.x; const sy = d.y - camera.y;
        if(sx < -50 || sx > canvas.width+50 || sy < -50 || sy > canvas.height+50) return;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(d.angle);
        ctx.lineWidth = 3; ctx.fillStyle = getTeamColor(d.team); ctx.strokeStyle = darkenColor(ctx.fillStyle, 30);
        ctx.beginPath(); ctx.lineTo(d.radius, 0); ctx.lineTo(-d.radius*0.8, d.radius*0.8); ctx.lineTo(-d.radius*0.8, -d.radius*0.8); ctx.closePath();
        ctx.fill(); ctx.stroke(); ctx.restore();
    });
    
    dyingEntities = dyingEntities.filter(e => Date.now() - e.deathTime < 190);
    dyingEntities.forEach(e => {
        let progress = (Date.now() - e.deathTime) / 190;
        let scale = 1 + (progress * 0.45); 
        let alpha = 1 - progress;

        const sx = e.renderX - camera.x;
        const sy = e.renderY - camera.y;
        if(sx < -150 || sx > canvas.width+150 || sy < -150 || sy > canvas.height+150) return;

        deathCtx.clearRect(0, 0, 300, 300);
        deathCtx.save();
        deathCtx.translate(150, 150);
        deathCtx.scale(scale, scale);
        
        if (e.deathType === 'bullet') {
            deathCtx.fillStyle = getTeamColor(e.team); 
            deathCtx.strokeStyle = darkenColor(deathCtx.fillStyle, 30); 
            deathCtx.lineWidth = 2;
            deathCtx.beginPath(); 
            deathCtx.arc(0, 0, e.r, 0, Math.PI*2); 
            deathCtx.fill(); 
            deathCtx.stroke();
        } else if (e.deathType === 'drone') {
            deathCtx.rotate(e.angle);
            deathCtx.lineWidth = 3; 
            deathCtx.fillStyle = getTeamColor(e.team); 
            deathCtx.strokeStyle = darkenColor(deathCtx.fillStyle, 30);
            deathCtx.beginPath(); 
            deathCtx.lineTo(e.radius, 0); 
            deathCtx.lineTo(-e.radius*0.8, e.radius*0.8); 
            deathCtx.lineTo(-e.radius*0.8, -e.radius*0.8); 
            deathCtx.closePath();
            deathCtx.fill(); 
            deathCtx.stroke();
        } else {
            drawEntityBody(deathCtx, e);
            
            if (['tank', 'ai'].includes(e.type)) {
                const isWhite = !e.nameColor || e.nameColor === "white" || e.nameColor === "#fff" || e.nameColor === "#ffffff";
                deathCtx.fillStyle = e.nameColor || "white";
                deathCtx.lineJoin = "round"; 
                deathCtx.strokeStyle = isWhite ? "black" : (darkenColor(e.nameColor, 50) || "black");
                deathCtx.lineWidth = 3;
                deathCtx.font = "bold 14px Ubuntu";
                deathCtx.textAlign = "center";
                
                deathCtx.strokeText(e.name, 0, -e.radius - 25);
                deathCtx.fillText(e.name, 0, -e.radius - 25);
                
                deathCtx.font = "11px Ubuntu";
                deathCtx.fillStyle = "white";
                deathCtx.strokeStyle = "black";
                const displayScore = formatScore(Math.floor(e.score || 0));
                deathCtx.strokeText(displayScore, 0, -e.radius - 12);
                deathCtx.fillText(displayScore, 0, -e.radius - 12);
                
                deathCtx.fillStyle = '#555'; 
                deathCtx.fillRect(-20, e.radius+10, 40, 6);
                let hpRatio = Math.max(0, e.hp / (e.maxHp || 100));
                if (hpRatio > 0) {
                    deathCtx.fillStyle = '#85e37d'; 
                    deathCtx.fillRect(-20, e.radius+10, 40*hpRatio, 6);
                }
            }
        }
        
        deathCtx.restore();

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(deathCanvas, sx - 150, sy - 150);
        ctx.restore();
    });

    [...gameState.entities].sort((a,b) => (a.type.includes('tank')||a.type==='ai'?1:-1)).forEach(en => {
        if(!en.inView){ return; }
        if (!renderEntities.has(en.id)) renderEntities.set(en.id, { ...en, renderX: en.x, renderY: en.y });
        let rPos = renderEntities.get(en.id);
        
        let rx = rPos.renderX; let ry = rPos.renderY;
        Object.assign(rPos, en);
        rPos.renderX = rx + (en.x - rx) * 0.35;
        rPos.renderY = ry + (en.y - ry) * 0.35;

        const sx = rPos.renderX - camera.x; const sy = rPos.renderY - camera.y;
        if(sx < -100 || sx > canvas.width+100 || sy < -100 || sy > canvas.height+100) return;

        if (['tank', 'ai'].includes(en.type)) {
            const isWhite = !en.nameColor || en.nameColor === "white" || en.nameColor === "#fff" || en.nameColor === "#ffffff";

            ctx.fillStyle = en.nameColor || "white";
            ctx.lineJoin = "round"; 
            ctx.strokeStyle = isWhite ? "black" : (darkenColor(en.nameColor, 50) || "black");
            ctx.lineWidth = 3;
            ctx.font = "bold 14px Ubuntu";
            ctx.textAlign = "center";
            
            ctx.strokeText(en.name, sx, sy - en.radius - 25);
            ctx.fillText(en.name, sx, sy - en.radius - 25);
            ctx.font = "11px Ubuntu";
            ctx.fillStyle = "white";
            ctx.strokeStyle = "black";
            const displayScore = formatScore(Math.floor(en.score));
            ctx.strokeText(displayScore, sx, sy - en.radius - 12);
            ctx.fillText(displayScore, sx, sy - en.radius - 12);
        }
        
        if(en.hp < en.maxHp) {
            ctx.fillStyle = '#555'; ctx.fillRect(sx-20, sy+en.radius+10, 40, 6);
            ctx.fillStyle = '#85e37d'; ctx.fillRect(sx-20, sy+en.radius+10, 40*(en.hp/en.maxHp), 6);
        }
        
        ctx.save();
        ctx.translate(sx, sy);
        drawEntityBody(ctx, en);
        ctx.restore();
    });

    const escapeHTML = (str) => {
        const p = document.createElement('p'); p.textContent = str; return p.innerHTML;
    };
    
    const updateLeaderboard = () => {
        const entries = gameState.entities
            .filter(e => ['tank', 'ai'].includes(e.type))
            .sort((a, b) => b.score - a.score)
            .slice(0, entryCount);

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
    updateLeaderboard();
    mCtx.clearRect(0,0,150,150);
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
        let s = en.id === myId ? 4 : 2;
        mCtx.fillRect((en.x/WORLD_SIZE)*150 - s/2, (en.y/WORLD_SIZE)*150 - s/2, s, s);
    });

    requestAnimationFrame(draw);
}

// Variables and State
let holdingM = false;

window.onkeydown = e => { 
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
    mouse.rx = mouse.x + camera.x; 
    mouse.ry = mouse.y + camera.y; 
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
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    // Calculate how much we need to zoom to match our reference width
    fovFactor = window.innerWidth / REFERENCE_WIDTH;

    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    
    if (!myId && camera) {
        // Center camera using the scaled dimensions
        camera.x = WORLD_SIZE/2 - (canvas.width / fovFactor) / 2;
        camera.y = WORLD_SIZE/2 - (canvas.height / fovFactor) / 2;
    }
}window.addEventListener('resize', resizeGame);
resizeGame();
