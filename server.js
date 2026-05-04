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

// State Management
// Stores host per room. Example: { 'test-party-123': { host: 'socket_id_abc' } }
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🟢 User connected: ${socket.id}`);

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`🚪 User ${socket.id} joined room: ${roomId}`);

        if (!rooms[roomId]) {
            rooms[roomId] = { host: socket.id };
            console.log(`👑 User ${socket.id} is the host of ${roomId}`);
        } else {
            const shortId = socket.id.substring(0, 4);
            io.to(rooms[roomId].host).emit('latecomer_arrived', { newUserId: shortId });
        }
    });

    // Play / pause / seek — broadcast to everyone else in the room
    socket.on('sync_state', (data) => {
        socket.to(data.roomId).emit('sync_state', data);
    });

    // Chat messages — broadcast to everyone else in the room
    socket.on('chat_message', (data) => {
        console.log(`💬 Chat in ${data.roomId} from ${data.sender}: ${data.text}`);
        socket.to(data.roomId).emit('chat_message', data);
    });

    // Typing indicator
    socket.on('typing', (data) => {
        socket.to(data.roomId).emit('user_typing', { sender: data.sender });
    });

    socket.on('stopped_typing', (data) => {
        socket.to(data.roomId).emit('user_stopped', { sender: data.sender });
    });

    // Emoji reaction
    socket.on('reaction', (data) => {
        console.log(`🎉 Reaction in ${data.roomId} from ${data.sender}: ${data.emoji}`);
        socket.to(data.roomId).emit('reaction', { emoji: data.emoji, sender: data.sender });
    });

    // =====================================================
    // --- VOICE CALL SIGNALING (WebRTC via Socket.io) ---
    // =====================================================
    // The server is just a relay here — it never touches the audio.
    // It only passes the WebRTC handshake messages between peers.

    // Step 1 — Someone starts a call. Tell everyone else in the room.
    socket.on('voice_call_started', (data) => {
        console.log(`🎙️ Voice call started in room ${data.roomId} by ${data.sender}`);
        socket.to(data.roomId).emit('voice_call_incoming', {
            from: socket.id,
            sender: data.sender,
            roomId: data.roomId
        });
    });

    // Step 2 — Caller sends their WebRTC offer to a specific peer
    socket.on('voice_offer', (data) => {
        // data.to = the socket.id of the person we want to call
        console.log(`📞 voice_offer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('voice_offer', {
            offer: data.offer,
            from: socket.id
        });
    });

    // Step 3 — Receiver sends their WebRTC answer back to the caller
    socket.on('voice_answer', (data) => {
        console.log(`📞 voice_answer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('voice_answer', {
            answer: data.answer,
            from: socket.id
        });
    });

    // Step 4 — Both sides exchange ICE candidates (network path info)
    // This happens automatically and repeatedly as the browser discovers paths
    socket.on('ice_candidate', (data) => {
        io.to(data.to).emit('ice_candidate', {
            candidate: data.candidate,
            from: socket.id
        });
    });

    // Step 5 — Someone ends the call. Notify the whole room.
    socket.on('voice_call_ended', (data) => {
        console.log(`📵 Voice call ended in room ${data.roomId}`);
        socket.to(data.roomId).emit('voice_call_ended', { sender: data.sender });
    });

    // Disconnect & host reassignment
    socket.on('disconnect', () => {
        console.log(`🔴 User disconnected: ${socket.id}`);

        // If a peer disconnects mid-call, notify their room
        for (let roomId in rooms) {
            const clients = io.sockets.adapter.rooms.get(roomId);
            if (clients && clients.has(socket.id) === false) {
                socket.to(roomId).emit('voice_peer_disconnected', { socketId: socket.id });
            }
        }

        for (let roomId in rooms) {
            if (rooms[roomId].host === socket.id) {
                const clients = io.sockets.adapter.rooms.get(roomId);
                if (clients && clients.size > 0) {
                    rooms[roomId].host = [...clients][0];
                    console.log(`👑 Host left. User ${rooms[roomId].host} is now host of ${roomId}`);
                } else {
                    delete rooms[roomId];
                    console.log(`🗑️ Room ${roomId} is empty and has been deleted.`);
                }
            }
        }
    });
});

server.listen(3000, () => {
    console.log(`🚀 Watch Party Server running on http://localhost:3000`);
    console.log(`📡 Waiting for connections...`);
});