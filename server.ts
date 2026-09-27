import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type MapId = 'karachi_city' | 'f1_circuit' | 'f1_marina' | 'firing_range' | 'kemari_docks' | 'derby_dome';

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
  teamId: string;
  teamName: string;
  bodyColor: string;
  stripeColor: string;
  rimColor: string;
  underglowColor: string;
  tireCompound: 'soft' | 'medium' | 'hard';
  ready: boolean;
  gridIndex: number;
  raceLap: number;
  raceGate: number;
  pitCount: number;
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

interface RaceFinishEntry {
  id: string;
  name: string;
  teamName: string;
  carId: string;
  position: number;
  totalTimeMs: number;
  bestLapMs: number;
  pitCount: number;
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
  raceStatus: 'lobby' | 'countdown' | 'racing' | 'finished';
  raceStartTime: number;
  raceTotalLaps: number;
  finishOrder: RaceFinishEntry[];
  countdownTimer?: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const VALID_MAPS: MapId[] = ['karachi_city', 'f1_circuit', 'f1_marina', 'firing_range', 'kemari_docks', 'derby_dome'];

const MAP_LABELS: Record<MapId, string> = {
  karachi_city: '🏙️ Karachi Open World (Lyari & Clifton)',
  f1_circuit: '🏎️ Karachi Grand Prix F1 Stadium Circuit',
  f1_marina: '🌃 Clifton Night Marina GP (Street F1 Circuit)',
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
    f1_marina: 'MGP',
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

function sanitizeTireCompound(raw: unknown): 'soft' | 'medium' | 'hard' {
  const s = String(raw || 'soft').toLowerCase();
  if (s === 'medium' || s === 'hard') return s;
  return 'soft';
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
      raceStatus: 'lobby',
      raceStartTime: 0,
      raceTotalLaps: 3,
      finishOrder: [],
      createdAt: Date.now(),
    };
    rooms.set(code, room);
  }
  return room;
}

function triggerRaceCountdown(room: RoomState, initiatorName?: string) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
  }
  room.raceStatus = 'countdown';
  room.finishOrder = [];
  room.raceStartTime = Date.now() + 5000;

  let slot = 0;
  for (const [, p] of room.players) {
    p.gridIndex = slot++;
    const sp = getSpawnForMapAndSlot(room.mapId, p.gridIndex);
    p.x = sp.x;
    p.z = sp.z;
    p.heading = sp.heading;
    p.mode = sp.mode;
    p.speed = 0;
    p.raceLap = 1;
    p.raceGate = 0;
    p.pitCount = 0;
  }

  const cdMsg: ChatMessage = {
    id: 'cd-' + Date.now(),
    senderId: 'system',
    senderName: 'FIA RACE DIRECTOR',
    text: `🚥 ALL DRIVERS READY${initiatorName ? ` (${initiatorName})` : ''}! Cars on the Starting Grid — 5 Red Lights sequence initiated!`,
    timestamp: Date.now(),
    system: true,
  };
  room.chat.push(cdMsg);
  if (room.chat.length > 40) room.chat.shift();

  broadcastToRoom(room.code, {
    type: 'race:countdown_start',
    mapId: room.mapId,
    countdownMs: 5000,
    totalLaps: room.raceTotalLaps,
    players: Array.from(room.players.values()),
    chatMessage: cdMsg,
  });

  room.countdownTimer = setTimeout(() => {
    room.raceStatus = 'racing';
    room.raceStartTime = Date.now();
    const goMsg: ChatMessage = {
      id: 'go-' + Date.now(),
      senderId: 'system',
      senderName: 'FIA RACE DIRECTOR',
      text: `🟢 LIGHTS OUT AND AWAY WE GO! ${room.raceTotalLaps}-Lap Grand Prix is LIVE on ${MAP_LABELS[room.mapId]}!`,
      timestamp: Date.now(),
      system: true,
    };
    room.chat.push(goMsg);
    if (room.chat.length > 40) room.chat.shift();

    broadcastToRoom(room.code, {
      type: 'race:lights_out',
      raceStartTime: room.raceStartTime,
      totalLaps: room.raceTotalLaps,
      chatMessage: goMsg,
    });
  }, 5000);
}

function checkAllPlayersReadyAndStart(room: RoomState) {
  if (room.players.size === 0) return;
  if (room.raceStatus === 'countdown') return;
  let allReady = true;
  for (const [, p] of room.players) {
    if (!p.ready) {
      allReady = false;
      break;
    }
  }
  if (allReady) {
    // Ensure room is on an F1 circuit if someone readied up in F1 paddock
    if (room.mapId !== 'f1_circuit' && room.mapId !== 'f1_marina') {
      room.mapId = 'f1_circuit';
    }
    triggerRaceCountdown(room);
  }
}

function getPublicRoomsList() {
  const list: Array<{
    code: string;
    mapId: MapId;
    mapLabel: string;
    hostName: string;
    playerCount: number;
    playerNames: string[];
  }> = [];
  for (const [, r] of rooms) {
    if (r.players.size > 0 || r.code === 'KARACHI-1') {
      const names = Array.from(r.players.values()).map((p) => `${p.name} (${p.carId})`);
      list.push({
        code: r.code,
        mapId: r.mapId,
        mapLabel: MAP_LABELS[r.mapId],
        hostName: r.hostName || (names[0] ? names[0] : 'Operative'),
        playerCount: r.players.size,
        playerNames: names,
      });
    }
  }
  return list.slice(0, 25);
}

function getSpawnForMapAndSlot(mapId: MapId, slotIndex: number): { x: number; z: number; heading: number; mode: 'drive' | 'walk' } {
  const idx = Math.max(0, slotIndex || 0);
  const row = Math.floor(idx / 2);
  const col = idx % 2 === 0 ? -1 : 1;
  const staggerZ = idx % 2 === 1 ? -3.5 : 0;
  if (mapId === 'f1_circuit') {
    return {
      x: Number((145 + col * 4.2).toFixed(2)),
      z: Number((12 + row * 9.5 + staggerZ).toFixed(2)),
      heading: Math.PI,
      mode: 'drive',
    };
  }
  if (mapId === 'f1_marina') {
    return {
      x: Number((-12 - row * 9.5 - staggerZ).toFixed(2)),
      z: Number((96 + col * 4.2).toFixed(2)),
      heading: Number((Math.PI / 2).toFixed(3)),
      mode: 'drive',
    };
  }
  if (mapId === 'firing_range') {
    return {
      x: Number((col * (3.5 + row * 3)).toFixed(2)),
      z: 15.5,
      heading: Math.PI,
      mode: 'walk',
    };
  }
  if (mapId === 'kemari_docks') {
    const ang = (idx * Math.PI) / 3;
    return {
      x: Number((Math.cos(ang) * 28).toFixed(2)),
      z: Number((Math.sin(ang) * 28).toFixed(2)),
      heading: Number((ang + Math.PI).toFixed(3)),
      mode: 'walk',
    };
  }
  if (mapId === 'derby_dome') {
    const ang = (idx * Math.PI) / 3;
    return {
      x: Number((Math.cos(ang) * 38).toFixed(2)),
      z: Number((Math.sin(ang) * 38).toFixed(2)),
      heading: Number((ang + Math.PI).toFixed(3)),
      mode: 'drive',
    };
  }
  // Default: karachi_city side-by-side spawn
  return {
    x: Number((col * (3.2 + row * 2.5)).toFixed(2)),
    z: Number((16 + row * 6).toFixed(2)),
    heading: 0,
    mode: 'drive',
  };
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

  // Hybrid HTTP Real-Time Sync Endpoint (guarantees multiplayer visibility even across HTTP proxies or when WS reconnects)
  app.post('/api/mp/sync', (req, res) => {
    try {
      const body = req.body || {};
      const pid = String(body.selfId || '').trim();
      if (!pid) {
        res.status(400).json({ error: 'Missing selfId' });
        return;
      }
      const targetCode = normalizeRoomCode(body.room || 'KARACHI-1');
      const callsign = String(body.name || 'Hamza-IB').trim().slice(0, 20) || 'Hamza-IB';
      const room = getOrCreateRoom(targetCode, body.mapId ? sanitizeMapId(body.mapId) : undefined, pid, callsign);

      // Remove from any other room if player switched rooms
      for (const [rCode, r] of rooms) {
        if (rCode !== room.code && r.players.has(pid)) {
          r.players.delete(pid);
          broadcastToRoom(rCode, { type: 'player:left', id: pid }, pid);
        }
      }

      let p = room.players.get(pid);
      const isF1 = room.mapId === 'f1_circuit' || room.mapId === 'f1_marina';
      if (!p) {
        const slot = room.players.size;
        const sp = getSpawnForMapAndSlot(room.mapId, slot);
        p = {
          id: pid,
          name: callsign,
          role: String(body.role || 'IB Deep-Cover (Hamza)').slice(0, 32),
          room: room.code,
          mode: body.mode === 'walk' || body.mode === 'interior' ? body.mode : sp.mode,
          x: typeof body.x === 'number' && !Number.isNaN(body.x) ? body.x : sp.x,
          y: 0,
          z: typeof body.z === 'number' && !Number.isNaN(body.z) ? body.z : sp.z,
          heading: typeof body.heading === 'number' && !Number.isNaN(body.heading) ? body.heading : sp.heading,
          speed: Number(body.speed) || 0,
          steerAngle: Number(body.steerAngle) || 0,
          carId: String(body.carId || (isF1 ? 'f1' : 'speedster')).slice(0, 24),
          teamId: String(body.teamId || 'ferrari_corsa').slice(0, 24),
          teamName: String(body.teamName || 'Scuderia Corsa Rossa').slice(0, 36),
          bodyColor: String(body.bodyColor || '#dc2626').slice(0, 16),
          stripeColor: String(body.stripeColor || '#ffffff').slice(0, 16),
          rimColor: String(body.rimColor || '#facc15').slice(0, 16),
          underglowColor: String(body.underglowColor || '#38bdf8').slice(0, 16),
          tireCompound: sanitizeTireCompound(body.tireCompound),
          ready: Boolean(body.ready),
          gridIndex: slot,
          raceLap: Number(body.raceLap) || 1,
          raceGate: Number(body.raceGate) || 0,
          pitCount: Number(body.pitCount) || 0,
          outfitColor: String(body.outfitColor || '#1e242b').slice(0, 16),
          weapon: String(body.weapon || 'pistol').slice(0, 20),
          health: Math.max(1, Math.min(100, Number(body.health) || 100)),
          armor: Math.max(0, Math.min(100, Number(body.armor) || 50)),
          kills: 0,
          deaths: 0,
          bounty: 0,
          bestLapMs: 0,
          rangeScore: 0,
          lastSeen: Date.now(),
        };
        room.players.set(pid, p);
        broadcastToRoom(room.code, { type: 'player:joined', player: p }, pid);
      } else {
        p.name = callsign;
        if (typeof body.role === 'string' && body.role.trim()) p.role = body.role.trim().slice(0, 32);
        if (typeof body.x === 'number' && !Number.isNaN(body.x)) p.x = body.x;
        if (typeof body.z === 'number' && !Number.isNaN(body.z)) p.z = body.z;
        if (typeof body.heading === 'number' && !Number.isNaN(body.heading)) p.heading = body.heading;
        if (typeof body.speed === 'number' && !Number.isNaN(body.speed)) p.speed = body.speed;
        if (typeof body.steerAngle === 'number' && !Number.isNaN(body.steerAngle)) p.steerAngle = body.steerAngle;
        if (body.mode === 'drive' || body.mode === 'walk' || body.mode === 'interior') p.mode = body.mode;
        if (typeof body.carId === 'string' && body.carId) p.carId = body.carId.slice(0, 24);
        if (typeof body.teamId === 'string' && body.teamId) p.teamId = body.teamId.slice(0, 24);
        if (typeof body.teamName === 'string' && body.teamName) p.teamName = body.teamName.slice(0, 36);
        if (typeof body.bodyColor === 'string' && body.bodyColor) p.bodyColor = body.bodyColor.slice(0, 16);
        if (typeof body.stripeColor === 'string' && body.stripeColor) p.stripeColor = body.stripeColor.slice(0, 16);
        if (typeof body.rimColor === 'string' && body.rimColor) p.rimColor = body.rimColor.slice(0, 16);
        if (typeof body.underglowColor === 'string' && body.underglowColor) p.underglowColor = body.underglowColor.slice(0, 16);
        if (body.tireCompound) p.tireCompound = sanitizeTireCompound(body.tireCompound);
        if (typeof body.ready === 'boolean') p.ready = body.ready;
        if (typeof body.outfitColor === 'string' && body.outfitColor) p.outfitColor = body.outfitColor.slice(0, 16);
        if (typeof body.health === 'number') p.health = Math.max(0, Math.min(100, body.health));
        if (typeof body.armor === 'number') p.armor = Math.max(0, Math.min(100, body.armor));
        p.lastSeen = Date.now();

        // Also push to any WebSocket peers in the room if this client has no open WS
        const wsSock = clientSockets.get(pid);
        if (!wsSock || wsSock.readyState !== WebSocket.OPEN) {
          broadcastToRoom(
            room.code,
            {
              type: 'player:moved',
              ...p,
            },
            pid
          );
        }
      }

      // Prune stale HTTP-only players inactive for >15s
      const now = Date.now();
      for (const [otherId, otherP] of room.players) {
        const otherSock = clientSockets.get(otherId);
        const wsAlive = otherSock && otherSock.readyState === WebSocket.OPEN;
        if (!wsAlive && now - otherP.lastSeen > 15000) {
          room.players.delete(otherId);
          broadcastToRoom(room.code, { type: 'player:left', id: otherId });
        }
      }

      res.json({
        selfId: pid,
        room: room.code,
        mapId: room.mapId,
        raceStatus: room.raceStatus,
        raceTotalLaps: room.raceTotalLaps,
        finishOrder: room.finishOrder,
        players: Array.from(room.players.values()),
        chat: room.chat.slice(-25),
        supplyDrop: room.supplyDrop,
        roomsList: getPublicRoomsList(),
      });
    } catch (_e) {
      res.status(500).json({ error: 'sync error' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    let playerId = 'op-' + Math.random().toString(36).slice(2, 9) + '-' + Date.now().toString(36).slice(-3);
    let currentRoomCode = 'KARACHI-1';

    clientSockets.set(playerId, ws);

    function adoptClientId(rawClientId: unknown) {
      if (typeof rawClientId === 'string' && rawClientId.trim().length >= 4) {
        const cleanId = rawClientId.trim().slice(0, 32);
        if (cleanId !== playerId) {
          clientSockets.delete(playerId);
          playerId = cleanId;
          clientSockets.set(playerId, ws);
        }
      }
    }

    function joinPlayerToRoom(targetCode: string, msg: Record<string, unknown>, forceMapId?: MapId) {
      adoptClientId(msg.clientId);
      // Leave previous room if any
      for (const [rCode, r] of rooms) {
        if (rCode !== normalizeRoomCode(targetCode) && r.players.has(playerId)) {
          r.players.delete(playerId);
          broadcastToRoom(rCode, { type: 'player:left', id: playerId, roomsList: getPublicRoomsList() }, playerId);
        }
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

      const isF1Map = room.mapId === 'f1_circuit' || room.mapId === 'f1_marina';
      const assignedSlot = room.players.size;
      const defaultSpawn = getSpawnForMapAndSlot(room.mapId, assignedSlot);
      const clientMapMatches = msg.mapId === room.mapId;

      const newPlayer: PlayerState = {
        id: playerId,
        name: callsign,
        role: String(msg.role || 'IB Deep-Cover (Hamza)').slice(0, 32),
        room: cleanCode,
        mode: clientMapMatches && (msg.mode === 'walk' || msg.mode === 'drive') ? msg.mode : defaultSpawn.mode,
        x: clientMapMatches && typeof msg.x === 'number' && (msg.x !== 0 || msg.z !== 16) ? Number(msg.x) : defaultSpawn.x,
        y: Number(msg.y) || 0,
        z: clientMapMatches && typeof msg.z === 'number' && (msg.x !== 0 || msg.z !== 16) ? Number(msg.z) : defaultSpawn.z,
        heading: clientMapMatches && typeof msg.heading === 'number' ? Number(msg.heading) : defaultSpawn.heading,
        speed: Number(msg.speed) || 0,
        steerAngle: Number(msg.steerAngle) || 0,
        carId: String(msg.carId || (isF1Map ? 'f1' : 'speedster')).slice(0, 24),
        teamId: String(msg.teamId || 'ferrari_corsa').slice(0, 24),
        teamName: String(msg.teamName || 'Scuderia Corsa Rossa').slice(0, 36),
        bodyColor: String(msg.bodyColor || '#dc2626').slice(0, 16),
        stripeColor: String(msg.stripeColor || '#ffffff').slice(0, 16),
        rimColor: String(msg.rimColor || '#facc15').slice(0, 16),
        underglowColor: String(msg.underglowColor || '#38bdf8').slice(0, 16),
        tireCompound: sanitizeTireCompound(msg.tireCompound),
        ready: Boolean(msg.ready),
        gridIndex: assignedSlot,
        raceLap: 1,
        raceGate: 0,
        pitCount: 0,
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
        raceStatus: room.raceStatus,
        raceTotalLaps: room.raceTotalLaps,
        finishOrder: room.finishOrder,
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
          joinPlayerToRoom(customCode, msg, chosenMap);
        } else if (msg.type === 'player:join' || msg.type === 'room:switch') {
          const targetCode = normalizeRoomCode(msg.room || 'KARACHI-1');
          const requestedMap = msg.mapId ? sanitizeMapId(msg.mapId) : undefined;
          const existing = rooms.get(targetCode);
          joinPlayerToRoom(targetCode, msg, existing ? undefined : requestedMap);
        } else if (msg.type === 'room:change_map') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const nextMap = sanitizeMapId(msg.mapId);
          room.mapId = nextMap;
          room.raceStatus = 'lobby';
          room.finishOrder = [];
          let slot = 0;
          for (const [, rp] of room.players) {
            rp.gridIndex = slot++;
            const sp = getSpawnForMapAndSlot(nextMap, rp.gridIndex);
            rp.x = sp.x;
            rp.z = sp.z;
            rp.heading = sp.heading;
            rp.mode = sp.mode;
            rp.speed = 0;
            rp.ready = false;
            rp.raceLap = 1;
            rp.raceGate = 0;
            rp.pitCount = 0;
            if ((nextMap === 'f1_circuit' || nextMap === 'f1_marina') && rp.carId === 'speedster') {
              rp.carId = 'f1';
            }
          }
          room.supplyDrop = createSupplyDrop(nextMap);
          const p = room.players.get(playerId);
          const changerName = p ? p.name : 'Host';

          const mapMsg: ChatMessage = {
            id: 'map-' + Date.now(),
            senderId: 'system',
            senderName: 'MAP CONTROL',
            text: `🗺️ ${changerName} switched Room [${room.code}] map to ${MAP_LABELS[nextMap]}!`,
            timestamp: Date.now(),
            system: true,
          };
          room.chat.push(mapMsg);
          if (room.chat.length > 40) room.chat.shift();

          broadcastToRoom(room.code, {
            type: 'room:map_changed',
            mapId: nextMap,
            raceStatus: room.raceStatus,
            players: Array.from(room.players.values()),
            supplyDrop: room.supplyDrop,
            chatMessage: mapMsg,
          });
        } else if (msg.type === 'race:select_loadout') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;

          if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim().slice(0, 20);
          if (typeof msg.teamId === 'string') p.teamId = msg.teamId.slice(0, 24);
          if (typeof msg.teamName === 'string') p.teamName = msg.teamName.slice(0, 36);
          if (typeof msg.carId === 'string') p.carId = msg.carId.slice(0, 24);
          if (typeof msg.bodyColor === 'string') p.bodyColor = msg.bodyColor.slice(0, 16);
          if (typeof msg.stripeColor === 'string') p.stripeColor = msg.stripeColor.slice(0, 16);
          if (typeof msg.rimColor === 'string') p.rimColor = msg.rimColor.slice(0, 16);
          if (msg.tireCompound) p.tireCompound = sanitizeTireCompound(msg.tireCompound);
          if (typeof msg.totalLaps === 'number') {
            room.raceTotalLaps = Math.max(1, Math.min(10, Math.round(msg.totalLaps)));
          }

          broadcastToRoom(room.code, {
            type: 'race:lobby_state',
            mapId: room.mapId,
            raceStatus: room.raceStatus,
            raceTotalLaps: room.raceTotalLaps,
            players: Array.from(room.players.values()),
          });
        } else if (msg.type === 'race:toggle_ready') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;

          if (typeof msg.name === 'string' && msg.name.trim()) p.name = msg.name.trim().slice(0, 20);
          if (typeof msg.teamId === 'string') p.teamId = msg.teamId.slice(0, 24);
          if (typeof msg.teamName === 'string') p.teamName = msg.teamName.slice(0, 36);
          if (typeof msg.carId === 'string') p.carId = msg.carId.slice(0, 24);
          if (typeof msg.bodyColor === 'string') p.bodyColor = msg.bodyColor.slice(0, 16);
          if (typeof msg.stripeColor === 'string') p.stripeColor = msg.stripeColor.slice(0, 16);
          if (typeof msg.rimColor === 'string') p.rimColor = msg.rimColor.slice(0, 16);
          if (msg.tireCompound) p.tireCompound = sanitizeTireCompound(msg.tireCompound);
          if (msg.mapId) {
            const reqMap = sanitizeMapId(msg.mapId);
            if (reqMap === 'f1_circuit' || reqMap === 'f1_marina') {
              room.mapId = reqMap;
            }
          }

          p.ready = msg.ready !== undefined ? Boolean(msg.ready) : !p.ready;

          let readyCount = 0;
          for (const [, rp] of room.players) {
            if (rp.ready) readyCount++;
          }

          const rdyMsg: ChatMessage = {
            id: 'rdy-' + Date.now() + '-' + Math.random(),
            senderId: 'system',
            senderName: 'F1 PADDOCK',
            text: p.ready
              ? `✅ ${p.name} [${p.teamName}] is READY on ${p.tireCompound.toUpperCase()} tires (${readyCount}/${room.players.size} Ready)!`
              : `⏸ ${p.name} is adjusting garage setup (${readyCount}/${room.players.size} Ready).`,
            timestamp: Date.now(),
            system: true,
          };
          room.chat.push(rdyMsg);
          if (room.chat.length > 40) room.chat.shift();

          broadcastToRoom(room.code, {
            type: 'race:lobby_state',
            mapId: room.mapId,
            raceStatus: room.raceStatus,
            raceTotalLaps: room.raceTotalLaps,
            players: Array.from(room.players.values()),
            chatMessage: rdyMsg,
          });

          checkAllPlayersReadyAndStart(room);
        } else if (msg.type === 'race:force_start') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (msg.mapId) {
            const reqMap = sanitizeMapId(msg.mapId);
            if (reqMap === 'f1_circuit' || reqMap === 'f1_marina') room.mapId = reqMap;
          }
          for (const [, rp] of room.players) rp.ready = true;
          triggerRaceCountdown(room, p ? p.name : 'Race Host');
        } else if (msg.type === 'race:reset') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          if (room.countdownTimer) clearTimeout(room.countdownTimer);
          room.raceStatus = 'lobby';
          room.finishOrder = [];
          for (const [, rp] of room.players) {
            rp.ready = false;
            rp.raceLap = 1;
            rp.raceGate = 0;
            rp.pitCount = 0;
          }
          broadcastToRoom(room.code, {
            type: 'race:lobby_state',
            mapId: room.mapId,
            raceStatus: room.raceStatus,
            raceTotalLaps: room.raceTotalLaps,
            players: Array.from(room.players.values()),
          });
        } else if (msg.type === 'race:pit_stop') {
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const p = room.players.get(playerId);
          if (!p) return;

          p.pitCount = (p.pitCount || 0) + 1;
          if (msg.tireCompound) p.tireCompound = sanitizeTireCompound(msg.tireCompound);
          const stopDur = Number(msg.durationSec) || 2.4;

          const pitMsg: ChatMessage = {
            id: 'pit-' + Date.now() + '-' + Math.random(),
            senderId: 'system',
            senderName: 'F1 PIT WALL',
            text: `🔧 BOX BOX! ${p.name} (${p.teamName}) completed a ${stopDur.toFixed(1)}s Pit Stop → Fitted fresh ${p.tireCompound.toUpperCase()} compound tires (Stop #${p.pitCount})!`,
            timestamp: Date.now(),
            system: true,
          };
          room.chat.push(pitMsg);
          if (room.chat.length > 40) room.chat.shift();

          broadcastToRoom(room.code, {
            type: 'race:pit_broadcast',
            playerId: p.id,
            playerName: p.name,
            teamName: p.teamName,
            tireCompound: p.tireCompound,
            pitCount: p.pitCount,
            chatMessage: pitMsg,
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
            const lapMs = Math.max(4000, Math.round(Number(msg.value) || 0));
            const lapNum = Math.max(1, Math.round(Number(msg.lap) || 1));
            const isPB = p.bestLapMs === 0 || lapMs < p.bestLapMs;
            if (isPB) p.bestLapMs = lapMs;
            p.raceLap = lapNum + 1;
            const lapSec = (lapMs / 1000).toFixed(2);

            const finishedRace = lapNum >= (room.raceTotalLaps || 3);
            if (finishedRace && !room.finishOrder.some((f) => f.id === p.id)) {
              const pos = room.finishOrder.length + 1;
              const totalTimeMs = room.raceStartTime > 0 ? Math.max(lapMs, Date.now() - room.raceStartTime) : lapMs * lapNum;
              const entry: RaceFinishEntry = {
                id: p.id,
                name: p.name,
                teamName: p.teamName,
                carId: p.carId,
                position: pos,
                totalTimeMs,
                bestLapMs: p.bestLapMs,
                pitCount: p.pitCount || 0,
              };
              room.finishOrder.push(entry);
              p.ready = false;

              const medals = ['🏆 P1 WINNER', '🥈 P2 PODIUM', '🥉 P3 PODIUM'];
              const badge = medals[pos - 1] || `🏁 P${pos} FINISHER`;
              const finMsg: ChatMessage = {
                id: 'fin-' + Date.now() + '-' + Math.random(),
                senderId: 'system',
                senderName: 'FIA CHECKERED FLAG',
                text: `${badge}! ${p.name} [${p.teamName}] finished the ${room.raceTotalLaps}-Lap Grand Prix! Best Lap: ${(p.bestLapMs / 1000).toFixed(2)}s · Pit Stops: ${p.pitCount || 0}`,
                timestamp: Date.now(),
                system: true,
              };
              room.chat.push(finMsg);
              if (room.chat.length > 40) room.chat.shift();

              if (room.finishOrder.length >= room.players.size) {
                room.raceStatus = 'finished';
              }

              broadcastToRoom(room.code, {
                type: 'race:driver_finished',
                entry,
                finishOrder: room.finishOrder,
                raceStatus: room.raceStatus,
                players: Array.from(room.players.values()),
                chatMessage: finMsg,
              });
            } else {
              const scoreMsg: ChatMessage = {
                id: 'lap-' + Date.now() + '-' + Math.random(),
                senderId: 'system',
                senderName: 'F1 TELEMETRY',
                text: `🏁 ${p.name} [${p.teamName}] completed Lap ${lapNum}/${room.raceTotalLaps || 3} in ${lapSec}s${isPB ? ' (★ PURPLE SECTOR PB!)' : ''}!`,
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
                lap: lapNum,
                value: lapMs,
                bestLapMs: p.bestLapMs,
                chatMessage: scoreMsg,
              });
            }
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
          if (typeof msg.teamId === 'string') p.teamId = msg.teamId.slice(0, 24);
          if (typeof msg.teamName === 'string') p.teamName = msg.teamName.slice(0, 36);
          if (typeof msg.bodyColor === 'string') p.bodyColor = msg.bodyColor.slice(0, 16);
          if (typeof msg.stripeColor === 'string') p.stripeColor = msg.stripeColor.slice(0, 16);
          if (typeof msg.rimColor === 'string') p.rimColor = msg.rimColor.slice(0, 16);
          if (typeof msg.underglowColor === 'string') p.underglowColor = msg.underglowColor.slice(0, 16);
          if (msg.tireCompound) p.tireCompound = sanitizeTireCompound(msg.tireCompound);
          if (typeof msg.raceLap === 'number') p.raceLap = msg.raceLap;
          if (typeof msg.raceGate === 'number') p.raceGate = msg.raceGate;
          if (typeof msg.pitCount === 'number') p.pitCount = msg.pitCount;
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
              teamId: p.teamId,
              teamName: p.teamName,
              bodyColor: p.bodyColor,
              stripeColor: p.stripeColor,
              rimColor: p.rimColor,
              underglowColor: p.underglowColor,
              tireCompound: p.tireCompound,
              ready: p.ready,
              raceLap: p.raceLap,
              raceGate: p.raceGate,
              pitCount: p.pitCount,
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
