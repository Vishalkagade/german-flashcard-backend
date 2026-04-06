/**
 * Tests for Meeting Audio Processing helper functions
 *
 * These test the individual helper functions in isolation:
 * - uploadToGeminiFileAPI
 * - transcribeAudio
 * - extractVocabulary
 * - deleteGeminiFile
 *
 * All fetch calls are mocked.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock node-fetch before requiring the module
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

// Set dummy API key
process.env.GEMINI_API_KEY = 'test-key-for-helpers';

const {
  uploadToGeminiFileAPI,
  transcribeAudio,
  extractVocabulary,
  deleteGeminiFile,
} = require('../index');


describe('uploadToGeminiFileAPI', () => {
  let tempFilePath;

  beforeEach(() => {
    fetch.mockReset();
    // Create a temp file to simulate an audio file
    tempFilePath = path.join(os.tmpdir(), `test-upload-${Date.now()}.webm`);
    fs.writeFileSync(tempFilePath, Buffer.alloc(256, 0));
  });

  afterEach(() => {
    try { fs.unlinkSync(tempFilePath); } catch {}
  });

  test('returns fileUri and fileName on successful upload', async () => {
    // Mock the 3 fetch calls: start, upload, (no polling needed if ACTIVE)
    let callCount = 0;
    fetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Start resumable upload
        return Promise.resolve({
          ok: true,
          headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com/upload' : null },
          text: () => Promise.resolve(''),
        });
      }
      if (callCount === 2) {
        // Upload bytes (finalize) - returns ACTIVE immediately
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            file: {
              uri: 'https://gemini/files/abc123',
              name: 'files/abc123',
              state: 'ACTIVE',
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const result = await uploadToGeminiFileAPI(tempFilePath, 'audio/webm');

    expect(result).toHaveProperty('fileUri', 'https://gemini/files/abc123');
    expect(result).toHaveProperty('fileName', 'files/abc123');
  });

  test('throws when start upload returns non-ok response', async () => {
    fetch.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      })
    );

    await expect(
      uploadToGeminiFileAPI(tempFilePath, 'audio/webm')
    ).rejects.toThrow('Gemini File API start failed: 403');
  });

  test('throws when no upload URL is returned', async () => {
    fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      })
    );

    await expect(
      uploadToGeminiFileAPI(tempFilePath, 'audio/webm')
    ).rejects.toThrow('No upload URL returned from Gemini File API');
  });

  test('throws when upload bytes step fails', async () => {
    let callCount = 0;
    fetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com' : null },
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });
    });

    await expect(
      uploadToGeminiFileAPI(tempFilePath, 'audio/webm')
    ).rejects.toThrow('Gemini File API upload failed: 500');
  });

  test('polls for ACTIVE state when file starts as PROCESSING', async () => {
    let callCount = 0;
    fetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com' : null },
        });
      }
      if (callCount === 2) {
        // Upload returns PROCESSING state
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            file: {
              uri: 'https://gemini/files/poll-test',
              name: 'files/poll-test',
              state: 'PROCESSING',
            },
          }),
        });
      }
      if (callCount === 3) {
        // First poll: still PROCESSING
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            state: 'PROCESSING',
            uri: 'https://gemini/files/poll-test',
          }),
        });
      }
      // Second poll: now ACTIVE
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          state: 'ACTIVE',
          uri: 'https://gemini/files/poll-test-final',
        }),
      });
    });

    // Use fake timers to avoid real 3-second waits
    jest.useFakeTimers();
    const uploadPromise = uploadToGeminiFileAPI(tempFilePath, 'audio/webm');

    // Advance past both polling delays
    await jest.advanceTimersByTimeAsync(3000);
    await jest.advanceTimersByTimeAsync(3000);

    const result = await uploadPromise;
    expect(result.fileUri).toBe('https://gemini/files/poll-test-final');
    expect(result.fileName).toBe('files/poll-test');

    jest.useRealTimers();
  }, 15000);

  test('throws when file reaches FAILED state directly from upload', async () => {
    // When the upload finalize step returns state: 'FAILED' (not PROCESSING),
    // the while loop is never entered and the function throws immediately.
    let callCount = 0;
    fetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com' : null },
        });
      }
      // Upload finalize returns FAILED state directly
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          file: {
            uri: 'https://gemini/files/stuck',
            name: 'files/stuck',
            state: 'FAILED',
          },
        }),
      });
    });

    await expect(
      uploadToGeminiFileAPI(tempFilePath, 'audio/webm')
    ).rejects.toThrow('File processing failed, state: FAILED');
  });

  test('sends correct headers for resumable upload', async () => {
    let callCount = 0;
    fetch.mockImplementation((_url, options) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com' : null },
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          file: { uri: 'uri', name: 'name', state: 'ACTIVE' },
        }),
      });
    });

    await uploadToGeminiFileAPI(tempFilePath, 'audio/webm');

    // Verify start upload headers
    const startCall = fetch.mock.calls[0];
    const startHeaders = startCall[1].headers;
    expect(startHeaders['X-Goog-Upload-Protocol']).toBe('resumable');
    expect(startHeaders['X-Goog-Upload-Command']).toBe('start');
    expect(startHeaders['X-Goog-Upload-Header-Content-Type']).toBe('audio/webm');
    expect(startHeaders['Content-Type']).toBe('application/json');

    // Verify upload bytes headers
    const uploadCall = fetch.mock.calls[1];
    const uploadHeaders = uploadCall[1].headers;
    expect(uploadHeaders['X-Goog-Upload-Command']).toBe('upload, finalize');
    expect(uploadHeaders['X-Goog-Upload-Offset']).toBe('0');
  });

  test('includes API key in the upload URL', async () => {
    fetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload.com' : null },
        json: () => Promise.resolve({
          file: { uri: 'uri', name: 'name', state: 'ACTIVE' },
        }),
      })
    );

    await uploadToGeminiFileAPI(tempFilePath, 'audio/webm').catch(() => {});

    const firstCallUrl = fetch.mock.calls[0][0];
    expect(firstCallUrl).toContain('key=test-key-for-helpers');
  });
});


describe('transcribeAudio', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  test('returns transcript text on success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{ text: 'Guten Morgen, heute besprechen wir das neue Projekt.' }],
          },
        }],
      }),
    });

    const transcript = await transcribeAudio('https://gemini/files/123', 'audio/webm');
    expect(transcript).toBe('Guten Morgen, heute besprechen wir das neue Projekt.');
  });

  test('throws when API returns non-ok response', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too many requests'),
    });

    await expect(
      transcribeAudio('https://gemini/files/123', 'audio/webm')
    ).rejects.toThrow('Transcription failed: 429');
  });

  test('throws when result has no transcript text', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [] } }],
      }),
    });

    await expect(
      transcribeAudio('https://gemini/files/123', 'audio/webm')
    ).rejects.toThrow('Empty transcription result');
  });

  test('throws when candidates array is empty', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    });

    await expect(
      transcribeAudio('https://gemini/files/123', 'audio/webm')
    ).rejects.toThrow('Empty transcription result');
  });

  test('sends the correct payload structure to Gemini', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'test' }] } }],
      }),
    });

    await transcribeAudio('https://gemini/files/abc', 'audio/webm');

    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain('gemini-2.5-flash');
    expect(url).toContain('generateContent');

    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].fileData).toEqual({
      mimeType: 'audio/webm',
      fileUri: 'https://gemini/files/abc',
    });
    expect(body.contents[0].parts[1].text).toContain('Transcribe this German audio');
    expect(body.generationConfig.temperature).toBe(0.1);
  });

  test('uses the gemini-2.5-flash model for transcription', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'test' }] } }],
      }),
    });

    await transcribeAudio('https://gemini/files/abc', 'audio/webm');

    const url = fetch.mock.calls[0][0];
    expect(url).toContain('gemini-2.5-flash:generateContent');
  });
});


describe('extractVocabulary', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  const sampleTranscript = 'In der heutigen Besprechung besprechen wir die Ergebnisse der Umfrage. Die Teilnehmer haben verschiedene Vorschlaege gemacht.';

  const sampleExtractionResult = [
    {
      germanWord: 'die Umfrage',
      englishTranslation: 'survey; poll',
      details: 'Noun \u2022 feminine \u2022 plural: Umfragen',
      examples: [
        { german: 'Wir machen eine Umfrage.', english: 'We are conducting a survey.' },
        { german: 'Die Umfrage zeigt klare Ergebnisse.', english: 'The survey shows clear results.' },
      ],
    },
    {
      germanWord: 'der Vorschlag',
      englishTranslation: 'suggestion; proposal',
      details: 'Noun \u2022 masculine \u2022 plural: Vorschlaege',
      examples: [
        { german: 'Das ist ein guter Vorschlag.', english: 'That is a good suggestion.' },
        { german: 'Er hat einen Vorschlag gemacht.', english: 'He made a proposal.' },
      ],
    },
  ];

  function mockSuccessfulExtraction() {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify(sampleExtractionResult) }],
          },
        }],
      }),
    });
  }

  test('returns formatted word objects with german, english, examples', async () => {
    mockSuccessfulExtraction();

    const result = await extractVocabulary(sampleTranscript, 'b1', []);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('german');
    expect(result[0]).toHaveProperty('english');
    expect(result[0]).toHaveProperty('examples');
  });

  test('formats german field as "word\\n\\n(details)"', async () => {
    mockSuccessfulExtraction();

    const result = await extractVocabulary(sampleTranscript, 'b1', []);

    expect(result[0].german).toBe('die Umfrage\n\n(Noun \u2022 feminine \u2022 plural: Umfragen)');
    expect(result[1].german).toBe('der Vorschlag\n\n(Noun \u2022 masculine \u2022 plural: Vorschlaege)');
  });

  test('passes userLevel to the prompt', async () => {
    mockSuccessfulExtraction();

    await extractVocabulary(sampleTranscript, 'a2', []);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const systemPrompt = body.systemInstruction.parts[0].text;
    expect(systemPrompt).toContain('A2');
  });

  test('defaults to b1 level description when userLevel is unknown', async () => {
    mockSuccessfulExtraction();

    await extractVocabulary(sampleTranscript, 'c1', ['Haus']);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const systemText = body.systemInstruction.parts[0].text;
    // c1 is not in levelDescriptions, so it falls back to b1 description
    expect(systemText).toContain('B1 (Intermediate)');
  });

  test('includes existing words in the prompt for filtering', async () => {
    mockSuccessfulExtraction();

    const existingWords = ['Haus', 'gehen', 'Schule'];
    await extractVocabulary(sampleTranscript, 'b1', existingWords);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const userQuery = body.contents[0].parts[0].text;
    expect(userQuery).toContain('Haus');
    expect(userQuery).toContain('gehen');
    expect(userQuery).toContain('Schule');
  });

  test('truncates existing words to 500 items', async () => {
    mockSuccessfulExtraction();

    const manyWords = Array.from({ length: 600 }, (_, i) => `Wort${i}`);
    await extractVocabulary(sampleTranscript, 'b1', manyWords);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const userQuery = body.contents[0].parts[0].text;
    // Should contain Wort499 but not Wort500
    expect(userQuery).toContain('Wort499');
    expect(userQuery).not.toContain('Wort500');
  });

  test('truncates transcript to 30000 characters', async () => {
    mockSuccessfulExtraction();

    const longTranscript = 'A'.repeat(35000);
    await extractVocabulary(longTranscript, 'b1', []);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const userQuery = body.contents[0].parts[0].text;
    // The transcript portion should be truncated
    const transcriptSection = userQuery.split('TRANSCRIPT:\n')[1].split('\n\nSTUDENT')[0];
    expect(transcriptSection.length).toBe(30000);
  });

  test('throws when API returns non-ok response', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      extractVocabulary(sampleTranscript, 'b1', [])
    ).rejects.toThrow('Vocabulary extraction failed: 500');
  });

  test('throws when extraction result is empty', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{}] } }],
      }),
    });

    await expect(
      extractVocabulary(sampleTranscript, 'b1', [])
    ).rejects.toThrow('Empty extraction result');
  });

  test('throws when JSON from Gemini is unparseable', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{ text: 'not valid json {{{' }],
          },
        }],
      }),
    });

    await expect(
      extractVocabulary(sampleTranscript, 'b1', [])
    ).rejects.toThrow();
  });

  test('handles words with missing examples gracefully', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([
                {
                  germanWord: 'schnell',
                  englishTranslation: 'fast; quick',
                  details: 'Adjective \u2022 comparative: schneller',
                  // no examples field
                },
              ]),
            }],
          },
        }],
      }),
    });

    const result = await extractVocabulary(sampleTranscript, 'b1', []);
    expect(result[0].examples).toEqual([]);
  });

  test('uses gemini-2.5-flash-lite model for vocabulary extraction', async () => {
    mockSuccessfulExtraction();

    await extractVocabulary(sampleTranscript, 'b1', []);

    const url = fetch.mock.calls[0][0];
    expect(url).toContain('gemini-2.5-flash-lite:generateContent');
  });

  test('requests JSON response format from Gemini', async () => {
    mockSuccessfulExtraction();

    await extractVocabulary(sampleTranscript, 'b1', []);

    const [, options] = fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();
  });
});


describe('deleteGeminiFile', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  test('sends DELETE request to correct URL with API key', async () => {
    fetch.mockResolvedValue({ ok: true });

    await deleteGeminiFile('files/test-file-456');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain('files/test-file-456');
    expect(url).toContain('key=test-key-for-helpers');
    expect(options.method).toBe('DELETE');
  });

  test('does not throw when delete fails (fire and forget)', async () => {
    // deleteGeminiFile doesn't check the response, so it should not throw
    fetch.mockResolvedValue({ ok: false, status: 404 });

    // Should complete without throwing
    await expect(deleteGeminiFile('files/nonexistent')).resolves.not.toThrow();
  });
});
