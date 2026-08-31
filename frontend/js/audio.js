/**
 * audio.js
 * ========
 * All of the game's sound, synthesised on the fly with the Web Audio API.
 *
 * WHY SYNTHESISED RATHER THAN .mp3 FILES
 * --------------------------------------
 * Shipping audio files means sourcing them, and every free sound library
 * carries a licence that has to be honoured and documented. Chess sounds are
 * simple enough — a wooden knock, a duller thud, a couple of clean tones —
 * that generating them from an oscillator and a burst of filtered noise is
 * both easier and completely free of licensing questions. It also means the
 * project ships zero audio bytes, which matters on a phone connection.
 *
 * THE AUTOPLAY RULE
 * -----------------
 * Mobile browsers refuse to start an AudioContext until the user has
 * interacted with the page. `unlock()` must therefore be called from inside a
 * real tap handler — both AR modes call it from the button that starts the
 * experience, which is exactly the gesture the browser is waiting for.
 */

/** Each sound is scaled by this so the set as a whole is unobtrusive. */
const MASTER_VOLUME = 0.35;

class GameAudio {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.isMuted = false;
  }

  /**
   * Create (or resume) the AudioContext. Safe to call repeatedly, and safe to
   * call on a browser with no Web Audio support — sound simply stays silent
   * rather than throwing and taking the scene down with it.
   */
  unlock() {
    try {
      if (!this.audioContext) {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) {
          return;
        }
        this.audioContext = new AudioContextConstructor();
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = MASTER_VOLUME;
        this.masterGain.connect(this.audioContext.destination);
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
    } catch (audioError) {
      console.warn('[audio] could not start the audio context:', audioError);
    }
  }

  /** Turn sound on or off; returns the new muted state for the UI to show. */
  toggleMuted() {
    this.isMuted = !this.isMuted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.isMuted ? 0 : MASTER_VOLUME;
    }
    return this.isMuted;
  }

  /** True once audio is usable — used to decide whether to bother scheduling. */
  get isReady() {
    return this.audioContext !== null && this.audioContext.state === 'running';
  }

  /* --------------------------------------------------------------------- *
   * Low-level voices
   * --------------------------------------------------------------------- */

  /**
   * A single pitched note with an exponential decay.
   *
   * @param {object} options
   * @param {number} options.frequency     Pitch in hertz.
   * @param {number} options.durationSeconds How long the note rings for.
   * @param {string} [options.waveform]    'sine' | 'triangle' | 'square' | 'sawtooth'
   * @param {number} [options.peakGain]    Loudness before the master volume.
   * @param {number} [options.delaySeconds] Schedule the note into the future.
   */
  playTone({ frequency, durationSeconds, waveform = 'sine', peakGain = 0.6, delaySeconds = 0 }) {
    if (!this.isReady) {
      return;
    }
    const startTime = this.audioContext.currentTime + delaySeconds;

    const oscillator = this.audioContext.createOscillator();
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(frequency, startTime);

    const envelope = this.audioContext.createGain();
    // A 6 ms attack instead of an instant one avoids the click that a hard
    // gain step produces on most phone speakers.
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSeconds);

    oscillator.connect(envelope).connect(this.masterGain);
    oscillator.start(startTime);
    oscillator.stop(startTime + durationSeconds + 0.02);
  }

  /**
   * A burst of band-passed white noise — the percussive part of a piece
   * landing on a wooden board. The filter's centre frequency is what makes it
   * sound like wood rather than static.
   */
  playNoiseBurst({ centreFrequency, durationSeconds, peakGain = 0.6, delaySeconds = 0 }) {
    if (!this.isReady) {
      return;
    }
    const startTime = this.audioContext.currentTime + delaySeconds;
    const sampleCount = Math.max(1, Math.floor(this.audioContext.sampleRate * durationSeconds));

    const noiseBuffer = this.audioContext.createBuffer(1, sampleCount, this.audioContext.sampleRate);
    const noiseSamples = noiseBuffer.getChannelData(0);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      noiseSamples[sampleIndex] = Math.random() * 2 - 1;
    }

    const noiseSource = this.audioContext.createBufferSource();
    noiseSource.buffer = noiseBuffer;

    const bandPassFilter = this.audioContext.createBiquadFilter();
    bandPassFilter.type = 'bandpass';
    bandPassFilter.frequency.value = centreFrequency;
    bandPassFilter.Q.value = 1.6;

    const envelope = this.audioContext.createGain();
    envelope.gain.setValueAtTime(peakGain, startTime);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSeconds);

    noiseSource.connect(bandPassFilter).connect(envelope).connect(this.masterGain);
    noiseSource.start(startTime);
    noiseSource.stop(startTime + durationSeconds + 0.02);
  }

  /* --------------------------------------------------------------------- *
   * Game sounds
   * --------------------------------------------------------------------- */

  /** A quiet wooden knock: a piece set down on an empty square. */
  playMove() {
    this.playNoiseBurst({ centreFrequency: 1100, durationSeconds: 0.06, peakGain: 0.45 });
    this.playTone({ frequency: 190, durationSeconds: 0.09, waveform: 'triangle', peakGain: 0.25 });
  }

  /** Heavier and lower than a move — one piece displacing another. */
  playCapture() {
    this.playNoiseBurst({ centreFrequency: 620, durationSeconds: 0.11, peakGain: 0.6 });
    this.playTone({ frequency: 110, durationSeconds: 0.17, waveform: 'triangle', peakGain: 0.4 });
  }

  /** Two rising notes — an alert that reads as urgent without being harsh. */
  playCheck() {
    this.playTone({ frequency: 660, durationSeconds: 0.13, peakGain: 0.4 });
    this.playTone({ frequency: 880, durationSeconds: 0.18, peakGain: 0.4, delaySeconds: 0.11 });
  }

  /** A rising major triad for a win, a falling one for a loss. */
  playGameOver({ didWin }) {
    const noteFrequencies = didWin ? [523.25, 659.25, 783.99] : [523.25, 415.3, 329.63];
    noteFrequencies.forEach((noteFrequency, noteIndex) => {
      this.playTone({
        frequency: noteFrequency,
        durationSeconds: 0.34,
        waveform: 'triangle',
        peakGain: 0.42,
        delaySeconds: noteIndex * 0.15,
      });
    });
  }

  /** A short low buzz: the tap was not a legal move. */
  playRejected() {
    this.playTone({ frequency: 120, durationSeconds: 0.14, waveform: 'sawtooth', peakGain: 0.22 });
  }

  /** A soft blip confirming a piece has been picked up. */
  playSelect() {
    this.playTone({ frequency: 520, durationSeconds: 0.05, peakGain: 0.18 });
  }
}

/**
 * One shared instance. Audio is inherently global — there is only ever one set
 * of speakers — so both AR modes import this same object.
 */
export const gameAudio = new GameAudio();
