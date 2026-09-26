import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type MapId = 'karachi_city' | 'f1_circuit' | 'firing_range' | 'kemari_docks' | 'derby_dome';

interface PlayerState {
  id: string;
  name: string;
  role: string;
  room: string;
  mode: 'drive' | 'walk' | 'interior';
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  steerAngle: number;
  carId: string;
  bodyColor: string;
  underglowColor: string;
  outfitColor: string;
  weapon: string;
  health: number;
  armor: number;
  kills: number;
  deaths: number;
  bounty: number;
  bestLapMs: number;
  rangeScore: number;
  lastSeen: number;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  system?: boolean;
}

interface SupplyDrop {
  id: string;
  title: string;
  x: number;
  z: number;
  reward: number;
}

interface RoomState {
  id: string;
  code: string;
  mapId: MapId;
  hostId: string;
  hostName: string;
  players: Map<string, PlayerState>;
  chat: ChatMessage[];
  supplyDrop: SupplyDrop;
  createdAt: number;
}

const VALID_MAPS: MapId[] = ['karachi_city', 'f1_circuit', 'firing_range', 'kemari_docks', 'derby_dome'];

const MAP_LABELS: Record<MapId, string> = {
  karachi_city: '🏙️ Karachi Open World (Lyari & Clifton)',
  f1_circuit: '🏎️ Karachi Grand Prix F1 Circuit',
  firing_range: '🎯 IB Tactical Firing Range & Killhouse',
  kemari_docks: '⚓ Kemari Port Container PvP Arena',
  derby_dome: '💥 Clifton Destruction Derby Bowl',
};

const BLOCK = 42;
const SUPPLY_LOCATIONS = [
  { title: 'Lyari IB Dead-Drop Crate', x: 0, z: 0 },
  { title: 'Clifton Bridge Hawala Cache', x: 2 * BLOCK, z: -2 * BLOCK },
  { title: 'Kemari Port RDX Intercept', x: -3 * BLOCK, z: 2 * BLOCK },
  { title: 'Chakiwara Arms Shipment', x: -2 * BLOCK, z: -2 * BLOCK },
  { title: 'South Harbor Intelligence Vault', x: 3 * BLOCK, z: 3 * BLOCK },
  { title: 'Napier Road Syndicate Drop', x: 1 * BLOCK, z: 3 * BLOCK },
  { title: 'Mauripur Highway Supply Crate', x: -3 * BLOCK, z: -3 * BLOCK },
  { title: 'Karachi Press Club Microfilm', x: 2 * BLOCK, z: 1 * BLOCK },
];

function createSupplyDrop(mapId: MapId = 'karachi_city'): SupplyDrop {
  if (mapId !== 'karachi_city') {
    return {
      id: 'drop-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title: 'Arena Center Bonus Drop',
      x: 0,
      z: 0,
      reward: 3000,
    };
  }
  const loc = SUPPLY_LOCATIONS[Math.floor(Math.random() * SUPPLY_LOCATIONS.length)];
  return {
    id: 'drop-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    title: loc.title,
    x: loc.x,
    z: loc.z,
    reward: 2000 + Math.floor(Math.random() * 4) * 500,
  };
}

const rooms = new Map<string, RoomState>();
const clientSockets = new Map<string, WebSocket>();

function normalizeRoomCode(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16);
  return cleaned || 'KARACHI-1';
}

function generateShortRoomCode(mapId: MapId): string {
  const prefixes: Record<MapId, string> = {
    karachi_city: 'KRC',
    f1_circuit: 'F1X',
    firing_range: 'RNG',
    kemari_docks: 'PVP',
    derby_dome: 'DRB',
  };
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = '';
    for (let i = 0; i < 3; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    const candidate = `${prefixes[mapId] || 'DHU'}-${suffix}`;
    if (!rooms.has(candidate)) return candidate;
  }
  return 'DHU-' + Math.floor(100 + Math.random() * 900);
}

function sanitizeMapId(raw: unknown): MapId {
  const s = String(raw || 'karachi_city') as MapId;
  return VALID_MAPS.includes(s) ? s : 'karachi_city';
}

function getOrCreateRoom(rawCode: string, mapId?: MapId, hostId?: string, hostName?: string): RoomState {
  const code = normalizeRoomCode(rawCode);
  let room = rooms.get(code);
  if (!room) {
    const initialMap = sanitizeMapId(mapId);
    room = {
      id: code,
      code,
      mapId: initialMap,
      hostId: hostId || '',
      hostName: hostName || 'IB Command',
      players: new Map(),
      chat: [
        {
          id: 'sys-init-' + Date.now(),
          senderId: 'system',
          senderName: 'IB CONTROL (AJAY SANYAL)',
          text: `Room [${code}] online on map: ${MAP_LABELS[initialMap]}. Share code [${code}] with friends to join!`,
          timestamp: Date.now(),
          system: true,
        },
      ],
      supplyDrop: createSupplyDrop(initialMap),
      createdAt: Date.now(),
    };
    rooms.set(code, room);
  }
  return room;
}

function getPublicRoomsList() {
  const list: Array<{
    code: string;
    mapId: MapId;
    mapLabel: string;
    hostName: string;
    playerCount: number;
  }> = [];
  for (const [, r] of rooms) {
    if (r.players.size > 0 || r.code === 'KARACHI-1') {
      list.push({
        code: r.code,
        mapId: r.mapId,
        mapLabel: MAP_LABELS[r.mapId],
        hostName: r.hostName || 'Operative',
        playerCount: r.players.size,
      });
    }
  }
  return list.slice(0, 25);
}

function broadcastToRoom(roomCode: string, payload: unknown, excludeId?: string) {
  const room = rooms.get(normalizeRoomCode(roomCode));
  if (!room) return;
  const raw = JSON.stringify(payload);
  for (const [pid] of room.players) {
    if (excludeId && pid === excludeId) continue;
    const sock = clientSockets.get(pid);
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(raw);
    }
  }
}

function sendToPlayer(playerId: string, payload: unknown) {
  const sock = clientSockets.get(playerId);
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(payload));
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json());

  // Seed default lobby room
  getOrCreateRoom('KARACHI-1', 'karachi_city', 'system', 'IB Control');

  app.get('/api/health', (_req, res) => {
    let totalPlayers = 0;
    for (const [, r] of rooms) totalPlayers += r.players.size;
    res.json({ status: 'ok', totalPlayers, rooms: getPublicRoomsList() });
  });

  app.get('/api/rooms', (_req, res) => {
    res.json({ rooms: getPublicRoomsList() });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const playerId = 'op-' + Math.random().toString(36).slice(2, 9) + '-' + Date.now().toString(36).slice(-3);
    let currentRoomCode = 'KARACHI-1';

    clientSockets.set(playerId, ws);

    function joinPlayerToRoom(targetCode: string, msg: Record<string, unknown>, forceMapId?: MapId) {
      // Leave previous room if any
      const prevRoom = rooms.get(currentRoomCode);
      if (prevRoom && prevRoom.players.has(playerId)) {
        prevRoom.players.delete(playerId);
        broadcastToRoom(currentRoomCode, { type: 'player:left', id: playerId }, playerId);
      }

      const cleanCode = normalizeRoomCode(targetCode);
      currentRoomCode = cleanCode;
      const callsign = String(msg.name || 'Hamza-' + playerId.slice(3, 6).toUpperCase()).slice(0, 20);
      const room = getOrCreateRoom(cleanCode, forceMapId, playerId, callsign);

      if (forceMapId && VALID_MAPS.includes(forceMapId)) {
        room.mapId = forceMapId;
      }
      if (!room.hostId || !room.players.has(room.hostId)) {
        room.hostId = playerId;
        room.hostName = callsign;
      }

      const newPlayer: PlayerState = {
        id: playerId,
        name: callsign,
        role: String(msg.role || 'IB Deep-Cover (Hamza)').slice(0, 32),
        room: cleanCode,
        mode: msg.mode === 'walk' ? 'walk' : 'drive',
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        heading: Number(msg.heading) || 0,
        speed: Number(msg.speed) || 0,
        steerAngle: Number(msg.steerAngle) || 0,
        carId: String(msg.carId || (room.mapId === 'f1_circuit' ? 'f1' : 'speedster')),
        bodyColor: String(msg.bodyColor || '#eab308'),
        underglowColor: String(msg.underglowColor || '#38bdf8'),
        outfitColor: String(msg.outfitColor || '#1e242b'),
        weapon: String(msg.weapon || 'pistol'),
        health: Math.max(1, Math.min(100, Number(msg.health) || 100)),
        armor: Math.max(0, Math.min(100, Number(msg.armor) || 50)),
        kills: 0,
        deaths: 0,
        bounty: 0,
        bestLapMs: 0,
        rangeScore: 0,
        lastSeen: Date.now(),
      };

      room.players.set(playerId, newPlayer);

      sendToPlayer(playerId, {
        type: 'room:init',
        selfId: playerId,
        room: room.code,
        mapId: room.mapId,
        hostId: room.hostId,
        hostName: room.hostName,
        players: Array.from(room.players.values()),
        chat: room.chat.slice(-25),
        supplyDrop: room.supplyDrop,
        roomsList: getPublicRoomsList(),
      });

      const joinNotice: ChatMessage = {
        id: 'join-' + Date.now() + '-' + playerId,
        senderId: 'system',
        senderName: 'ROOM COMMS',
        text: `Operative ${newPlayer.name} joined Room [${room.code}] (${MAP_LABELS[room.mapId]}).`,
        timestamp: Date.now(),
        system: true,
      };
      room.chat.push(joinNotice);
      if (room.chat.length > 40) room.chat.shift();

      broadcastToRoom(
        room.code,
        {
          type: 'player:joined',
          player: newPlayer,
          chatMessage: joinNotice,
        },
        playerId
      );
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'room:create') {
          const chosenMap = sanitizeMapId(msg.mapId);
          const customCode = msg.customCode ? normalizeRoomCode(msg.customCode) : generateShortRoomCode(chosenMap);
          // If room already exists, still update its map if creator requested it
          joinPlayerToRoom(customCode, msg, chosenMap);
        } else if (msg.type === 'player:join' || msg.type === 'room:switch') {
          const targetCode = normalizeRoomCode(msg.room || 'KARACHI-1');
          const requestedMap = msg.mapId ? sanitizeMapId(msg.mapId) : undefined;
          const existing = rooms.get(targetCode);
          // Only override map if room is brand new
          joinPlayerToRoom(targetCode, msg, existing ? undefined : requestedMap);
        } else if (msg.type === 'room:change_map') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const nextMap = sanitizeMapId(msg.mapId);
          room.mapId = nextMap;
          room.supplyDrop = createSupplyDrop(nextMap);
          const p = room.players.get(playerId);
          const changerName = p ? p.name : 'Host';

          const mapMsg: ChatMessage = {
            id: 'map-' + Date.now(),
            senderId: 'system',
            senderName: 'MAP CONTROL',
            text: `🗺️ ${changerName} switched Room [${room.code}] map to ${MAP_LABELS[nextMap]}! Deploying all operatives...`,
            timestamp: Date.now(),
            system: true,
          };
          room.chat.push(mapMsg);
          if (room.chat.length > 40) room.chat.shift();

          broadcastToRoom(room.code, {
            type: 'room:map_changed',
            mapId: nextMap,
            supplyDrop: room.supplyDrop,
            chatMessage: mapMsg,
          });
        } else if (msg.type === 'rooms:request') {
          sendToPlayer(playerId, {
            type: 'rooms:list',
            roomsList: getPublicRoomsList(),
          });
        } else if (msg.type === 'map:score') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;

          if (msg.kind === 'f1_lap') {
            const lapMs = Math.max(5000, Math.round(Number(msg.value) || 0));
            const isPB = p.bestLapMs === 0 || lapMs < p.bestLapMs;
            if (isPB) p.bestLapMs = lapMs;
            const lapSec = (lapMs / 1000).toFixed(2);
            const scoreMsg: ChatMessage = {
              id: 'lap-' + Date.now() + '-' + Math.random(),
              senderId: 'system',
              senderName: 'F1 TELEMETRY',
              text: `🏁 ${p.name} completed Lap ${msg.lap || 1} in ${lapSec}s${isPB ? ' (★ NEW PERSONAL BEST!)' : ''}!`,
              timestamp: Date.now(),
              system: true,
            };
            room.chat.push(scoreMsg);
            if (room.chat.length > 40) room.chat.shift();
            broadcastToRoom(room.code, {
              type: 'map:score_broadcast',
              playerId: p.id,
              playerName: p.name,
              kind: 'f1_lap',
              value: lapMs,
              bestLapMs: p.bestLapMs,
              chatMessage: scoreMsg,
            });
          } else if (msg.kind === 'firing_range') {
            const pts = Math.max(0, Math.round(Number(msg.value) || 0));
            if (pts > p.rangeScore) p.rangeScore = pts;
            const scoreMsg: ChatMessage = {
              id: 'rng-' + Date.now() + '-' + Math.random(),
              senderId: 'system',
              senderName: 'IB FIRING RANGE',
              text: `🎯 ${p.name} scored ${pts} pts on the IB Live-Fire Range (Best: ${p.rangeScore} pts)!`,
              timestamp: Date.now(),
              system: true,
            };
            room.chat.push(scoreMsg);
            if (room.chat.length > 40) room.chat.shift();
            broadcastToRoom(room.code, {
              type: 'map:score_broadcast',
              playerId: p.id,
              playerName: p.name,
              kind: 'firing_range',
              value: pts,
              rangeScore: p.rangeScore,
              chatMessage: scoreMsg,
            });
          }
        } else if (msg.type === 'player:update') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;

          if (typeof msg.x === 'number' && !Number.isNaN(msg.x)) p.x = msg.x;
          if (typeof msg.y === 'number' && !Number.isNaN(msg.y)) p.y = msg.y;
          if (typeof msg.z === 'number' && !Number.isNaN(msg.z)) p.z = msg.z;
          if (typeof msg.heading === 'number' && !Number.isNaN(msg.heading)) p.heading = msg.heading;
          if (typeof msg.speed === 'number' && !Number.isNaN(msg.speed)) p.speed = msg.speed;
          if (typeof msg.steerAngle === 'number' && !Number.isNaN(msg.steerAngle)) p.steerAngle = msg.steerAngle;
          if (msg.mode === 'drive' || msg.mode === 'walk' || msg.mode === 'interior') p.mode = msg.mode;
          if (typeof msg.carId === 'string') p.carId = msg.carId.slice(0, 24);
          if (typeof msg.bodyColor === 'string') p.bodyColor = msg.bodyColor.slice(0, 16);
          if (typeof msg.underglowColor === 'string') p.underglowColor = msg.underglowColor.slice(0, 16);
          if (typeof msg.outfitColor === 'string') p.outfitColor = msg.outfitColor.slice(0, 16);
          if (typeof msg.weapon === 'string') p.weapon = msg.weapon.slice(0, 20);
          if (typeof msg.health === 'number') p.health = Math.max(0, Math.min(100, msg.health));
          if (typeof msg.armor === 'number') p.armor = Math.max(0, Math.min(100, msg.armor));
          if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim().slice(0, 20);
          if (typeof msg.role === 'string' && msg.role.trim()) p.role = msg.role.trim().slice(0, 32);
          p.lastSeen = Date.now();

          broadcastToRoom(
            currentRoomCode,
            {
              type: 'player:moved',
              id: playerId,
              name: p.name,
              role: p.role,
              mode: p.mode,
              x: p.x,
              y: p.y,
              z: p.z,
              heading: p.heading,
              speed: p.speed,
              steerAngle: p.steerAngle,
              carId: p.carId,
              bodyColor: p.bodyColor,
              underglowColor: p.underglowColor,
              outfitColor: p.outfitColor,
              weapon: p.weapon,
              health: p.health,
              armor: p.armor,
              kills: p.kills,
              bounty: p.bounty,
              bestLapMs: p.bestLapMs,
              rangeScore: p.rangeScore,
            },
            playerId
          );
        } else if (msg.type === 'player:shoot') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;
          broadcastToRoom(
            currentRoomCode,
            {
              type: 'player:shot',
              id: playerId,
              weapon: msg.weapon || p.weapon,
              ox: Number(msg.ox) || p.x,
              oy: Number(msg.oy) || 1.3,
              oz: Number(msg.oz) || p.z,
              tx: Number(msg.tx) || p.x,
              ty: Number(msg.ty) || 1.3,
              tz: Number(msg.tz) || p.z,
            },
            playerId
          );
        } else if (msg.type === 'player:hit') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const attacker = room.players.get(playerId);
          const victim = room.players.get(String(msg.targetId));
          if (!attacker || !victim || attacker.id === victim.id) return;

          const dmg = Math.max(5, Math.min(65, Number(msg.damage) || 22));
          let rem = dmg;
          if (victim.armor > 0) {
            const absorb = Math.min(victim.armor, Math.round(rem * 0.65));
            victim.armor -= absorb;
            rem -= absorb;
          }
          victim.health = Math.max(0, victim.health - rem);

          if (victim.health <= 0) {
            victim.health = 100;
            victim.armor = 50;
            victim.deaths += 1;
            attacker.kills += 1;
            const reward = 1500;
            attacker.bounty += reward;

            const killMsg: ChatMessage = {
              id: 'kill-' + Date.now() + '-' + Math.random(),
              senderId: 'system',
              senderName: 'COMBAT INTEL',
              text: `💥 ${attacker.name} neutralized ${victim.name} (${msg.weapon || attacker.weapon}) · +$${reward} Bounty!`,
              timestamp: Date.now(),
              system: true,
            };
            room.chat.push(killMsg);
            if (room.chat.length > 40) room.chat.shift();

            broadcastToRoom(currentRoomCode, {
              type: 'combat:kill',
              attackerId: attacker.id,
              attackerName: attacker.name,
              attackerKills: attacker.kills,
              attackerBounty: attacker.bounty,
              victimId: victim.id,
              victimName: victim.name,
              weapon: msg.weapon || attacker.weapon,
              reward,
              chatMessage: killMsg,
            });
          } else {
            broadcastToRoom(currentRoomCode, {
              type: 'player:damaged',
              targetId: victim.id,
              attackerId: attacker.id,
              attackerName: attacker.name,
              damage: dmg,
              health: victim.health,
              armor: victim.armor,
            });
          }
        } else if (msg.type === 'supply:claim') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p || !room.supplyDrop) return;
          if (msg.dropId && msg.dropId !== room.supplyDrop.id) return;

          const dx = p.x - room.supplyDrop.x;
          const dz = p.z - room.supplyDrop.z;
          if (Math.sqrt(dx * dx + dz * dz) <= 18) {
            const claimed = room.supplyDrop;
            p.bounty += claimed.reward;
            room.supplyDrop = createSupplyDrop(room.mapId);

            const claimMsg: ChatMessage = {
              id: 'drop-' + Date.now(),
              senderId: 'system',
              senderName: 'IB SUPPLY DROP',
              text: `📦 ${p.name} secured [${claimed.title}] for +$${claimed.reward}!`,
              timestamp: Date.now(),
              system: true,
            };
            room.chat.push(claimMsg);
            if (room.chat.length > 40) room.chat.shift();

            broadcastToRoom(currentRoomCode, {
              type: 'supply:claimed',
              winnerId: p.id,
              winnerName: p.name,
              reward: claimed.reward,
              claimedTitle: claimed.title,
              nextDrop: room.supplyDrop,
              chatMessage: claimMsg,
            });
          }
        } else if (msg.type === 'chat:send') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          const text = String(msg.text || '').trim().slice(0, 180);
          if (!text) return;

          const chatMessage: ChatMessage = {
            id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            senderId: playerId,
            senderName: p ? p.name : 'Operative',
            text,
            timestamp: Date.now(),
          };
          room.chat.push(chatMessage);
          if (room.chat.length > 40) room.chat.shift();

          broadcastToRoom(currentRoomCode, {
            type: 'chat:message',
            chatMessage,
          });
        }
      } catch (_err) {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      clientSockets.delete(playerId);
      const room = rooms.get(currentRoomCode);
      if (room && room.players.has(playerId)) {
        const leaving = room.players.get(playerId)!;
        room.players.delete(playerId);
        const leaveNotice: ChatMessage = {
          id: 'leave-' + Date.now() + '-' + playerId,
          senderId: 'system',
          senderName: 'ROOM COMMS',
          text: `Operative ${leaving.name} left Room [${room.code}].`,
          timestamp: Date.now(),
          system: true,
        };
        room.chat.push(leaveNotice);
        if (room.chat.length > 40) room.chat.shift();

        broadcastToRoom(currentRoomCode, {
          type: 'player:left',
          id: playerId,
          chatMessage: leaveNotice,
        });
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dhurandhar Multiplayer Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
