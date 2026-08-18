require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  PORT = 3000,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Faltando LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET no .env');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.send('tela token server ok'));

app.post('/token', async (req, res) => {
  const { room, name } = req.body || {};
  if (!room || !name) {
    return res.status(400).json({ error: 'campos "room" e "name" obrigatorios' });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: name,
    ttl: 60 * 60 * 6,
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  });

  res.json({ token: await at.toJwt(), url: LIVEKIT_URL });
});

app.listen(PORT, () => {
  console.log(`token server rodando em http://localhost:${PORT}`);
});
