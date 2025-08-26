// Backend/server.js
require('dotenv').config(); // so FREE_BOT_LIMIT works from .env
// --- Free plan limit (defaults to 3 if .env not set)
const FREE_BOT_LIMIT = parseInt(process.env.FREE_BOT_LIMIT || '3', 10);

const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// NEW security deps
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: '*'}));
app.use(
  helmet({
    // Allow our CDNs + (for now) inline <script>/<style> so index.html works.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com"
        ],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com"
        ],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"], // your fetch() calls to same origin
        "frame-ancestors": ["'self'"]
      }
    }
  })
);

app.use(rateLimit({ windowMs: 60_000, max: 100 }));

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

// Collections
let usersCollection;
let botsCollection;
let commandsCollection;
let errorsCollection;
let propertiesCollection; // For storing properties

async function connectToMongo() {
  try {
    await client.connect();
    db = client.db("RunMyBotDB");
    console.log("✅ Connected to MongoDB!");

    // Initialize collections
    usersCollection = db.collection("users");
    botsCollection = db.collection("bots");
    commandsCollection = db.collection("commands");
    errorsCollection = db.collection("errors");
    propertiesCollection = db.collection("properties");

    // Indexes
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await botsCollection.createIndex({ botId: 1 }, { unique: true });
    await botsCollection.createIndex({ ownerId: 1 });
    await commandsCollection.createIndex({ botId: 1 });
    await errorsCollection.createIndex({ botId: 1 });
    await propertiesCollection.createIndex({ botId: 1 });

    // Seed admin
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPass) {
      const existing = await usersCollection.findOne({ email: adminEmail });
      if (!existing) {
        const hash = await bcrypt.hash(adminPass, 10);
        await usersCollection.insertOne({
          name: 'Admin',
          email: adminEmail,
          passwordHash: hash,
          role: 'admin',
          plan: 'premium',
          createdAt: new Date(),
        });
        console.log("✅ Admin user seeded:", adminEmail);
      }
    }

    // Start the server
    startServer();
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

/* =========================
   Auth helpers & middleware
   ========================= */
function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role || 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function getUserFromReq(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await usersCollection.findOne({ _id: new ObjectId(payload.id) });
    return user || null;
  } catch (_) {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const user = await getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });
  next();
}

async function ensureOwnerOrAdmin(req, res, next) {
  const botId = (req.body && req.body.botId) ? req.body.botId : req.query.botId;
  if (!botId) return res.status(400).json({ ok: false, error: 'botId is required' });

  const bot = await botsCollection.findOne({ botId });
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' });

  if (req.user.role !== 'admin' && bot.ownerId !== req.user._id.toString()) {
    return res.status(403).json({ ok: false, error: 'Forbidden: not your bot' });
  }
  req._bot = bot; // stash for handlers
  next();
}

/* =========================
   Bot lifecycle
   ========================= */
async function launchBot(botId) {
  const botCfg = await botsCollection.findOne({ botId });
  if (!botCfg) return false;

  // Stop any existing instance
  if (activeBots[botId]) {
    try { await activeBots[botId].stop('SIGTERM'); } catch (_) {}
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
    try { await activeBots[botId].stop('SIGTERM'); } catch (_) {}
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
          // NOTE: still using dynamic code; will sandbox in a later step
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

/* =========================
   Auth routes
   ========================= */
// Register
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, error: 'name, email, password required' });
    }
    const existing = await usersCollection.findOne({ email });
    if (existing) return res.status(409).json({ ok: false, error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      name, email, passwordHash,
      role: 'user',
      plan: 'free', // default free plan: 3 bots limit
      createdAt: new Date()
    };
    const { insertedId } = await usersCollection.insertOne(user);
    const token = signToken({ _id: insertedId, role: user.role });
    return res.json({
      ok: true,
      token,
      user: { id: insertedId, name, email, role: user.role, plan: user.plan }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({
      ok: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, plan: user.plan }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Current user
app.get('/auth/me', requireAuth, (req, res) => {
  const { _id, name, email, role, plan } = req.user;
  res.json({ ok: true, user: { id: _id, name, email, role, plan } });
});


/* =========================
   Admin routes (Admin only)
   ========================= */

// List users with bot counts
app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { name: 1, email: 1, role: 1, plan: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .toArray();

    const withCounts = await Promise.all(users.map(async (u) => {
      const botCount = await botsCollection.countDocuments({ ownerId: u._id.toString() });
      return { id: u._id, name: u.name, email: u.email, role: u.role, plan: u.plan, createdAt: u.createdAt, botCount };
    }));
    res.json({ ok: true, users: withCounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get bots for a specific user
app.get('/admin/user/:id/bots', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const bots = await botsCollection
      .find({ ownerId: userId })
      .project({ token: 0 })           // ⬅️ hide token
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ ok: true, bots });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Get errors for a specific user's bots (optionally single bot)
app.get('/admin/user/:id/errors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const botId = req.query.botId;

    if (botId) {
      const bot = await botsCollection.findOne({ botId });
      if (!bot || bot.ownerId !== userId) return res.status(404).json({ ok: false, error: 'Bot not found for this user' });
      const errs = await errorsCollection.find({ botId }).sort({ timestamp: -1 }).toArray();
      return res.json({ ok: true, errors: errs });
    }

    const userBots = await botsCollection.find({ ownerId: userId }).project({ botId: 1, name: 1 }).toArray();
    const ids = userBots.map(b => b.botId);
    if (ids.length === 0) return res.json({ ok: true, errors: [] });

    const errs = await errorsCollection.find({ botId: { $in: ids } }).sort({ timestamp: -1 }).toArray();
    res.json({ ok: true, errors: errs, bots: userBots });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get commands for a specific bot of this user
app.get('/admin/user/:id/commands', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const botId = req.query.botId;
    if (!botId) return res.status(400).json({ ok: false, error: 'botId required' });

    const bot = await botsCollection.findOne({ botId });
    if (!bot || bot.ownerId !== userId) return res.status(404).json({ ok: false, error: 'Bot not found for this user' });

    const cmds = await commandsCollection.findOne({ botId });
    res.json({ ok: true, commands: cmds?.commands || {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update user plan (free|premium)
app.post('/admin/user/:id/plan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { plan } = req.body || {};
    if (!['free', 'premium'].includes(plan)) return res.status(400).json({ ok: false, error: 'Invalid plan' });

    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update user role (user|admin)
app.post('/admin/user/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { role } = req.body || {};
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ ok: false, error: 'Invalid role' });

    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { role } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* =========================
   Bot endpoints (ownership & limits)
   ========================= */

// Create bot (explicit token + name)
app.post('/createBot', requireAuth, async (req, res) => {
  const { token, name } = req.body || {};
  if (!token || !name) {
    return res.status(400).json({ ok: false, error: "Token and name are required." });
  }
  try {
    // Enforce free plan limit
if (req.user.plan !== 'premium') {
  const count = await botsCollection.countDocuments({ ownerId: req.user._id.toString() });
  if (count >= FREE_BOT_LIMIT) {
    return res.status(403).json({
      ok: false,
      error: `Free plan limit reached (${FREE_BOT_LIMIT} bots). Upgrade to add more.`
    });
  }
}


    const id = Math.random().toString(36).substring(2, 15);
    await botsCollection.insertOne({
      botId: id,
      token,
      name,
      status: 'STOP',
      ownerId: req.user._id.toString(),
      createdAt: new Date()
    });
    await commandsCollection.insertOne({ botId: id, commands: {} });
    res.json({ ok: true, botId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/deleteBot', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const { botId } = req.body || {};
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

app.post('/startBot', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const { botId } = req.body || {};
  try {
    const success = await launchBot(botId);
    res.json({ ok: success });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/stopBot', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const { botId } = req.body || {};
  try {
    const success = await stopBot(botId);
    res.json({ ok: success });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get bots: user sees own; admin sees all
app.get('/getBots', requireAuth, async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { ownerId: req.user._id.toString() };
    const list = await botsCollection
      .find(query)
      .project({ token: 0 })           // ⬅️ hide token
      .toArray();
    res.json(list);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/getCommands', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const botId = req.query.botId;
  try {
    const botCommands = await commandsCollection.findOne({ botId });
    res.json(botCommands?.commands || {});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/getErrors', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const botId = req.query.botId;
  try {
    const errs = await errorsCollection.find({ botId }).toArray();
    res.json(errs);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/addCommand', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const { botId, name, code } = req.body || {};
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

app.post('/delCommand', requireAuth, ensureOwnerOrAdmin, async (req, res) => {
  const { botId, name } = req.body || {};
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

// Validate token & create "Unnamed" bot (same as create but with validation)
app.post('/setToken', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ ok: false, error: "Token is required." });
  }
  try {
    // Enforce free plan limit (3)
    if (req.user.plan !== 'premium') {
      const count = await botsCollection.countDocuments({ ownerId: req.user._id.toString() });
      if (count >= 3) return res.status(403).json({ ok: false, error: 'Free plan limit reached (3 bots). Upgrade to add more.' });
    }

    const tmp = new Telegraf(token);
    await tmp.telegram.getMe(); // validate token
    const id = Math.random().toString(36).substring(2, 15);
    await botsCollection.insertOne({
      botId: id,
      token,
      name: 'Unnamed',
      status: 'STOP',
      ownerId: req.user._id.toString(),
      createdAt: new Date()
    });
    await commandsCollection.insertOne({ botId: id, commands: {} });
    res.json({ ok: true, botId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/test', (_req, res) => res.send('Test OK'));

app.use(express.static(path.join(__dirname, '..', 'Frontend')));



// Start the server
function startServer() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`⚡ RunMyBot server on :${PORT}`));
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const botId in activeBots) {
    try { await activeBots[botId].stop('SIGTERM'); } catch (_) {}
  }
  process.exit(0);
});

// Connect to MongoDB and start the server
connectToMongo();
