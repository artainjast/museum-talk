import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use('/fonts', express.static(path.join(__dirname, 'node_modules/vazirmatn/fonts/webfonts'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

server.listen(PORT, () => console.log(`museum on http://localhost:${PORT}/`));
