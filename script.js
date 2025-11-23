const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Game Constants
const ASPECT_RATIO = 1.6; // Maintain proportions
let CANVAS_WIDTH = window.innerWidth;
let CANVAS_HEIGHT = window.innerHeight;
const FIELD_WIDTH = 800;
const FIELD_HEIGHT = 500;
let FIELD_OFFSET_X = 0;
let FIELD_OFFSET_Y = 0;
const GOAL_HEIGHT = 150; // Portería más grande
let renderScale = 1;

const GOAL_DEPTH = 40;
const PLAYER_RADIUS = 15;
const BALL_RADIUS = 8;
const GOAL_WIDTH = 10; // Used for post thickness now
const FRICTION = 0.98;
const PLAYER_SPEED = 2;
const KICK_POWER = 8;
const AI_SPEED = 2.0;
const KICK_REACH = 12; // Increased reach for easier hitting

const PEER_CONFIG = {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    path: '/' // Force public PeerServer to avoid file:// origin issues
};

// Netcode / interpolation tuning
const NETWORK_STATE_INTERVAL = 70; // ~14 updates per second
const NETWORK_INPUT_INTERVAL = 70;
const INTERPOLATION_DELAY_MS = 120;
const MAX_STATE_BUFFER = 30;

const stateBuffer = [];

// ------------------ SETTINGS PERSISTENCE ------------------
const SETTINGS_KEY = 'furbo2d_settings';
let userSettings = {
    username: '',
    favoriteNumber: null,
    showTouchControls: true // Activado por defecto
};

function loadSettings() {
    let raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
        // Fallback cookie
        const cookieMatch = document.cookie.match(/furbo2d_settings=([^;]+)/);
        if (cookieMatch) raw = decodeURIComponent(cookieMatch[1]);
    }
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            // Si la configuración almacenada no tiene la clave, mantenemos true por defecto
            userSettings = { ...userSettings, ...parsed };
            if (parsed.showTouchControls === undefined) {
                userSettings.showTouchControls = true;
            }
        } catch (e) { /* ignore parse errors */ }
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings));
    document.cookie = 'furbo2d_settings=' + encodeURIComponent(JSON.stringify(userSettings)) + ';path=/;max-age=31536000';
}

function applySettingsToUI() {
    const usernameInput = document.getElementById('setting-username');
    const favNumberInput = document.getElementById('setting-fav-number');
    const showTouchCheckbox = document.getElementById('setting-show-touch');
    if (!usernameInput) return; // UI not created yet
    usernameInput.value = userSettings.username || '';
    favNumberInput.value = userSettings.favoriteNumber !== null ? userSettings.favoriteNumber : '';
    showTouchCheckbox.checked = !!userSettings.showTouchControls;
}

function applySettingsGameplayHooks() {
    // Touch controls preference overrides auto-detection
    if (userSettings.showTouchControls) {
        toggleMobileControls(true);
    } else {
        const controls = document.getElementById('mobile-controls');
        if (controls) controls.style.display = 'none';
        isMobile = false;
    }
}

function openSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    const menu = document.getElementById('menu-overlay');
    if (overlay && menu) {
        menu.style.display = 'none';
        overlay.style.display = 'flex';
        applySettingsToUI();
    }
}

function closeSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    const menu = document.getElementById('menu-overlay');
    const err = document.getElementById('settings-error');
    if (err) err.style.display = 'none';
    if (overlay && menu) {
        overlay.style.display = 'none';
        menu.style.display = 'flex';
    }
}

function validateAndSaveSettings() {
    const usernameInput = document.getElementById('setting-username');
    const favNumberInput = document.getElementById('setting-fav-number');
    const showTouchCheckbox = document.getElementById('setting-show-touch');
    const errorBox = document.getElementById('settings-error');
    if (!usernameInput || !favNumberInput || !showTouchCheckbox) return;

    const username = (usernameInput.value || '').trim();
    if (username.length > 16) {
        errorBox.innerText = 'El nombre supera 16 caracteres.';
        errorBox.style.display = 'block';
        return;
    }

    let favNumberRaw = favNumberInput.value.trim();
    let favNumber = favNumberRaw === '' ? null : parseInt(favNumberRaw, 10);
    if (favNumber !== null && (isNaN(favNumber) || favNumber < 1 || favNumber > 25)) {
        errorBox.innerText = 'Número favorito debe estar entre 1 y 25.';
        errorBox.style.display = 'block';
        return;
    }

    userSettings.username = username;
    userSettings.favoriteNumber = favNumber;
    userSettings.showTouchControls = !!showTouchCheckbox.checked;
    saveSettings();
    applySettingsGameplayHooks();
    closeSettingsPanel();
}

// Initial load
loadSettings();
document.addEventListener('DOMContentLoaded', () => {
    applySettingsToUI();
    applySettingsGameplayHooks();
    const btnGear = document.getElementById('btn-open-settings');
    const btnSave = document.getElementById('btn-save-settings');
    const btnClose = document.getElementById('btn-close-settings');
    if (btnGear) btnGear.addEventListener('click', openSettingsPanel);
    if (btnSave) btnSave.addEventListener('click', validateAndSaveSettings);
    if (btnClose) btnClose.addEventListener('click', closeSettingsPanel);
});

const quantize = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

const hashString = (value) => {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
};

const derivePlayerNumber = (ownerId = 'player', team = 'neutral', index = 0) => {
    const seed = `${ownerId}-${team}-${index}`;
    return (hashString(seed) % 25) + 1;
};

const deterministicIndex = (playersList, salt) => {
    if (!playersList.length) return -1;
    const seed = `${salt}-${playersList.map(p => p.ownerId || p.id || 'player').join('|')}`;
    return hashString(seed) % playersList.length;
};

const serializeMotion = (entity) => {
    const vx = entity.vx || 0;
    const vy = entity.vy || 0;
    const speed = Math.hypot(vx, vy);
    return {
        x: quantize(entity.x, 2),
        y: quantize(entity.y, 2),
        dirX: speed > 0 ? quantize(vx / speed, 3) : 0,
        dirY: speed > 0 ? quantize(vy / speed, 3) : 0,
        speed: quantize(speed, 3)
    };
};

const serializePlayerState = (player) => ({
    id: player.ownerId || player.id || `player-${player.team}-${player.number}`,
    team: player.team,
    number: player.number,
    role: player.role,
    ...serializeMotion(player)
});

const serializeBallState = () => serializeMotion(ball);

function setControllerMode(active) {
    if (controllerOnlyMode === active) {
        document.body.classList.toggle('controller-mode', active);
        if (controllerOverlay) controllerOverlay.style.display = active ? 'flex' : 'none';
        if (btnToggleControls) btnToggleControls.style.display = active ? 'none' : '';
        return;
    }

    controllerOnlyMode = active;
    document.body.classList.toggle('controller-mode', active);

    if (controllerOverlay) {
        controllerOverlay.style.display = active ? 'flex' : 'none';
    }

    if (btnToggleControls) {
        btnToggleControls.style.display = active ? 'none' : '';
    }

    const mobileControls = document.getElementById('mobile-controls');
    if (active) {
        if (mobileControls) {
            previousMobileControlsDisplay = mobileControls.style.display;
            mobileControls.style.display = 'flex';
        }
        previousIsMobileState = isMobile;
        isMobile = true;
    } else {
        if (mobileControls && previousMobileControlsDisplay !== null) {
            mobileControls.style.display = previousMobileControlsDisplay;
        }
        if (previousIsMobileState !== null) {
            isMobile = previousIsMobileState;
        }
        previousMobileControlsDisplay = null;
        previousIsMobileState = null;
    }
}

function handleHudUpdate(data) {
    if (data.score) {
        scoreRed = data.score.red;
        scoreBlue = data.score.blue;
    }
    if (typeof data.timeLeft === 'number') {
        timeLeft = data.timeLeft;
    }
    updateScoreboard();
    updateTimerDisplay();
}

function enqueueServerState(snapshot) {
    const arrival = performance.now();
    stateBuffer.push({ timestamp: arrival, state: snapshot });
    if (stateBuffer.length > MAX_STATE_BUFFER) stateBuffer.shift();

    if (snapshot.score) {
        scoreRed = snapshot.score.red;
        scoreBlue = snapshot.score.blue;
        updateScoreboard();
    }

    if (typeof snapshot.timeLeft === 'number') {
        timeLeft = snapshot.timeLeft;
        updateTimerDisplay();
    }
}

function applyInterpolatedState() {
    if (!stateBuffer.length) return;
    const renderTimestamp = performance.now() - INTERPOLATION_DELAY_MS;

    while (stateBuffer.length >= 2 && stateBuffer[1].timestamp <= renderTimestamp) {
        stateBuffer.shift();
    }

    const current = stateBuffer[0];
    const next = stateBuffer[1];

    if (next) {
        const span = Math.max(next.timestamp - current.timestamp, 1);
        const alpha = Math.min(Math.max((renderTimestamp - current.timestamp) / span, 0), 1);
        blendSnapshots(current.state, next.state, alpha);
    } else {
        blendSnapshots(current.state, current.state, 0);
    }
}

function blendSnapshots(fromState, toState, alpha) {
    const lerp = (a, b, t) => a + (b - a) * t;

    const blendMotion = (from, to, entity) => {
        const targetX = lerp(from.x, to.x, alpha);
        const targetY = lerp(from.y, to.y, alpha);
        const dirX = lerp(from.dirX, to.dirX, alpha);
        const dirY = lerp(from.dirY, to.dirY, alpha);
        const speed = lerp(from.speed, to.speed, alpha);

        entity.x = targetX;
        entity.y = targetY;
        entity.vx = dirX * speed;
        entity.vy = dirY * speed;
    };

    blendMotion(fromState.ball, toState.ball, ball);

    const playerMap = new Map(players.map(p => [p.ownerId || p.id || `${p.team}-${p.number}`, p]));

    toState.players.forEach((toPlayer, index) => {
        const fromPlayer = fromState.players.find(p => p.id === toPlayer.id) || toPlayer;
        let entity = playerMap.get(toPlayer.id);
        if (!entity) {
            entity = new Player(
                toPlayer.x,
                toPlayer.y,
                toPlayer.team,
                false,
                derivePlayerNumber(toPlayer.id, toPlayer.team, index),
                'field',
                toPlayer.id
            );
            players.push(entity);
        }
        blendMotion(fromPlayer, toPlayer, entity);
        entity.team = toPlayer.team || entity.team;
        if (typeof toPlayer.number === 'number') entity.number = toPlayer.number;
        if (toPlayer.role) entity.role = toPlayer.role;
    });
}

// Network Optimization
let lastNetworkUpdate = 0;
let lastInputUpdate = 0;

// Game State
let scoreRed = 0;
let scoreBlue = 0;
let gameDuration = 180; // seconds (default 3 min)
let timeLeft = 0;
let isGameOver = false;

// Input State
const keys = {
    w: false,
    a: false,
    s: false,
    d: false,
    space: false,
    joystick: { x: 0, y: 0, active: false }
};
const inputBuffer = {
    space: false
};

const controllerOverlay = document.getElementById('controller-overlay');
const controllerScoreDisplay = document.getElementById('controller-score');
const controllerTimeDisplay = document.getElementById('controller-time');
const btnToggleControls = document.getElementById('btn-toggle-controls');

let hostDisplayOnly = false;
let controllerOnlyMode = false;
let previousMobileControlsDisplay = null;
let previousIsMobileState = null;

// Entities
class Ball {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = FIELD_WIDTH / 2;
        this.y = FIELD_HEIGHT / 2;
        this.vx = 0;
        this.vy = 0;
    }

    update(deltaTime) {
        if (gameMode === 'client') return;

        this.x += this.vx * deltaTime;
        this.y += this.vy * deltaTime;

        // Friction
        this.vx *= Math.pow(FRICTION, deltaTime);
        this.vy *= Math.pow(FRICTION, deltaTime);

        // Wall collisions
        if (this.y - BALL_RADIUS < 0) {
            this.y = BALL_RADIUS;
            this.vy *= -0.8;
        } else if (this.y + BALL_RADIUS > FIELD_HEIGHT) {
            this.y = FIELD_HEIGHT - BALL_RADIUS;
            this.vy *= -0.8;
        }

        // Goal Detection & X Collisions
        const goalTop = (FIELD_HEIGHT - GOAL_HEIGHT) / 2;
        const goalBottom = (FIELD_HEIGHT + GOAL_HEIGHT) / 2;

        // Left Side
        if (this.x - BALL_RADIUS < 0) {
            if (this.y > goalTop && this.y < goalBottom) {
                // Inside Goal Area
                if (this.x < -BALL_RADIUS) {
                    // GOAL! (Fully crossed line)
                    scoreBlue++;
                    updateScoreboard();
                    triggerGoal('blue');
                    return;
                }
                // Bounce off back of net (optional, but good for realism if it doesn't trigger goal immediately)
                if (this.x - BALL_RADIUS < -GOAL_DEPTH) {
                     this.x = -GOAL_DEPTH + BALL_RADIUS;
                     this.vx *= -0.8;
                }
                // Constrain Y inside goal (net top/bottom)
                if (this.y - BALL_RADIUS < goalTop) {
                    this.y = goalTop + BALL_RADIUS;
                    this.vy *= -0.8;
                } else if (this.y + BALL_RADIUS > goalBottom) {
                    this.y = goalBottom - BALL_RADIUS;
                    this.vy *= -0.8;
                }
            } else {
                // Wall Bounce
                this.x = BALL_RADIUS;
                this.vx *= -0.8;
            }
        } 
        // Right Side
        else if (this.x + BALL_RADIUS > FIELD_WIDTH) {
            if (this.y > goalTop && this.y < goalBottom) {
                // Inside Goal Area
                if (this.x > FIELD_WIDTH + BALL_RADIUS) {
                    // GOAL!
                    scoreRed++;
                    updateScoreboard();
                    triggerGoal('red');
                    return;
                }
                // Bounce off back of net
                if (this.x + BALL_RADIUS > FIELD_WIDTH + GOAL_DEPTH) {
                     this.x = FIELD_WIDTH + GOAL_DEPTH - BALL_RADIUS;
                     this.vx *= -0.8;
                }
                // Constrain Y inside goal
                if (this.y - BALL_RADIUS < goalTop) {
                    this.y = goalTop + BALL_RADIUS;
                    this.vy *= -0.8;
                } else if (this.y + BALL_RADIUS > goalBottom) {
                    this.y = goalBottom - BALL_RADIUS;
                    this.vy *= -0.8;
                }
            } else {
                // Wall Bounce
                this.x = FIELD_WIDTH - BALL_RADIUS;
                this.vx *= -0.8;
            }
        }
    }

    draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, BALL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.fill();
        ctx.strokeStyle = 'black';
        ctx.stroke();
        ctx.closePath();
    }
}

class Player {
    constructor(x, y, team, isHuman = false, number = null, role = 'field', ownerId = null) {
        this.startX = x;
        this.startY = y;
        this.x = x;
        this.y = y;
        this.team = team; // 'red' or 'blue'
        this.isHuman = isHuman;
        this.number = number !== null ? number : derivePlayerNumber(ownerId || `${team}-player`, team);
        this.role = role; // 'goalie', 'defender', 'attacker', 'field'
        this.ownerId = ownerId; // 'host', 'bot', or peerId
        this.vx = 0;
        this.vy = 0;
        this.kickCooldown = 0;

        // AI State
        this.aiTimer = 0;
        this.targetX = x;
        this.targetY = y;
        this.isKicking = false;
        this.kickVisualTimer = 0;
        this.shockwaveTimer = 0;
        this.wasKicking = false;
        
        // New AI State
        this.wantsToKick = false;
        this.kickTargetX = 0;
        this.kickTargetY = 0;
    }

    reset() {
        this.x = this.startX;
        this.y = this.startY;
        this.vx = 0;
        this.vy = 0;
    }

    update(ball, allPlayers, deltaTime) {
        if (gameMode === 'client') return; 

        if (this.isHuman) {
            // Input Handling based on Owner
            let inputKeys = { w: false, a: false, s: false, d: false, space: false, joystick: { active: false } };
            
            if (this.ownerId === 'host') {
                inputKeys = keys;
                // Apply input buffer for local controls
                if (inputKeys === keys) {
                    inputKeys = { ...keys, space: keys.space || inputBuffer.space };
                }
            } else if (remoteInputs[this.ownerId]) {
                inputKeys = remoteInputs[this.ownerId];
            }

            this.handleInput(inputKeys);
            
            // Visual Kick State
            if (inputKeys.space && !this.wasKicking) {
                this.shockwaveTimer = 20;
            }
            this.wasKicking = inputKeys.space;
            this.isKicking = inputKeys.space;

            // Kicking Logic for Human
            const dx = ball.x - this.x;
            const dy = ball.y - this.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const kickAreaRadius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH;
            const canKickDist = kickAreaRadius + BALL_RADIUS;

            if (inputKeys.space && this.kickCooldown <= 0 && distance < canKickDist) {
                const angle = Math.atan2(dy, dx);
                let currentKickPower = (this.role === 'goalie') ? KICK_POWER * 1.25 : KICK_POWER;

                // Distance-based power modulation
                // Closer = Stronger, Farther = Weaker
                const minDist = PLAYER_RADIUS + BALL_RADIUS;
                const maxDist = canKickDist;
                let powerFactor = 1.0;
                
                if (distance > minDist) {
                    // Linear falloff from 1.0 to 0.2
                    powerFactor = 1.0 - ((distance - minDist) / (maxDist - minDist)) * 0.8;
                }
                powerFactor = Math.max(0.2, Math.min(1.0, powerFactor));
                
                currentKickPower *= powerFactor;

                ball.vx = Math.cos(angle) * currentKickPower;
                ball.vy = Math.sin(angle) * currentKickPower;
                this.kickCooldown = 10; // 10 frames at 60 FPS 
            }

        } else {
            this.aiBehavior(ball, allPlayers, deltaTime);
            if (this.kickVisualTimer > 0) {
                this.isKicking = true;
                this.kickVisualTimer -= deltaTime;
            } else {
                this.isKicking = false;
            }
        }

        this.x += this.vx * deltaTime;
        this.y += this.vy * deltaTime;

        // Boundaries
        const MARGIN = 15; // Allow players to step slightly out
        const goalTop = (FIELD_HEIGHT - GOAL_HEIGHT) / 2;
        const goalBottom = (FIELD_HEIGHT + GOAL_HEIGHT) / 2;

        // 1. Global Field Limits (Outer bounds)
        if (this.y < -MARGIN) this.y = -MARGIN;
        if (this.y > FIELD_HEIGHT + MARGIN) this.y = FIELD_HEIGHT + MARGIN;
        
        // X limits depend on where we are
        let minX = -MARGIN;
        let maxX = FIELD_WIDTH + MARGIN;

        // Role-based limits
        if (this.role === 'goalie') {
            minX = -GOAL_DEPTH + PLAYER_RADIUS;
            maxX = FIELD_WIDTH + GOAL_DEPTH - PLAYER_RADIUS;
        } else {
            // Default limits for field players
            minX = -MARGIN;
            maxX = FIELD_WIDTH + MARGIN;

            // Explicit Goal Barriers (The "Mouth" of the goal)
            // Left Goal Barrier
            if (this.x < PLAYER_RADIUS + 5) { 
                // Top Post Area
                if (this.y <= goalTop) {
                    const dist = Math.hypot(this.x, this.y - goalTop);
                    if (dist < PLAYER_RADIUS) {
                        const angle = Math.atan2(this.y - goalTop, this.x);
                        this.x = Math.cos(angle) * PLAYER_RADIUS;
                        this.y = goalTop + Math.sin(angle) * PLAYER_RADIUS;
                    }
                }
                // Bottom Post Area
                else if (this.y >= goalBottom) {
                    const dist = Math.hypot(this.x, this.y - goalBottom);
                    if (dist < PLAYER_RADIUS) {
                        const angle = Math.atan2(this.y - goalBottom, this.x);
                        this.x = Math.cos(angle) * PLAYER_RADIUS;
                        this.y = goalBottom + Math.sin(angle) * PLAYER_RADIUS;
                    }
                }
                // Inside Goal Mouth
                else {
                    if (this.x < PLAYER_RADIUS) this.x = PLAYER_RADIUS;
                }
            }

            // Right Goal Barrier
            if (this.x > FIELD_WIDTH - PLAYER_RADIUS - 5) {
                // Top Post Area
                if (this.y <= goalTop) {
                    const dist = Math.hypot(this.x - FIELD_WIDTH, this.y - goalTop);
                    if (dist < PLAYER_RADIUS) {
                        const angle = Math.atan2(this.y - goalTop, this.x - FIELD_WIDTH);
                        this.x = FIELD_WIDTH + Math.cos(angle) * PLAYER_RADIUS;
                        this.y = goalTop + Math.sin(angle) * PLAYER_RADIUS;
                    }
                }
                // Bottom Post Area
                else if (this.y >= goalBottom) {
                    const dist = Math.hypot(this.x - FIELD_WIDTH, this.y - goalBottom);
                    if (dist < PLAYER_RADIUS) {
                        const angle = Math.atan2(this.y - goalBottom, this.x - FIELD_WIDTH);
                        this.x = FIELD_WIDTH + Math.cos(angle) * PLAYER_RADIUS;
                        this.y = goalBottom + Math.sin(angle) * PLAYER_RADIUS;
                    }
                }
                // Inside Goal Mouth
                else {
                    if (this.x > FIELD_WIDTH - PLAYER_RADIUS) this.x = FIELD_WIDTH - PLAYER_RADIUS;
                }
            }
        }

        if (this.x < minX) this.x = minX;
        if (this.x > maxX) this.x = maxX;

        // 2. Net Side Collisions (The "Walls" of the goal)
        // Left Goal
        if (this.x < 0) {
            // Top Net Wall
            if (Math.abs(this.y - goalTop) < PLAYER_RADIUS) {
                if (this.y < goalTop) this.y = goalTop - PLAYER_RADIUS; // Push Up (Outside)
                else this.y = goalTop + PLAYER_RADIUS; // Push Down (Inside)
            }
            // Bottom Net Wall
            if (Math.abs(this.y - goalBottom) < PLAYER_RADIUS) {
                if (this.y > goalBottom) this.y = goalBottom + PLAYER_RADIUS; // Push Down (Outside)
                else this.y = goalBottom - PLAYER_RADIUS; // Push Up (Inside)
            }
        }
        // Right Goal
        if (this.x > FIELD_WIDTH) {
            // Top Net Wall
            if (Math.abs(this.y - goalTop) < PLAYER_RADIUS) {
                if (this.y < goalTop) this.y = goalTop - PLAYER_RADIUS;
                else this.y = goalTop + PLAYER_RADIUS;
            }
            // Bottom Net Wall
            if (Math.abs(this.y - goalBottom) < PLAYER_RADIUS) {
                if (this.y > goalBottom) this.y = goalBottom + PLAYER_RADIUS;
                else this.y = goalBottom - PLAYER_RADIUS;
            }
        }

        // 3. Void Check (Prevent walking behind goal line outside the net)
        if (this.x < -MARGIN) {
            if (this.y < goalTop || this.y > goalBottom) this.x = -MARGIN;
        }
        if (this.x > FIELD_WIDTH + MARGIN) {
            if (this.y < goalTop || this.y > goalBottom) this.x = FIELD_WIDTH + MARGIN;
        }

        // Kicking
        // Allow kicking if any part of the ball overlaps with the kick reach area
        // Visual Area Radius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH
        // Interaction Distance = Visual Area Radius + BALL_RADIUS (so edges touch)
        // Logic moved inside isHuman block for humans, and aiBehavior for bots (partially)
        // But we need collision logic here for physics
        
        // Ball interaction
        const dx = ball.x - this.x;
        const dy = ball.y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Collision (Physics)
        if (distance < PLAYER_RADIUS + BALL_RADIUS) {
            // Push ball away slightly to prevent sticking
            const angle = Math.atan2(dy, dx);
            const pushDist = (PLAYER_RADIUS + BALL_RADIUS - distance) + 1;
            ball.x += Math.cos(angle) * pushDist;
            ball.y += Math.sin(angle) * pushDist;

            // Bounce ball away
            // Calculate impact force based on player speed and existing ball speed
            const playerSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            
            // Dribbling logic:
            // If player is moving, impart velocity slightly higher than player speed.
            // If player is stationary (or very slow), act as a wall (bounce).
            
            let impactForce;
            if (playerSpeed > 0.1) {
                // Player is moving: Push the ball
                // Force is proportional to player speed, allowing for close dribbling
                impactForce = playerSpeed * 1.1; 
            } else {
                // Player is stationary: Bounce the ball
                // Preserve some of the ball's existing speed but dampen it
                const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
                impactForce = ballSpeed * 0.5; 
            }
            
            // Ensure a tiny minimum movement to avoid sticking, but much less than before
            impactForce = Math.max(impactForce, 0.1);

            ball.vx = Math.cos(angle) * impactForce;
            ball.vy = Math.sin(angle) * impactForce;
        }

        // AI Kick Logic (Human kick logic is above in update)
        if (!this.isHuman) {
            const kickAreaRadius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH;
            const canKickDist = kickAreaRadius + BALL_RADIUS;
            
            // Only kick if AI wants to AND is close enough
            if (this.wantsToKick && distance < canKickDist && this.kickCooldown <= 0) {
                // AI now kicks towards its determined target
                const kickAngle = Math.atan2(this.kickTargetY - this.y, this.kickTargetX - this.x);
                let currentKickPower = (this.role === 'goalie') ? KICK_POWER * 1.25 : KICK_POWER;

                // Distance-based power modulation for AI too
                const minDist = PLAYER_RADIUS + BALL_RADIUS;
                const maxDist = canKickDist;
                let powerFactor = 1.0;
                
                if (distance > minDist) {
                    powerFactor = 1.0 - ((distance - minDist) / (maxDist - minDist)) * 0.8;
                }
                powerFactor = Math.max(0.2, Math.min(1.0, powerFactor));
                
                currentKickPower *= powerFactor;

                ball.vx = Math.cos(kickAngle) * currentKickPower;
                ball.vy = Math.sin(kickAngle) * currentKickPower;
                this.kickCooldown = 60; // 60 frames at 60 FPS (1 second cooldown)
                this.kickVisualTimer = 15; // 15 frames at 60 FPS
                this.shockwaveTimer = 20;
                this.wantsToKick = false; // Reset flag
            }
        }

        if (this.shockwaveTimer > 0) this.shockwaveTimer -= deltaTime;
        if (this.kickCooldown > 0) this.kickCooldown -= deltaTime;
    }

    handleInput(inputKeys) {
        // Sliding Physics (Ice Effect)
        let targetVx = 0;
        let targetVy = 0;
        
        const currentSpeed = (this.role === 'goalie') ? PLAYER_SPEED * 0.75 : PLAYER_SPEED;

        // Joystick (Analog)
        if (inputKeys.joystick && inputKeys.joystick.active) {
            targetVx = inputKeys.joystick.x * currentSpeed;
            targetVy = inputKeys.joystick.y * currentSpeed;
        } else {
            // Keyboard (Digital)
            let dx = 0;
            let dy = 0;
            if (inputKeys.w) dy -= 1;
            if (inputKeys.s) dy += 1;
            if (inputKeys.a) dx -= 1;
            if (inputKeys.d) dx += 1;

            if (dx !== 0 || dy !== 0) {
                // Normalize to prevent faster diagonal movement
                const length = Math.sqrt(dx * dx + dy * dy);
                targetVx = (dx / length) * currentSpeed;
                targetVy = (dy / length) * currentSpeed;
            }
        }
        
        // Apply Inertia (Slide)
        const ACCEL = 0.04; // Lower = more slide
        this.vx += (targetVx - this.vx) * ACCEL;
        this.vy += (targetVy - this.vy) * ACCEL;
    }

    aiBehavior(ball, allPlayers, deltaTime) {
        this.aiTimer -= deltaTime;
        
        // Update AI decisions periodically
        if (this.aiTimer <= 0) {
            this.aiTimer = 5 + Math.random() * 5; // Faster updates: 5-10 frames (0.08-0.16s) for better responsiveness

            this.wantsToKick = false; // Reset kick desire

            // 1. Identify closest teammate to ball
            let myTeammates = allPlayers.filter(p => p.team === this.team);
            let closestTeammate = null;
            let minDist = Infinity;
            
            myTeammates.forEach(p => {
                let d = Math.hypot(p.x - ball.x, p.y - ball.y);
                if (d < minDist) {
                    minDist = d;
                    closestTeammate = p;
                }
            });

            const amIClosest = (closestTeammate === this);
            const distToBall = Math.hypot(this.x - ball.x, this.y - ball.y);

            // 2. Behavior based on Role and Context
            if (this.role === 'goalie') {
                // Goalie Logic
                const isRed = this.team === 'red';
                const myScore = isRed ? scoreRed : scoreBlue;
                const oppScore = isRed ? scoreBlue : scoreRed;
                const amILosing = myScore < oppScore;

                const goalLineX = isRed ? 30 : FIELD_WIDTH - 30;
                const forwardDir = isRed ? 1 : -1;
                
                // Imperfection: Add random noise to where they think the ball is (Human error)
                // +/- 40px error range, makes them leave gaps
                const errorY = (Math.random() - 0.5) * 40; 
                
                // 1. Basic Positioning
                // If losing, play further forward (Sweeper Keeper default pos)
                let baseForward = amILosing ? 120 : 60;
                
                const distFactor = Math.min(Math.abs(ball.x - goalLineX) / (FIELD_WIDTH/2), 1);
                this.targetX = goalLineX + (forwardDir * baseForward * distFactor); 
                
                // Clamp Y to goal area but with error
                const goalTop = (FIELD_HEIGHT - GOAL_HEIGHT) / 2 - 10;
                const goalBottom = (FIELD_HEIGHT + GOAL_HEIGHT) / 2 + 10;
                
                // Apply error to target Y so they aren't perfectly aligned with ball
                this.targetY = Math.max(goalTop, Math.min(goalBottom, ball.y + errorY));

                // 2. Aggressive Rush (Sweeper Keeper)
                const distToBall = Math.hypot(ball.x - this.x, ball.y - this.y);
                
                // Rush more if losing
                let rushThreshold = 200; 
                if (amILosing) rushThreshold = 400; // Much more aggressive if losing

                // Only rush if ball is on our side
                // If losing, extend "our side" definition to almost midfield
                let sideLimit = isRed ? FIELD_WIDTH * 0.4 : FIELD_WIDTH * 0.6;
                if (amILosing) sideLimit = isRed ? FIELD_WIDTH * 0.7 : FIELD_WIDTH * 0.3;

                const ballOnOurSide = isRed ? ball.x < sideLimit : ball.x > sideLimit;

                if (ballOnOurSide && distToBall < rushThreshold) {
                    this.targetX = ball.x;
                    this.targetY = ball.y;
                    // Goalie clears the ball
                    this.wantsToKick = true;
                    this.kickTargetX = isRed ? FIELD_WIDTH : 0;
                    this.kickTargetY = FIELD_HEIGHT / 2;
                }

            } else if (amIClosest) {
                // Attacker Logic: Chase Ball with positioning
                const opponentGoalX = this.team === 'red' ? FIELD_WIDTH : 0;
                
                // Default Aim: Center of Goal (with some noise)
                let aimTargetX = opponentGoalX;
                let aimTargetY = FIELD_HEIGHT / 2;

                const distToGoal = Math.abs(opponentGoalX - ball.x);

                // Smart Shooting: If close, aim for corners
                if (distToGoal < 300) {
                    // Pick top or bottom corner based on y position
                    aimTargetY = (ball.y < FIELD_HEIGHT/2) ? 
                        (FIELD_HEIGHT/2 + GOAL_HEIGHT/2 - 15) : // Bottom corner
                        (FIELD_HEIGHT/2 - GOAL_HEIGHT/2 + 15);  // Top corner
                }

                // Analyze Situation
                let bestTeammate = null;
                let bestPassScore = -1;
                const opponents = allPlayers.filter(p => p.team !== this.team);
                
                // Check for Pass
                if (distToGoal > 100) { // Don't pass if super close to goal
                    myTeammates.forEach(tm => {
                        if (tm === this) return;
                        
                        const tmDistToGoal = Math.abs(opponentGoalX - tm.x);
                        const isForward = tmDistToGoal < distToGoal;
                        const distToTm = Math.hypot(tm.x - ball.x, tm.y - ball.y);
                        
                        if (distToTm < 80 || distToTm > 500) return;

                        // Line of Sight
                        let blocked = false;
                        for (let opp of opponents) {
                            const l2 = distToTm * distToTm;
                            if (l2 === 0) continue;
                            const t = ((opp.x - ball.x) * (tm.x - ball.x) + (opp.y - ball.y) * (tm.y - ball.y)) / l2;
                            const tClamped = Math.max(0, Math.min(1, t));
                            const projX = ball.x + tClamped * (tm.x - ball.x);
                            const projY = ball.y + tClamped * (tm.y - ball.y);
                            const distToLine = Math.hypot(opp.x - projX, opp.y - projY);
                            
                            if (distToLine < PLAYER_RADIUS * 3) { 
                                blocked = true;
                                break;
                            }
                        }

                        if (!blocked) {
                            let score = 1000 - tmDistToGoal;
                            if (!isForward) score /= 3; // Heavy penalty for backward pass
                            
                            // Bonus if teammate is very open (far from opponents)
                            let nearestOppToTm = Infinity;
                            opponents.forEach(opp => {
                                const d = Math.hypot(opp.x - tm.x, opp.y - tm.y);
                                if (d < nearestOppToTm) nearestOppToTm = d;
                            });
                            if (nearestOppToTm > 150) score += 200;

                            if (score > bestPassScore) {
                                bestPassScore = score;
                                bestTeammate = tm;
                            }
                        }
                    });
                }

                // Check Pressure
                let nearestOpponentDist = Infinity;
                let nearestOpponentToBall = Infinity;
                opponents.forEach(p => {
                    const d = Math.hypot(p.x - this.x, p.y - this.y);
                    if (d < nearestOpponentDist) nearestOpponentDist = d;
                    
                    const dBall = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (dBall < nearestOpponentToBall) nearestOpponentToBall = dBall;
                });
                const underPressure = nearestOpponentDist < 120;
                const ballThreatened = nearestOpponentToBall < 200;

                // Alignment Check
                const dx = aimTargetX - ball.x;
                const dy = aimTargetY - ball.y;
                const distToTarget = Math.hypot(dx, dy);
                const aimDirX = dx / distToTarget;
                const aimDirY = dy / distToTarget;
                
                const pDx = ball.x - this.x;
                const pDy = ball.y - this.y;
                const angleToBall = Math.atan2(pDy, pDx);
                const angleToTarget = Math.atan2(dy, dx);
                let angleDiff = Math.abs(angleToBall - angleToTarget);
                if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
                const isAligned = angleDiff < (Math.PI / 4); // 45 degrees

                // DECISION MAKING
                let action = 'dribble'; // Default

                // 1. Shoot?
                if (distToGoal < 250 && isAligned) {
                    action = 'shoot';
                }
                // 2. Pass?
                else if (bestTeammate && bestPassScore > (1000 - distToGoal) + 100) {
                    // Pass if teammate score is significantly better than my position
                    action = 'pass';
                }
                // 3. Clear/Panic Shoot?
                else if (underPressure && distToGoal < 400 && isAligned) {
                    action = 'shoot';
                }
                
                // EXECUTION
                if (action === 'shoot') {
                    this.targetX = ball.x;
                    this.targetY = ball.y;
                    this.wantsToKick = true;
                    this.kickTargetX = aimTargetX;
                    this.kickTargetY = aimTargetY;
                } else if (action === 'pass') {
                    this.targetX = ball.x;
                    this.targetY = ball.y;
                    this.wantsToKick = true;
                    // Lead the pass
                    this.kickTargetX = bestTeammate.x + bestTeammate.vx * 15;
                    this.kickTargetY = bestTeammate.y + bestTeammate.vy * 15;
                } else {
                    // Dribble / Position
                    
                    // EMERGENCY / CONTEST: If ball is threatened or we are super close, don't back off!
                    // If an opponent is close to the ball, we must contest it.
                    // Also if we are already touching the ball, don't back off to "prep".
                    const distToBall = Math.hypot(pDx, pDy);
                    const touchingBall = distToBall < PLAYER_RADIUS + BALL_RADIUS + 5;
                    
                    if ((ballThreatened || touchingBall) && !isAligned) {
                         // Just go for the ball to push it or contest it
                         this.targetX = ball.x;
                         this.targetY = ball.y;
                         
                         // If we are really close and facing roughly the wrong way, maybe kick it to clear/pass?
                         // But for now, just pushing it is better than running away.
                    }
                    else if (isAligned) {
                        // Dribble: Move towards goal through ball
                        this.targetX = ball.x + aimDirX * 50;
                        this.targetY = ball.y + aimDirY * 50;
                        // Don't kick, just push
                    } else {
                        // Position: Move to prep point
                        const approachDist = 60; 
                        const prepX = ball.x - aimDirX * approachDist;
                        const prepY = ball.y - aimDirY * approachDist;
                        this.targetX = prepX;
                        this.targetY = prepY;
                        
                        // Circle around ball if close (but not touching/threatened)
                        if (distToBall < 80) {
                            const cross = pDx * aimDirY - pDy * aimDirX;
                            const side = cross > 0 ? 1 : -1;
                            const perpX = -aimDirY;
                            const perpY = aimDirX;
                            this.targetX += perpX * side * 70;
                            this.targetY += perpY * side * 70;
                        }
                    }
                }

            } else {
                // Support / Positioning Logic (Not closest)
                
                // Default: Move towards opponent goal but stay behind ball if defending
                const opponentGoalX = this.team === 'red' ? FIELD_WIDTH : 0;
                const myGoalX = this.team === 'red' ? 0 : FIELD_WIDTH;

                // Are we attacking or defending?
                // Simple check: Is ball on our side?
                const isDefending = (this.team === 'red' && ball.x < FIELD_WIDTH/2) || (this.team === 'blue' && ball.x > FIELD_WIDTH/2);

                if (isDefending) {
                    // Defend: Position between ball and goal
                    this.targetX = (ball.x + myGoalX) / 2;
                    this.targetY = ball.y;
                } else {
                    // Attack: Move to open space
                    // Try to be forward of the ball
                    const forwardOffset = this.team === 'red' ? 150 : -150;
                    this.targetX = ball.x + forwardOffset;
                    
                    // Spread out vertically
                    // If ball is top, go bottom, etc.
                    if (ball.y < FIELD_HEIGHT / 2) {
                        this.targetY = FIELD_HEIGHT * 0.75;
                    } else {
                        this.targetY = FIELD_HEIGHT * 0.25;
                    }
                }
            }

            // 3. Separation (Avoid Clustering)
            // Push away from teammates
            let sepX = 0;
            let sepY = 0;
            myTeammates.forEach(p => {
                if (p !== this) {
                    const dx = this.x - p.x;
                    const dy = this.y - p.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist < 120 && dist > 0) { // 120px separation radius
                        const force = (120 - dist) / 120;
                        sepX += (dx / dist) * force * 60;
                        sepY += (dy / dist) * force * 60;
                    }
                }
            });

            this.targetX += sepX;
            this.targetY += sepY;
        }

        // Move towards target
        const angle = Math.atan2(this.targetY - this.y, this.targetX - this.x);
        const distToTarget = Math.hypot(this.targetX - this.x, this.targetY - this.y);
        
        const currentAiSpeed = (this.role === 'goalie') ? AI_SPEED * 0.75 : AI_SPEED;
        
        let targetVx = 0;
        let targetVy = 0;

        if (distToTarget > 5) {
            targetVx = Math.cos(angle) * currentAiSpeed;
            targetVy = Math.sin(angle) * currentAiSpeed;
        }
        
        // Apply Inertia to AI too
        const ACCEL = 0.04;
        this.vx += (targetVx - this.vx) * ACCEL;
        this.vy += (targetVy - this.vy) * ACCEL;
    }

    draw() {
        // Shockwave effect when kicking (for all players)
        if (this.shockwaveTimer > 0) {
            const maxRadius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH + 5;
            const progress = 1 - (this.shockwaveTimer / 20);
            
            // Wave 1 (Outer - Dark Earth/Grey)
            const radius1 = PLAYER_RADIUS + (maxRadius - PLAYER_RADIUS) * progress;
            const alpha = (1 - progress) * 0.8; // Reduced opacity
            
            ctx.beginPath();
            ctx.arc(this.x, this.y, radius1, 0, Math.PI * 2);
            ctx.lineWidth = 4;
            ctx.strokeStyle = `rgba(100, 100, 100, ${alpha})`; // Grey
            ctx.stroke();
            ctx.closePath();

            // Wave 2 (Inner - Smaller ripple)
            const radius2 = PLAYER_RADIUS + (maxRadius - PLAYER_RADIUS) * (progress * 0.6);
            
            ctx.beginPath();
            ctx.arc(this.x, this.y, radius2, 0, Math.PI * 2);
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgba(120, 120, 120, ${alpha})`; // Lighter grey
            ctx.stroke();
            ctx.closePath();
        }

        // Base Fill
        ctx.beginPath();
        ctx.arc(this.x, this.y, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = this.team === 'red' ? '#ff4444' : '#4444ff';
        ctx.fill();

        // Goalie Indicator (Green Stripe) - Drawn BEFORE border
        if (this.role === 'goalie') {
            ctx.save();
            ctx.beginPath();
            ctx.arc(this.x, this.y, PLAYER_RADIUS, 0, Math.PI * 2);
            ctx.clip();
            ctx.fillStyle = '#05a805ff';
            ctx.fillRect(this.x - PLAYER_RADIUS, this.y + PLAYER_RADIUS * 0.5, PLAYER_RADIUS * 2, PLAYER_RADIUS);
            ctx.restore();
        }
        
        // Border (Redraw path to ensure it's on top)
        ctx.beginPath();
        ctx.arc(this.x, this.y, PLAYER_RADIUS, 0, Math.PI * 2);

        if (this.isHuman) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'yellow';
            ctx.stroke();
            ctx.lineWidth = 1;
        } else {
            ctx.strokeStyle = 'white';
            ctx.stroke();
        }
        
        // Draw number or symbol
        ctx.fillStyle = 'white';
        
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.number, this.x, this.y);
        
        ctx.closePath();
    }
}

// Setup
const ball = new Ball();
let players = [];
let gameRunning = false;
let gameMode = ''; // 'individual', 'bots', 'host', 'client'
let loopStarted = false;

// Multiplayer State
let peer = null;
let conn = null; // Keep for client mode
let connections = []; // For host mode
let myPlayerId = null;
let remoteInputs = {}; // Map peerId -> input
let lobbyState = {
    red: [],
    blue: []
};

function generateRoomCode() {
    const chars = '0123456789ABCDEF';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function initMultiplayer(role, options = {}) {
    // Reset Peer if exists
    if (peer) peer.destroy();
    connections = [];
    remoteInputs = {};
    lobbyState = { red: [], blue: [] };
    if (role === 'host') {
        hostDisplayOnly = !!options.displayOnly;
    } else {
        hostDisplayOnly = false;
    }

    if (role === 'host') {
        const roomCode = generateRoomCode();
        const peerId = 'football2d-' + roomCode;
        
        peer = new Peer(peerId, PEER_CONFIG);
        
        peer.on('open', (id) => {
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('lobby-status').innerText = hostDisplayOnly ? "Modo pantalla activo. Esperando controladores..." : "Esperando jugadores...";
            document.getElementById('host-controls').style.display = 'block';
            
            // Add Host to Lobby (Red Team by default) unless this is a display-only host
            if (!hostDisplayOnly) {
                lobbyState.red.push({ id: 'host', name: 'Anfitrión', type: 'human' });
            }
            updateLobbyUI();

            document.getElementById('multiplayer-menu').style.display = 'none';
            document.getElementById('lobby-screen').style.display = 'flex';
        });

        peer.on('connection', (connection) => {
            connections.push(connection);
            
            connection.on('open', () => {
                // Add new player to Blue team by default, or Red if empty
                const newPlayer = { id: connection.peer, name: 'Jugador ' + connections.length, type: 'human' };
                if (lobbyState.blue.length < 4) lobbyState.blue.push(newPlayer);
                else if (lobbyState.red.length < 4) lobbyState.red.push(newPlayer);
                
                broadcastLobbyState();
            });

            connection.on('data', (data) => {
                if (data.input) {
                    remoteInputs[connection.peer] = data.input;
                }
            });
            
            connection.on('close', () => {
                // Remove from lobby
                lobbyState.red = lobbyState.red.filter(p => p.id !== connection.peer);
                lobbyState.blue = lobbyState.blue.filter(p => p.id !== connection.peer);
                connections = connections.filter(c => c !== connection);
                broadcastLobbyState();
            });
        });

        peer.on('error', (err) => {
            console.error(err);
            alert("Error de conexión: " + err.type);
        });

    } else if (role === 'join') {
        const code = document.getElementById('room-code-input').value.toUpperCase();
        if (code.length !== 6) {
            alert("El código debe tener 6 caracteres.");
            return;
        }

        const peerId = 'football2d-' + code;
        peer = new Peer(undefined, PEER_CONFIG); 

        peer.on('open', () => {
            conn = peer.connect(peerId);

            conn.on('open', () => {
                document.getElementById('lobby-status').innerText = "Conectado. Esperando al anfitrión...";
                document.getElementById('multiplayer-menu').style.display = 'none';
                document.getElementById('lobby-screen').style.display = 'flex';
                document.getElementById('display-room-code').innerText = code;
                document.getElementById('host-controls').style.display = 'none';
                
                // Hide add bot buttons for client
                document.querySelectorAll('.lobby-action-btn').forEach(b => b.style.display = 'none');
            });

            conn.on('data', (data) => {
                if (data.type === 'LOBBY_UPDATE') {
                    lobbyState = data.state;
                    updateLobbyUI();
                } else if (data.type === 'START') {
                    startGameClient(data.config);
                } else if (data.type === 'GAME_OVER') {
                    // Show Game Over Screen
                    const winnerEl = document.getElementById('winner-text');
                    winnerEl.innerText = data.winner;
                    winnerEl.style.color = data.color;
                    document.getElementById('game-over-overlay').style.display = 'flex';
                    gameRunning = false;
                } else if (data.type === 'UPDATE') {
                    enqueueServerState(data);
                } else if (data.type === 'HUD') {
                    handleHudUpdate(data);
                }
            });
            
            conn.on('close', () => {
                alert("Desconectado del anfitrión.");
                gameRunning = false;
                document.getElementById('menu-overlay').style.display = 'flex';
                resetMenu();
            });
        });
    }
}

function broadcastLobbyState() {
    updateLobbyUI();
    connections.forEach(c => {
        if (c.open) c.send({ type: 'LOBBY_UPDATE', state: lobbyState });
    });
}

function updateLobbyUI() {
    const renderList = (list, elementId, team) => {
        const container = document.getElementById(elementId);
        container.innerHTML = '';
        list.forEach((p, index) => {
            const div = document.createElement('div');
            div.className = 'lobby-item';
            div.innerHTML = `<span>${p.name} (${p.type === 'bot' ? 'Bot' : 'Humano'})</span>`;
            
            // Host Controls
            if (gameMode !== 'client' && !peer.disconnected) { // Check if we are host (peer exists and not client mode logic)
                 // Actually gameMode is not set to 'host' yet, but we can check if we have connections array
                 if (connections) {
                     const moveBtn = document.createElement('button');
                     moveBtn.innerText = '⇄';
                     moveBtn.className = 'lobby-action-btn';
                     moveBtn.onclick = () => movePlayer(team, index);
                     div.appendChild(moveBtn);
                     
                     if (p.type === 'bot') {
                         const removeBtn = document.createElement('button');
                         removeBtn.innerText = 'x';
                         removeBtn.className = 'lobby-action-btn';
                         removeBtn.style.marginLeft = '5px';
                         removeBtn.onclick = () => removeBot(team, index);
                         div.appendChild(removeBtn);
                     }
                 }
            }
            container.appendChild(div);
        });
    };

    renderList(lobbyState.red, 'list-red', 'red');
    renderList(lobbyState.blue, 'list-blue', 'blue');
}

function movePlayer(fromTeam, index) {
    const player = lobbyState[fromTeam][index];
    const toTeam = fromTeam === 'red' ? 'blue' : 'red';
    
    if (lobbyState[toTeam].length >= 4) return; // Full
    
    lobbyState[fromTeam].splice(index, 1);
    lobbyState[toTeam].push(player);
    broadcastLobbyState();
}

function addBot(team) {
    if (lobbyState[team].length >= 4) return;
    lobbyState[team].push({ id: 'bot-' + Date.now(), name: 'Bot', type: 'bot' });
    broadcastLobbyState();
}

function removeBot(team, index) {
    lobbyState[team].splice(index, 1);
    broadcastLobbyState();
}

document.getElementById('btn-add-bot-red').addEventListener('click', () => addBot('red'));
document.getElementById('btn-add-bot-blue').addEventListener('click', () => addBot('blue'));

function startGameHost() {
    gameMode = 'host';
    const config = {
        red: lobbyState.red,
        blue: lobbyState.blue,
        displayOnly: hostDisplayOnly
    };
    
    // Send Start to all
    connections.forEach(c => {
        if (c.open) c.send({ type: 'START', config: config });
    });
    
    startCountdown(3);
    initGame('host', config);
}

function startGameClient(config) {
    gameMode = 'client';
    document.getElementById('menu-overlay').style.display = 'none';
    // Start the render loop but freeze physics while countdown runs
    gameRunning = true;
    countdownActive = true;
    lastTime = 0;
    startCountdown(3);
    // Init game with config received from host
    initGame('client', config);
}

function initGame(mode, config = null) {
    gameMode = mode;
    players = [];
    scoreRed = 0;
    scoreBlue = 0;
    isGameOver = false;
    stateBuffer.length = 0;
    const shouldUseControllerView = mode === 'client' && config && config.displayOnly;
    setControllerMode(shouldUseControllerView);
    
    // Set Duration
    if (config && config.duration) {
        gameDuration = config.duration;
    } else {
        gameDuration = 180; // Default 3 min
    }
    timeLeft = gameDuration;
    updateTimerDisplay();

    updateScoreboard();
    ball.reset();

    if (mode === 'singleplayer') {
        // Config: { redCount: N, blueCount: M }
        const redCount = (config && config.redCount) ? config.redCount : 1;
        const blueCount = (config && config.blueCount !== undefined) ? config.blueCount : 1;

        // Red Team (1 Human + Bots)
        // Human
        const hostId = 'host';
        players.push(new Player(
            0, 0, // Position will be set by setupTeamFormation
            'red',
            true,
            derivePlayerNumber(hostId, 'red', 0),
            'field',
            hostId
        ));
        
        // Red Bots
        for(let i=1; i<redCount; i++) {
            const botId = `sp-red-${i}`;
            players.push(new Player(
                0, 0, // Position will be set by setupTeamFormation
                'red',
                false,
                derivePlayerNumber(botId, 'red', i),
                'field',
                botId
            ));
        }

        // Blue Team (Bots)
        for(let i=0; i<blueCount; i++) {
            const botId = `sp-blue-${i}`;
            players.push(new Player(
                0, 0, // Position will be set by setupTeamFormation
                'blue',
                false,
                derivePlayerNumber(botId, 'blue', i),
                'field',
                botId
            ));
        }

        setupTeamFormation(players);
        // Apply favorite number override to human host if set
        if (userSettings.favoriteNumber) {
            const human = players.find(p => p.isHuman && p.ownerId === 'host');
            if (human) {
                // Ensure uniqueness: if number already used, skip override
                const taken = players.some(p => p !== human && p.number === userSettings.favoriteNumber);
                if (!taken) human.number = userSettings.favoriteNumber;
            }
        }

    } else if (mode === 'host' || mode === 'client') {
        // Config: { red: [players], blue: [players] }
        // Reconstruct players from lobby config
        
        const createTeam = (list, teamName) => {
            if (!list) return;
            list.forEach((p, i) => {
                const isHuman = p.type === 'human';
                const ownerId = p.id;
                const jersey = derivePlayerNumber(ownerId, teamName, i);
                players.push(new Player(0, 0, teamName, isHuman, jersey, 'field', ownerId));
            });
        };

        createTeam(config.red, 'red');
        createTeam(config.blue, 'blue');

        if (mode === 'host') {
            setupTeamFormation(players);
            if (userSettings.favoriteNumber) {
                const humanHost = players.find(p => p.isHuman && p.ownerId === 'host');
                if (humanHost) {
                    const taken = players.some(p => p !== humanHost && p.number === userSettings.favoriteNumber);
                    if (!taken) humanHost.number = userSettings.favoriteNumber;
                }
            }
        }
    }

    document.getElementById('menu-overlay').style.display = 'none';
    gameRunning = true;
    lastTime = 0;
    
    if (!loopStarted) {
        loopStarted = true;
        requestAnimationFrame(gameLoop);
    }
}

// Asignación de posiciones, roles y números
function setupTeamFormation(playerList) {
    const used = new Set();
    const teams = {
        red: playerList.filter(p => p.team === 'red'),
        blue: playerList.filter(p => p.team === 'blue')
    };

    const processTeam = (arr, isRed) => {
        if (!arr.length) return;

        // 1. Shuffle to randomize who gets which slot (and thus who becomes goalie)
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }

        // 2. Assign Positions & Roles
        const forward = isRed ? 1 : -1;
        const goalX = isRed ? 0 : FIELD_WIDTH;
        
        arr.forEach((p, i) => {
            let tx, ty;
            
            // Index 0 is Goalie (Back) if we have enough players
            if (i === 0 && arr.length > 1) {
                // Goalie
                p.role = 'goalie';
                tx = goalX + forward * (FIELD_WIDTH * 0.1);
                ty = FIELD_HEIGHT * 0.5;
            } else {
                // Field
                p.role = 'field'; 
                
                // Formation: Vertical line at 0.35 * W
                const fieldIndex = (arr.length > 1) ? i - 1 : i;
                const fieldCount = (arr.length > 1) ? arr.length - 1 : arr.length;
                
                const xOffset = FIELD_WIDTH * 0.35;
                tx = goalX + forward * xOffset;
                
                // Distribute Y evenly
                const segment = FIELD_HEIGHT / (fieldCount + 1);
                ty = segment * (fieldIndex + 1);
            }
            
            p.x = tx;
            p.y = ty;
            p.startX = tx;
            p.startY = ty;
            
            // Refine Field Role
            if (p.role === 'field') {
                const rolesPool = ['defender', 'attacker', 'field'];
                p.role = rolesPool[Math.floor(Math.random() * rolesPool.length)];
            }
            
            // Assign Unique Number
            let num;
            for (let attempt = 0; attempt < 50; attempt++) {
                num = Math.floor(Math.random() * 25) + 1;
                if (!used.has(num)) break;
            }
            if (used.has(num)) {
                 for (let candidate = 1; candidate <= 25; candidate++) {
                    if (!used.has(candidate)) { num = candidate; break; }
                 }
            }
            used.add(num);
            p.number = num;
        });
    };

    processTeam(teams.red, true);
    processTeam(teams.blue, false);
}

// Menu Navigation
function resetMenu() {
    setControllerMode(false);
    hostDisplayOnly = false;
    document.getElementById('multiplayer-menu').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('singleplayer-setup').style.display = 'none';
    document.getElementById('main-menu').style.display = 'block';
    
    const overlay = document.getElementById('menu-overlay');
    Array.from(overlay.children).forEach(child => {
        if (child.id === 'scoreboard') return;
        // Reset visibility logic if needed
    });
}

document.getElementById('btn-singleplayer').addEventListener('click', () => {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('singleplayer-setup').style.display = 'block';
});

// Single Player Setup Logic
let spRedValue = 3; // Default 3
let spBlueValue = 3; // Default 3
let spDurationValue = 3; // Default 3 minutes

const spRedCount = document.getElementById('sp-red-count');
const spBlueCount = document.getElementById('sp-blue-count');
const timeSelection = document.getElementById('time-selection');

// Buttons
const btnPrevRed = document.getElementById('btn-prev-red');
const btnNextRed = document.getElementById('btn-next-red');
const btnPrevBlue = document.getElementById('btn-prev-blue');
const btnNextBlue = document.getElementById('btn-next-blue');
const btnPrevTime = document.getElementById('btn-prev-time');
const btnNextTime = document.getElementById('btn-next-time');

function updateCounters() {
    spRedCount.innerText = spRedValue;
    spBlueCount.innerText = spBlueValue;
    timeSelection.innerText = spDurationValue + " min";

    // Red Limits (1-4)
    btnPrevRed.disabled = (spRedValue <= 1);
    btnNextRed.disabled = (spRedValue >= 4);

    // Blue Limits (0-4)
    btnPrevBlue.disabled = (spBlueValue <= 0);
    btnNextBlue.disabled = (spBlueValue >= 4);

    // Time Limits (1-5)
    btnPrevTime.disabled = (spDurationValue <= 1);
    btnNextTime.disabled = (spDurationValue >= 5);
}

// Initialize state
updateCounters();

btnPrevRed.addEventListener('click', () => {
    if (spRedValue > 1) spRedValue--;
    updateCounters();
});
btnNextRed.addEventListener('click', () => {
    if (spRedValue < 4) spRedValue++;
    updateCounters();
});

btnPrevBlue.addEventListener('click', () => {
    if (spBlueValue > 0) spBlueValue--;
    updateCounters();
});
btnNextBlue.addEventListener('click', () => {
    if (spBlueValue < 4) spBlueValue++;
    updateCounters();
});

btnPrevTime.addEventListener('click', () => {
    if (spDurationValue > 1) spDurationValue--;
    updateCounters();
});
btnNextTime.addEventListener('click', () => {
    if (spDurationValue < 5) spDurationValue++;
    updateCounters();
});

document.getElementById('btn-start-sp').addEventListener('click', () => {
    startCountdown(3);
    initGame('singleplayer', {
        redCount: spRedValue,
        blueCount: spBlueValue,
        duration: spDurationValue * 60 // Convert to seconds
    });
});

document.getElementById('btn-back-sp').addEventListener('click', () => {
    document.getElementById('singleplayer-setup').style.display = 'none';
    document.getElementById('main-menu').style.display = 'block';
});

document.getElementById('btn-multiplayer').addEventListener('click', () => {
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('multiplayer-menu').style.display = 'flex';
});

document.getElementById('btn-back-menu').addEventListener('click', () => {
    document.getElementById('multiplayer-menu').style.display = 'none';
    document.getElementById('main-menu').style.display = 'block';
});

document.getElementById('btn-create-room').addEventListener('click', () => initMultiplayer('host'));
document.getElementById('btn-create-display-room').addEventListener('click', () => initMultiplayer('host', { displayOnly: true }));
document.getElementById('btn-join-room').addEventListener('click', () => initMultiplayer('join'));
document.getElementById('btn-start-mp').addEventListener('click', startGameHost);
document.getElementById('btn-cancel-lobby').addEventListener('click', () => {
    if (peer) peer.destroy();
    resetMenu();
});

document.getElementById('btn-fullscreen-toggle').addEventListener('click', function() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.log(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        document.exitFullscreen();
    }
    this.blur(); // Remove focus from button so Spacebar doesn't trigger it again
});

function resetPositions() {
    ball.reset();
    players.forEach(p => p.reset());
}

function updateScoreboard() {
    document.getElementById('score-red').innerText = scoreRed;
    document.getElementById('score-blue').innerText = scoreBlue;
    if (controllerOnlyMode && controllerScoreDisplay) {
        controllerScoreDisplay.innerText = `${scoreRed} - ${scoreBlue}`;
    }
}

function formatTime(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateTimerDisplay() {
    const formatted = formatTime(timeLeft);
    document.getElementById('timer').innerText = formatted;
    if (controllerOnlyMode && controllerTimeDisplay) {
        controllerTimeDisplay.innerText = formatted;
    }
}

// Goal animation state
let goalAnimating = false;
// Goal Overlay State
let goalOverlayState = {
    active: false,
    timer: 0,
    scoringTeam: '',
    oldRed: 0,
    oldBlue: 0
};

function drawGoalOverlay(dt) {
    if (!goalOverlayState.active) return;
    
    goalOverlayState.timer += dt;
    const t = goalOverlayState.timer;
    
    // Animation Timing
    const animStart = 1.0; 
    const animDuration = 0.8; 
    
    // Calculate interpolation 0..1
    let progress = 0;
    if (t > animStart) {
        progress = (t - animStart) / animDuration;
        if (progress > 1) progress = 1;
    }
    
    // Ease out cubic
    const ease = 1 - Math.pow(1 - progress, 3);
    
    ctx.save();
    
    // Darken background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
    
    const centerY = FIELD_HEIGHT / 2;
    const centerX = FIELD_WIDTH / 2;
    const offset = 200; 
    const dropDist = 300;

    // Helper to draw numbers
    const drawNum = (num, x, y, color, alpha) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `900 180px "Arial Black", "Arial", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = color;
        ctx.shadowBlur = 40;
        ctx.lineWidth = 8;
        ctx.strokeStyle = 'white';
        ctx.strokeText(num, x, y);
        ctx.fillStyle = color;
        ctx.fillText(num, x, y);
        ctx.restore();
    };

    // Draw "GOAL!" text
    if (t < animStart + 0.5) {
        ctx.save();
        const scale = t < 0.2 ? t * 5 : 1; // Pop in
        ctx.translate(centerX, centerY - 200);
        ctx.scale(scale, scale);
        ctx.font = `900 100px "Arial Black", "Arial", sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = goalOverlayState.scoringTeam === 'red' ? '#ff4444' : '#4444ff';
        ctx.shadowBlur = 30;
        ctx.fillText("¡GOL!", 0, 0);
        ctx.restore();
    }

    // Draw Scores
    // Static side
    if (goalOverlayState.scoringTeam === 'red') {
        // Blue is static
        drawNum(goalOverlayState.oldBlue, centerX + offset, centerY, '#4444ff', 1);
        
        // Red animates
        if (progress < 1) {
             // Old falling
             drawNum(goalOverlayState.oldRed, centerX - offset, centerY + (dropDist * ease), '#ff4444', 1 - ease);
             // New dropping in
             drawNum(scoreRed, centerX - offset, (centerY - dropDist) + (dropDist * ease), '#ff4444', ease);
        } else {
             drawNum(scoreRed, centerX - offset, centerY, '#ff4444', 1);
        }
    } else {
        // Red is static
        drawNum(goalOverlayState.oldRed, centerX - offset, centerY, '#ff4444', 1);
        
        // Blue animates
        if (progress < 1) {
             // Old falling
             drawNum(goalOverlayState.oldBlue, centerX + offset, centerY + (dropDist * ease), '#4444ff', 1 - ease);
             // New dropping in
             drawNum(scoreBlue, centerX + offset, (centerY - dropDist) + (dropDist * ease), '#4444ff', ease);
        } else {
             drawNum(scoreBlue, centerX + offset, centerY, '#4444ff', 1);
        }
    }
    
    ctx.restore();
}

// Start countdown state
let countdownActive = false;
let countdownEndTime = 0;
let countdownFlashUntil = 0;

function triggerGoal(team) {
    if (goalAnimating) return;
    goalAnimating = true;
    
    // Setup Overlay
    goalOverlayState.active = true;
    goalOverlayState.timer = 0;
    goalOverlayState.scoringTeam = team;
    goalOverlayState.oldRed = team === 'red' ? scoreRed - 1 : scoreRed;
    goalOverlayState.oldBlue = team === 'blue' ? scoreBlue - 1 : scoreBlue;

    // Only spawn canvas-based explosion particles at the goal mouth
    spawnGoalExplosion(team, ball ? ball.y : FIELD_HEIGHT/2);

    // After animation duration, reset positions and clear particles
    setTimeout(() => {
        resetPositions();
        // clear particles after reset
        goalParticles.length = 0;
        goalAnimating = false;
        goalOverlayState.active = false;
        updateScoreboard();
    }, 3000);
}

// Goal explosion particle system (canvas)
let goalParticles = [];

function spawnGoalExplosion(team, y) {
    const count = 40;
    const dir = team === 'red' ? -1 : 1; // red scored on right -> explosion goes left into field
    const centerX = team === 'red' ? FIELD_WIDTH : 0;
    const centerY = Math.max(30, Math.min(FIELD_HEIGHT - 30, y || FIELD_HEIGHT/2));

    for (let i = 0; i < count; i++) {
        const angle = (Math.random() * Math.PI / 2) - Math.PI/4; // spread +/-45deg
        const speed = 2 + Math.random() * 6;
        const vx = Math.cos(angle) * speed * dir + (Math.random() - 0.5) * 1.5;
        const vy = Math.sin(angle) * speed + (Math.random() - 0.5) * 1.5;
        const life = 40 + Math.floor(Math.random() * 40); // frames-ish
        const size = 4 + Math.random() * 6;
        const colorChoice = Math.random();
        const color = colorChoice < 0.45 ? '#ffcc00' : (colorChoice < 0.75 ? (team === 'red' ? '#ff4444' : '#4444ff') : '#ffffff');
        goalParticles.push({ x: centerX, y: centerY, vx, vy, life, size, color, age: 0 });
    }
}

function drawGoalParticles(deltaFrames) {
    if (!goalParticles.length) return;

    ctx.save();
    // particles drawn in field coordinate space already
    goalParticles.forEach(p => {
        // update
        const dt = Math.max(0.5, Math.min(4, deltaFrames));
        p.x += p.vx * dt;
        p.y += p.vy * dt + 0.5 * (p.age/20); // slight gravity over time
        // slow down
        p.vx *= 0.98;
        p.vy *= 0.99;
        p.age += dt;
        p.life -= dt;

        // draw
        ctx.beginPath();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 60));
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.closePath();
        ctx.globalAlpha = 1;
    });
    ctx.restore();

    // remove dead
    for (let i = goalParticles.length - 1; i >= 0; i--) {
        if (goalParticles[i].life <= 0) goalParticles.splice(i, 1);
    }
}

// Start countdown overlay and logic
function startCountdown(seconds) {
    countdownActive = true;
    const now = performance.now();
    countdownEndTime = now + Math.max(1, Math.floor(seconds)) * 1000;
    countdownFlashUntil = 0;
}

// Input Listeners
window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === 'W') keys.w = true;
    if (e.key === 'a' || e.key === 'A') keys.a = true;
    if (e.key === 's' || e.key === 'S') keys.s = true;
    if (e.key === 'd' || e.key === 'D') keys.d = true;
    if (e.key === ' ') {
        keys.space = true;
        inputBuffer.space = true;
    }
    
    // Escape to menu
    if (e.key === 'Escape') {
        if (gameMode === 'host' || gameMode === 'client') {
            if (peer) peer.destroy();
            alert("Partida finalizada.");
        }
        gameRunning = false;
        document.getElementById('menu-overlay').style.display = 'flex';
        resetMenu();
        document.getElementById('btn-individual').style.display = 'block';
        document.getElementById('btn-bots').style.display = 'block';
        document.getElementById('btn-multiplayer').style.display = 'block';
    }
});

window.addEventListener('keyup', (e) => {
    if (e.key === 'w' || e.key === 'W') keys.w = false;
    if (e.key === 'a' || e.key === 'A') keys.a = false;
    if (e.key === 's' || e.key === 'S') keys.s = false;
    if (e.key === 'd' || e.key === 'D') keys.d = false;
    if (e.key === ' ') keys.space = false;
});

function drawField() {
    // Nuevo diseño estilo mesa de air hockey con estética metálica y neón
    const goalTop = (FIELD_HEIGHT - GOAL_HEIGHT) / 2;
    const goalBottom = goalTop + GOAL_HEIGHT;

    // Fondo metálico del campo
    const boardGrad = ctx.createLinearGradient(0, 0, 0, FIELD_HEIGHT);
    boardGrad.addColorStop(0, '#3e444a');
    boardGrad.addColorStop(0.5, '#2a2f33');
    boardGrad.addColorStop(1, '#1c2023');
    ctx.fillStyle = boardGrad;
    ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

    // Borde exterior con degradado neón
    const borderGrad = ctx.createLinearGradient(0, 0, FIELD_WIDTH, 0);
    borderGrad.addColorStop(0, 'rgba(0,234,255,0.85)');
    borderGrad.addColorStop(0.5, 'rgba(184,255,59,0.55)');
    borderGrad.addColorStop(1, 'rgba(255,43,214,0.85)');
    ctx.lineWidth = 6;
    ctx.strokeStyle = borderGrad;
    ctx.strokeRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

    // Borde interior tenue para efecto de profundidad
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeRect(3, 3, FIELD_WIDTH - 6, FIELD_HEIGHT - 6);

    // Línea central neón
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(FIELD_WIDTH / 2, 12);
    ctx.lineTo(FIELD_WIDTH / 2, FIELD_HEIGHT - 12);
    ctx.strokeStyle = 'rgba(0,234,255,0.75)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,234,255,0.6)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();

    // Círculo central (face-off principal)
    ctx.save();
    ctx.beginPath();
    ctx.arc(FIELD_WIDTH / 2, FIELD_HEIGHT / 2, 55, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,43,214,0.75)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255,43,214,0.6)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // Punto central
    ctx.beginPath();
    ctx.arc(FIELD_WIDTH / 2, FIELD_HEIGHT / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Semicírculos (áreas de portería) estilo air hockey
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, FIELD_HEIGHT / 2, 85, -Math.PI / 2, Math.PI / 2, false);
    ctx.strokeStyle = 'rgba(0,234,255,0.6)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(0,234,255,0.5)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(FIELD_WIDTH, FIELD_HEIGHT / 2, 85, Math.PI / 2, -Math.PI / 2, false);
    ctx.strokeStyle = 'rgba(255,43,214,0.6)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255,43,214,0.5)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();

    // Aperturas de gol: línea vertical destacada
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, goalTop);
    ctx.lineTo(0, goalBottom);
    ctx.strokeStyle = 'rgba(0,234,255,0.85)';
    ctx.lineWidth = 4;
    ctx.shadowColor = 'rgba(0,234,255,0.7)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(FIELD_WIDTH, goalTop);
    ctx.lineTo(FIELD_WIDTH, goalBottom);
    ctx.strokeStyle = 'rgba(255,43,214,0.85)';
    ctx.lineWidth = 4;
    ctx.shadowColor = 'rgba(255,43,214,0.7)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // Túneles de portería (hueco hacia afuera) para marcar claramente la zona de gol
    // Izquierda
    ctx.save();
    const tunnelDepth = GOAL_DEPTH; // Usa profundidad existente lógica
    const leftGrad = ctx.createLinearGradient(-tunnelDepth, 0, 0, 0);
    leftGrad.addColorStop(0, '#0a0c0d');
    leftGrad.addColorStop(0.4, '#14181b');
    leftGrad.addColorStop(1, '#20262a');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(-tunnelDepth, goalTop, tunnelDepth, GOAL_HEIGHT);

    // Bordes internos con brillo tenue
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,234,255,0.35)';
    ctx.strokeRect(-tunnelDepth + 2, goalTop + 2, tunnelDepth - 4, GOAL_HEIGHT - 4);

    // Rejilla sutil (líneas horizontales)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let y = goalTop + 6; y < goalBottom - 6; y += 10) {
        ctx.beginPath();
        ctx.moveTo(-tunnelDepth + 4, y);
        ctx.lineTo(-4, y);
        ctx.stroke();
    }
    // Líneas verticales muy tenues
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let x = -tunnelDepth + 8; x < -8; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, goalTop + 4);
        ctx.lineTo(x, goalBottom - 4);
        ctx.stroke();
    }

    // Borde exterior del túnel con neón degradado
    const leftRim = ctx.createLinearGradient(-tunnelDepth, 0, 0, 0);
    leftRim.addColorStop(0, 'rgba(0,234,255,0.7)');
    leftRim.addColorStop(1, 'rgba(0,234,255,0.15)');
    ctx.beginPath();
    ctx.strokeStyle = leftRim;
    ctx.lineWidth = 3;
    ctx.rect(-tunnelDepth, goalTop, tunnelDepth, GOAL_HEIGHT);
    ctx.stroke();
    ctx.restore();

    // Derecha
    ctx.save();
    const rightGrad = ctx.createLinearGradient(FIELD_WIDTH, 0, FIELD_WIDTH + tunnelDepth, 0);
    rightGrad.addColorStop(0, '#20262a');
    rightGrad.addColorStop(0.6, '#14181b');
    rightGrad.addColorStop(1, '#0a0c0d');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(FIELD_WIDTH, goalTop, tunnelDepth, GOAL_HEIGHT);

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,43,214,0.35)';
    ctx.strokeRect(FIELD_WIDTH + 2, goalTop + 2, tunnelDepth - 4, GOAL_HEIGHT - 4);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let y = goalTop + 6; y < goalBottom - 6; y += 10) {
        ctx.beginPath();
        ctx.moveTo(FIELD_WIDTH + 4, y);
        ctx.lineTo(FIELD_WIDTH + tunnelDepth - 4, y);
        ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let x = FIELD_WIDTH + 8; x < FIELD_WIDTH + tunnelDepth - 8; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, goalTop + 4);
        ctx.lineTo(x, goalBottom - 4);
        ctx.stroke();
    }

    const rightRim = ctx.createLinearGradient(FIELD_WIDTH, 0, FIELD_WIDTH + tunnelDepth, 0);
    rightRim.addColorStop(0, 'rgba(255,43,214,0.7)');
    rightRim.addColorStop(1, 'rgba(255,43,214,0.15)');
    ctx.beginPath();
    ctx.strokeStyle = rightRim;
    ctx.lineWidth = 3;
    ctx.rect(FIELD_WIDTH, goalTop, tunnelDepth, GOAL_HEIGHT);
    ctx.stroke();
    ctx.restore();

    // Puntos de face-off adicionales (arriba y abajo del centro)
    const faceOffOffsets = [FIELD_HEIGHT * 0.25, FIELD_HEIGHT * 0.75];
    faceOffOffsets.forEach(y => {
        ctx.beginPath();
        ctx.arc(FIELD_WIDTH / 2, y, 32, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(184,255,59,0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(FIELD_WIDTH / 2, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fill();
    });
}

// Start game
// Handle Window Resize
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    CANVAS_WIDTH = window.innerWidth;
    CANVAS_HEIGHT = window.innerHeight; // Full height
    
    canvas.width = CANVAS_WIDTH * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    
    canvas.style.width = CANVAS_WIDTH + 'px';
    canvas.style.height = CANVAS_HEIGHT + 'px';

    // Calculate Scale to fit the fixed field into the available space
    const availableWidth = CANVAS_WIDTH * 0.95;
    const availableHeight = CANVAS_HEIGHT * 0.95;

    // Account for goal depth in width calculation so goals are visible
    const totalContentWidth = FIELD_WIDTH + (GOAL_DEPTH * 2);
    
    const scaleX = availableWidth / totalContentWidth;
    const scaleY = availableHeight / FIELD_HEIGHT;

    renderScale = Math.min(scaleX, scaleY);
    
    const scaledFieldWidth = FIELD_WIDTH * renderScale;
    const scaledFieldHeight = FIELD_HEIGHT * renderScale;
    
    FIELD_OFFSET_X = (CANVAS_WIDTH - scaledFieldWidth) / 2;
    FIELD_OFFSET_Y = (CANVAS_HEIGHT - scaledFieldHeight) / 2;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Initial call

let lastTime = 0;

function resolvePlayerCollisions() {
    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const p1 = players[i];
            const p2 = players[j];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const minDistance = PLAYER_RADIUS * 2;

            if (distance < minDistance && distance > 0) {
                const overlap = minDistance - distance;
                const angle = Math.atan2(dy, dx);
                const moveX = Math.cos(angle) * overlap / 2;
                const moveY = Math.sin(angle) * overlap / 2;

                p1.x -= moveX;
                p1.y -= moveY;
                p2.x += moveX;
                p2.y += moveY;
            }
        }
    }
}

function gameLoop(timestamp) {
    if (!timestamp) timestamp = performance.now();
    // Always draw background even if game not running
    if (!lastTime) lastTime = timestamp;
    let deltaTime = (timestamp - lastTime) / 16.67;
    let dtSeconds = (timestamp - lastTime) / 1000; // Real time in seconds
    lastTime = timestamp;

    // Cap deltaTime
    if (deltaTime > 4) deltaTime = 4;

    // Clear entire canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Field (Always)
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    ctx.translate(FIELD_OFFSET_X, FIELD_OFFSET_Y);
    ctx.scale(renderScale, renderScale);
    const settingsVisible = document.getElementById('settings-overlay') && document.getElementById('settings-overlay').style.display !== 'none';
    const menuVisible = document.getElementById('menu-overlay') && document.getElementById('menu-overlay').style.display !== 'none';
    if (!gameRunning && (menuVisible || settingsVisible)) {
        // Fondo plano cuando estamos en menú o ajustes
        ctx.fillStyle = '#1e2125';
        ctx.fillRect(0,0,FIELD_WIDTH,FIELD_HEIGHT);
    } else {
        drawField();
    }

    if (!gameRunning) {
        ctx.restore();
        requestAnimationFrame(gameLoop);
        return;
    }

    // Timer Logic
    if (!isGameOver && gameMode !== 'client') { // Host or Singleplayer manages time
        timeLeft -= dtSeconds;
        if (timeLeft <= 0) {
            timeLeft = 0;
            endGame();
        }
        updateTimerDisplay();
    }

    // Game Logic (Only if running)
    if (gameMode === 'client') {
        // Client Logic: Send Input, Render State
        const now = performance.now();
        if (conn && conn.open && now - lastInputUpdate > NETWORK_INPUT_INTERVAL) {
            lastInputUpdate = now;
            // Send buffered input to ensure host receives the kick command
            conn.send({ input: { ...keys, space: keys.space || inputBuffer.space } });
        }
        applyInterpolatedState();
    } else if (!isGameOver) {
        // Host / Local Logic
        if (!goalAnimating && !countdownActive) {
            resolvePlayerCollisions(); // Prevent overlapping
            ball.update(deltaTime);
            players.forEach(player => {
                player.update(ball, players, deltaTime);
            });
        } else {
            // During goal animation: optionally make a soft net/glow effect by not updating physics
        }

        // If Host, send state to client
        if (gameMode === 'host' && connections.length > 0) {
            const now = performance.now();
            if (now - lastNetworkUpdate > NETWORK_STATE_INTERVAL) {
                lastNetworkUpdate = now;
                if (hostDisplayOnly) {
                    const hud = {
                        type: 'HUD',
                        score: { red: scoreRed, blue: scoreBlue },
                        timeLeft: quantize(Math.max(0, timeLeft), 2)
                    };
                    connections.forEach(c => {
                        if (c.open) c.send(hud);
                    });
                } else {
                    const state = {
                        type: 'UPDATE',
                        ball: serializeBallState(),
                        score: { red: scoreRed, blue: scoreBlue },
                        timeLeft: quantize(Math.max(0, timeLeft), 2),
                        players: players.map(serializePlayerState)
                    };
                    connections.forEach(c => {
                        if (c.open) c.send(state);
                    });
                }
            }
        }
    }

    // Draw everything (Client and Host)
    ball.draw();
    players.forEach(player => {
        player.draw();
    });

    // Draw goal explosion particles if any
    if (goalAnimating || goalParticles.length) {
        drawGoalParticles(deltaTime);
    }

    // Draw Goal Overlay
    if (goalOverlayState.active) {
        drawGoalOverlay(dtSeconds);
    }

    // Draw start countdown on the canvas (so it's always visible and above field)
    if (countdownActive) {
        const now = performance.now();
        const msLeft = countdownEndTime - now;
        if (msLeft > 0) {
            const sec = Math.ceil(msLeft / 1000);
            ctx.save();
            
            // Neon Style
            const fontSize = Math.floor(150 * renderScale);
            ctx.font = `900 ${fontSize}px "Arial Black", "Arial", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Glow effect
            ctx.shadowColor = '#efb710d7 '; 
            ctx.shadowBlur = 20;
        
            
            // Stroke
            ctx.lineWidth = 10;
            ctx.strokeStyle = '#dba911ff ';
            ctx.strokeText(sec.toString(), FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
            
            // Fill
            ctx.fillStyle = '#131313ff ';
            ctx.fillText(sec.toString(), FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
            
            ctx.restore();
        } else {
            countdownActive = false;
        }
    }

    ctx.restore();

    // Clear input buffer at the end of the frame
    inputBuffer.space = false;

    requestAnimationFrame(gameLoop);
}

function endGame() {
    isGameOver = true;
    gameRunning = false;
    
    let winnerText = "¡Empate!";
    let color = "white";
    
    if (scoreRed > scoreBlue) {
        winnerText = "¡Gana Equipo Rojo!";
        color = "#ff4444";
    } else if (scoreBlue > scoreRed) {
        winnerText = "¡Gana Equipo Azul!";
        color = "#4444ff";
    }
    
    const winnerEl = document.getElementById('winner-text');
    winnerEl.innerText = winnerText;
    winnerEl.style.color = color;
    
    document.getElementById('game-over-overlay').style.display = 'flex';
    
    // Send Game Over to clients
    if (gameMode === 'host') {
        connections.forEach(c => {
            if (c.open) c.send({ type: 'GAME_OVER', winner: winnerText, color: color });
        });
    }
}

document.getElementById('btn-return-setup').addEventListener('click', () => {
    document.getElementById('game-over-overlay').style.display = 'none';
    document.getElementById('menu-overlay').style.display = 'flex';

    if (gameMode === 'singleplayer') {
        // Singleplayer: Go to Setup
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('multiplayer-menu').style.display = 'none';
        document.getElementById('lobby-screen').style.display = 'none';
        document.getElementById('singleplayer-setup').style.display = 'block';
    } else if (gameMode === 'host' || gameMode === 'client') {
        // Multiplayer: Go to Lobby
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('singleplayer-setup').style.display = 'none';
        document.getElementById('multiplayer-menu').style.display = 'none';
        document.getElementById('lobby-screen').style.display = 'flex';
        updateLobbyUI();
        
        if (gameMode === 'host') {
             document.getElementById('host-controls').style.display = 'block';
             document.getElementById('lobby-status').innerText = "Esperando jugadores...";
        } else {
             document.getElementById('host-controls').style.display = 'none';
             document.getElementById('lobby-status').innerText = "Esperando al anfitrión...";
        }
    } else {
        resetMenu();
    }
});

// Initial draw (background)
ctx.save();
ctx.translate(FIELD_OFFSET_X, FIELD_OFFSET_Y);
ctx.scale(renderScale, renderScale);
drawField();
ctx.restore();

// Mobile Controls Logic
let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.innerWidth <= 800 && window.innerHeight <= 600);

function toggleMobileControls(forceShow) {
    const controls = document.getElementById('mobile-controls');
    if (forceShow || controls.style.display === 'none') {
        controls.style.display = 'flex';
        isMobile = true; // Enable logic
        userSettings.showTouchControls = true;
        saveSettings();
    } else {
        controls.style.display = 'none';
        isMobile = false;
        userSettings.showTouchControls = false;
        saveSettings();
    }
}

if (btnToggleControls) {
    btnToggleControls.addEventListener('click', () => toggleMobileControls());
}

// Initialize controls if detected
if (isMobile) {
    document.getElementById('mobile-controls').style.display = 'flex';
}

// Joystick Logic (Always attach listeners, but they only work if visible/isMobile)
const joystickBase = document.getElementById('joystick-base');
const joystickStick = document.getElementById('joystick-stick');
let joystickActive = false;
let joystickCenter = { x: 0, y: 0 };
const maxRadius = 35; // Adjusted to match new CSS size

joystickBase.addEventListener('touchstart', (e) => {
    if (!isMobile) return;
    e.preventDefault();
    joystickActive = true;
    const rect = joystickBase.getBoundingClientRect();
    joystickCenter = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
    };
    handleJoystickMove(e.touches[0]);
}, { passive: false });

joystickBase.addEventListener('touchmove', (e) => {
    if (!isMobile) return;
    e.preventDefault();
    if (joystickActive) {
        handleJoystickMove(e.touches[0]);
    }
}, { passive: false });

joystickBase.addEventListener('touchend', (e) => {
    if (!isMobile) return;
    e.preventDefault();
    joystickActive = false;
    joystickStick.style.transform = `translate(-50%, -50%)`;
    
    keys.joystick.active = false;
    keys.joystick.x = 0;
    keys.joystick.y = 0;
});

function handleJoystickMove(touch) {
    const dx = touch.clientX - joystickCenter.x;
    const dy = touch.clientY - joystickCenter.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    const clampedDist = Math.min(distance, maxRadius);
    const stickX = Math.cos(angle) * clampedDist;
    const stickY = Math.sin(angle) * clampedDist;

    joystickStick.style.transform = `translate(calc(-50% + ${stickX}px), calc(-50% + ${stickY}px))`;

    // Analog Output
    // Normalize distance to 0-1 range based on maxRadius
    let magnitude = clampedDist / maxRadius;
    
    // Deadzone (e.g. 5px)
    if (distance < 5) {
        magnitude = 0;
        keys.joystick.active = false;
        keys.joystick.x = 0;
        keys.joystick.y = 0;
    } else {
        keys.joystick.active = true;
        keys.joystick.x = Math.cos(angle) * magnitude;
        keys.joystick.y = Math.sin(angle) * magnitude;
    }
}

// Kick Button
const kickBtn = document.getElementById('btn-kick');
kickBtn.addEventListener('touchstart', (e) => {
    if (!isMobile) return;
    e.preventDefault();
    keys.space = true;
    inputBuffer.space = true;
});
kickBtn.addEventListener('touchend', (e) => {
    if (!isMobile) return;
    e.preventDefault();
    keys.space = false;
});
