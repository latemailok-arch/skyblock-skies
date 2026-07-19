// Skyblock Skies - local-network Socket.io game server with NPC bots.
// Start with: npm install && node server.js
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Cloud hosts provide their own port; local play still defaults to 3000.
const PORT = Number(process.env.PORT) || 3000;
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAX_PLAYERS = 4;
const MAX_NPCS = 4;
const MAX_HEALTH = 100;
const RESPAWN_MS = 3000;
const NPC_RESPAWN_MS = 5000;
const BULLET_SPEED = 165;
const BULLET_LIFETIME = 1.9;
const HIT_RADIUS = 2.5;
const FIRE_COOLDOWN_MS = 145;
const NPC_FIRE_COOLDOWN_MS = 180;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// Exposes LAN addresses to the start screen. No internet connection is required.
function getLocalIPs() {
  const addresses = [];
  for (const adapters of Object.values(os.networkInterfaces())) {
    for (const network of adapters || []) {
      if (network.family === 'IPv4' && !network.internal) addresses.push(network.address);
    }
  }
  return addresses;
}
app.get('/api/network-info', (_request, response) => response.json({ port: PORT, addresses: getLocalIPs() }));

const players = new Map();
const npcs = new Map();
const bullets = [];
let nextBulletId = 1;
let nextNpcId = 1;

const spawns = [
  { x: -72, y: 30, z: 18 }, { x: 72, y: 30, z: -18 },
  { x: -25, y: 42, z: -72 }, { x: 25, y: 42, z: 72 },
  { x: -100, y: 50, z: 100 }, { x: 100, y: 50, z: -100 },
  { x: -100, y: 50, z: -100 }, { x: 100, y: 50, z: 100 }
];

// NPC Personality types for varied behavior
const NPC_PERSONALITIES = {
  AGGRESSIVE: { engageDist: 180, evadeDist: 80, aimError: 0.08, reactionDelay: 80, throttleAggression: 0.9, rollFrequency: 0.3 },
  DEFENSIVE: { engageDist: 250, evadeDist: 120, aimError: 0.15, reactionDelay: 150, throttleAggression: 0.4, rollFrequency: 0.15 },
  BALANCED: { engageDist: 200, evadeDist: 100, aimError: 0.12, reactionDelay: 110, throttleAggression: 0.6, rollFrequency: 0.22 },
  ERRATIC: { engageDist: 150, evadeDist: 60, aimError: 0.2, reactionDelay: 60, throttleAggression: 1.0, rollFrequency: 0.5 }
};

const NPC_STATES = {
  IDLE: 'IDLE',
  PATROL: 'PATROL',
  ENGAGE: 'ENGAGE',
  PURSUE: 'PURSUE',
  STRAFE: 'STRAFE',
  EVADE: 'EVADE',
  RETREAT: 'RETREAT'
};

function teamRotation(team) {
  const yaw = team === 'blue' ? Math.PI / 2 : -Math.PI / 2;
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function teamColor(team) {
  return team === 'blue' ? '#4f7895' : '#9a5a52';
}

function createPlayer(id) {
  const bluePilots = [...players.values()].filter((player) => player.team === 'blue').length;
  const redPilots = players.size - bluePilots;
  const team = bluePilots <= redPilots ? 'blue' : 'red';
  const spawn = spawns[players.size % spawns.length];
  return {
    id, team, color: teamColor(team), position: { ...spawn }, rotation: teamRotation(team),
    health: MAX_HEALTH, score: 0, deadUntil: 0, lastShotAt: 0
  };
}

function createNPC() {
  const npcId = `npc_${nextNpcId++}`;
  const blueNpcs = [...npcs.values()].filter((n) => n.team === 'blue').length;
  const redNpcs = npcs.size - blueNpcs;
  const team = blueNpcs <= redNpcs ? 'blue' : 'red';
  const spawn = spawns[(players.size + npcs.size) % spawns.length];
  const personalityKey = Object.keys(NPC_PERSONALITIES)[Math.floor(Math.random() * Object.keys(NPC_PERSONALITIES).length)];
  const personality = { ...NPC_PERSONALITIES[personalityKey] };
  // Add slight variation to each NPC
  for (const key of Object.keys(personality)) {
    personality[key] *= 0.85 + Math.random() * 0.3;
  }
  
  return {
    id: npcId, team, color: teamColor(team), position: { ...spawn }, rotation: teamRotation(team),
    health: MAX_HEALTH, score: 0, deadUntil: 0, lastShotAt: 0,
    isNPC: true, personality, state: NPC_STATES.PATROL,
    target: null, lastStateChange: Date.now(), lastTargetUpdate: 0,
    patrolPoint: null, patrolTimer: 0,
    reactionTimer: 0, aimOffset: { x: 0, y: 0, z: 0 },
    throttle: 65, desiredThrottle: 65,
    rollDirection: 0, rollTimer: 0
  };
}

function publicPlayer(player) {
  return {
    id: player.id, team: player.team, color: player.color, health: player.health, score: player.score,
    deadUntil: player.deadUntil, position: { ...player.position }, rotation: { ...player.rotation },
    isNPC: player.isNPC || false
  };
}

function isFiniteVector(value) {
  return value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]));
}

function unitVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 0.001) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

function vecSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vecAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vecScale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function quatToForward(q) {
  return {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y)
  };
}

function quatFromEuler(x, y, z) {
  const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz
  };
}

function quatSlerp(q1, q2, t) {
  let dot = q1.x * q2.x + q1.y * q2.y + q1.z * q2.z + q1.w * q2.w;
  let q2c = { ...q2 };
  if (dot < 0) { dot = -dot; q2c = { x: -q2.x, y: -q2.y, z: -q2.z, w: -q2.w }; }
  if (dot > 0.9995) return lerpQuat(q1, q2c, t);
  const theta0 = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const s1 = Math.sin((1 - t) * theta0) / sinTheta0;
  const s2 = Math.sin(t * theta0) / sinTheta0;
  return {
    x: q1.x * s1 + q2c.x * s2,
    y: q1.y * s1 + q2c.y * s2,
    z: q1.z * s1 + q2c.z * s2,
    w: q1.w * s1 + q2c.w * s2
  };
}

function lerpQuat(q1, q2, t) {
  return {
    x: q1.x + (q2.x - q1.x) * t,
    y: q1.y + (q2.y - q1.y) * t,
    z: q1.z + (q2.z - q1.z) * t,
    w: q1.w + (q2.w - q1.w) * t
  };
}

function respawn(player) {
  const spawn = spawns[Math.floor(Math.random() * spawns.length)];
  player.position = { ...spawn };
  player.rotation = teamRotation(player.team);
  player.health = MAX_HEALTH;
  player.deadUntil = 0;
  io.emit('playerRespawned', publicPlayer(player));
}

function respawnNPC(npc) {
  const spawn = spawns[Math.floor(Math.random() * spawns.length)];
  npc.position = { ...spawn };
  npc.rotation = teamRotation(npc.team);
  npc.health = MAX_HEALTH;
  npc.deadUntil = 0;
  npc.state = NPC_STATES.PATROL;
  npc.target = null;
  npc.patrolPoint = null;
  io.emit('npcRespawned', publicPlayer(npc));
}

function spawnBullet(shooter, origin, direction, isNPC = false) {
  const bullet = { id: nextBulletId++, ownerId: shooter.id, team: shooter.team, position: { ...origin }, direction, age: 0, isNPC };
  bullets.push(bullet);
  io.emit('bulletFired', bullet);
}

// NPC AI Functions
function getAllLivingPlayers() {
  const now = Date.now();
  return [...players.values(), ...npcs.values()].filter(p => !p.deadUntil || now < p.deadUntil);
}

function getEnemies(npc) {
  return getAllLivingPlayers().filter(p => p.team !== npc.team && p.id !== npc.id);
}

function getNearestEnemy(npc) {
  const enemies = getEnemies(npc);
  let nearest = null, nearestDist = Infinity;
  for (const enemy of enemies) {
    const d = distance(npc.position, enemy.position);
    if (d < nearestDist) { nearestDist = d; nearest = enemy; }
  }
  return { enemy: nearest, distance: nearestDist };
}

function getRandomPatrolPoint(npc) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 150 + Math.random() * 200;
  return {
    x: Math.cos(angle) * radius,
    y: 40 + Math.random() * 80,
    z: Math.sin(angle) * radius
  };
}

function updateNPCAI(npc, dt, now) {
  if (npc.deadUntil && now < npc.deadUntil) return;
  
  const enemies = getEnemies(npc);
  const { enemy: nearestEnemy, distance: nearestDist } = getNearestEnemy(npc);
  const p = npc.personality;
  
  // Reaction delay simulation
  if (npc.reactionTimer > 0) {
    npc.reactionTimer -= dt * 1000;
  }
  
  // State machine
  switch (npc.state) {
    case NPC_STATES.PATROL: {
      if (!npc.patrolPoint || npc.patrolTimer <= 0) {
        npc.patrolPoint = getRandomPatrolPoint(npc);
        npc.patrolTimer = 8000 + Math.random() * 12000;
      }
      npc.patrolTimer -= dt * 1000;
      
      if (nearestEnemy && nearestDist < p.engageDist && npc.reactionTimer <= 0) {
        npc.state = NPC_STATES.ENGAGE;
        npc.target = nearestEnemy.id;
        npc.lastStateChange = now;
        npc.reactionTimer = p.reactionDelay;
      }
      break;
    }
    
    case NPC_STATES.ENGAGE: {
      if (!nearestEnemy || nearestEnemy.id !== npc.target) {
        npc.target = nearestEnemy?.id || null;
      }
      
      if (!npc.target || nearestDist > p.engageDist * 1.3) {
        npc.state = NPC_STATES.PATROL;
        npc.target = null;
        break;
      }
      
      if (nearestDist < p.engageDist * 0.6) {
        npc.state = Math.random() < 0.5 ? NPC_STATES.STRAFE : NPC_STATES.PURSUE;
        npc.lastStateChange = now;
      }
      break;
    }
    
    case NPC_STATES.PURSUE: {
      if (!npc.target || nearestDist > p.engageDist) {
        npc.state = NPC_STATES.ENGAGE;
        break;
      }
      if (now - npc.lastStateChange > 3000 + Math.random() * 4000) {
        npc.state = NPC_STATES.STRAFE;
        npc.lastStateChange = now;
      }
      break;
    }
    
    case NPC_STATES.STRAFE: {
      if (!npc.target || nearestDist > p.engageDist * 1.2) {
        npc.state = NPC_STATES.ENGAGE;
        break;
      }
      if (npc.rollTimer <= 0 && Math.random() < p.rollFrequency * dt * 60) {
        npc.rollDirection = Math.random() < 0.5 ? -1 : 1;
        npc.rollTimer = 0.5 + Math.random() * 1.5;
      }
      npc.rollTimer -= dt;
      
      if (now - npc.lastStateChange > 4000 + Math.random() * 3000) {
        npc.state = NPC_STATES.ENGAGE;
        npc.lastStateChange = now;
      }
      break;
    }
    
    case NPC_STATES.EVADE: {
      if (nearestDist > p.evadeDist * 1.5 || !npc.target) {
        npc.state = NPC_STATES.ENGAGE;
        break;
      }
      if (now - npc.lastStateChange > 2000 + Math.random() * 2000) {
        npc.state = NPC_STATES.ENGAGE;
        npc.lastStateChange = now;
      }
      break;
    }
    
    case NPC_STATES.RETREAT: {
      if (npc.health > 40 || nearestDist > p.engageDist * 2) {
        npc.state = NPC_STATES.PATROL;
      }
      break;
    }
  }
  
  // Low health -> retreat
  if (npc.health < 30 && npc.state !== NPC_STATES.RETREAT && npc.state !== NPC_STATES.EVADE) {
    npc.state = NPC_STATES.RETREAT;
    npc.lastStateChange = now;
  }
  
  // Execute movement based on state
  executeNPCMovement(npc, dt, now, nearestEnemy, nearestDist);
}

function executeNPCMovement(npc, dt, now, nearestEnemy, nearestDist) {
  const forward = quatToForward(npc.rotation);
  const right = { x: -forward.z, y: 0, z: forward.x };
  const up = { x: 0, y: 1, z: 0 };
  
  let targetYaw = 0, targetPitch = 0, targetRoll = 0;
  let targetThrottle = npc.throttle;
  
  const p = npc.personality;
  
  switch (npc.state) {
    case NPC_STATES.PATROL: {
      if (npc.patrolPoint) {
        const toTarget = vecSub(npc.patrolPoint, npc.position);
        const dist = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
        if (dist > 10) {
          const desiredForward = unitVector(toTarget);
          if (desiredForward) {
            targetYaw = Math.atan2(-desiredForward.x, -desiredForward.z);
            targetPitch = Math.asin(Math.max(-1, Math.min(1, desiredForward.y)));
          }
        }
      }
      targetThrottle = 65 + p.throttleAggression * 20;
      break;
    }
    
    case NPC_STATES.ENGAGE:
    case NPC_STATES.PURSUE: {
      if (nearestEnemy) {
        const toEnemy = vecSub(nearestEnemy.position, npc.position);
        const desiredForward = unitVector(toEnemy);
        if (desiredForward) {
          // Add aim error for human-like imperfection
          const error = p.aimError;
          const errorVec = {
            x: (Math.random() - 0.5) * error,
            y: (Math.random() - 0.5) * error * 0.5,
            z: (Math.random() - 0.5) * error
          };
          const adjustedForward = unitVector(vecAdd(desiredForward, errorVec));
          if (adjustedForward) {
            targetYaw = Math.atan2(-adjustedForward.x, -adjustedForward.z);
            targetPitch = Math.asin(Math.max(-1, Math.min(1, adjustedForward.y)));
          }
        }
        
        if (npc.state === NPC_STATES.PURSUE) {
          targetThrottle = Math.min(150, 80 + p.throttleAggression * 50);
        } else {
          targetThrottle = 70 + p.throttleAggression * 30;
        }
      }
      break;
    }
    
    case NPC_STATES.STRAFE: {
      if (nearestEnemy) {
        const toEnemy = vecSub(nearestEnemy.position, npc.position);
        const desiredForward = unitVector(toEnemy);
        if (desiredForward) {
          targetYaw = Math.atan2(-desiredForward.x, -desiredForward.z);
          targetPitch = Math.asin(Math.max(-1, Math.min(1, desiredForward.y)));
        }
        targetThrottle = 75;
        targetRoll = npc.rollDirection * 0.8;
      }
      break;
    }
    
    case NPC_STATES.EVADE: {
      if (nearestEnemy) {
        const away = vecSub(npc.position, nearestEnemy.position);
        const perp = { x: -away.z, y: 0, z: away.x };
        const evadeDir = unitVector(vecAdd(vecScale(away, 0.7), vecScale(perp, 0.3 * (Math.random() < 0.5 ? 1 : -1))));
        if (evadeDir) {
          targetYaw = Math.atan2(-evadeDir.x, -evadeDir.z);
          targetPitch = Math.asin(Math.max(-1, Math.min(1, evadeDir.y)));
        }
      }
      targetThrottle = 120;
      targetRoll = (Math.random() - 0.5) * 1.2;
      break;
    }
    
    case NPC_STATES.RETREAT: {
      const safeY = 120;
      const toSafe = { x: -npc.position.x * 0.3, y: safeY - npc.position.y, z: -npc.position.z * 0.3 };
      const dir = unitVector(toSafe);
      if (dir) {
        targetYaw = Math.atan2(-dir.x, -dir.z);
        targetPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      }
      targetThrottle = 100;
      break;
    }
  }
  
  // Smooth throttle
  npc.throttle += (targetThrottle - npc.throttle) * Math.min(1, dt * 3);
  npc.throttle = Math.max(35, Math.min(150, npc.throttle));
  
  // Apply rotation with smoothing (simulate human control limits)
  const maxYawRate = 1.2 * (1 + p.throttleAggression * 0.3);
  const maxPitchRate = 1.0;
  const maxRollRate = 1.5;
  
  // Convert current rotation to euler
  const q = npc.rotation;
  const sinr_cosp = 2 * (q.w * q.x + q.y * q.z);
  const cosr_cosp = 1 - 2 * (q.x * q.x + q.y * q.y);
  const currentRoll = Math.atan2(sinr_cosp, cosr_cosp);
  
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  const currentPitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  
  const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
  const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  const currentYaw = Math.atan2(siny_cosp, cosy_cosp);
  
  // Smooth rotation
  let newYaw = currentYaw, newPitch = currentPitch, newRoll = currentRoll;
  
  // Yaw
  let yawDiff = targetYaw - currentYaw;
  while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
  while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
  newYaw = currentYaw + Math.max(-maxYawRate * dt, Math.min(maxYawRate * dt, yawDiff));
  
  // Pitch
  let pitchDiff = targetPitch - currentPitch;
  newPitch = currentPitch + Math.max(-maxPitchRate * dt, Math.min(maxPitchRate * dt, pitchDiff));
  newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, newPitch));
  
  // Roll
  let rollDiff = targetRoll - currentRoll;
  newRoll = currentRoll + Math.max(-maxRollRate * dt, Math.min(maxRollRate * dt, rollDiff));
  newRoll = Math.max(-0.9, Math.min(0.9, newRoll));
  
  npc.rotation = quatFromEuler(newPitch, newYaw, newRoll);
  
  // Update position based on throttle and forward vector
  const newForward = quatToForward(npc.rotation);
  npc.position.x += newForward.x * npc.throttle * dt;
  npc.position.y += newForward.y * npc.throttle * dt;
  npc.position.z += newForward.z * npc.throttle * dt;
  
  // World bounds
  npc.position.x = Math.max(-900, Math.min(900, npc.position.x));
  npc.position.y = Math.max(4, Math.min(550, npc.position.y));
  npc.position.z = Math.max(-900, Math.min(900, npc.position.z));
  
  // Shooting logic
  if (nearestEnemy && (npc.state === NPC_STATES.ENGAGE || npc.state === NPC_STATES.PURSUE || npc.state === NPC_STATES.STRAFE)) {
    const toEnemy = vecSub(nearestEnemy.position, npc.position);
    const enemyDist = Math.hypot(toEnemy.x, toEnemy.y, toEnemy.z);
    const forward = quatToForward(npc.rotation);
    const dot = (forward.x * toEnemy.x + forward.y * toEnemy.y + forward.z * toEnemy.z) / enemyDist;
    
    if (dot > 0.92 && enemyDist < 250 && now - npc.lastShotAt >= NPC_FIRE_COOLDOWN_MS) {
      // Add spread to shot
      const spread = p.aimError * 0.5;
      const shotDir = unitVector(vecAdd(forward, {
        x: (Math.random() - 0.5) * spread,
        y: (Math.random() - 0.5) * spread * 0.5,
        z: (Math.random() - 0.5) * spread
      }));
      
      if (shotDir) {
        const origin = vecAdd(npc.position, vecScale(shotDir, 3.25));
        spawnBullet(npc, origin, shotDir, true);
        npc.lastShotAt = now;
      }
    }
  }
}

function applyNPCDamage(npc, damage, shooterId) {
  npc.health = Math.max(0, npc.health - damage);
  const shooter = players.get(shooterId) || npcs.get(shooterId);
  io.emit('playerHit', { victimId: npc.id, health: npc.health, shooterId });
  
  // Trigger evade state on hit
  if (npc.health > 0 && npc.state !== NPC_STATES.EVADE && npc.state !== NPC_STATES.RETREAT) {
    npc.state = NPC_STATES.EVADE;
    npc.lastStateChange = Date.now();
    npc.reactionTimer = npc.personality.reactionDelay;
  }
  
  if (npc.health === 0) {
    npc.deadUntil = Date.now() + NPC_RESPAWN_MS;
    if (shooter) shooter.score += 1;
    io.emit('playerDestroyed', { victimId: npc.id, shooterId, respawnAt: npc.deadUntil });
  }
}

function spawnNPCs() {
  while (npcs.size < MAX_NPCS) {
    const npc = createNPC();
    npcs.set(npc.id, npc);
    io.emit('npcSpawned', publicPlayer(npc));
  }
}

io.on('connection', (socket) => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  const player = createPlayer(socket.id);
  players.set(socket.id, player);
  socket.emit('welcome', { id: socket.id, player: publicPlayer(player), players: [...players.values()].map(publicPlayer), npcs: [...npcs.values()].map(publicPlayer), maxHealth: MAX_HEALTH });
  socket.broadcast.emit('playerJoined', publicPlayer(player));

  // Flight is client-predicted for responsive controls. The server keeps a clamped copy for hit detection.
  socket.on('state', (state) => {
    const current = players.get(socket.id);
    if (!current || current.deadUntil || !state || !isFiniteVector(state.position)) return;
    current.position.x = Math.max(-900, Math.min(900, state.position.x));
    current.position.y = Math.max(4, Math.min(550, state.position.y));
    current.position.z = Math.max(-900, Math.min(900, state.position.z));
    if (state.rotation && ['x', 'y', 'z', 'w'].every((key) => Number.isFinite(state.rotation[key]))) {
      current.rotation = { x: state.rotation.x, y: state.rotation.y, z: state.rotation.z, w: state.rotation.w };
    }
  });

  socket.on('shoot', (shot) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.deadUntil || !shot || !isFiniteVector(shot.origin) || !isFiniteVector(shot.direction)) return;
    const now = Date.now();
    if (now - shooter.lastShotAt < FIRE_COOLDOWN_MS) return;
    const direction = unitVector(shot.direction);
    if (!direction) return;
    const dx = shot.origin.x - shooter.position.x;
    const dy = shot.origin.y - shooter.position.y;
    const dz = shot.origin.z - shooter.position.z;
    // Bullets must originate near the server's known aircraft position.
    if (Math.hypot(dx, dy, dz) > 9) return;
    shooter.lastShotAt = now;
    spawnBullet(shooter, shot.origin, direction);
  });

  socket.on('disconnect', () => {
    if (players.delete(socket.id)) io.emit('playerLeft', socket.id);
  });
});

setInterval(() => {
  const now = Date.now();
  const dt = 1 / TICK_RATE;
  
  // Update player respawns
  for (const player of players.values()) {
    if (player.deadUntil && now >= player.deadUntil) respawn(player);
  }
  
  // Spawn NPCs if needed
  spawnNPCs();
  
  // Update NPC AI
  for (const npc of npcs.values()) {
    if (npc.deadUntil && now >= npc.deadUntil) {
      respawnNPC(npc);
    } else if (!npc.deadUntil || now >= npc.deadUntil) {
      updateNPCAI(npc, dt, now);
    }
  }

  // Update bullets
  for (let index = bullets.length - 1; index >= 0; index--) {
    const bullet = bullets[index];
    bullet.age += dt;
    bullet.position.x += bullet.direction.x * BULLET_SPEED * dt;
    bullet.position.y += bullet.direction.y * BULLET_SPEED * dt;
    bullet.position.z += bullet.direction.z * BULLET_SPEED * dt;

    let victim = null;
    let victimIsNPC = false;
    
    // Check player collisions
    for (const player of players.values()) {
      if (player.id === bullet.ownerId || player.team === bullet.team || player.deadUntil) continue;
      const dx = player.position.x - bullet.position.x;
      const dy = player.position.y - bullet.position.y;
      const dz = player.position.z - bullet.position.z;
      if (dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS) { victim = player; break; }
    }
    
    // Check NPC collisions (if not hit player already)
    if (!victim) {
      for (const npc of npcs.values()) {
        if (npc.id === bullet.ownerId || npc.team === bullet.team || npc.deadUntil) continue;
        const dx = npc.position.x - bullet.position.x;
        const dy = npc.position.y - bullet.position.y;
        const dz = npc.position.z - bullet.position.z;
        if (dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS) { victim = npc; victimIsNPC = true; break; }
      }
    }

    if (victim) {
      if (victimIsNPC) {
        applyNPCDamage(victim, 25, bullet.ownerId);
      } else {
        victim.health = Math.max(0, victim.health - 25);
        const shooter = players.get(bullet.ownerId) || npcs.get(bullet.ownerId);
        io.emit('playerHit', { victimId: victim.id, health: victim.health, shooterId: bullet.ownerId });
        if (victim.health === 0) {
          victim.deadUntil = now + RESPAWN_MS;
          if (shooter) shooter.score += 1;
          io.emit('playerDestroyed', { victimId: victim.id, shooterId: bullet.ownerId, respawnAt: victim.deadUntil });
        }
      }
      bullets.splice(index, 1);
    } else if (bullet.age >= BULLET_LIFETIME) {
      bullets.splice(index, 1);
    }
  }

  // A 60Hz snapshot is intentionally simple: local planes use prediction; remote planes interpolate it.
  io.emit('snapshot', [...players.values()].map(publicPlayer), [...npcs.values()].map(publicPlayer));
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Skyblock Skies is running on http://localhost:${PORT}`);
  console.log(`LAN URL(s): ${getLocalIPs().map((ip) => `http://${ip}:${PORT}`).join(', ') || 'not found'}`);
  console.log(`NPC Bots: ${MAX_NPCS} active`);
});