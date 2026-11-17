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

async function processVideo(jobData) {
  const { title, url, subtitle1, subtitle2, updateStatus } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, `raw_${Date.now()}.mp4`);
  const outputVideoPath = path.join(tempDir, `out_${Date.now()}.mp4`);

  try {
    // 1. Download
    updateStatus('Downloading video...', 10);
    const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));

    // 2. FFprobe Check
    updateStatus('Checking codec...', 25);
    let isX264 = false;
    try {
      const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawVideoPath}"`).toString().trim();
      isX264 = (probe === 'h264');
    } catch (e) { console.log('ffprobe failed, forcing convert.'); }

    // 3. FFmpeg Process
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    
    if (subtitle1) ffmpegCmd += `-i "${subtitle1}" `;
    if (subtitle2) ffmpegCmd += `-i "${subtitle2}" `;

    // Video & Audio mapping
    ffmpegCmd += `-map 0:v -map 0:a `;
    if (subtitle1) ffmpegCmd += `-map 1:0 `;
    if (subtitle2) ffmpegCmd += `-map 2:0 `;

    if (isX264) {
      updateStatus('Fast Processing (Copying video)...', 40);
      ffmpegCmd += `-c:v copy -c:a copy `;
    } else {
      updateStatus('Transcoding to x264 (Slow)...', 40);
      ffmpegCmd += `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k `;
    }

    // Subtitle Encoding & Metadata
    if (subtitle1) {
      ffmpegCmd += `-c:s mov_text -metadata:s:s:0 language=sin -metadata:s:s:0 title="Sinhala" -disposition:s:0 default `;
    }
    if (subtitle2) {
      const subIndex = subtitle1 ? 1 : 0;
      ffmpegCmd += `-c:s mov_text -metadata:s:s:${subIndex} language=eng -metadata:s:s:${subIndex} title="English" `;
    }
    
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 100, timeout: 7200000 }, (error) => error ? reject(error) : resolve());
    });

    // 4. Upload
    updateStatus('Uploading to R2...', 60);
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;
    const fileSize = fs.statSync(outputVideoPath).size;
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);

    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fileStream, ContentType: 'video/mp4'
    }));

    // 5. Telegram (with 2GB Check)
    let telegramFileId = null;
    if (fileSizeGB < 1.95) { // 2GB is approx 2.14GB, keeping safe margin
      updateStatus('Uploading to Telegram...', 80);
      const form = new FormData();
      form.append('chat_id', process.env.TG_CHAT_ID);
      form.append('video', fs.createReadStream(outputVideoPath));
      form.append('caption', `🎬 ${title}\nID: ${permanentId}`);
      try {
        const tgRes = await axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
          headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity
        });
        telegramFileId = tgRes.data.result.video.file_id;
      } catch (e) { console.log('TG Upload Failed: ' + e.message); }
    } else {
      updateStatus('Skipping Telegram (Over 2GB limit)...', 80);
    }

    // 6. Sync DB
    updateStatus('Syncing Database...', 90);
    await axios.post(`https://tipiz.moviezonee.workers.dev/api/vps/sync`, {
      uuid: permanentId, title: title, r2_key: r2Key, telegram_file_id: telegramFileId, source_type: 'r2'
    }, { headers: { 'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}` } });

    updateStatus('Completed!', 100);
    
    // Cleanup
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (subtitle1) fs.unlinkSync(subtitle1);
    if (subtitle2) fs.unlinkSync(subtitle2);

  } catch (err) {
    updateStatus('Failed: ' + err.message, 100);
    // Cleanup on error
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
  }
}

module.exports = { processVideo };