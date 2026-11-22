# TIPIZ VPS Admin Panel - Complete Setup Guide

This document contains the complete, step-by-step instructions and all necessary terminal commands to deploy the TIPIZ VPS Admin Panel on a fresh Ubuntu VPS.

This system handles downloading direct video links, converting them to x264 (if needed), embedding dual subtitles, uploading to Cloudflare R2, and sending to Telegram (supporting files up to 2GB via a Local Bot API Server).

---

## Step 1: System Update & Install Dependencies

First, update your VPS and install the required system packages (Node.js, FFmpeg, Git, PM2, and Docker).

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js v20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# 3. Install FFmpeg (for video processing), Git, and Docker
sudo apt install -y ffmpeg git docker.io

# 4. Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker

# 5. Install PM2 globally (Process Manager)
sudo npm install -g pm2

```

## Step 2: Clone the Project & Install Node Modules

Clone your GitHub repository and install all required Node.js packages.

```bash
# Clone the repository (replace with your actual repo URL if different)
git clone https://github.com/Oska2007/tipiz-vps-admin.git

# Go into the project folder
cd tipiz-vps-admin

# Install Node.js dependencies
npm install

```

## Step 3: Configure Environment Variables (.env)

Create the .env file to store your secret keys and configurations.

```bash
nano .env

```

Copy the template below, replace the placeholder values with your actual credentials, and paste it into the editor. Then save (Ctrl + O, Enter) and exit (Ctrl + X).

```ini
PORT=3000

# Cloudflare API
CF_API_URL=https://tipiz.moviezonee.workers.dev
CF_VPS_API_KEY=your_cloudflare_vps_api_key_here

# Admin Login (Choose your own)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password_here
SESSION_SECRET=any_random_secret_string_here

# Cloudflare R2 Settings
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_ENDPOINT=https://xxxxx.r2.cloudflarestorage.com
R2_BUCKET_NAME=tipiz-media

# Telegram Settings
TG_BOT_TOKEN=your_telegram_bot_token
TG_CHAT_ID=-100xxxxxxxxxxx

# Telegram Local API Settings (Get these from my.telegram.org)
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash

```

## Step 4: Start the Local Telegram Bot API Server (Docker)

Run the Docker container using the credentials from your .env file. This step is crucial for uploading files larger than 50MB to Telegram.

```bash
# Ensure you are inside the tipiz-vps-admin folder
sudo docker run -d -p 8081:8081 --name telegram-bot-api --env-file .env -e TELEGRAM_LOCAL=1 aiogram/telegram-bot-api:latest
# Verify it is running
sudo docker ps

```

## Step 5: Start the Admin Panel (PM2)

Start the Node.js server using PM2 and configure it to auto-start on VPS reboot.

```bash
sudo pm2 start server.js --name "tipiz-admin"
sudo pm2 save
sudo pm2 startup

```

## Step 6: Open Firewall Ports

You must open Port 3000 to access the panel via browser.

```bash
sudo ufw allow 3000

```

# 🛠️ Troubleshooting & Useful Commands

```bash
# View Server Logs
sudo pm2 logs tipiz-admin

# Restart the Server (after changing .env or code)
sudo pm2 restart tipiz-admin --update-env

# Check Docker Logs
sudo docker logs telegram-bot-api

# Restart Docker Container
sudo docker restart telegram-bot-api

# Delete Temp Files (if disk gets full from failed jobs)
rm -rf temp/*

```
