/**
 * index.js - Backend server for the Cardio flashcard app
 *
 * This is a simple Express.js server with ONE job:
 * - Receive a German word from the frontend
 * - Call the Google Gemini API to get translation + grammar + examples
 * - Return the structured result to the frontend
 *
 * The backend exists because the Gemini API key must stay secret.
 * If we called the API directly from the browser, anyone could steal the key.
 *
 * Endpoints:
 *   POST /translate          — translates a German word (rate limited: 40/day per IP)
 *   POST /translate-batch    — translates multiple words in one call
 *   POST /process-meeting    — uploads meeting audio, transcribes, extracts vocabulary
 *
 * Environment variables (in .env file):
 *   GEMINI_API_KEY   — your Google Gemini API key
 *   PORT             — server port (defaults to 3000)
 */

// Load environment variables from .env file into process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');    // node-fetch v2 (v3 doesn't support require())
const rateLimit = require('express-rate-limit');
const multer = require('multer');       // File upload handling for meeting audio
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;


// ==========================================================================
// MIDDLEWARE
// ==========================================================================

// CORS: Allow requests from any origin (the frontend runs on a different URL)
// In production, you could restrict this to your GitHub Pages domain for security.
app.use(cors());

// Parse JSON request bodies (the frontend sends { germanWord: "..." })
app.use(express.json());

// Multer: saves uploaded meeting audio to OS temp directory (not memory).
// This avoids loading large audio files into RAM (Render has 512MB limit).
const meetingUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});


// ==========================================================================
// RATE LIMITING
// ==========================================================================
// Prevents abuse by limiting each IP to 40 translations per day.
// Uses IP + today's date as the key, so the counter resets at midnight.

// Generate a unique key per IP per day (e.g., "192.168.1.1-2026-02-21")
const getDailyKey = (ip) => {
  const today = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
  return `${ip}-${today}`;
};

const translateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours (controls how long the store keeps entries)
  max: 40,                         // Maximum 40 requests per key
  standardHeaders: true,           // Send RateLimit-* headers in responses
  legacyHeaders: false,

  // Custom key: IP + date means a new day = a fresh quota
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return getDailyKey(ip);
  },

  // Custom response when limit is hit (frontend checks for 429 status)
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Daily limit reached',
      message: 'You\'ve used all 40 free translations for today. Resets at midnight.',
      limit: 40
    });
  }
});


// ==========================================================================
// ROUTE: POST /translate
// ==========================================================================
// This is the main (and only) endpoint. Flow:
// 1. Frontend sends: { germanWord: "Haus" }
// 2. We build a prompt for the Gemini API
// 3. Gemini returns structured JSON with translation + grammar + examples
// 4. We format and send it back to the frontend

app.post('/translate', translateLimiter, async (req, res) => {
  try {
    // --- Step 1: Validate input ---
    const { germanWord } = req.body;

    if (!germanWord || !germanWord.trim()) {
      return res.status(400).json({ error: 'germanWord is required' });
    }

    console.log('Received word from frontend:', germanWord);

    // --- Step 2: Build the Gemini API request ---

    // System prompt: tells Gemini how to format its response.
    // Key rules:
    // - Include the article (der/die/das) for nouns
    // - Include "sich" for reflexive verbs
    // - Grammar details must be in GERMAN only (no English in the details field)
    // - Provide 2-3 example sentences
    const systemPrompt = `You are a specialized German-English vocabulary expert. Your task is to provide clear, concise vocabulary information optimized for flashcard learning.

CRITICAL RULE: The "details" field must ONLY contain GERMAN grammar information. NEVER include English translations or meanings in the details field.

GRAMMAR FORMATTING RULES:
- For NOUNS: Include article in germanWord, add GERMAN plural in details. Example: germanWord: "das Haus", details: "Noun • neuter • plural: Häuser" (NOT "houses"!)
- For VERBS: If reflexive, INCLUDE "sich" in germanWord. Example: germanWord: "sich duschen", details: "Reflexive verb • infinitive" (NO English!)
- For REGULAR VERBS: Example: germanWord: "gehen", details: "Verb • past: ging, gegangen" (ONLY German forms!)
- For ADJECTIVES: Example: germanWord: "schön", details: "Adjective • comparative: schöner" (NO English!)
- Keep details SHORT and SCANNABLE (under 60 characters)
- Use bullet points (•) to separate information
- Details = German grammar ONLY (gender, plural, verb forms, cases)

TRANSLATION RULES:
- Give the primary everyday meaning first
- If the word has other common meanings, add them after a semicolon: "to meet; also: to hit, to make (a decision)"
- Only include meanings that Germans actually use often — skip rare/archaic ones
- Keep it concise: max 2-3 meanings total

EXAMPLE SENTENCE RULES:
- Provide 2-3 examples, each MUST show a DIFFERENT meaning or common collocation
- Use natural, conversational German — how real people actually talk, NOT textbook sentences
- Show real-life situations: chatting with friends, ordering food, texting, work conversations, daily routines
- Include common collocations and phrases Germans actually say (e.g. "eine Entscheidung treffen", "Bescheid geben", "Lust haben")
- If the word has multiple meanings, each example MUST demonstrate a different usage
- BAD example: "Ich treffe meinen Freund." (too simple, textbook-like)
- GOOD example: "Lass uns morgen im Cafe treffen!" (natural, how people actually speak)
- GOOD example: "Er hat eine schwierige Entscheidung getroffen." (shows a different meaning/collocation)

Provide the response as a clean JSON object following the schema.`;

    const userQuery = `German word: ${germanWord}`;

    // Response schema: tells Gemini the exact JSON structure we expect.
    // This uses Gemini's "structured output" feature to guarantee valid JSON.
    const responseSchema = {
      type: "OBJECT",
      properties: {
        germanWord: { type: "STRING", description: "The exact German word with article (for nouns) or 'sich' (for reflexive verbs). Examples: 'das Haus', 'sich vorstellen', 'gehen'" },
        englishTranslation: { type: "STRING", description: "Primary meaning first, then other common meanings after semicolon. Example: 'to meet; also: to hit, to make (a decision)'. Max 2-3 meanings, only frequently used ones." },
        details: { type: "STRING", description: "GERMAN grammar details ONLY using bullet format (•). NEVER include English translations here! Examples: 'Noun • neuter • plural: Häuser' (NOT 'houses'), 'Reflexive verb • infinitive', or 'Verb • past: ging, gegangen'. Keep under 60 characters. ONLY German grammar info!" },
        examples: {
          type: "ARRAY",
          description: "2-3 example sentences, each showing a DIFFERENT meaning or collocation. Use natural conversational German, not textbook style.",
          items: {
            type: "OBJECT",
            properties: {
              german: { type: "STRING", description: "Example sentence in German" },
              english: { type: "STRING", description: "English translation of the example" }
            },
            required: ["german", "english"]
          }
        }
      },
      required: ["germanWord", "englishTranslation", "details", "examples"]
    };

    // The full request payload for Gemini's generateContent API
    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        responseMimeType: "application/json",  // Force JSON output
        responseSchema: responseSchema,         // Enforce our schema
      },
    };

    // --- Step 3: Call the Gemini API ---
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY is missing in .env');
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    const modelName = 'gemini-2.5-flash-lite';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    console.log('Calling Gemini API...');

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Handle Gemini API errors
    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('Gemini API error:', apiResponse.status, errorText);
      return res.status(apiResponse.status).json({
        error: 'Gemini API call failed',
        status: apiResponse.status,
        details: errorText,
      });
    }

    // --- Step 4: Parse the Gemini response ---
    const result = await apiResponse.json();

    // Gemini returns: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
    const candidate = result.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      console.error('Invalid Gemini response structure:', result);
      return res.status(500).json({ error: 'Invalid response from Gemini API' });
    }

    // The text is a JSON string (because we requested responseMimeType: "application/json")
    const jsonText = candidate.content.parts[0].text;

    let parsedData;
    try {
      parsedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('Error parsing JSON from Gemini:', parseError, 'Raw text:', jsonText);
      return res.status(500).json({
        error: 'Failed to parse JSON from Gemini',
        raw: jsonText,
      });
    }

    // --- Step 5: Format and send response to frontend ---
    // The frontend expects german text in this format:
    //   "das Haus\n\n(Noun • neuter • plural: Häuser)"
    // Line 1: the word with article
    // Line 2: blank
    // Line 3: grammar details in parentheses
    const fullGerman = `${parsedData.germanWord}\n\n(${parsedData.details})`;
    const fullEnglish = parsedData.englishTranslation;

    return res.json({
      german: fullGerman,        // Formatted German text for the flashcard front
      english: fullEnglish,      // English translation for the flashcard back
      examples: parsedData.examples || [],  // Example sentences
      raw: parsedData,           // Full Gemini response (useful for debugging)
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// ==========================================================================
// ROUTE: POST /translate-batch
// ==========================================================================
// Translates multiple German words in a single Gemini API call.
// Used by the daily auto-add feature (no rate limiting).
// Input: { words: ["Apfel", "sprechen", ...] } (max 10)
// Output: [{ german, english, examples }, ...]

app.post('/translate-batch', async (req, res) => {
  try {
    const { words } = req.body;

    if (!words || !Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: 'words array is required' });
    }

    // Validate and sanitize: only strings, max 100 chars each, limit to 10
    const batch = words
      .filter(w => typeof w === 'string' && w.trim().length > 0 && w.length <= 100)
      .slice(0, 10);

    if (batch.length === 0) {
      return res.status(400).json({ error: 'No valid words provided' });
    }

    console.log('Batch translate:', batch.length, 'words');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    const systemPrompt = `You are a specialized German-English vocabulary expert. Translate the given list of German words for flashcard learning.

For EACH word, provide:
- germanWord: Include article (der/die/das) for nouns, "sich" for reflexive verbs
- englishTranslation: Primary meaning first; if other common meanings exist, add after semicolon (e.g. "to meet; also: to hit, to make (a decision)"). Max 2-3 meanings, only frequently used ones.
- details: GERMAN grammar info ONLY (gender, plural, verb forms). Use bullet (•) separators. Under 60 chars. NO English in details!
- examples: 2 example sentences (german + english). Each example MUST show a DIFFERENT meaning or common collocation. Use natural conversational German, not textbook style. Show real-life situations.

Return a JSON array with one object per word.`;

    const userQuery = `Translate these German words: ${JSON.stringify(batch)}`;

    const responseSchema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          germanWord: { type: "STRING" },
          englishTranslation: { type: "STRING" },
          details: { type: "STRING" },
          examples: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                german: { type: "STRING" },
                english: { type: "STRING" }
              },
              required: ["german", "english"]
            }
          }
        },
        required: ["germanWord", "englishTranslation", "details", "examples"]
      }
    };

    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    };

    const modelName = 'gemini-2.5-flash-lite';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('Gemini API error:', apiResponse.status, errorText);
      return res.status(apiResponse.status).json({ error: 'Gemini API call failed' });
    }

    const result = await apiResponse.json();
    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonText) {
      return res.status(500).json({ error: 'Invalid response from Gemini API' });
    }

    let parsedArray;
    try {
      parsedArray = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse Gemini response' });
    }

    // Format each word the same way as /translate
    const formatted = parsedArray.map(item => ({
      german: `${item.germanWord}\n\n(${item.details})`,
      english: item.englishTranslation,
      examples: item.examples || [],
    }));

    return res.json(formatted);

  } catch (error) {
    console.error('Batch translate error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// ==========================================================================
// MEETING AUDIO PROCESSING — Helper Functions
// ==========================================================================

/**
 * Upload an audio file to the Gemini File API using resumable upload.
 * Returns the file URI that can be passed to generateContent.
 * Waits for the file to reach ACTIVE state before returning.
 */
async function uploadToGeminiFileAPI(filePath, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const fileBuffer = fs.readFileSync(filePath);

  // Step 1: Start resumable upload
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName: 'meeting-audio' } }),
    }
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Gemini File API start failed: ${startRes.status} ${errText}`);
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL returned from Gemini File API');

  // Step 2: Upload the bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': mimeType,
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Gemini File API upload failed: ${uploadRes.status} ${errText}`);
  }

  const fileInfo = await uploadRes.json();
  let fileUri = fileInfo.file.uri;
  const fileName = fileInfo.file.name;
  let state = fileInfo.file.state;

  // Step 3: Wait for file to become ACTIVE (may take a few seconds for large files)
  let attempts = 0;
  while (state === 'PROCESSING' && attempts < 60) {
    await new Promise(r => setTimeout(r, 3000));
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    const checkData = await checkRes.json();
    state = checkData.state;
    fileUri = checkData.uri;
    attempts++;
  }

  if (state !== 'ACTIVE') throw new Error(`File processing failed, state: ${state}`);
  return { fileUri, fileName };
}

/**
 * Delete a file from the Gemini File API (cleanup after processing).
 */
async function deleteGeminiFile(fileName) {
  const apiKey = process.env.GEMINI_API_KEY;
  await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    { method: 'DELETE' }
  );
}

/**
 * Transcribe audio using Gemini 2.5 Flash (supports audio input natively).
 * Returns the German transcript as a string.
 */
async function transcribeAudio(fileUri, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = 'gemini-2.5-flash';

  const payload = {
    contents: [{
      parts: [
        { fileData: { mimeType: mimeType, fileUri: fileUri } },
        { text: 'Transcribe this German audio. Output ONLY the German transcript text, nothing else. Preserve the original German words exactly as spoken. Do not translate to English. Do not add timestamps or speaker labels.' }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
    },
  };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Transcription failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  const transcript = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!transcript) throw new Error('Empty transcription result');
  return transcript;
}

/**
 * Extract vocabulary from a transcript using Gemini.
 * Filters by user's CEFR level and excludes words already in their deck.
 * Returns formatted word objects matching the /translate response format.
 */
async function extractVocabulary(transcript, userLevel, existingWords) {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = 'gemini-2.5-flash-lite';

  const levelDescriptions = {
    a1: 'A1 (Beginner) — knows basic greetings, numbers, simple everyday words',
    a2: 'A2 (Elementary) — knows everyday expressions, basic personal/family vocab',
    b1: 'B1 (Intermediate) — knows common words about work, school, leisure',
    b2: 'B2 (Upper-Intermediate) — understands main ideas of complex text',
  };

  const systemPrompt = `You are a German language teacher helping a ${levelDescriptions[userLevel] || levelDescriptions.b1} student extract useful vocabulary from a meeting transcript.

TASK: Identify 15-20 German words/phrases from the transcript that would be most valuable for this student to learn.

RULES:
1. SKIP words the student already knows (provided in the existing deck list below)
2. SKIP very common words that any ${(userLevel || 'b1').toUpperCase()} student would already know (der, die, das, ist, hat, und, aber, nicht, auch, ich, du, er, sie, es, wir, ihr, ein, eine, mit, von, zu, in, auf, an, etc.)
3. SKIP English words, proper nouns, filler words
4. FOCUS on vocabulary that appeared in a meaningful context in the meeting
5. For nouns: ALWAYS include the article (der/die/das)
6. For reflexive verbs: include "sich"
7. Rank words by usefulness for daily life (most useful first)
8. Provide 2 natural example sentences per word, each showing a different usage

GRAMMAR FORMATTING (details field):
- For NOUNS: "Noun • gender • plural: Xen" — GERMAN grammar only, no English
- For VERBS: "Verb • past: ging, gegangen" — ONLY German verb forms
- For ADJECTIVES: "Adjective • comparative: schöner" — ONLY German forms
- Keep under 60 characters, use bullet (•) separators

TRANSLATION RULES:
- Primary meaning first, secondary after semicolon if relevant
- Max 2-3 meanings, only frequently used ones`;

  const existingList = existingWords.slice(0, 500);
  const userQuery = `TRANSCRIPT:\n${transcript.substring(0, 30000)}\n\nSTUDENT'S EXISTING DECK (skip these words):\n${JSON.stringify(existingList)}\n\nExtract the most useful vocabulary for a ${(userLevel || 'b1').toUpperCase()} learner.`;

  const responseSchema = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        germanWord: { type: "STRING", description: "German word with article for nouns or sich for reflexive verbs" },
        englishTranslation: { type: "STRING", description: "English translation, primary meaning first" },
        details: { type: "STRING", description: "German grammar details only, under 60 chars" },
        examples: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              german: { type: "STRING" },
              english: { type: "STRING" }
            },
            required: ["german", "english"]
          }
        }
      },
      required: ["germanWord", "englishTranslation", "details", "examples"]
    }
  };

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
    },
  };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vocabulary extraction failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) throw new Error('Empty extraction result');

  const parsedArray = JSON.parse(jsonText);

  // Format identically to /translate and /translate-batch responses
  return parsedArray.map(item => ({
    german: `${item.germanWord}\n\n(${item.details})`,
    english: item.englishTranslation,
    examples: item.examples || [],
  }));
}


// ==========================================================================
// ROUTE: POST /process-meeting
// ==========================================================================
// Processes a meeting audio recording:
// 1. Receives audio file + user level + existing deck words
// 2. Uploads audio to Gemini File API
// 3. Transcribes audio using Gemini 2.5 Flash
// 4. Extracts vocabulary using Gemini 2.5 Flash Lite
// 5. Returns formatted word list ready for flashcard creation

app.post('/process-meeting', meetingUpload.single('audio'), async (req, res) => {
  let tempFilePath = req.file?.path;
  let geminiFileName = null;

  try {
    // --- Validate input ---
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    const userLevel = req.body.userLevel || 'b1';
    let existingWords = [];
    try {
      existingWords = JSON.parse(req.body.existingWords || '[]');
    } catch { existingWords = []; }

    const mimeType = req.file.mimetype || 'audio/webm';
    console.log(`Processing meeting: ${(req.file.size / 1024 / 1024).toFixed(1)}MB, level=${userLevel}, deck=${existingWords.length} words`);

    // --- Step 1: Upload audio to Gemini File API ---
    console.log('Uploading audio to Gemini File API...');
    const { fileUri, fileName } = await uploadToGeminiFileAPI(tempFilePath, mimeType);
    geminiFileName = fileName;

    // Delete local temp file immediately after upload
    try { fs.unlinkSync(tempFilePath); } catch {}
    tempFilePath = null;

    // --- Step 2: Transcribe audio ---
    console.log('Transcribing audio...');
    const transcript = await transcribeAudio(fileUri, mimeType);
    console.log(`Transcript: ${transcript.length} chars`);

    // --- Step 3: Extract vocabulary ---
    console.log('Extracting vocabulary...');
    const words = await extractVocabulary(transcript, userLevel, existingWords);
    console.log(`Extracted ${words.length} words`);

    // --- Step 4: Cleanup Gemini file ---
    try { await deleteGeminiFile(geminiFileName); } catch {}

    return res.json({
      words: words,
      wordCount: words.length,
      transcriptPreview: transcript.substring(0, 200),
    });

  } catch (error) {
    console.error('Meeting processing error:', error);

    // Cleanup on error
    if (tempFilePath) try { fs.unlinkSync(tempFilePath); } catch {}
    if (geminiFileName) try { deleteGeminiFile(geminiFileName); } catch {}

    return res.status(500).json({
      error: 'Meeting processing failed',
      details: error.message || 'Unknown error',
    });
  }
});


// ==========================================================================
// START SERVER
// ==========================================================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

// Export for testing
module.exports = {
  app,
  uploadToGeminiFileAPI,
  transcribeAudio,
  extractVocabulary,
  deleteGeminiFile,
};
