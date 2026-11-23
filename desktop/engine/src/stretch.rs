//! "Keep pitch": changing speed without changing pitch.
//!
//! WSOLA (waveform-similarity overlap-add), the same method Chrome and Firefox
//! use for `preservesPitch`: the song is cut into 20 ms windows that are
//! cross-faded together, each one taken from wherever, near its ideal place,
//! it lines up best with the one before, so the joins don't warble. Both
//! layers (vocals and instruments) are cut at the same places, so they stay
//! in step.

use std::collections::VecDeque;

use crate::feeder::Frame4;

/// Throw away consumed input once this much has piled up.
const COMPACT_AT: usize = 16_384;

pub struct Stretcher {
    /// Window length and hop (half a window), in frames.
    size: usize,
    hop: usize,
    /// How far either side of the ideal place to look for the best fit.
    search: usize,
    window: Vec<f32>,
    input: Vec<Frame4>,
    marks: Vec<u64>,
    /// Where the next window ideally starts (moves on by hop × speed).
    target: f64,
    /// Where the previous window started.
    previous: Option<usize>,
    overlap: Vec<Frame4>,
    output: VecDeque<(Frame4, u64)>,
}

impl Stretcher {
    pub fn new(sample_rate: u32) -> Self {
        let size = ((sample_rate as f64 * 0.02) as usize).max(64) & !1;
        let hop = size / 2;
        // A periodic Hann window: two of them half a window apart add up to 1.
        let window = (0..size).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / size as f64).cos()) as f32).collect();
        Self {
            size,
            hop,
            search: (sample_rate as f64 * 0.015) as usize,
            window,
            input: Vec::new(),
            marks: Vec::new(),
            target: 0.0,
            previous: None,
            overlap: vec![[0.0; 4]; size],
            output: VecDeque::new(),
        }
    }

    pub fn reset(&mut self) {
        self.input.clear();
        self.marks.clear();
        self.target = 0.0;
        self.previous = None;
        self.overlap.iter_mut().for_each(|f| *f = [0.0; 4]);
        self.output.clear();
    }

    pub fn push(&mut self, frames: &[Frame4], marks: &[u64]) {
        self.input.extend_from_slice(frames);
        self.marks.extend_from_slice(marks);
    }

    /// The next stretched frame and the song frame it came from.
    pub fn pop(&mut self) -> Option<(Frame4, u64)> {
        self.output.pop_front()
    }

    pub fn has_output(&self) -> bool {
        !self.output.is_empty()
    }

    /// How much more input the next step needs (0 = it can run now).
    pub fn wants(&self) -> usize {
        let furthest = (self.target as usize + self.search + self.size).max(self.previous.map_or(0, |p| p + self.hop + self.size));
        furthest.saturating_sub(self.input.len())
    }

    fn mono(&self, i: usize) -> f32 {
        let f = &self.input[i];
        f[0] + f[1] + f[2] + f[3]
    }

    /// How well the window at `candidate` continues the previous one (higher
    /// is better): correlation with the natural continuation, over `length`
    /// frames, looking at every `stride`th one.
    fn fit(&self, reference: usize, candidate: usize, length: usize, stride: usize) -> f32 {
        let mut dot = 0.0f32;
        let mut energy = 1e-9f32;
        let mut i = 0;
        while i < length {
            let x = self.mono(candidate + i);
            dot += self.mono(reference + i) * x;
            energy += x * x;
            i += stride;
        }
        dot / energy.sqrt()
    }

    /// Make one hop of output at `speed` (1.5 = 50 % faster). Returns `false`
    /// if more input is needed first.
    pub fn step(&mut self, speed: f64) -> bool {
        if self.wants() > 0 {
            return false;
        }
        let ideal = self.target.round() as usize;
        let chosen = match self.previous {
            None => ideal,
            Some(previous) => {
                let reference = previous + self.hop; // what would naturally come next
                let low = ideal.saturating_sub(self.search);
                let high = ideal + self.search;
                // Coarse search, then refine around the best.
                let mut best = (f32::MIN, ideal);
                let mut c = low;
                while c <= high {
                    let score = self.fit(reference, c, self.hop, 4);
                    if score > best.0 {
                        best = (score, c);
                    }
                    c += 4;
                }
                let (from, to) = (best.1.saturating_sub(3).max(low), (best.1 + 3).min(high));
                for c in from..=to {
                    let score = self.fit(reference, c, self.hop, 1);
                    if score > best.0 {
                        best = (score, c);
                    }
                }
                best.1
            }
        };
        for i in 0..self.size {
            let w = self.window[i];
            let x = self.input[chosen + i];
            let o = &mut self.overlap[i];
            for c in 0..4 {
                o[c] += x[c] * w;
            }
        }
        for i in 0..self.hop {
            self.output.push_back((self.overlap[i], self.marks[chosen + i]));
        }
        self.overlap.copy_within(self.hop.., 0);
        let size = self.size;
        self.overlap[size - self.hop..].iter_mut().for_each(|f| *f = [0.0; 4]);
        self.previous = Some(chosen);
        self.target += self.hop as f64 * speed;

        // Drop input nothing will look at again.
        let keep_from = chosen.min((self.target as usize).saturating_sub(self.search));
        if keep_from > COMPACT_AT {
            self.input.drain(..keep_from);
            self.marks.drain(..keep_from);
            self.target -= keep_from as f64;
            self.previous = Some(chosen - keep_from);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: f64, n: usize) -> Vec<Frame4> {
        (0..n)
            .map(|i| {
                let v = (2.0 * std::f64::consts::PI * freq * i as f64 / rate).sin() as f32 * 0.5;
                [v, v, v, v]
            })
            .collect()
    }

    /// Count upward zero crossings → frequency.
    fn frequency(signal: &[f32], rate: f64) -> f64 {
        let crossings = signal.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f64 * rate / signal.len() as f64
    }

    fn stretch(speed: f64, input: &[Frame4]) -> Vec<(Frame4, u64)> {
        let mut s = Stretcher::new(44_100);
        let marks: Vec<u64> = (0..input.len() as u64).collect();
        s.push(input, &marks);
        let mut out = Vec::new();
        while s.step(speed) {
            while let Some(f) = s.pop() {
                out.push(f);
            }
        }
        out
    }

    #[test]
    fn faster_keeps_the_pitch_and_shortens_the_song() {
        let input = sine(440.0, 44_100.0, 44_100 * 2);
        for speed in [0.5, 0.85, 1.25, 2.0] {
            let out = stretch(speed, &input);
            let expected_len = input.len() as f64 / speed;
            assert!((out.len() as f64 - expected_len).abs() / expected_len < 0.05, "speed {speed}: length {}", out.len());
            let left: Vec<f32> = out[2_000..out.len() - 4_000].iter().map(|(f, _)| f[0]).collect();
            let hz = frequency(&left, 44_100.0);
            assert!((hz - 440.0).abs() < 5.0, "speed {speed}: {hz} Hz");
            // Smooth: no sudden jumps between neighbouring samples.
            let jump = left.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
            assert!(jump < 0.05, "speed {speed}: jump {jump}");
        }
    }

    #[test]
    fn marks_advance_at_the_speed() {
        let input = sine(220.0, 44_100.0, 44_100);
        let out = stretch(1.5, &input);
        let (_, mark) = out[20_000];
        assert!((mark as f64 - 30_000.0).abs() < 1_000.0, "mark {mark}");
    }
}
