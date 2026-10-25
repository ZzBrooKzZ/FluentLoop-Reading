# FluentLoop Reading

FluentLoop Reading is a web app for practicing academic reading and IELTS-style comprehension. It includes 54 built-in passages across CEFR levels A1–C1, with interactive vocabulary, questions, explanations, and progress tracking.

## What the app does

- Browse reading lessons by CEFR level and topic.
- Read passages with clickable vocabulary annotations, English definitions, and sentence context.
- Save words to a personal vocabulary bank.
- Answer IELTS-style comprehension questions and review evidence from the passage.
- Track completed lessons and reading progress.
- Use local answer grading first; optionally use server-side Gemini grading for open-ended answers that need semantic review.
- Sign in with Google and sync user data through Firebase when Firebase is configured.

Guest progress is stored in the browser. Firebase is used for sign-in and cloud data; configure the Firebase project, Google sign-in provider, Firestore, and its security rules before relying on shared accounts or saved cloud data.

## Requirements

- Node.js 20 or newer
- npm
- A Firebase project for sign-in and cloud sync
- An optional Gemini API key for semantic grading of open-ended answers

## Run locally

1. Clone the repository and enter the project folder:

   ```bash
   git clone https://github.com/ZzBrooKzZ/FluentLoop-Reading.git
   cd FluentLoop-Reading
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and configure server-side values:

   ```powershell
   Copy-Item .env.example .env
   ```

   Set `GEMINI_API_KEY` to your own key if you want Gemini grading. `GEMINI_GRADING_MODEL` is optional, and `APP_URL` is the deployed app URL when hosted. Keep `.env` private; it is ignored by Git.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open the local URL printed in the terminal (normally `http://localhost:3000`).

## Production build

```bash
npm run build
npm start
```

The Express server serves the built `dist` app when `NODE_ENV=production` and handles the `/api/grade-answers` endpoint. Set the host's `PORT` environment variable when deploying.

## Firebase setup

The client Firebase configuration is read from `firebase-applet-config.json`. Use your own Firebase project configuration for a separate installation, enable Google authentication, and deploy the Firestore rules in `firestore.rules`. Firebase web configuration is used by the browser; keep private service-account credentials out of this repository and out of client code.

## Deploying a test version

A Node web-service host such as Render can run this app. Use:

- Build command: `npm install && npm run build`
- Start command: `npm start`

Add `GEMINI_API_KEY`, `GEMINI_GRADING_MODEL` (optional), and `APP_URL` in the host's environment settings. Do not put secrets in `VITE_` variables or commit them. The current GitHub repository is private, so grant testers repository access if they need to clone the code; for browser-only testing, share the deployed app URL instead.

## Latest updates

- Expanded static vocabulary annotations across the built-in lessons without changing passage or question text.
- Vocabulary annotations now appear in all 411 paragraphs across the 54 built-in lessons; the paragraph pass adds up to two matching terms from a reviewed offline word list per paragraph.
- Annotation IDs are stable across reloads, and word matching uses the lesson passage text.
- Vocabulary expansion does not call Gemini. Gemini is only an optional server-side answer-grading path.

## Project structure

- `src/data/batches/` — built-in reading lessons by CEFR level
- `src/data/vocabularyExpansion.ts` — static vocabulary additions and paragraph coverage
- `src/services/gradingService.ts` — local and layered answer grading
- `src/components/` — reader, assessments, admin studio, and documentation views
- `src/lib/firebase.ts` — Firebase client setup
- `server.ts` — Express server, API routes, and Vite development middleware
- `firestore.rules` — Firestore access rules
