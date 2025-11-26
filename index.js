// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');    // IMPORTANT: node-fetch v2

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(cors());            // Allow requests from any origin (for dev)
app.use(express.json());    // Parse JSON request bodies

// ---------- ROUTE: /translate ----------
app.post('/translate', async (req, res) => {
  try {
    // 1. Read the word from the request body
    const { germanWord } = req.body;

    if (!germanWord || !germanWord.trim()) {
      return res.status(400).json({ error: 'germanWord is required' });
    }

    console.log('Received word from frontend:', germanWord);

    // 2. Build prompts and payload (similar to frontend)
    const systemPrompt = `You are a specialized German-English vocabulary expert. Your task is to provide the exact English translation and the German article/gender for a given German word. If the word is a noun, you MUST include the article (der, die, or das) and the plural form in parentheses. If it is a verb, include the infinitive form and, if possible, the past participle (e.g., gehen (ging, gegangen)). Provide the response as a clean JSON object following the schema.`;

    const userQuery = `German word: ${germanWord}`;

    const responseSchema = {
      type: "OBJECT",
      properties: {
        germanWord: { type: "STRING", description: "The exact German word entered, including article if applicable." },
        englishTranslation: { type: "STRING", description: "The primary, most accurate English translation." },
        details: { type: "STRING", description: "German grammar details (e.g., gender, plural, verb forms). Include the plural form in parentheses for nouns." }
      },
      required: ["germanWord", "englishTranslation", "details"]
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
