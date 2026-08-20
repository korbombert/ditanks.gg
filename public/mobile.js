(function initMobileControls() {
    // 1. Detect coarse touch input (mobile screens)
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) return; 

    // 2. Inject CSS for New Layout
    const style = document.createElement('style');
    style.innerHTML = `
        #mobile-controls {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            pointer-events: none; z-index: 1000;
        }
        .joystick-base {
            position: absolute; bottom: 12vh; width: 120px; height: 120px;
            background: rgba(255, 255, 255, 0.15); border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%; pointer-events: auto; touch-action: none;
        }
        /* Shifted inwards using viewport units for responsive centering */
        #joy-left { left: 10vw; }
        #joy-right { right: 10vw; }
        
        .joystick-knob {
            position: absolute; top: 50%; left: 50%; width: 50px; height: 50px;
            background: rgba(255, 255, 255, 0.6); border-radius: 50%;
            transform: translate(-50%, -50%); pointer-events: none;
            transition: transform 0.05s linear;
        }

        /* Top-Right Container for C & E */
        #top-action-group {
            position: absolute; top: 20px; right: 20px;
            display: flex; flex-direction: column; gap: 10px;
            pointer-events: auto;
        }
        
        .mobile-btn {
            background: rgba(0, 0, 0, 0.5); color: white;
            border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 6px;
            padding: 10px 16px; font-weight: bold; pointer-events: auto;
            user-select: none; font-family: 'Ubuntu', sans-serif;
            font-size: 13px; text-shadow: 1px 1px 0 #000;
            box-sizing: border-box; text-align: center;
        }
        .mobile-btn.active { background: rgba(255, 255, 255, 0.7); color: black; text-shadow: none; }

        /* Ability Button positioned directly above right joystick */
        #ability-btn { 
            position: absolute; bottom: calc(12vh + 140px); right: 10vw;
            width: 60px; height: 60px; padding: 0;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        
        /* Crosshair UI */
        #mobile-crosshair {
            position: fixed; width: 30px; height: 30px;
            border: 2px solid rgba(255, 0, 0, 0.7); border-radius: 50%;
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
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
        </button>
    `;
    document.body.appendChild(container);
    
    // Inject crosshair outside the hidden container so it maps properly to the screen
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
            // Apply -50% translation baseline to keep knob perfectly centered
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
            callbacks.onMove(dx, dy, Math.hypot(dx, dy));
            e.preventDefault();
        };

        const handleMove = (e) => {
            if (e.pointerId !== activePointerId) return;
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            updateKnob(dx, dy);
            callbacks.onMove(dx, dy, Math.hypot(dx, dy));
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

    // Right Joystick: Dynamic Crosshair Aiming
    setupJoy('joy-right', {
        onStart: () => { 
            if (typeof mobileAim !== 'undefined') { mobileAim.active = true; mobileAim.firing = true; }
            crosshair.style.display = 'block';
        },
        onMove: (dx, dy, dist) => {
            if (typeof mobileAim === 'undefined' || dist < 10) return;
            
            // Basic angle calculation for your global object
            mobileAim.angle = Math.atan2(dy, dx);

            // Crosshair scaling logic: Maps joystick radius (60px) to screen boundaries
            const maxJoyRadius = 60; 
            const maxScreenRadius = Math.min(window.innerWidth, window.innerHeight) / 2;
            const scaleFactor = maxScreenRadius / maxJoyRadius;
            
            // Calculate global screen coordinates relative to center
            const screenX = (window.innerWidth / 2) + (dx * scaleFactor);
            const screenY = (window.innerHeight / 2) + (dy * scaleFactor);
            
            // Update UI crosshair
            crosshair.style.left = `${screenX}px`;
            crosshair.style.top = `${screenY}px`;
            
            // Injecting aiming coordinates into the global mouse object (if your game supports it)
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
