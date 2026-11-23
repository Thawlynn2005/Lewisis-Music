//! Varispeed: playing samples back at any rate. This is what turns a 44.1 kHz
//! song into the sound card's 48 kHz, and what speed does when "Keep pitch"
//! is off (faster = higher, like a record).
//!
//! A windowed-sinc interpolator whose cut-off follows the speed, so speeding
//! up never folds high notes back down as aliasing. At exactly 1× it passes
//! samples through untouched.

use crate::feeder::Frame4;

/// Taps on each side of the output point.
const HALF: usize = 16;
const TAPS: usize = HALF * 2;
/// Fractional positions the filter is worked out for (in between, it blends).
const PHASES: usize = 256;
/// Throw away consumed input once this much has piled up.
const COMPACT_AT: usize = 8192;

/// "No song frame here" (the zero padding before the first real frame).
const NO_MARK: u64 = u64::MAX;

pub struct Resampler {
    input: Vec<Frame4>,
    /// The song frame each input frame came from.
    marks: Vec<u64>,
    /// Where in `input` the next output is centred.
    position: f64,
    cutoff: f32,
    /// (PHASES + 1) rows of TAPS coefficients.
    table: Vec<f32>,
}

impl Default for Resampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Resampler {
    pub fn new() -> Self {
        let mut resampler =
            Self { input: Vec::new(), marks: Vec::new(), position: 0.0, cutoff: 0.0, table: vec![0.0; (PHASES + 1) * TAPS] };
        resampler.build_table(1.0);
        resampler.reset();
        resampler
    }

    /// Forget everything (after a seek or a new song).
    pub fn reset(&mut self) {
        self.input.clear();
        self.marks.clear();
        // Silence before the first frame, so output starts right away.
        self.input.resize(HALF - 1, [0.0; 4]);
        self.marks.resize(HALF - 1, NO_MARK);
        self.position = (HALF - 1) as f64;
    }

    pub fn push(&mut self, frames: &[Frame4], marks: &[u64]) {
        debug_assert_eq!(frames.len(), marks.len());
        self.input.extend_from_slice(frames);
        self.marks.extend_from_slice(marks);
    }

    /// Whether there is enough input for the next output frame.
    pub fn ready(&self) -> bool {
        (self.position as usize) + HALF < self.input.len()
    }

    /// The song frame the next output comes from (`None` before any input).
    pub fn mark(&self) -> Option<u64> {
        self.marks.get(self.position as usize).copied().filter(|m| *m != NO_MARK)
    }

    /// How many input frames are waiting (not yet passed by the output).
    pub fn buffered(&self) -> usize {
        self.input.len().saturating_sub(self.position as usize)
    }

    fn build_table(&mut self, cutoff: f32) {
        self.cutoff = cutoff;
        for phase in 0..=PHASES {
            let frac = phase as f64 / PHASES as f64;
            let row = &mut self.table[phase * TAPS..(phase + 1) * TAPS];
            let mut sum = 0.0;
            for (k, c) in row.iter_mut().enumerate() {
                // Distance from the output point to this input sample.
                let d = (k as f64 - (HALF - 1) as f64) - frac;
                let x = d * cutoff as f64;
                let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                // Blackman window over the filter's span.
                let w = d / HALF as f64;
                let window = if w.abs() >= 1.0 {
                    0.0
                } else {
                    0.42 + 0.5 * (std::f64::consts::PI * w).cos() + 0.08 * (2.0 * std::f64::consts::PI * w).cos()
                };
                *c = (cutoff as f64 * sinc * window) as f32;
                sum += *c as f64;
            }
            // Exactly unity gain at every position (no ripple in loudness).
            for c in row.iter_mut() {
                *c = (*c as f64 / sum) as f32;
            }
        }
    }

    /// One output frame; then move on by `step` input frames (2.0 = twice as
    /// fast / an octave up).
    pub fn next(&mut self, step: f64) -> Frame4 {
        let cutoff = if step > 1.0 { (1.0 / step) as f32 } else { 1.0 };
        if (cutoff - self.cutoff).abs() > 0.002 {
            self.build_table(cutoff);
        }
        let index = self.position as usize;
        let frac = self.position - index as f64;
        let out = if frac == 0.0 && self.cutoff == 1.0 {
            self.input[index]
        } else {
            let phase = frac * PHASES as f64;
            let p = phase as usize;
            let t = (phase - p as f64) as f32;
            let a = &self.table[p * TAPS..(p + 1) * TAPS];
            let b = &self.table[(p + 1) * TAPS..(p + 2) * TAPS];
            let window = &self.input[index + 1 - HALF..=index + HALF];
            let mut out = [0.0f32; 4];
            for k in 0..TAPS {
                let c = a[k] + (b[k] - a[k]) * t;
                let x = &window[k];
                out[0] += x[0] * c;
                out[1] += x[1] * c;
                out[2] += x[2] * c;
                out[3] += x[3] * c;
            }
            out
        };
        self.position += step;
        let consumed = self.position as usize;
        if consumed > COMPACT_AT + HALF {
            let drop = consumed - HALF;
            self.input.drain(..drop);
            self.marks.drain(..drop);
            self.position -= drop as f64;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: f64, n: usize) -> Vec<Frame4> {
        (0..n)
            .map(|i| {
                let v = (2.0 * std::f64::consts::PI * freq * i as f64 / rate).sin() as f32;
                [v, v, 0.0, 0.0]
            })
            .collect()
    }

    fn run(input: &[Frame4], step: f64) -> Vec<Frame4> {
        let mut r = Resampler::new();
        let marks: Vec<u64> = (0..input.len() as u64).collect();
        r.push(input, &marks);
        let mut out = Vec::new();
        while r.ready() {
            out.push(r.next(step));
        }
        out
    }

    #[test]
    fn one_to_one_is_untouched() {
        let input = sine(440.0, 44_100.0, 5000);
        let out = run(&input, 1.0);
        assert_eq!(&out[..4000], &input[..4000]);
    }

    #[test]
    fn changing_rate_keeps_the_tone() {
        // 44.1 kHz → 48 kHz: a 1 kHz tone should still be a clean 1 kHz tone.
        let input = sine(1000.0, 44_100.0, 44_100);
        let out = run(&input, 44_100.0 / 48_000.0);
        let expected = sine(1000.0, 48_000.0, out.len());
        let worst = out[100..40_000].iter().zip(&expected[100..40_000]).map(|(a, b)| (a[0] - b[0]).abs()).fold(0.0, f32::max);
        assert!(worst < 2e-3, "worst error {worst}");
    }

    #[test]
    fn speeding_up_does_not_alias() {
        // A 15 kHz tone played 2× is above the new Nyquist and must vanish,
        // not fold back as a 14 kHz whistle.
        let input = sine(15_000.0, 44_100.0, 20_000);
        let out = run(&input, 2.0);
        let peak = out[100..9_000].iter().map(|f| f[0].abs()).fold(0.0, f32::max);
        assert!(peak < 0.02, "aliasing peak {peak}");
    }

    #[test]
    fn marks_follow_the_input() {
        let input = sine(100.0, 8000.0, 1000);
        let mut r = Resampler::new();
        assert_eq!(r.mark(), None);
        let marks: Vec<u64> = (5000..6000).collect();
        r.push(&input, &marks);
        assert_eq!(r.mark(), Some(5000));
        for _ in 0..100 {
            r.next(1.5);
        }
        assert_eq!(r.mark(), Some(5150));
    }
}
