const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;

// Load config
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { models: [], systemPrompt: 'You are a helpful, fun AI assistant called FreeClaw. Be concise, have personality, and be genuinely useful.' }; }
}

// Conversation memory (in-file persistence)
const MEM_PATH = path.join(__dirname, '..', 'conversations.json');
function loadConversations() {
  try { return JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConversations(convos) {
  fs.writeFileSync(MEM_PATH, JSON.stringify(convos, null, 2));
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load secrets
function getVultrKey() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'secrets', 'vultr.json'), 'utf8'));
    return s.key1;
  } catch { return null; }
}

// Chat with LLM
async function chat(messages, model, systemPrompt) {
  const config = loadConfig();
  const apiKey = getVultrKey() || config.apiKey;
  const baseUrl = config.baseUrl || 'https://api.vultrinference.com/v1';
  const modelId = model || config.defaultModel || 'zai-org/GLM-5.1-FP8';

  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt || config.systemPrompt },
      ...messages
    ],
    max_tokens: 4096,
    stream: true
  };

  return { baseUrl, apiKey, payload, modelId };
}

// REST endpoint for chat (non-streaming fallback)
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model, conversationId, systemPrompt } = req.body;
    const { baseUrl, apiKey, payload, modelId } = await chat(messages, model, systemPrompt);
    payload.stream = false;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err });
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || 'No response';

    // Save to conversation
    if (conversationId) {
      const convos = loadConversations();
      if (!convos[conversationId]) convos[conversationId] = { id: conversationId, messages: [], created: Date.now() };
      convos[conversationId].messages.push(...messages, { role: 'assistant', content: reply });
      convos[conversationId].updated = Date.now();
      saveConversations(convos);
    }

    res.json({ reply, model: modelId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List conversations
app.get('/api/conversations', (req, res) => {
  const convos = loadConversations();
  const list = Object.values(convos).map(c => ({
    id: c.id,
    title: c.messages?.[0]?.content?.slice(0, 60) || 'New chat',
    updated: c.updated || c.created,
    count: c.messages?.length || 0
  })).sort((a, b) => b.updated - a.updated);
  res.json(list);
});

// Get conversation
app.get('/api/conversations/:id', (req, res) => {
  const convos = loadConversations();
  res.json(convos[req.params.id] || { messages: [] });
});

// Delete conversation
app.delete('/api/conversations/:id', (req, res) => {
  const convos = loadConversations();
  delete convos[req.params.id];
  saveConversations(convos);
  res.json({ ok: true });
});

// Get available models
app.get('/api/models', (req, res) => {
  const config = loadConfig();
  res.json(config.models || []);
});

// WebSocket for streaming
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const { messages, model, conversationId, systemPrompt, type } = JSON.parse(data);

      if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

      const { baseUrl, apiKey, payload, modelId } = await chat(messages, model, systemPrompt);

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        ws.send(JSON.stringify({ type: 'error', error: await resp.text() }));
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullReply = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content || '';
            if (token) {
              fullReply += token;
              ws.send(JSON.stringify({ type: 'token', token, model: modelId }));
            }
          } catch {}
        }
      }

      ws.send(JSON.stringify({ type: 'done', fullReply, model: modelId }));

      // Save
      if (conversationId) {
        const convos = loadConversations();
        if (!convos[conversationId]) convos[conversationId] = { id: conversationId, messages: [], created: Date.now() };
        convos[conversationId].messages.push(...messages, { role: 'assistant', content: fullReply });
        convos[conversationId].updated = Date.now();
        saveConversations(convos);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FreeClaw running on http://0.0.0.0:${PORT}`);
});
