const { exec } = require('child_process');
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
  const { title, url, subtitleUrl } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, 'raw_video.mp4');
  const outputVideoPath = path.join(tempDir, 'output_x264.mp4');
  const subtitlePath = path.join(tempDir, 'subtitle.vtt');

  console.log(`\n[Job Started] ${title}`);

  try {
    // 1. Download Video
    console.log(`[1/4] Downloading video from: ${url}`);
    const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
    await pipeline(response.data, fs.createWriteStream(rawVideoPath));
    console.log(`✅ Video downloaded.`);

    // 2. Download Subtitle
    let hasSubtitle = false;
    if (subtitleUrl) {
      console.log(`[2/4] Downloading subtitle...`);
      try {
        const subRes = await axios({ url: subtitleUrl, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
        await pipeline(subRes.data, fs.createWriteStream(subtitlePath));
        hasSubtitle = true;
      } catch (e) { console.log(`⚠️ Subtitle failed.`); }
    }

    // 3. FFmpeg Process
    console.log(`[3/4] Processing with FFmpeg...`);
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    if (hasSubtitle) ffmpegCmd += `-i "${subtitlePath}" -c:v copy -c:a copy -c:s mov_text `;
    else ffmpegCmd += `-c:v copy -c:a copy `;
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => error ? reject(error) : resolve());
    });
    console.log(`✅ FFmpeg Processed.`);

    // 4. Upload & Sync
    console.log(`[4/4] Uploading...`);
    const permanentId = uuidv4();
    const r2Key = `videos/${permanentId}.mp4`;
    let telegramFileId = null;

    // 4.1 R2 Upload
    console.log(`☁️ Uploading to Cloudflare R2...`);
    const fileStream = fs.createReadStream(outputVideoPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: 'video/mp4'
    }));
    console.log(`✅ R2 Upload Complete!`);

    // 4.2 Telegram Upload
    console.log(`✈️ Uploading to Telegram...`);
    const form = new FormData();
    form.append('chat_id', process.env.TG_CHAT_ID);
    form.append('video', fs.createReadStream(outputVideoPath));
    form.append('caption', `🎬 ${title}\nID: ${permanentId}`);

    try {
      const tgRes = await axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendVideo`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      telegramFileId = tgRes.data.result.video.file_id; // Telegram File ID එක ගන්නවා
      console.log(`✅ Telegram Upload Complete!`);
    } catch (tgErr) {
      console.log(`❌ Telegram Upload Failed: ${tgErr.message}`);
    }

    // 4.3 Cloudflare Database එකට Sync කිරීම
    console.log(`🔄 Syncing with Cloudflare Database...`);
    try {
      await axios.post(`https://tipiz.moviezonee.workers.dev/api/vps/sync`, {
        uuid: permanentId,
        title: title,
        r2_key: r2Key,
        telegram_file_id: telegramFileId,
        source_type: 'r2'
      }, {
        headers: { 'Authorization': `Bearer ${process.env.CF_VPS_API_KEY}` }
      });
      console.log(`✅ Database Sync Complete!`);
    } catch (syncErr) {
      console.error(`❌ Database Sync Failed:`, syncErr.response?.data || syncErr.message);
    }

    console.log(`✅ [DONE] Video ready! Permanent ID: ${permanentId}`);
    
    // Cleanup
    if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    if (hasSubtitle && fs.existsSync(subtitlePath)) fs.unlinkSync(subtitlePath);

  } catch (err) {
    console.error(`Job Failed: ${err.message}`);
  }
}