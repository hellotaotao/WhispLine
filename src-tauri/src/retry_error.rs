// These codes are a persistent format: older history.json rows store them in
// text/error. Never rename or reuse a code without a migration; retain frontend
// translations for retired codes. scripts/retry-recovery.test.mjs checks every
// production code against both languages and preserves a legacy-code fixture.
#[derive(Clone, Copy, Debug)]
pub enum RetryError {
  HistoryRead,
  EntryMissing,
  NotPending,
  AudioMissing,
  AudioRead,
  SettingsRead,
  ResultSave,
  AudioFormat,
  NoSpeech,
  CaptureIncomplete,
}

impl RetryError {
  pub fn code(self) -> &'static str {
    match self {
      Self::HistoryRead => "RETRY_HISTORY_READ",
      Self::EntryMissing => "RETRY_ENTRY_MISSING",
      Self::NotPending => "RETRY_NOT_PENDING",
      Self::AudioMissing => "RETRY_AUDIO_MISSING",
      Self::AudioRead => "RETRY_AUDIO_READ",
      Self::SettingsRead => "RETRY_SETTINGS_READ",
      Self::ResultSave => "RETRY_RESULT_SAVE",
      Self::AudioFormat => "RETRY_AUDIO_FORMAT",
      Self::NoSpeech => "RETRY_NO_SPEECH",
      Self::CaptureIncomplete => "RETRY_CAPTURE_INCOMPLETE",
    }
  }
}

// Engine errors are ordinary text, even if they happen to begin with RETRY_.
pub enum RetryFailure<'a> {
  BuiltIn(RetryError),
  Engine(&'a str),
}
