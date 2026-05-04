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

    // --- NEW: Typing indicator — relay to everyone else in the room ---
    socket.on('typing', (data) => {
        socket.to(data.roomId).emit('user_typing', { sender: data.sender });
    });

    // --- NEW: Stopped typing — relay to everyone else in the room ---
    socket.on('stopped_typing', (data) => {
        socket.to(data.roomId).emit('user_stopped', { sender: data.sender });
    });

    // --- NEW: Emoji reaction — relay to everyone else in the room ---
    socket.on('reaction', (data) => {
        console.log(`🎉 Reaction in ${data.roomId} from ${data.sender}: ${data.emoji}`);
        socket.to(data.roomId).emit('reaction', { emoji: data.emoji, sender: data.sender });
    });

    // Disconnect & host reassignment
    socket.on('disconnect', () => {
        console.log(`🔴 User disconnected: ${socket.id}`);
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