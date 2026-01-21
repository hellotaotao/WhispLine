const Groq = require("groq-sdk");
const fs = require("fs");

class GroqTranscriptionService {
  constructor(apiKey) {
    this.client = new Groq({ apiKey });
  }

  async transcribe(tempFile, options = {}) {
    const {
      model = 'whisper-large-v3-turbo',
      language = 'auto',
      prompt = '',
      translateMode = false,
      signal
    } = options;

    if (translateMode) {
      // Groq translation (English output)
      const translationOptions = {
        file: fs.createReadStream(tempFile),
        model: 'whisper-large-v3',
        response_format: 'text',
        temperature: 0.0,
      };
      
      const translationResponse = await this.client.audio.translations.create(translationOptions, { signal });
      return typeof translationResponse === 'string' ? { text: translationResponse } : translationResponse;
    } else {
      // Groq transcription (verbose_json for timestamps)
      const transcriptionOptions = {
        file: fs.createReadStream(tempFile),
        model: model,
        response_format: 'verbose_json',
      };
      
      if (language !== 'auto') transcriptionOptions.language = language;
      if (prompt.trim()) transcriptionOptions.prompt = prompt;
      
      return await this.client.audio.transcriptions.create(transcriptionOptions, { signal });
    }
  }

  static getSupportedModels() {
    return [
      'whisper-large-v3',
      'whisper-large-v3-turbo'
    ];
  }
}

module.exports = GroqTranscriptionService;
