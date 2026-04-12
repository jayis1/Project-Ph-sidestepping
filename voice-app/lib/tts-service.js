/**
 * Local TTS Service — Kokoro TTS via Kokoro-FastAPI
 * Sends text to a local Kokoro-FastAPI server running Kokoro-82M TTS.
 * OpenAI-compatible /v1/audio/speech endpoint.
 * No cloud API keys required — fully local CPU inference.
 *
 * For GPU servers with Voxtral TTS, just change LOCAL_TTS_URL to point
 * to the vLLM-Omni endpoint instead.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const { execSync } = require('child_process');

const LOCAL_TTS_URL = process.env.LOCAL_TTS_URL || 'http://127.0.0.1:8880/v1/audio/speech';


// Audio output directory
let audioDir = path.join(__dirname, '../audio-temp');

/**
 * Set the audio output directory
 * @param {string} dir
 */
function setAudioDir(dir) {
  audioDir = dir;
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

/**
 * Generate unique filename for audio file
 * @param {string} text
 * @returns {string}
 */
function generateFilename(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  return `tts-${Date.now()}-${hash}.wav`;
}

/**
 * Generate speech from text using local Voxtral TTS (vLLM-Omni)
 *
 * Supports two endpoint styles:
 *   - OpenAI-compatible (`/audio/speech`): POST JSON with {model, input, voice, response_format}
 *   - Generic (anything else): POST JSON with {text}
 *
 * @param {string} text - Text to convert to speech
 * @param {string} _voiceId - Ignored (voice configured via VOXTRAL_VOICE env var)
 * @returns {Promise<string>} HTTP URL to the saved audio file
 */
async function generateSpeech(text, _voiceId) {
  const startTime = Date.now();

  logger.info('Generating speech with VibeVoice TTS', { textLength: text.length, url: LOCAL_TTS_URL });

  let response;

  try {
    const isOpenAICompat = LOCAL_TTS_URL.includes('/audio/speech');

    if (isOpenAICompat) {
      response = await axios({
        method: 'POST',
        url: LOCAL_TTS_URL,
        headers: { 'Content-Type': 'application/json' },
        data: {
          model: 'vibevoice',
          input: text,
          voice: 'af_heart',
          response_format: 'wav'
        },
        responseType: 'arraybuffer',
        timeout: 120000
      });
    } else {
      // Generic simple TTS POST (fallback for other TTS servers)
      response = await axios({
        method: 'POST',
        url: LOCAL_TTS_URL,
        headers: { 'Content-Type': 'application/json' },
        data: { text },
        responseType: 'arraybuffer',
        timeout: 120000
      });
    }

    const filename = generateFilename(text);
    const rawPath = path.join(audioDir, 'raw_' + filename);
    const filepath = path.join(audioDir, filename);

    // Save raw TTS output (24kHz from Kokoro GPU)
    fs.writeFileSync(rawPath, response.data);

    // Resample to 8kHz/16-bit/mono for FreeSWITCH telephony
    try {
      execSync(`ffmpeg -y -i "${rawPath}" -ar 8000 -ac 1 -sample_fmt s16 "${filepath}" 2>/dev/null`);
      fs.unlinkSync(rawPath); // Clean up raw file
    } catch (e) {
      // Fallback: use raw file if ffmpeg fails
      logger.warn('ffmpeg resample failed, using raw audio', { error: e.message });
      fs.renameSync(rawPath, filepath);
    }

    const latency = Date.now() - startTime;
    const stats = fs.statSync(filepath);
    logger.info('VibeVoice TTS generation successful', { filename, fileSize: stats.size, latency });

    // Bypass HTTP and return the direct physical file path so FreeSWITCH can read it over the shared volume mount
    return filepath;

  } catch (error) {
    const latency = Date.now() - startTime;
    const errBody = error.response?.data ? error.response.data.toString() : '';
    logger.error('VibeVoice TTS generation failed', {
      error: error.message,
      detail: errBody,
      latency,
      url: LOCAL_TTS_URL,
      status: error.response?.status
    });
    throw new Error(`TTS generation failed: ${error.message} - ${errBody}`);
  }
}

/**
 * Clean up old audio files
 * @param {number} maxAgeMs - Max age in ms (default: 1 hour)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);
    let deletedCount = 0;

    files.forEach(file => {
      if (!file.startsWith('tts-') || !file.endsWith('.wav')) return;
      const stats = fs.statSync(path.join(audioDir, file));
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(path.join(audioDir, file));
        deletedCount++;
      }
    });

    if (deletedCount > 0) logger.info('Cleaned up old audio files', { deletedCount });
  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

// Initialize
setAudioDir(audioDir);

// Periodic cleanup every 30 minutes
setInterval(() => cleanupOldFiles(), 30 * 60 * 1000);

module.exports = { generateSpeech, setAudioDir, cleanupOldFiles };
