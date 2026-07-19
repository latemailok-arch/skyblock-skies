import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

const socket = io();
const TICK_RATE = 60;
const MAX_HEALTH = 100;
const FORWARD = new THREE.Vector3(0, 0, -1);
const COCKPIT_OFFSET = new THREE.Vector3(0, 0.48, -1.65);
const isTouchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#78b9e4');
scene.fog = new THREE.Fog('#78b9e4', 280, 1150);
const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight('#dff5ff', '#385f36', 2.1));
const sunlight = new THREE.DirectionalLight('#fff8dd', 2.5);
sunlight.position.set(110, 180, -90); sunlight.castShadow = true; scene.add(sunlight);

const terrain = new THREE.Group(); scene.add(terrain);
function createBlockyWorld() {
  const grass = new THREE.MeshStandardMaterial({ color: '#4a954d', roughness: 1 });
  const dirt = new THREE.MeshStandardMaterial({ color: '#6d492f', roughness: 1 });
  const stone = new THREE.MeshStandardMaterial({ color: '#6f7b80', roughness: .95 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), grass);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; terrain.add(ground);
  const grid = new THREE.GridHelper(1800, 90, '#a3d987', '#4d804c'); grid.position.y = .02; grid.material.transparent = true; grid.material.opacity = .28; terrain.add(grid);
  // Chunky terrain landmarks help pilots orient themselves without external assets.
  const landmarks = [[-145,-100,40,85], [125,-150,35,62], [-185,95,55,110], [165,105,42,74], [-55,205,31,56], [42,-230,38,80], [235,15,48,100], [-230,10,33,66]];
  landmarks.forEach(([x, z, width, height], index) => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), index % 2 ? dirt : stone);
    base.position.set(x, height / 2, z); base.castShadow = base.receiveShadow = true; terrain.add(base);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 3, 7, width + 3), grass);
    cap.position.set(x, height + 3.5, z); cap.castShadow = cap.receiveShadow = true; terrain.add(cap);
  });
  const beaconMaterial = new THREE.MeshStandardMaterial({ color: '#e4ed98', emissive: '#d6e44a', emissiveIntensity: 1.8 });
  [[0,0], [300,250], [-300,-250]].forEach(([x,z]) => {
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 62, 8), beaconMaterial);
    beacon.position.set(x, 31, z); beacon.castShadow = true; terrain.add(beacon);
  });
}
createBlockyWorld();

const menu = document.querySelector('#menu');
const startButton = document.querySelector('#start-game');
const menuStatus = document.querySelector('#menu-status');
const hud = document.querySelector('#hud');
const touchControls = document.querySelector('#touch-controls');
const toast = document.querySelector('#toast');
const keys = new Set();
const remotePlayers = new Map();
const bullets = [];
const scratchForward = new THREE.Vector3();
const scratchCameraOffset = new THREE.Vector3();

let localId = null;
let localPlayer = null;
let health = MAX_HEALTH;
let score = 0;
let gameStarted = false;
let lastShot = 0;
let lastStateSent = 0;
let currentBank = 0;
let targetBank = 0;
let touchAim = { x: 0, y: 0 };
let fireHeld = false;
let toastUntil = 0;
let previousTime = performance.now();
let touchControlsReady = false;

function createWing(side, material) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.9);
  shape.lineTo(side * 5.4, 0.15);
  shape.lineTo(side * 4.25, -1.4);
  shape.lineTo(side * 0.55, -0.45);
  shape.lineTo(0, -1.15);
  shape.closePath();
  const wing = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  wing.rotation.x = -Math.PI / 2;
  wing.position.z = .45;
  return wing;
}

function createFighterJet(color) {
  const jet = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color, metalness: .72, roughness: .28 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: '#202a30', metalness: .85, roughness: .2 });
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: '#6ca1af', metalness: .55, roughness: .08, transparent: true, opacity: .77 });
  const exhaustMaterial = new THREE.MeshStandardMaterial({ color: '#d6823c', emissive: '#c64d14', emissiveIntensity: 1.8, metalness: .3 });
  const add = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; jet.add(mesh); return mesh; };

  // The fuselage, separate engine, pointed nose, swept wings, stabilizers, and fins form a modern fighter silhouette.
  const fuselage = add(new THREE.Mesh(new THREE.CylinderGeometry(.78, .63, 7.2, 14), hull));
  fuselage.rotation.x = Math.PI / 2;
  const nose = add(new THREE.Mesh(new THREE.ConeGeometry(.79, 2.9, 14), hull));
  nose.rotation.x = -Math.PI / 2; nose.position.z = -5.0;
  const intake = add(new THREE.Mesh(new THREE.CylinderGeometry(.42, .65, 1.25, 14), darkMetal));
  intake.rotation.x = Math.PI / 2; intake.position.set(0, -.18, 3.96);
  const exhaust = add(new THREE.Mesh(new THREE.CylinderGeometry(.4, .52, .45, 12), exhaustMaterial));
  exhaust.rotation.x = Math.PI / 2; exhaust.position.z = 4.75;
  add(createWing(1, hull)); add(createWing(-1, hull));
  const stabilizerLeft = add(new THREE.Mesh(new THREE.BoxGeometry(2.1, .11, .76), hull));
  stabilizerLeft.position.set(-1.1, .12, 3.1); stabilizerLeft.rotation.y = -.25;
  const stabilizerRight = add(new THREE.Mesh(new THREE.BoxGeometry(2.1, .11, .76), hull));
  stabilizerRight.position.set(1.1, .12, 3.1); stabilizerRight.rotation.y = .25;
  const finLeft = add(new THREE.Mesh(new THREE.BoxGeometry(.13, 1.75, 1.25), hull));
  finLeft.position.set(-.43, 1.0, 2.8); finLeft.rotation.z = -.19;
  const finRight = add(new THREE.Mesh(new THREE.BoxGeometry(.13, 1.75, 1.25), hull));
  finRight.position.set(.43, 1.0, 2.8); finRight.rotation.z = .19;
  const canopy = add(new THREE.Mesh(new THREE.SphereGeometry(.72, 16, 10), canopyMaterial));
  canopy.scale.set(.85, .5, 1.6); canopy.position.set(0, .47, -1.4);
  for (const side of [-1, 1]) {
    const missile = add(new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, 2.15, 8), darkMetal));
    missile.rotation.x = Math.PI / 2; missile.position.set(side * 2.8, -.18, .1);
  }
  return jet;
}

function makeRemote(player) {
  const mesh = createFighterJet(player.color);
  const remote = { mesh, targetPosition: new THREE.Vector3(), targetQuaternion: new THREE.Quaternion(), player };
  scene.add(mesh); remotePlayers.set(player.id, remote); updateRemote(remote, player, true);
}

function updateRemote(remote, player, snap = false) {
  remote.player = player;
  remote.targetPosition.set(player.position.x, player.position.y, player.position.z);
  remote.targetQuaternion.set(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w);
  if (snap) { remote.mesh.position.copy(remote.targetPosition); remote.mesh.quaternion.copy(remote.targetQuaternion); }
  remote.mesh.visible = !player.deadUntil;
}

function applyPlayer(player, snap = false) {
  if (player.id === localId) {
    score = player.score; health = player.health; updateHud();
    if (snap && localPlayer) {
      localPlayer.mesh.position.set(player.position.x, player.position.y, player.position.z);
      localPlayer.mesh.quaternion.set(player.rotation.x, player.rotation.y, player.rotation.z, player.rotation.w);
      localPlayer.velocity = 65; currentBank = 0; targetBank = 0;
    }
    return;
  }
  if (!remotePlayers.has(player.id)) makeRemote(player);
  updateRemote(remotePlayers.get(player.id), player, snap);
}

function removeRemote(id) {
  const remote = remotePlayers.get(id);
  if (remote) { scene.remove(remote.mesh); remotePlayers.delete(id); }
}

function spawnBullet(data) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(.13, 8, 8), new THREE.MeshBasicMaterial({ color: '#fff2a8' }));
  mesh.position.set(data.position.x, data.position.y, data.position.z); scene.add(mesh);
  bullets.push({ mesh, direction: new THREE.Vector3(data.direction.x, data.direction.y, data.direction.z), age: 0 });
}

function updateHud() {
  document.querySelector('#health').textContent = health;
  document.querySelector('#score').textContent = score;
  document.querySelector('#team').textContent = localPlayer ? localPlayer.player.team.toUpperCase() : '—';
  const fill = document.querySelector('#health-fill'); fill.style.width = `${health}%`;
  fill.style.background = health > 50 ? '#7ddd44' : health > 25 ? '#e9cc4b' : '#e0473e';
  document.querySelector('#throttle').textContent = localPlayer ? Math.round(((localPlayer.velocity - 35) / 115) * 100) : '0';
}

function setToast(text, duration = 1800) { toast.textContent = text; toastUntil = performance.now() + duration; }

async function showLanUrl() {
  try {
    const info = await fetch('/api/network-info').then((response) => response.json());
    document.querySelector('#lan-url').textContent = info.addresses.length ? info.addresses.map((ip) => `http://${ip}:${info.port}`).join('  OR  ') : 'Use your computer IPv4 address with :3000';
  } catch { document.querySelector('#lan-url').textContent = 'Use http://YOUR-COMPUTER-IP:3000'; }
}

function beginGame() {
  if (!localPlayer) { menuStatus.textContent = 'Still connecting…'; return; }
  gameStarted = true; menu.classList.add('hidden'); hud.classList.add('show');
  if (isTouchDevice) { touchControls.classList.add('show'); setupTouchControls(); }
  else renderer.domElement.requestPointerLock?.();
  setToast(isTouchDevice ? 'USE THE STICK TO FLY · HOLD FIRE TO SHOOT' : 'CLICK TO CAPTURE MOUSE · HUNT THE OTHER JET', 2600);
}

function setupTouchControls() {
  if (!isTouchDevice || !window.nipplejs || touchControlsReady) return;
  touchControlsReady = true;
  const joystick = nipplejs.create({ zone: document.querySelector('#joystick-zone'), mode: 'static', position: { left: '50%', top: '50%' }, color: 'white', size: 105 });
  joystick.on('move', (_event, data) => { touchAim.x = data.vector.x; touchAim.y = data.vector.y; });
  joystick.on('end', () => { touchAim = { x: 0, y: 0 }; });
  const fireButton = document.querySelector('#fire-button');
  fireButton.addEventListener('pointerdown', (event) => { event.preventDefault(); fireHeld = true; fireButton.setPointerCapture?.(event.pointerId); shoot(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => fireButton.addEventListener(type, () => { fireHeld = false; }));
}
showLanUrl();

startButton.addEventListener('click', beginGame);
renderer.domElement.addEventListener('click', () => {
  if (gameStarted && !isTouchDevice && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  if (gameStarted && !isTouchDevice && document.pointerLockElement !== renderer.domElement) setToast('MOUSE RELEASED — CLICK TO AIM', 2200);
});
document.addEventListener('mousemove', (event) => {
  if (!gameStarted || isTouchDevice || document.pointerLockElement !== renderer.domElement || !localPlayer || health <= 0) return;
  localPlayer.mesh.rotateY(-event.movementX * .0023);
  localPlayer.mesh.rotateX(-event.movementY * .0018);
  targetBank = THREE.MathUtils.clamp(targetBank - event.movementX * .004, -.72, .72);
});

addEventListener('keydown', (event) => {
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.code === 'Space') shoot();
});
addEventListener('keyup', (event) => keys.delete(event.code));
addEventListener('mousedown', (event) => { if (event.button === 0 && gameStarted && !isTouchDevice) shoot(); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

function shoot() {
  if (!gameStarted || !localPlayer || health <= 0 || performance.now() - lastShot < 145) return;
  lastShot = performance.now();
  const direction = FORWARD.clone().applyQuaternion(localPlayer.mesh.quaternion).normalize();
  const origin = localPlayer.mesh.position.clone().addScaledVector(direction, 3.25);
  socket.emit('shoot', { origin, direction });
}

function updateFlight(dt) {
  if (!gameStarted || !localPlayer || health <= 0) return;
  const jet = localPlayer.mesh;
  const throttleChange = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  localPlayer.velocity = THREE.MathUtils.clamp(localPlayer.velocity + throttleChange * 45 * dt, 35, 150);

  // Touch input steers yaw/pitch; a mouse updates these axes in its event handler above.
  if (isTouchDevice) {
    jet.rotateY(-touchAim.x * 1.15 * dt);
    jet.rotateX(touchAim.y * .9 * dt);
    targetBank = THREE.MathUtils.lerp(targetBank, -touchAim.x * .58, 1 - Math.exp(-7 * dt));
  }
  const manualRoll = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
  targetBank = THREE.MathUtils.clamp(targetBank + manualRoll * 1.4 * dt, -.82, .82);
  targetBank *= Math.exp(-2.6 * dt);
  const rollStep = (targetBank - currentBank) * (1 - Math.exp(-8 * dt));
  jet.rotateZ(rollStep); currentBank += rollStep;

  scratchForward.copy(FORWARD).applyQuaternion(jet.quaternion);
  jet.position.addScaledVector(scratchForward, localPlayer.velocity * dt);
  jet.position.y = Math.max(5, jet.position.y);
  updateHud();
  if (fireHeld) shoot();
}

function updateCamera() {
  if (!localPlayer) return;
  // Strict pilot POV: the camera shares the jet rotation and lives inside its canopy/nose.
  scratchCameraOffset.copy(COCKPIT_OFFSET).applyQuaternion(localPlayer.mesh.quaternion);
  camera.position.copy(localPlayer.mesh.position).add(scratchCameraOffset);
  camera.quaternion.copy(localPlayer.mesh.quaternion);
}

socket.on('welcome', ({ id, player, players }) => {
  localId = id;
  localPlayer = { player, mesh: createFighterJet(player.color), velocity: 65 };
  // The local aircraft is still the flight transform, but hidden so it cannot block the pilot's view.
  localPlayer.mesh.visible = false; scene.add(localPlayer.mesh);
  applyPlayer(player, true); (players || []).forEach((other) => applyPlayer(other, true));
  menuStatus.textContent = `HANGAR READY · ${players?.length || 1}/4 PILOTS CONNECTED`;
  startButton.textContent = 'START GAME'; updateHud();
});
socket.on('playerJoined', (player) => { if (player.id !== localId) applyPlayer(player, true); });
socket.on('playerLeft', removeRemote);
socket.on('snapshot', (players) => players.forEach((player) => applyPlayer(player)));
socket.on('bulletFired', spawnBullet);
socket.on('playerHit', ({ victimId, health: updatedHealth }) => { if (victimId === localId) { health = updatedHealth; updateHud(); } });
socket.on('playerDestroyed', ({ victimId, shooterId }) => {
  if (victimId === localId) setToast('JET DESTROYED — RESPAWNING', 3000);
  if (shooterId === localId) { score += 1; updateHud(); setToast('TARGET SPLASHED!', 1200); }
});
socket.on('playerRespawned', (player) => {
  if (player.id === localId) { health = player.health; applyPlayer(player, true); setToast('RESPAWNED — BACK IN THE FIGHT', 1400); }
  else applyPlayer(player, true);
});
socket.on('serverFull', () => { menuStatus.textContent = 'HANGAR FULL — FOUR PILOTS MAX'; startButton.disabled = true; });

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - previousTime) / 1000, .05); previousTime = now;
  updateFlight(dt); updateCamera();
  for (const remote of remotePlayers.values()) {
    remote.mesh.position.lerp(remote.targetPosition, 1 - Math.exp(-14 * dt));
    remote.mesh.quaternion.slerp(remote.targetQuaternion, 1 - Math.exp(-14 * dt));
  }
  for (let index = bullets.length - 1; index >= 0; index--) {
    const bullet = bullets[index]; bullet.age += dt; bullet.mesh.position.addScaledVector(bullet.direction, 165 * dt);
    if (bullet.age > 1.9) { scene.remove(bullet.mesh); bullets.splice(index, 1); }
  }
  if (gameStarted && localPlayer && health > 0 && now - lastStateSent > 1000 / TICK_RATE) {
    lastStateSent = now;
    socket.emit('state', { position: localPlayer.mesh.position, rotation: localPlayer.mesh.quaternion });
  }
  if (toastUntil && now > toastUntil) { toast.textContent = ''; toastUntil = 0; }
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
