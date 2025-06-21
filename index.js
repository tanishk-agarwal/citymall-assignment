require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Mock authentication middleware
const USERS = {
  netrunnerX: { id: 'netrunnerX', role: 'admin' },
  reliefAdmin: { id: 'reliefAdmin', role: 'admin' },
  citizen1: { id: 'citizen1', role: 'contributor' },
  citizen2: { id: 'citizen2', role: 'contributor' },
};

app.use((req, res, next) => {
  const userId = req.header('x-user-id');
  if (userId && USERS[userId]) {
    req.user = USERS[userId];
  } else {
    req.user = USERS['citizen1']; // default user
  }
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Disaster Response API running' });
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Utility: log actions
function logAction(action, details) {
  console.log(JSON.stringify({ action, ...details, timestamp: new Date().toISOString() }));
}

// Utility: Supabase cache get/set
async function getCache(key) {
  const { data, error } = await supabase.from('cache').select('value,expires_at').eq('key', key).single();
  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data.value;
}
async function setCache(key, value, ttlSeconds = 3600) {
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await supabase.from('cache').upsert({ key, value, expires_at });
}

// Create disaster
app.post('/disasters', async (req, res) => {
  const { title, location_name, location, description, tags } = req.body;
  const owner_id = req.user.id;
  const audit_trail = [{ action: 'create', user_id: owner_id, timestamp: new Date().toISOString() }];
  let geoPoint = null;
  if (location && location.lat && location.lng) {
    geoPoint = `SRID=4326;POINT(${location.lng} ${location.lat})`;
  }
  const { data, error } = await supabase.from('disasters').insert([
    { title, location_name, location: geoPoint, description, tags, owner_id, audit_trail }
  ]).select();
  if (error) return res.status(400).json({ error: error.message });
  logAction('Disaster created', { title, owner_id });
  io.emit('disaster_updated', { type: 'create', disaster: data[0] });
  res.json(data[0]);
});

// Get disasters (with optional tag filter)
app.get('/disasters', async (req, res) => {
  const { tag } = req.query;
  let query = supabase.from('disasters').select('*');
  if (tag) {
    query = query.contains('tags', [tag]);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Update disaster
app.put('/disasters/:id', async (req, res) => {
  const { id } = req.params;
  const { title, location_name, location, description, tags } = req.body;
  const user_id = req.user.id;
  // Fetch current audit trail
  const { data: current, error: fetchErr } = await supabase.from('disasters').select('audit_trail').eq('id', id).single();
  if (fetchErr) return res.status(404).json({ error: 'Disaster not found' });
  const audit_trail = current.audit_trail || [];
  audit_trail.push({ action: 'update', user_id, timestamp: new Date().toISOString() });
  let geoPoint = null;
  if (location && location.lat && location.lng) {
    geoPoint = `SRID=4326;POINT(${location.lng} ${location.lat})`;
  }
  const updateFields = { title, location_name, description, tags, audit_trail };
  if (geoPoint) updateFields.location = geoPoint;
  const { data, error } = await supabase.from('disasters').update(updateFields).eq('id', id).select();
  if (error) return res.status(400).json({ error: error.message });
  logAction('Disaster updated', { id, user_id });
  io.emit('disaster_updated', { type: 'update', disaster: data[0] });
  res.json(data[0]);
});

// Delete disaster
app.delete('/disasters/:id', async (req, res) => {
  const { id } = req.params;
  const user_id = req.user.id;
  // Fetch current audit trail
  const { data: current, error: fetchErr } = await supabase.from('disasters').select('audit_trail').eq('id', id).single();
  if (fetchErr) return res.status(404).json({ error: 'Disaster not found' });
  const audit_trail = current.audit_trail || [];
  audit_trail.push({ action: 'delete', user_id, timestamp: new Date().toISOString() });
  // Update audit trail before delete
  await supabase.from('disasters').update({ audit_trail }).eq('id', id);
  const { error } = await supabase.from('disasters').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  logAction('Disaster deleted', { id, user_id });
  io.emit('disaster_updated', { type: 'delete', id });
  res.json({ success: true });
});

// Create report
app.post('/reports', async (req, res) => {
  const { disaster_id, content, image_url } = req.body;
  const user_id = req.user.id;
  const verification_status = 'pending';
  const { data, error } = await supabase.from('reports').insert([
    { disaster_id, user_id, content, image_url, verification_status }
  ]).select();
  if (error) return res.status(400).json({ error: error.message });
  logAction('Report created', { disaster_id, user_id });
  io.emit('report_updated', { type: 'create', report: data[0] });
  res.json(data[0]);
});

// Get reports (by disaster_id, optional verification_status)
app.get('/reports', async (req, res) => {
  const { disaster_id, verification_status } = req.query;
  let query = supabase.from('reports').select('*');
  if (disaster_id) query = query.eq('disaster_id', disaster_id);
  if (verification_status) query = query.eq('verification_status', verification_status);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Create resource
app.post('/resources', async (req, res) => {
  const { disaster_id, name, location_name, location, type } = req.body;
  let geoPoint = null;
  if (location && location.lat && location.lng) {
    geoPoint = `SRID=4326;POINT(${location.lng} ${location.lat})`;
  }
  const { data, error } = await supabase.from('resources').insert([
    { disaster_id, name, location_name, location: geoPoint, type }
  ]).select();
  if (error) return res.status(400).json({ error: error.message });
  logAction('Resource created', { disaster_id, name });
  io.emit('resources_updated', { type: 'create', resource: data[0] });
  res.json(data[0]);
});

// Get resources (by disaster_id)
app.get('/resources', async (req, res) => {
  const { disaster_id } = req.query;
  let query = supabase.from('resources').select('*');
  if (disaster_id) query = query.eq('disaster_id', disaster_id);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Geospatial resource lookup: GET /disasters/:id/resources?lat=...&lon=...
app.get('/disasters/:id/resources', async (req, res) => {
  const { id } = req.params;
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  // 10km radius
  const radius = 10000;
  const { data, error } = await supabase.rpc('nearby_resources', {
    disaster_id_param: id,
    lat_param: parseFloat(lat),
    lon_param: parseFloat(lon),
    radius_param: radius
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEMINI_API_KEY });

// POST /geocode: extract location with Gemini, geocode with OpenStreetMap Nominatim
app.post('/geocode', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const cacheKey = `geocode:${Buffer.from(text).toString('base64')}`;
  // Check cache
  const cached = await getCache(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  // 1. Gemini API: extract location name
  let location_name;
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { text: `Extract the location name from: ${text}` }
      ]
    });
    location_name = result.candidates[0].content.parts[0].text.trim();
    if (!location_name) throw new Error('No location found');
  } catch (e) {
    return res.status(500).json({ error: 'Gemini API failed', details: e.message });
  }
  // 2. OpenStreetMap Nominatim Geocoding API
  let lat, lng;
  try {
    const geoResp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: location_name,
        format: 'json',
        limit: 1
      },
      headers: {
        'User-Agent': 'DisasterResponseApp/1.0 (dogomer959@nab4.com)'
      }
    });
    const result = geoResp.data[0];
    if (!result) throw new Error('No geocode result');
    lat = parseFloat(result.lat);
    lng = parseFloat(result.lon);
  } catch (e) {
    return res.status(500).json({ error: 'Geocoding failed', details: e.message });
  }
  const response = { location_name, lat, lng };
  await setCache(cacheKey, response);
  logAction('Geocode', { text, location_name, lat, lng });
  res.json(response);
});

// GET /mock-social-media: returns sample social media posts
app.get('/mock-social-media', async (req, res) => {
  const cacheKey = 'mock-social-media';
  const cached = await getCache(cacheKey);
  if (cached) return res.json({ posts: cached, cached: true });
  const posts = [
    { post: '#floodrelief Need food in NYC', user: 'citizen1' },
    { post: 'Power outage in Lower East Side', user: 'citizen2' },
    { post: 'Red Cross shelter open in Brooklyn', user: 'reliefAdmin' },
    { post: 'Urgent: SOS in Queens', user: 'citizen1' }
  ];
  await setCache(cacheKey, posts);
  logAction('Mock social media fetched', { count: posts.length });
  res.json({ posts });
});

// GET /disasters/:id/official-updates: scrape FEMA and Red Cross
app.get('/disasters/:id/official-updates', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `official-updates:${id}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json({ updates: cached, cached: true });
  // Example: scrape FEMA and Red Cross homepages (demo only)
  try {
    const [femaResp, redCrossResp] = await Promise.all([
      axios.get('https://www.fema.gov'),
      axios.get('https://www.redcross.org')
    ]);
    const $fema = cheerio.load(femaResp.data);
    const $rc = cheerio.load(redCrossResp.data);
    const femaUpdate = $fema('title').text();
    const rcUpdate = $rc('title').text();
    const updates = [
      { source: 'FEMA', headline: femaUpdate },
      { source: 'Red Cross', headline: rcUpdate }
    ];
    await setCache(cacheKey, updates);
    logAction('Official updates fetched', { id, sources: ['FEMA', 'Red Cross'] });
    res.json({ updates });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch official updates', details: e.message });
  }
});

// POST /disasters/:id/verify-image: verify image with Gemini (if available)
app.post('/disasters/:id/verify-image', async (req, res) => {
  const { id } = req.params;
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url required' });
  const cacheKey = `verify-image:${id}:${Buffer.from(image_url).toString('base64')}`;
  const cached = await getCache(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    // Download image and convert to base64
    const response = await fetch(image_url);
    const arrayBuffer = await response.arrayBuffer();
    const base64ImageData = Buffer.from(arrayBuffer).toString('base64');
    // Gemini Vision API call
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64ImageData,
          },
        },
        { text: 'Analyze this image for signs of manipulation or disaster context.' }
      ],
    });
    const analysis = result.candidates[0].content.parts[0].text;
    if (!analysis) throw new Error('No analysis result');
    const out = { image_url, analysis };
    await setCache(cacheKey, out);
    logAction('Image verified', { id, image_url });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'Gemini image verification failed', details: e.message });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 