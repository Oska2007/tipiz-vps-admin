const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises'); // මේක තමයි අලුතින් එකතු කළේ

async function processVideo(jobData) {
  const { title, url, subtitleUrl } = jobData;
  const tempDir = path.join(__dirname, 'temp');
  
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const rawVideoPath = path.join(tempDir, 'raw_video.mp4');
  const outputVideoPath = path.join(tempDir, 'output_x264.mp4');
  const subtitlePath = path.join(tempDir, 'subtitle.vtt');

  console.log(`[Job Started] ${title}`);

  try {
    // 1. Video එක ඩවුන්ලෝඩ් කිරීම
    console.log(`[1/4] Downloading video from: ${url}`);
    const response = await axios({ 
      url, 
      method: 'GET', 
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const writer = fs.createWriteStream(rawVideoPath);
    // pipeline එකෙන් ෆයිල් එක 100%ක් සේව් වෙනකම් ඉන්නවා
    await pipeline(response.data, writer);
    
    const stats = fs.statSync(rawVideoPath);
    if (stats.size === 0) throw new Error("Downloaded file is empty (0 bytes)");
    console.log(`✅ Video downloaded successfully. Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 2. Subtitle එක ඩවුන්ලෝඩ් කිරීම
    let hasSubtitle = false;
    if (subtitleUrl) {
      console.log(`[2/4] Downloading subtitle...`);
      try {
        const subRes = await axios({ 
          url: subtitleUrl, 
          method: 'GET', 
          responseType: 'stream',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const subWriter = fs.createWriteStream(subtitlePath);
        await pipeline(subRes.data, subWriter);
        hasSubtitle = true;
        console.log(`✅ Subtitle downloaded successfully.`);
      } catch (subErr) {
        console.log(`⚠️ Subtitle download failed (${subErr.response?.status}). Continuing without subtitle...`);
        hasSubtitle = false;
      }
    }

    // 3. FFmpeg හරහා Process කිරීම
    console.log(`[3/4] Processing with FFmpeg... (This may take a while)`);
    
    let ffmpegCmd = `ffmpeg -y -i "${rawVideoPath}" `;
    
    if (hasSubtitle) {
      ffmpegCmd += `-i "${subtitlePath}" -c:v copy -c:a copy -c:s mov_text `;
    } else {
      ffmpegCmd += `-c:v copy -c:a copy `;
    }
    
    ffmpegCmd += `-movflags +faststart "${outputVideoPath}"`;

    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg Error: ${error.message}`);
        return;
      }
      console.log(`[4/4] ✅ Video Processed Successfully! Ready for Upload.`);
      
      // ටෙස්ට් කරද්දී ෆයිල් එක මකන්නේ නෑ (බලන්න පුළුවන් වෙන්න)
      // fs.unlinkSync(rawVideoPath);
    });

  } catch (err) {
    console.error(`Job Failed: ${err.message}`);
  }
}

module.exports = { processVideo };