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

// --- NEW: State Management ---
// We will store the host of each room here. Example: { 'test-party-123': { host: 'socket_id_abc' } }
const rooms = {}; 

io.on('connection', (socket) => {
    console.log(`🟢 User connected: ${socket.id}`);

    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`🚪 User ${socket.id} joined room: ${roomId}`);

        // If the room doesn't exist yet, this person is the Host
        if (!rooms[roomId]) {
            rooms[roomId] = { host: socket.id };
            console.log(`👑 User ${socket.id} is the host of ${roomId}`);
        } else {
            // If the room already exists, tell the Host to pause and sync the new person
            // We only send this message to the Host, not the whole room
            const shortId = socket.id.substring(0, 4); // Just grabbed 4 letters for a display name
            io.to(rooms[roomId].host).emit('latecomer_arrived', { newUserId: shortId });
        }
    });

    // Handle normal play/pause/seek commands (Works for ANY member)
    socket.on('sync_state', (data) => {
        // Broadcast to everyone else
        socket.to(data.roomId).emit('sync_state', data);
    });
    // --- CHAT LOGIC ---
    socket.on('chat_message', (data) => {
        // data looks like: { roomId: 'matrix-01', text: 'Hello!', sender: 'User123' }
        console.log(`💬 Chat in ${data.roomId} from ${data.sender}: ${data.text}`);
        
        // Broadcast the message to everyone else in the room
        socket.to(data.roomId).emit('chat_message', data);
    });

    // Handle Disconnects & Host Reassignment
    socket.on('disconnect', () => {
        console.log(`🔴 User disconnected: ${socket.id}`);
        // If the host leaves, we need to assign a new host!
        for (let roomId in rooms) {
            if (rooms[roomId].host === socket.id) {
                const clients = io.sockets.adapter.rooms.get(roomId);
                if (clients && clients.size > 0) {
                    rooms[roomId].host = [...clients][0]; // Give the crown to the next person in line
                    console.log(`👑 Host left. User ${rooms[roomId].host} is now host of ${roomId}`);
                } else {
                    delete rooms[roomId]; // Room is empty, destroy it
                }
            }
        }
    });
});

server.listen(3000, () => {
    console.log(`🚀 Watch Party Server running on http://localhost:3000`);
    console.log(`📡 Waiting for connections...`);
});