const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
console.log('Starting on port:', process.env.PORT);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'N2lVS1w4EtoT3dr4eOWO';

const users = new Map();

function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      name: null,
      history: [],
      messageCount: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return users.get(userId);
}

function buildSystemPrompt(user) {
  const userName = user.name ? `Имя пользователя: ${user.name}.` : '';
  return `Ты профессиональный AI-ассистент службы поддержки клиентов.
Всегда отвечай на русском языке, вежливо и профессионально.
${userName}
- Помогай клиентам решать вопросы
- Запоминай имя если пользователь его назвал
- Давай короткие чёткие ответы 2-4 предложения
- Никогда не придумывай информацию`;
}

function extractName(message) {
  const patterns = [
    /меня зовут\s+([А-ЯЁа-яёA-Za-z]+)/i,
    /моё имя\s+([А-ЯЁа-яёA-Za-z]+)/i,
    /my name is\s+([A-Za-z]+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, data: {} });
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsPostBinary(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200, buffer: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    return res.status(400).json({ error: 'userId and message required' });
  }
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  }

  try {
    const user = getUser(userId);
    const name = extractName(message);
    if (name) user.name = name;

    user.history.push({ role: 'user', content: message });
    user.messageCount++;

    const messages = [
      { role: 'system', content: buildSystemPrompt(user) },
      ...user.history.slice(-20),
    ];

    const groqRes = await httpsPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      { model: 'llama-3.3-70b-versatile', messages, max_tokens: 300, temperature: 0.7 }
    );

    if (!groqRes.ok || !groqRes.data.choices) {
      return res.status(500).json({ error: 'Groq error', details: groqRes.data });
    }

    const aiText = groqRes.data.choices[0].message.content;
    user.history.push({ role: 'assistant', content: aiText });

    let audioBase64 = null;
    if (ELEVENLABS_API_KEY) {
      try {
        const audioRes = await httpsPostBinary(
          'api.elevenlabs.io',
          `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          Buffer.from(JSON.stringify({
            text: aiText,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }))
        );
        if (audioRes.ok) {
          audioBase64 = audioRes.buffer.toString('base64');
        }
      } catch (e) {
        console.error('ElevenLabs error:', e.message);
      }
    }

    return res.json({
      text: aiText,
      audio: audioBase64,
      user: { id: userId, name: user.name, messageCount: user.messageCount },
    });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  const { audioBase64 } = req.body;
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const boundary = 'FormBoundary' + Math.random().toString(36).substr(2);

    const formData = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nru\r\n--${boundary}--\r\n`),
    ]);

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length,
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.write(formData);
      req.end();
    });

    return res.json({ text: result.text || '' });

  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  res.json({ id: user.id, name: user.name, messageCount: user.messageCount });
});

app.delete('/api/user/:userId/history', (req, res) => {
  const user = getUser(req.params.userId);
  user.history = [];
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    groq: !!GROQ_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
    model: 'llama-3.3-70b-versatile FREE',
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Russian Voice Bot is running!', status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Groq: ${GROQ_API_KEY ? 'Connected FREE' : 'Missing key'}`);
  console.log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'Connected FREE' : 'Missing key'}`);
});
