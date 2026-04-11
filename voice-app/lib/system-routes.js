/**
 * System Routes
 * Provides system stats, health checks, and call recordings for Mission Control
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const recordings = require('./call-recordings');

const router = express.Router();

// Track server start time
const serverStartTime = Date.now();

/**
 * GET /api/system-stats
 * Returns CPU, memory, disk, and uptime info
 */
router.get('/system-stats', (req, res) => {
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Disk usage
    let disk = { total: 0, used: 0, percent: 0 };
    try {
        const dfOutput = execSync("df -B1 / | tail -1", { encoding: 'utf8' });
        const parts = dfOutput.trim().split(/\s+/);
        disk = {
            total: parseInt(parts[1]) || 0,
            used: parseInt(parts[2]) || 0,
            percent: parseInt(parts[4]) || 0
        };
    } catch (e) { /* ignore */ }

    res.json({
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        systemUptime: os.uptime(),
        cpu: {
            cores: os.cpus().length,
            loadAvg: loadAvg.map(l => Math.round(l * 100) / 100)
        },
        memory: {
            total: totalMem,
            used: usedMem,
            percent: Math.round((usedMem / totalMem) * 100)
        },
        disk
    });
});

/**
 * GET /api/health
 * Check connectivity to Ollama, Whisper STT, and TTS services
 */
router.get('/health', async (req, res) => {
    const checks = {};

    // Ollama
    try {
        const ollamaUrl = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';
        const r = await axios.get(`${ollamaUrl}/api/tags`, { timeout: 3000 });
        checks.ollama = { status: 'online', models: r.data.models?.length || 0 };
    } catch (e) {
        checks.ollama = { status: 'offline', error: e.message };
    }

    // Whisper STT / VibeVoice STT
    try {
        const sttUrl = process.env.LOCAL_STT_URL || 'http://127.0.0.1:8080/v1';
        try {
            const urlObj = new URL(sttUrl);
            await axios.get(`${urlObj.protocol}//${urlObj.host}/health`, { timeout: 3000 });
        } catch {
            // Fallback for legacy configs
            await axios.get(sttUrl, { timeout: 3000 });
        }
        checks.whisper = { status: 'online' };
    } catch (e) {
        checks.whisper = { status: 'offline', error: e.message };
    }

    // TTS / VibeVoice TTS
    try {
        const ttsUrl = process.env.LOCAL_TTS_URL || 'http://127.0.0.1:8880/v1/audio/speech';
        try {
            const urlObj = new URL(ttsUrl);
            await axios.get(`${urlObj.protocol}//${urlObj.host}/health`, { timeout: 3000 });
        } catch {
            // Fallback for legacy configs
            await axios.get(ttsUrl, { timeout: 3000 });
        }
        checks.tts = { status: 'online' };
    } catch (e) {
        checks.tts = { status: 'offline', error: e.message };
    }

    res.json(checks);
});

/**
 * GET /api/recordings
 * List saved call recordings (transcripts + metadata)
 */
router.get('/recordings', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ recordings: recordings.listRecordings(limit) });
});

/**
 * GET /api/recordings/:callId
 * Get a specific call recording detail
 */
router.get('/recordings/:callId', (req, res) => {
    const record = recordings.getRecording(req.params.callId);
    if (!record) {
        return res.status(404).json({ error: 'Recording not found' });
    }
    res.json(record);
});

/**
 * GET /api/recordings/audio/:filename
 * Serve recorded call audio files
 */
router.get('/recordings/audio/:filename', (req, res) => {
    const filename = path.basename(req.params.filename); // Prevent path traversal
    const audioDir = process.env.RECORDINGS_DIR
        ? path.join(process.env.RECORDINGS_DIR, 'audio')
        : '/app/recordings/audio';
    const filepath = path.join(audioDir, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Audio file not found' });
    }

    const stat = fs.statSync(filepath);
    res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filepath).pipe(res);
});

module.exports = router;
