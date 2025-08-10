const OpenAI = require("openai");
const fs = require("fs");

class OpenAITranscriptionService {
  constructor(apiKey) {
    this.client = new OpenAI({ 
      apiKey,
      dangerouslyAllowBrowser: false,
      baseURL: 'https://api.openai.com/v1'
    });
  }

  async transcribe(tempFile, options = {}) {
    const {
      model = 'whisper-1',
      language = 'auto',
      prompt = '',
      translateMode = false
    } = options;

    if (translateMode) {
      // OpenAI translations API currently supports only whisper-1
      const translationOptions = {
        file: fs.createReadStream(tempFile),
        model: 'whisper-1',
        response_format: 'text',
      };
      
      const translationResponse = await this.client.audio.translations.create(translationOptions);
      return typeof translationResponse === 'string' ? { text: translationResponse } : translationResponse;
    } else {
      // OpenAI transcriptions - use stable whisper-1 for now
      const transcriptionOptions = {
        file: fs.createReadStream(tempFile),
        model: 'whisper-1', // Force whisper-1 for stability
        response_format: 'text',
      };
      
      if (language !== 'auto') transcriptionOptions.language = language;
      if (prompt.trim()) transcriptionOptions.prompt = prompt;
      
      const transcription = await this.client.audio.transcriptions.create(transcriptionOptions);
      return typeof transcription === 'string' ? { text: transcription } : transcription;
    }
  }

  static getSupportedModels() {
    return [
      'whisper-1'
      // Note: GPT-4o models may require special access permissions
      // 'gpt-4o-transcribe',
      // 'gpt-4o-mini-transcribe'
    ];
  }
}

module.exports = OpenAITranscriptionService;
