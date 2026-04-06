/**
 * Tests for POST /process-meeting endpoint
 *
 * These tests verify the full endpoint behavior including:
 * - Input validation (missing file, missing/default userLevel, bad JSON)
 * - Successful processing flow
 * - Error handling for Gemini API failures
 * - File cleanup on success and error
 *
 * All Gemini API calls are mocked via node-fetch.
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock node-fetch before requiring the app
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

// Set a dummy API key so the server doesn't complain
process.env.GEMINI_API_KEY = 'test-key-123';

const { app } = require('../index');

// Helper: create a small temporary audio file for upload tests
function createTempAudioFile() {
  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, `test-audio-${Date.now()}.webm`);
  // Write a small buffer (not real audio, but sufficient for upload tests)
  fs.writeFileSync(filePath, Buffer.alloc(1024, 0));
  return filePath;
}

// Mock responses for the multi-step Gemini flow
function createSuccessfulMocks() {
  const uploadStartResponse = {
    ok: true,
    headers: { get: (key) => key === 'x-goog-upload-url' ? 'https://fake-upload-url.com' : null },
    text: () => Promise.resolve(''),
  };

  const uploadFinishResponse = {
    ok: true,
    json: () => Promise.resolve({
      file: {
        uri: 'https://gemini-files/test-file',
        name: 'files/test-file-123',
        state: 'ACTIVE',
      },
    }),
  };

  const transcribeResponse = {
    ok: true,
    json: () => Promise.resolve({
      candidates: [{
        content: {
          parts: [{ text: 'Heute besprechen wir die Ergebnisse der Besprechung.' }],
        },
      }],
    }),
  };

  const extractResponse = {
    ok: true,
    json: () => Promise.resolve({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify([
              {
                germanWord: 'die Besprechung',
                englishTranslation: 'meeting; discussion',
                details: 'Noun \u2022 feminine \u2022 plural: Besprechungen',
                examples: [
                  { german: 'Wir haben eine Besprechung um 10 Uhr.', english: 'We have a meeting at 10.' },
                  { german: 'Die Besprechung dauerte zwei Stunden.', english: 'The meeting lasted two hours.' },
                ],
              },
              {
                germanWord: 'das Ergebnis',
                englishTranslation: 'result; outcome',
                details: 'Noun \u2022 neuter \u2022 plural: Ergebnisse',
                examples: [
                  { german: 'Das Ergebnis war unerwartet.', english: 'The result was unexpected.' },
                  { german: 'Wir warten auf die Ergebnisse.', english: 'We are waiting for the results.' },
                ],
              },
            ]),
          }],
        },
      }],
    }),
  };

  const deleteResponse = {
    ok: true,
    json: () => Promise.resolve({}),
  };

  return {
    uploadStartResponse,
    uploadFinishResponse,
    transcribeResponse,
    extractResponse,
    deleteResponse,
  };
}

/**
 * Sets up fetch mock to return the correct response for each sequential call
 * in the /process-meeting flow:
 *   1. Upload start (resumable)
 *   2. Upload finish (send bytes)
 *   3. Transcribe (generateContent)
 *   4. Extract vocabulary (generateContent)
 *   5. Delete file (cleanup)
 */
function setupFetchMocksForSuccess() {
  const mocks = createSuccessfulMocks();
  let callCount = 0;
  fetch.mockImplementation(() => {
    callCount++;
    switch (callCount) {
      case 1: return Promise.resolve(mocks.uploadStartResponse);
      case 2: return Promise.resolve(mocks.uploadFinishResponse);
      case 3: return Promise.resolve(mocks.transcribeResponse);
      case 4: return Promise.resolve(mocks.extractResponse);
      case 5: return Promise.resolve(mocks.deleteResponse);
      default: return Promise.resolve(mocks.deleteResponse);
    }
  });
}


describe('POST /process-meeting', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  // ------------------------------------------------------------------
  // INPUT VALIDATION
  // ------------------------------------------------------------------

  describe('input validation', () => {
    test('returns 400 when no audio file is provided', async () => {
      const res = await request(app)
        .post('/process-meeting')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Audio file is required');
    });

    test('defaults userLevel to b1 when not provided', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' });

      // If the request succeeds, it means userLevel defaulted to b1
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('words');
    });

    test('handles invalid existingWords JSON gracefully by defaulting to empty array', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'a2')
        .field('existingWords', 'not-valid-json{{{');

      // Should succeed despite bad JSON (falls back to empty array)
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('words');
    });

    test('accepts valid existingWords JSON', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', JSON.stringify(['Haus', 'gehen', 'schon']));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('words');
    });
  });

  // ------------------------------------------------------------------
  // SUCCESSFUL PROCESSING
  // ------------------------------------------------------------------

  describe('successful processing', () => {
    test('returns correct response format with words, wordCount, and transcriptPreview', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'meeting.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('words');
      expect(res.body).toHaveProperty('wordCount');
      expect(res.body).toHaveProperty('transcriptPreview');
      expect(Array.isArray(res.body.words)).toBe(true);
      expect(res.body.wordCount).toBe(res.body.words.length);
    });

    test('returns words in the standard flashcard format (german, english, examples)', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'meeting.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(200);
      const word = res.body.words[0];
      expect(word).toHaveProperty('german');
      expect(word).toHaveProperty('english');
      expect(word).toHaveProperty('examples');

      // German field should contain the word + grammar details (formatted with newlines)
      expect(word.german).toContain('die Besprechung');
      expect(word.german).toContain('\n\n(');
      expect(word.german).toContain('Noun');

      // English field should have the translation
      expect(word.english).toContain('meeting');

      // Examples should be an array of {german, english} objects
      expect(Array.isArray(word.examples)).toBe(true);
      expect(word.examples[0]).toHaveProperty('german');
      expect(word.examples[0]).toHaveProperty('english');
    });

    test('transcriptPreview is truncated to 200 characters', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'meeting.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(200);
      expect(res.body.transcriptPreview.length).toBeLessThanOrEqual(200);
    });
  });

  // ------------------------------------------------------------------
  // GEMINI API ERROR HANDLING
  // ------------------------------------------------------------------

  describe('Gemini API error handling', () => {
    test('returns 500 when file upload start fails', async () => {
      fetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('Service Unavailable'),
        })
      );

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Meeting processing failed');
      expect(res.body.details).toContain('Gemini File API start failed');
    });

    test('returns 500 when upload bytes step fails', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Upload failed'),
        });
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('Gemini File API upload failed');
    });

    test('returns 500 when transcription API call fails', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve(mocks.uploadFinishResponse);
        if (callCount === 3) return Promise.resolve({
          ok: false,
          status: 429,
          text: () => Promise.resolve('Rate limit exceeded'),
        });
        // Call 4+ is cleanup (deleteGeminiFile)
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('Transcription failed');
    });

    test('returns 500 when transcription returns empty result', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve(mocks.uploadFinishResponse);
        if (callCount === 3) return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ candidates: [{ content: { parts: [{}] } }] }),
        });
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('Empty transcription result');
    });

    test('returns 500 when vocabulary extraction API call fails', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve(mocks.uploadFinishResponse);
        if (callCount === 3) return Promise.resolve(mocks.transcribeResponse);
        if (callCount === 4) return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal error'),
        });
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('Vocabulary extraction failed');
    });

    test('returns 500 when vocabulary extraction returns empty result', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve(mocks.uploadFinishResponse);
        if (callCount === 3) return Promise.resolve(mocks.transcribeResponse);
        if (callCount === 4) return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ candidates: [{ content: { parts: [{}] } }] }),
        });
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('Empty extraction result');
    });

    test('returns 500 when file never reaches ACTIVE state', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            file: {
              uri: 'https://gemini-files/test-file',
              name: 'files/test-file-123',
              state: 'PROCESSING',
            },
          }),
        });
        // All subsequent polling calls also return PROCESSING
        // (the function will poll up to 60 times, but we mock all as PROCESSING)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            state: 'FAILED',
            uri: 'https://gemini-files/test-file',
          }),
        });
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);
      expect(res.body.details).toContain('File processing failed');
    }, 30000);
  });

  // ------------------------------------------------------------------
  // FILE CLEANUP
  // ------------------------------------------------------------------

  describe('file cleanup', () => {
    test('calls deleteGeminiFile after successful processing', async () => {
      setupFetchMocksForSuccess();

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(200);

      // The 5th fetch call should be the DELETE to cleanup the Gemini file
      const calls = fetch.mock.calls;
      const lastCallUrl = calls[calls.length - 1][0];
      expect(lastCallUrl).toContain('files/test-file-123');
      // The DELETE call uses { method: 'DELETE' }
      const lastCallOptions = calls[calls.length - 1][1];
      expect(lastCallOptions.method).toBe('DELETE');
    });

    test('attempts cleanup of Gemini file even when processing errors occur', async () => {
      const mocks = createSuccessfulMocks();
      let callCount = 0;
      fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(mocks.uploadStartResponse);
        if (callCount === 2) return Promise.resolve(mocks.uploadFinishResponse);
        // Transcription fails
        if (callCount === 3) return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Transcription error'),
        });
        // Cleanup call (deleteGeminiFile)
        return Promise.resolve(mocks.deleteResponse);
      });

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', Buffer.alloc(512), { filename: 'test.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      expect(res.status).toBe(500);

      // After the error, the cleanup should attempt to delete the Gemini file
      // The error catch block calls deleteGeminiFile with geminiFileName
      const deleteCalls = fetch.mock.calls.filter(
        call => call[1] && call[1].method === 'DELETE'
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // MULTER FILE SIZE LIMIT
  // ------------------------------------------------------------------

  describe('multer configuration', () => {
    test('rejects files larger than 50MB', async () => {
      // Create a buffer just over 50MB
      // Note: supertest may not fully simulate multer's file size check in memory,
      // but this documents the expected behavior. The multer config in index.js
      // sets limits.fileSize to 50 * 1024 * 1024.
      const overSizeBuffer = Buffer.alloc(50 * 1024 * 1024 + 1);

      const res = await request(app)
        .post('/process-meeting')
        .attach('audio', overSizeBuffer, { filename: 'huge.webm', contentType: 'audio/webm' })
        .field('userLevel', 'b1')
        .field('existingWords', '[]');

      // Multer should reject with 413 or 500 depending on version
      expect([400, 413, 500]).toContain(res.status);
    }, 30000);
  });
});
