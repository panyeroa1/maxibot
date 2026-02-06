<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Maximus - AI Voice Companion

A real-time voice chat application powered by Google's Gemini API.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Set the `VITE_GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy to Vercel

1. Push this repository to GitHub
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Add the environment variable in Vercel dashboard:
   - Name: `VITE_GEMINI_API_KEY`
   - Value: Your Gemini API key
4. Deploy!
