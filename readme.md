# TIPIZ VPS Admin — Video + Local AI Subtitle Build

This build keeps the existing TIPIZ admin workflow and adds local AI subtitle generation, strict subtitle validation, verified R2 subtitle uploads, and queue controls.

## What changed

- Downloaded videos are still converted/remuxed to H.264/AAC MP4 using the existing CRF 23 / `fast` defaults.
- While the video FFmpeg conversion is running, the worker starts audio extraction when English subtitles are missing. As soon as the audio file is ready, Faster-Whisper starts generating timestamped English subtitles while MP4 conversion continues.
- If English subtitles already exist but Sinhala is missing, the English subtitle is translated locally to Sinhala without audio transcription.
- If both tracks are missing, local Whisper creates English cues and the local HPLT model translates those cues to Sinhala.
- If only Sinhala is supplied, Whisper generates the missing English track. Existing valid uploaded subtitles are not overwritten.
- No translation API key or paid cloud translation API is used. Model files are downloaded once to `models/` and inference runs on the VPS.
- Empty VTT files, header-only VTT files, invalid timestamps, and cue blocks without subtitle text are rejected before R2 upload.
- R2 subtitle files are uploaded only after local validation. A `HeadObject` size check verifies uploads when the R2 key has read permission; write-only R2 credentials are allowed but will log that remote HEAD verification was skipped.
- Queue jobs can be deleted, running jobs can be cancelled, failed jobs can be retried, and queued/history lists can be cleared.
- Cancelled FFmpeg/Python/network subprocesses are stopped. A PM2 restart requeues an interrupted job instead of losing it.
- Generated audio and generated subtitle temp files are cleaned. Uploaded subtitle temp files are retained for failed-job retry and deleted after success, cancellation, or manual deletion.

## Subtitle decision table

| Uploaded Sinhala | Uploaded English | Result |
|---|---|---|
| Valid | Valid | Use both uploaded tracks; no AI needed |
| Missing/invalid | Valid | Keep English and locally translate Sinhala |
| Valid | Missing/invalid | Keep Sinhala and locally generate English from audio |
| Missing/invalid | Missing/invalid | Generate English from audio and translate it to Sinhala |

A subtitle track that is invalid is treated as missing. If the source video has no audio stream, speech recognition cannot generate a missing track; valid uploaded tracks can still be uploaded and the job continues with an AI warning.

## Models and limitations

- Speech recognition: Faster-Whisper `small`, CPU INT8 by default.
- English → Sinhala: `HPLT/translate-en-si-v2.0-hplt_opus`, converted locally to a CTranslate2 INT8 model.
- The HPLT model is published under CC-BY-4.0. Retain attribution to HPLT when redistributing or using the model.
- Accuracy is not guaranteed at 90% or above for every movie. Audio clarity, accents, background music, overlapping speech, names, slang, and subtitle context affect the result. Test a few episodes and review sample output before enabling fully automatic publication on the public site.
- This is an offline runtime pipeline after the initial model download. The one-time model download requires internet access, but no paid API token.

## Recommended VPS

Recommended starting point: 4 vCPU and 8 GB RAM. The default Whisper `small` model and HPLT translator use CPU INT8 / low thread counts to reduce memory and CPU contention. A 2 GB VPS is not recommended: changing `WHISPER_MODEL=base` or `tiny` reduces Whisper memory only; HPLT model conversion/translation can still run out of RAM. Keep at least 3 GB of free disk space during first model setup because source and converted model files coexist in the cache.

---

# Updating an existing TIPIZ VPS Admin installation

> Do not overwrite your `.env`, `data/queue.json`, `temp/`, `.venv/`, or `models/`. The update commands below deliberately preserve them.

## 1. Back up current project files

Run on your VPS:

```bash
cd ~/tipiz-vps-admin
mkdir -p ~/tipiz-admin-backup-$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=$(ls -dt ~/tipiz-admin-backup-* | head -n 1)
cp -a server.js worker.js public readme.md package.json package-lock.json "$BACKUP_DIR"/
echo "Backup saved to: $BACKUP_DIR"
```

## 2. Copy the update ZIP to the VPS

First install the small archive/copy utilities if they are missing, then upload `tipiz-vps-admin-ai-update.zip` to your VPS home directory using SCP, WinSCP, or your provider's file uploader. Then run:

```bash
sudo apt update
sudo apt install -y unzip rsync
cd ~
rm -rf ~/tipiz-admin-update
mkdir -p ~/tipiz-admin-update
unzip -o ~/tipiz-vps-admin-ai-update.zip -d ~/tipiz-admin-update

rsync -av \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='.venv/' \
  --exclude='models/' \
  --exclude='data/' \
  --exclude='temp/' \
  ~/tipiz-admin-update/tipiz-vps-admin-main/ \
  ~/tipiz-vps-admin/
```

If the ZIP was given a different name, change only the ZIP filename in the `unzip` command.

## 3. Install/update Node dependencies

```bash
cd ~/tipiz-vps-admin
npm install
```

## 4. Install local AI dependencies and download models

```bash
sudo apt update
sudo apt install -y python3 python3-venv ffmpeg
cd ~/tipiz-vps-admin
chmod +x install-ai.sh
./install-ai.sh
```

The setup downloads the Faster-Whisper model and HPLT English-to-Sinhala model, then converts HPLT to CPU INT8. This step needs internet access and may take time. It is a one-time setup unless you delete `models/`.

## 5. Add AI settings to your existing `.env`

Do not replace your current `.env` because it contains your login, R2, Cloudflare, and Telegram secrets. Open it:

```bash
cd ~/tipiz-vps-admin
nano .env
```

Add these lines if they are not already present:

```ini
AI_SUBTITLES_ENABLED=true
WHISPER_MODEL=small
WHISPER_COMPUTE_TYPE=int8
WHISPER_CPU_THREADS=1
WHISPER_BEAM_SIZE=5
TRANSLATION_REPO=HPLT/translate-en-si-v2.0-hplt_opus
TRANSLATION_CPU_THREADS=1
TRANSLATION_NUM_BEAMS=4
TRANSLATION_BATCH_SIZE=4
TRANSLATION_MAX_DECODING_LENGTH=256
X264_PRESET=fast
X264_CRF=23
VIDEO_THREADS=1
```

Save with `Ctrl+O`, Enter, then `Ctrl+X`.

## 6. Restart PM2

```bash
cd ~/tipiz-vps-admin
sudo pm2 restart tipiz-admin --update-env
sudo pm2 save
```

## 7. Verify installation

```bash
cd ~/tipiz-vps-admin
.venv/bin/python -c "import faster_whisper, ctranslate2, sentencepiece; print('AI libraries OK')"
node --check server.js
node --check worker.js
sudo pm2 logs tipiz-admin --lines 80
```

The startup log should include:

```text
TIPIZ VPS Admin listening on port 3000
Automatic local AI subtitles: ON
```

## Queue controls in the admin page

- `Delete from queue`: removes a waiting job and its uploaded temp subtitle files.
- `Cancel job`: terminates the active FFmpeg, AI, and network processes.
- `Retry`: requeues a failed job. Existing uploaded subtitle files are reused when available; missing tracks can be generated by AI.
- `Remove from history`: deletes a completed/failed/cancelled queue record.
- `Delete all queued jobs`: clears all waiting jobs.
- `Clear completed / failed / cancelled history`: clears terminal queue records without touching active jobs. It does not delete the associated video/subtitle objects already stored in R2.

## Useful commands

```bash
# Admin logs
sudo pm2 logs tipiz-admin

# Restart after .env/code changes
sudo pm2 restart tipiz-admin --update-env

# Current CPU/RAM state
htop
free -h
mpstat -P ALL 1 5

# Disk usage
 df -h
 du -sh models .venv temp data 2>/dev/null

# Check services
sudo pm2 status
ss -lntp | grep 3000

# Check the local AI Python environment
.venv/bin/python subtitle_ai.py --help
```

## Troubleshooting

**AI subtitle warning: Python executable not found**

Run `./install-ai.sh` and restart PM2. The Node worker automatically selects `.venv/bin/python` when it exists.

**Model download/conversion fails**

Check internet connectivity, free disk space (`df -h`), and the PM2/server logs. Run `./install-ai.sh` again; already downloaded model files are cached.

**AI takes too much CPU**

Keep `WHISPER_CPU_THREADS=1` and `TRANSLATION_CPU_THREADS=1`. On a small VPS use `WHISPER_MODEL=base` or `tiny`; then run the download command again with that environment setting or restart the install script after exporting it.

**VTT is skipped**

The validator requires at least one well-formed timestamped cue with non-empty text. A `WEBVTT` header alone is not a subtitle. This prevents empty VTT objects being uploaded to R2.

**R2 HEAD verification warning**

A successful PUT is retained. The warning means the R2 token may not have object-read permission for HEAD checks. Grant object read permission to the R2 token if you want remote size verification; local VTT validation still blocks empty files.

**Temporarily disable AI**

Set `AI_SUBTITLES_ENABLED=false` in `.env`, then run `sudo pm2 restart tipiz-admin --update-env`. Uploaded valid subtitle files will still be converted and uploaded.
