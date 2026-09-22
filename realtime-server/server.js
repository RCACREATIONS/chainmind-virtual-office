/**
 * ChainMind Team Portal — Realtime Server
 * -----------------------------------------------------------------
 * Handles three things, all over one Socket.IO connection per user:
 *   1. Presence — who's currently in the virtual space
 *   2. Movement sync — broadcasting avatar x/y/z/rotation as people walk around
 *   3. WebRTC signaling — relaying offer/answer/ICE candidates so browsers
 *      can set up their own peer-to-peer (or small-mesh group) video/voice
 *      streams. Actual media never touches this server — it only ever
 *      passes small JSON signaling messages, so it stays cheap to run.
 *
 * PRODUCTION NOTE: WebRTC works out of the box on the same network or when
 * both peers have open/compatible NATs. For calls to reliably connect from
 * anywhere (most real-world users, e.g. behind CGNAT / strict corporate
 * firewalls), you need a TURN server (coturn is the standard free option)
 * and to add its credentials to ICE_SERVERS below. Without TURN, some
 * fraction of calls will fail to connect — that's a WebRTC/networking fact,
 * not a bug in this code.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.CM_JWT_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_STRING'; // must match backend/config/config.php JWT_SECRET
const ALLOWED_ORIGINS = (process.env.CM_ALLOWED_ORIGINS || 'http://localhost:8080').split(',');

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.get('/health', (_req, res) => res.json({ ok: true, connected: io?.engine?.clientsCount ?? 0 }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

// userId -> { socketId, name, roomId }
const presence = new Map();
// roomId -> Set of userIds currently in that call room
const callRooms = new Map();

function authenticate(socket, next) {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        socket.user = { id: payload.sub, name: payload.name, role: payload.role };
        next();
    } catch (err) {
        next(new Error('Invalid or expired token'));
    }
}

io.use(authenticate);

io.on('connection', (socket) => {
    const { id: userId, name } = socket.user;

    // ---- Presence: join the shared virtual space ----
    socket.on('space:join', (initialPos) => {
        presence.set(userId, { socketId: socket.id, name, roomId: null, pos: initialPos || { x: 0, y: 0, z: 0, rotY: 0 } });
        socket.join('space');
        io.to('space').emit('space:user_joined', { userId, name, pos: initialPos });
        // send the new joiner everyone already there
        const others = [...presence.entries()]
            .filter(([id]) => id !== userId)
            .map(([id, p]) => ({ userId: id, name: p.name, pos: p.pos }));
        socket.emit('space:roster', others);
    });

    // ---- Movement sync (client should throttle to ~10-15 times/sec) ----
    socket.on('space:move', (pos) => {
        const p = presence.get(userId);
        if (p) p.pos = pos;
        socket.to('space').emit('space:user_moved', { userId, pos });
    });

    // ---- Call signaling: 1:1 or group, identified by a roomId string ----
    socket.on('call:join', (roomId) => {
        socket.join(`call:${roomId}`);
        const p = presence.get(userId);
        if (p) p.roomId = roomId;
        if (!callRooms.has(roomId)) callRooms.set(roomId, new Set());
        const room = callRooms.get(roomId);

        // tell the new participant who's already in the call so they can
        // initiate a peer connection to each of them (mesh topology —
        // fine for small teams; swap for an SFU like mediasoup/LiveKit
        // once group calls regularly exceed ~6-8 people)
        socket.emit('call:existing_peers', [...room]);
        room.add(userId);
        socket.to(`call:${roomId}`).emit('call:peer_joined', { userId, name });
    });

    socket.on('call:signal', ({ roomId, toUserId, signal }) => {
        const target = presence.get(toUserId);
        if (target) io.to(target.socketId).emit('call:signal', { roomId, fromUserId: userId, signal });
    });

    socket.on('call:leave', (roomId) => {
        leaveCall(userId, roomId);
    });

    // ---- Lightweight chat inside a call or the general space (optional) ----
    socket.on('space:chat', (msg) => {
        io.to('space').emit('space:chat', { userId, name, text: String(msg).slice(0, 1000), at: Date.now() });
    });

    socket.on('disconnect', () => {
        const p = presence.get(userId);
        if (p?.roomId) leaveCall(userId, p.roomId);
        presence.delete(userId);
        io.to('space').emit('space:user_left', { userId });
    });
});

function leaveCall(userId, roomId) {
    const room = callRooms.get(roomId);
    if (room) {
        room.delete(userId);
        if (room.size === 0) callRooms.delete(roomId);
    }
    io.to(`call:${roomId}`).emit('call:peer_left', { userId });
    const p = presence.get(userId);
    if (p) p.roomId = null;
}

server.listen(PORT, () => {
    console.log(`ChainMind realtime server listening on :${PORT}`);
});
