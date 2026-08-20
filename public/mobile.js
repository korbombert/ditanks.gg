(function initMobileControls() {
    // 1. Detect if the user is on a mobile/touch device
    const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return; // Exit if playing on PC

    // 2. Inject CSS for Joysticks and Buttons
    const style = document.createElement('style');
    style.innerHTML = `
        #mobile-controls {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            pointer-events: none; z-index: 1000;
        }
        .joystick-base {
            position: absolute; bottom: 40px; width: 120px; height: 120px;
            background: rgba(255, 255, 255, 0.15); border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%; pointer-events: auto; touch-action: none;
        }
        #joy-left { left: 40px; }
        #joy-right { right: 40px; }
        .joystick-knob {
            position: absolute; top: 50%; left: 50%; width: 50px; height: 50px;
            background: rgba(255, 255, 255, 0.5); border-radius: 50%;
            margin-top: -25px; margin-left: -25px; pointer-events: none;
            transition: transform 0.05s linear;
        }
        .mobile-btn {
            position: absolute; background: rgba(0, 0, 0, 0.4); color: white;
            border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 8px;
            padding: 12px; font-weight: bold; pointer-events: auto;
            user-select: none; font-family: 'Ubuntu', sans-serif;
            font-size: 14px; text-shadow: 1px 1px 0 #000;
        }
        #btn-e { bottom: 180px; right: 40px; }
        #btn-c { bottom: 240px; right: 40px; }
        #ability-btn { 
            bottom: 40px; right: 180px; width: 70px; height: 70px; 
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        .mobile-btn.active { background: rgba(255, 255, 255, 0.5); color: black; text-shadow: none; }
    `;
    document.head.appendChild(style);

    // 3. Inject HTML Container
    const container = document.createElement('div');
    container.id = 'mobile-controls';
    container.style.display = 'none'; // Hidden by default on the menu
    container.innerHTML = `
        <div id="joy-left" class="joystick-base"><div class="joystick-knob"></div></div>
        <div id="joy-right" class="joystick-base"><div class="joystick-knob"></div></div>
        <button id="btn-e" class="mobile-btn">E (Auto-Fire)</button>
        <button id="btn-c" class="mobile-btn">C (Auto-Spin)</button>
        <div id="ability-btn" class="mobile-btn">Ability</div>
    `;
    document.body.appendChild(container);

    // 4. Visibility Logic (Disappear on Menu/Death Screen)
    // We poll the display properties of the existing UI components to toggle our controls.
    setInterval(() => {
        const gameUi = document.getElementById('game-ui');
        const deathScreen = document.getElementById('death-screen');
        
        // Show controls ONLY if game-ui is active AND death-screen is hidden
        if (gameUi && gameUi.style.display === 'block' && 
            deathScreen && deathScreen.style.display !== 'flex') {
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }
    }, 200);

    // 5. Joystick Touch Implementation
    function setupJoy(baseId, callbacks) {
        const base = document.getElementById(baseId);
        const knob = base.querySelector('.joystick-knob');
        let activePointerId = null;
        let centerX = 0, centerY = 0;

        function updateKnob(dx, dy) {
            const maxRadius = base.clientWidth / 2;
            const dist = Math.min(Math.hypot(dx, dy), maxRadius);
            const angle = Math.atan2(dy, dx);
            knob.style.transform = \`translate(\${Math.cos(angle) * dist}px, \${Math.sin(angle) * dist}px)\`;
        }

        base.addEventListener('pointerdown', e => {
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
        });

        base.addEventListener('pointermove', e => {
            if (e.pointerId !== activePointerId) return;
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            updateKnob(dx, dy);
            callbacks.onMove(dx, dy, Math.hypot(dx, dy));
            e.preventDefault();
        });

        function release(e) {
            if (e.pointerId !== activePointerId) return;
            activePointerId = null;
            knob.style.transform = 'translate(0px, 0px)';
            if (callbacks.onEnd) callbacks.onEnd();
        }

        base.addEventListener('pointerup', release);
        base.addEventListener('pointercancel', release);
    }

    // Left Joystick: Translates to global WASD keys
    setupJoy('joy-left', {
        onMove: (dx, dy, dist) => {
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
        onEnd: () => { keys.w = keys.a = keys.s = keys.d = false; }
    });

    // Right Joystick: Translates to global mobileAim variables
    setupJoy('joy-right', {
        onStart: () => { mobileAim.active = true; mobileAim.firing = true; },
        onMove: (dx, dy, dist) => {
            if (dist < 10) return; // Deadzone
            mobileAim.angle = Math.atan2(dy, dx);
        },
        onEnd: () => { mobileAim.active = false; mobileAim.firing = false; }
    });

    // 6. Action Button Implementation
    
    // Simulates a keyboard event so it triggers the window.onkeydown logic in your main script
    const simulateKey = (keyName) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: keyName }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: keyName }));
    };

    const btnE = document.getElementById('btn-e');
    btnE.addEventListener('pointerdown', (e) => {
        simulateKey('e'); 
        btnE.classList.toggle('active');
        e.preventDefault();
    });

    const btnC = document.getElementById('btn-c');
    btnC.addEventListener('pointerdown', (e) => {
        simulateKey('c'); 
        btnC.classList.toggle('active');
        e.preventDefault();
    });

    const abilityBtn = document.getElementById('ability-btn');
    const pressAbility = (e) => { 
        mouse.repel = true; 
        mouse.rightDown = true; 
        abilityBtn.classList.add('active'); 
        e.preventDefault(); 
    };
    const releaseAbility = (e) => { 
        mouse.repel = false; 
        mouse.rightDown = false; 
        abilityBtn.classList.remove('active'); 
        e.preventDefault(); 
    };
    
    // Ability hooks
    abilityBtn.addEventListener('pointerdown', pressAbility);
    abilityBtn.addEventListener('pointerup', releaseAbility);
    abilityBtn.addEventListener('pointercancel', releaseAbility);
    abilityBtn.addEventListener('pointerleave', releaseAbility);

})();
