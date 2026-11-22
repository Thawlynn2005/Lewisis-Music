//! The nine reverbs. Each is a recipe for a synthetic impulse response (the
//! same recipes, and the same loudness, as the browser version), played
//! through a real-time FFT convolver.

use fft_convolver::TwoStageFFTConvolver;
use serde::{Deserialize, Serialize};

/// One reverb's recipe.
#[derive(Debug, Clone, Copy)]
pub struct Recipe {
    /// How long it rings, in seconds.
    pub seconds: f32,
    /// How fast it dies away (higher = faster).
    pub decay: f32,
    /// The gap before it starts, in seconds.
    pub pre_delay: f32,
    /// How dull the tail is at its start and end (0 = bright, 1 = dark).
    pub damping: (f32, f32),
    /// How many early wall reflections.
    pub early: u32,
    /// How loud the reverb is compared to the others.
    pub level: f32,
    /// A metallic ring: sound bouncing between two close walls (delay s, feedback).
    pub flutter: Option<(f32, f32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Room,
    Studio,
    Chamber,
    #[default]
    Hall,
    Cathedral,
    Arena,
    Cave,
    Tunnel,
    Plate,
}

impl Kind {
    pub const ALL: [Kind; 9] =
        [Kind::Room, Kind::Studio, Kind::Chamber, Kind::Hall, Kind::Cathedral, Kind::Arena, Kind::Cave, Kind::Tunnel, Kind::Plate];

    pub fn recipe(self) -> Recipe {
        let r = |seconds, decay, pre_delay, damping, early, level| Recipe { seconds, decay, pre_delay, damping, early, level, flutter: None };
        match self {
            Kind::Room => r(0.9, 3.2, 0.004, (0.25, 0.75), 6, 1.5),
            Kind::Studio => r(0.45, 3.6, 0.002, (0.12, 0.55), 4, 1.3),
            Kind::Chamber => r(1.5, 2.8, 0.008, (0.3, 0.8), 7, 1.5),
            Kind::Hall => r(2.8, 2.4, 0.02, (0.3, 0.85), 8, 1.6),
            Kind::Cathedral => r(6.5, 1.9, 0.045, (0.45, 0.93), 10, 1.7),
            Kind::Arena => r(4.5, 2.1, 0.07, (0.2, 0.86), 14, 1.7),
            Kind::Cave => r(5.5, 1.6, 0.03, (0.62, 0.96), 14, 1.9),
            Kind::Tunnel => Recipe { flutter: Some((0.043, 0.8)), ..r(2.8, 2.2, 0.012, (0.2, 0.7), 6, 1.0) },
            Kind::Plate => r(2.0, 2.9, 0.0, (0.04, 0.3), 0, 1.4),
        }
    }
}

/// A small, fast random number generator (the impulse only needs noise).
struct Noise(u64);
impl Noise {
    fn next(&mut self) -> f32 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        ((self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32) / (1u64 << 24) as f32
    }
}

/// The stereo impulse response for a recipe at a sample rate (port of the
/// browser version's `makeImpulse`).
pub fn impulse(recipe: Recipe, rate: u32, seed: u64) -> [Vec<f32>; 2] {
    let rate = rate as f32;
    let length = (rate * recipe.seconds) as usize;
    let pre_delay = (rate * recipe.pre_delay) as usize;
    let (damp_start, damp_end) = recipe.damping;
    let mut noise = Noise(seed | 1);
    let mut channels = [vec![0.0f32; length], vec![0.0f32; length]];
    for (channel, data) in channels.iter_mut().enumerate() {
        let mut low = 0.0f32;
        for (i, sample) in data.iter_mut().enumerate().skip(pre_delay) {
            let t = (i - pre_delay) as f32 / (length - pre_delay) as f32;
            let damping = damp_start + (damp_end - damp_start) * t; // the tail gets darker over time
            low = low * damping + (noise.next() * 2.0 - 1.0) * (1.0 - damping);
            *sample = low * (1.0 - t).powf(recipe.decay);
        }
        for n in 0..recipe.early {
            // A few early wall reflections.
            let at = pre_delay + (rate * (0.004 + noise.next() * 0.012 * (n + 1) as f32)) as usize;
            if at < length {
                data[at] += if noise.next() > 0.5 { 1.0 } else { -1.0 } * 0.5 / (n + 1) as f32;
            }
        }
        if let Some((delay, feedback)) = recipe.flutter {
            let step = (rate * delay * if channel == 1 { 1.07 } else { 1.0 }) as usize;
            for i in (pre_delay + step)..length {
                data[i] += data[i - step] * feedback;
            }
        }
    }
    // Web Audio's ConvolverNode normalises impulses by default; doing the same
    // keeps every reverb exactly as loud as in the browser version.
    let scale = normalisation_scale(&channels, rate);
    for data in channels.iter_mut() {
        for sample in data.iter_mut() {
            *sample *= scale;
        }
    }
    channels
}

/// The Web Audio specification's `calculateNormalizationScale`.
fn normalisation_scale(channels: &[Vec<f32>; 2], rate: f32) -> f32 {
    const GAIN_CALIBRATION: f64 = 0.00125;
    const GAIN_CALIBRATION_SAMPLE_RATE: f64 = 44_100.0;
    const MIN_POWER: f64 = 0.000125;
    let length = channels[0].len().max(1);
    let sum: f64 = channels.iter().flat_map(|c| c.iter()).map(|&x| (x as f64) * (x as f64)).sum();
    let mut power = (sum / (2 * length) as f64).sqrt();
    if !power.is_finite() || power < MIN_POWER {
        power = MIN_POWER;
    }
    (1.0 / power * GAIN_CALIBRATION * GAIN_CALIBRATION_SAMPLE_RATE / rate as f64) as f32
}

/// How much reverb: the browser version's equal-power style cross-fade, where
/// at 100 % the direct sound is almost gone. Returns (dry, wet) gains.
pub fn mix_gains(amount: f32, kind: Kind) -> (f32, f32) {
    let quarter = std::f32::consts::FRAC_PI_2;
    ((amount * quarter * 0.86).cos(), (amount * quarter).sin() * kind.recipe().level)
}

/// A stereo convolution reverb at one sample rate.
pub struct Reverb {
    rate: u32,
    kind: Option<Kind>,
    left: TwoStageFFTConvolver<f32>,
    right: TwoStageFFTConvolver<f32>,
    wet: [Vec<f32>; 2],
}

/// Processing block size for the convolvers' first stage.
const HEAD_BLOCK: usize = 128;

impl Reverb {
    pub fn new(rate: u32) -> Self {
        Self { rate, kind: None, left: Default::default(), right: Default::default(), wet: [vec![], vec![]] }
    }

    pub fn kind(&self) -> Option<Kind> {
        self.kind
    }

    /// Switch to another reverb (builds its impulse; not for the audio thread
    /// in a tight loop, but fast enough to do once when the listener picks one).
    pub fn set_kind(&mut self, kind: Kind) {
        if self.kind == Some(kind) {
            return;
        }
        let [l, r] = impulse(kind.recipe(), self.rate, 0x5EED + kind as u64);
        let _ = self.left.init_default(HEAD_BLOCK, &l);
        let _ = self.right.init_default(HEAD_BLOCK, &r);
        self.kind = Some(kind);
    }

    /// Clear the tail (after a seek or a new song).
    pub fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }

    /// Mix reverb into planar stereo audio in place: out = dry·x + wet·(x ∗ impulse).
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], dry: f32, wet: f32) {
        if self.kind.is_none() {
            return;
        }
        let n = left.len();
        for buffer in self.wet.iter_mut() {
            if buffer.len() < n {
                buffer.resize(n, 0.0);
            }
        }
        let _ = self.left.process(left, &mut self.wet[0][..n]);
        let _ = self.right.process(right, &mut self.wet[1][..n]);
        for i in 0..n {
            left[i] = left[i] * dry + self.wet[0][i] * wet;
            right[i] = right[i] * dry + self.wet[1][i] * wet;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impulses_have_the_right_length_and_are_finite() {
        for kind in Kind::ALL {
            let recipe = kind.recipe();
            let [l, r] = impulse(recipe, 48_000, 7);
            assert_eq!(l.len(), (48_000.0 * recipe.seconds) as usize);
            assert_eq!(l.len(), r.len());
            assert!(l.iter().chain(&r).all(|x| x.is_finite()));
            // Silence before the pre-delay.
            let pre = (48_000.0 * recipe.pre_delay) as usize;
            assert!(l[..pre].iter().all(|x| *x == 0.0));
        }
    }

    #[test]
    fn a_click_comes_back_as_a_tail() {
        let mut reverb = Reverb::new(48_000);
        reverb.set_kind(Kind::Hall);
        let mut tail_energy = 0.0;
        for block in 0..100 {
            let mut left = vec![0.0f32; 512];
            let mut right = vec![0.0f32; 512];
            if block == 0 {
                left[0] = 1.0;
                right[0] = 1.0;
            }
            reverb.process(&mut left, &mut right, 0.0, 1.0);
            if block > 10 {
                tail_energy += left.iter().map(|x| x * x).sum::<f32>();
            }
        }
        assert!(tail_energy > 0.0, "the hall should still ring after 100 ms");
    }

    #[test]
    fn zero_reverb_is_the_dry_sound() {
        let (dry, wet) = mix_gains(0.0, Kind::Cathedral);
        assert_eq!((dry, wet), (1.0, 0.0));
        let (dry, wet) = mix_gains(1.0, Kind::Hall);
        assert!(dry < 0.25 && (wet - 1.6).abs() < 1e-6);
    }
}
