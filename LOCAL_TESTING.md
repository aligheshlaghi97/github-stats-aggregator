# Local Testing Setup

## Quick Start Commands

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your GitHub token:
   ```
   GITHUB_TOKEN=your_github_token_here
   ```

3. **Start local server:**
   ```bash
   npm start
   # or
   npm run dev
   ```

4. **Test the API:**
   - Open browser to: http://localhost:3000
   - Test endpoint: http://localhost:3000/api?test=true
   - Your stats: http://localhost:3000/api
   - Custom user: http://localhost:3000/api?user=YOUR_USERNAME

## Getting GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes:
   - ✅ `repo` (for private repositories)
   - ✅ `read:user`
4. Copy the token and add it to your `.env` file

## Debugging

- Check console logs for detailed information
- The test endpoint shows if your token is set
- Look for "PRIVATE" or "PUBLIC" in the logs to see which data is being fetched

## Troubleshooting

- If you see 0 values: Check your GitHub token permissions
- If private data isn't showing: Make sure your token has `repo` scope
- If server won't start: Make sure you have all dependencies installed
