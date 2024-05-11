const { networkInterfaces } = require('os');

const nets = networkInterfaces();
const results = Object.create(null); // Or just '{}', an empty object

for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {

        const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
        if (net.family === familyV4Value && !net.internal) {
            if (!results[name]) {
                results[name] = [];
            }
            results[name].push(net.address);
        }
    }
}

const io = require('socket.io')(3500, {
    cors: {
        // origin: ['http://localhost:3000',
        //          'http://'+results.en0+':3000']
        origin: ['https://virajsonaje.github.io/snake-ladder']
    }
});

let allRooms = new Map();

io.on('connection', socket => {
    console.log(socket.id);
    socket.on('send-roll', (data) => {
        socket.to(data.Room).emit("recieve-roll", data);
    })

    socket.on('join-room', room => {
        allRooms[room]
        console.log("joined %s", room);
        socket.join(room);
    })
});