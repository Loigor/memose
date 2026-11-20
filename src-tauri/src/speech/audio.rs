//! Microphone samples to speech slices: mono 16 kHz, split at pauses.

/// Sample rate every recognizer here expects.
pub const RATE: u32 = 16_000;
/// One analysis frame: 20 ms.
const FRAME: usize = 320;
const FRAME_MS: u32 = 20;
/// Sound kept before the first voiced frame, so a word's start is not cut.
const PRE_ROLL_FRAMES: usize = 10;
/// Quiet kept at the end of a slice.
const TAIL_FRAMES: usize = 10;
/// A slice with less voice than this is noise and is dropped. Recognizers invent text on silence.
const MIN_VOICED_FRAMES: usize = 8;
const FLOOR: f32 = 0.006;

/// Averages interleaved channels and resamples to 16 kHz by linear interpolation.
pub struct Resampler {
    channels: usize,
    step: f64,
    at: f64,
    last: f32,
    primed: bool,
}

impl Resampler {
    pub fn new(rate: u32, channels: u16) -> Self {
        Self {
            channels: usize::from(channels.max(1)),
            step: f64::from(rate.max(1)) / f64::from(RATE),
            at: 0.0,
            last: 0.0,
            primed: false,
        }
    }

    /// Feeds interleaved samples and appends 16 kHz mono samples to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for frame in input.chunks_exact(self.channels) {
            let sample = frame.iter().sum::<f32>() / self.channels as f32;
            if !self.primed {
                self.last = sample;
                self.primed = true;
            }
            // `at` is the position of the next output sample, measured from `last` (0) to `sample` (1).
            while self.at < 1.0 {
                let mix = self.at as f32;
                out.push(self.last + (sample - self.last) * mix);
                self.at += self.step;
            }
            self.at -= 1.0;
            self.last = sample;
        }
    }
}

/// How speech is cut into slices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkPlan {
    /// A pause this long ends a slice.
    pub pause_ms: u32,
    /// A slice is cut at its quietest recent point once it is this long.
    pub max_ms: u32,
}

impl ChunkPlan {
    /// Dictation into a memo: short slices, so text appears soon.
    pub const DICTATION: Self = Self {
        pause_ms: 700,
        max_ms: 12_000,
    };
    /// A spoken prompt: a whole command arrives as one piece where possible.
    pub const PROMPT: Self = Self {
        pause_ms: 1_300,
        max_ms: 25_000,
    };
}

fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    (frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32).sqrt()
}

/// Cuts a stream of 16 kHz samples into slices that hold speech.
pub struct Chunker {
    plan: ChunkPlan,
    pending: Vec<f32>,
    /// Frames of the slice being built. Before speech starts it holds only the pre-roll.
    frames: Vec<Vec<f32>>,
    levels: Vec<f32>,
    in_speech: bool,
    quiet_run: usize,
    voiced: usize,
    noise: f32,
    /// Loudest recent frame level, for a meter. Read and reset by `take_level`.
    peak: f32,
    /// Frames seen so far, to measure pauses.
    frame_no: usize,
    last_voiced: usize,
    /// End of the voice in the last slice that was kept.
    voice_end: Option<usize>,
    /// Silence before the slice being built, in frames.
    slice_pause: usize,
    /// Silence before each slice handed out and not yet taken, in ms.
    pauses: std::collections::VecDeque<u32>,
}

impl Chunker {
    pub fn new(plan: ChunkPlan) -> Self {
        Self {
            plan,
            pending: Vec::new(),
            frames: Vec::new(),
            levels: Vec::new(),
            in_speech: false,
            quiet_run: 0,
            voiced: 0,
            noise: FLOOR,
            peak: 0.0,
            frame_no: 0,
            last_voiced: 0,
            voice_end: None,
            slice_pause: 0,
            pauses: std::collections::VecDeque::new(),
        }
    }

    /// Silence before the next slice handed out, in ms, in the order the slices came.
    /// The first slice of a recording has none.
    pub fn take_pause(&mut self) -> u32 {
        self.pauses.pop_front().unwrap_or(0)
    }

    pub fn take_level(&mut self) -> f32 {
        std::mem::take(&mut self.peak)
    }

    fn threshold(&self) -> f32 {
        (self.noise * 3.0).max(FLOOR * 2.0)
    }

    /// Feeds samples. Returns the slices that ended inside them.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let mut done = Vec::new();
        self.pending.extend_from_slice(samples);
        let mut start = 0;
        while self.pending.len() - start >= FRAME {
            let frame = self.pending[start..start + FRAME].to_vec();
            start += FRAME;
            if let Some(slice) = self.frame(frame) {
                done.push(slice);
            }
        }
        self.pending.drain(..start);
        done
    }

    fn frame(&mut self, frame: Vec<f32>) -> Option<Vec<f32>> {
        let level = rms(&frame);
        self.peak = self.peak.max(level);
        let voiced = level > self.threshold();
        self.frame_no += 1;
        if voiced {
            self.last_voiced = self.frame_no;
        }
        if !voiced {
            // The noise floor follows quiet frames slowly, so a fan does not count as speech.
            self.noise = self.noise * 0.95 + level.max(FLOOR * 0.5) * 0.05;
        }
        self.frames.push(frame);
        self.levels.push(level);
        if !self.in_speech {
            if voiced {
                self.in_speech = true;
                self.voiced = 1;
                self.quiet_run = 0;
                self.slice_pause = self
                    .voice_end
                    .map_or(0, |end| self.frame_no.saturating_sub(end + 1));
            } else if self.frames.len() > PRE_ROLL_FRAMES {
                self.frames.remove(0);
                self.levels.remove(0);
            }
            return None;
        }
        if voiced {
            self.voiced += 1;
            self.quiet_run = 0;
        } else {
            self.quiet_run += 1;
        }
        let pause_frames = (self.plan.pause_ms / FRAME_MS) as usize;
        if self.quiet_run >= pause_frames {
            let keep = self.frames.len() - self.quiet_run.saturating_sub(TAIL_FRAMES);
            return self.cut(keep);
        }
        let max_frames = (self.plan.max_ms / FRAME_MS) as usize;
        if self.frames.len() >= max_frames {
            // No pause came: cut at the quietest frame of the last second, between two words if possible.
            let from = self.frames.len().saturating_sub(50);
            let quietest = (from..self.frames.len())
                .min_by(|a, b| self.levels[*a].total_cmp(&self.levels[*b]))
                .unwrap_or(self.frames.len() - 1);
            return self.cut(quietest + 1);
        }
        None
    }

    /// Ends the slice after `keep` frames. Later frames start the next slice.
    fn cut(&mut self, keep: usize) -> Option<Vec<f32>> {
        let rest_frames = self.frames.split_off(keep.min(self.frames.len()));
        let rest_levels = self.levels.split_off(keep.min(self.levels.len()));
        let slice: Vec<f32> = std::mem::replace(&mut self.frames, rest_frames).concat();
        self.levels = rest_levels;
        let voiced = self.voiced;
        let threshold = self.threshold();
        // Frames carried over are speech only if they are loud. A trailing pause is not.
        self.voiced = self
            .levels
            .iter()
            .filter(|level| **level > threshold)
            .count();
        self.in_speech = self.voiced > 0;
        self.quiet_run = 0;
        let kept = voiced >= MIN_VOICED_FRAMES;
        if kept {
            self.pauses.push_back(self.slice_pause as u32 * FRAME_MS);
            self.voice_end = Some(self.last_voiced);
        }
        // Speech carried into the next slice follows without a pause.
        self.slice_pause = 0;
        if !self.in_speech {
            let extra = self.frames.len().saturating_sub(PRE_ROLL_FRAMES);
            self.frames.drain(..extra);
            self.levels.drain(..extra);
        }
        kept.then_some(slice)
    }

    /// The unfinished slice, when recording stops mid-sentence.
    pub fn finish(&mut self) -> Option<Vec<f32>> {
        if !self.in_speech {
            return None;
        }
        let mut frames = std::mem::take(&mut self.frames);
        frames.push(std::mem::take(&mut self.pending));
        self.levels.clear();
        self.in_speech = false;
        let voiced = std::mem::take(&mut self.voiced);
        let kept = voiced >= MIN_VOICED_FRAMES;
        if kept {
            self.pauses.push_back(self.slice_pause as u32 * FRAME_MS);
        }
        kept.then(|| frames.concat())
    }
}

pub fn to_pcm(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
        .collect()
}

/// A 16 kHz mono 16-bit WAV file.
pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: u32, level: f32) -> Vec<f32> {
        (0..(RATE * ms / 1000))
            .map(|i| (i as f32 * 0.2).sin() * level)
            .collect()
    }

    fn quiet(ms: u32) -> Vec<f32> {
        vec![0.0; (RATE * ms / 1000) as usize]
    }

    #[test]
    fn resampler_turns_48k_stereo_into_16k_mono() {
        let mut resampler = Resampler::new(48_000, 2);
        let input: Vec<f32> = (0..48_000).flat_map(|_| [0.5, -0.1]).collect();
        let mut out = Vec::new();
        resampler.push(&input[..30_000], &mut out);
        resampler.push(&input[30_000..], &mut out);
        assert!((out.len() as i64 - 16_000).abs() <= 1);
        assert!(out.iter().all(|sample| (sample - 0.2).abs() < 1e-4));
    }

    #[test]
    fn resampler_keeps_16k_mono_as_it_is() {
        let mut resampler = Resampler::new(16_000, 1);
        let input = tone(100, 0.3);
        let mut out = Vec::new();
        resampler.push(&input, &mut out);
        assert_eq!(out.len(), input.len());
    }

    #[test]
    fn a_pause_ends_a_slice() {
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        let mut audio = quiet(500);
        audio.extend(tone(1500, 0.2));
        audio.extend(quiet(1000));
        audio.extend(tone(1000, 0.2));
        audio.extend(quiet(1000));
        let slices = chunker.push(&audio);
        assert_eq!(slices.len(), 2);
        let first_ms = slices[0].len() as u32 * 1000 / RATE;
        assert!(
            (1700..=2000).contains(&first_ms),
            "first slice was {first_ms} ms"
        );
        assert_eq!(chunker.finish(), None);
    }

    #[test]
    fn silence_and_clicks_give_no_slice() {
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        let mut audio = quiet(2000);
        audio.extend(tone(60, 0.3));
        audio.extend(quiet(2000));
        assert!(chunker.push(&audio).is_empty());
        assert_eq!(chunker.finish(), None);
    }

    #[test]
    fn long_speech_is_cut_at_the_quietest_recent_point() {
        let mut chunker = Chunker::new(ChunkPlan {
            pause_ms: 700,
            max_ms: 3000,
        });
        let mut audio = tone(2500, 0.2);
        audio.extend(tone(100, 0.03));
        audio.extend(tone(2000, 0.2));
        let slices = chunker.push(&audio);
        assert_eq!(slices.len(), 1);
        let cut_ms = slices[0].len() as u32 * 1000 / RATE;
        assert!((2500..=2620).contains(&cut_ms), "cut at {cut_ms} ms");
        let rest = chunker.finish().expect("speech after the cut is kept");
        assert!(rest.len() as u32 * 1000 / RATE >= 1500);
    }

    #[test]
    fn a_spoken_prompt_waits_longer_before_cutting() {
        let mut audio = tone(1000, 0.2);
        audio.extend(quiet(1000));
        audio.extend(tone(1000, 0.2));
        audio.extend(quiet(1500));
        assert_eq!(Chunker::new(ChunkPlan::DICTATION).push(&audio).len(), 2);
        assert_eq!(Chunker::new(ChunkPlan::PROMPT).push(&audio).len(), 1);
    }

    #[test]
    fn stopping_mid_sentence_returns_the_open_slice() {
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        assert!(chunker.push(&tone(900, 0.2)).is_empty());
        let rest = chunker.finish().expect("open slice");
        assert_eq!(rest.len(), (RATE * 900 / 1000) as usize);
    }

    #[test]
    fn steady_background_noise_is_not_speech() {
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        let mut audio = tone(4000, 0.01);
        audio.extend(tone(1200, 0.25));
        audio.extend(tone(1200, 0.01));
        let slices = chunker.push(&audio);
        assert_eq!(slices.len(), 1);
    }

    #[test]
    fn each_slice_reports_the_silence_before_it() {
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        let mut audio = quiet(300);
        audio.extend(tone(1000, 0.2));
        audio.extend(quiet(1000));
        audio.extend(tone(1000, 0.2));
        audio.extend(quiet(3000));
        audio.extend(tone(1000, 0.2));
        audio.extend(quiet(1000));
        let slices = chunker.push(&audio);
        assert_eq!(slices.len(), 3);
        let pauses: Vec<u32> = (0..3).map(|_| chunker.take_pause()).collect();
        assert_eq!(pauses[0], 0, "the first slice has no pause before it");
        assert!(
            (900..=1100).contains(&pauses[1]),
            "short pause was {} ms",
            pauses[1]
        );
        assert!(
            (2900..=3100).contains(&pauses[2]),
            "long pause was {} ms",
            pauses[2]
        );
        assert_eq!(chunker.take_pause(), 0);
    }

    #[test]
    fn wav_has_a_valid_header() {
        let wav = wav_bytes(&to_pcm(&[0.0, 1.0, -1.0]));
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), RATE);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 50);
        assert_eq!(
            i16::from_le_bytes(wav[46..48].try_into().unwrap()),
            i16::MAX
        );
    }
}
