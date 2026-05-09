const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Keepalive ping endpoint (prevents Render free-tier cold starts)
app.get('/ping', (req, res) => res.send('ok'));

const rooms = {};

function getRoom(roomId) {
    if (!rooms[roomId]) rooms[roomId] = { host: null, queue: [], currentUrl: null };
    return rooms[roomId];
}

// CHANGE 2: emit live viewer count to everyone in a room
function emitRoomCount(roomId) {
    const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit('room_count', { count });
}

function playNextInQueue(roomId) {
    const room = rooms[roomId];
    if (!room || room.queue.length === 0) {
        if (room) room.currentUrl = null;
        io.to(roomId).emit('queue_empty');
        return;
    }
    const next = room.queue.shift();
    room.currentUrl = next.url;
    console.log(`▶ Playing next in ${roomId}: ${next.title}`);
    io.to(roomId).emit('navigate_to', { url: next.url, title: next.title });
    io.to(roomId).emit('queue_update', { queue: room.queue, host: room.host });
    io.to(roomId).emit('chat_message', {
        sender: 'SYSTEM',
        text: `▶ Now playing: "${next.title}" — added by ${next.addedBy}`,
        isSystem: true
    });
}

io.on('connection', (socket) => {
    console.log(`🟢 User connected: ${socket.id}`);

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        socket.data.roomId = roomId;
        const room = getRoom(roomId);

        if (!room.host) {
            room.host = socket.id;
            console.log(`👑 ${socket.id} is host of ${roomId}`);
        } else {
            const shortId = socket.id.substring(0, 4);
            io.to(room.host).emit('latecomer_arrived', { newUserId: shortId });
        }

        // Send joining user the full current state
        socket.emit('queue_update', { queue: room.queue, host: room.host });
        if (room.currentUrl) socket.emit('navigate_to', { url: room.currentUrl, time: 0 });

        // CHANGE 2: broadcast updated count to everyone including the new joiner
        emitRoomCount(roomId);
    });

    socket.on('sync_state',       (data) => socket.to(data.roomId).emit('sync_state', data));
    socket.on('chat_message',     (data) => socket.to(data.roomId).emit('chat_message', data));
    socket.on('typing',           (data) => socket.to(data.roomId).emit('user_typing',  { sender: data.sender }));
    socket.on('stopped_typing',   (data) => socket.to(data.roomId).emit('user_stopped', { sender: data.sender }));
    socket.on('reaction',         (data) => socket.to(data.roomId).emit('reaction',     { emoji: data.emoji, sender: data.sender }));
    socket.on('user_status',      (data) => socket.to(data.roomId).emit('user_status',  data));

    // Queue: any member can add
    socket.on('queue_add', (data) => {
        const { roomId, url, title, sender } = data;
        const room = getRoom(roomId);
        const item = { url, title: title || url, addedBy: sender, id: Date.now() };
        room.queue.push(item);
        io.to(roomId).emit('queue_update', { queue: room.queue, host: room.host });
        io.to(roomId).emit('chat_message', {
            sender: 'SYSTEM', text: `${sender} added "${item.title}" to the queue`, isSystem: true
        });
        if (!room.currentUrl) playNextInQueue(roomId);
    });

    // Queue: host-only controls
    socket.on('queue_remove', (data) => {
        const room = getRoom(data.roomId);
        if (room.host !== socket.id) return;
        room.queue = room.queue.filter(i => i.id !== data.itemId);
        io.to(data.roomId).emit('queue_update', { queue: room.queue, host: room.host });
    });

    socket.on('queue_play_next', (data) => {
        const room = getRoom(data.roomId);
        if (room.host !== socket.id) return;
        playNextInQueue(data.roomId);
    });

    socket.on('queue_play_item', (data) => {
        const room = getRoom(data.roomId);
        if (room.host !== socket.id) return;
        const idx = room.queue.findIndex(i => i.id === data.itemId);
        if (idx === -1) return;
        const [item] = room.queue.splice(idx, 1);
        room.queue.unshift(item);
        playNextInQueue(data.roomId);
    });

    socket.on('queue_reorder', (data) => {
        const room = getRoom(data.roomId);
        if (room.host !== socket.id) return;
        const [moved] = room.queue.splice(data.fromIndex, 1);
        room.queue.splice(data.toIndex, 0, moved);
        io.to(data.roomId).emit('queue_update', { queue: room.queue, host: room.host });
    });

    // Voice call signaling
    socket.on('voice_call_started', (data) => socket.to(data.roomId).emit('voice_call_incoming', { from: socket.id, sender: data.sender, roomId: data.roomId }));
    socket.on('voice_offer',        (data) => io.to(data.to).emit('voice_offer',   { offer: data.offer, from: socket.id }));
    socket.on('voice_answer',       (data) => io.to(data.to).emit('voice_answer',  { answer: data.answer, from: socket.id }));
    socket.on('ice_candidate',      (data) => io.to(data.to).emit('ice_candidate', { candidate: data.candidate, from: socket.id }));
    socket.on('voice_call_ended',   (data) => socket.to(data.roomId).emit('voice_call_ended', { sender: data.sender }));

    // Disconnect & host reassignment
    socket.on('disconnect', () => {
        console.log(`🔴 User disconnected: ${socket.id}`);
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        socket.to(roomId).emit('voice_peer_disconnected', { socketId: socket.id });

        if (room.host === socket.id) {
            const clients = io.sockets.adapter.rooms.get(roomId);
            if (clients && clients.size > 0) {
                room.host = [...clients][0];
                io.to(roomId).emit('queue_update', { queue: room.queue, host: room.host });
                io.to(roomId).emit('chat_message', { sender: 'SYSTEM', text: 'Host left — controls transferred.', isSystem: true });
            } else {
                delete rooms[roomId];
                return; // room gone, no count to emit
            }
        }

        // CHANGE 2: broadcast updated count after someone leaves
        emitRoomCount(roomId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Watch Party Server running on port ${PORT}`);
    console.log(`📡 Waiting for connections...`);
});