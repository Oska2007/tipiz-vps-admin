'use strict';

const {
    execFileSync,
    spawn
} = require('child_process');

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
    pipeline
} = require('stream/promises');

const {
    Transform
} = require('stream');

const FormData = require('form-data');

const {
    S3Client,
    PutObjectCommand
} = require('@aws-sdk/client-s3');

const {
    randomUUID
} = require('crypto');

// ========================================
// CLOUDFLARE R2
// ========================================

const s3Client = new S3Client({

    region: 'auto',

    endpoint: process.env.R2_ENDPOINT,

    credentials: {

        accessKeyId:
            process.env.R2_ACCESS_KEY_ID,

        secretAccessKey:
            process.env.R2_SECRET_ACCESS_KEY

    }

});

// ========================================
// SUBTITLE CONVERTER
// ========================================

function escapeVttText(text) {

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

}

function convertSrtToVtt(sourcePath) {

    if (
        !sourcePath ||
        path.extname(sourcePath).toLowerCase() !== '.srt'
    ) {
        return sourcePath;
    }

    const vttPath = `${sourcePath}.vtt`;

    let srt = fs.readFileSync(
        sourcePath,
        'utf8'
    )
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();

    const cues = srt.split(/\n{2,}/)
        .map(block => {

            const lines = block.split('\n');

            const index = lines.findIndex(line =>
                /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(line)
            );

            if (index < 0) return null;

            const parts = lines[index].split(
                /\s+-->\s+/
            );

            if (parts.length !== 2) return null;

            const normalize = value =>
                value.trim()
                    .replace(',', '.')
                    .replace(
                        /(\d{2}:\d{2}:\d{2}\.\d{1,2})(?!\d)/,
                        t => t.padEnd(12, '0')
                    );

            const endParts = parts[1].split(/\s+/);

            const timing =
                `${normalize(parts[0])} --> ` +
                `${normalize(endParts[0])}` +
                (
                    endParts.length > 1
                        ? ' ' + endParts.slice(1).join(' ')
                        : ''
                );

            return (
                `${timing}\n` +
                escapeVttText(
                    lines.slice(index + 1).join('\n').trim()
                )
            );

        })
        .filter(Boolean);

    fs.writeFileSync(
        vttPath,
        `WEBVTT\n\n${cues.join('\n\n')}\n`,
        'utf8'
    );

    return vttPath;

}

// ========================================
// VIDEO INFORMATION
// ========================================

function getVideoInfo(filePath) {

    const result = execFileSync(

        'ffprobe',

        [
            '-v',
            'error',

            '-show_entries',

            'format=format_name,duration:stream=index,codec_type,codec_name,profile',

            '-of',
            'json',

            filePath
        ],

        {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        }

    );

    return JSON.parse(result);

}

// ========================================
// FFMPEG PROGRESS
// ========================================

function runFFmpeg(
    args,
    duration,
    updateStatus,
    label
) {

    return new Promise((resolve, reject) => {

        const ffmpeg = spawn(
            'ffmpeg',
            args,
            {
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe'
                ]
            }
        );

        let progressBuffer = '';
        let errorBuffer = '';

        ffmpeg.stdout.on('data', data => {

            progressBuffer += data.toString();

            const lines = progressBuffer.split('\n');

            progressBuffer = lines.pop();

            for (const line of lines) {

                if (!line.startsWith('out_time_ms=')) {
                    continue;
                }

                const value = Number(
                    line.slice('out_time_ms='.length)
                );

                if (
                    duration > 0 &&
                    Number.isFinite(value)
                ) {

                    const fraction = Math.max(
                        0,
                        Math.min(
                            1,
                            value / 1000000 / duration
                        )
                    );

                    updateStatus(
                        label,
                        30 + fraction * 35,
                        {
                            detail:
                                `${Math.round(fraction * 100)}% of video timeline`
                        }
                    );

                }

            }

        });

        ffmpeg.stderr.on('data', data => {

            errorBuffer += data.toString();

            if (errorBuffer.length > 12000) {
                errorBuffer = errorBuffer.slice(-12000);
            }

        });

        ffmpeg.on('error', reject);

        ffmpeg.on('close', code => {

            if (code === 0) {
                resolve();
            } else {

                reject(
                    new Error(
                        `FFmpeg exited with code ${code}: ` +
                        errorBuffer.slice(-2500)
                    )
                );

            }

        });

    });

}

// ========================================
// STREAM PROGRESS
// ========================================

function makeProgressTransform(total, onProgress) {

    let loaded = 0;

    return new Transform({

        transform(chunk, enc, cb) {

            loaded += chunk.length;

            onProgress(
                loaded,
                total || null
            );

            cb(null, chunk);

        }

    });

}

// ========================================
// R2 UPLOAD
// ========================================

async function uploadR2(
    filePath,
    key,
    contentType,
    onProgress
) {

    const size = fs.statSync(filePath).size;

    let loaded = 0;

    let lastAt = Date.now();
    let lastLoaded = 0;

    const meter = new Transform({

        transform(chunk, enc, cb) {

            loaded += chunk.length;

            const now = Date.now();

            const speed =
                now - lastAt >= 1000
                    ? (
                        (loaded - lastLoaded) /
                        ((now - lastAt) / 1000)
                    )
                    : null;

            onProgress(
                loaded,
                size,
                speed
            );

            if (now - lastAt >= 1000) {

                lastAt = now;
                lastLoaded = loaded;

            }

            cb(null, chunk);

        }

    });

    await s3Client.send(

        new PutObjectCommand({

            Bucket: process.env.R2_BUCKET_NAME,

            Key: key,

            Body: fs.createReadStream(filePath).pipe(meter),

            ContentLength: size,

            ContentType: contentType

        })

    );

    onProgress(size, size, 0);

}

// ========================================
// MAIN PROCESS
// ========================================

async function processVideo(jobData) {

    const {
        title,
        url,
        subtitle1,
        subtitle2
    } = jobData;

    const updateStatus =
        typeof jobData.updateStatus === 'function'
            ? jobData.updateStatus
            : () => {};

    const tempDir = path.join(
        __dirname,
        'temp'
    );

    fs.mkdirSync(tempDir, {
        recursive: true
    });

    const id = randomUUID();

    const rawPath = path.join(
        tempDir,
        `raw_${id}.bin`
    );

    const outPath = path.join(
        tempDir,
        `out_${id}.mp4`
    );

    const thumbPath = path.join(
        tempDir,
        `thumb_${id}.jpg`
    );

    let sub1Vtt = null;
    let sub2Vtt = null;

    let permanentId = null;
    let telegramFileId = null;

    let completed = false;

    try {

        console.log(`\n[Job Started] ${title}`);

        // ========================================
        // 1. DOWNLOAD
        // ========================================

        updateStatus(
            'Downloading video',
            0,
            {
                detail: 'Connecting to source…',
                speed: null
            }
        );

        const response = await axios({

            url,

            method: 'GET',

            responseType: 'stream',

            headers: {
                'User-Agent': 'Mozilla/5.0'
            },

            maxContentLength: Infinity,

            maxBodyLength: Infinity,

            timeout: 0,

            validateStatus: status =>
                status >= 200 && status < 300

        });

        const total =
            Number(response.headers['content-length']) ||
            null;

        let lastAt = Date.now();
        let lastBytes = 0;

        const meter = makeProgressTransform(
            total,

            (loaded, expected) => {

                const now = Date.now();

                let speed = null;

                if (now - lastAt >= 1000) {

                    speed =
                        (loaded - lastBytes) /
                        ((now - lastAt) / 1000);

                    lastAt = now;
                    lastBytes = loaded;

                }

                updateStatus(
                    'Downloading video',

                    expected
                        ? 25 * loaded / expected
                        : null,

                    {
                        loadedBytes: loaded,
                        totalBytes: expected,
                        speed
                    }
                );

            }
        );

        await pipeline(
            response.data,
            meter,
            fs.createWriteStream(rawPath)
        );

        updateStatus(
            'Download complete — checking codecs',
            26,
            {
                loadedBytes: fs.statSync(rawPath).size,
                totalBytes: fs.statSync(rawPath).size,
                speed: 0
            }
        );

        // ========================================
        // 2. CHECK VIDEO CODECS
        // ========================================

        const info = getVideoInfo(rawPath);

        const video = info.streams.find(
            s => s.codec_type === 'video'
        );

        const audio = info.streams.find(
            s => s.codec_type === 'audio'
        );

        if (!video) {
            throw new Error(
                'No video stream found in downloaded file.'
            );
        }

        const duration =
            Number(info.format.duration) || 0;

        const isMp4 =
            (info.format.format_name || '')
                .split(',')
                .includes('mp4');

        const isH264 =
            video.codec_name === 'h264';

        const isAacLc =
            audio?.codec_name === 'aac' &&
            audio?.profile === 'LC';

        let mode;

        // ========================================
        // 3. CONVERSION
        // ========================================

        if (isMp4 && isH264 && isAacLc) {

            mode = 'ORIGINAL_COPY';

            updateStatus(
                'Compatible H.264/AAC MP4 — keeping original quality',
                65,
                {
                    detail: 'No re-encoding required'
                }
            );

            await pipeline(
                fs.createReadStream(rawPath),
                fs.createWriteStream(outPath)
            );

        } else {

            mode =
                isMp4 && isH264
                    ? 'AUDIO_ONLY'
                    : 'FULL_CONVERSION';

            const args = [
                '-y',
                '-i',
                rawPath,
                '-map',
                '0:v:0',
                '-map',
                '0:a:0?'
            ];

            if (mode === 'AUDIO_ONLY') {

                args.push(
                    '-c:v',
                    'copy'
                );

            } else {

                args.push(
                    '-c:v',
                    'libx264',
                    '-preset',
                    'fast',
                    '-crf',
                    '23',
                    '-threads',
                    '2'
                );

            }

            args.push(
                '-c:a',
                'aac',
                '-b:a',
                '160k',
                '-ac',
                '2',
                '-movflags',
                '+faststart',
                '-progress',
                'pipe:1',
                '-nostats',
                outPath
            );

            await runFFmpeg(
                args,
                duration,
                updateStatus,

                mode === 'AUDIO_ONLY'
                    ? 'Converting audio to AAC'
                    : 'Converting video to H.264 MP4'
            );

        }

        if (
            !fs.existsSync(outPath) ||
            fs.statSync(outPath).size === 0
        ) {
            throw new Error(
                'Output MP4 was not created or is empty.'
            );
        }

        const fileSize = fs.statSync(outPath).size;

        console.log(
            `Processing mode: ${mode}; output ${(fileSize / 1048576).toFixed(2)} MB`
        );

        permanentId = randomUUID();

        const r2Key = `videos/${permanentId}.mp4`;

        // ========================================
        // 4. SUBTITLE CONVERSION
        // ========================================

        sub1Vtt = convertSrtToVtt(subtitle1);

        sub2Vtt = convertSrtToVtt(subtitle2);

        // ========================================
        // 5. R2 VIDEO UPLOAD
        // ========================================

        updateStatus(
            'Uploading video to Cloudflare R2',
            66,
            {
                detail: 'Preparing upload'
            }
        );

        await uploadR2(
            outPath,
            r2Key,
            'video/mp4',

            (loaded, totalBytes, speed) => {

                updateStatus(
                    'Uploading video to Cloudflare R2',

                    totalBytes
                        ? 66 + 17 * loaded / totalBytes
                        : null,

                    {
                        loadedBytes: loaded,
                        totalBytes,
                        speed
                    }
                );

            }
        );

        updateStatus(
            'R2 video upload complete',
            84
        );

        // ========================================
        // 6. SUBTITLE UPLOAD
        // ========================================

        const subtitleTasks = [

            {
                file: sub1Vtt,
                key: `subtitles/${permanentId}_sin.vtt`,
                label: 'Sinhala subtitle'
            },

            {
                file: sub2Vtt,
                key: `subtitles/${permanentId}_eng.vtt`,
                label: 'English subtitle'
            }

        ].filter(item =>
            item.file && fs.existsSync(item.file)
        );

        for (
            let i = 0;
            i < subtitleTasks.length;
            i++
        ) {

            const task = subtitleTasks[i];

            updateStatus(
                `Uploading ${task.label}`,
                84 + (
                    i / Math.max(1, subtitleTasks.length)
                ) * 4
            );

            await uploadR2(
                task.file,
                task.key,
                'text/vtt',

                (loaded, totalBytes, speed) => {

                    const base =
                        84 + (
                            i / Math.max(1, subtitleTasks.length)
                        ) * 4;

                    updateStatus(
                        `Uploading ${task.label}`,

                        totalBytes
                            ? base + (
                                4 * (loaded / totalBytes) /
                                Math.max(1, subtitleTasks.length)
                            )
                            : null,

                        {
                            loadedBytes: loaded,
                            totalBytes,
                            speed
                        }
                    );

                }
            );

        }

        // ========================================
        // 7. TELEGRAM UPLOAD
        // ========================================

        if (
            fileSize < 1.95 * 1024 ** 3 &&
            process.env.TG_BOT_TOKEN &&
            process.env.TG_CHAT_ID
        ) {

            updateStatus(
                'Preparing Telegram upload',
                89
            );

            try {

                try {

                    execFileSync(
                        'ffmpeg',

                        [
                            '-y',
                            '-ss',
                            '00:00:05',
                            '-i',
                            outPath,
                            '-vframes',
                            '1',
                            '-vf',
                            'scale=320:-2',
                            '-q:v',
                            '5',
                            thumbPath
                        ],

                        {
                            stdio: 'ignore'
                        }
                    );

                } catch (_) {
                    // Thumbnail is optional.
                }

                const form = new FormData();

                form.append(
                    'chat_id',
                    process.env.TG_CHAT_ID
                );

                form.append(
                    'video',
                    fs.createReadStream(outPath),
                    {
                        filename: `${permanentId}.mp4`,
                        contentType: 'video/mp4'
                    }
                );

                form.append(
                    'caption',
                    `🎬 ${title}\nID: ${permanentId}`
                );

                form.append(
                    'supports_streaming',
                    'true'
                );

                if (fs.existsSync(thumbPath)) {

                    form.append(
                        'thumbnail',
                        fs.createReadStream(thumbPath)
                    );

                }

                if (duration > 0) {

                    form.append(
                        'duration',
                        String(Math.round(duration))
                    );

                }

                const tgUrl =
                    process.env.TG_API_BASE_URL ||
                    'http://localhost:8081';

                const tgRes = await axios.post(

                    `${tgUrl}/bot${process.env.TG_BOT_TOKEN}/sendVideo`,

                    form,

                    {
                        headers: form.getHeaders(),

                        maxBodyLength: Infinity,

                        maxContentLength: Infinity,

                        timeout: 0,

                        onUploadProgress: event => {

                            updateStatus(
                                'Uploading to Telegram',

                                event.total
                                    ? 89 + 8 * event.loaded / event.total
                                    : null,

                                {
                                    loadedBytes: event.loaded,
                                    totalBytes: event.total || null
                                }
                            );

                        }

                    }

                );

                telegramFileId =
                    tgRes.data?.result?.video?.file_id ||
                    null;

                updateStatus(
                    'Telegram upload complete',
                    97
                );

            } catch (e) {

                console.error(
                    'Telegram upload failed:',
                    e.response?.data?.description || e.message
                );

                updateStatus(
                    'Telegram upload failed — continuing with database sync',
                    97,
                    {
                        detail:
                            e.response?.data?.description ||
                            e.message
                    }
                );

            }

        } else {

            updateStatus(

                fileSize >= 1.95 * 1024 ** 3
                    ? 'Telegram skipped (file exceeds configured size limit)'
                    : 'Telegram not configured — skipped',

                97

            );

        }

        // ========================================
        // 8. DATABASE SYNC
        // ========================================

        updateStatus(
            'Syncing video record to database',
            98
        );

        const syncUrl =
            `${process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev'}/api/vps/sync`;

        const syncRes = await axios.post(

            syncUrl,

            {
                uuid: permanentId,
                title,
                r2_key: r2Key,
                telegram_file_id: telegramFileId,
                source_type: 'r2'
            },

            {
                headers: {
                    Authorization:
                        `Bearer ${process.env.CF_VPS_API_KEY}`
                },

                timeout: 60000
            }

        );

        if (
            syncRes.status < 200 ||
            syncRes.status >= 300
        ) {
            throw new Error(
                `Database sync failed with HTTP ${syncRes.status}`
            );
        }

        console.log(
            `[Job Completed] ${title} (${permanentId})`
        );

        completed = true;

        return {
            permanentId,
            r2Key,
            telegramFileId
        };

    } catch (err) {

        console.error(
            `[Job Failed] ${title}:`,
            err.message
        );

        throw err;

    } finally {

        // ========================================
        // 9. CLEANUP
        // ========================================

        const cleanup = [
            rawPath,
            outPath,
            thumbPath
        ];

        // Failed job retry එකට subtitles තබාගන්නවා.
        if (completed) {

            cleanup.push(
                subtitle1,
                subtitle2
            );

            if (
                subtitle1 &&
                sub1Vtt &&
                subtitle1 !== sub1Vtt
            ) {
                cleanup.push(sub1Vtt);
            }

            if (
                subtitle2 &&
                sub2Vtt &&
                subtitle2 !== sub2Vtt
            ) {
                cleanup.push(sub2Vtt);
            }

        }

        for (const file of cleanup) {

            if (file && fs.existsSync(file)) {

                try {

                    fs.unlinkSync(file);

                } catch (e) {

                    console.error(
                        `Cleanup failed for ${file}:`,
                        e.message
                    );

                }

            }

        }

    }

}

// ========================================
// EXPORT
// ========================================

module.exports = {
    processVideo,
    convertSrtToVtt
};