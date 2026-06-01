// ============================================================
// Russian Voice AI Customer Support Bot
// Stack: Node.js + Express + Groq (FREE) + ElevenLabs (FREE)
// Built by SAZ Tech — saztech.online
// ============================================================

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ── ElevenLabs Russian voice ID ──
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'N2lVS1w4EtoT3dr4eOWO';

// ── In-memory user store ──
const users = new Map();

function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      name: null,
      preferences: {},
      history: [],
      createdAt: new Date().toISOString(),
      messageCount: 0,
    });
  }
  return users.get(userId);
}

function buildSystemPrompt(user) {
  const userName = user.name ? `Имя пользователя: ${user.name}.` : '';
  return `Ты — профессиональный AI-ассистент службы поддержки клиентов.
Ты всегда отвечаешь на русском языке, вежливо и профессионально.

${userName}
Количество предыдущих обращений: ${user.messageCount}

Твои задачи:
- Помогать клиентам решать их вопросы и проблемы
- Запоминать имя пользователя если он его назвал
- Давать чёткие, полезные и дружелюбные ответы
- Если не знаешь ответа — честно сказать и предложить связаться с живым специалистом

Правила:
- Всегда отвечай на русском языке
- Будь вежливым и профессиональным
- Давай короткие чёткие ответы (2-4 предложения для голосового ответа)
- Если пользователь называет своё имя — запомни и используй его
- Не придумывай информацию которой у тебя нет`;
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

// ────────────────────────────────────────────────
// ROUTE: Chat — uses Groq (FREE)
// ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: 'userId and message are required' });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set. Get free key at https://groq.com' });
  }

  try {
    const user = getUser(userId);

    // Extract name if mentioned
    const detectedName = extractName(message);
    if (detectedName) user.name = detectedName;

    // Add to history
    user.history.push({ role: 'user', content: message });
    user.messageCount++;

    // Keep last 20 messages
    const recentHistory = user.history.slice(-20);

    // ── Call Groq API (FREE — Llama 3.3 70B) ──
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: buildSystemPrompt(user) },
          ...recentHistory,
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    const groqData = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error('Groq error:', groqData);
      return res.status(500).json({ error: 'Groq API error', details: groqData });
    }

    const aiText = groqData.choices[0].message.content;

    // Add AI response to history
    user.history.push({ role: 'assistant', content: aiText });

    // ── Convert to Russian speech with ElevenLabs (FREE TIER) ──
    let audioBase64 = null;

    if (ELEVENLABS_API_KEY) {
      const elevenRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: aiText,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.3,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (elevenRes.ok) {
        const audioBuffer = await elevenRes.arrayBuffer();
        audioBase64 = Buffer.from(audioBuffer).toString('base64');
      } else {
        const err = await elevenRes.json().catch(() => ({}));
        console.error('ElevenLabs error:', err);
      }
    }

    return res.json({
      text: aiText,
      audio: audioBase64,
      user: {
        id: userId,
        name: user.name,
        messageCount: user.messageCount,
      },
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE: Speech to text — uses Groq Whisper (FREE)
// ────────────────────────────────────────────────
app.post('/api/transcribe', async (req, res) => {
  const { audioBase64 } = req.body;

  if (!audioBase64) {
    return res.status(400).json({ error: 'audioBase64 is required' });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ru');
    formData.append('response_format', 'json');

    // ── Groq Whisper (FREE) ──
    const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    const whisperData = await whisperRes.json();

    if (!whisperRes.ok) {
      return res.status(500).json({ error: 'Whisper error', details: whisperData });
    }

    return res.json({ text: whisperData.text });

  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE: Get user profile
// ────────────────────────────────────────────────
app.get('/api/user/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  res.json({
    id: user.id,
    name: user.name,
    messageCount: user.messageCount,
    createdAt: user.createdAt,
  });
});

// ────────────────────────────────────────────────
// ROUTE: Clear user history
// ────────────────────────────────────────────────
app.delete('/api/user/:userId/history', (req, res) => {
  const user = getUser(req.params.userId);
  user.history = [];
  res.json({ success: true });
});

// ────────────────────────────────────────────────
// ROUTE: Health check
// ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    users: users.size,
    groq: !!GROQ_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
    model: 'llama-3.3-70b-versatile (FREE)',
    speech: 'whisper-large-v3 via Groq (FREE)',
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Russian Voice Bot is running!', status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`\n✅ Russian Voice Bot running on port ${PORT}`);
  console.log(`   Groq AI:     ${GROQ_API_KEY ? '✅ Connected (FREE)' : '❌ Missing — get free key at groq.com'}`);
  console.log(`   ElevenLabs:  ${ELEVENLABS_API_KEY ? '✅ Connected (FREE tier)' : '❌ Missing — get free key at elevenlabs.io'}`);
  console.log(`   Health:      http://localhost:${PORT}/health\n`);
});
