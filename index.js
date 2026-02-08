// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');    // IMPORTANT: node-fetch v2
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(cors());            // Allow requests from any origin (for dev)
app.use(express.json());    // Parse JSON request bodies

// ---------- RATE LIMITING ----------
// Date-based key ensures reset at midnight
const getDailyKey = (ip) => {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `${ip}-${today}`;
};

const translateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours (for store cleanup)
  max: 40,                         // 40 requests per day
  standardHeaders: true,
  legacyHeaders: false,

  // IP + date as key = auto resets at midnight
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return getDailyKey(ip);
  },

  handler: (_req, res) => {
    res.status(429).json({
      error: 'Daily limit reached',
      message: 'You\'ve used all 40 free translations for today. Resets at midnight.',
      limit: 40
    });
  }
});

// ---------- ROUTE: /translate ----------
app.post('/translate', translateLimiter, async (req, res) => {
  try {
    // 1. Read the word from the request body
    const { germanWord } = req.body;

    if (!germanWord || !germanWord.trim()) {
      return res.status(400).json({ error: 'germanWord is required' });
    }

    console.log('Received word from frontend:', germanWord);

    // 2. Build prompts and payload (similar to frontend)
    const systemPrompt = `You are a specialized German-English vocabulary expert. Your task is to provide clear, concise vocabulary information optimized for flashcard learning.

FORMATTING RULES:
- For NOUNS: Include article in germanWord, add plural in details. Example: germanWord: "das Haus", details: "Noun • neuter • plural: Häuser"
- For VERBS: If reflexive, INCLUDE "sich" in germanWord. Example: germanWord: "sich vorstellen", details: "Reflexive verb • past: stellte vor"
- For REGULAR VERBS: Example: germanWord: "gehen", details: "Verb • past: ging, gegangen"
- For ADJECTIVES: Just say "Adjective" with any relevant info
- Keep details SHORT and SCANNABLE (under 60 characters)
- Use bullet points (•) to separate information
- Provide 2-3 simple, practical example sentences

Provide the response as a clean JSON object following the schema.`;

    const userQuery = `German word: ${germanWord}`;

    const responseSchema = {
      type: "OBJECT",
      properties: {
        germanWord: { type: "STRING", description: "The exact German word with article (for nouns) or 'sich' (for reflexive verbs). Examples: 'das Haus', 'sich vorstellen', 'gehen'" },
        englishTranslation: { type: "STRING", description: "The primary, most accurate English translation." },
        details: { type: "STRING", description: "Concise grammar details using bullet format (•). Examples: 'Noun • neuter • plural: Häuser', 'Reflexive verb • past: stellte vor', or 'Verb • past: ging, gegangen'. Keep under 60 characters." },
        examples: { 
          type: "ARRAY", 
          description: "2-3 example sentences showing the word in context",
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

    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    };

    // 3. Call the Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY is missing in .env');
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    const modelName = 'gemini-2.5-flash-preview-09-2025';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    console.log('Calling Gemini API...');

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('Gemini API error:', apiResponse.status, errorText);
      return res.status(apiResponse.status).json({
        error: 'Gemini API call failed',
        status: apiResponse.status,
        details: errorText,
      });
    }

    const result = await apiResponse.json();
    // console.log('Gemini raw result:', JSON.stringify(result, null, 2));

    // 4. Extract and parse model output
    const candidate = result.candidates?.[0];
    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      console.error('Invalid Gemini response structure:', result);
      return res.status(500).json({ error: 'Invalid response from Gemini API' });
    }

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

    // 5. Build response for frontend
    const fullGerman = `${parsedData.germanWord}\n\n(${parsedData.details})`;
    const fullEnglish = parsedData.englishTranslation;

    return res.json({
      german: fullGerman,
      english: fullEnglish,
      examples: parsedData.examples || [],
      raw: parsedData,  // Optional extra info
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
