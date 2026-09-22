/**
 * ChainMind Virtual Space
 * -----------------------------------------------------------------
 * A third-person 3D office. Each teammate is a simple capsule-body
 * avatar with a "head" that is a camera-facing sprite. When someone's
 * webcam is on, their live video is drawn onto a canvas each frame and
 * used as that sprite's texture (center-cropped to a square), so their
 * actual face rides around on the avatar's head instead of a static
 * icon. Movement is WASD/arrow keys; drag the mouse to look around.
 *
 * NOTE ON ICE/TURN: see the comment in realtime-server/server.js.
 * Add your TURN server credentials to ICE_SERVERS below before relying
 * on this for real-world users behind restrictive NATs/firewalls.
 */
import * as THREE from 'three';

// Keep ICE light. A long public TURN list makes every call gather several
// extra candidates and can overwhelm the PHP signaling endpoint on modest
// hosting. Add one private TURN server here for users behind strict NAT.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MEDIA_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: {
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
    frameRate: { ideal: 15, max: 20 },
    facingMode: 'user',
  },
};

const MOVE_SPEED = 4.2; // units/sec

let renderer, scene, camera, clock;
let socket = null;
let localAvatar = null;
let localHeadCanvas, localHeadCtx, localHeadTexture;
let localHeadSprite = null;
let localVideoSprite = null;
let localIdleColor = '#4b7891';
let localIdleInitials = '?';
let localStream = null;
let localVideoEl = null;
let inGroupCall = false;
let groupCallRoomId = 'space-global';

const remoteAvatars = new Map();   // userId -> { group, headCanvas, headCtx, headTexture, videoEl }
const peerConnections = new Map(); // userId -> RTCPeerConnection
const directory = new Map();       // userId -> title (from backend/api/avatars.php?action=roster)
const offices = [];                // built once in initScene(); see buildOffices()
const colliders = [];              // simple 2D AABBs for avatar movement

// Six small offices along the back of the space. The three "department"
// rooms get multiple desks — one per teammate whose title matches, filled
// in live as people join/leave. The other three are single-occupant
// executive offices. Matching is by title keyword since that's all the
// backend currently tracks per-person; edit these patterns to fit your
// actual job titles.
const OFFICE_DEFS = [
  { id: 'md',       label: 'MD Office',                  width: 5, deskCount: 1, building: 'leadership', match: [/\bmd\b/i, /managing director/i] },
  { id: 'digital',  label: 'Head of Digital Innovation',  width: 5, deskCount: 1, building: 'leadership', match: [/digital innovation/i] },
  { id: 'backend',  label: 'Backend Development',         width: 7, deskCount: 3, building: 'technology', match: [/backend/i] },
  { id: 'frontend', label: 'Frontend Development',        width: 7, deskCount: 3, building: 'technology', match: [/front[\s-]?end/i] },
  { id: 'cloud',    label: 'Cloud & Web3 Development',    width: 7, deskCount: 3, building: 'technology', match: [/cloud/i, /web\s?3/i] },
  { id: 'legal',    label: 'Legal Office',                width: 5, deskCount: 1, building: 'leadership', match: [/legal/i] },
];
const OFFICE_ROW_Z = -20;
const OFFICE_DEPTH = 6;
const OFFICE_GAP = 1.2;
const DOOR_WIDTH = 1.6;
const WALL_HEIGHT = 3;
const PLAYER_RADIUS = 0.42;
const WORLD_LIMIT = 28;

const keys = { w: false, a: false, s: false, d: false };
let yaw = 0, pitch = -0.12, dragging = false, lastX = 0, lastY = 0;

function initScene() {
  const canvas = document.getElementById('cm-space-canvas');
  // The space is intentionally a lightweight scene: no shadows, no post
  // processing, and a capped pixel ratio keep laptops and phones responsive.
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  scene = new THREE.Scene();
  // Warm daylight and a little atmospheric haze make the space feel like a
  // stylized game map instead of a neon sci-fi lobby.
  scene.background = new THREE.Color(0xa9bdc4);
  scene.fog = new THREE.Fog(0xa9bdc4, 26, 72);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);

  scene.add(new THREE.HemisphereLight(0xd9edf1, 0x766859, 1.35));
  scene.add(new THREE.AmbientLight(0xfff8ed, 0.42));
  const sun = new THREE.DirectionalLight(0xfff0d4, 1.35);
  sun.position.set(-10, 18, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.camera.left = -32;
  sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0xb5a58d, roughness: 0.96 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(60, 30, 0x8f806c, 0xcdbfaa);
  grid.material.transparent = true;
  grid.material.opacity = 0.26;
  scene.add(grid);

  // Office islands, glass walls, plants, and light strips make the space read
  // as a place people work in rather than a flat multiplayer arena.
  const deskMat = new THREE.MeshStandardMaterial({ color: 0xa76f4d, roughness: 0.78 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xe6a36e, roughness: 0.65 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x9db9b5, transparent: true, opacity: 0.3, roughness: 0.35, metalness: 0.05 });
  for (const [x, z] of [[-10, -6], [10, -6], [-10, 6], [10, 6], [0, -14]]) {
    const desk = new THREE.Mesh(new THREE.BoxGeometry(3, 0.9, 1.4), deskMat);
    desk.position.set(x, 0.45, z);
    scene.add(desk);
    addCollider(x, z, 3, 1.4, 0.12);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.04, 0.04), trimMat);
    strip.position.set(x, 0.92, z - 0.68);
    scene.add(strip);
  }
  for (const [x, z, rot] of [[-18, -8, 0], [18, -8, 0], [-18, 9, 0], [18, 9, 0]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.6, 8), glassMat);
    wall.position.set(x, 1.8, z);
    wall.rotation.y = rot;
    scene.add(wall);
    addCollider(x, z, 0.22, 8, PLAYER_RADIUS * 0.35);
  }
  for (const [x, z] of [[-14, -3], [14, -3], [-14, 13], [14, 13]]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 0.45, 12), new THREE.MeshStandardMaterial({ color: 0xb36f4e, roughness: 0.9 }));
    pot.position.set(x, 0.22, z);
    const plant = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), new THREE.MeshStandardMaterial({ color: 0x5f8f62, roughness: 0.95 }));
    plant.scale.y = 1.3;
    plant.position.set(x, 0.9, z);
    scene.add(pot, plant);
    addCollider(x, z, 0.9, 0.9, 0.08);
  }

  clock = new THREE.Clock();
  buildOffices();
  applyGameShadows(scene);
  window.addEventListener('resize', onResize);
  bindControls();
  animate();
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

function bindControls() {
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() in keys || e.key.startsWith('Arrow')) {
      e.preventDefault();
      setKey(e.key, true);
    }
  });
  window.addEventListener('keyup', e => {
    if (e.key.toLowerCase() in keys || e.key.startsWith('Arrow')) {
      e.preventDefault();
      setKey(e.key, false);
    }
  });
  const canvas = document.getElementById('cm-space-canvas');
  canvas.addEventListener('pointerdown', e => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });
  window.addEventListener('pointerup', () => dragging = false);
  window.addEventListener('pointercancel', () => dragging = false);
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.005;
    // Vertical drag now tilts the orbit camera. Clamping prevents the camera
    // from flipping upside down while still allowing a useful room overview.
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - lastY) * 0.005, -0.8, 0.7);
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const mobileButtons = {
    mobileMoveUp: 'w',
    mobileMoveLeft: 'a',
    mobileMoveDown: 's',
    mobileMoveRight: 'd',
  };
  for (const [id, key] of Object.entries(mobileButtons)) {
    const button = document.getElementById(id);
    if (!button) continue;
    const press = event => {
      event.preventDefault();
      event.stopPropagation();
      button.setPointerCapture?.(event.pointerId);
      setKey(key, true);
    };
    const release = event => {
      event.preventDefault();
      event.stopPropagation();
      setKey(key, false);
    };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }
}
function setKey(key, val) {
  const map = { ArrowUp: 'w', ArrowDown: 's', ArrowLeft: 'a', ArrowRight: 'd' };
  const k = map[key] || key.toLowerCase();
  if (k in keys) keys[k] = val;
}

function addCollider(centerX, centerZ, width, depth, padding = 0) {
  colliders.push({
    minX: centerX - width / 2 - padding,
    maxX: centerX + width / 2 + padding,
    minZ: centerZ - depth / 2 - padding,
    maxZ: centerZ + depth / 2 + padding,
  });
}

function applyGameShadows(root) {
  root.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

function blockedAt(x, z) {
  if (x < -WORLD_LIMIT + PLAYER_RADIUS || x > WORLD_LIMIT - PLAYER_RADIUS
    || z < -WORLD_LIMIT + PLAYER_RADIUS || z > WORLD_LIMIT - PLAYER_RADIUS) return true;
  return colliders.some(c => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);
}

// Resolve each axis independently so the avatar slides naturally along walls
// instead of getting stuck when moving diagonally into a desk or doorway.
function moveWithCollisions(position, delta) {
  const nextX = position.x + delta.x;
  if (!blockedAt(nextX, position.z)) position.x = nextX;
  const nextZ = position.z + delta.z;
  if (!blockedAt(position.x, nextZ)) position.z = nextZ;
}

function officeAt(x, z) {
  return offices.find(office =>
    x > office.centerX - office.width / 2 + 0.25
    && x < office.centerX + office.width / 2 - 0.25
    && z > office.centerZ - OFFICE_DEPTH / 2 + 0.25
    && z < office.centerZ + OFFICE_DEPTH / 2 - 0.25
  ) || null;
}

// ---------------------------------------------------------------
// Avatar construction
// ---------------------------------------------------------------
function makeHeadCanvas(color, initialsText) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  drawIdleHead(ctx, color, initialsText);
  const texture = new THREE.CanvasTexture(canvas);
  return { canvas, ctx, texture };
}

function drawIdleHead(ctx, color, initialsText) {
  ctx.clearRect(0, 0, 256, 256);
  // A small illustrated face keeps non-camera avatars expressive without
  // turning them into floating neon discs.
  ctx.fillStyle = '#d59673';
  ctx.beginPath(); ctx.arc(128, 128, 119, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(128, 128, 119, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(128, 58, 96, Math.PI, Math.PI * 2); ctx.fill();
  ctx.fillRect(32, 52, 192, 35);
  ctx.fillStyle = '#3a2d2a';
  ctx.beginPath(); ctx.arc(92, 126, 10, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(164, 126, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fffaf0';
  ctx.beginPath(); ctx.arc(94, 123, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(166, 123, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#a85f52';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(128, 148, 34, 0.18, Math.PI - 0.18); ctx.stroke();
  ctx.restore();
}

/** Draws a center-cropped square from a <video> onto the head canvas (called every frame while cam is on). */
function drawVideoToHead(ctx, videoEl) {
  if (!videoEl || videoEl.readyState < 2) return;
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const size = Math.min(vw, vh);
  const sx = (vw - size) / 2, sy = (vh - size) / 2;
  ctx.clearRect(0, 0, 256, 256);
  ctx.save();
  ctx.beginPath(); ctx.arc(128, 128, 122, 0, Math.PI * 2); ctx.clip();
  // mirror horizontally so it feels like a mirror, like every video call UI
  ctx.translate(256, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, sx, sy, size, size, 0, 0, 256, 256);
  ctx.restore();
}

function buildAvatarGroup(color, shape) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd59673, roughness: 0.92 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x34495e, roughness: 0.88 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x49352f, roughness: 0.94 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x2d3138, roughness: 0.92 });
  const torso = shape === 'block'
    ? new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.95, 0.52), bodyMat)
    : new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.52, 6, 12), bodyMat);
  torso.position.y = 1.05;
  group.add(torso);
  const collar = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.18, 6), new THREE.MeshStandardMaterial({ color: 0xf3d4b4, roughness: 0.8 }));
  collar.position.set(0, 1.61, 0);
  group.add(collar);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.48), darkMat);
  belt.position.set(0, 0.73, 0);
  group.add(belt);
  const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.62, 0.18), bodyMat);
  backpack.position.set(0, 1.08, 0.34);
  backpack.castShadow = true;
  group.add(backpack);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.18, 12), skinMat);
  neck.position.y = 1.68;
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 16), skinMat);
  head.scale.set(0.92, 1.08, 0.92);
  head.position.y = 2.0;
  group.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.375, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.48), hairMat);
  hair.scale.set(0.96, 1.08, 0.96);
  hair.position.y = 2.16;
  group.add(hair);
  const arms = [];
  const legs = [];
  const armGeometry = new THREE.CapsuleGeometry(0.11, 0.55, 5, 8);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(armGeometry, bodyMat);
    arm.position.set(side * 0.55, 1.08, 0);
    arm.rotation.z = side * -0.12;
    group.add(arm);
    arms.push(arm);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.62, 5, 8), darkMat);
    leg.position.set(side * 0.19, 0.34, 0);
    group.add(leg);
    legs.push(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.42), darkMat);
    shoe.position.set(side * 0.19, 0.04, -0.08);
    shoe.material = shoeMat;
    group.add(shoe);
  }
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 20),
    new THREE.MeshBasicMaterial({ color: 0x4b4038, transparent: true, opacity: 0.2, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  shadow.renderOrder = -1;
  group.add(shadow);
  group.userData.anim = { arms, legs, torso, phase: Math.random() * Math.PI * 2 };
  return group;
}

function animateAvatar(group, elapsed, walking) {
  const anim = group.userData.anim;
  if (!anim) return;
  const wave = Math.sin(elapsed * (walking ? 9 : 2.2) + anim.phase);
  const stride = walking ? wave * 0.5 : 0;
  anim.torso.position.y = 1.05 + (walking ? Math.abs(wave) * 0.035 : wave * 0.012);
  anim.arms[0].rotation.x = stride;
  anim.arms[1].rotation.x = -stride;
  anim.legs[0].rotation.x = -stride * 0.7;
  anim.legs[1].rotation.x = stride * 0.7;
}

function addNamePlate(group, name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(48,57,66,0.86)';
  ctx.roundRect ? ctx.roundRect(0, 8, 256, 48, 12) : ctx.rect(0, 8, 256, 48);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 26px Inter, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 16), 128, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = 3.55;
  group.add(sprite);
}

/** A small text plate whose text can be redrawn later (used above each desk to show who's currently in it). */
function makeUpdatablePlate(initialText, { width = 200, height = 56, font = 'bold 22px Inter, sans-serif', bg = 'rgba(48,57,66,0.86)' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  const plate = { canvas, ctx, texture, sprite, bg, font, lastText: null };
  setPlateText(plate, initialText);
  return plate;
}
function setPlateText(plate, text) {
  if (plate.lastText === text) return;
  plate.lastText = text;
  const { ctx, canvas } = plate;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = plate.bg;
  ctx.roundRect ? ctx.roundRect(4, 6, canvas.width - 8, canvas.height - 16, 10) : ctx.rect(4, 6, canvas.width - 8, canvas.height - 16);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = plate.font;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(text).slice(0, 20), canvas.width / 2, canvas.height / 2 - 2);
  plate.texture.needsUpdate = true;
}

/**
 * Six small offices along the back of the space (see OFFICE_DEFS). Each has
 * walls with a doorway you can walk through, a sign over the door, and one
 * or more desk+monitor setups. Occupancy (who's sitting where) is computed
 * live in updateOfficeOccupancy() from whoever is currently in the space —
 * this function only builds the static geometry, once.
 */
function buildOffices() {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9c9b8, roughness: 0.9 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x8f8173, roughness: 0.96 });
  const deskMat = new THREE.MeshStandardMaterial({ color: 0xa76f4d, roughness: 0.82 });
  const monitorFrameMat = new THREE.MeshStandardMaterial({ color: 0x394650, roughness: 0.82 });
  const lintelMat = new THREE.MeshStandardMaterial({ color: 0xe18a60, roughness: 0.72 });

  const totalWidth = OFFICE_DEFS.reduce((s, o) => s + o.width, 0) + OFFICE_GAP * (OFFICE_DEFS.length - 1);
  let cursorX = -totalWidth / 2;

  for (const def of OFFICE_DEFS) {
    const centerX = cursorX + def.width / 2;
    const centerZ = OFFICE_ROW_Z;
    const halfW = def.width / 2, halfD = OFFICE_DEPTH / 2;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(def.width - 0.2, OFFICE_DEPTH - 0.2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, 0.01, centerZ);
    scene.add(floor);

    const backWall = new THREE.Mesh(new THREE.BoxGeometry(def.width, WALL_HEIGHT, 0.15), wallMat);
    backWall.position.set(centerX, WALL_HEIGHT / 2, centerZ - halfD);
    scene.add(backWall);
    addCollider(centerX, centerZ - halfD, def.width, 0.15, PLAYER_RADIUS * 0.35);

    const sideWallGeo = new THREE.BoxGeometry(0.15, WALL_HEIGHT, OFFICE_DEPTH);
    const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
    leftWall.position.set(centerX - halfW, WALL_HEIGHT / 2, centerZ);
    scene.add(leftWall);
    addCollider(centerX - halfW, centerZ, 0.15, OFFICE_DEPTH, PLAYER_RADIUS * 0.35);
    const rightWall = new THREE.Mesh(sideWallGeo, wallMat);
    rightWall.position.set(centerX + halfW, WALL_HEIGHT / 2, centerZ);
    scene.add(rightWall);
    addCollider(centerX + halfW, centerZ, 0.15, OFFICE_DEPTH, PLAYER_RADIUS * 0.35);

    // Front wall, split by a doorway in the middle so you can walk in.
    const sideSpan = (def.width - DOOR_WIDTH) / 2;
    if (sideSpan > 0.05) {
      const frontGeo = new THREE.BoxGeometry(sideSpan, WALL_HEIGHT, 0.15);
      const frontL = new THREE.Mesh(frontGeo, wallMat);
      frontL.position.set(centerX - def.width / 2 + sideSpan / 2, WALL_HEIGHT / 2, centerZ + halfD);
      scene.add(frontL);
      addCollider(frontL.position.x, centerZ + halfD, sideSpan, 0.15, PLAYER_RADIUS * 0.35);
      const frontR = new THREE.Mesh(frontGeo, wallMat);
      frontR.position.set(centerX + def.width / 2 - sideSpan / 2, WALL_HEIGHT / 2, centerZ + halfD);
      scene.add(frontR);
      addCollider(frontR.position.x, centerZ + halfD, sideSpan, 0.15, PLAYER_RADIUS * 0.35);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(DOOR_WIDTH, 0.12, 0.15), lintelMat);
    lintel.position.set(centerX, WALL_HEIGHT - 0.2, centerZ + halfD);
    scene.add(lintel);

    addOfficeSign(centerX, WALL_HEIGHT - 0.55, centerZ + halfD + 0.08, def.label);

    // Desks + monitors, spread evenly along the back wall.
    const deskSlots = [];
    for (let i = 0; i < def.deskCount; i++) {
      const t = def.deskCount === 1 ? 0.5 : (i + 0.5) / def.deskCount;
      const deskX = centerX - halfW + 0.65 + t * (def.width - 1.3);
      const deskZ = centerZ - halfD + 0.9;

      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.85, 0.7), deskMat);
      desk.position.set(deskX, 0.42, deskZ);
      scene.add(desk);
      addCollider(deskX, deskZ, 1.3, 0.7, 0.12);

      const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.05), monitorFrameMat);
      monitor.position.set(deskX, 1.02, deskZ - 0.18);
      scene.add(monitor);
      const monitorStand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), monitorFrameMat);
      monitorStand.position.set(deskX, 0.9, deskZ - 0.18);
      scene.add(monitorStand);

       const screenMat = new THREE.MeshStandardMaterial({ color: 0x25333a, emissive: 0x397c78, emissiveIntensity: 0.08 });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.3), screenMat);
      screen.position.set(deskX, 1.02, deskZ - 0.152);
      scene.add(screen);

      const plate = makeUpdatablePlate('Available', { width: 200, height: 56 });
      plate.sprite.scale.set(1.1, 0.31, 1);
      plate.sprite.position.set(deskX, 1.55, deskZ - 0.2);
      scene.add(plate.sprite);

      deskSlots.push({ screenMat, plate });
    }

    offices.push({ ...def, centerX, centerZ, deskSlots });
    cursorX += def.width + OFFICE_GAP;
  }

  const technology = offices.filter(office => office.building === 'technology');
  if (technology.length) buildTechnologyBuilding(technology, wallMat, lintelMat);
}

function buildTechnologyBuilding(technology, wallMat, lintelMat) {
  const first = technology[0];
  const last = technology[technology.length - 1];
  const minX = first.centerX - first.width / 2 - 0.8;
  const maxX = last.centerX + last.width / 2 + 0.8;
  const centerX = (minX + maxX) / 2;
  const depth = OFFICE_DEPTH + 1.6;
  const halfD = depth / 2;
  const shellWallMat = wallMat.clone();
  shellWallMat.color.setHex(0x64757a);

  // A simple open-front shell makes the three rooms read as one department
  // building while preserving each office's separate walls and doorway.
  const back = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, WALL_HEIGHT + 0.35, 0.18), shellWallMat);
  back.position.set(centerX, (WALL_HEIGHT + 0.35) / 2, OFFICE_ROW_Z - halfD);
  scene.add(back);
  addCollider(centerX, OFFICE_ROW_Z - halfD, maxX - minX, 0.18, PLAYER_RADIUS * 0.35);

  for (const x of [minX, maxX]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.18, WALL_HEIGHT + 0.35, depth), shellWallMat);
    side.position.set(x, (WALL_HEIGHT + 0.35) / 2, OFFICE_ROW_Z);
    scene.add(side);
    addCollider(x, OFFICE_ROW_Z, 0.18, depth, PLAYER_RADIUS * 0.35);
  }

  const top = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, 0.18, 0.28), lintelMat);
  top.position.set(centerX, WALL_HEIGHT + 0.25, OFFICE_ROW_Z + halfD);
  scene.add(top);
  // A pair of chunky front columns and a shallow canopy give the shared
  // department a readable entrance without closing off the three offices.
  for (const x of [minX, maxX]) {
    const column = new THREE.Mesh(new THREE.BoxGeometry(0.34, WALL_HEIGHT + 0.1, 0.34), lintelMat);
    column.position.set(x, (WALL_HEIGHT + 0.1) / 2, OFFICE_ROW_Z + halfD);
    scene.add(column);
  }
  addOfficeSign(centerX, WALL_HEIGHT + 0.58, OFFICE_ROW_Z + halfD + 0.12, 'TECHNOLOGY');
}

function addOfficeSign(x, y, z, text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(67,78,83,0.94)';
  ctx.roundRect ? ctx.roundRect(4, 4, 504, 88, 14) : ctx.rect(4, 4, 504, 88);
  ctx.fill();
  ctx.strokeStyle = 'rgba(242,178,125,0.85)';
  ctx.lineWidth = 3;
  ctx.roundRect ? ctx.roundRect(4, 4, 504, 88, 14) : ctx.rect(4, 4, 504, 88);
  ctx.stroke();
  ctx.fillStyle = '#fff8eb';
  ctx.font = 'bold 34px Inter, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 50);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.5), mat);
  sign.position.set(x, y, z);
  scene.add(sign);
}

/**
 * Runs every frame from animate(). Figures out, from whoever is currently
 * in the space, which desk in which office each person belongs in (by
 * title match) and keeps that desk's name plate and monitor glow in sync.
 * Unfilled desks stay dim and say "Available" instead of a stale name.
 */
let officeRefreshTimer = 0;
function updateOfficeOccupancy(dt, elapsed) {
  officeRefreshTimer += dt;
  if (officeRefreshTimer > 0.4) {
    officeRefreshTimer = 0;
    const present = [];
    if (localAvatar && window.CM?.user) present.push({ userId: Number(CM.user.id), name: 'You' });
    for (const [userId, entry] of remoteAvatars) present.push({ userId: Number(userId), name: entry.name });

    for (const office of offices) {
      const occupants = present.filter(p => {
        const title = directory.get(p.userId) || '';
        return office.match.some(rx => rx.test(title));
      });
      office.deskSlots.forEach((slot, i) => {
        const occ = occupants[i];
        setPlateText(slot.plate, occ ? occ.name : 'Available');
        slot.occupied = !!occ;
      });
    }
  }
  // Smooth, ever-so-slightly flickering "screen on" glow — this is what
  // makes an occupied office read as alive rather than a static diorama.
  for (const office of offices) {
    for (const slot of office.deskSlots) {
      const target = slot.occupied ? 0.24 + Math.sin(elapsed * 3 + office.centerX) * 0.04 : 0.06;
      slot.screenMat.emissiveIntensity += (target - slot.screenMat.emissiveIntensity) * 0.08;
      slot.screenMat.emissive.setHex(slot.occupied ? 0x6a9b8d : 0x40565b);
    }
  }
}

function addVideoSprite(group, texture) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  // Keep the live camera bubble clearly above the physical character head.
  sprite.scale.set(0.86, 0.86, 1);
  sprite.position.y = 2.85;
  sprite.renderOrder = 10;
  sprite.visible = false;
  group.add(sprite);
  return sprite;
}

function createLocalAvatar(profile) {
  const group = buildAvatarGroup(profile.body_color || '#4b7891', profile.body_shape || 'capsule');
  localIdleColor = profile.body_color || '#4b7891';
  localIdleInitials = initials(profile.display_name || profile.name);
  const { canvas, ctx, texture } = makeHeadCanvas(localIdleColor, localIdleInitials);
  const headSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
  headSprite.scale.set(0.72, 0.72, 1);
  headSprite.position.y = 1.98;
  group.add(headSprite);
  localHeadSprite = headSprite;
  localVideoSprite = addVideoSprite(group, texture);
  addNamePlate(group, (profile.display_name || profile.name) + ' (you)');
  applyGameShadows(group);
  scene.add(group);
  localHeadCanvas = canvas; localHeadCtx = ctx; localHeadTexture = texture;
  return group;
}

function createRemoteAvatar(userId, name, color = '#d46d50') {
  const group = buildAvatarGroup(color, 'capsule');
  const idleInitials = initials(name);
  const { canvas, ctx, texture } = makeHeadCanvas(color, idleInitials);
  const headSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
  headSprite.scale.set(0.72, 0.72, 1);
  headSprite.position.y = 1.98;
  group.add(headSprite);
  const videoSprite = addVideoSprite(group, texture);
  addNamePlate(group, name);
  // Small status tag, shown only while the call to this person isn't fully
  // connected yet — lets you tell "still connecting" apart from "camera is
  // just off" without opening devtools. Hidden once the call is live.
  const statusPlate = makeUpdatablePlate('', { width: 240, height: 52, font: 'bold 20px Inter, sans-serif', bg: 'rgba(159,18,57,0.85)' });
  statusPlate.sprite.scale.set(1.3, 0.28, 1);
  statusPlate.sprite.position.set(0, 3.9, 0);
  statusPlate.sprite.visible = false;
  group.add(statusPlate.sprite);
  applyGameShadows(group);
  scene.add(group);
  const entry = { group, headCanvas: canvas, headCtx: ctx, headTexture: texture, headSprite, videoSprite, videoEl: null, idleColor: color, idleInitials, name, color, statusPlate, walkingUntil: 0 };
  remoteAvatars.set(userId, entry);
  updatePeopleCount();
  return entry;
}

/** Reflects live WebRTC connection state onto the tag above that person's avatar. */
function setCallStatus(userId, state) {
  const entry = remoteAvatars.get(userId);
  if (!entry?.statusPlate) return;
  const labels = {
    new: 'Connecting call…',
    connecting: 'Connecting call…',
    connected: null, // hide — call is live
    disconnected: 'Call interrupted, retrying…',
    failed: 'Call trouble — no route found (needs TURN)',
    closed: null,
  };
  const label = labels[state];
  if (label == null) {
    entry.statusPlate.sprite.visible = false;
  } else {
    setPlateText(entry.statusPlate, label);
    entry.statusPlate.sprite.visible = true;
  }
}

function removeRemoteAvatar(userId) {
  const entry = remoteAvatars.get(userId);
  if (!entry) return;
  scene.remove(entry.group);
  if (entry.videoEl) entry.videoEl.remove();
  remoteAvatars.delete(userId);
  updatePeopleCount();
}

function initials(name) {
  return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}
function updatePeopleCount() {
  const total = remoteAvatars.size + (localAvatar ? 1 : 0);
  const label = total === 1 ? 'person' : 'people';
  document.getElementById('spacePeopleCount').textContent = `${total} ${label} here`;
}

// ---------------------------------------------------------------
// Movement + render loop
// ---------------------------------------------------------------
let lastSentPos = 0;
let lastSent = null;      // last {x,y,z,rotY} actually sent, so idle standing sends nothing
let moveInFlight = false; // guards against overlapping move requests during network hiccups
const MOVE_SEND_INTERVAL = 0.24;   // ~4/sec while actively moving; enough for a shared office
const MOVE_SEND_EPSILON = 0.03;     // ignore tiny movement noise
let mediaFrameTimer = 0;
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  mediaFrameTimer += dt;
  const updateMediaFrames = mediaFrameTimer >= 1 / 15;
  if (updateMediaFrames) mediaFrameTimer = 0;

  if (localAvatar) {
    const dir = new THREE.Vector3();
    let walking = false;
    if (keys.w) dir.z -= 1;
    if (keys.s) dir.z += 1;
    if (keys.a) dir.x -= 1;
    if (keys.d) dir.x += 1;
    if (dir.lengthSq() > 0) {
      walking = true;
      dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        moveWithCollisions(localAvatar.position, dir.multiplyScalar(MOVE_SPEED * dt));
      localAvatar.rotation.y = Math.atan2(dir.x, dir.z);
    }
    animateAvatar(localAvatar, clock.elapsedTime, walking);
      // Third-person follow camera. Inside an office it pulls closer and stays
      // inside the room bounds, which gives a full view instead of clipping
      // through the walls when looking around.
      const room = officeAt(localAvatar.position.x, localAvatar.position.z);
      const distance = room ? 3.35 : 6;
      const horizontal = Math.cos(pitch) * distance;
      const camOffset = new THREE.Vector3(
        Math.sin(yaw) * horizontal,
        2.65 + Math.sin(pitch) * distance,
        Math.cos(yaw) * horizontal,
      );
      const target = localAvatar.position.clone().add(new THREE.Vector3(0, room ? 1.25 : 1.4, 0));
      const desiredCamera = target.clone().add(camOffset);
      if (room) {
        desiredCamera.x = THREE.MathUtils.clamp(desiredCamera.x, room.centerX - room.width / 2 + 0.7, room.centerX + room.width / 2 - 0.7);
        desiredCamera.z = THREE.MathUtils.clamp(desiredCamera.z, room.centerZ - OFFICE_DEPTH / 2 + 0.7, room.centerZ + OFFICE_DEPTH / 2 - 0.7);
        desiredCamera.y = THREE.MathUtils.clamp(desiredCamera.y, 1.1, WALL_HEIGHT - 0.35);
      }
      camera.position.copy(desiredCamera);
      camera.lookAt(target);

      if (localVideoEl && localHeadCtx) {
        if (updateMediaFrames) drawVideoToHead(localHeadCtx, localVideoEl);
        const videoEnabled = !!localStream?.getVideoTracks().some(track => track.enabled);
        if (localVideoSprite) localVideoSprite.visible = videoEnabled;
        if (localHeadSprite) localHeadSprite.visible = !videoEnabled;
      }
    if (localHeadTexture) localHeadTexture.needsUpdate = true;

    lastSentPos += dt;
    // Only actually send when something changed AND enough time has passed
    // AND the previous send has already resolved. Previously this fired
    // unconditionally ~12x/sec forever (even standing still), which was
    // the real source of the sustained request load that eventually
    // tripped the host's process limit — see the note in realtime.php.
    if (socket && !moveInFlight && lastSentPos > MOVE_SEND_INTERVAL) {
      lastSentPos = 0;
      const p = localAvatar.position, rotY = localAvatar.rotation.y;
      const moved = !lastSent
        || Math.abs(p.x - lastSent.x) > MOVE_SEND_EPSILON
        || Math.abs(p.z - lastSent.z) > MOVE_SEND_EPSILON
        || Math.abs(rotY - lastSent.rotY) > MOVE_SEND_EPSILON;
      if (moved) {
        lastSent = { x: p.x, y: p.y, z: p.z, rotY };
        moveInFlight = true;
        Promise.resolve(socket.emit('space:move', { x: p.x, y: p.y, z: p.z, rotY }))
          .catch(() => {}) // fire-and-forget: a dropped move update just gets superseded by the next one
          .finally(() => { moveInFlight = false; });
      }
    }
  }

  for (const [, entry] of remoteAvatars) {
    animateAvatar(entry.group, clock.elapsedTime, entry.walkingUntil > clock.elapsedTime);
    if (entry.videoEl && updateMediaFrames) {
      drawVideoToHead(entry.headCtx, entry.videoEl);
      entry.headTexture.needsUpdate = true;
      // Require an actual video frame, not just readyState — an audio-only
      // peer's <video> element can still reach readyState 2 with no frames,
      // which used to hide the idle head behind a blank video sprite.
      entry.videoSprite.visible = entry.videoEl.readyState >= 2 && entry.videoEl.videoWidth > 0;
      entry.headSprite.visible = !entry.videoSprite.visible;
    }
  }

  updateOfficeOccupancy(dt, clock.elapsedTime);

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------
// Networking: presence + movement
// -----------------------------------------------------------------
// No Node/Socket.IO server here — PollingSocket below simulates one with
// plain HTTP long-polling against backend/api/realtime.php (pure PHP,
// runs on any cPanel/shared host). It exposes the same .on(event, cb) /
// .emit(event, data) shape a Socket.IO client would, so everything below
// this point reads exactly as it would against a real socket.
// ---------------------------------------------------------------
class PollingSocket {
  constructor(apiBase, token) {
    this.apiBase = apiBase;
    this.token = token;
    this.handlers = new Map();
    this.since = 0;
    this.callRoom = null;
    this.stopped = false;
    this.rosterTimer = null;
  }

  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(cb);
  }

  _fire(event, data) {
    (this.handlers.get(event) || []).forEach(cb => cb(data));
  }

  async _call(action, body = {}) {
    // Token rides in BOTH the Authorization header and the query string.
    // Some shared-hosting Apache/PHP-CGI setups strip the Authorization
    // header before PHP ever sees it (see backend/includes/jwt.php's
    // current_user(), which already falls back to ?token= for exactly
    // this reason). CM.call() in api.js does the same double-send for
    // every other endpoint — this just brings realtime.php in line with
    // that so presence doesn't 401 on hosts that drop the header.
    const q = new URLSearchParams({ action, token: this.token || '' });
    const res = await fetch(`${this.apiBase}/realtime.php?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Realtime service returned a non-JSON response (${res.status}).`);
    }
    if (!res.ok) {
      const base = data.error || `Realtime ${action} failed (${res.status}).`;
      throw new Error(data.reason ? `${base} — ${data.reason}` : base);
    }
    return data;
  }

  async connect(initialPos) {
    const data = await this._call('join', initialPos);
    this.since = data.since || 0;
    this._fire('connect');
    this._fire('space:roster', data.roster || []);
    // A periodic full resync, mainly as an eventual-consistency safety net —
    // the poll stream + touch_presence()'s self-heal (see realtime.php) do
    // the real-time work now, so this doesn't need to be frequent. Every
    // 3s here was one more request per open tab, all the time, adding to
    // the exact kind of sustained background load that was pressuring the
    // host's process limit.
    this.rosterTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const roster = await this._call('roster');
        this._fire('space:roster', roster.roster || []);
      } catch {
        // The poll stream remains the primary channel; a roster refresh can retry.
      }
    }, 15000);
    this._loop();
    return data;
  }

  // Short poll: each call to action=poll now returns in milliseconds (see
  // the comment in realtime.php's poll_events() for why it no longer holds
  // the connection open). So this loop paces itself: go again immediately
  // when something just came back, otherwise wait a bit before re-asking —
  // that's what keeps a room full of idle tabs from turning into hundreds
  // of requests/sec against the server.
  async _loop() {
    while (!this.stopped) {
      try {
        const q = new URLSearchParams({ action: 'poll', since: this.since, token: this.token || '' });
        if (this.callRoom) q.set('call_room', this.callRoom);
        const res = await fetch(`${this.apiBase}/realtime.php?${q}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          cache: 'no-store',
        });
        if (res.status === 401) { this.stopped = true; return; }
        const data = await res.json();
        this.since = data.since ?? this.since;
        const events = data.events || [];
        for (const ev of events) this._dispatch(ev);
        if (!events.length) await new Promise(r => setTimeout(r, 1100));
      } catch (e) {
        // network hiccup (e.g. brief connectivity loss) — back off briefly,
        // then keep polling rather than giving up on the space entirely
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  _dispatch(ev) {
    if (ev.type === 'call:signal') {
      this._fire('call:signal', { fromUserId: ev.fromUserId, signal: ev.payload.signal });
    } else {
      this._fire(ev.type, ev.payload);
    }
  }

  emit(event, data) {
    // Fire-and-forget writes; the poll loop above is what delivers the
    // resulting events back (to us and everyone else). Callers that need
    // to know when the request actually finishes (e.g. the move-throttle
    // guard in animate()) can await/chain the returned promise.
    switch (event) {
      case 'space:move':
        return this._call('move', { x: data.x, y: data.y, z: data.z, rot_y: data.rotY });
      case 'space:chat':
        return this._call('chat', { text: data });
      case 'call:join':
        this.callRoom = data;
        return this._call('call_join', { room: data }).then(r => this._fire('call:existing_peers', r.existing_peers || []));
      case 'call:leave':
        this._call('call_leave', { room: data });
        this.callRoom = null;
        return;
      case 'call:signal':
        return this._call('signal', { room: this.callRoom || 'space-global', to_user_id: data.toUserId, signal: data.signal });
    }
  }

  disconnect() {
    this.stopped = true;
    if (this.rosterTimer) {
      clearInterval(this.rosterTimer);
      this.rosterTimer = null;
    }
    // Best-effort: tell the server we're gone right away instead of
    // waiting for the presence heartbeat to time out (~8s). sendBeacon
    // can't set an Authorization header, so the token rides in the query
    // string for this one call — see the fallback in backend/includes/jwt.php.
    const url = `${this.apiBase}/realtime.php?action=leave&token=${encodeURIComponent(this.token)}`;
    navigator.sendBeacon?.(url, new Blob(['{}'], { type: 'application/json' }));
  }
}

async function connectSocket(profile) {
  socket = new PollingSocket(CM_CONFIG.API_BASE, CM.token);

  const syncRoster = (others) => {
    const seen = new Set();
    others.forEach(o => {
      const userId = String(o.userId);
      if (Number(o.userId) === Number(CM.user.id)) return;
      seen.add(userId);
      const entry = remoteAvatars.get(o.userId) || createRemoteAvatar(o.userId, o.name);
      entry.group.position.set(o.pos?.x || 0, o.pos?.y || 0, o.pos?.z || 0);
      entry.group.rotation.y = o.pos?.rotY || 0;
    });
    for (const userId of [...remoteAvatars.keys()]) {
      if (!seen.has(String(userId))) removeRemoteAvatar(userId);
    }
    updatePeopleCount();
  };

  socket.on('space:roster', syncRoster);
  socket.on('space:user_joined', (o) => {
    if (!remoteAvatars.has(o.userId)) {
      const entry = createRemoteAvatar(o.userId, o.name);
      entry.group.position.set(o.pos?.x || 0, o.pos?.y || 0, o.pos?.z || 0);
      entry.group.rotation.y = o.pos?.rotY || 0;
    }
  });
  socket.on('space:user_moved', (o) => {
    const entry = remoteAvatars.get(o.userId);
    if (entry && o.pos) {
      entry.group.position.set(o.pos.x, o.pos.y || 0, o.pos.z);
      entry.group.rotation.y = o.pos.rotY || 0;
      entry.walkingUntil = clock.elapsedTime + 0.35;
    }
  });
  socket.on('space:user_left', (o) => removeRemoteAvatar(o.userId));

  // ---- WebRTC signaling ----
  socket.on('call:existing_peers', (peerIds) => {
    peerIds.forEach(pid => {
      if (Number(CM.user.id) < Number(pid)) callPeer(pid, true); // deterministic offerer
    });
  });
  socket.on('call:peer_joined', ({ userId }) => {
    if (Number(CM.user.id) < Number(userId)) callPeer(userId, true);
  });
  socket.on('call:peer_left', ({ userId }) => closePeer(userId));
  socket.on('call:signal', async ({ fromUserId, signal }) => {
    let pc = peerConnections.get(fromUserId);
    if (!pc) pc = callPeer(fromUserId, false);
    try {
      if (Array.isArray(signal.candidates)) {
        await addRemoteIceCandidates(pc, signal.candidates);
      } else if (signal.type === 'offer') {
        // "Perfect negotiation": if both sides happen to send an offer at
        // once (e.g. both toggle camera around the same time), the polite
        // side backs off instead of both connections getting stuck.
        const collision = pc.makingOffer || pc.signalingState !== 'stable';
        if (collision && !pc.polite) return; // impolite side: ignore theirs, keep ours
        if (collision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        await addRemoteIceCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:signal', { toUserId: fromUserId, signal: pc.localDescription });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        await addRemoteIceCandidates(pc);
      } else if (signal.candidate) {
        await addRemoteIceCandidates(pc, [signal]);
      }
    } catch (err) {
      console.error('WebRTC signal handling failed:', err);
    }
  });

  const joined = await socket.connect({ x: 0, y: 0, z: 0, rotY: 0 });
  if (joined.self?.pos && localAvatar) {
    localAvatar.position.set(
      joined.self.pos.x || 0,
      joined.self.pos.y || 0,
      joined.self.pos.z || 0,
    );
    localAvatar.rotation.y = joined.self.pos.rotY || 0;
  }
}

// ---------------------------------------------------------------
// WebRTC peer connections
// ---------------------------------------------------------------
function callPeer(userId, isOfferer) {
  const existing = peerConnections.get(userId);
  if (existing && existing.connectionState !== 'closed') return existing;
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 0,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  // "Perfect negotiation" roles (see the WebRTC spec's recommended pattern):
  // the deterministic initial offerer is "impolite" (keeps its own offer if
  // two collide), the other side is "polite" (backs off — see the rollback
  // logic in the call:signal handler above). Crucially, BOTH sides now get
  // onnegotiationneeded below, not just the initial offerer — previously
  // only the offerer side could ever renegotiate, so if you turned your
  // camera/mic on mid-call while on the non-offerer side, that track was
  // silently never announced to your peer.
  pc.polite = !isOfferer;
  pc.makingOffer = false;
  pc.pendingRemoteCandidates = [];
  pc.negotiationTimer = null;
  peerConnections.set(userId, pc);
  if (!remoteAvatars.has(userId)) createRemoteAvatar(userId, 'Teammate');
  setCallStatus(userId, 'connecting');

  if (localStream) localStream.getTracks().forEach(t => addTrackOnce(pc, t, localStream));

  // Batch trickle-ICE candidates. Each candidate used to create its own PHP
  // request and database row; batching keeps the signaling server quiet while
  // preserving fast connection setup.
  let pendingCandidates = [];
  let candidateTimer = null;
  const flushCandidates = () => {
    candidateTimer = null;
    if (!pendingCandidates.length || !socket) return;
    const candidates = pendingCandidates;
    pendingCandidates = [];
    socket.emit('call:signal', { toUserId: userId, signal: { candidates } });
  };
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    pendingCandidates.push(e.candidate);
    if (!candidateTimer) candidateTimer = setTimeout(flushCandidates, 80);
  };
  // ICE can land on 'failed' when no direct path exists and TURN is
  // unavailable/overloaded — try one restart before giving up, and only
  // then tell the person, so a normal brief blip doesn't nag them.
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      if (!pc.restartedOnce) {
        pc.restartedOnce = true;
        try { pc.restartIce(); } catch { /* older browsers: renegotiate manually */ pc.onnegotiationneeded?.(); }
      } else {
        showMediaNotice('Could not connect video/audio to a teammate on this network. This usually means a TURN relay is needed — see the ICE_SERVERS note in space.js.');
      }
    }
  };
  pc.onconnectionstatechange = () => setCallStatus(userId, pc.connectionState);
  pc.ontrack = (e) => {
    let entry = remoteAvatars.get(userId);
    if (!entry) entry = createRemoteAvatar(userId, 'Teammate');
    if (!entry.videoEl) {
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = false;
      v.srcObject = e.streams[0];
      entry.videoEl = v;
      entry.videoSprite.visible = true;
      playRemoteVideo(v);
    }
  };

  pc.onnegotiationneeded = () => {
    // Coalesce audio + video track changes made by two quick button presses
    // into one offer rather than creating overlapping offers.
    if (pc.negotiationTimer) return;
    pc.negotiationTimer = setTimeout(async () => {
      pc.negotiationTimer = null;
      if (pc.makingOffer || pc.signalingState !== 'stable') return;
      try {
        pc.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:signal', { toUserId: userId, signal: pc.localDescription });
      } catch (err) {
        console.error('WebRTC renegotiation failed:', err);
      } finally {
        pc.makingOffer = false;
      }
    }, 100);
  };
  return pc;
}

function closePeer(userId) {
  const pc = peerConnections.get(userId);
  if (pc) { pc.close(); peerConnections.delete(userId); }
  const entry = remoteAvatars.get(userId);
  if (entry?.videoEl) {
    entry.videoEl.remove();
    entry.videoEl = null;
    entry.videoSprite.visible = false;
    entry.headSprite.visible = true;
    drawIdleHead(entry.headCtx, entry.idleColor, entry.idleInitials);
    entry.headTexture.needsUpdate = true;
  }
  if (entry?.statusPlate) entry.statusPlate.sprite.visible = false;
}

function addTrackOnce(pc, track, stream) {
  const sender = pc.getSenders().find(candidate => candidate.track?.kind === track.kind);
  if (sender) return sender.replaceTrack(track);
  pc.addTrack(track, stream);
}

async function addRemoteIceCandidates(pc, candidates = []) {
  pc.pendingRemoteCandidates.push(...candidates);
  if (!pc.remoteDescription) return;
  const pending = pc.pendingRemoteCandidates.splice(0);
  for (const candidate of pending) {
    try { await pc.addIceCandidate(candidate); } catch { /* peer may have closed */ }
  }
}

// ---------------------------------------------------------------
// Media controls
// ---------------------------------------------------------------
async function ensureLocalStream() {
  if (!localStream) localStream = new MediaStream();
  localVideoEl = document.getElementById('cm-local-video');
  localVideoEl.srcObject = localStream;
  return localStream;
}

function showMediaNotice(message, { clickable = false, onClick = null } = {}) {
  const panel = document.getElementById('spaceMediaNotice');
  if (!panel) return;
  panel.textContent = message;
  panel.classList.add('visible');
  panel.classList.toggle('clickable', clickable);
  panel.onclick = clickable ? onClick : null;
}

/**
 * Browsers can block audio/video from playing until there's been a user
 * gesture on the page. There normally already has been one (clicking the
 * mic/cam button), so this usually just works — but on stricter browsers,
 * or if a remote track arrives before that registers, play() rejects and
 * the previous code swallowed that silently: the call connects, the video
 * texture even updates, but you never hear anything. Now a rejected play()
 * puts up a clickable "tap to enable sound" notice instead of failing
 * silently, and one click retries every remote video/audio at once.
 */
function playRemoteVideo(videoEl) {
  videoEl.play().catch(() => {
    showMediaNotice('🔊 Tap here to enable sound for this call', {
      clickable: true,
      onClick: () => {
        let stillBlocked = false;
        for (const entry of remoteAvatars.values()) {
          if (entry.videoEl) entry.videoEl.play().catch(() => { stillBlocked = true; });
        }
        if (!stillBlocked) showMediaNotice('', { clickable: false });
      },
    });
  });
}

async function ensureMedia(kind) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showMediaNotice('Camera and microphone need HTTPS (or localhost). Open this portal over HTTPS, then try again.');
    throw new Error('Secure context required for camera and microphone access.');
  }
  await ensureLocalStream();
  const existing = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
  if (existing.length) return existing[0];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'audio' ? MEDIA_CONSTRAINTS.audio : false,
      video: kind === 'video' ? MEDIA_CONSTRAINTS.video : false,
    });
    const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!track) throw new Error(`No ${kind} device was returned.`);
    localStream.addTrack(track);
    localVideoEl.srcObject = localStream;
    for (const pc of peerConnections.values()) addTrackOnce(pc, track, localStream);
    showMediaNotice('');
    return track;
  } catch (err) {
    const detail = err.name === 'NotAllowedError'
      ? `Browser permission was blocked for your ${kind}. Click the lock icon → allow ${kind}, reload, and try again.`
      : err.name === 'NotFoundError'
        ? `No ${kind} device was found on this device.`
        : `Could not start ${kind}: ${err.message || 'browser permission error'}`;
    showMediaNotice(detail);
    throw err;
  }
}

/**
 * Make sure we're actually in the call mesh (peer connections to everyone
 * else already in the room) before a local track is expected to reach
 * anyone. This used to be something you only got by separately clicking the
 * "group call" button — toggling your mic or camera on its own grabbed the
 * device and mirrored it onto your OWN avatar, but never joined the call
 * room, so no RTCPeerConnection to anyone else was ever created. Both sides
 * would see their own video locally and nothing from the other person, no
 * matter how many times they toggled cam/mic — which is exactly the
 * "their video never shows up on my end" symptom this fixes. Deliberately
 * does NOT request mic/cam permission itself (that's ensureMedia's job) so
 * turning on the camera alone doesn't also pop a microphone prompt.
 */
async function ensureInCall() {
  if (inGroupCall) return;
  if (!socket) {
    showMediaNotice('Presence isn\u2019t connected yet, so calls can\u2019t start. Try re-entering the space.');
    return;
  }
  inGroupCall = true;
  document.getElementById('groupCallBtn')?.classList.add('active-on');
  await Promise.resolve(socket.emit('call:join', groupCallRoomId)).catch(() => {});
}

// ---------------------------------------------------------------
// Public API used by portal.html buttons
// ---------------------------------------------------------------
export const Space = {
  async enter() {
    document.getElementById('cm-space-overlay').classList.add('open');
    if (!renderer) initScene();
    const { avatar } = await CM.call('avatars', 'mine');
    if (!localAvatar) localAvatar = createLocalAvatar({ ...avatar, name: CM.user.name });
    updatePeopleCount();
    // Everyone's title, so the offices below know whose desk is whose.
    // Best-effort: if this fails, offices just show "Available" everywhere.
    CM.call('avatars', 'roster').then(({ roster }) => {
      directory.clear();
      (roster || []).forEach(u => directory.set(Number(u.user_id), u.title || ''));
    }).catch(() => {});
    if (!socket) {
      try {
        await connectSocket(avatar);
      } catch (error) {
        socket?.disconnect();
        socket = null;
        document.getElementById('spacePeopleCount').textContent = 'Presence offline';
        showMediaNotice(`Your avatar loaded, but live teammate presence could not connect. ${error.message}`);
        console.error('Virtual space presence failed:', error);
      }
    }
  },

  exit() {
    document.getElementById('cm-space-overlay').classList.remove('open');
    if (inGroupCall) this.toggleGroupCall();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (socket) { socket.disconnect(); socket = null; }
    for (const userId of [...remoteAvatars.keys()]) removeRemoteAvatar(userId);
    if (localAvatar) { scene.remove(localAvatar); localAvatar = null; }
    localHeadSprite = null;
    localVideoSprite = null;
    document.getElementById('micBtn').classList.remove('active-on');
    document.getElementById('camBtn').classList.remove('active-on');
  },

  async toggleMic() {
    const hadTrack = !!localStream?.getAudioTracks()[0];
    let track = localStream?.getAudioTracks()[0];
    if (!track) track = await ensureMedia('audio');
    // Turning the mic on means "let people hear me" — make sure a peer
    // connection to everyone in the room actually exists, or the track
    // above just sits in localStream with nowhere to go. No-op if we're
    // already in the call.
    await ensureInCall();
    if (!hadTrack) {
      document.getElementById('micBtn').classList.add('active-on');
      return;
    }
    track.enabled = !track.enabled;
    document.getElementById('micBtn').classList.toggle('active-on', track.enabled);
  },

  async toggleCam() {
    const hadTrack = !!localStream?.getVideoTracks()[0];
    let track = localStream?.getVideoTracks()[0];
    if (!track) track = await ensureMedia('video');
    // Same reasoning as toggleMic: without this, your camera only ever
    // rendered onto your own avatar and was never sent to anyone else.
    await ensureInCall();
    if (!hadTrack) {
      document.getElementById('camBtn').classList.add('active-on');
      if (localVideoSprite) localVideoSprite.visible = true;
      if (localHeadSprite) localHeadSprite.visible = false;
      localVideoEl.play().catch(() => {});
      return;
    }
    track.enabled = !track.enabled;
    document.getElementById('camBtn').classList.toggle('active-on', track.enabled);
    if (localVideoSprite) localVideoSprite.visible = track.enabled;
    if (localHeadSprite) localHeadSprite.visible = !track.enabled;
    if (!track.enabled && localHeadCtx) {
      drawIdleHead(localHeadCtx, localIdleColor, localIdleInitials);
      if (localHeadTexture) localHeadTexture.needsUpdate = true;
    }
    if (track.enabled) localVideoEl.play().catch(() => {});
  },

  async toggleGroupCall() {
    const joining = !inGroupCall;
    // Only prompt for mic permission when actually joining — leaving
    // shouldn't be blocked on (or trigger) a permission prompt.
    if (joining) await ensureMedia('audio');
    inGroupCall = joining;
    document.getElementById('groupCallBtn').classList.toggle('active-on', inGroupCall);
    if (inGroupCall) {
      socket.emit('call:join', groupCallRoomId);
    } else {
      socket.emit('call:leave', groupCallRoomId);
      for (const userId of [...peerConnections.keys()]) closePeer(userId);
    }
  },
};

window.Space = Space; // expose to the non-module onclick handlers in portal.html

// Best-effort clean disconnect when the tab actually closes/navigates away,
// so presence clears immediately instead of waiting for the ~8s heartbeat
// timeout on the server. See PollingSocket.disconnect() above.
window.addEventListener('pagehide', () => { if (socket) socket.disconnect(); });
