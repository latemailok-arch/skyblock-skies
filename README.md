# Skyblock Skies

A local-network multiplayer Three.js airplane shooter. Launch a fighter jet, hunt enemy pilots, and dominate the blocky skies.

## Features

- **Local network multiplayer** - Play with friends on the same WiFi/network (up to 4 players)
- **Three.js fighter jets** - Procedurally generated low-poly fighter aircraft with cockpits, missiles, and afterburners
- **Blocky voxel terrain** - Procedural terrain with landmarks for orientation
- **First-person cockpit view** - Immersive pilot perspective with HUD (health, score, throttle, team)
- **Responsive controls** - Mouse/keyboard for desktop, virtual joystick + fire button for touch devices
- **Team deathmatch** - Blue vs Red teams with respawning and scoring
- **Real-time networking** - Socket.io with 60Hz server tick rate, client-side prediction, server-authoritative hit detection

## Quick Start

### Prerequisites
- Node.js 18+

### Install & Run
```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (or `$PORT` if set).

### Play Locally
1. Start the server on one computer
2. Open `http://localhost:3000` in a browser
3. Click **START GAME** to join
4. On another device on the same network, open the LAN URL shown on the start screen (e.g., `http://192.168.1.x:3000`)

### Controls

**Desktop (Mouse + Keyboard):**
| Input | Action |
|-------|--------|
| Mouse movement | Aim / Auto-bank |
| Left click / Space | Fire |
| W / S | Throttle up / down |
| A / D | Roll left / right |
| Esc | Release mouse lock |

**Touch / Mobile:**
- Left virtual joystick: Steer (yaw + pitch + auto-roll)
- Right fire button: Hold to shoot

## Project Structure

```
skyblock-skies/
├── package.json         # Dependencies & scripts
├── server.js            # Express + Socket.io game server (60Hz tick)
├── public/
│   ├── index.html       # Game UI, HUD, menus, styling
│   └── client.js        # Three.js client: rendering, input, networking
├── .gitignore
└── README.md
```

## Architecture

**Server (`server.js`)**
- Express static file server for `public/`
- Socket.io for real-time WebSocket communication
- 60Hz authoritative game loop (physics, hit detection, respawning)
- Team assignment (auto-balance Blue/Red)
- LAN IP discovery endpoint (`/api/network-info`)

**Client (`public/client.js`)**
- Three.js scene with procedural fighter jets & voxel terrain
- Client-side prediction for responsive flight controls
- Server reconciliation via 60Hz state snapshots
- Smooth remote player interpolation (lerp/slerp)
- First-person cockpit camera with HUD
- Touch controls via nipplejs virtual joystick

**Networking**
- 60Hz server tick (16.67ms)
- Client sends state ~60Hz (throttled)
- Server broadcasts snapshots at 60Hz
- Client predicts local movement, interpolates remote players
- Server-authoritative hit detection with anti-cheat (origin validation, cooldown)

## Controls Reference

| Key / Input | Action |
|-------------|--------|
| Mouse move | Aim (yaw/pitch) + auto-bank |
| Left click / Space | Fire machine guns |
| W / S | Increase / decrease throttle |
| A / D | Manual roll |
| Esc | Release mouse lock |
| Touch joystick | Aim + steer (mobile) |
| Touch fire button | Hold to shoot (mobile) |

## Game Rules

- **Teams**: Auto-balanced Blue vs Red (max 4 players, 2 per team)
- **Health**: 100 HP, bullets deal 25 damage
- **Respawn**: 3 seconds after destruction
- **Score**: +1 per enemy destroyed
- **Flight ceiling**: Min altitude 5 units
- **World bounds**: ±900 X/Z, 4-550 Y
- **Fire rate**: 145ms cooldown (server-enforced)
- **Bullet speed**: 165 units/sec, 1.9s lifetime

## Development

```bash
# Start dev server with auto-reload (requires nodemon)
npx nodemon server.js
```

## Deployment

Works on any Node.js host (Render, Railway, Fly.io, VPS, etc.):

```bash
# Set PORT env var if required by host
PORT=3000 npm start
```

**Note**: LAN discovery only works on local networks. For internet play, deploy to a public host and share the public URL.

## Tech Stack

- **Three.js** (r161) via CDN - 3D rendering
- **Socket.io** (v4) - Real-time networking
- **Express** - Static file server
- **nipplejs** (CDN) - Virtual joystick for touch
- **Press Start 2P** (Google Fonts) - Pixel font

## License

MIT