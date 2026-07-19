// Skyblock Skies - local-network Socket.io game server.
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
const MAX_HEALTH = 100;
const RESPAWN_MS = 3000;
const BULLET_SPEED = 165;
const BULLET_LIFETIME = 1.9;
const HIT_RADIUS = 2.5;
const FIRE_COOLDOWN_MS = 145;

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
const bullets = [];
let nextBulletId = 1;

const spawns = [
  { x: -72, y: 30, z: 18 }, { x: 72, y: 30, z: -18 },
  { x: -25, y: 42, z: -72 }, { x: 25, y: 42, z: 72 }
];

function teamRotation(team) {
  const yaw = team === 'blue' ? Math.PI / 2 : -Math.PI / 2;
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function teamColor(team) {
  // Cool gunmetal blue vs. warm titanium red rather than flat arcade colors.
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

function publicPlayer(player) {
  return {
    id: player.id, team: player.team, color: player.color, health: player.health, score: player.score,
    deadUntil: player.deadUntil, position: { ...player.position }, rotation: { ...player.rotation }
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

function respawn(player) {
  const spawn = spawns[Math.floor(Math.random() * spawns.length)];
  player.position = { ...spawn };
  player.rotation = teamRotation(player.team);
  player.health = MAX_HEALTH;
  player.deadUntil = 0;
  io.emit('playerRespawned', publicPlayer(player));
}

function spawnBullet(shooter, origin, direction) {
  const bullet = { id: nextBulletId++, ownerId: shooter.id, team: shooter.team, position: { ...origin }, direction, age: 0 };
  bullets.push(bullet);
  io.emit('bulletFired', bullet);
}

io.on('connection', (socket) => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  const player = createPlayer(socket.id);
  players.set(socket.id, player);
  socket.emit('welcome', { id: socket.id, player: publicPlayer(player), players: [...players.values()].map(publicPlayer), maxHealth: MAX_HEALTH });
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
  for (const player of players.values()) {
    if (player.deadUntil && now >= player.deadUntil) respawn(player);
  }

  for (let index = bullets.length - 1; index >= 0; index--) {
    const bullet = bullets[index];
    bullet.age += 1 / TICK_RATE;
    bullet.position.x += bullet.direction.x * BULLET_SPEED / TICK_RATE;
    bullet.position.y += bullet.direction.y * BULLET_SPEED / TICK_RATE;
    bullet.position.z += bullet.direction.z * BULLET_SPEED / TICK_RATE;

    let victim = null;
    for (const player of players.values()) {
      if (player.id === bullet.ownerId || player.team === bullet.team || player.deadUntil) continue;
      const dx = player.position.x - bullet.position.x;
      const dy = player.position.y - bullet.position.y;
      const dz = player.position.z - bullet.position.z;
      if (dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS) { victim = player; break; }
    }

    if (victim) {
      victim.health = Math.max(0, victim.health - 25);
      const shooter = players.get(bullet.ownerId);
      io.emit('playerHit', { victimId: victim.id, health: victim.health, shooterId: bullet.ownerId });
      if (victim.health === 0) {
        victim.deadUntil = now + RESPAWN_MS;
        if (shooter) shooter.score += 1;
        io.emit('playerDestroyed', { victimId: victim.id, shooterId: bullet.ownerId, respawnAt: victim.deadUntil });
      }
      bullets.splice(index, 1);
    } else if (bullet.age >= BULLET_LIFETIME) {
      bullets.splice(index, 1);
    }
  }

  // A 60Hz snapshot is intentionally simple: local planes use prediction; remote planes interpolate it.
  io.emit('snapshot', [...players.values()].map(publicPlayer));
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Skyblock Skies is running on http://localhost:${PORT}`);
  console.log(`LAN URL(s): ${getLocalIPs().map((ip) => `http://${ip}:${PORT}`).join(', ') || 'not found'}`);
});
