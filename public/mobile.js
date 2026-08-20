(function initMobileControls() {
    // 1. Detect coarse touch input (mobile screens)
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) return; 

    // 2. Inject CSS for Scalable Layout
    const style = document.createElement('style');
    style.innerHTML = `
        #mobile-controls {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            pointer-events: none; z-index: 1000;
        }
        /* vmin ensures joysticks scale proportionally without stretching */
        .joystick-base {
            position: absolute; bottom: 10vh; width: 22vmin; height: 22vmin;
            background: rgba(255, 255, 255, 0.15); border: 0.5vmin solid rgba(255, 255, 255, 0.3);
            border-radius: 50%; pointer-events: auto; touch-action: none;
        }
        #joy-left { left: 8vw; }
        #joy-right { right: 8vw; }
        
        .joystick-knob {
            position: absolute; top: 50%; left: 50%; width: 8vmin; height: 8vmin;
            background: rgba(255, 255, 255, 0.6); border-radius: 50%;
            transform: translate(-50%, -50%); pointer-events: none;
            transition: transform 0.05s linear;
        }

        #top-action-group {
            position: absolute; top: 3vmin; right: 3vmin;
            display: flex; flex-direction: column; gap: 2vmin;
            pointer-events: auto;
        }
        
        .mobile-btn {
            background: rgba(0, 0, 0, 0.5); color: white;
            border: 0.3vmin solid rgba(255, 255, 255, 0.3); border-radius: 1.5vmin;
            padding: 2.5vmin 4vmin; font-weight: bold; pointer-events: auto;
            user-select: none; font-family: 'Ubuntu', sans-serif;
            font-size: 3.5vmin; text-shadow: 1px 1px 0 #000;
            box-sizing: border-box; text-align: center;
        }
        .mobile-btn.active { background: rgba(255, 255, 255, 0.7); color: black; text-shadow: none; }

        /* Scaled up ability button placed above right joystick */
        #ability-btn { 
            position: absolute; bottom: calc(10vh + 26vmin); right: 8vw;
            width: 18vmin; height: 18vmin; padding: 0;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        
        #mobile-crosshair {
            position: fixed; width: 6vmin; height: 6vmin;
            border: 0.4vmin solid rgba(255, 0, 0, 0.7); border-radius: 50%;
            pointer-events: none; display: none; z-index: 999;
            transform: translate(-50%, -50%);
            background: radial-gradient(circle, rgba(255,0,0,0.4) 10%, transparent 20%);
        }
    `;
    document.head.appendChild(style);

    // 3. Inject HTML
    const container = document.createElement('div');
    container.id = 'mobile-controls';
    container.style.display = 'none';
    container.innerHTML = `
        <div id="joy-left" class="joystick-base"><div class="joystick-knob"></div></div>
        <div id="joy-right" class="joystick-base"><div class="joystick-knob"></div></div>
        
        <div id="top-action-group">
            <button id="btn-c" class="mobile-btn">C (Spin)</button>
            <button id="btn-e" class="mobile-btn">E (Fire)</button>
        </div>

        <button id="ability-btn" class="mobile-btn">
            <!-- Scaled up SVG -->
            <svg viewBox="0 0 24 24" style="width: 65%; height: 65%;" fill="currentColor">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
        </button>
    `;
    document.body.appendChild(container);
    
    const crosshair = document.createElement('div');
    crosshair.id = 'mobile-crosshair';
    document.body.appendChild(crosshair);

    // 4. Robust Display Logic
    setInterval(() => {
        const gameUi = document.getElementById('game-ui');
        const deathScreen = document.getElementById('death-screen');
        
        const isGameVisible = gameUi && window.getComputedStyle(gameUi).display !== 'none';
        const isDeathVisible = deathScreen && window.getComputedStyle(deathScreen).display !== 'none';

        container.style.display = (isGameVisible && !isDeathVisible) ? 'block' : 'none';
        if (!isGameVisible || isDeathVisible) crosshair.style.display = 'none';
    }, 200);

    // 5. Joystick Framework
    function setupJoy(baseId, callbacks) {
        const base = document.getElementById(baseId);
        const knob = base.querySelector('.joystick-knob');
        let activePointerId = null;
        let centerX = 0, centerY = 0;

        function updateKnob(dx, dy) {
            const maxRadius = base.clientWidth / 2;
            const dist = Math.min(Math.hypot(dx, dy), maxRadius);
            const angle = Math.atan2(dy, dx);
            knob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px))`;
        }

        const handleStart = (e) => {
            if (activePointerId !== null) return;
            activePointerId = e.pointerId;
            base.setPointerCapture(e.pointerId);
            const rect = base.getBoundingClientRect();
            centerX = rect.left + rect.width / 2;
            centerY = rect.top + rect.height / 2;
            if (callbacks.onStart) callbacks.onStart();
            
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            updateKnob(dx, dy);
            callbacks.onMove(dx, dy, Math.hypot(dx, dy), base.clientWidth / 2);
            e.preventDefault();
        };

        const handleMove = (e) => {
            if (e.pointerId !== activePointerId) return;
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            updateKnob(dx, dy);
            callbacks.onMove(dx, dy, Math.hypot(dx, dy), base.clientWidth / 2);
            e.preventDefault();
        };

        const handleEnd = (e) => {
            if (e.pointerId !== activePointerId) return;
            activePointerId = null;
            knob.style.transform = 'translate(-50%, -50%)';
            if (callbacks.onEnd) callbacks.onEnd();
        };

        base.addEventListener('pointerdown', handleStart);
        base.addEventListener('pointermove', handleMove);
        base.addEventListener('pointerup', handleEnd);
        base.addEventListener('pointercancel', handleEnd);
    }

    // Left Joystick: WASD
    setupJoy('joy-left', {
        onMove: (dx, dy, dist) => {
            if (typeof keys === 'undefined') return;
            if (dist < 16) { keys.w = keys.a = keys.s = keys.d = false; return; }
            let angle = Math.atan2(-dy, dx);
            if (angle < 0) angle += Math.PI * 2;
            const octant = Math.round(angle / (Math.PI / 4)) % 8;
            
            const dirs = [
                { d: true }, { w: true, d: true }, { w: true }, { w: true, a: true },
                { a: true }, { a: true, s: true }, { s: true }, { s: true, d: true }
            ][octant];
            
            keys.w = !!dirs.w; keys.a = !!dirs.a; keys.s = !!dirs.s; keys.d = !!dirs.d;
        },
        onEnd: () => { 
            if (typeof keys !== 'undefined') keys.w = keys.a = keys.s = keys.d = false; 
        }
    });

    // Right Joystick: Perfect Rectangular Crosshair Mapping
    setupJoy('joy-right', {
        onStart: () => { 
            if (typeof mobileAim !== 'undefined') { mobileAim.active = true; mobileAim.firing = true; }
            crosshair.style.display = 'block';
        },
        onMove: (dx, dy, dist, maxRadius) => {
            let angle = Math.atan2(dy, dx);
            
            // Set aiming angle directly (only if outside a tiny deadzone to prevent jitter)
            if (typeof mobileAim !== 'undefined' && dist >= 5) {
                mobileAim.angle = angle;
            }

            // Screen bounds
            const w = window.innerWidth / 2;
            const h = window.innerHeight / 2;
            
            // Raycast calculation to map the circular joystick exactly to the rectangular screen bounds
            let absCos = Math.abs(Math.cos(angle));
            let absSin = Math.abs(Math.sin(angle));
            let distToEdge = 0;
            
            if (absCos === 0) {
                distToEdge = h;
            } else if (absSin === 0) {
                distToEdge = w;
            } else if (w * absSin < h * absCos) {
                distToEdge = w / absCos;
            } else {
                distToEdge = h / absSin;
            }
            
            // Limit joystick drag visual dist to maxRadius to prevent overshooting math
            const clampedDist = Math.min(dist, maxRadius);
            const pushRatio = clampedDist / maxRadius;
            
            // Project exact coordinates onto the screen
            const screenX = w + (Math.cos(angle) * distToEdge * pushRatio);
            const screenY = h + (Math.sin(angle) * distToEdge * pushRatio);
            
            // Assign to crosshair element
            crosshair.style.left = `${screenX}px`;
            crosshair.style.top = `${screenY}px`;
            
            // Directly overwrite game's mouse object
            if (typeof mouse !== 'undefined') {
                mouse.x = screenX;
                mouse.y = screenY;
                mouse.clientX = screenX;
                mouse.clientY = screenY;
            }
        },
        onEnd: () => { 
            if (typeof mobileAim !== 'undefined') { mobileAim.active = false; mobileAim.firing = false; }
            crosshair.style.display = 'none';
            // Snap mouse back to center of screen when released (Crucial for drone control)
            if (typeof mouse !== 'undefined') {
                mouse.x = window.innerWidth / 2;
                mouse.y = window.innerHeight / 2;
                mouse.clientX = mouse.x;
                mouse.clientY = mouse.y;
            }
        }
    });

    // 6. Action Buttons
    const simulateKey = (keyName) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: keyName }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: keyName }));
    };

    document.getElementById('btn-e').addEventListener('pointerdown', (e) => {
        simulateKey('e'); 
        e.target.classList.toggle('active');
        e.preventDefault();
    });

    document.getElementById('btn-c').addEventListener('pointerdown', (e) => {
        simulateKey('c'); 
        e.target.classList.toggle('active');
        e.preventDefault();
    });

    // Ability Button
    const abilityBtn = document.getElementById('ability-btn');
    const pressAbility = (e) => { 
        if (typeof mouse !== 'undefined') { mouse.repel = true; mouse.rightDown = true; }
        abilityBtn.classList.add('active'); 
        e.preventDefault(); 
    };
    const releaseAbility = (e) => { 
        if (typeof mouse !== 'undefined') { mouse.repel = false; mouse.rightDown = false; }
        abilityBtn.classList.remove('active'); 
        e.preventDefault(); 
    };
    
    abilityBtn.addEventListener('pointerdown', pressAbility);
    abilityBtn.addEventListener('pointerup', releaseAbility);
    abilityBtn.addEventListener('pointercancel', releaseAbility);
    abilityBtn.addEventListener('pointerleave', releaseAbility);
})();
