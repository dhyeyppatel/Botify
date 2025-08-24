require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, '..', 'Frontend')));

// MongoDB connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;
let activeBots = {}; // Track active bot instances
let propertiesCollection; // For storing properties

async function connectToMongo() {
  try {
    await client.connect();
    db = client.db("RunMyBotDB");
    console.log("✅ Connected to MongoDB!");

    // Initialize collections
    botsCollection = db.collection("bots");
    commandsCollection = db.collection("commands");
    errorsCollection = db.collection("errors");
    propertiesCollection = db.collection("properties"); // New collection for properties

    // Start the server
    startServer();
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

async function launchBot(botId) {
  const botCfg = await botsCollection.findOne({ botId });
  if (!botCfg) return false;

  // Stop any existing instance
  if (activeBots[botId]) {
    try {
      await activeBots[botId].stop('SIGTERM');
    } catch (_) {}
    delete activeBots[botId];
  }

  const instance = new Telegraf(botCfg.token, {
    telegram: { timeout: 3000 },
    handlerTimeout: 9000
  });

  await registerHandlers(instance, botId);
  instance.launch({ polling: { timeout: 3 } });
  activeBots[botId] = instance;
  await botsCollection.updateOne({ botId }, { $set: { status: 'RUN' } });
  return true;
}

async function stopBot(botId) {
  if (activeBots[botId]) {
    try {
      await activeBots[botId].stop('SIGTERM');
    } catch (_) {}
    delete activeBots[botId];
  }
  await botsCollection.updateOne({ botId }, { $set: { status: 'STOP' } });
  return true;
}

async function registerHandlers(instance, botId) {
  instance.context.updateTypes = [];

  // Load ONLY user-added commands from MongoDB
  const botCommands = await commandsCollection.findOne({ botId });
  if (botCommands && botCommands.commands) {
    for (const cmd in botCommands.commands) {
      const raw = cmd.replace('/', '');
      instance.command(raw, async (ctx) => {
        try {
          new Function('ctx', botCommands.commands[cmd])(ctx);
        } catch (e) {
          ctx.reply(`⚠️ Error in command ${cmd}: ${e.message}`);
          await storeError(botId, e.message, cmd);
        }
      });
    }
  }
}

async function storeError(botId, errorMessage, command) {
  await errorsCollection.insertOne({
    botId,
    timestamp: new Date(),
    message: errorMessage,
    command: command
  });
}

// Endpoints
app.post('/createBot', async (req, res) => {
  const { token, name } = req.body;
  if (!token || !name) {
    return res.status(400).json({ ok: false, error: "Token and name are required." });
  }
  try {
    const id = Math.random().toString(36).substring(2, 15);
    await botsCollection.insertOne({
      botId: id,
      token,
      name,
      status: 'STOP',
      createdAt: new Date()
    });
    await commandsCollection.insertOne({ botId: id, commands: {} });
    res.json({ ok: true, botId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/deleteBot', async (req, res) => {
  const { botId } = req.body;
  if (!botId) {
    return res.status(400).json({ ok: false, error: "botId is required." });
  }
  try {
    await stopBot(botId);
    await botsCollection.deleteOne({ botId });
    await commandsCollection.deleteOne({ botId });
    await errorsCollection.deleteMany({ botId });
    await propertiesCollection.deleteMany({ botId }); // Also delete properties
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/startBot', async (req, res) => {
  const { botId } = req.body;
  if (!botId) {
    return res.status(400).json({ ok: false, error: "botId is required." });
  }
  try {
    const success = await launchBot(botId);
    res.json({ ok: success });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/stopBot', async (req, res) => {
  const { botId } = req.body;
  if (!botId) {
    return res.status(400).json({ ok: false, error: "botId is required." });
  }
  try {
    const success = await stopBot(botId);
    res.json({ ok: success });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/getBots', async (_, res) => {
  try {
    const list = await botsCollection.find({}).toArray();
    res.json(list);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/getCommands', async (req, res) => {
  const botId = req.query.botId;
  if (!botId) {
    return res.status(400).json({ ok: false, error: "botId is required." });
  }
  try {
    const botCommands = await commandsCollection.findOne({ botId });
    res.json(botCommands?.commands || {});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/getErrors', async (req, res) => {
  const botId = req.query.botId;
  if (!botId) {
    return res.status(400).json({ ok: false, error: "botId is required." });
  }
  try {
    const errs = await errorsCollection.find({ botId }).toArray();
    res.json(errs);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/addCommand', async (req, res) => {
  const { botId, name, code } = req.body;
  if (!botId || !name || !code) {
    return res.status(400).json({ ok: false, error: "botId, name, and code are required." });
  }
  try {
    await commandsCollection.updateOne(
      { botId },
      { $set: { [`commands.${name}`]: code } },
      { upsert: true }
    );

    // Restart the bot to apply new commands
    if (activeBots[botId]) {
      await stopBot(botId);
      await launchBot(botId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/delCommand', async (req, res) => {
  const { botId, name } = req.body;
  if (!botId || !name) {
    return res.status(400).json({ ok: false, error: "botId and name are required." });
  }
  try {
    await commandsCollection.updateOne(
      { botId },
      { $unset: { [`commands.${name}`]: "" } }
    );

    // Restart the bot to remove the command
    if (activeBots[botId]) {
      await stopBot(botId);
      await launchBot(botId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/setToken', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ ok: false, error: "Token is required." });
  }
  try {
    const tmp = new Telegraf(token);
    await tmp.telegram.getMe();
    const id = Math.random().toString(36).substring(2, 15);
    await botsCollection.insertOne({
      botId: id,
      token,
      name: 'Unnamed',
      status: 'STOP',
      createdAt: new Date()
    });
    await commandsCollection.insertOne({ botId: id, commands: {} });
    res.json({ ok: true, botId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/test', (req, res) => res.send('Test OK'));

// Start the server
function startServer() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`⚡ RunMyBot server on :${PORT}`));
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const botId in activeBots) {
    try {
      await activeBots[botId].stop('SIGTERM');
    } catch (_) {}
  }
  process.exit(0);
});

// Connect to MongoDB and start the server
connectToMongo();

