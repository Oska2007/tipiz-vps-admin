const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const FormData = require('form-data');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

// ==========================================
// CLOUDFLARE R2 CONFIGURATION
// ==========================================

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ==========================================
// SRT TO VTT CONVERTER
// ==========================================

function escapeVttText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function convertSrtToVtt(sourcePath) {
  if (!sourcePath || path.extname(sourcePath).toLowerCase() !== '.srt') {
    return sourcePath;
  }

  const vttPath = `${sourcePath}.vtt`;

  let srt = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^\uFEFF/, '');

  srt = srt.replace(/\r\n?/g, '\n').trim();

  const cues = srt.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');

    const timingIndex = lines.findIndex((line) =>
      /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(line)
    );

    if (timingIndex === -1) return null;

    const parts = lines[timingIndex].split(/\s+-->\s+/);

    if (parts.length !== 2) return null;

    const normalizeTime = (value) => {
      const match = value.trim().replace(',', '.');

      return match.replace(
        /(\d{2}:\d{2}:\d{2}\.\d{1,2})(?!\d)/,
        (time) => time.padEnd(12, '0')
      );
    };

    const timingParts = parts[1].split(/\s+/);

    const timing = `${normalizeTime(parts[0])} --> ${normalizeTime(timingParts[0])}${
      timingParts.length > 1
        ? ' ' + timingParts.slice(1).join(' ')
        : ''
    }`;

    const text = escapeVttText(
      lines.slice(timingIndex + 1).join('\n').trim()
    );

    return `${timing}\n${text}`;
  }).filter(Boolean);

  fs.writeFileSync(
    vttPath,
    `WEBVTT\n\n${cues.join('\n\n')}\n`,
    'utf8'
  );

  return vttPath;
}

// ==========================================
// FFPROBE INFORMATION
// ==========================================

function getVideoInfo(filePath) {
  const result = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,profile',
    '-of', 'json',
    filePath
  ], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(result);
}

// ==========================================
// FFMPEG PROCESS WITH PROGRESS
// ==========================================

function runFFmpeg(args, duration, updateStatus) {
  return new Promise((resolve, reject) => {

    const ffmpeg = spawn('ffmpeg', args);

    let progressBuffer = '';
    let errorBuffer = '';

    ffmpeg.stdout.on('data', (data) => {

      progressBuffer += data.toString();

      const lines = progressBuffer.split('\n');

      progressBuffer = lines.pop();

      for (const line of lines) {

        if (line.startsWith('out_time_ms=')) {

          const timeMs = parseInt(line.split('=')[1], 10);

          if (duration > 0 && Number.isFinite(timeMs)) {

            const percent = Math.min(
              99,
              (timeMs / 1000000 / duration) * 100
            );

            const overallProgress = 40 + (percent * 0.4);

            updateStatus(
              'Processing video...',
              Math.round(overallProgress)
            );
          }
        }
      }
    });

    ffmpeg.stderr.on('data', (data) => {

      const msg = data.toString();

      errorBuffer += msg;

      if (errorBuffer.length > 20000) {
        errorBuffer = errorBuffer.slice(-20000);
      }

      if (msg.toLowerCase().includes('error')) {
        console.error(msg);
      }
    });

    ffmpeg.on('error', reject);

    ffmpeg.on('close', (code) => {

      if (code === 0) {

        console.log('FFmpeg processing completed.');

        resolve();

      } else {

        reject(
          new Error(
            `FFmpeg exited with code ${code}: ${errorBuffer.slice(-3000)}`
          )
        );

      }
    });

  });
}

// ==========================================
// MAIN VIDEO PROCESSING
// ==========================================

async function processVideo(jobData) {

  const {
    title,
    url,
    subtitle1,
    subtitle2,
    updateStatus
  } = jobData;

  const tempDir = path.join(__dirname, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const jobId = uuidv4();

  const rawVideoPath = path.join(
    tempDir,
    `raw_${jobId}.mp4`
  );

  const outputVideoPath = path.join(
    tempDir,
    `out_${jobId}.mp4`
  );

  const thumbPath = path.join(
    tempDir,
    `thumb_${jobId}.jpg`
  );

  let subtitle1Vtt = null;
  let subtitle2Vtt = null;

  let permanentId = null;
  let telegramFileId = null;

  try {

    // ==========================================
    // 1. DOWNLOAD VIDEO
    // ==========================================

    console.log(`\n[Job Started] ${title}`);

    updateStatus('Downloading video...', 10);

    console.log(`[1/5] Downloading: ${url}`);

    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 0
    });

    await pipeline(
      response.data,
      fs.createWriteStream(rawVideoPath)
    );

    console.log('Video downloaded successfully.');

    // ==========================================
    // 2. CHECK VIDEO AND AUDIO CODECS
    // ==========================================

    updateStatus('Checking video and audio codecs...', 25);

    console.log('[2/5] Checking media information...');

    const info = getVideoInfo(rawVideoPath);

    const videoStream = info.streams.find(
      stream => stream.codec_type === 'video'
    );

    const audioStream = info.streams.find(
      stream => stream.codec_type === 'audio'
    );

    if (!videoStream) {
      throw new Error('No video stream found.');
    }

    const videoCodec = videoStream.codec_name;

    const audioCodec = audioStream
      ? audioStream.codec_name
      : 'none';

    const audioProfile = audioStream
      ? audioStream.profile
      : null;

    const formatName = info.format.format_name || '';

    const duration = parseFloat(info.format.duration) || 0;

    const isMp4 = formatName.split(',').includes('mp4');

    const isH264 = videoCodec === 'h264';

    const isAacLc =
      audioCodec === 'aac' &&
      audioProfile === 'LC';

    const hasAudio = Boolean(audioStream);

    console.log('--------------------------------');
    console.log(`Video Codec: ${videoCodec}`);
    console.log(`Audio Codec: ${audioCodec}`);
    console.log(`Audio Profile: ${audioProfile || 'N/A'}`);
    console.log(`Container: ${formatName}`);
    console.log(`Duration: ${duration}`);
    console.log('--------------------------------');

    // ==========================================
    // 3. SELECT PROCESSING METHOD
    // ==========================================

    let processingMode;

    let ffmpegArgs = [];

    if (isH264 && isMp4 && isAacLc) {

      // ----------------------------------------
      // CASE 1: H264 MP4 + AAC-LC
      // ----------------------------------------

      processingMode = 'ORIGINAL_COPY';

      console.log(
        '[3/5] H264 MP4 + AAC-LC detected.'
      );

      console.log(
        'Original file will be uploaded without changes.'
      );

      updateStatus('Compatible MP4 detected. Copying original...', 40);

      fs.copyFileSync(
        rawVideoPath,
        outputVideoPath
      );

      updateStatus('Original file ready...', 80);

    } else if (isH264 && isMp4) {

      // ----------------------------------------
      // CASE 2: H264 MP4 + INCOMPATIBLE AUDIO
      // ----------------------------------------

      processingMode = 'AUDIO_ONLY';

      console.log(
        '[3/5] H264 MP4 detected. Converting audio only.'
      );

      updateStatus('Converting audio to AAC...', 40);

      ffmpegArgs = [
        '-y',

        '-i', rawVideoPath,

        '-map', '0:v:0',
        '-map', '0:a:0?',

        // Keep original video quality
        '-c:v', 'copy',

        // Convert audio to AAC
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ac', '2',

        // MP4 optimization
        '-movflags', '+faststart',

        '-progress', 'pipe:1',

        outputVideoPath
      ];

      await runFFmpeg(
        ffmpegArgs,
        duration,
        updateStatus
      );

    } else {

      // ----------------------------------------
      // CASE 3: ALL OTHER VIDEO FORMATS
      // ----------------------------------------

      processingMode = 'FULL_CONVERSION';

      console.log(
        `[3/5] Converting ${videoCodec} to H264 + AAC.`
      );

      console.log('CRF: 23');

      updateStatus('Converting to H264 MP4 (CRF 23)...', 40);

      ffmpegArgs = [
        '-y',

        '-i', rawVideoPath,

        '-map', '0:v:0',
        '-map', '0:a:0?',

        // H264 video
        '-c:v', 'libx264',

        '-preset', 'ultrafast',

        '-crf', '23',

        '-threads', '1',

        // AAC audio
        '-c:a', 'aac',

        '-b:a', '160k',

        '-ac', '2',

        // MP4 optimization
        '-movflags', '+faststart',

        '-progress', 'pipe:1',

        outputVideoPath
      ];

      await runFFmpeg(
        ffmpegArgs,
        duration,
        updateStatus
      );
    }

    console.log(`Processing Mode: ${processingMode}`);

    // ==========================================
    // 4. VERIFY OUTPUT FILE
    // ==========================================

    if (!fs.existsSync(outputVideoPath)) {
      throw new Error('Output video was not created.');
    }

    const fileSize = fs.statSync(outputVideoPath).size;

    if (fileSize === 0) {
      throw new Error('Output video is empty.');
    }

    const fileSizeGB = fileSize / (1024 ** 3);

    console.log(
      `Final Video Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`
    );

    // ==========================================
    // 5. UPLOAD TO CLOUDFLARE R2
    // ==========================================

    updateStatus('Uploading to R2...', 80);

    console.log('[4/5] Uploading to Cloudflare R2...');

    permanentId = uuidv4();

    const r2Key = `videos/${permanentId}.mp4`;

    // Convert subtitles

    subtitle1Vtt = convertSrtToVtt(subtitle1);

    subtitle2Vtt = convertSrtToVtt(subtitle2);

    // Upload video

    await s3Client.send(
      new PutObjectCommand({

        Bucket: process.env.R2_BUCKET_NAME,

        Key: r2Key,

        Body: fs.createReadStream(outputVideoPath),

        ContentType: 'video/mp4'

      })
    );

    console.log('R2 Video Upload Complete.');

    // ==========================================
    // UPLOAD SINHALA SUBTITLE
    // ==========================================

    if (subtitle1Vtt && fs.existsSync(subtitle1Vtt)) {

      await s3Client.send(
        new PutObjectCommand({

          Bucket: process.env.R2_BUCKET_NAME,

          Key: `subtitles/${permanentId}_sin.vtt`,

          Body: fs.createReadStream(subtitle1Vtt),

          ContentType: 'text/vtt'

        })
      );

      console.log('Sinhala Subtitle Uploaded.');

    }

    // ==========================================
    // UPLOAD ENGLISH SUBTITLE
    // ==========================================

    if (subtitle2Vtt && fs.existsSync(subtitle2Vtt)) {

      await s3Client.send(
        new PutObjectCommand({

          Bucket: process.env.R2_BUCKET_NAME,

          Key: `subtitles/${permanentId}_eng.vtt`,

          Body: fs.createReadStream(subtitle2Vtt),

          ContentType: 'text/vtt'

        })
      );

      console.log('English Subtitle Uploaded.');

    }

    // ==========================================
    // 6. TELEGRAM UPLOAD
    // ==========================================

    if (fileSizeGB < 1.95) {

      updateStatus('Uploading to Telegram...', 90);

      console.log('[5/5] Uploading to Telegram...');

      // Generate thumbnail

      try {

        execFileSync('ffmpeg', [
          '-y',
          '-ss', '00:00:05',
          '-i', outputVideoPath,
          '-vframes', '1',
          '-vf', 'scale=320:-2',
          '-q:v', '5',
          thumbPath
        ]);

      } catch (e) {

        console.log('Thumbnail generation failed.');

      }

      const form = new FormData();

      form.append(
        'chat_id',
        process.env.TG_CHAT_ID
      );

      form.append(
        'video',
        fs.createReadStream(outputVideoPath)
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
          Math.round(duration).toString()
        );

      }

      try {

        const tgRes = await axios.post(
          `http://localhost:8081/bot${process.env.TG_BOT_TOKEN}/sendVideo`,
          form,
          {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        );

        telegramFileId = tgRes.data.result.video.file_id;

        console.log('Telegram Upload Complete.');

      } catch (e) {

        console.log(
          'Telegram Upload Failed: ' +
          (e.response?.data?.description || e.message)
        );

      }

    } else {

      console.log(
        'Telegram upload skipped: File exceeds size limit.'
      );

    }

    // ==========================================
    // 7. DATABASE SYNC
    // ==========================================

    updateStatus('Syncing Database...', 95);

    await axios.post(

      `${process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev'}/api/vps/sync`,

      {
        uuid: permanentId,

        title: title,

        r2_key: r2Key,

        telegram_file_id: telegramFileId,

        source_type: 'r2'
      },

      {
        headers: {
          'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}`
        }
      }

    );

    console.log('Database Sync Complete.');

    // ==========================================
    // 8. COMPLETED
    // ==========================================

    updateStatus('Completed!', 100);

    console.log(`[Job Completed] ${title}`);

  } catch (err) {

    // ==========================================
    // ERROR HANDLING
    // ==========================================

    console.error(`[Job Failed] ${err.message}`);

    updateStatus(
      'Failed: ' + err.message,
      100
    );

  } finally {

    // ==========================================
    // 9. CLEANUP TEMPORARY FILES
    // ==========================================

    console.log('Cleaning temporary files...');

    const cleanupFiles = [
      rawVideoPath,
      outputVideoPath,
      thumbPath,
      subtitle1,
      subtitle2
    ];

    if (
      subtitle1 &&
      subtitle1Vtt &&
      subtitle1 !== subtitle1Vtt
    ) {
      cleanupFiles.push(subtitle1Vtt);
    }

    if (
      subtitle2 &&
      subtitle2Vtt &&
      subtitle2 !== subtitle2Vtt
    ) {
      cleanupFiles.push(subtitle2Vtt);
    }

    for (const file of cleanupFiles) {

      if (file && fs.existsSync(file)) {

        try {

          fs.unlinkSync(file);

        } catch (e) {

          console.error(
            `Cleanup failed: ${file}`,
            e.message
          );

        }

      }

    }

    console.log('Temporary file cleanup completed.');

  }

}

// ==========================================
// EXPORT
// ==========================================

module.exports = {
  processVideo,
  convertSrtToVtt
};