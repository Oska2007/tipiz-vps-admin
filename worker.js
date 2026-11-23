const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const FormData = require('form-data');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

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
  let srt = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  srt = srt.replace(/\r\n?/g, '\n').trim();

  const cues = srt.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(line));
    if (timingIndex === -1) return null;

    const parts = lines[timingIndex].split(/\s+-->\s+/);
    if (parts.length !== 2) return null;

    const normalizeTime = (value) => value
      .trim()
      .replace(',', '.')
      .replace(/(\d{2}:\d{2}:\d{2}\.\d{1,2})(?!\d)/, (match) => match.padEnd(12, '0'));

    const timingParts = parts[1].split(/\s+/);
    const timing = `${normalizeTime(parts[0])} --> ${normalizeTime(timingParts[0])}${timingParts.length > 1 ? ' ' + timingParts.slice(1).join(' ') : ''}`;

    const text = escapeVttText(lines.slice(timingIndex + 1).join('\n').trim());
    return `${timing}\n${text}`;
  }).filter(Boolean);

  fs.writeFileSync(vttPath, `WEBVTT\n\n${cues.join('\n\n')}\n`, 'utf8');
  return vttPath;
}

async function processVideo(jobData) {
  const { title, url, subtitle1, subtitle2, updateStatus } = jobData;
  const tempDir = path.join(__dirname, 'temp');

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, `raw_${Date.now()}.mp4`);
  const outputVideoPath = path.join(tempDir, `out_${Date.now()}.mp4`);

  try {
    // 1. Download
    console.log(`\n[Job Started] ${title}`);
    updateStatus('Downloading video...', 10);
    console.log(`[1/5] Downloading video from: ${url}`);

    const response = await axios({
      url, method: 'GET', responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));
    console.log(`✅ Video downloaded.`);

    // 2. FFprobe Check
    updateStatus('Checking codec...', 25);
    let isX264 = false;
    try {
      const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawVideoPath}"`).toString().trim();
      isX264 = (probe === 'h264');
    } catch (e) { console.log('ffprobe failed, forcing convert.'); }

    // 3. FFmpeg Process (Subtitles Embed කරන්නේ නෑ - External .vtt විදිහට යවන නිසා)
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;

    if (isX264) {
      updateStatus('Fast Processing (Copying video)...', 40);
      console.log(`[3/5] Processing (Fast Copy mode)...`);
      ffmpegCmd += `-c:v copy -c:a copy `;
    } else {
      updateStatus('Transcoding to x264 (Slow)...', 40);
      console.log(`[3/5] Transcoding to x264 (Slow mode)...`);
      ffmpegCmd += `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k `;
    }

    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 100, timeout: 7200000 }, (error) => error ? reject(error) : resolve());
    });
    console.log(`✅ FFmpeg Processed.`);

    // 4. Upload to R2 (Video + Subtitles)
    updateStatus('Uploading to R2...', 60);
    console.log(`[4/5] Uploading to Cloudflare R2...`);
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;
    const fileSize = fs.statSync(outputVideoPath).size;
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);
    const subtitle1Vtt = convertSrtToVtt(subtitle1);
    const subtitle2Vtt = convertSrtToVtt(subtitle2);

    // Video Upload
    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: 'video/mp4'
    }));

    // Subtitle Uploads (R2)
    if (subtitle1Vtt && fs.existsSync(subtitle1Vtt)) {
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `subtitles/${permanentId}_sin.vtt`,
        Body: fs.createReadStream(subtitle1Vtt),
        ContentType: 'text/vtt'
      }));
      console.log(`✅ Sinhala subtitle converted${subtitle1Vtt !== subtitle1 ? ' to VTT' : ''} and uploaded to R2.`);
    }

    if (subtitle2Vtt && fs.existsSync(subtitle2Vtt)) {
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `subtitles/${permanentId}_eng.vtt`,
        Body: fs.createReadStream(subtitle2Vtt),
        ContentType: 'text/vtt'
      }));
      console.log(`✅ English subtitle converted${subtitle2Vtt !== subtitle2 ? ' to VTT' : ''} and uploaded to R2.`);
    }

    console.log(`✅ R2 Upload Complete!`);

    // 5. Telegram Upload
    let telegramFileId = null;
    if (fileSizeGB < 1.95) {
      updateStatus('Uploading to Telegram...', 80);
      console.log(`[5/5] Uploading to Telegram...`);

      const thumbPath = path.join(tempDir, `thumb_${Date.now()}.jpg`);
      await new Promise((resolve) => {
        exec(`ffmpeg -y -ss 00:00:05 -i "${outputVideoPath}" -vframes 1 -vf "scale=320:-2" -q:v 5 "${thumbPath}"`, (err) => resolve());
      });

      let duration = 0;
      try {
        const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputVideoPath}"`).toString().trim();
        duration = Math.round(parseFloat(durationStr));
      } catch (e) { }

      const form = new FormData();
      form.append('chat_id', process.env.TG_CHAT_ID);
      form.append('video', fs.createReadStream(outputVideoPath));
      form.append('caption', `🎬 ${title}\nID: ${permanentId}`);
      form.append('supports_streaming', 'true');

      if (fs.existsSync(thumbPath)) form.append('thumbnail', fs.createReadStream(thumbPath));
      if (duration > 0) form.append('duration', duration.toString());

      try {
        const tgRes = await axios.post(`http://localhost:8081/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
          headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity
        });
        telegramFileId = tgRes.data.result.video.file_id;
        console.log(`✅ Telegram Upload Complete!`);
      } catch (e) {
        console.log(`❌ TG Upload Failed: ` + (e.response?.data?.description || e.message));
      } finally {
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      }
    } else {
      updateStatus('Skipping Telegram (Over 2GB limit)...', 80);
    }

    // 6. Sync DB
    updateStatus('Syncing Database...', 90);
    await axios.post(`${process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev'}/api/vps/sync`, {
      uuid: permanentId, title: title, r2_key: r2Key, telegram_file_id: telegramFileId, source_type: 'r2'
    }, { headers: { 'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}` } });
    console.log(`✅ Database Sync Complete!`);

    updateStatus('Completed!', 100);

    // Cleanup
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (subtitle1 && fs.existsSync(subtitle1)) fs.unlinkSync(subtitle1);
    if (subtitle2 && fs.existsSync(subtitle2)) fs.unlinkSync(subtitle2);
    if (subtitle1 && subtitle1 !== subtitle1Vtt && fs.existsSync(subtitle1Vtt)) fs.unlinkSync(subtitle1Vtt);
    if (subtitle2 && subtitle2 !== subtitle2Vtt && fs.existsSync(subtitle2Vtt)) fs.unlinkSync(subtitle2Vtt);

  } catch (err) {
    updateStatus('Failed: ' + err.message, 100);
    console.log(`❌ Job Failed: ${err.message}`);
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (subtitle1 && fs.existsSync(`${subtitle1}.vtt`)) fs.unlinkSync(`${subtitle1}.vtt`);
    if (subtitle2 && fs.existsSync(`${subtitle2}.vtt`)) fs.unlinkSync(`${subtitle2}.vtt`);
  }
}

module.exports = { processVideo, convertSrtToVtt };