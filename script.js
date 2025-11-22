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
const GOAL_HEIGHT = 125;
let renderScale = 1;

const GOAL_DEPTH = 40;
const PLAYER_RADIUS = 15;
const BALL_RADIUS = 8;
const GOAL_WIDTH = 10; // Used for post thickness now
const FRICTION = 0.975;
const PLAYER_SPEED = 2;
const KICK_POWER = 8;
const AI_SPEED = 2.0;
const KICK_REACH = 5;

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
                    resetPositions();
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
                    resetPositions();
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
            this.isKicking = inputKeys.space;

            // Kicking Logic for Human
            const dx = ball.x - this.x;
            const dy = ball.y - this.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const kickAreaRadius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH;
            const canKickDist = kickAreaRadius + BALL_RADIUS;

            if (inputKeys.space && this.kickCooldown <= 0 && distance < canKickDist) {
                const angle = Math.atan2(dy, dx);
                const currentKickPower = (this.role === 'goalie') ? KICK_POWER * 1.25 : KICK_POWER;
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
            const impactForce = Math.max(playerSpeed * 1.1, 2); // Reduced bounce
            
            ball.vx = Math.cos(angle) * impactForce;
            ball.vy = Math.sin(angle) * impactForce;
        }

        // AI Kick Logic (Human kick logic is above in update)
        if (!this.isHuman) {
            const kickAreaRadius = PLAYER_RADIUS + BALL_RADIUS + KICK_REACH;
            const canKickDist = kickAreaRadius + BALL_RADIUS;
            
            if (distance < canKickDist && this.kickCooldown <= 0) {
                // Simple AI kick if close to goal or clearing
                let targetX = this.team === 'red' ? FIELD_WIDTH : 0;
                // Add MORE randomness to AI aim
                let targetY = FIELD_HEIGHT / 2 + (Math.random() - 0.5) * (FIELD_HEIGHT * 0.8); 
                
                // Sometimes kick in a completely random direction (panic)
                if (Math.random() < 0.1) {
                    targetY = Math.random() * FIELD_HEIGHT;
                    targetX = Math.random() * FIELD_WIDTH;
                }
                
                const kickAngle = Math.atan2(targetY - this.y, targetX - this.x);
                const currentKickPower = (this.role === 'goalie') ? KICK_POWER * 1.25 : KICK_POWER;
                ball.vx = Math.cos(kickAngle) * currentKickPower;
                ball.vy = Math.sin(kickAngle) * currentKickPower;
                this.kickCooldown = 60; // 60 frames at 60 FPS (1 second cooldown)
                this.kickVisualTimer = 15; // 15 frames at 60 FPS
            }
        }

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
            this.aiTimer = 10 + Math.random() * 10; // 10-20 frames at 60 FPS (0.17-0.33 seconds)

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
                const errorY = (Math.random() - 0.5) * 80; 
                
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
                let rushThreshold = 250; 
                if (amILosing) rushThreshold = 500; // Much more aggressive if losing

                // Only rush if ball is on our side
                // If losing, extend "our side" definition to almost midfield
                let sideLimit = isRed ? FIELD_WIDTH * 0.4 : FIELD_WIDTH * 0.6;
                if (amILosing) sideLimit = isRed ? FIELD_WIDTH * 0.7 : FIELD_WIDTH * 0.3;

                const ballOnOurSide = isRed ? ball.x < sideLimit : ball.x > sideLimit;

                if (ballOnOurSide && distToBall < rushThreshold) {
                    this.targetX = ball.x;
                    this.targetY = ball.y;
                }

            } else if (amIClosest) {
                // Attacker Logic: Chase Ball
                this.targetX = ball.x;
                this.targetY = ball.y;

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
                    if (dist < 100 && dist > 0) { // 100px separation radius
                        const force = (100 - dist) / 100;
                        sepX += (dx / dist) * force * 50;
                        sepY += (dy / dist) * force * 50;
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
        // Indicator for human player
        if (this.isHuman) {
            // Draw kick range as white shadow
            ctx.beginPath();
            ctx.arc(this.x, this.y, PLAYER_RADIUS + BALL_RADIUS + KICK_REACH, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'; // White shadow
            ctx.fill();
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
        if (this.isKicking && Math.floor(Date.now() / 50) % 2 === 0) {
            ctx.fillStyle = 'black';
        } else {
            ctx.fillStyle = 'white';
        }
        
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
    
    initGame('host', config);
}

function startGameClient(config) {
    gameMode = 'client';
    document.getElementById('menu-overlay').style.display = 'none';
    gameRunning = true;
    lastTime = 0;
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
            FIELD_WIDTH * 0.1,
            FIELD_HEIGHT * 0.5,
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
                FIELD_WIDTH * 0.2,
                FIELD_HEIGHT * (0.2 + i*0.2),
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
                FIELD_WIDTH * 0.8,
                FIELD_HEIGHT * (0.2 + i*0.2),
                'blue',
                false,
                derivePlayerNumber(botId, 'blue', i),
                'field',
                botId
            ));
        }

        assignGoalies(players);

    } else if (mode === 'host' || mode === 'client') {
        // Config: { red: [players], blue: [players] }
        // Reconstruct players from lobby config
        
        const createTeam = (list, teamName, startX) => {
            if (!list) return;
            list.forEach((p, i) => {
                const isHuman = p.type === 'human';
                const ownerId = p.id;
                const y = FIELD_HEIGHT * (0.2 + (i+1)*0.15);
                const jersey = derivePlayerNumber(ownerId, teamName, i);
                players.push(new Player(startX, y, teamName, isHuman, jersey, 'field', ownerId));
            });
        };

        createTeam(config.red, 'red', FIELD_WIDTH * 0.1);
        createTeam(config.blue, 'blue', FIELD_WIDTH * 0.9);

        assignGoalies(players);
    }

    document.getElementById('menu-overlay').style.display = 'none';
    gameRunning = true;
    lastTime = 0;
    
    if (!loopStarted) {
        loopStarted = true;
        requestAnimationFrame(gameLoop);
    }
}

function assignGoalies(playerList) {
    const redTeam = playerList.filter(p => p.team === 'red');
    const blueTeam = playerList.filter(p => p.team === 'blue');

    // Only assign goalies if BOTH teams have more than 1 player
    redTeam.forEach(p => p.role = 'field');
    blueTeam.forEach(p => p.role = 'field');

    if (redTeam.length > 1 && blueTeam.length > 1) {
        const rIdx = deterministicIndex(redTeam, 'red-goalie');
        const bIdx = deterministicIndex(blueTeam, 'blue-goalie');

        if (rIdx >= 0) redTeam[rIdx].role = 'goalie';
        if (bIdx >= 0) blueTeam[bIdx].role = 'goalie';
    }
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
    // Draw Grass (Main Field)
    ctx.fillStyle = '#4CAF50';
    ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

    // Center line
    ctx.beginPath();
    ctx.moveTo(FIELD_WIDTH / 2, 0);
    ctx.lineTo(FIELD_WIDTH / 2, FIELD_HEIGHT);
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.closePath();

    // Center circle
    ctx.beginPath();
    ctx.arc(FIELD_WIDTH / 2, FIELD_HEIGHT / 2, 70, 0, Math.PI * 2);
    ctx.stroke();
    ctx.closePath();

    // Field Border Lines
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

    // Goals (Real Nets)
    const goalTop = (FIELD_HEIGHT - GOAL_HEIGHT) / 2;
    
    // Fill Goal Floor with Grass
    ctx.fillStyle = '#4CAF50';
    ctx.fillRect(-GOAL_DEPTH, goalTop, GOAL_DEPTH, GOAL_HEIGHT);
    ctx.fillRect(FIELD_WIDTH, goalTop, GOAL_DEPTH, GOAL_HEIGHT);

    ctx.strokeStyle = 'white';
    ctx.lineWidth = 4;

    // Left Goal
    ctx.beginPath();
    ctx.moveTo(0, goalTop);
    ctx.lineTo(-GOAL_DEPTH, goalTop);
    ctx.lineTo(-GOAL_DEPTH, goalTop + GOAL_HEIGHT);
    ctx.lineTo(0, goalTop + GOAL_HEIGHT);
    ctx.stroke();
    
    // Net pattern (Left)
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i <= GOAL_DEPTH; i += 10) {
        ctx.beginPath();
        ctx.moveTo(-i, goalTop);
        ctx.lineTo(-i, goalTop + GOAL_HEIGHT);
        ctx.stroke();
    }
    for (let i = 0; i <= GOAL_HEIGHT; i += 10) {
        ctx.beginPath();
        ctx.moveTo(0, goalTop + i);
        ctx.lineTo(-GOAL_DEPTH, goalTop + i);
        ctx.stroke();
    }

    // Right Goal
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'white';
    ctx.beginPath();
    ctx.moveTo(FIELD_WIDTH, goalTop);
    ctx.lineTo(FIELD_WIDTH + GOAL_DEPTH, goalTop);
    ctx.lineTo(FIELD_WIDTH + GOAL_DEPTH, goalTop + GOAL_HEIGHT);
    ctx.lineTo(FIELD_WIDTH, goalTop + GOAL_HEIGHT);
    ctx.stroke();

    // Net pattern (Right)
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i <= GOAL_DEPTH; i += 10) {
        ctx.beginPath();
        ctx.moveTo(FIELD_WIDTH + i, goalTop);
        ctx.lineTo(FIELD_WIDTH + i, goalTop + GOAL_HEIGHT);
        ctx.stroke();
    }
    for (let i = 0; i <= GOAL_HEIGHT; i += 10) {
        ctx.beginPath();
        ctx.moveTo(FIELD_WIDTH, goalTop + i);
        ctx.lineTo(FIELD_WIDTH + GOAL_DEPTH, goalTop + i);
        ctx.stroke();
    }
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
    drawField();

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
        resolvePlayerCollisions(); // Prevent overlapping
        ball.update(deltaTime);
        players.forEach(player => {
            player.update(ball, players, deltaTime);
        });

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
    } else {
        controls.style.display = 'none';
        isMobile = false;
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
