'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const FormData = require('form-data');
const { randomUUID } = require('crypto');
const {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand
} = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    },
    maxAttempts: 3
});

const TEMP_DIR = path.join(__dirname, 'temp');
const AI_SCRIPT = path.join(__dirname, 'subtitle_ai.py');
const AI_ENABLED = String(process.env.AI_SUBTITLES_ENABLED ?? 'true').toLowerCase() !== 'false';

fs.mkdirSync(TEMP_DIR, { recursive: true });

function isAborted(signal) {
    return Boolean(signal && signal.aborted);
}

function throwIfAborted(signal) {
    if (isAborted(signal)) {
        const error = new Error('Job was cancelled.');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        throw error;
    }
}

function isAbortError(error, signal) {
    return Boolean(
        isAborted(signal) ||
        error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR' ||
        error?.code === 'ERR_CANCELED'
    );
}

function pythonExecutable() {
    const venvPython = path.join(__dirname, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) return venvPython;
    return process.env.PYTHON_BIN || 'python3';
}

function updateProgressSafely(callback, ...args) {
    try {
        if (typeof callback === 'function') callback(...args);
    } catch (error) {
        console.warn('Progress update failed:', error.message);
    }
}

function runProcess(command, args, options = {}) {
    const {
        signal,
        onStdoutLine,
        label = command,
        env = process.env
    } = options;

    return new Promise((resolve, reject) => {
        throwIfAborted(signal);

        const child = spawn(command, args, {
            cwd: __dirname,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let settled = false;
        let killTimer = null;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(result);
        };

        const onAbort = () => {
            try { child.kill('SIGTERM'); } catch (_) {}
            killTimer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (_) {}
            }, 7000);
            killTimer.unref?.();
        };

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }

        child.stdout.on('data', chunk => {
            stdoutBuffer += chunk.toString('utf8');
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                if (typeof onStdoutLine === 'function') {
                    try { onStdoutLine(line); } catch (_) {}
                } else {
                    console.log(`[${label}] ${line}`);
                }
            }
        });

        child.stderr.on('data', chunk => {
            stderrBuffer += chunk.toString('utf8');
            if (stderrBuffer.length > 16000) {
                stderrBuffer = stderrBuffer.slice(-16000);
            }
        });

        child.on('error', error => {
            if (isAbortError(error, signal)) {
                const cancelled = new Error('Job was cancelled.');
                cancelled.name = 'AbortError';
                cancelled.code = 'ABORT_ERR';
                finish(cancelled);
            } else {
                finish(error);
            }
        });

        child.on('close', code => {
            if (isAborted(signal)) {
                const cancelled = new Error('Job was cancelled.');
                cancelled.name = 'AbortError';
                cancelled.code = 'ABORT_ERR';
                return finish(cancelled);
            }

            if (code === 0) {
                if (stdoutBuffer.trim() && typeof onStdoutLine === 'function') {
                    try { onStdoutLine(stdoutBuffer.trim()); } catch (_) {}
                }
                return finish(null, { code: 0, stderr: stderrBuffer });
            }

            finish(new Error(
                `${label} exited with code ${code}: ${stderrBuffer.slice(-3000) || 'No error output.'}`
            ));
        });
    });
}

function runFFmpeg(args, duration, updateStatus, label, options = {}) {
    const { signal, progressStart = 30, progressRange = 35 } = options;

    return new Promise((resolve, reject) => {
        throwIfAborted(signal);

        const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let progressBuffer = '';
        let errorBuffer = '';
        let settled = false;
        let killTimer = null;

        const finish = error => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
        };

        const onAbort = () => {
            try { ffmpeg.kill('SIGTERM'); } catch (_) {}
            killTimer = setTimeout(() => {
                try { ffmpeg.kill('SIGKILL'); } catch (_) {}
            }, 7000);
            killTimer.unref?.();
        };

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }

        ffmpeg.stdout.on('data', chunk => {
            progressBuffer += chunk.toString('utf8');
            const lines = progressBuffer.split('\n');
            progressBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('out_time_ms=')) continue;
                const value = Number(line.slice('out_time_ms='.length));
                if (duration > 0 && Number.isFinite(value)) {
                    const fraction = Math.max(0, Math.min(1, value / 1000000 / duration));
                    updateProgressSafely(updateStatus, label, progressStart + fraction * progressRange, {
                        detail: `${Math.round(fraction * 100)}% of video timeline`
                    });
                }
            }
        });

        ffmpeg.stderr.on('data', chunk => {
            errorBuffer += chunk.toString('utf8');
            if (errorBuffer.length > 16000) errorBuffer = errorBuffer.slice(-16000);
        });

        ffmpeg.on('error', error => {
            if (isAbortError(error, signal)) {
                const cancelled = new Error('Job was cancelled.');
                cancelled.name = 'AbortError';
                cancelled.code = 'ABORT_ERR';
                finish(cancelled);
            } else {
                finish(error);
            }
        });

        ffmpeg.on('close', code => {
            if (isAborted(signal)) {
                const cancelled = new Error('Job was cancelled.');
                cancelled.name = 'AbortError';
                cancelled.code = 'ABORT_ERR';
                return finish(cancelled);
            }
            if (code === 0) return finish();
            finish(new Error(
                `FFmpeg exited with code ${code}: ${errorBuffer.slice(-3000) || 'No error output.'}`
            ));
        });
    });
}

function getVideoInfo(filePath) {
    const result = execFileSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile',
        '-of', 'json',
        filePath
    ], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    return JSON.parse(result);
}

function makeProgressTransform(total, onProgress) {
    let loaded = 0;
    return new Transform({
        transform(chunk, enc, callback) {
            loaded += chunk.length;
            onProgress(loaded, total || null);
            callback(null, chunk);
        }
    });
}

async function uploadR2(filePath, key, contentType, onProgress, signal) {
    throwIfAborted(signal);

    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (!size || !stat.isFile()) {
        throw new Error(`Refusing to upload an empty or invalid file: ${filePath}`);
    }

    let loaded = 0;
    let lastAt = Date.now();
    let lastLoaded = 0;

    const meter = new Transform({
        transform(chunk, enc, callback) {
            loaded += chunk.length;
            const now = Date.now();
            const speed = now - lastAt >= 1000
                ? (loaded - lastLoaded) / ((now - lastAt) / 1000)
                : null;
            updateProgressSafely(onProgress, loaded, size, speed);
            if (now - lastAt >= 1000) {
                lastAt = now;
                lastLoaded = loaded;
            }
            callback(null, chunk);
        }
    });

    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: fs.createReadStream(filePath).pipe(meter),
        ContentLength: size,
        ContentType: contentType,
        CacheControl: contentType === 'text/vtt' ? 'public, max-age=3600' : 'public, max-age=31536000, immutable'
    }), signal ? { abortSignal: signal } : undefined);

    throwIfAborted(signal);

    // R2 HEAD verification catches truncated/mismatched objects. If the R2 key
    // is write-only, keep the successful PUT and log that HEAD verification was unavailable.
    try {
        const head = await s3Client.send(new HeadObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key
        }), signal ? { abortSignal: signal } : undefined);

        if (Number.isFinite(head.ContentLength) && head.ContentLength !== size) {
            throw new Error(`R2 verification failed for ${key}: expected ${size} bytes, found ${head.ContentLength}.`);
        }
    } catch (error) {
        const statusCode = error?.$metadata?.httpStatusCode;
        const code = error?.name || error?.Code;
        if (statusCode === 403 || code === 'AccessDenied') {
            console.warn(`R2 HEAD verification skipped for ${key}: credentials do not have read permission.`);
        } else {
            throw error;
        }
    }

    updateProgressSafely(onProgress, size, size, 0);
}

function normalizeTimestamp(value) {
    const match = String(value).trim().replace(',', '.').match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{1,3})$/);
    if (!match) return null;
    const hours = String(match[1] || '00').padStart(2, '0');
    const minutes = match[2];
    const seconds = match[3];
    const millis = String(match[4]).padEnd(3, '0');
    return `${hours}:${minutes}:${seconds}.${millis}`;
}

function timestampToMs(value) {
    const normalized = normalizeTimestamp(value);
    if (!normalized) return null;
    const [clock, ms] = normalized.split('.');
    const [hours, minutes, seconds] = clock.split(':').map(Number);
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + Number(ms);
}

function escapeVttText(text) {
    return String(text)
        .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[\da-f]+;)/gi, '&amp;')
        .replace(/</g, match => match)
        .replace(/>/g, match => match);
}

function parseSubtitleBlocks(text) {
    const normalized = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();

    const blocks = normalized.split(/\n\s*\n/);
    const cues = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        const timingIndex = lines.findIndex(line => /-->/u.test(line));
        if (timingIndex < 0) continue;

        const timingLine = lines[timingIndex].trim();
        const timingMatch = timingLine.match(/^((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?$/);
        if (!timingMatch) continue;

        const start = normalizeTimestamp(timingMatch[1]);
        const endToken = timingMatch[2].trim().split(/\s+/)[0];
        const end = normalizeTimestamp(endToken);
        if (!start || !end) continue;
        if (timestampToMs(end) <= timestampToMs(start)) continue;

        const body = lines.slice(timingIndex + 1).join('\n').trim();
        const plain = body
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!plain) continue;

        cues.push({
            start,
            end,
            text: body
        });
    }

    return cues;
}

function validateSubtitleFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return { valid: false, reason: 'Subtitle file is missing.', cueCount: 0 };
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 10) {
        return { valid: false, reason: 'Subtitle file is empty or too small.', cueCount: 0 };
    }

    if (stat.size > 50 * 1024 * 1024) {
        return { valid: false, reason: 'Subtitle file is larger than 50 MB.', cueCount: 0 };
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const cues = parseSubtitleBlocks(text);
    if (cues.length === 0) {
        return { valid: false, reason: 'No valid timestamped subtitle cues with text were found.', cueCount: 0 };
    }

    return { valid: true, cueCount: cues.length, cues };
}

function convertSrtToVtt(sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;

    const ext = path.extname(sourcePath).toLowerCase();
    if (!['.srt', '.vtt'].includes(ext)) return null;

    const sourceText = fs.readFileSync(sourcePath, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();

    const cues = parseSubtitleBlocks(sourceText);
    if (cues.length === 0) return null;

    const vttPath = ext === '.vtt'
        ? `${sourcePath}.normalized.vtt`
        : `${sourcePath}.vtt`;

    const vtt = [
        'WEBVTT',
        '',
        ...cues.flatMap(cue => [
            `${cue.start} --> ${cue.end}`,
            escapeVttText(cue.text),
            ''
        ])
    ].join('\n').trimEnd() + '\n';

    fs.writeFileSync(vttPath, vtt, 'utf8');

    const validation = validateSubtitleFile(vttPath);
    if (!validation.valid) {
        try { fs.unlinkSync(vttPath); } catch (_) {}
        return null;
    }

    return vttPath;
}

function emitSubtitleStatus(updateSubtitleStatus, state, stage, detail = '', progress = null) {
    updateProgressSafely(updateSubtitleStatus, {
        state,
        stage,
        detail,
        progress,
        updatedAt: new Date().toISOString()
    });
}

function buildPythonEnvironment() {
    const env = { ...process.env };
    const modelDir = path.join(__dirname, 'models');
    env.HF_HOME = env.HF_HOME || path.join(modelDir, 'huggingface');
    env.HUGGINGFACE_HUB_CACHE = env.HUGGINGFACE_HUB_CACHE || path.join(env.HF_HOME, 'hub');
    env.TRANSFORMERS_CACHE = env.TRANSFORMERS_CACHE || path.join(env.HF_HOME, 'transformers');
    env.FASTER_WHISPER_CACHE = env.FASTER_WHISPER_CACHE || path.join(modelDir, 'faster-whisper');
    env.PYTHONUNBUFFERED = '1';
    return env;
}

async function runSubtitleAI(args, signal, updateSubtitleStatus) {
    const env = buildPythonEnvironment();
    return runProcess(pythonExecutable(), [AI_SCRIPT, ...args], {
        signal,
        env,
        label: 'Subtitle AI',
        onStdoutLine(line) {
            try {
                const event = JSON.parse(line);
                if (event.event === 'progress') {
                    emitSubtitleStatus(
                        updateSubtitleStatus,
                        'processing',
                        event.stage || 'AI subtitle processing',
                        event.detail || '',
                        Number.isFinite(event.progress) ? event.progress : null
                    );
                } else if (event.event === 'message') {
                    console.log(`[Subtitle AI] ${event.message}`);
                }
            } catch (_) {
                console.log(`[Subtitle AI] ${line}`);
            }
        }
    });
}

async function prepareSubtitles({
    subtitle1,
    subtitle2,
    rawPath,
    hasAudio,
    id,
    signal,
    updateSubtitleStatus
}) {
    const generatedFiles = [];
    let sinVtt = null;
    let engVtt = null;
    let audioPath = path.join(TEMP_DIR, `audio_${id}.mp3`);
    let engSrtPath = path.join(TEMP_DIR, `ai_eng_${id}.srt`);
    let sinSrtPath = path.join(TEMP_DIR, `ai_sin_${id}.srt`);

    try {
        emitSubtitleStatus(updateSubtitleStatus, 'checking', 'Checking uploaded subtitles', 'Validating SRT/VTT files.', 5);

        if (subtitle1) {
            const validation = validateSubtitleFile(subtitle1);
            if (validation.valid) {
                sinVtt = convertSrtToVtt(subtitle1);
                if (sinVtt) generatedFiles.push(sinVtt);
            } else {
                console.warn(`Sinhala subtitle ignored: ${validation.reason}`);
                emitSubtitleStatus(updateSubtitleStatus, 'warning', 'Invalid Sinhala subtitle ignored', validation.reason, 8);
            }
        }

        if (subtitle2) {
            const validation = validateSubtitleFile(subtitle2);
            if (validation.valid) {
                engVtt = convertSrtToVtt(subtitle2);
                if (engVtt) generatedFiles.push(engVtt);
            } else {
                console.warn(`English subtitle ignored: ${validation.reason}`);
                emitSubtitleStatus(updateSubtitleStatus, 'warning', 'Invalid English subtitle ignored', validation.reason, 8);
            }
        }

        if (sinVtt && engVtt) {
            emitSubtitleStatus(updateSubtitleStatus, 'ready', 'Uploaded subtitles validated', 'Both Sinhala and English subtitles are ready.', 100);
            return { sinVtt, engVtt, generatedFiles, audioPath: null };
        }

        if (!AI_ENABLED) {
            emitSubtitleStatus(updateSubtitleStatus, 'disabled', 'Automatic subtitles disabled', 'Set AI_SUBTITLES_ENABLED=true in .env to enable local AI subtitles.', 100);
            return { sinVtt, engVtt, generatedFiles, audioPath: null };
        }

        let englishForTranslation = engVtt;

        // If the English track is absent, first extract a small mono audio file,
        // then run Whisper while the video FFmpeg conversion is still running.
        if (!engVtt) {
            if (!hasAudio) {
                throw new Error('The video has no audio stream, so AI cannot generate subtitles.');
            }

            throwIfAborted(signal);
            emitSubtitleStatus(updateSubtitleStatus, 'processing', 'Extracting audio for AI subtitles', 'Running audio extraction alongside MP4 conversion.', 12);

            await runFFmpeg([
                '-y', '-i', rawPath,
                '-map', '0:a:0',
                '-vn',
                '-ac', '1',
                '-ar', '16000',
                '-c:a', 'libmp3lame',
                '-b:a', '48k',
                '-threads', '1',
                audioPath
            ], 0, () => {}, 'Extracting audio', { signal });

            if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
                throw new Error('Audio extraction did not produce a usable audio file.');
            }

            emitSubtitleStatus(updateSubtitleStatus, 'processing', 'AI is generating English subtitles', 'Faster-Whisper is processing the extracted audio.', 25);

            await runSubtitleAI([
                'generate',
                '--audio', audioPath,
                '--output', engSrtPath
            ], signal, updateSubtitleStatus);

            generatedFiles.push(engSrtPath);
            engVtt = convertSrtToVtt(engSrtPath);
            if (!engVtt || !validateSubtitleFile(engVtt).valid) {
                throw new Error('AI did not produce a valid English subtitle file.');
            }
            generatedFiles.push(engVtt);
            englishForTranslation = engVtt;
        }

        // If Sinhala is missing, translate an existing uploaded English subtitle
        // or the English transcript generated above. No cloud API is used.
        if (!sinVtt && englishForTranslation) {
            throwIfAborted(signal);
            emitSubtitleStatus(updateSubtitleStatus, 'processing', 'AI is translating English to Sinhala', 'Using the local offline translation model.', 65);

            await runSubtitleAI([
                'translate',
                '--input', englishForTranslation,
                '--output', sinSrtPath
            ], signal, updateSubtitleStatus);

            generatedFiles.push(sinSrtPath);
            sinVtt = convertSrtToVtt(sinSrtPath);
            if (!sinVtt || !validateSubtitleFile(sinVtt).valid) {
                throw new Error('AI did not produce a valid Sinhala subtitle file.');
            }
            generatedFiles.push(sinVtt);
        }

        const readyCount = Number(Boolean(sinVtt)) + Number(Boolean(engVtt));
        emitSubtitleStatus(
            updateSubtitleStatus,
            readyCount === 2 ? 'ready' : 'partial',
            readyCount === 2 ? 'AI subtitles ready' : 'Some subtitles are ready',
            `${readyCount}/2 subtitle tracks validated and ready for R2 upload.`,
            100
        );

        return { sinVtt, engVtt, generatedFiles, audioPath };

    } catch (error) {
        if (isAbortError(error, signal)) {
            // The caller may be cancelling the job while a subprocess is active.
            // Remove all subtitle-only temporary files before propagating cancel.
            const disposable = [audioPath, engSrtPath, sinSrtPath, ...generatedFiles];
            for (const file of new Set(disposable.filter(Boolean))) {
                try {
                    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
                } catch (cleanupError) {
                    console.warn(`Subtitle cancellation cleanup failed for ${file}:`, cleanupError.message);
                }
            }
            throw error;
        }
        console.error('Subtitle AI failed:', error.stack || error.message);
        emitSubtitleStatus(updateSubtitleStatus, 'warning', 'Automatic subtitle generation failed', error.message, null);
        return { sinVtt, engVtt, generatedFiles, audioPath };
    }
}

function makeTelegramForm({ title, permanentId, outPath, thumbPath, duration }) {
    const form = new FormData();
    form.append('chat_id', process.env.TG_CHAT_ID);
    form.append('video', fs.createReadStream(outPath), {
        filename: `${permanentId}.mp4`,
        contentType: 'video/mp4'
    });
    form.append('caption', `🎬 ${title}\nID: ${permanentId}`);
    form.append('supports_streaming', 'true');

    if (fs.existsSync(thumbPath)) {
        form.append('thumbnail', fs.createReadStream(thumbPath));
    }
    if (duration > 0) {
        form.append('duration', String(Math.round(duration)));
    }
    return form;
}

async function processVideo(jobData) {
    const {
        title,
        url,
        subtitle1,
        subtitle2
    } = jobData;

    const updateStatus = typeof jobData.updateStatus === 'function'
        ? jobData.updateStatus
        : () => {};
    const updateSubtitleStatus = typeof jobData.updateSubtitleStatus === 'function'
        ? jobData.updateSubtitleStatus
        : () => {};
    const signal = jobData.signal;

    fs.mkdirSync(TEMP_DIR, { recursive: true });

    const id = randomUUID();
    const rawPath = path.join(TEMP_DIR, `raw_${id}.bin`);
    const outPath = path.join(TEMP_DIR, `out_${id}.mp4`);
    const thumbPath = path.join(TEMP_DIR, `thumb_${id}.jpg`);

    let subtitles = null;
    let subtitlePromise = null;
    let subtitleController = null;
    let unlinkSubtitleAbort = null;
    let permanentId = null;
    let telegramFileId = null;
    let completed = false;

    try {
        console.log(`\n[Job Started] ${title}`);
        throwIfAborted(signal);

        // 1. Download
        updateStatus('Downloading video', 0, {
            detail: 'Connecting to source…',
            speed: null
        });

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 0,
            signal,
            validateStatus: status => status >= 200 && status < 300
        });

        const total = Number(response.headers['content-length']) || null;
        let lastAt = Date.now();
        let lastBytes = 0;

        const meter = makeProgressTransform(total, (loaded, expected) => {
            const now = Date.now();
            let speed = null;
            if (now - lastAt >= 1000) {
                speed = (loaded - lastBytes) / ((now - lastAt) / 1000);
                lastAt = now;
                lastBytes = loaded;
            }
            updateStatus('Downloading video', expected ? 25 * loaded / expected : null, {
                loadedBytes: loaded,
                totalBytes: expected,
                speed
            });
        });

        await pipeline(response.data, meter, fs.createWriteStream(rawPath), { signal });
        throwIfAborted(signal);

        const downloadedSize = fs.statSync(rawPath).size;
        if (downloadedSize < 1024) throw new Error('Downloaded video is empty or too small.');

        updateStatus('Download complete — checking codecs', 26, {
            loadedBytes: downloadedSize,
            totalBytes: downloadedSize,
            speed: 0
        });

        // 2. Inspect source
        const info = getVideoInfo(rawPath);
        const video = (info.streams || []).find(stream => stream.codec_type === 'video');
        const audio = (info.streams || []).find(stream => stream.codec_type === 'audio');
        if (!video) throw new Error('No video stream found in downloaded file.');

        const duration = Number(info.format?.duration) || 0;
        const isMp4 = (info.format?.format_name || '').split(',').includes('mp4');
        const isH264 = video.codec_name === 'h264';
        const isAacLc = audio?.codec_name === 'aac' && audio?.profile === 'LC';
        let mode;

        // Start subtitle work before video conversion. Audio extraction and AI
        // transcription continue in parallel with the H.264/AAC FFmpeg job.
        subtitleController = new AbortController();
        const abortSubtitleWork = () => subtitleController.abort();
        if (signal) {
            if (signal.aborted) abortSubtitleWork();
            else {
                signal.addEventListener('abort', abortSubtitleWork, { once: true });
                unlinkSubtitleAbort = () => signal.removeEventListener('abort', abortSubtitleWork);
            }
        }

        subtitlePromise = prepareSubtitles({
            subtitle1,
            subtitle2,
            rawPath,
            hasAudio: Boolean(audio),
            id,
            signal: subtitleController.signal,
            updateSubtitleStatus
        });
        // Attach a rejection handler immediately because video conversion may
        // fail before the parallel subtitle task has finished.
        subtitlePromise.catch(() => {});

        // 3. Convert/remux video
        if (isMp4 && isH264 && isAacLc) {
            mode = 'ORIGINAL_COPY';
            updateStatus('Compatible H.264/AAC MP4 — keeping original quality', 65, {
                detail: 'No re-encoding required'
            });
            await pipeline(
                fs.createReadStream(rawPath),
                fs.createWriteStream(outPath),
                { signal }
            );
        } else {
            mode = isMp4 && isH264 ? 'AUDIO_ONLY' : 'FULL_CONVERSION';
            const args = [
                '-y',
                '-i', rawPath,
                '-map', '0:v:0',
                '-map', '0:a:0?'
            ];

            if (mode === 'AUDIO_ONLY') {
                args.push('-c:v', 'copy');
            } else {
                args.push(
                    '-c:v', 'libx264',
                    '-preset', process.env.X264_PRESET || 'fast',
                    '-crf', process.env.X264_CRF || '23',
                    '-threads', process.env.VIDEO_THREADS || '1'
                );
            }

            args.push(
                '-c:a', 'aac',
                '-b:a', '160k',
                '-ac', '2',
                '-movflags', '+faststart',
                '-progress', 'pipe:1',
                '-nostats',
                outPath
            );

            await runFFmpeg(
                args,
                duration,
                updateStatus,
                mode === 'AUDIO_ONLY' ? 'Converting audio to AAC' : 'Converting video to H.264 MP4',
                { signal, progressStart: 30, progressRange: 35 }
            );
        }

        throwIfAborted(signal);
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
            throw new Error('Output MP4 was not created or is empty.');
        }

        const fileSize = fs.statSync(outPath).size;
        console.log(`Processing mode: ${mode}; output ${(fileSize / 1048576).toFixed(2)} MB`);

        // If the subtitle worker is still translating/transcribing, wait here.
        subtitles = await subtitlePromise;
        throwIfAborted(signal);

        permanentId = randomUUID();
        const r2Key = `videos/${permanentId}.mp4`;

        // 4. Upload video
        updateStatus('Uploading video to Cloudflare R2', 66, { detail: 'Preparing upload' });
        await uploadR2(outPath, r2Key, 'video/mp4', (loaded, totalBytes, speed) => {
            updateStatus(
                'Uploading video to Cloudflare R2',
                totalBytes ? 66 + 17 * loaded / totalBytes : null,
                { loadedBytes: loaded, totalBytes, speed }
            );
        }, signal);

        updateStatus('R2 video upload complete', 84);

        // 5. Upload only subtitles that passed cue/timestamp/text validation.
        const subtitleTasks = [
            { file: subtitles?.sinVtt, key: `subtitles/${permanentId}_sin.vtt`, label: 'Sinhala subtitle' },
            { file: subtitles?.engVtt, key: `subtitles/${permanentId}_eng.vtt`, label: 'English subtitle' }
        ].filter(item => {
            if (!item.file || !fs.existsSync(item.file)) return false;
            const validation = validateSubtitleFile(item.file);
            if (!validation.valid) {
                console.warn(`Skipping ${item.label}: ${validation.reason}`);
                return false;
            }
            return true;
        });

        for (let index = 0; index < subtitleTasks.length; index++) {
            throwIfAborted(signal);
            const task = subtitleTasks[index];
            const base = 84 + (index / Math.max(1, subtitleTasks.length)) * 4;
            updateStatus(`Uploading ${task.label}`, base);
            await uploadR2(task.file, task.key, 'text/vtt', (loaded, totalBytes, speed) => {
                updateStatus(
                    `Uploading ${task.label}`,
                    totalBytes ? base + 4 * (loaded / totalBytes) / Math.max(1, subtitleTasks.length) : null,
                    { loadedBytes: loaded, totalBytes, speed }
                );
            }, signal);
        }

        // 6. Telegram upload (optional)
        if (fileSize < 1.95 * 1024 ** 3 && process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
            updateStatus('Preparing Telegram upload', 89);
            try {
                try {
                    execFileSync('ffmpeg', [
                        '-y', '-ss', '00:00:05', '-i', outPath,
                        '-vframes', '1', '-vf', 'scale=320:-2', '-q:v', '5', thumbPath
                    ], { stdio: 'ignore' });
                } catch (_) {
                    // Thumbnail is optional.
                }

                const form = makeTelegramForm({ title, permanentId, outPath, thumbPath, duration });
                const tgUrl = process.env.TG_API_BASE_URL || 'http://localhost:8081';
                const tgRes = await axios.post(
                    `${tgUrl}/bot${process.env.TG_BOT_TOKEN}/sendVideo`,
                    form,
                    {
                        headers: form.getHeaders(),
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity,
                        timeout: 0,
                        signal,
                        onUploadProgress: event => {
                            updateStatus('Uploading to Telegram', event.total ? 89 + 8 * event.loaded / event.total : null, {
                                loadedBytes: event.loaded,
                                totalBytes: event.total || null
                            });
                        }
                    }
                );

                telegramFileId = tgRes.data?.result?.video?.file_id || null;
                updateStatus('Telegram upload complete', 97);
            } catch (error) {
                if (isAbortError(error, signal)) throw error;
                console.error('Telegram upload failed:', error.response?.data?.description || error.message);
                updateStatus('Telegram upload failed — continuing with database sync', 97, {
                    detail: error.response?.data?.description || error.message
                });
            }
        } else {
            updateStatus(
                fileSize >= 1.95 * 1024 ** 3
                    ? 'Telegram skipped (file exceeds configured size limit)'
                    : 'Telegram not configured — skipped',
                97
            );
        }

        // 7. Database sync
        throwIfAborted(signal);
        updateStatus('Syncing video record to database', 98);
        const syncUrl = `${process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev'}/api/vps/sync`;
        const syncRes = await axios.post(syncUrl, {
            uuid: permanentId,
            title,
            r2_key: r2Key,
            telegram_file_id: telegramFileId,
            source_type: 'r2'
        }, {
            headers: { Authorization: `Bearer ${process.env.CF_VPS_API_KEY}` },
            timeout: 60000,
            signal
        });

        if (syncRes.status < 200 || syncRes.status >= 300) {
            throw new Error(`Database sync failed with HTTP ${syncRes.status}`);
        }

        completed = true;
        console.log(`[Job Completed] ${title} (${permanentId})`);

        return {
            permanentId,
            r2Key,
            telegramFileId,
            subtitlesUploaded: subtitleTasks.map(task => task.key)
        };

    } catch (error) {
        if (isAbortError(error, signal)) {
            const cancelled = new Error('Job was cancelled by an administrator.');
            cancelled.name = 'AbortError';
            cancelled.code = 'ABORT_ERR';
            throw cancelled;
        }
        console.error(`[Job Failed] ${title}:`, error.stack || error.message);
        throw error;

    } finally {
        // If the video path failed before subtitles finished, stop the parallel
        // AI task and wait for its subprocesses to exit before deleting files.
        if (!completed && subtitleController && !subtitleController.signal.aborted) {
            subtitleController.abort();
        }
        if (unlinkSubtitleAbort) unlinkSubtitleAbort();
        if (subtitlePromise && !subtitles) {
            try {
                subtitles = await subtitlePromise;
            } catch (subtitleError) {
                if (!isAbortError(subtitleError, signal)) {
                    console.warn('Subtitle task ended during cleanup:', subtitleError.message);
                }
            }
        }

        const cleanup = [rawPath, outPath, thumbPath, subtitles?.audioPath];

        // Keep original user-uploaded subtitles after a failure so a retry can
        // reuse them. Generated artifacts and audio are always disposable.
        if (subtitles?.generatedFiles) cleanup.push(...subtitles.generatedFiles);

        if (completed) cleanup.push(subtitle1, subtitle2);

        for (const file of new Set(cleanup.filter(Boolean))) {
            try {
                if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
            } catch (error) {
                console.error(`Cleanup failed for ${file}:`, error.message);
            }
        }
    }
}

module.exports = {
    processVideo,
    convertSrtToVtt,
    validateSubtitleFile
};
