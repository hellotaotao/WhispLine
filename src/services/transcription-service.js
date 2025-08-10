const GroqTranscriptionService = require('./groq-transcription');
const OpenAITranscriptionService = require('./openai-transcription');
const fs = require("fs");
const path = require("path");
const os = require("os");

class TranscriptionService {
  constructor(provider, apiKey) {
    this.provider = provider;
    
    switch (provider) {
      case 'groq':
        this.service = new GroqTranscriptionService(apiKey);
        break;
      case 'openai':
        this.service = new OpenAITranscriptionService(apiKey);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async transcribeAudio(audioBuffer, options = {}) {
    const {
      model,
      language = 'auto',
      prompt = '',
      translateMode = false
    } = options;

    // Save audio buffer to temporary file
    const tempFile = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
    fs.writeFileSync(tempFile, audioBuffer);

    try {
      // Determine the actual model to use
      const actualModel = translateMode 
        ? (this.provider === 'openai' ? 'whisper-1' : 'whisper-large-v3')
        : model;

      console.log(`🎙️  Provider: ${this.provider} | Using model: ${actualModel} | Language: ${language} | Translate mode: ${translateMode}`);

      // Call the appropriate service
      const result = await this.service.transcribe(tempFile, {
        model: actualModel,
        language,
        prompt,
        translateMode
      });

      console.log(`✅ ${translateMode ? 'Translation' : 'Transcription'} completed: "${result.text}"`);
      
      return result.text;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        console.warn('Failed to cleanup temp file:', error);
      }
    }
  }

  static getSupportedModels(provider) {
    switch (provider) {
      case 'groq':
        return GroqTranscriptionService.getSupportedModels();
      case 'openai':
        return OpenAITranscriptionService.getSupportedModels();
      default:
        return [];
    }
  }

  static getSupportedProviders() {
    return ['groq', 'openai'];
  }
}

module.exports = TranscriptionService;
