require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const FormData = require('form-data');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);

function requireEnvironment(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
}

function srtToVtt(content) {
  let text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (/^WEBVTT\b/i.test(text)) return text;

  text = text
    .replace(/(\d{2}:\d{2}:\d{2})[,.](\d{3})/g, '$1.$2')
    .replace(/^\d+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return `WEBVTT\n\n${text}\n`;
}

function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function uploadSubtitle(s3Client, bucket, permanentId, subtitlePath, originalName, language) {
  if (!subtitlePath) return null;
  if (!fs.existsSync(subtitlePath)) throw new Error(`${language} subtitle temporary file not found`);

  const key = `subtitles/${permanentId}_${language}.vtt`;
  let content = fs.readFileSync(subtitlePath, 'utf8').replace(/^\uFEFF/, '');

  if (/\.srt$/i.test(originalName || '') || !/^WEBVTT\b/i.test(content.trim())) {
    content = srtToVtt(content);
  }

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(content, 'utf8'),
    ContentType: 'text/vtt',
    CacheControl: 'public, max-age=31536000'
  }));

  console.log(`[Subtitle] Uploaded ${language}: ${key}`);
  return key;
}

async function processVideo(jobData) {
  const {
    id,
    title,
    url,
    subtitle1,
    subtitle1Name,
    subtitle2,
    subtitle2Name,
    updateStatus
  } = jobData;

  const tempDir = path.join(__dirname, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const token = `${id || uuidv4()}-${Date.now()}`;
  const rawVideoPath = path.join(tempDir, `raw-${token}.mp4`);
  const outputVideoPath = path.join(tempDir, `out-${token}.mp4`);
  const thumbPath = path.join(tempDir, `thumb-${token}.jpg`);

  let telegramFileId = null;
  let permanentId = null;

  try {
    requireEnvironment('R2_ACCESS_KEY_ID');
    requireEnvironment('R2_SECRET_ACCESS_KEY');
    requireEnvironment('R2_ENDPOINT');
    requireEnvironment('R2_BUCKET_NAME');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });

    permanentId = uuidv4();

    console.log(`\n[Job Started] ${title}`);
    updateStatus('Downloading video', 10);
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));
    console.log('[1/5] Video downloaded');

    updateStatus('Checking video codec', 25);
    let h264 = false;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        rawVideoPath
      ], { timeout: 120000 });
      h264 = stdout.trim() === 'h264';
    } catch (error) {
      console.warn(`[FFprobe] ${error.message}`);
    }

    updateStatus(h264 ? 'Fast processing' : 'Transcoding video', 40);
    const ffmpegArgs = [
      '-y', '-i', rawVideoPath,
      ...(h264
        ? ['-c:v', 'copy', '-c:a', 'copy']
        : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k']),
      '-movflags', '+faststart',
      outputVideoPath
    ];
    await execFileAsync('ffmpeg', ffmpegArgs, {
      timeout: 7200000,
      maxBuffer: 100 * 1024 * 1024
    });
    console.log('[3/5] FFmpeg processing complete');

    updateStatus('Uploading video and subtitles to R2', 60);
    const r2Key = `videos/${permanentId}.mp4`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fs.createReadStream(outputVideoPath),
      ContentType: 'video/mp4',
      CacheControl: 'public, max-age=31536000'
    }));
    console.log(`[R2] Uploaded video: ${r2Key}`);

    const subtitle1Key = await uploadSubtitle(
      s3Client,
      process.env.R2_BUCKET_NAME,
      permanentId,
      subtitle1,
      subtitle1Name,
      'sin'
    );
    const subtitle2Key = await uploadSubtitle(
      s3Client,
      process.env.R2_BUCKET_NAME,
      permanentId,
      subtitle2,
      subtitle2Name,
      'eng'
    );

    const fileSize = fs.statSync(outputVideoPath).size;
    if (fileSize / (1024 * 1024 * 1024) < 1.95) {
      updateStatus('Uploading to Telegram', 80);
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-ss', '00:00:05', '-i', outputVideoPath,
          '-vframes', '1', '-vf', 'scale=320:-2', '-q:v', '5', thumbPath
        ], { timeout: 120000 });

        let duration = 0;
        try {
          const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            outputVideoPath
          ], { timeout: 120000 });
          duration = Math.round(parseFloat(stdout.trim()) || 0);
        } catch (_error) {}

        const form = new FormData();
        form.append('chat_id', requireEnvironment('TG_CHAT_ID'));
        form.append('video', fs.createReadStream(outputVideoPath));
        form.append('caption', `🎬 ${title}\nID: ${permanentId}`);
        form.append('supports_streaming', 'true');
        if (fs.existsSync(thumbPath)) form.append('thumbnail', fs.createReadStream(thumbPath));
        if (duration > 0) form.append('duration', String(duration));

        const telegramResponse = await axios.post(
          `http://localhost:8081/bot${requireEnvironment('TG_BOT_TOKEN')}/sendVideo`,
          form,
          { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 30 * 60 * 1000 }
        );
        telegramFileId = telegramResponse.data?.result?.video?.file_id || null;
        console.log('[5/5] Telegram upload complete');
      } catch (error) {
        console.warn(`[Telegram] ${error.response?.data?.description || error.message}`);
      }
    } else {
      updateStatus('Skipping Telegram because file exceeds 2 GB', 80);
    }

    updateStatus('Syncing database', 90);
    const baseUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const cfApiUrl = (process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev').replace(/\/$/, '');
    const syncPayload = {
      uuid: permanentId,
      title,
      r2_key: r2Key,
      subtitle1_key: subtitle1Key,
      subtitle2_key: subtitle2Key,
      subtitle1_url: subtitle1Key && baseUrl ? `${baseUrl}/${subtitle1Key}` : null,
      subtitle2_url: subtitle2Key && baseUrl ? `${baseUrl}/${subtitle2Key}` : null,
      sin_subtitle_key: subtitle1Key,
      eng_subtitle_key: subtitle2Key,
      telegram_file_id: telegramFileId,
      source_type: 'r2'
    };
    const syncResponse = await axios.post(`${cfApiUrl}/api/vps/sync`, syncPayload, {
      headers: { Authorization: `Bearer ${requireEnvironment('CF_VPS_API_KEY')}` },
      timeout: 120000
    });
    console.log(`[Database] Sync complete: ${JSON.stringify(syncResponse.data)}`);

    updateStatus('Completed', 100);
    return {
      uuid: permanentId,
      r2Key,
      subtitle1Key,
      subtitle2Key,
      telegramFileId
    };
  } catch (error) {
    const message = error.response?.data?.description ||
      error.response?.data?.error ||
      error.message ||
      'Unknown processing error';
    console.error(`[Job Failed] ${title}: ${message}`);
    throw new Error(message);
  } finally {
    cleanupFile(rawVideoPath);
    cleanupFile(outputVideoPath);
    cleanupFile(thumbPath);
    cleanupFile(subtitle1);
    cleanupFile(subtitle2);
  }
}

module.exports = { processVideo };
